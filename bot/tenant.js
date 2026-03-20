/**
 * Multi-Tenant Support — Tenant CRUD, Encrypted Config & Credential Management
 *
 * Manages 1000+ companies sharing one bot deployment. Each tenant gets isolated
 * credentials (Salesforce, M365, Gmail), settings, email domain mapping, and
 * a per-tenant data prefix (t:{tenantId}:) for downstream modules.
 *
 * All data stored in Redis (no additional database required).
 * Secrets encrypted with AES-256-GCM using a master key.
 */

const crypto = require("crypto");
const LOG = "[Tenant]";

let redisClient = null;
let masterKey = null;

const MASTER_KEY_HEX =
  process.env.MASTER_ENCRYPTION_KEY ||
  process.env.M365_TOKEN_ENCRYPTION_KEY ||
  "";

const VALID_STATUSES = ["ACTIVE", "SUSPENDED", "PROVISIONING"];
const CREDENTIAL_PROVIDERS = ["salesforce", "m365", "gmail"];
const DEFAULT_MODULES = [
  "email",
  "calendar",
  "salesforce",
  "sharepoint",
  "briefing",
];

// ── Init ─────────────────────────────────────────────────

function init(redis) {
  redisClient = redis;

  if (MASTER_KEY_HEX && MASTER_KEY_HEX.length >= 64) {
    masterKey = Buffer.from(MASTER_KEY_HEX, "hex");
  } else {
    console.warn(
      `${LOG} No master encryption key configured — credentials will be stored in plaintext`
    );
  }

  console.log(
    `${LOG} Initialized (encryption: ${masterKey ? "enabled" : "disabled"})`
  );
}

// ── Encryption ───────────────────────────────────────────

function encrypt(text) {
  if (!masterKey) return text;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${tag}:${encrypted}`;
}

function decrypt(data) {
  if (!masterKey) return data;
  const parts = data.split(":");
  if (parts.length !== 3) return data;
  const [ivHex, tagHex, encrypted] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", masterKey, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

// ── Slug Helpers ─────────────────────────────────────────

function slugify(name) {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .substring(0, 64);
}

function isValidSlug(slug) {
  return /^[a-z0-9][a-z0-9-]{0,62}[a-z0-9]$/.test(slug) || /^[a-z0-9]$/.test(slug);
}

// ── Credential Encryption ────────────────────────────────

function encryptCredentials(credentials) {
  if (!credentials) return null;
  const encrypted = { ...credentials };
  if (encrypted.clientSecret) {
    encrypted.clientSecret = encrypt(encrypted.clientSecret);
  }
  return encrypted;
}

function decryptCredentials(credentials) {
  if (!credentials) return null;
  const decrypted = { ...credentials };
  if (decrypted.clientSecret) {
    try {
      decrypted.clientSecret = decrypt(decrypted.clientSecret);
    } catch (e) {
      console.error(`${LOG} Failed to decrypt credential secret:`, e.message);
    }
  }
  return decrypted;
}

function encryptTenantSecrets(tenant) {
  const safe = { ...tenant };
  if (safe.credentials) {
    safe.credentials = { ...safe.credentials };
    for (const provider of CREDENTIAL_PROVIDERS) {
      if (safe.credentials[provider]) {
        safe.credentials[provider] = encryptCredentials(safe.credentials[provider]);
      }
    }
  }
  if (safe.encryptionKey) {
    safe.encryptionKey = encrypt(safe.encryptionKey);
  }
  return safe;
}

function decryptTenantSecrets(tenant) {
  const clear = { ...tenant };
  if (clear.credentials) {
    clear.credentials = { ...clear.credentials };
    for (const provider of CREDENTIAL_PROVIDERS) {
      if (clear.credentials[provider]) {
        clear.credentials[provider] = decryptCredentials(clear.credentials[provider]);
      }
    }
  }
  if (clear.encryptionKey) {
    try {
      clear.encryptionKey = decrypt(clear.encryptionKey);
    } catch (e) {
      console.error(`${LOG} Failed to decrypt tenant encryption key:`, e.message);
    }
  }
  return clear;
}

// ── CRUD ─────────────────────────────────────────────────

async function createTenant({ name, slug, adminEmail, adminName, emailDomains }) {
  if (!redisClient) throw new Error("Redis not initialized");
  if (!name || !name.trim()) throw new Error("Tenant name is required");
  if (!adminEmail || !adminEmail.trim()) throw new Error("Admin email is required");

  const tenantSlug = slug ? slug.trim().toLowerCase() : slugify(name);
  if (!isValidSlug(tenantSlug)) {
    throw new Error(`Invalid slug: "${tenantSlug}" — must be lowercase alphanumeric with hyphens`);
  }

  // Check slug uniqueness
  const existingId = await redisClient.get(`tenant:slug:${tenantSlug}`);
  if (existingId) {
    throw new Error(`Slug "${tenantSlug}" is already taken`);
  }

  // Check domain uniqueness
  const domains = (emailDomains || []).map((d) => d.toLowerCase().trim()).filter(Boolean);
  for (const domain of domains) {
    const domainOwner = await redisClient.get(`tenant:domain:${domain}`);
    if (domainOwner) {
      throw new Error(`Domain "${domain}" is already assigned to another tenant`);
    }
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const tenantEncKey = crypto.randomBytes(32).toString("hex");

  const tenant = {
    id,
    slug: tenantSlug,
    name: name.trim(),
    status: "PROVISIONING",
    createdAt: now,
    updatedAt: now,
    adminEmail: adminEmail.toLowerCase().trim(),
    adminName: (adminName || "").trim(),
    emailDomains: domains,
    credentials: {
      salesforce: null,
      m365: null,
      gmail: null,
    },
    settings: {
      maxUsers: 50,
      enabledModules: [...DEFAULT_MODULES],
      welcomeMessage: null,
    },
    adminPassword: null,
    encryptionKey: tenantEncKey,
  };

  // Encrypt secrets before storage
  const storable = encryptTenantSecrets(tenant);

  // Atomic writes: record + indexes
  const pipeline = redisClient.multi();
  pipeline.set(`tenant:${id}`, JSON.stringify(storable));
  pipeline.set(`tenant:slug:${tenantSlug}`, id);
  pipeline.sAdd("tenants", id);
  for (const domain of domains) {
    pipeline.set(`tenant:domain:${domain}`, id);
  }
  await pipeline.exec();

  console.log(`${LOG} Tenant created: ${name} (${id}) slug=${tenantSlug}`);
  return tenant;
}

async function getTenant(id) {
  if (!redisClient) return null;
  const raw = await redisClient.get(`tenant:${id}`);
  if (!raw) return null;
  try {
    const tenant = JSON.parse(raw);
    return decryptTenantSecrets(tenant);
  } catch (e) {
    console.error(`${LOG} Failed to parse tenant ${id}:`, e.message);
    return null;
  }
}

async function getTenantBySlug(slug) {
  if (!redisClient || !slug) return null;
  const id = await redisClient.get(`tenant:slug:${slug.toLowerCase().trim()}`);
  if (!id) return null;
  return getTenant(id);
}

async function getTenantByDomain(domain) {
  if (!redisClient || !domain) return null;
  const id = await redisClient.get(`tenant:domain:${domain.toLowerCase().trim()}`);
  if (!id) return null;
  return getTenant(id);
}

async function updateTenant(id, updates) {
  if (!redisClient) return null;
  const tenant = await getTenant(id);
  if (!tenant) return null;

  const oldSlug = tenant.slug;
  const oldDomains = tenant.emailDomains || [];

  // Apply updates (shallow merge, protect immutable fields)
  const immutable = ["id", "createdAt"];
  for (const key of Object.keys(updates)) {
    if (immutable.includes(key)) continue;
    tenant[key] = updates[key];
  }
  tenant.updatedAt = new Date().toISOString();

  // Validate slug if changed
  if (updates.slug && updates.slug !== oldSlug) {
    const newSlug = updates.slug.toLowerCase().trim();
    if (!isValidSlug(newSlug)) {
      throw new Error(`Invalid slug: "${newSlug}"`);
    }
    const existingId = await redisClient.get(`tenant:slug:${newSlug}`);
    if (existingId && existingId !== id) {
      throw new Error(`Slug "${newSlug}" is already taken`);
    }
    tenant.slug = newSlug;
  }

  // Validate domains if changed
  const newDomains = (tenant.emailDomains || []).map((d) => d.toLowerCase().trim()).filter(Boolean);
  if (updates.emailDomains) {
    for (const domain of newDomains) {
      const domainOwner = await redisClient.get(`tenant:domain:${domain}`);
      if (domainOwner && domainOwner !== id) {
        throw new Error(`Domain "${domain}" is already assigned to another tenant`);
      }
    }
  }

  // Encrypt and store
  const storable = encryptTenantSecrets(tenant);
  const pipeline = redisClient.multi();
  pipeline.set(`tenant:${id}`, JSON.stringify(storable));

  // Re-index slug if changed
  if (updates.slug && tenant.slug !== oldSlug) {
    pipeline.del(`tenant:slug:${oldSlug}`);
    pipeline.set(`tenant:slug:${tenant.slug}`, id);
  }

  // Re-index domains if changed
  if (updates.emailDomains) {
    // Remove old domain indexes
    for (const domain of oldDomains) {
      pipeline.del(`tenant:domain:${domain}`);
    }
    // Add new domain indexes
    for (const domain of newDomains) {
      pipeline.set(`tenant:domain:${domain}`, id);
    }
    tenant.emailDomains = newDomains;
  }

  await pipeline.exec();

  console.log(`${LOG} Tenant updated: ${tenant.name} (${id})`);
  return tenant;
}

async function deleteTenant(id) {
  if (!redisClient) return false;
  const tenant = await getTenant(id);
  if (!tenant) return false;

  const pipeline = redisClient.multi();

  // Remove tenant record
  pipeline.del(`tenant:${id}`);

  // Remove slug index
  pipeline.del(`tenant:slug:${tenant.slug}`);

  // Remove domain indexes
  for (const domain of tenant.emailDomains || []) {
    pipeline.del(`tenant:domain:${domain}`);
  }

  // Remove from tenants set
  pipeline.sRem("tenants", id);

  await pipeline.exec();

  // Clean up per-tenant data keys (t:{id}:*) using SCAN to avoid blocking
  let cursor = "0";
  const prefix = `t:${id}:`;
  do {
    const result = await redisClient.scan(cursor, { MATCH: `${prefix}*`, COUNT: 100 });
    cursor = result.cursor.toString();
    const keys = result.keys;
    if (keys.length > 0) {
      await redisClient.del(keys);
    }
  } while (cursor !== "0");

  console.log(`${LOG} Tenant deleted: ${tenant.name} (${id})`);
  return true;
}

async function listTenants() {
  if (!redisClient) return [];
  const tenantIds = await redisClient.sMembers("tenants");
  const tenants = [];
  for (const id of tenantIds) {
    const tenant = await getTenant(id);
    if (tenant) tenants.push(tenant);
  }
  return tenants.sort((a, b) => a.name.localeCompare(b.name));
}

// ── Credentials ──────────────────────────────────────────

async function setTenantCredentials(id, provider, credentials) {
  if (!redisClient) return null;
  if (!CREDENTIAL_PROVIDERS.includes(provider)) {
    throw new Error(`Invalid provider: "${provider}" — must be one of: ${CREDENTIAL_PROVIDERS.join(", ")}`);
  }
  if (!credentials || typeof credentials !== "object") {
    throw new Error("Credentials must be a non-null object");
  }

  const tenant = await getTenant(id);
  if (!tenant) throw new Error(`Tenant not found: ${id}`);

  tenant.credentials[provider] = credentials;
  tenant.updatedAt = new Date().toISOString();

  const storable = encryptTenantSecrets(tenant);
  await redisClient.set(`tenant:${id}`, JSON.stringify(storable));

  console.log(`${LOG} Credentials set for tenant ${tenant.name}: ${provider}`);
  return tenant;
}

async function getTenantCredentials(id, provider) {
  if (!redisClient) return null;
  if (!CREDENTIAL_PROVIDERS.includes(provider)) {
    throw new Error(`Invalid provider: "${provider}" — must be one of: ${CREDENTIAL_PROVIDERS.join(", ")}`);
  }

  const tenant = await getTenant(id);
  if (!tenant) return null;

  return tenant.credentials[provider] || null;
}

// ── Status ───────────────────────────────────────────────

async function setTenantStatus(id, status) {
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(`Invalid status: "${status}" — must be one of: ${VALID_STATUSES.join(", ")}`);
  }
  return updateTenant(id, { status });
}

// ── Stats ────────────────────────────────────────────────

async function getStats() {
  if (!redisClient) return {};

  const tenantIds = await redisClient.sMembers("tenants");
  const tenants = [];
  for (const id of tenantIds) {
    const tenant = await getTenant(id);
    if (tenant) tenants.push(tenant);
  }

  const total = tenants.length;
  const active = tenants.filter((t) => t.status === "ACTIVE").length;
  const suspended = tenants.filter((t) => t.status === "SUSPENDED").length;
  const provisioning = tenants.filter((t) => t.status === "PROVISIONING").length;

  return {
    total,
    byStatus: { active, suspended, provisioning },
  };
}

// ── Exports ──────────────────────────────────────────────

module.exports = {
  init,
  createTenant,
  getTenant,
  getTenantBySlug,
  getTenantByDomain,
  updateTenant,
  deleteTenant,
  listTenants,
  setTenantCredentials,
  getTenantCredentials,
  setTenantStatus,
  getStats,
};
