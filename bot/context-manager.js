/**
 * Context Manager — Unified Conversation Context Layer
 *
 * Provides seamless context across all 3 AI paths:
 *   - Agent (Sonnet) — gets recent conversation + file context
 *   - Chat (Opus via OpenClaw) — gets entities + agent summaries + file context
 *   - Document — gets file references
 *
 * Stores unified messages in Redis sorted sets alongside the legacy
 * history:{userId} for backward compatibility.
 */

const LOG = "[Context]";

let redisClient = null;

const MAX_ENTRIES = 50;           // Max messages per user
const CONTEXT_TTL = 24 * 3600;    // 24h TTL
const ENTITY_TTL = 2 * 3600;      // 2h TTL for entities
const META_TTL = 3600;             // 1h TTL for meta
const MAX_CONTEXT_CHARS = 8000;    // ~2000 tokens budget for context injection

// In-memory cache for hot path
const contextCache = new Map();

function init(redis) {
  redisClient = redis;
  console.log(`${LOG} Initialized (redis: ${!!redis})`);
}

// ══════════════════════════════════════════════════════════
// WRITE — Record messages from all paths
// ══════════════════════════════════════════════════════════

/**
 * Record a message from any path.
 * @param {string} userId - User/conversation key
 * @param {string} role - "user" | "assistant" | "system"
 * @param {string} content - Message text
 * @param {object} metadata - { path, toolsUsed, entitiesResolved, filesReferenced, summary }
 */
async function addEntry(userId, role, content, metadata = {}) {
  if (!redisClient || !content) return;

  const ts = Date.now();
  const entry = {
    role,
    content: content.substring(0, 5000), // cap per-entry size
    ts,
    path: metadata.path || "unknown",
  };
  if (metadata.toolsUsed) entry.toolsUsed = metadata.toolsUsed;
  if (metadata.summary) entry.summary = metadata.summary;
  if (metadata.filesReferenced) entry.files = metadata.filesReferenced;

  const key = `context:${userId}:messages`;
  try {
    await redisClient.zAdd(key, { score: ts, value: JSON.stringify(entry) });
    // Trim to max entries (remove oldest)
    const count = await redisClient.zCard(key);
    if (count > MAX_ENTRIES) {
      await redisClient.zRemRangeByRank(key, 0, count - MAX_ENTRIES - 1);
    }
    await redisClient.expire(key, CONTEXT_TTL);

    // Invalidate cache
    contextCache.delete(userId);
  } catch (e) {
    console.warn(`${LOG} addEntry error:`, e.message);
  }

  // Extract and store entities from agent responses
  if (metadata.entitiesResolved && Object.keys(metadata.entitiesResolved).length > 0) {
    await updateEntities(userId, metadata.entitiesResolved);
  }

  // Update meta
  if (metadata.path || metadata.filesReferenced) {
    await updateMeta(userId, {
      lastPath: metadata.path,
      lastActivity: new Date(ts).toISOString(),
      ...(metadata.filesReferenced ? { activeFiles: metadata.filesReferenced } : {}),
    });
  }
}

/**
 * Store resolved entities (from agent working memory).
 */
async function updateEntities(userId, entities) {
  if (!redisClient) return;
  const key = `context:${userId}:entities`;
  try {
    for (const [name, value] of Object.entries(entities)) {
      const val = typeof value === "object" ? JSON.stringify(value) : String(value);
      await redisClient.hSet(key, name, val);
    }
    await redisClient.expire(key, ENTITY_TTL);
  } catch (e) {
    console.warn(`${LOG} updateEntities error:`, e.message);
  }
}

/**
 * Update session metadata.
 */
async function updateMeta(userId, meta) {
  if (!redisClient) return;
  const key = `context:${userId}:meta`;
  try {
    for (const [k, v] of Object.entries(meta)) {
      const val = typeof v === "object" ? JSON.stringify(v) : String(v);
      await redisClient.hSet(key, k, val);
    }
    await redisClient.expire(key, META_TTL);
  } catch (e) {
    console.warn(`${LOG} updateMeta error:`, e.message);
  }
}

// ══════════════════════════════════════════════════════════
// READ — Build context for each path
// ══════════════════════════════════════════════════════════

/**
 * Get recent messages from unified store.
 */
async function getRecentMessages(userId, maxCount = 20) {
  if (!redisClient) return [];
  try {
    const key = `context:${userId}:messages`;
    const raw = await redisClient.zRange(key, -maxCount, -1);
    return raw.map(r => {
      try { return JSON.parse(r); } catch { return null; }
    }).filter(Boolean);
  } catch (e) {
    console.warn(`${LOG} getRecentMessages error:`, e.message);
    return [];
  }
}

/**
 * Get stored entities.
 */
async function getEntities(userId) {
  if (!redisClient) return {};
  try {
    const key = `context:${userId}:entities`;
    return await redisClient.hGetAll(key) || {};
  } catch {
    return {};
  }
}

/**
 * Get session meta.
 */
async function getMeta(userId) {
  if (!redisClient) return {};
  try {
    const key = `context:${userId}:meta`;
    return await redisClient.hGetAll(key) || {};
  } catch {
    return {};
  }
}

/**
 * Build context for the CHAT path (callOpenClaw).
 * Returns a text block to inject into the system prompt.
 *
 * Includes: entities, agent summaries, file context, recent activity.
 * This gives Opus the awareness of what Sonnet discovered.
 */
async function getContextForChat(userId) {
  // Check cache
  if (contextCache.has(userId)) {
    const cached = contextCache.get(userId);
    if (Date.now() - cached.ts < 30000) return cached.value; // 30s cache
  }

  const [entities, meta, messages] = await Promise.all([
    getEntities(userId),
    getMeta(userId),
    getRecentMessages(userId, 10),
  ]);

  const parts = [];

  // Entities
  if (Object.keys(entities).length > 0) {
    const entityLines = Object.entries(entities)
      .map(([name, val]) => `- "${name}" = ${val}`)
      .slice(0, 15);
    parts.push(`KNOWN ENTITIES:\n${entityLines.join("\n")}`);
  }

  // Recent agent activity (summaries of what the agent did)
  const agentMessages = messages.filter(m => m.path === "agent" && m.role === "assistant");
  if (agentMessages.length > 0) {
    const summaries = agentMessages.slice(-5).map(m => {
      const summary = m.summary || truncate(m.content, 150);
      const tools = m.toolsUsed ? ` [tools: ${m.toolsUsed.join(", ")}]` : "";
      return `- ${summary}${tools}`;
    });
    parts.push(`RECENT AI ACTIVITY:\n${summaries.join("\n")}`);
  }

  // Active files
  if (meta.activeFiles) {
    try {
      const files = JSON.parse(meta.activeFiles);
      if (files.length > 0) {
        parts.push(`ACTIVE FILES:\n- ${files.join("\n- ")}`);
      }
    } catch {}
  }

  const result = parts.length > 0 ? parts.join("\n\n") : "";

  // Cache
  contextCache.set(userId, { ts: Date.now(), value: result });

  return result;
}

/**
 * Build context for the AGENT path (agent.run).
 * Returns a brief summary to inject alongside working memory.
 *
 * Kept short and advisory — agent should still call tools for data.
 * Filtered to avoid PERSON_N placeholders (PII issue #46).
 */
async function getContextForAgent(userId) {
  const messages = await getRecentMessages(userId, 6);
  if (messages.length === 0) return "";

  // Filter out PII-tainted entries
  const clean = messages.filter(m =>
    !m.content.includes("PERSON_") && !m.content.includes("[PRODUCT_")
  );
  if (clean.length === 0) return "";

  // Build brief conversation summary
  const recent = clean.slice(-4).map(m => {
    const prefix = m.role === "user" ? "User" : "Assistant";
    const pathNote = m.path && m.path !== "unknown" ? ` (via ${m.path})` : "";
    return `${prefix}${pathNote}: ${truncate(m.content, 200)}`;
  });

  return `Recent conversation:\n${recent.join("\n")}\n\nNote: Always verify data with tools. This is for context only.`;
}

/**
 * Sync agent working memory entities into the unified store.
 * Called after agent.run() completes.
 */
async function syncAgentMemory(userId, agentMemory) {
  if (!agentMemory) return;

  // Extract resolved entities
  if (agentMemory.resolvedEntities) {
    const entities = {};
    for (const [name, data] of Object.entries(agentMemory.resolvedEntities)) {
      entities[name] = typeof data === "object" ? (data.value || JSON.stringify(data)) : data;
    }
    if (Object.keys(entities).length > 0) {
      await updateEntities(userId, entities);
    }
  }

  // Extract current target
  if (agentMemory.currentTarget) {
    await updateMeta(userId, { currentTarget: agentMemory.currentTarget });
  }
}

/**
 * Generate a brief 1-2 sentence summary of a response.
 * Heuristic — no AI call needed.
 */
function generateSummary(text) {
  if (!text) return "";
  // If response has numbered items, summarize count
  const listMatch = text.match(/^\d+\.\s/gm);
  if (listMatch && listMatch.length > 2) {
    const firstLine = text.split("\n").find(l => l.trim().length > 10) || "";
    return `Found ${listMatch.length} items. ${truncate(firstLine.replace(/^#+\s*/, ""), 100)}`;
  }
  // Take first meaningful sentence
  const firstSentence = text.replace(/^#+\s*/gm, "").split(/[.!?\n]/).find(s => s.trim().length > 15);
  return truncate(firstSentence || text, 150);
}

// ══════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════

function truncate(text, maxLen) {
  if (!text || text.length <= maxLen) return text || "";
  return text.substring(0, maxLen).trimEnd() + "...";
}

module.exports = {
  init,
  addEntry,
  updateEntities,
  updateMeta,
  getRecentMessages,
  getEntities,
  getMeta,
  getContextForChat,
  getContextForAgent,
  syncAgentMemory,
  generateSummary,
};
