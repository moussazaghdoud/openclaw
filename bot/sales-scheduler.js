/**
 * Sales Agent — Proactive Sales Alerts & Scheduled Digests
 *
 * Sends proactive Rainbow messages to opted-in users:
 * - Daily morning digest: deals closing this week, stale deals, past close dates
 * - Weekly Monday digest: full pipeline summary
 * - Instant alerts: when high-value deals go stale
 *
 * Uses Redis for user preferences, dedup locks, and opt-in tracking.
 * Timezone handling via simple hour offset (no library needed).
 */

const cfg = require("./sales-config");
const LOG = "[Sales-Scheduler]";

let redisClient, sfAuthModule, sfApiModule, salesAnalyzer, sendMessageFn;
let dailyTimer = null;
let weeklyTimer = null;
let alertTimer = null;

// ── Redis Key Patterns ───────────────────────────────────
// sales:schedule:users                          — SET of opted-in user IDs
// sales:schedule:prefs:{userId}                 — JSON { timezone, dailyTime, weeklyDay, alertsEnabled }
// sales:schedule:lock:daily:{userId}:{YYYY-MM-DD}  — dedup lock, 24h TTL
// sales:schedule:lock:weekly:{userId}:{YYYY-Www}   — dedup lock, 7d TTL
// sales:schedule:lock:alert:{userId}:{oppId}       — dedup lock, 24h TTL

const KEYS = {
  users: "sales:schedule:users",
  prefs: (userId) => `sales:schedule:prefs:${userId}`,
  lockDaily: (userId, date) => `sales:schedule:lock:daily:${userId}:${date}`,
  lockWeekly: (userId, week) => `sales:schedule:lock:weekly:${userId}:${week}`,
  lockAlert: (userId, oppId) => `sales:schedule:lock:alert:${userId}:${oppId}`,
};

const DEFAULT_PREFS = {
  timezone: "Europe/Paris",  // UTC+1 (winter) / UTC+2 (summer)
  dailyTime: 8,              // 8:00 AM local time
  weeklyDay: 1,              // Monday (0=Sun, 1=Mon, ...)
  alertsEnabled: true,
  // Per-alert configuration
  daily_digest: { enabled: true, time: "08:00" },
  weekly_summary: { enabled: true, day: "Monday", time: "09:00" },
  stale_deal_alert: { enabled: true, min_days_inactive: 14, min_amount: 0 },
  close_date_alert: { enabled: true, days_before: 7 },
  high_value_alert: { enabled: true, min_amount: 100000 },
};

// Simple timezone offsets (no library needed)
// DST approximation: last Sunday of March to last Sunday of October
const TIMEZONE_OFFSETS = {
  "Europe/Paris": { standard: 1, dst: 2 },
  "Europe/London": { standard: 0, dst: 1 },
  "Europe/Berlin": { standard: 1, dst: 2 },
  "America/New_York": { standard: -5, dst: -4 },
  "America/Chicago": { standard: -6, dst: -5 },
  "America/Denver": { standard: -7, dst: -6 },
  "America/Los_Angeles": { standard: -8, dst: -7 },
  "Asia/Tokyo": { standard: 9, dst: 9 },
  "Asia/Singapore": { standard: 8, dst: 8 },
  "UTC": { standard: 0, dst: 0 },
};

// ── Init ──────────────────────────────────────────────────

/**
 * Initialize the scheduler module.
 *
 * @param {Object} deps - Dependencies
 * @param {Object} deps.redis       - Redis client
 * @param {Object} deps.sfAuth      - Salesforce auth module (getValidToken)
 * @param {Object} deps.sfApi       - Salesforce API module
 * @param {Object} deps.analyzer    - Sales analyzer module (analyzePipeline)
 * @param {Function} deps.sendMessage - function(userId, text) to send Rainbow message
 */
function init(deps) {
  redisClient = deps.redis || null;
  sfAuthModule = deps.sfAuth || null;
  sfApiModule = deps.sfApi || null;
  salesAnalyzer = deps.analyzer || null;
  sendMessageFn = deps.sendMessage || null;

  if (!redisClient) {
    console.warn(`${LOG} Redis not available — scheduler disabled`);
    return;
  }
  if (!sfAuthModule) {
    console.warn(`${LOG} Salesforce auth not available — scheduler disabled`);
    return;
  }
  if (!salesAnalyzer) {
    console.warn(`${LOG} Sales analyzer not available — scheduler disabled`);
    return;
  }
  if (!sendMessageFn) {
    console.warn(`${LOG} sendMessage not available — scheduler disabled`);
    return;
  }

  startSchedulers();
  console.log(`${LOG} Initialized (redis: ${!!redisClient}, sfAuth: ${!!sfAuthModule}, analyzer: ${!!salesAnalyzer})`);
}

// ── Schedulers ────────────────────────────────────────────

function startSchedulers() {
  // Daily digest: check every 5 minutes if it's morning digest time for any user
  dailyTimer = setInterval(async () => {
    try {
      await checkDailyDigests();
    } catch (err) {
      console.error(`${LOG} Daily digest error:`, err.message);
    }
  }, 5 * 60 * 1000);
  if (dailyTimer.unref) dailyTimer.unref();

  // Weekly digest: check every 15 minutes if it's Monday morning for any user
  weeklyTimer = setInterval(async () => {
    try {
      await checkWeeklyDigests();
    } catch (err) {
      console.error(`${LOG} Weekly digest error:`, err.message);
    }
  }, 15 * 60 * 1000);
  if (weeklyTimer.unref) weeklyTimer.unref();

  // Instant alerts: scan every 30 minutes for newly stale high-value deals
  alertTimer = setInterval(async () => {
    try {
      await checkInstantAlerts();
    } catch (err) {
      console.error(`${LOG} Instant alert error:`, err.message);
    }
  }, 30 * 60 * 1000);
  if (alertTimer.unref) alertTimer.unref();

  console.log(`${LOG} Schedulers started (daily: 5min, weekly: 15min, alerts: 30min)`);
}

// ── Daily Digests ─────────────────────────────────────────

async function checkDailyDigests() {
  if (!redisClient) return;

  const userIds = await redisClient.sMembers(KEYS.users);
  if (!userIds || userIds.length === 0) return;

  for (const userId of userIds) {
    try {
      const prefs = await getUserPrefs(userId);
      const now = new Date();
      const userHour = getLocalHour(now, prefs.timezone);
      const userMinute = getLocalMinute(now, prefs.timezone);

      // Check if current time matches dailyTime (within +/-5 min window)
      // dailyTime can be integer hour (8) or from daily_digest.time string ("08:30")
      let targetMinute;
      if (prefs.daily_digest?.time) {
        const parts = prefs.daily_digest.time.split(":");
        targetMinute = parseInt(parts[0], 10) * 60 + (parseInt(parts[1], 10) || 0);
      } else {
        targetMinute = (prefs.dailyTime || 8) * 60;
      }
      if (prefs.daily_digest?.enabled === false) continue;
      const currentMinute = userHour * 60 + userMinute;
      if (Math.abs(currentMinute - targetMinute) > 5) continue;

      // Dedup lock: one digest per user per day
      const dateStr = formatLocalDate(now, prefs.timezone);
      const lockKey = KEYS.lockDaily(userId, dateStr);
      const acquired = await redisClient.set(lockKey, "1", { NX: true, EX: 24 * 3600 });
      if (!acquired) continue;

      // Stagger digests to avoid thundering herd when all users share the same time
      const staggerDelay = Math.floor(Math.random() * 30000);
      await new Promise(r => setTimeout(r, staggerDelay));

      console.log(`${LOG} Sending daily digest to ${userId}`);

      // Get SF token
      const tokenData = await sfAuthModule.getValidToken(userId);
      if (!tokenData || !tokenData.token) {
        console.warn(`${LOG} No SF token for ${userId} — skipping daily digest`);
        continue;
      }

      // Run analysis
      const report = await salesAnalyzer.analyzePipeline(
        tokenData.token,
        tokenData.instanceUrl,
        userId
      );
      if (!report || report.error) {
        console.warn(`${LOG} Analysis failed for ${userId}: ${report?.error || "unknown"}`);
        continue;
      }

      // Build and send digest
      const text = buildDailyDigest(report);
      await sendMessageFn(userId, text);
      console.log(`${LOG} Daily digest sent to ${userId}`);
    } catch (err) {
      console.error(`${LOG} Daily digest error for ${userId}:`, err.message);
    }
  }
}

// ── Weekly Digests ────────────────────────────────────────

async function checkWeeklyDigests() {
  if (!redisClient) return;

  const userIds = await redisClient.sMembers(KEYS.users);
  if (!userIds || userIds.length === 0) return;

  for (const userId of userIds) {
    try {
      const prefs = await getUserPrefs(userId);
      const now = new Date();
      const userDay = getLocalDay(now, prefs.timezone);

      // Only on Monday (or configured weeklyDay)
      if (userDay !== (prefs.weeklyDay ?? 1)) continue;

      const userHour = getLocalHour(now, prefs.timezone);
      const userMinute = getLocalMinute(now, prefs.timezone);

      // Same time window as daily
      const targetMinute = prefs.dailyTime * 60;
      const currentMinute = userHour * 60 + userMinute;
      if (Math.abs(currentMinute - targetMinute) > 15) continue;

      // Dedup lock by ISO week
      const weekStr = getISOWeekString(now, prefs.timezone);
      const lockKey = KEYS.lockWeekly(userId, weekStr);
      const acquired = await redisClient.set(lockKey, "1", { NX: true, EX: 7 * 24 * 3600 });
      if (!acquired) continue;

      console.log(`${LOG} Sending weekly digest to ${userId}`);

      const tokenData = await sfAuthModule.getValidToken(userId);
      if (!tokenData || !tokenData.token) {
        console.warn(`${LOG} No SF token for ${userId} — skipping weekly digest`);
        continue;
      }

      const report = await salesAnalyzer.analyzePipeline(
        tokenData.token,
        tokenData.instanceUrl,
        userId
      );
      if (!report || report.error) {
        console.warn(`${LOG} Analysis failed for ${userId}: ${report?.error || "unknown"}`);
        continue;
      }

      const text = buildWeeklyDigest(report);
      await sendMessageFn(userId, text);
      console.log(`${LOG} Weekly digest sent to ${userId}`);
    } catch (err) {
      console.error(`${LOG} Weekly digest error for ${userId}:`, err.message);
    }
  }
}

// ── Instant Alerts ────────────────────────────────────────

async function checkInstantAlerts() {
  if (!redisClient) return;

  const userIds = await redisClient.sMembers(KEYS.users);
  if (!userIds || userIds.length === 0) return;

  for (const userId of userIds) {
    try {
      const prefs = await getUserPrefs(userId);
      if (!prefs.alertsEnabled) continue;

      const tokenData = await sfAuthModule.getValidToken(userId);
      if (!tokenData || !tokenData.token) continue;

      const report = await salesAnalyzer.analyzePipeline(
        tokenData.token,
        tokenData.instanceUrl,
        userId
      );
      if (!report || report.error || !report.deals) continue;

      // Find high-value deals that are stale — use user prefs for thresholds
      const minAmount = prefs.high_value_alert?.min_amount || cfg.HIGH_VALUE_THRESHOLD;
      const minDays = prefs.stale_deal_alert?.min_days_inactive || cfg.STALE_DEAL_DAYS;
      if (prefs.high_value_alert?.enabled === false && prefs.stale_deal_alert?.enabled === false) continue;

      const atRiskDeals = report.deals.filter(d =>
        d.amount >= minAmount &&
        d.daysSinceActivity >= minDays
      );

      // Only alert on NEW stale deals (not already locked)
      const newAlerts = [];
      for (const deal of atRiskDeals) {
        const lockKey = KEYS.lockAlert(userId, deal.id);
        const acquired = await redisClient.set(lockKey, "1", { NX: true, EX: 7 * 24 * 3600 }); // 7-day lock
        if (acquired) newAlerts.push(deal);
      }

      if (newAlerts.length === 0) continue;

      // Send ONE consolidated message with top 5 new alerts
      const top5 = newAlerts
        .sort((a, b) => b.amount - a.amount)
        .slice(0, 5);
      const lines = [`\u26a0\ufe0f ${newAlerts.length} deal(s) newly at risk:\n`];
      for (const deal of top5) {
        lines.push(`- ${deal.name} (${formatAmount(deal.amount)}) — ${deal.daysSinceActivity} days inactive`);
      }
      if (newAlerts.length > 5) {
        lines.push(`\n...and ${newAlerts.length - 5} more. Ask "deals at risk" for the full list.`);
      }
      await sendMessageFn(userId, lines.join("\n"));
      console.log(`${LOG} Consolidated alert sent to ${userId}: ${newAlerts.length} deals`);
    } catch (err) {
      console.error(`${LOG} Instant alert error for ${userId}:`, err.message);
    }
  }
}

// ══════════════════════════════════════════════════════════
// DIGEST FORMATTERS
// ══════════════════════════════════════════════════════════

function buildDailyDigest(report) {
  const lines = [];
  lines.push("\ud83d\udcca Morning Pipeline Digest");
  lines.push("");

  const now = new Date();
  const deals = report.deals || [];

  // Deals closing this week (0-7 days)
  const closingThisWeek = deals.filter(d =>
    d.daysUntilClose >= 0 && d.daysUntilClose <= 7
  ).sort((a, b) => a.daysUntilClose - b.daysUntilClose);

  lines.push(`Deals closing this week: ${closingThisWeek.length}`);
  if (closingThisWeek.length > 0) {
    for (const d of closingThisWeek) {
      const amountStr = formatAmount(d.amount);
      const dayLabel = getCloseDayLabel(d.daysUntilClose, now);
      lines.push(`- ${d.name} (${amountStr}) \u2014 closes ${dayLabel}`);
    }
  }
  lines.push("");

  // Stale deals — top 5 by amount (highest value at risk)
  const staleDeals = deals.filter(d =>
    d.daysSinceActivity >= cfg.STALE_DEAL_DAYS
  ).sort((a, b) => b.amount - a.amount);

  lines.push(`\u26a0\ufe0f Stale deals (no activity ${cfg.STALE_DEAL_DAYS}+ days): ${staleDeals.length}`);
  if (staleDeals.length > 0) {
    const totalStaleValue = staleDeals.reduce((s, d) => s + (d.amount || 0), 0);
    lines.push(`Total at-risk value: ${formatAmount(totalStaleValue)}`);
    const top5 = staleDeals.slice(0, 5);
    for (const d of top5) {
      const amountStr = formatAmount(d.amount);
      lines.push(`- ${d.name} (${amountStr}) \u2014 ${d.daysSinceActivity} days inactive`);
    }
    if (staleDeals.length > 5) {
      lines.push(`...and ${staleDeals.length - 5} more stale deals`);
    }
  }
  lines.push("");

  // Past close date — top 5 by amount
  const pastClose = deals.filter(d =>
    d.daysUntilClose < 0
  ).sort((a, b) => b.amount - a.amount);

  lines.push(`\ud83d\udd34 Past close date: ${pastClose.length}`);
  if (pastClose.length > 0) {
    const top5 = pastClose.slice(0, 5);
    for (const d of top5) {
      const amountStr = formatAmount(d.amount);
      const overdueDays = Math.abs(d.daysUntilClose);
      lines.push(`- ${d.name} (${amountStr}) \u2014 ${overdueDays} days overdue`);
    }
    if (pastClose.length > 5) {
      lines.push(`...and ${pastClose.length - 5} more overdue deals`);
    }
  }

  return lines.join("\n");
}

function buildWeeklyDigest(report) {
  const lines = [];
  lines.push("\ud83d\udcc8 Weekly Pipeline Summary");
  lines.push("");

  const summary = report.summary || {};
  const deals = report.deals || [];

  // Pipeline totals
  lines.push(`Total pipeline value: ${formatAmount(summary.totalPipeline || 0)}`);
  lines.push(`Weighted pipeline: ${formatAmount(summary.weightedPipeline || 0)}`);
  lines.push(`Total deals: ${summary.totalDeals || 0}`);
  lines.push(`High-value deals (\u2265${formatAmount(cfg.HIGH_VALUE_THRESHOLD)}): ${summary.highValueDeals || 0}`);
  lines.push(`Strategic deals (\u2265${formatAmount(cfg.STRATEGIC_THRESHOLD)}): ${summary.strategicDeals || 0}`);
  lines.push("");

  // Risk distribution
  const risk = summary.riskDistribution || {};
  lines.push("Risk distribution:");
  lines.push(`- \ud83d\udd34 High risk: ${risk.High || 0}`);
  lines.push(`- \ud83d\udfe1 Medium risk: ${risk.Medium || 0}`);
  lines.push(`- \ud83d\udfe2 Low risk: ${risk.Low || 0}`);
  lines.push("");

  // Issue summary
  const issues = summary.issueCounts || {};
  lines.push("Issues detected:");
  lines.push(`- Stale deals: ${issues.staleDeals || 0}`);
  lines.push(`- Missing next steps: ${issues.missingNextSteps || 0}`);
  lines.push(`- Past close date: ${issues.pastCloseDate || 0}`);
  lines.push(`- Stage inconsistencies: ${issues.stageInconsistency || 0}`);
  lines.push(`- Ghost deals: ${issues.ghostDeals || 0}`);
  lines.push("");

  // Top 5 deals by amount
  const topDeals = deals
    .sort((a, b) => (b.amount || 0) - (a.amount || 0))
    .slice(0, 5);

  if (topDeals.length > 0) {
    lines.push("Top deals:");
    for (const d of topDeals) {
      const amountStr = formatAmount(d.amount);
      const riskBadge = d.riskLevel === "High" ? "\ud83d\udd34"
        : d.riskLevel === "Medium" ? "\ud83d\udfe1"
        : "\ud83d\udfe2";
      lines.push(`- ${d.name} (${amountStr}) ${riskBadge} ${d.stage}`);
    }
  }

  // Stage distribution
  const stages = summary.stageDistribution || {};
  const stageEntries = Object.entries(stages).sort((a, b) => b[1].totalAmount - a[1].totalAmount);
  if (stageEntries.length > 0) {
    lines.push("");
    lines.push("Pipeline by stage:");
    for (const [stage, data] of stageEntries) {
      lines.push(`- ${stage}: ${data.count} deals (${formatAmount(data.totalAmount)})`);
    }
  }

  return lines.join("\n");
}

// ══════════════════════════════════════════════════════════
// USER PREFERENCE MANAGEMENT
// ══════════════════════════════════════════════════════════

/**
 * Get user preferences, falling back to defaults.
 */
async function getUserPrefs(userId) {
  if (!redisClient) return { ...DEFAULT_PREFS };

  try {
    const raw = await redisClient.get(KEYS.prefs(userId));
    if (raw) {
      return { ...DEFAULT_PREFS, ...JSON.parse(raw) };
    }
  } catch (err) {
    console.error(`${LOG} Error reading prefs for ${userId}:`, err.message);
  }

  return { ...DEFAULT_PREFS };
}

/**
 * Set user preferences (partial update, merges with existing).
 */
async function setUserPrefs(userId, prefs) {
  if (!redisClient) return false;

  try {
    const existing = await getUserPrefs(userId);
    const merged = { ...existing, ...prefs };

    // Validate timezone
    if (merged.timezone && !TIMEZONE_OFFSETS[merged.timezone]) {
      console.warn(`${LOG} Unknown timezone ${merged.timezone}, falling back to default`);
      merged.timezone = DEFAULT_PREFS.timezone;
    }

    // Validate dailyTime (0-23)
    if (typeof merged.dailyTime === "number") {
      merged.dailyTime = Math.max(0, Math.min(23, Math.round(merged.dailyTime)));
    }

    // Validate weeklyDay (0-6)
    if (typeof merged.weeklyDay === "number") {
      merged.weeklyDay = Math.max(0, Math.min(6, Math.round(merged.weeklyDay)));
    }

    await redisClient.set(KEYS.prefs(userId), JSON.stringify(merged));

    // Ensure user is in the opted-in set
    await redisClient.sAdd(KEYS.users, userId);

    console.log(`${LOG} Prefs updated for ${userId}:`, merged);
    return true;
  } catch (err) {
    console.error(`${LOG} Error saving prefs for ${userId}:`, err.message);
    return false;
  }
}

/**
 * Enable proactive alerts for a user (opt-in).
 * Adds to the scheduled users set with default prefs if not already present.
 */
async function enableAlerts(userId) {
  if (!redisClient) return false;

  try {
    await redisClient.sAdd(KEYS.users, userId);

    // Set default prefs if none exist
    const existing = await redisClient.get(KEYS.prefs(userId));
    if (!existing) {
      await redisClient.set(KEYS.prefs(userId), JSON.stringify(DEFAULT_PREFS));
    } else {
      // Ensure alertsEnabled is true
      const prefs = JSON.parse(existing);
      prefs.alertsEnabled = true;
      await redisClient.set(KEYS.prefs(userId), JSON.stringify(prefs));
    }

    console.log(`${LOG} Alerts enabled for ${userId}`);
    return true;
  } catch (err) {
    console.error(`${LOG} Error enabling alerts for ${userId}:`, err.message);
    return false;
  }
}

/**
 * Disable proactive alerts for a user (opt-out).
 * Removes from the scheduled users set.
 */
async function disableAlerts(userId) {
  if (!redisClient) return false;

  try {
    await redisClient.sRem(KEYS.users, userId);

    // Update prefs to reflect disabled state
    const existing = await redisClient.get(KEYS.prefs(userId));
    if (existing) {
      const prefs = JSON.parse(existing);
      prefs.alertsEnabled = false;
      await redisClient.set(KEYS.prefs(userId), JSON.stringify(prefs));
    }

    console.log(`${LOG} Alerts disabled for ${userId}`);
    return true;
  } catch (err) {
    console.error(`${LOG} Error disabling alerts for ${userId}:`, err.message);
    return false;
  }
}

// ══════════════════════════════════════════════════════════
// TIMEZONE HELPERS
// ══════════════════════════════════════════════════════════

/**
 * Get UTC offset in hours for a timezone, accounting for DST.
 * Uses simple approximation: DST from last Sunday of March to last Sunday of October.
 */
function getTimezoneOffset(timezone) {
  const tz = TIMEZONE_OFFSETS[timezone] || TIMEZONE_OFFSETS["Europe/Paris"];
  const now = new Date();
  const month = now.getUTCMonth(); // 0-11

  // Approximate DST: April through September (months 3-9)
  // More precise: last Sunday of March to last Sunday of October
  if (month >= 3 && month <= 9) {
    return tz.dst;
  }
  if (month === 2) {
    // March: DST starts last Sunday
    const lastDay = new Date(Date.UTC(now.getUTCFullYear(), 3, 0));
    const lastSunday = lastDay.getUTCDate() - lastDay.getUTCDay();
    if (now.getUTCDate() >= lastSunday) return tz.dst;
  }
  if (month === 10) {
    // October: DST ends last Sunday
    const lastDay = new Date(Date.UTC(now.getUTCFullYear(), 11, 0));
    const lastSunday = lastDay.getUTCDate() - lastDay.getUTCDay();
    if (now.getUTCDate() < lastSunday) return tz.dst;
  }
  return tz.standard;
}

function getLocalHour(date, timezone) {
  const offset = getTimezoneOffset(timezone);
  const localHour = (date.getUTCHours() + offset + 24) % 24;
  return localHour;
}

function getLocalMinute(date, timezone) {
  // Minutes are the same regardless of integer hour offset
  return date.getUTCMinutes();
}

function getLocalDay(date, timezone) {
  const offset = getTimezoneOffset(timezone);
  const localDate = new Date(date.getTime() + offset * 3600 * 1000);
  return localDate.getUTCDay(); // 0=Sun, 1=Mon, ...
}

function formatLocalDate(date, timezone) {
  const offset = getTimezoneOffset(timezone);
  const localDate = new Date(date.getTime() + offset * 3600 * 1000);
  const yyyy = localDate.getUTCFullYear();
  const mm = String(localDate.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(localDate.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/**
 * Get ISO week string for dedup (e.g. "2026-W13").
 */
function getISOWeekString(date, timezone) {
  const offset = getTimezoneOffset(timezone);
  const localDate = new Date(date.getTime() + offset * 3600 * 1000);

  // ISO week calculation
  const d = new Date(Date.UTC(localDate.getUTCFullYear(), localDate.getUTCMonth(), localDate.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNo = Math.ceil((((d - yearStart) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNo).padStart(2, "0")}`;
}

// ══════════════════════════════════════════════════════════
// FORMAT HELPERS
// ══════════════════════════════════════════════════════════

function formatAmount(amount) {
  if (!amount || amount === 0) return "$0";
  if (amount >= 1000000) return `$${(amount / 1000000).toFixed(1)}M`;
  if (amount >= 1000) return `$${(amount / 1000).toFixed(0)}K`;
  return `$${amount.toFixed(0)}`;
}

/**
 * Get a human-readable day label for close date.
 * E.g. "today", "tomorrow", "Wednesday", "in 5 days"
 */
function getCloseDayLabel(daysUntilClose, now) {
  if (daysUntilClose === 0) return "today";
  if (daysUntilClose === 1) return "tomorrow";
  if (daysUntilClose <= 7) {
    const closeDate = new Date(now.getTime() + daysUntilClose * 24 * 3600 * 1000);
    const days = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
    return days[closeDate.getDay()];
  }
  return `in ${daysUntilClose} days`;
}

// ── Stop ──────────────────────────────────────────────────

function stop() {
  if (dailyTimer) {
    clearInterval(dailyTimer);
    dailyTimer = null;
  }
  if (weeklyTimer) {
    clearInterval(weeklyTimer);
    weeklyTimer = null;
  }
  if (alertTimer) {
    clearInterval(alertTimer);
    alertTimer = null;
  }
  console.log(`${LOG} Schedulers stopped`);
}

// ── Exports ───────────────────────────────────────────────

/**
 * Apply alert configuration from an uploaded JSON file.
 * Expected format:
 * {
 *   "timezone": "Europe/Paris",
 *   "daily_digest": { "enabled": true, "time": "08:00" },
 *   "weekly_summary": { "enabled": true, "day": "Monday", "time": "09:00" },
 *   "stale_deal_alert": { "enabled": true, "min_days_inactive": 14, "min_amount": 50000 },
 *   "close_date_alert": { "enabled": true, "days_before": 7 },
 *   "high_value_alert": { "enabled": true, "min_amount": 100000 }
 * }
 */
async function applyConfigFile(userId, jsonContent) {
  try {
    const config = typeof jsonContent === "string" ? JSON.parse(jsonContent) : jsonContent;
    const prefs = await getUserPrefs(userId);

    // Map config file fields to prefs
    if (config.timezone) prefs.timezone = config.timezone;
    if (config.daily_digest) prefs.daily_digest = { ...prefs.daily_digest, ...config.daily_digest };
    if (config.weekly_summary) prefs.weekly_summary = { ...prefs.weekly_summary, ...config.weekly_summary };
    if (config.stale_deal_alert) prefs.stale_deal_alert = { ...prefs.stale_deal_alert, ...config.stale_deal_alert };
    if (config.close_date_alert) prefs.close_date_alert = { ...prefs.close_date_alert, ...config.close_date_alert };
    if (config.high_value_alert) prefs.high_value_alert = { ...prefs.high_value_alert, ...config.high_value_alert };

    // Sync top-level fields from config
    if (config.daily_digest?.time) {
      const hour = parseInt(config.daily_digest.time.split(":")[0], 10);
      if (!isNaN(hour)) prefs.dailyTime = hour;
    }
    if (config.weekly_summary?.day) {
      const dayMap = { Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6 };
      if (dayMap[config.weekly_summary.day] !== undefined) prefs.weeklyDay = dayMap[config.weekly_summary.day];
    }

    prefs.alertsEnabled = true;
    await setUserPrefs(userId, prefs);
    await enableAlerts(userId);

    // Build summary of what was configured
    const summary = [];
    if (prefs.daily_digest?.enabled) summary.push(`Daily digest at ${prefs.daily_digest.time || "08:00"}`);
    else summary.push("Daily digest: disabled");
    if (prefs.weekly_summary?.enabled) summary.push(`Weekly summary on ${prefs.weekly_summary.day || "Monday"}`);
    else summary.push("Weekly summary: disabled");
    if (prefs.stale_deal_alert?.enabled) summary.push(`Stale deal alert: ${prefs.stale_deal_alert.min_days_inactive}+ days, min $${prefs.stale_deal_alert.min_amount || 0}`);
    else summary.push("Stale deal alert: disabled");
    if (prefs.close_date_alert?.enabled) summary.push(`Close date alert: ${prefs.close_date_alert.days_before} days before`);
    else summary.push("Close date alert: disabled");
    if (prefs.high_value_alert?.enabled) summary.push(`High-value alert: deals > $${prefs.high_value_alert.min_amount}`);
    else summary.push("High-value alert: disabled");

    console.log(`${LOG} Config file applied for ${userId}`);
    return { success: true, timezone: prefs.timezone, alerts: summary };
  } catch (e) {
    console.error(`${LOG} Config file parse error:`, e.message);
    return { error: `Invalid config file: ${e.message}` };
  }
}

/**
 * Manually trigger a daily digest for a user (bypasses time check and dedup lock).
 * For testing purposes.
 */
async function triggerDailyDigest(userId) {
  if (!redisClient || !sfAuthModule || !salesAnalyzer || !sendMessageFn) {
    return { error: "Scheduler not fully initialized" };
  }

  try {
    const tokenData = await sfAuthModule.getValidToken(userId);
    if (!tokenData || !tokenData.token) {
      return { error: `No SF token for ${userId}` };
    }

    const report = await salesAnalyzer.analyzePipeline(tokenData.token, tokenData.instanceUrl, userId);
    if (!report || report.error) {
      return { error: `Analysis failed: ${report?.error || "unknown"}` };
    }

    const text = buildDailyDigest(report);
    await sendMessageFn(userId, text);
    console.log(`${LOG} Manual daily digest sent to ${userId}`);
    return { success: true, message: "Daily digest sent", preview: text.substring(0, 200) };
  } catch (e) {
    console.error(`${LOG} Manual digest error:`, e.message);
    return { error: e.message };
  }
}

module.exports = { init, stop, getUserPrefs, setUserPrefs, enableAlerts, disableAlerts, applyConfigFile, triggerDailyDigest };
