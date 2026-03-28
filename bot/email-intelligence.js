/**
 * Email Intelligence — Priority Learning & Smart Follow-up Timing
 *
 * Two learning features that observe user behavior to improve email handling:
 *
 * 1. Priority Learning (#9): Tracks which emails users read and reply to,
 *    builds per-sender priority profiles, and provides priority boost signals
 *    to email-scheduler for smarter digest classification.
 *
 * 2. Smart Follow-up Timing (#10): Tracks when contacts typically reply,
 *    learns their response patterns (day of week, hour), and suggests
 *    optimal follow-up times.
 *
 * Uses Redis for all persistent state with TTLs (30 days for priority, 90 days for patterns).
 */

const LOG = "[Email-Intelligence]";

let redisClient = null;

// ── Redis Key Patterns ───────────────────────────────────
// email:learn:interactions:{userId}       — sorted set by timestamp (TTL 30 days)
// email:learn:sender_scores:{userId}      — hash, key=senderEmail, value=JSON (TTL 30 days)
// email:learn:reply_patterns:{userId}     — hash, key=senderEmail, value=JSON (TTL 90 days)

const KEYS = {
  interactions: (userId) => `email:learn:interactions:${userId}`,
  senderScores: (userId) => `email:learn:sender_scores:${userId}`,
  replyPatterns: (userId) => `email:learn:reply_patterns:${userId}`,
};

const TTL_30_DAYS = 30 * 24 * 60 * 60;
const TTL_90_DAYS = 90 * 24 * 60 * 60;

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

// ── Initialization ───────────────────────────────────────

function init(redis) {
  redisClient = redis;
  console.log(`${LOG} Initialized (redis: ${!!redisClient})`);
}

// ═══════════════════════════════════════════════════════════
// Feature 1: Priority Learning (#9)
// ═══════════════════════════════════════════════════════════

/**
 * Record an email interaction (read or reply).
 * Updates both the interaction log and the sender score.
 *
 * @param {string} userId
 * @param {"read"|"reply"} action
 * @param {{ emailId: string, sender: string, senderEmail: string, subject?: string }} emailData
 */
async function recordInteraction(userId, action, emailData) {
  if (!redisClient || !userId || !emailData) return;

  try {
    const timestamp = Date.now();
    const entry = JSON.stringify({
      action,
      emailId: emailData.emailId || "",
      sender: emailData.sender || "",
      senderEmail: (emailData.senderEmail || "").toLowerCase(),
      subject: emailData.subject || "",
      timestamp,
    });

    const key = KEYS.interactions(userId);

    // Add to sorted set (score = timestamp)
    await redisClient.zAdd(key, { score: timestamp, value: entry });
    await redisClient.expire(key, TTL_30_DAYS);

    // Prune entries older than 30 days
    const cutoff = timestamp - TTL_30_DAYS * 1000;
    await redisClient.zRemRangeByScore(key, 0, cutoff);

    // Update sender score
    if (emailData.senderEmail) {
      await _updateSenderScore(userId, emailData.senderEmail.toLowerCase());
    }

    console.log(`${LOG} Recorded ${action} for ${emailData.senderEmail} (user: ${userId})`);
  } catch (err) {
    console.error(`${LOG} recordInteraction error:`, err.message);
  }
}

/**
 * Recompute and store the sender score from interaction history.
 */
async function _updateSenderScore(userId, senderEmail) {
  try {
    const interactions = await _getInteractionsForSender(userId, senderEmail);
    const score = computeSenderScore(interactions);
    score.lastInteraction = Date.now();

    const key = KEYS.senderScores(userId);
    await redisClient.hSet(key, senderEmail, JSON.stringify(score));
    await redisClient.expire(key, TTL_30_DAYS);
  } catch (err) {
    console.error(`${LOG} _updateSenderScore error:`, err.message);
  }
}

/**
 * Get all interactions for a specific sender from the sorted set.
 */
async function _getInteractionsForSender(userId, senderEmail) {
  try {
    const key = KEYS.interactions(userId);
    const raw = await redisClient.zRange(key, 0, -1);
    const all = raw.map((r) => {
      try { return JSON.parse(r); } catch { return null; }
    }).filter(Boolean);

    return all.filter((i) => i.senderEmail === senderEmail);
  } catch (err) {
    console.error(`${LOG} _getInteractionsForSender error:`, err.message);
    return [];
  }
}

/**
 * Compute a sender's priority score from their interaction history.
 *
 * Scoring logic:
 * - More total interactions = higher priority
 * - Replies weighted 3x more than reads (replying signals importance)
 * - Faster average reply time = higher priority
 *
 * @param {Array} interactions — array of { action, timestamp, ... }
 * @returns {{ totalInteractions: number, reads: number, replies: number, avgResponseMinutes: number|null, priority: "high"|"normal"|"low" }}
 */
function computeSenderScore(interactions) {
  if (!interactions || interactions.length === 0) {
    return { totalInteractions: 0, reads: 0, replies: 0, avgResponseMinutes: null, priority: "normal" };
  }

  const reads = interactions.filter((i) => i.action === "read");
  const replies = interactions.filter((i) => i.action === "reply");

  // Calculate average response time between consecutive read → reply pairs
  let responseTimes = [];
  const sorted = [...interactions].sort((a, b) => a.timestamp - b.timestamp);
  let lastReadTime = null;

  for (const entry of sorted) {
    if (entry.action === "read") {
      lastReadTime = entry.timestamp;
    } else if (entry.action === "reply" && lastReadTime) {
      const minutes = (entry.timestamp - lastReadTime) / 60000;
      if (minutes >= 0 && minutes < 1440) { // Only count if < 24 hours
        responseTimes.push(minutes);
      }
      lastReadTime = null;
    }
  }

  const avgResponseMinutes = responseTimes.length > 0
    ? Math.round((responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length) * 10) / 10
    : null;

  // Weighted score: replies count 3x, reads count 1x
  const weightedScore = reads.length + replies.length * 3;

  // Priority determination
  let priority = "normal";
  if (weightedScore >= 10 || replies.length >= 3) {
    priority = "high";
  } else if (weightedScore <= 2 && replies.length === 0) {
    priority = "low";
  }

  // Fast responders get a boost
  if (avgResponseMinutes !== null && avgResponseMinutes < 15 && reads.length >= 2) {
    priority = "high";
  }

  return {
    totalInteractions: interactions.length,
    reads: reads.length,
    replies: replies.length,
    avgResponseMinutes,
    priority,
  };
}

/**
 * Get the priority data for a specific sender.
 *
 * @param {string} userId
 * @param {string} senderEmail
 * @returns {{ totalInteractions: number, avgResponseMinutes: number|null, lastInteraction: number, priority: string }|null}
 */
async function getSenderScore(userId, senderEmail) {
  if (!redisClient || !userId || !senderEmail) return null;

  try {
    const key = KEYS.senderScores(userId);
    const raw = await redisClient.hGet(key, senderEmail.toLowerCase());
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.error(`${LOG} getSenderScore error:`, err.message);
    return null;
  }
}

/**
 * Get all sender scores for a user, sorted by priority (high first).
 *
 * @param {string} userId
 * @returns {Array<{ senderEmail: string, score: object }>}
 */
async function getSenderScores(userId) {
  if (!redisClient || !userId) return [];

  try {
    const key = KEYS.senderScores(userId);
    const all = await redisClient.hGetAll(key);
    if (!all || Object.keys(all).length === 0) return [];

    const priorityOrder = { high: 0, normal: 1, low: 2 };

    return Object.entries(all)
      .map(([senderEmail, raw]) => {
        try { return { senderEmail, score: JSON.parse(raw) }; } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => {
        const pa = priorityOrder[a.score.priority] ?? 1;
        const pb = priorityOrder[b.score.priority] ?? 1;
        if (pa !== pb) return pa - pb;
        return (b.score.totalInteractions || 0) - (a.score.totalInteractions || 0);
      });
  } catch (err) {
    console.error(`${LOG} getSenderScores error:`, err.message);
    return [];
  }
}

/**
 * Get top N senders by interaction frequency.
 *
 * @param {string} userId
 * @param {number} limit
 * @returns {Array<{ senderEmail: string, score: object }>}
 */
async function getTopSenders(userId, limit = 10) {
  if (!redisClient || !userId) return [];

  try {
    const all = await getSenderScores(userId);
    return all
      .sort((a, b) => (b.score.totalInteractions || 0) - (a.score.totalInteractions || 0))
      .slice(0, limit);
  } catch (err) {
    console.error(`${LOG} getTopSenders error:`, err.message);
    return [];
  }
}

/**
 * Get priority boost for a sender — used by email-scheduler to adjust classification.
 *
 * @param {string} userId
 * @param {string} senderEmail
 * @returns {"high"|"normal"|"low"}
 */
async function getPriorityBoost(userId, senderEmail) {
  if (!redisClient || !userId || !senderEmail) return "normal";

  try {
    const score = await getSenderScore(userId, senderEmail);
    if (!score) return "normal";
    return score.priority || "normal";
  } catch (err) {
    console.error(`${LOG} getPriorityBoost error:`, err.message);
    return "normal";
  }
}

// ═══════════════════════════════════════════════════════════
// Feature 2: Smart Follow-up Timing (#10)
// ═══════════════════════════════════════════════════════════

/**
 * Record when a contact replies to an email.
 * Builds reply pattern data: day of week, hour, response time.
 *
 * @param {string} userId
 * @param {string} senderEmail — the contact who replied
 * @param {Date|string|number} sentAt — when the original email was sent
 * @param {Date|string|number} repliedAt — when the contact replied
 */
async function recordReplyReceived(userId, senderEmail, sentAt, repliedAt) {
  if (!redisClient || !userId || !senderEmail) return;

  try {
    senderEmail = senderEmail.toLowerCase();
    const sentDate = new Date(sentAt);
    const replyDate = new Date(repliedAt);

    if (isNaN(sentDate.getTime()) || isNaN(replyDate.getTime())) {
      console.warn(`${LOG} recordReplyReceived: invalid dates`);
      return;
    }

    const responseTimeHours = Math.round(((replyDate - sentDate) / 3600000) * 10) / 10;
    if (responseTimeHours < 0) return; // Invalid: reply before send

    const replyEntry = {
      dayOfWeek: replyDate.getUTCDay(),
      hour: replyDate.getUTCHours(),
      responseTimeHours,
      timestamp: replyDate.getTime(),
    };

    const key = KEYS.replyPatterns(userId);
    let existing = null;

    try {
      const raw = await redisClient.hGet(key, senderEmail);
      if (raw) existing = JSON.parse(raw);
    } catch { /* first entry */ }

    if (!existing) {
      existing = { replies: [], bestDay: null, bestHour: null, avgResponseHours: null };
    }

    existing.replies.push(replyEntry);

    // Keep only last 100 replies per contact to avoid unbounded growth
    if (existing.replies.length > 100) {
      existing.replies = existing.replies.slice(-100);
    }

    // Recompute patterns
    const patterns = _computePatterns(existing.replies);
    existing.bestDay = patterns.bestDay;
    existing.bestHour = patterns.bestHour;
    existing.avgResponseHours = patterns.avgResponseHours;

    await redisClient.hSet(key, senderEmail, JSON.stringify(existing));
    await redisClient.expire(key, TTL_90_DAYS);

    console.log(`${LOG} Recorded reply pattern for ${senderEmail} (user: ${userId}): ${responseTimeHours}h response, ${DAY_NAMES[replyDate.getUTCDay()]} ${replyDate.getUTCHours()}:00`);
  } catch (err) {
    console.error(`${LOG} recordReplyReceived error:`, err.message);
  }
}

/**
 * Compute best day, best hour, and average response time from reply entries.
 */
function _computePatterns(replies) {
  if (!replies || replies.length === 0) {
    return { bestDay: null, bestHour: null, avgResponseHours: null };
  }

  // Average response time
  const avgResponseHours = Math.round(
    (replies.reduce((sum, r) => sum + r.responseTimeHours, 0) / replies.length) * 10
  ) / 10;

  // Find most frequent day of week
  const dayCounts = new Array(7).fill(0);
  for (const r of replies) {
    dayCounts[r.dayOfWeek]++;
  }
  const bestDayIndex = dayCounts.indexOf(Math.max(...dayCounts));

  // Find most frequent hour (bucket into 2-hour windows for more useful results)
  const hourCounts = new Array(24).fill(0);
  for (const r of replies) {
    hourCounts[r.hour]++;
  }
  const bestHour = hourCounts.indexOf(Math.max(...hourCounts));

  return {
    bestDay: DAY_NAMES[bestDayIndex],
    bestHour,
    avgResponseHours,
  };
}

/**
 * Get the reply pattern for a specific contact.
 *
 * @param {string} userId
 * @param {string} senderEmail
 * @returns {{ replies: Array, bestDay: string|null, bestHour: number|null, avgResponseHours: number|null }|null}
 */
async function getReplyPattern(userId, senderEmail) {
  if (!redisClient || !userId || !senderEmail) return null;

  try {
    const key = KEYS.replyPatterns(userId);
    const raw = await redisClient.hGet(key, senderEmail.toLowerCase());
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.error(`${LOG} getReplyPattern error:`, err.message);
    return null;
  }
}

/**
 * Get the best time to follow up with a contact.
 * Returns actionable recommendation based on observed reply patterns.
 *
 * @param {string} userId
 * @param {string} senderEmail
 * @returns {{ bestDay: string, bestHour: number, avgResponseHours: number, recommendation: string, dataPoints: number }|null}
 */
async function getBestFollowUpTime(userId, senderEmail) {
  if (!redisClient || !userId || !senderEmail) return null;

  try {
    const pattern = await getReplyPattern(userId, senderEmail.toLowerCase());
    if (!pattern || !pattern.replies || pattern.replies.length === 0) return null;

    const { bestDay, bestHour, avgResponseHours } = pattern;

    // Build human-readable recommendation
    let recommendation;
    const hourStr = bestHour !== null ? `${bestHour}:00` : "morning";
    const dayStr = bestDay || "weekdays";

    if (pattern.replies.length < 3) {
      recommendation = `Limited data (${pattern.replies.length} replies). Based on what we have, ${senderEmail} tends to reply on ${dayStr} around ${hourStr}. Average response time: ${avgResponseHours}h.`;
    } else if (avgResponseHours <= 2) {
      recommendation = `${senderEmail} is a fast responder (avg ${avgResponseHours}h). They're most active on ${dayStr} around ${hourStr}. You can follow up anytime — they'll likely reply quickly.`;
    } else if (avgResponseHours <= 12) {
      recommendation = `${senderEmail} typically replies within ${avgResponseHours} hours. Best time to reach them: ${dayStr} around ${hourStr} for the fastest response.`;
    } else {
      recommendation = `${senderEmail} takes about ${avgResponseHours} hours to reply on average. They're most responsive on ${dayStr} around ${hourStr}. Consider sending your follow-up then for the best chance of a quick reply.`;
    }

    return {
      bestDay: bestDay || null,
      bestHour: bestHour !== null ? bestHour : null,
      avgResponseHours: avgResponseHours || null,
      recommendation,
      dataPoints: pattern.replies.length,
    };
  } catch (err) {
    console.error(`${LOG} getBestFollowUpTime error:`, err.message);
    return null;
  }
}

/**
 * Get all reply patterns for a user's contacts.
 *
 * @param {string} userId
 * @returns {Array<{ senderEmail: string, pattern: object }>}
 */
async function getAllReplyPatterns(userId) {
  if (!redisClient || !userId) return [];

  try {
    const key = KEYS.replyPatterns(userId);
    const all = await redisClient.hGetAll(key);
    if (!all || Object.keys(all).length === 0) return [];

    return Object.entries(all)
      .map(([senderEmail, raw]) => {
        try { return { senderEmail, pattern: JSON.parse(raw) }; } catch { return null; }
      })
      .filter(Boolean)
      .sort((a, b) => (b.pattern.replies?.length || 0) - (a.pattern.replies?.length || 0));
  } catch (err) {
    console.error(`${LOG} getAllReplyPatterns error:`, err.message);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════
// Agent Tool Definition: get_followup_timing
// ═══════════════════════════════════════════════════════════

/**
 * Returns the tool definition for the agent's get_followup_timing tool.
 * Register this in agent.js tool list.
 */
function getFollowUpTimingToolDef() {
  return {
    name: "get_followup_timing",
    description:
      "Get the best time to follow up with a contact based on their reply patterns. " +
      "Use when user asks 'when should I follow up with X?' or 'best time to email X'.",
    input_schema: {
      type: "object",
      properties: {
        contact_name: {
          type: "string",
          description: "The contact's display name (for context in the response)",
        },
        contact_email: {
          type: "string",
          description: "The contact's email address (used to look up reply patterns)",
        },
      },
      required: ["contact_email"],
    },
  };
}

/**
 * Execute the get_followup_timing tool.
 *
 * @param {string} userId
 * @param {{ contact_name?: string, contact_email: string }} input
 * @returns {object} — result for the agent
 */
async function executeFollowUpTimingTool(userId, input) {
  const contactEmail = (input.contact_email || "").toLowerCase();
  const contactName = input.contact_name || contactEmail;

  if (!contactEmail) {
    return { error: "contact_email is required" };
  }

  const timing = await getBestFollowUpTime(userId, contactEmail);

  if (!timing) {
    return {
      contact: contactName,
      email: contactEmail,
      status: "no_data",
      message: `No reply pattern data available for ${contactName} (${contactEmail}). The system hasn't observed enough interactions yet to suggest a follow-up time.`,
    };
  }

  return {
    contact: contactName,
    email: contactEmail,
    status: "ok",
    bestDay: timing.bestDay,
    bestHour: timing.bestHour,
    avgResponseHours: timing.avgResponseHours,
    dataPoints: timing.dataPoints,
    recommendation: timing.recommendation,
  };
}

// ── Exports ──────────────────────────────────────────────

module.exports = {
  init,
  // Priority Learning (#9)
  recordInteraction,
  computeSenderScore,
  getSenderScore,
  getSenderScores,
  getTopSenders,
  getPriorityBoost,
  // Follow-up Timing (#10)
  recordReplyReceived,
  getReplyPattern,
  getBestFollowUpTime,
  getAllReplyPatterns,
  // Agent tool
  getFollowUpTimingToolDef,
  executeFollowUpTimingTool,
};
