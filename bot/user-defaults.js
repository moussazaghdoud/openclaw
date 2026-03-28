/**
 * User Defaults — Auto-provision settings for new users
 *
 * When a user activates via /admin invitation, this module
 * copies default settings to their account. Each user can
 * then customize their own settings independently.
 *
 * Defaults are stored in Redis under "defaults:*" keys.
 * Admin can update defaults via /api/admin/defaults endpoint.
 */

const LOG = "[UserDefaults]";

let redisClient = null;
let emailSchedulerModule = null;
let salesSchedulerModule = null;
let emailIntelligenceModule = null;

const DEFAULTS_KEY = "defaults:config";

// Built-in defaults (used when no admin config exists)
const BUILT_IN_DEFAULTS = {
  email_digest: {
    enabled: true,
    time: "08:00",
    auto_actions: true,
    crm_enrichment: true,
    max_emails: 50,
  },
  sales_alerts: {
    enabled: true,
    timezone: "Europe/Paris",
    dailyTime: 8,
    weeklyDay: 1,
    daily_digest: { enabled: true, time: "08:00" },
    weekly_summary: { enabled: true, day: "Monday", time: "09:00" },
    stale_deal_alert: { enabled: true, min_days_inactive: 14, min_amount: 50000 },
    close_date_alert: { enabled: true, days_before: 7 },
    high_value_alert: { enabled: true, min_amount: 100000 },
  },
  email_rules: [
    {
      category: "EMT",
      match_type: "sender",
      match_values: ["EMT", "ROBINEAU", "BLECKEN", "ZAGHDOUD", "EL KHODRY", "ZHANG", "MOHAMAD", "LILY"],
      description: "Executive Management Team",
    },
  ],
};

function init(deps) {
  redisClient = deps.redis || null;
  emailSchedulerModule = deps.emailScheduler || null;
  salesSchedulerModule = deps.salesScheduler || null;
  emailIntelligenceModule = deps.emailIntelligence || null;
  console.log(`${LOG} Initialized`);
}

/**
 * Get the current default config (admin-customizable).
 */
async function getDefaults() {
  if (!redisClient) return BUILT_IN_DEFAULTS;
  try {
    const raw = await redisClient.get(DEFAULTS_KEY);
    if (raw) return { ...BUILT_IN_DEFAULTS, ...JSON.parse(raw) };
  } catch {}
  return BUILT_IN_DEFAULTS;
}

/**
 * Update the default config (admin action).
 */
async function setDefaults(config) {
  if (!redisClient) return false;
  try {
    await redisClient.set(DEFAULTS_KEY, JSON.stringify(config));
    console.log(`${LOG} Defaults updated`);
    return true;
  } catch (e) {
    console.error(`${LOG} Failed to save defaults:`, e.message);
    return false;
  }
}

/**
 * Provision a new user with default settings.
 * Called when a user activates via /admin invitation.
 */
async function provisionUser(userId) {
  if (!redisClient) return { error: "Redis not available" };

  const defaults = await getDefaults();
  const results = [];

  try {
    // 1. Email digest settings
    if (emailSchedulerModule && defaults.email_digest) {
      await emailSchedulerModule.setUserPrefs(userId, {
        enabled: defaults.email_digest.enabled,
        time: defaults.email_digest.time,
        auto_actions: defaults.email_digest.auto_actions,
        crm_enrichment: defaults.email_digest.crm_enrichment,
        max_emails: defaults.email_digest.max_emails,
        email_digest: defaults.email_digest,
      });
      await emailSchedulerModule.enableAlerts(userId);
      results.push("email digest enabled");
    }

    // 2. Sales alerts
    if (salesSchedulerModule && defaults.sales_alerts) {
      await salesSchedulerModule.setUserPrefs(userId, defaults.sales_alerts);
      await salesSchedulerModule.enableAlerts(userId);
      results.push("sales alerts enabled");
    }

    // 3. Email classification rules
    if (emailSchedulerModule && defaults.email_rules && defaults.email_rules.length > 0) {
      for (const rule of defaults.email_rules) {
        await emailSchedulerModule.addClassificationRule(userId, rule);
      }
      results.push(`${defaults.email_rules.length} email rules applied`);
    }

    console.log(`${LOG} User ${userId} provisioned: ${results.join(", ")}`);
    return { success: true, provisioned: results };
  } catch (e) {
    console.error(`${LOG} Provisioning failed for ${userId}:`, e.message);
    return { error: e.message };
  }
}

module.exports = {
  init,
  getDefaults,
  setDefaults,
  provisionUser,
};
