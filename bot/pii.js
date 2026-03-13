/**
 * PII/PPI client — anonymize/deanonymize text, manage secure mode.
 *
 * Two layers of anonymization (both active in secure mode):
 * 1. ALE PPI list — proprietary product/brand names replaced with [PRODUCT_N] placeholders
 * 2. Presidio API — personal data (names, emails, phones, etc.) if PRESIDIO_URL is set
 *
 * The ALE PPI list is persisted in Redis so it survives redeployments.
 * Uses Node 22 built-in fetch — no extra dependencies.
 */

const PRESIDIO_URL = (process.env.PRESIDIO_URL || "").replace(/\/+$/, "");
const LOG = "[PII]";

let redisClient = null;
const localSecureMode = new Map();
const localMappings = new Map();

// ── Built-in ALE PPI terms (sorted longest-first for greedy matching) ──

const DEFAULT_PPI_TERMS = [
  // Company names
  "Alcatel-Lucent Enterprise USA Inc.", "Alcatel-Lucent Enterprise", "ALE International",
  "ALE USA Inc.", "Alcatel-Lucent", "Nokia",
  // Trademarks with class designations (longest first)
  "OPENTOUCH (cl. 09) (2nd filing)", "OPENTOUCH (cl. 09 & 38)",
  "OMNIACCESS (cl. 09)", "OMNIPCX (cl. 09)", "OMNIPCX (cl. 38)", "OMNIPCX (cl. 42)",
  "OMNITOUCH (cl. 09)", "OMNIVISTA (cl. 09)", "OPENTOUCH (cl. 09)", "OPENTOUCH (cl. 38)",
  "OPENTOUCH (cl.09)", "Rainbow (cl.38)", "Rainbow (cl.42)",
  "ALE (cl. 09)", "ALE (cl. 38)", "ALE (cl. 42)",
  // Full product names
  "OmniVista 8770 Network Management System", "OmniVista Network Management Platform",
  "OmniVista Network Advisor", "OmniVista Smart Tool",
  "OmniPCX Enterprise Communication Server", "OmniPCX Open Gateway", "OmniPCX RECORD Suite",
  "OpenTouch Enterprise Cloud", "OpenTouch Session Border Controller", "OpenTouch Conversation®",
  "OmniAccess Stellar AP1570 Series", "OmniAccess Stellar AP1360 Series",
  "OmniAccess Stellar AP1320-Series", "OmniAccess Stellar Asset Tracking",
  "OmniAccess Stellar AP1261", "OmniAccess Stellar AP1301H", "OmniAccess Stellar AP1301",
  "OmniAccess Stellar AP1311", "OmniAccess Stellar AP1331", "OmniAccess Stellar AP1351",
  "OmniAccess Stellar AP1411", "OmniAccess Stellar AP1431", "OmniAccess Stellar AP1451",
  "OmniAccess Stellar AP1501", "OmniAccess Stellar AP1511", "OmniAccess Stellar AP1521",
  "OmniAccess Stellar AP1561",
  "OmniSwitch Milestone Plugin",
  "OmniSwitch 6860(E and N)", "OmniSwitch 6560(E)",
  "OmniSwitch 2260", "OmniSwitch 2360", "OmniSwitch 6360", "OmniSwitch 6465T",
  "OmniSwitch 6465", "OmniSwitch 6570M", "OmniSwitch 6575", "OmniSwitch 6865",
  "OmniSwitch 6870", "OmniSwitch 6900", "OmniSwitch 6920", "OmniSwitch 9900",
  "SIP-DECT Base Stations", "DECT Base Stations", "SIP-DECT Handsets", "DECT Handsets",
  "WLAN Handsets", "Aries Series Headsets",
  "IP Desktop Softphone", "ALE SIP Deskphones", "ALE DeskPhones", "Smart DeskPhones",
  "Visual Automated Attendant", "Dispatch Console",
  "Rainbow Developer Platform", "Rainbow App Connector", "Rainbow Hospitality",
  "Rainbow cloud", "Rainbow open",
  "Unified Management Center", "Fleet Supervision",
  "Digital Age Networking", "Digital Age Communications",
  "Shortest Path Bridging (SPB)", "Purple on Demand", "SD-WAN & SASE",
  "Autonomous Network", "Hybrid POL", "OmniFabric",
  "WHERE EVERYTHING CONNECTS", "WO SICH ALLES VERBINDET", "Where Everything Connects",
  "R Rainbow (semi-figurative)", "R (semi-figurative)",
  "EXPERIENCE DAYS", "Enterprise Rainbow",
  "OXO Connect", "ALE Connect", "ALE Softphone",
  "OpenTouch Conversation", "OPENTOUCH CONVERSATION",
  // Core brand names / trademarks
  "al-enterprise.com",
  "IP Touch®", "My IC Phone®", "OmniAccess®", "OmniPCX®", "OmniSwitch®",
  "OmniTouch®", "OmniVista®", "OpenTouch®", "Rainbow™",
  "OMNIACCESS", "OMNIPCX", "OMNISTACK", "OMNISWITCH", "OMNITOUCH", "OMNIVISTA",
  "OPENTOUCH", "MY TEAMWORK", "MY IC PHONE", "IP TOUCH", "PIMPHONY", "PIMphony",
  "PAPILLON", "SUNBOW", "BLOOM", "Sipwse",
  "OpenRainbow", "Rainbow", "ALE",
];

// Runtime PPI list — starts with defaults, can be extended via Redis
let ppiTerms = [...DEFAULT_PPI_TERMS];

/**
 * Optionally inject a connected Redis client for persistence.
 * Loads custom PPI terms from Redis if available.
 */
async function init(redis) {
  redisClient = redis;
  if (redisClient) {
    try {
      const custom = await redisClient.get("ppi:custom_terms");
      if (custom) {
        const customTerms = JSON.parse(custom);
        // Merge: custom terms first (they may override defaults)
        const allTerms = [...new Set([...customTerms, ...DEFAULT_PPI_TERMS])];
        ppiTerms = allTerms.sort((a, b) => b.length - a.length);
        console.log(`${LOG} Loaded ${customTerms.length} custom PPI terms from Redis (${ppiTerms.length} total)`);
      } else {
        // Persist defaults to Redis on first run
        await redisClient.set("ppi:custom_terms", JSON.stringify(DEFAULT_PPI_TERMS));
        console.log(`${LOG} Saved ${DEFAULT_PPI_TERMS.length} default PPI terms to Redis`);
      }
    } catch (e) {
      console.warn(`${LOG} Redis PPI terms load error:`, e.message);
    }
  }
  // Ensure sorted longest-first
  ppiTerms.sort((a, b) => b.length - a.length);
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

// ── PPI anonymization (built-in, no external service needed) ──

/**
 * Replace ALE PPI terms with [PRODUCT_1], [PRODUCT_2], etc.
 * Returns { text, ppiMapping } where ppiMapping maps placeholders to originals.
 */
function anonymizePPI(text) {
  const ppiMapping = {};
  let counter = 0;
  let result = text;

  for (const term of ppiTerms) {
    // Case-insensitive search but preserve the matched case in the mapping
    const regex = new RegExp(escapeRegex(term), "gi");
    let match;
    while ((match = regex.exec(result)) !== null) {
      counter++;
      const placeholder = `[PRODUCT_${counter}]`;
      ppiMapping[placeholder] = match[0]; // preserve original case
      result = result.substring(0, match.index) + placeholder + result.substring(match.index + match[0].length);
      // Reset regex since we modified the string
      regex.lastIndex = match.index + placeholder.length;
    }
  }

  return { text: result, ppiMapping };
}

/**
 * Reverse PPI anonymization: replace [PRODUCT_N] placeholders with originals.
 */
function deanonymizePPI(text, ppiMapping) {
  if (!ppiMapping || Object.keys(ppiMapping).length === 0) return text;
  let result = text;
  // Replace longest placeholders first (higher numbers first)
  const sorted = Object.keys(ppiMapping).sort((a, b) => b.length - a.length);
  for (const ph of sorted) {
    result = result.replaceAll(ph, ppiMapping[ph]);
  }
  return result;
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── Main anonymize/deanonymize ───────────────────────────

async function anonymize(text) {
  // Step 1: Replace ALE PPI terms (always, no external service needed)
  const { text: ppiCleanText, ppiMapping } = anonymizePPI(text);
  const ppiCount = Object.keys(ppiMapping).length;
  if (ppiCount > 0) {
    console.log(`${LOG} PPI anonymized: ${ppiCount} terms replaced`);
  }

  // Step 2: Presidio for personal data (names, emails, phones, etc.)
  let finalText = ppiCleanText;
  let presidioMapping = {};

  if (PRESIDIO_URL) {
    try {
      const resp = await fetch(`${PRESIDIO_URL}/anonymize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: ppiCleanText }),
        signal: AbortSignal.timeout(10000),
      });
      if (resp.ok) {
        const data = await resp.json();
        finalText = data.anonymized_text;
        presidioMapping = data.mapping || {};
      } else {
        console.warn(`${LOG} Presidio /anonymize returned ${resp.status}`);
      }
    } catch (e) {
      console.warn(`${LOG} Presidio unreachable:`, e.message);
    }
  }

  // Merge both mappings
  const mapping = { ...presidioMapping, ...ppiMapping };
  return { anonymizedText: finalText, mapping };
}

async function deanonymize(text, mapping) {
  if (!mapping || Object.keys(mapping).length === 0) return text;

  // Separate PPI mappings ([PRODUCT_N]) from Presidio mappings
  const ppiMapping = {};
  const presidioMapping = {};
  for (const [k, v] of Object.entries(mapping)) {
    if (k.startsWith("[PRODUCT_")) {
      ppiMapping[k] = v;
    } else {
      presidioMapping[k] = v;
    }
  }

  let result = text;

  // Step 1: Presidio deanonymize (if available and has mappings)
  if (PRESIDIO_URL && Object.keys(presidioMapping).length > 0) {
    try {
      const resp = await fetch(`${PRESIDIO_URL}/deanonymize`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: result, mapping: presidioMapping }),
        signal: AbortSignal.timeout(10000),
      });
      if (resp.ok) {
        const data = await resp.json();
        result = data.text;
      } else {
        // Local fallback
        for (const ph of Object.keys(presidioMapping).sort((a, b) => b.length - a.length)) {
          result = result.replaceAll(ph, presidioMapping[ph]);
        }
      }
    } catch (e) {
      console.warn(`${LOG} Presidio deanonymize unreachable — local fallback:`, e.message);
      for (const ph of Object.keys(presidioMapping).sort((a, b) => b.length - a.length)) {
        result = result.replaceAll(ph, presidioMapping[ph]);
      }
    }
  } else if (Object.keys(presidioMapping).length > 0) {
    // No Presidio — local fallback
    for (const ph of Object.keys(presidioMapping).sort((a, b) => b.length - a.length)) {
      result = result.replaceAll(ph, presidioMapping[ph]);
    }
  }

  // Step 2: Restore PPI terms
  result = deanonymizePPI(result, ppiMapping);

  return result;
}

module.exports = { init, isSecureMode, setSecureMode, anonymize, deanonymize, storePiiMapping, getPiiMapping };
