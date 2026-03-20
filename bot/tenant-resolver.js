/**
 * Multi-Tenant Resolver — Rainbow JID to Tenant ID
 *
 * Resolves Rainbow JIDs (user_domain.com@openrainbow.com) to tenant IDs.
 * Runs on every incoming message — optimized for speed with a 3-level
 * resolution chain: L1 in-memory LRU → L2 Redis JID index → L3 Redis domain index.
 *
 * Uses Node 22 built-in features — no extra dependencies.
 */

const LOG = "[TenantResolver]";

// ── Configuration ────────────────────────────────────────

const CACHE_MAX_SIZE = 10_000;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

let redisClient = null;

// L1: In-memory LRU cache (Map preserves insertion order)
let cache = new Map();

// ── Init ─────────────────────────────────────────────────

function init(redis) {
  redisClient = redis;
  cache = new Map();
  console.log(`${LOG} Initialized (LRU max=${CACHE_MAX_SIZE}, TTL=${CACHE_TTL_MS / 1000}s)`);
}

// ── LRU Cache Helpers ────────────────────────────────────

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  // Move to end (most recently used): delete + re-insert
  cache.delete(key);
  cache.set(key, entry);
  return { tenantId: entry.tenantId, slug: entry.slug };
}

function cacheSet(key, tenantId, slug) {
  // If key already exists, delete first to refresh position
  if (cache.has(key)) {
    cache.delete(key);
  }
  // Evict oldest entry if at capacity
  if (cache.size >= CACHE_MAX_SIZE) {
    const oldest = cache.keys().next().value;
    cache.delete(oldest);
  }
  cache.set(key, {
    tenantId,
    slug,
    expiresAt: Date.now() + CACHE_TTL_MS,
  });
}

// ── Domain Extraction ────────────────────────────────────

/**
 * Parse "user_domain.com@openrainbow.com" → "domain.com"
 *
 * Rainbow JID format: {localpart}@openrainbow.com
 * where localpart is typically {username}_{domain}
 *
 * Edge cases handled:
 * - Underscores in username part: use lastIndexOf("_") before the @ sign
 * - Subdomains: "john_mail.sub.domain.com@openrainbow.com" → "mail.sub.domain.com"
 * - No underscore: returns null (can't extract domain)
 * - No @ sign: returns null (malformed JID)
 */
function extractDomainFromJid(jid) {
  if (!jid || typeof jid !== "string") return null;

  const atIdx = jid.indexOf("@");
  if (atIdx < 0) return null;

  const localpart = jid.substring(0, atIdx);
  const underscoreIdx = localpart.indexOf("_");
  if (underscoreIdx < 0 || underscoreIdx >= localpart.length - 1) return null;

  // Everything after the first underscore is the domain
  // e.g. "john.doe_acme.com" → "acme.com"
  // e.g. "john_doe_acme.com" → "doe_acme.com" is wrong — we need the domain part
  // The convention is: the domain portion starts after the LAST underscore that
  // precedes a valid domain-like string. However, the most reliable heuristic
  // for Rainbow JIDs is: split on underscore, the part containing a dot after
  // the last underscore before @ is the domain.
  //
  // Simplest correct approach: find the last "_" in the localpart. Everything
  // after it is the domain (which must contain at least one dot).
  const lastUnderscoreIdx = localpart.lastIndexOf("_");
  if (lastUnderscoreIdx < 0 || lastUnderscoreIdx >= localpart.length - 1) return null;

  const domain = localpart.substring(lastUnderscoreIdx + 1);
  if (!domain.includes(".")) return null;

  return domain.toLowerCase();
}

// ── Resolve (Hot Path) ───────────────────────────────────

/**
 * Resolve a Rainbow JID to a tenant.
 *
 * Resolution chain:
 *   L1: In-memory LRU cache
 *   L2: Redis tenant:jid:{jid} — direct JID-to-tenant mapping
 *   L3: Redis tenant:domain:{domain} — domain extracted from JID
 *   L4: Return null (unknown tenant)
 *
 * @param {string} jid - Rainbow JID (e.g. "user_domain.com@openrainbow.com")
 * @param {string} [email] - Optional email hint (unused currently, reserved for future L2.5)
 * @returns {Promise<{tenantId: string, slug: string}|null>}
 */
async function resolve(jid, email) {
  if (!jid) return null;

  // L1: In-memory LRU cache
  const cached = cacheGet(jid);
  if (cached) return cached;

  // L2: Redis direct JID mapping
  if (redisClient) {
    try {
      const jidData = await redisClient.get(`tenant:jid:${jid}`);
      if (jidData) {
        const parsed = JSON.parse(jidData);
        cacheSet(jid, parsed.tenantId, parsed.slug);
        return { tenantId: parsed.tenantId, slug: parsed.slug };
      }
    } catch (err) {
      console.error(`${LOG} L2 Redis error for JID ${jid}:`, err.message);
    }

    // L3: Redis domain mapping
    const domain = extractDomainFromJid(jid);
    if (domain) {
      try {
        const domainData = await redisClient.get(`tenant:domain:${domain}`);
        if (domainData) {
          const parsed = JSON.parse(domainData);
          // Populate L1 cache on domain hit
          cacheSet(jid, parsed.tenantId, parsed.slug);
          return { tenantId: parsed.tenantId, slug: parsed.slug };
        }
      } catch (err) {
        console.error(`${LOG} L3 Redis error for domain ${domain}:`, err.message);
      }
    }
  }

  // L4: Unknown tenant
  return null;
}

// ── Registration ─────────────────────────────────────────

/**
 * Register a JID-to-tenant mapping in Redis (L2 index).
 * Called when a user's Rainbow JID is linked to a tenant.
 *
 * @param {string} jid - Rainbow JID
 * @param {string} tenantId - Tenant identifier
 * @param {string} [slug] - Optional tenant slug/name
 */
async function registerJid(jid, tenantId, slug) {
  if (!jid || !tenantId) return;
  if (!redisClient) {
    console.warn(`${LOG} Cannot register JID — Redis not initialized`);
    return;
  }

  const data = JSON.stringify({ tenantId, slug: slug || tenantId });
  try {
    await redisClient.set(`tenant:jid:${jid}`, data);
    // Also populate L1 cache
    cacheSet(jid, tenantId, slug || tenantId);
    console.log(`${LOG} Registered JID ${jid} → tenant ${tenantId}`);
  } catch (err) {
    console.error(`${LOG} Failed to register JID ${jid}:`, err.message);
  }
}

/**
 * Unregister a JID mapping — deletes L2 index and evicts L1 cache.
 *
 * @param {string} jid - Rainbow JID
 */
async function unregisterJid(jid) {
  if (!jid) return;

  // Evict from L1
  cache.delete(jid);

  if (!redisClient) return;

  try {
    await redisClient.del(`tenant:jid:${jid}`);
    console.log(`${LOG} Unregistered JID ${jid}`);
  } catch (err) {
    console.error(`${LOG} Failed to unregister JID ${jid}:`, err.message);
  }
}

// ── Cache Management ─────────────────────────────────────

/**
 * Evict a JID from the L1 in-memory cache only.
 *
 * @param {string} jid - Rainbow JID
 */
function invalidate(jid) {
  if (!jid) return;
  cache.delete(jid);
}

/**
 * Pre-populate L2 Redis index for a batch of JIDs belonging to a tenant.
 * Used during tenant onboarding or user sync.
 *
 * @param {string} tenantId - Tenant identifier
 * @param {string[]} jids - Array of Rainbow JIDs
 * @param {string} [slug] - Optional tenant slug/name
 */
async function warmCache(tenantId, jids, slug) {
  if (!tenantId || !Array.isArray(jids) || jids.length === 0) return;
  if (!redisClient) {
    console.warn(`${LOG} Cannot warm cache — Redis not initialized`);
    return;
  }

  const data = JSON.stringify({ tenantId, slug: slug || tenantId });
  let count = 0;

  for (const jid of jids) {
    if (!jid) continue;
    try {
      await redisClient.set(`tenant:jid:${jid}`, data);
      count++;
    } catch (err) {
      console.error(`${LOG} Failed to warm JID ${jid}:`, err.message);
    }
  }

  console.log(`${LOG} Warmed L2 cache: ${count}/${jids.length} JIDs for tenant ${tenantId}`);
}

// ── Exports ──────────────────────────────────────────────

module.exports = {
  init,
  resolve,
  registerJid,
  unregisterJid,
  invalidate,
  extractDomainFromJid,
  warmCache,
};
