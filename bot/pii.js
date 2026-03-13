/**
 * Presidio PII client — anonymize/deanonymize text, manage secure mode.
 *
 * Requires: PRESIDIO_URL env var (e.g. http://presidio-service:5002)
 * Uses Node 22 built-in fetch — no extra dependencies.
 */

const PRESIDIO_URL = (process.env.PRESIDIO_URL || "").replace(/\/+$/, "");
const LOG = "[PII]";

// In-memory fallback for secure mode flags and PII mappings.
// If a Redis client is injected via init(), it's used instead.
let redisClient = null;
const localSecureMode = new Map();
const localMappings = new Map();

/**
 * Optionally inject a connected Redis client for persistence.
 */
function init(redis) {
  redisClient = redis;
}

// ── Secure mode ──────────────────────────────────────────

async function isSecureMode(historyKey) {
  if (redisClient) {
    try {
      const val = await redisClient.get(`pii:secure:${historyKey}`);
      return val === "1";
    } catch { /* fall through */ }
  }
  return !!localSecureMode.get(historyKey);
}

async function setSecureMode(historyKey, enabled) {
  if (redisClient) {
    try {
      if (enabled) {
        await redisClient.set(`pii:secure:${historyKey}`, "1", { EX: 86400 * 7 });
      } else {
        await redisClient.del(`pii:secure:${historyKey}`);
        await redisClient.del(`pii:mapping:${historyKey}`);
      }
    } catch (e) {
      console.warn(`${LOG} Redis setSecureMode error:`, e.message);
    }
  }
  if (enabled) {
    localSecureMode.set(historyKey, true);
  } else {
    localSecureMode.delete(historyKey);
    localMappings.delete(historyKey);
  }
}

// ── PII mapping storage ─────────────────────────────────

async function storePiiMapping(historyKey, mapping) {
  if (!mapping || Object.keys(mapping).length === 0) return;
  // Merge into existing mapping
  const existing = await getPiiMapping(historyKey);
  const merged = { ...existing, ...mapping };

  if (redisClient) {
    try {
      await redisClient.set(`pii:mapping:${historyKey}`, JSON.stringify(merged), { EX: 86400 * 7 });
    } catch (e) {
      console.warn(`${LOG} Redis storePiiMapping error:`, e.message);
    }
  }
  localMappings.set(historyKey, merged);
}

async function getPiiMapping(historyKey) {
  if (redisClient) {
    try {
      const raw = await redisClient.get(`pii:mapping:${historyKey}`);
      if (raw) return JSON.parse(raw);
    } catch { /* fall through */ }
  }
  return localMappings.get(historyKey) || {};
}

// ── Presidio API calls ──────────────────────────────────

async function anonymize(text) {
  if (!PRESIDIO_URL) {
    console.warn(`${LOG} PRESIDIO_URL not set — passing text through unchanged`);
    return { anonymizedText: text, mapping: {} };
  }
  try {
    const resp = await fetch(`${PRESIDIO_URL}/anonymize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      console.warn(`${LOG} Presidio /anonymize returned ${resp.status}`);
      return { anonymizedText: text, mapping: {} };
    }
    const data = await resp.json();
    return { anonymizedText: data.anonymized_text, mapping: data.mapping || {} };
  } catch (e) {
    console.warn(`${LOG} Presidio unreachable — passing text through:`, e.message);
    return { anonymizedText: text, mapping: {} };
  }
}

async function deanonymize(text, mapping) {
  if (!mapping || Object.keys(mapping).length === 0) return text;
  if (!PRESIDIO_URL) {
    // Local fallback: simple string replacement
    let result = text;
    for (const ph of Object.keys(mapping).sort((a, b) => b.length - a.length)) {
      result = result.replaceAll(ph, mapping[ph]);
    }
    return result;
  }
  try {
    const resp = await fetch(`${PRESIDIO_URL}/deanonymize`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, mapping }),
      signal: AbortSignal.timeout(10000),
    });
    if (!resp.ok) {
      console.warn(`${LOG} Presidio /deanonymize returned ${resp.status}`);
      // Fallback to local replacement
      let result = text;
      for (const ph of Object.keys(mapping).sort((a, b) => b.length - a.length)) {
        result = result.replaceAll(ph, mapping[ph]);
      }
      return result;
    }
    const data = await resp.json();
    return data.text;
  } catch (e) {
    console.warn(`${LOG} Presidio deanonymize unreachable — local fallback:`, e.message);
    let result = text;
    for (const ph of Object.keys(mapping).sort((a, b) => b.length - a.length)) {
      result = result.replaceAll(ph, mapping[ph]);
    }
    return result;
  }
}

module.exports = { init, isSecureMode, setSecureMode, anonymize, deanonymize, storePiiMapping, getPiiMapping };
