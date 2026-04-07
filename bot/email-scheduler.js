/**
 * Email Scheduler — Daily Email Digest & Follow-up Tracking
 *
 * Sends proactive Rainbow messages to opted-in users:
 * - Daily morning digest: fetch unread emails, classify with AI, apply Outlook actions, enrich with CRM
 * - Follow-up tracker: detect sent emails with no reply after 3 days, alert user
 *
 * Uses Redis for user preferences, dedup locks, and opt-in tracking.
 * Timezone handling via simple hour offset (no library needed).
 */

const LOG = "[Email-Scheduler]";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";

let redisClient, m365AuthModule, graphModule, sfAuthModule, sfApiModule, sendMessageFn;
let dailyTimer = null;
let followupTimer = null;

// ── Redis Key Patterns ───────────────────────────────────
// email:schedule:users                              — SET of opted-in user IDs
// email:schedule:prefs:{userId}                     — JSON prefs
// email:schedule:lock:daily:{userId}:{YYYY-MM-DD}   — dedup lock, 24h TTL

const KEYS = {
  users: "email:schedule:users",
  prefs: (userId) => `email:schedule:prefs:${userId}`,
  lockDaily: (userId, date) => `email:schedule:lock:daily:${userId}:${date}`,
};

const DEFAULT_PREFS = {
  timezone: "Europe/Paris",
  email_digest: {
    enabled: true,
    time: "08:00",
    max_emails: 50,
    crm_enrichment: true,
    auto_actions: true,
    hide_noise: false,
  },
  alertsEnabled: true,
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
 * Initialize the email scheduler module.
 *
 * @param {Object} deps - Dependencies
 * @param {Object} deps.redis       - Redis client
 * @param {Object} deps.m365Auth    - Microsoft 365 auth module (getValidToken)
 * @param {Object} deps.graph       - Microsoft Graph API module
 * @param {Object} [deps.sfAuth]    - Salesforce auth module (optional, for CRM enrichment)
 * @param {Object} [deps.sfApi]     - Salesforce API module (optional, for CRM enrichment)
 * @param {Function} deps.sendMessage - function(userId, text) to send Rainbow message
 */
function init(deps) {
  redisClient = deps.redis || null;
  m365AuthModule = deps.m365Auth || null;
  graphModule = deps.graph || null;
  sfAuthModule = deps.sfAuth || null;
  sfApiModule = deps.sfApi || null;
  sendMessageFn = deps.sendMessage || null;

  if (!redisClient) {
    console.warn(`${LOG} Redis not available — scheduler disabled`);
    return;
  }
  if (!m365AuthModule) {
    console.warn(`${LOG} M365 auth not available — scheduler disabled`);
    return;
  }
  if (!graphModule) {
    console.warn(`${LOG} Graph module not available — scheduler disabled`);
    return;
  }
  if (!sendMessageFn) {
    console.warn(`${LOG} sendMessage not available — scheduler disabled`);
    return;
  }

  startSchedulers();
  console.log(`${LOG} Initialized (redis: ${!!redisClient}, m365Auth: ${!!m365AuthModule}, graph: ${!!graphModule}, sfAuth: ${!!sfAuthModule}, anthropic: ${!!ANTHROPIC_API_KEY})`);
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

  // Follow-up tracker: check every 12 hours for unreplied sent emails
  followupTimer = setInterval(async () => {
    try {
      await checkFollowups();
    } catch (err) {
      console.error(`${LOG} Follow-up tracker error:`, err.message);
    }
  }, 12 * 60 * 60 * 1000);
  if (followupTimer.unref) followupTimer.unref();

  console.log(`${LOG} Schedulers started (daily: 5min, followup: 12h)`);
}

// ══════════════════════════════════════════════════════════
// DAILY EMAIL DIGEST (R1)
// ══════════════════════════════════════════════════════════

async function checkDailyDigests() {
  if (!redisClient) return;

  const userIds = await redisClient.sMembers(KEYS.users);
  if (!userIds || userIds.length === 0) return;

  for (const userId of userIds) {
    try {
      const prefs = await getUserPrefs(userId);
      if (prefs.email_digest?.enabled === false) continue;

      const now = new Date();
      const userHour = getLocalHour(now, prefs.timezone);
      const userMinute = getLocalMinute(now, prefs.timezone);

      // Parse target time from prefs
      let targetMinute;
      if (prefs.email_digest?.time) {
        const parts = prefs.email_digest.time.split(":");
        targetMinute = parseInt(parts[0], 10) * 60 + (parseInt(parts[1], 10) || 0);
      } else {
        targetMinute = 8 * 60; // default 08:00
      }
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

      console.log(`${LOG} Sending daily email digest to ${userId}`);

      // Get M365 token
      const tokenData = await m365AuthModule.getValidToken(userId);
      if (!tokenData || !tokenData.token) {
        console.warn(`${LOG} No M365 token for ${userId} — skipping email digest`);
        continue;
      }

      // Fetch unread emails
      const maxEmails = prefs.email_digest?.max_emails || 50;
      const emails = await graphModule.getUnreadEmails(tokenData.token, maxEmails);
      if (!emails || emails._error) {
        console.warn(`${LOG} Failed to fetch emails for ${userId}: ${emails?._error || "unknown"}`);
        continue;
      }
      if (emails.length === 0) {
        console.log(`${LOG} No unread emails for ${userId} — skipping digest`);
        continue;
      }

      // Classify emails with AI
      let classified;
      if (ANTHROPIC_API_KEY) {
        classified = await classifyEmails(emails, userId);
      } else {
        // Fallback: classify by importance field
        classified = emails.map(e => ({
          ...e,
          category: e.importance === "high" ? "URGENT" : "FYI",
          action_needed: "",
        }));
      }

      // Apply Outlook actions if enabled
      if (prefs.email_digest?.auto_actions !== false) {
        await applyOutlookActions(tokenData.token, classified, graphModule);
      }

      // CRM enrichment if available
      let crmContext = {};
      if (prefs.email_digest?.crm_enrichment !== false && sfAuthModule && sfApiModule) {
        crmContext = await enrichWithCRM(userId, classified);
      }

      // Build and send digest
      const text = buildEmailDigest(classified, crmContext, prefs);
      await sendMessageFn(userId, text);
      console.log(`${LOG} Daily email digest sent to ${userId} (${emails.length} emails classified)`);
    } catch (err) {
      console.error(`${LOG} Daily digest error for ${userId}:`, err.message);
    }
  }
}

// ── AI Classification ────────────────────────────────────

// ── Classification Rules (Redis-backed, user-configurable) ──

/**
 * Get classification rules for a user.
 * Rules format: [{ category: "EMT", match_type: "sender", match_values: ["ROBINEAU", "BLECKEN"], description: "Executive Management Team", outlook_action: "flag+category" }]
 */
async function getClassificationRules(userId) {
  if (!redisClient) return [];
  try {
    const raw = await redisClient.get(`email:rules:${userId}`);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

async function setClassificationRules(userId, rules) {
  if (!redisClient) return false;
  try {
    await redisClient.set(`email:rules:${userId}`, JSON.stringify(rules));
    console.log(`${LOG} Rules saved for ${userId}: ${rules.length} rules`);
    return true;
  } catch (e) {
    console.error(`${LOG} Failed to save rules:`, e.message);
    return false;
  }
}

async function addClassificationRule(userId, rule) {
  const rules = await getClassificationRules(userId);
  // Check for duplicate category+match
  const existing = rules.findIndex(r => r.category === rule.category && r.match_type === rule.match_type);
  if (existing >= 0) {
    // Merge values
    const merged = new Set([...(rules[existing].match_values || []), ...(rule.match_values || [])]);
    rules[existing].match_values = [...merged];
    rules[existing].description = rule.description || rules[existing].description;
  } else {
    rules.push(rule);
  }
  return setClassificationRules(userId, rules);
}

async function removeClassificationRule(userId, category) {
  const rules = await getClassificationRules(userId);
  const filtered = rules.filter(r => r.category.toUpperCase() !== category.toUpperCase());
  if (filtered.length === rules.length) return false;
  return setClassificationRules(userId, filtered);
}

function buildRulesPrompt(rules) {
  if (!rules || rules.length === 0) return "";
  const lines = ["CUSTOM CLASSIFICATION RULES (these take priority over default categories):"];
  for (const rule of rules) {
    const values = (rule.match_values || []).join(", ");
    if (rule.match_type === "sender") {
      lines.push(`- ${rule.category}: Emails from any of these senders (by last name): ${values}. ${rule.description || ""}`);
    } else if (rule.match_type === "subject") {
      lines.push(`- ${rule.category}: Emails with subject containing: ${values}. ${rule.description || ""}`);
    } else if (rule.match_type === "domain") {
      lines.push(`- ${rule.category}: Emails from these domains: ${values}. ${rule.description || ""}`);
    }
    lines.push(`  IMPORTANT: Classify matching emails as ${rule.category} regardless of content.`);
  }
  return lines.join("\n");
}

function getCustomCategories(rules) {
  if (!rules || rules.length === 0) return [];
  return [...new Set(rules.map(r => r.category.toUpperCase()))];
}

/**
 * Classify emails using Anthropic API (Claude Sonnet).
 * Sends subjects, senders, and previews in a batch prompt.
 * Returns array of { ...email, category, action_needed }.
 */
async function classifyEmails(emails, userId) {
  if (!ANTHROPIC_API_KEY || emails.length === 0) return emails.map(e => ({ ...e, category: "FYI", action_needed: "" }));

  // Load custom rules from Redis
  const rules = await getClassificationRules(userId);
  const customRulesText = buildRulesPrompt(rules);
  const customCategories = getCustomCategories(rules);
  const allCategories = ["URGENT", "ACTION", "FYI", "SYSTEM", ...customCategories, "NOISE"];

  const emailData = emails.map((e, i) => ({
    index: i,
    id: e.id,
    from: e.from,
    fromEmail: e.fromEmail,
    subject: e.subject,
    preview: (e.preview || "").substring(0, 150),
    importance: e.importance,
    hasAttachments: e.hasAttachments,
  }));

  const systemPrompt = `You are an executive email classifier. Classify each email into exactly one category:
- URGENT: Requires immediate attention from a HUMAN sender (deadlines today/tomorrow, escalations, executive requests, time-sensitive approvals)
- ACTION: Requires a response or action within 1-3 days from a HUMAN sender (questions needing answers, review requests, follow-ups)
- FYI: Informational from a human, no action required (status updates, confirmations, newsletters with relevant content)
- SYSTEM: Automated/system-generated emails (IT notifications, mailbox alerts, batch systems, Microsoft Exchange, calendar auto-responses, leave approval systems, noreply senders, automated reports)
- NOISE: Low value (marketing, mass mailings, spam, promotional)

IMPORTANT: Emails from automated systems, bots, batch processes, IT infrastructure (e.g. "Your mailbox is almost full", "Your worklist contains leave requests", calendar notifications) must be classified as SYSTEM, never as URGENT.

${customRulesText}

For URGENT, ACTION, and custom category emails, provide a brief action_needed description (max 10 words).

Respond with ONLY a JSON array. Each element must have: { "index": <number>, "category": "${allCategories.join("|")}", "action_needed": "<string or empty>" }
No markdown, no explanation, just the JSON array.`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30000);

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        system: systemPrompt,
        messages: [{ role: "user", content: JSON.stringify(emailData) }],
        max_tokens: 4096,
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errText = await response.text().catch(() => "");
      console.error(`${LOG} Anthropic API ${response.status}: ${errText.substring(0, 200)}`);
      return emails.map(e => ({ ...e, category: "FYI", action_needed: "" }));
    }

    const data = await response.json();
    const content = data.content?.[0]?.text || "";

    // Parse JSON from response (handle potential markdown wrapping)
    let jsonStr = content.trim();
    if (jsonStr.startsWith("```")) {
      jsonStr = jsonStr.replace(/^```(?:json)?\s*/, "").replace(/\s*```$/, "");
    }
    const classifications = JSON.parse(jsonStr);

    if (!Array.isArray(classifications)) {
      console.warn(`${LOG} AI classification returned non-array, falling back`);
      return emails.map(e => ({ ...e, category: "FYI", action_needed: "" }));
    }

    // Merge classifications with original emails
    const classMap = new Map();
    for (const c of classifications) {
      if (typeof c.index === "number") {
        classMap.set(c.index, c);
      }
    }

    return emails.map((e, i) => {
      const c = classMap.get(i);
      return {
        ...e,
        category: c?.category || "FYI",
        action_needed: c?.action_needed || "",
      };
    });
  } catch (err) {
    console.error(`${LOG} Email classification error:`, err.message);
    return emails.map(e => ({ ...e, category: "FYI", action_needed: "" }));
  }
}

// ── Outlook Actions ──────────────────────────────────────

/**
 * Apply Outlook actions based on classification.
 * - EMT: flag + set "EMT" category (Executive Management Team)
 * - URGENT: flag + set "Urgent" category
 * - ACTION: set "Action Required" category
 * - FYI: mark as read
 * - SYSTEM: move to "System Emails" folder + mark as read
 * - NOISE: move to "Low Priority" folder + mark as read
 */
async function applyOutlookActions(token, classified, graph) {
  const actions = { flagged: 0, categorized: 0, read: 0, moved: 0, errors: 0 };

  for (const email of classified) {
    try {
      switch (email.category) {
        case "URGENT":
          await graph.flagEmail(token, email.id);
          await graph.setCategories(token, email.id, ["Urgent"]);
          actions.flagged++;
          actions.categorized++;
          break;

        case "ACTION":
          await graph.setCategories(token, email.id, ["Action Required"]);
          actions.categorized++;
          break;

        case "FYI":
          await graph.markAsRead(token, email.id);
          actions.read++;
          break;

        case "SYSTEM":
          await graph.setCategories(token, email.id, ["System"]);
          await graph.moveToFolder(token, email.id, "System Emails");
          await graph.markAsRead(token, email.id);
          actions.categorized++;
          actions.moved++;
          actions.read++;
          break;

        case "NOISE":
          await graph.moveToFolder(token, email.id, "Low Priority");
          await graph.markAsRead(token, email.id);
          actions.moved++;
          actions.read++;
          break;

        default:
          // Custom category (e.g. EMT, NAVAN, VIP) — categorize + move to named folder
          await graph.setCategories(token, email.id, [email.category]);
          await graph.moveToFolder(token, email.id, email.category);
          await graph.markAsRead(token, email.id);
          actions.categorized++;
          actions.moved++;
          actions.read++;
          break;
      }
    } catch (err) {
      actions.errors++;
      console.error(`${LOG} Outlook action error for ${email.id}:`, err.message);
    }
  }

  console.log(`${LOG} Outlook actions: ${actions.flagged} flagged, ${actions.categorized} categorized, ${actions.read} read, ${actions.moved} moved, ${actions.errors} errors`);
  return actions;
}

// ── CRM Enrichment ───────────────────────────────────────

/**
 * Cross-reference email senders with Salesforce contacts.
 * Returns map of fromEmail → { account, deals }
 */
async function enrichWithCRM(userId, classified) {
  const crmContext = {};

  if (!sfAuthModule || !sfApiModule) return crmContext;

  try {
    const sfToken = await sfAuthModule.getValidToken(userId);
    if (!sfToken || !sfToken.token) return crmContext;

    // Collect unique sender emails (only URGENT and ACTION — skip FYI/NOISE)
    const senderEmails = new Set();
    for (const email of classified) {
      if ((email.category === "EMT" || email.category === "URGENT" || email.category === "ACTION") && email.fromEmail) {
        senderEmails.add(email.fromEmail.toLowerCase());
      }
    }

    // Look up each sender in Salesforce
    for (const senderEmail of senderEmails) {
      try {
        const contacts = await sfApiModule.searchContacts(sfToken.token, sfToken.instanceUrl, senderEmail, 1);
        if (contacts && contacts.length > 0) {
          const contact = contacts[0];
          const enrichment = {
            contactName: contact.Name || contact.name,
            account: contact.accountName || contact.Account?.Name || "",
            title: contact.Title || contact.title || "",
          };

          // Fetch account opportunities if we have an accountId
          const accountId = contact.AccountId || contact.accountId;
          if (accountId) {
            try {
              const opps = await sfApiModule.getOpportunities(sfToken.token, sfToken.instanceUrl, accountId, 3);
              if (opps && opps.length > 0) {
                enrichment.deals = opps.map(o => ({
                  name: o.Name || o.name,
                  amount: o.Amount || o.amount || 0,
                  stage: o.StageName || o.stageName || "",
                }));
              }
            } catch (oppErr) {
              // Non-critical — skip deal enrichment
            }
          }

          crmContext[senderEmail.toLowerCase()] = enrichment;
        }
      } catch (contactErr) {
        // Non-critical — skip this sender
      }
    }
  } catch (err) {
    console.error(`${LOG} CRM enrichment error:`, err.message);
  }

  return crmContext;
}

// ── Digest Builder ───────────────────────────────────────

/**
 * Build formatted digest message from classified emails and CRM context.
 */
function buildEmailDigest(classified, crmContext, prefs) {
  const fmtDate = (dateStr) => {
    if (!dateStr) return "";
    try {
      const d = new Date(dateStr);
      const day = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
      return ` (${day}, ${time})`;
    } catch { return ""; }
  };

  const lines = [];
  lines.push("\ud83d\udcec Morning Email Digest");
  lines.push("");

  // Group by category
  const groups = { URGENT: [], ACTION: [], FYI: [], SYSTEM: [], NOISE: [] };
  const customGroups = {}; // dynamic custom categories
  for (const email of classified) {
    if (groups[email.category]) {
      groups[email.category].push(email);
    } else {
      // Custom category
      if (!customGroups[email.category]) customGroups[email.category] = [];
      customGroups[email.category].push(email);
    }
  }

  let counter = 0;

  // Custom categories (EMT, VIP, etc.) — shown first
  for (const [catName, catEmails] of Object.entries(customGroups)) {
    if (catEmails.length > 0) {
      lines.push(`\ud83d\udc51 ${catName} (${catEmails.length})`);
      for (const email of catEmails) {
        counter++;
        const senderCRM = crmContext[email.fromEmail?.toLowerCase()];
        lines.push(`${counter}. ${email.from} \u2014 "${email.subject}"${fmtDate(email.receivedAt)}`);
        if (email.action_needed) {
          lines.push(`   \u2192 ${email.action_needed}`);
        }
        if (senderCRM?.account) {
          const dealInfo = senderCRM.deals?.[0];
          const dealStr = dealInfo ? ` \u2014 ${formatAmount(dealInfo.amount)} deal` : "";
          lines.push(`   \ud83d\udcce ${senderCRM.account}${dealStr}`);
        }
        lines.push("");
      }
    }
  }

  // URGENT
  if (groups.URGENT.length > 0) {
    lines.push(`\ud83d\udd34 URGENT (${groups.URGENT.length})`);
    for (const email of groups.URGENT) {
      counter++;
      const senderCRM = crmContext[email.fromEmail?.toLowerCase()];
      lines.push(`${counter}. ${email.from} \u2014 "${email.subject}"`);
      if (email.action_needed) {
        lines.push(`   \u2192 ${email.action_needed}`);
      }
      if (senderCRM?.account) {
        const dealInfo = senderCRM.deals?.[0];
        const dealStr = dealInfo ? ` \u2014 ${formatAmount(dealInfo.amount)} deal` : "";
        lines.push(`   \ud83d\udcce ${senderCRM.account}${dealStr}`);
      }
      lines.push("");
    }
  }

  // ACTION
  if (groups.ACTION.length > 0) {
    lines.push(`\ud83d\udfe1 ACTION NEEDED (${groups.ACTION.length})`);
    const showMax = 5;
    const shown = groups.ACTION.slice(0, showMax);
    for (const email of shown) {
      counter++;
      const senderCRM = crmContext[email.fromEmail?.toLowerCase()];
      lines.push(`${counter}. ${email.from} \u2014 "${email.subject}"`);
      if (email.action_needed) {
        lines.push(`   \u2192 ${email.action_needed}`);
      }
      if (senderCRM?.account) {
        const dealInfo = senderCRM.deals?.[0];
        const dealStr = dealInfo ? ` \u2014 ${formatAmount(dealInfo.amount)} deal` : "";
        lines.push(`   \ud83d\udcce ${senderCRM.account}${dealStr}`);
      }
    }
    if (groups.ACTION.length > showMax) {
      lines.push(`${counter + 1}-${counter + groups.ACTION.length - showMax}. (${groups.ACTION.length - showMax} more)`);
      counter += groups.ACTION.length - showMax;
    }
    lines.push("");
  }

  // FYI
  if (groups.FYI.length > 0) {
    lines.push(`\ud83d\udccb FYI (${groups.FYI.length})`);
    // Summarize by type rather than listing each
    const meetingConfirms = groups.FYI.filter(e =>
      /confirm|accept|calendar|meeting|rsvp/i.test(e.subject)
    ).length;
    const statusUpdates = groups.FYI.filter(e =>
      /update|status|report|weekly|progress/i.test(e.subject)
    ).length;
    const other = groups.FYI.length - meetingConfirms - statusUpdates;

    if (meetingConfirms > 0) lines.push(`- ${meetingConfirms} meeting confirmation${meetingConfirms > 1 ? "s" : ""}`);
    if (statusUpdates > 0) lines.push(`- ${statusUpdates} status update${statusUpdates > 1 ? "s" : ""}`);
    if (other > 0) lines.push(`- ${other} other informational`);
    lines.push("");
  }

  // SYSTEM
  if (groups.SYSTEM.length > 0) {
    lines.push(`\u2699\ufe0f SYSTEM (${groups.SYSTEM.length} \u2192 moved to System Emails)`);
    for (const email of groups.SYSTEM.slice(0, 3)) {
      lines.push(`- ${email.from} \u2014 "${email.subject}"${fmtDate(email.receivedAt)}`);
    }
    if (groups.SYSTEM.length > 3) lines.push(`- ...and ${groups.SYSTEM.length - 3} more`);
    lines.push("");
  }

  // NOISE
  if (groups.NOISE.length > 0) {
    const hideNoise = prefs?.email_digest?.hide_noise;
    if (hideNoise) {
      lines.push(`\ud83d\uddd1\ufe0f NOISE (${groups.NOISE.length} \u2192 hidden)`);
    } else {
      lines.push(`\ud83d\uddd1\ufe0f NOISE (${groups.NOISE.length} \u2192 moved to Low Priority)`);
    }
    lines.push("");
  }

  // Summary line
  const total = classified.length;
  const urgentCount = groups.URGENT.length;
  const actionCount = groups.ACTION.length;
  const canWait = groups.FYI.length + groups.NOISE.length;
  lines.push(`Total: ${total} unread \u2192 ${urgentCount} urgent, ${actionCount} action, ${canWait} can wait`);

  return lines.join("\n");
}

// ══════════════════════════════════════════════════════════
// FOLLOW-UP TRACKER (R8 proactive)
// ══════════════════════════════════════════════════════════

/**
 * Check sent emails for missing replies.
 * Emails with no reply after 3 days: flag in Outlook + alert user on Rainbow.
 * Limits to top 5 awaiting replies.
 */
async function checkFollowups() {
  if (!redisClient) return;

  const userIds = await redisClient.sMembers(KEYS.users);
  if (!userIds || userIds.length === 0) return;

  for (const userId of userIds) {
    try {
      const prefs = await getUserPrefs(userId);
      if (!prefs.alertsEnabled) continue;

      const tokenData = await m365AuthModule.getValidToken(userId);
      if (!tokenData || !tokenData.token) continue;

      const token = tokenData.token;

      // Fetch sent emails from last 7 days
      const sentEmails = await graphModule.getSentEmails(token, 50, 7);
      if (!sentEmails || sentEmails._error || sentEmails.length === 0) continue;

      const now = Date.now();
      const THREE_DAYS_MS = 3 * 24 * 60 * 60 * 1000;
      const awaitingReply = [];

      for (const sent of sentEmails) {
        // Only check emails older than 3 days
        const sentTime = new Date(sent.sentAt).getTime();
        if (now - sentTime < THREE_DAYS_MS) continue;

        // Check if there's a reply by fetching the conversation thread
        if (!sent.conversationId) continue;

        try {
          const thread = await graphModule.getEmailThread(token, sent.conversationId, 10);
          if (!thread || thread._error) continue;

          // Check if there's a newer message from someone else (not the user)
          const profile = await getCachedUserProfile(userId, token);
          const userEmail = profile?.mail?.toLowerCase() || profile?.userPrincipalName?.toLowerCase() || "";

          const hasReply = thread.some(msg => {
            if (!msg.receivedAt || !sent.sentAt) return false;
            const msgTime = new Date(msg.receivedAt).getTime();
            const sentMsgTime = new Date(sent.sentAt).getTime();
            // Message must be after the sent email and from someone else
            return msgTime > sentMsgTime &&
              msg.fromEmail?.toLowerCase() !== userEmail;
          });

          if (!hasReply) {
            const daysAgo = Math.floor((now - sentTime) / (24 * 60 * 60 * 1000));
            awaitingReply.push({
              id: sent.id,
              subject: sent.subject,
              to: Array.isArray(sent.to) ? sent.to.join(", ") : sent.to,
              sentAt: sent.sentAt,
              daysAgo,
            });
          }
        } catch (threadErr) {
          // Non-critical — skip this email
        }
      }

      if (awaitingReply.length === 0) continue;

      // Sort by oldest first, limit to top 5
      awaitingReply.sort((a, b) => a.daysAgo - b.daysAgo);
      // Actually sort by most overdue first (highest daysAgo)
      awaitingReply.sort((a, b) => b.daysAgo - a.daysAgo);
      const top5 = awaitingReply.slice(0, 5);

      // Flag unreplied emails in Outlook with due date
      for (const item of top5) {
        try {
          const dueDate = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
          await graphModule.flagWithDueDate(token, item.id, dueDate);
        } catch (flagErr) {
          // Non-critical — continue
        }
      }

      // Send alert to user
      const lines = [`\u23f3 Follow-Up Tracker \u2014 ${awaitingReply.length} email${awaitingReply.length > 1 ? "s" : ""} awaiting reply\n`];
      for (let i = 0; i < top5.length; i++) {
        const item = top5[i];
        lines.push(`${i + 1}. To: ${item.to}`);
        lines.push(`   "${item.subject}"`);
        lines.push(`   Sent ${item.daysAgo} day${item.daysAgo > 1 ? "s" : ""} ago \u2014 no reply`);
      }
      if (awaitingReply.length > 5) {
        lines.push(`\n...and ${awaitingReply.length - 5} more. Ask "show follow-ups" for the full list.`);
      }
      lines.push("\n\ud83d\udea9 These emails have been flagged in Outlook with a due date.");

      await sendMessageFn(userId, lines.join("\n"));
      console.log(`${LOG} Follow-up alert sent to ${userId}: ${awaitingReply.length} awaiting reply`);
    } catch (err) {
      console.error(`${LOG} Follow-up tracker error for ${userId}:`, err.message);
    }
  }
}

// User profile cache to avoid repeated API calls within a single followup run
const profileCache = new Map();

async function getCachedUserProfile(userId, token) {
  if (profileCache.has(userId)) return profileCache.get(userId);
  try {
    const profile = await graphModule.getUserProfile(token);
    if (profile && !profile._error) {
      profileCache.set(userId, profile);
      // Clear after 10 minutes
      setTimeout(() => profileCache.delete(userId), 10 * 60 * 1000);
      return profile;
    }
  } catch (err) {
    // Non-critical
  }
  return null;
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
      const parsed = JSON.parse(raw);
      // Deep merge email_digest
      return {
        ...DEFAULT_PREFS,
        ...parsed,
        email_digest: { ...DEFAULT_PREFS.email_digest, ...(parsed.email_digest || {}) },
      };
    }
  } catch (err) {
    console.error(`${LOG} Error reading prefs for ${userId}:`, err.message);
  }

  return { ...DEFAULT_PREFS, email_digest: { ...DEFAULT_PREFS.email_digest } };
}

/**
 * Set user preferences (partial update, merges with existing).
 */
async function setUserPrefs(userId, prefs) {
  if (!redisClient) return false;

  try {
    const existing = await getUserPrefs(userId);
    const merged = { ...existing, ...prefs };

    // Deep merge email_digest if provided
    if (prefs.email_digest) {
      merged.email_digest = { ...existing.email_digest, ...prefs.email_digest };
    }

    // Validate timezone
    if (merged.timezone && !TIMEZONE_OFFSETS[merged.timezone]) {
      console.warn(`${LOG} Unknown timezone ${merged.timezone}, falling back to default`);
      merged.timezone = DEFAULT_PREFS.timezone;
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
 * Enable email digest alerts for a user (opt-in).
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
      if (!prefs.email_digest) prefs.email_digest = { ...DEFAULT_PREFS.email_digest };
      prefs.email_digest.enabled = true;
      await redisClient.set(KEYS.prefs(userId), JSON.stringify(prefs));
    }

    console.log(`${LOG} Email alerts enabled for ${userId}`);
    return true;
  } catch (err) {
    console.error(`${LOG} Error enabling alerts for ${userId}:`, err.message);
    return false;
  }
}

/**
 * Disable email digest alerts for a user (opt-out).
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
      if (prefs.email_digest) prefs.email_digest.enabled = false;
      await redisClient.set(KEYS.prefs(userId), JSON.stringify(prefs));
    }

    console.log(`${LOG} Email alerts disabled for ${userId}`);
    return true;
  } catch (err) {
    console.error(`${LOG} Error disabling alerts for ${userId}:`, err.message);
    return false;
  }
}

// ══════════════════════════════════════════════════════════
// CONFIG FILE
// ══════════════════════════════════════════════════════════

/**
 * Apply alert configuration from an uploaded JSON file.
 * Expected format:
 * {
 *   "timezone": "Europe/Paris",
 *   "email_digest": {
 *     "enabled": true,
 *     "time": "08:00",
 *     "max_emails": 50,
 *     "crm_enrichment": true,
 *     "auto_actions": true,
 *     "hide_noise": false
 *   }
 * }
 */
async function applyConfigFile(userId, jsonContent) {
  try {
    const config = typeof jsonContent === "string" ? JSON.parse(jsonContent) : jsonContent;
    const prefs = await getUserPrefs(userId);

    // Map config file fields to prefs
    if (config.timezone) prefs.timezone = config.timezone;
    if (config.email_digest) prefs.email_digest = { ...prefs.email_digest, ...config.email_digest };

    prefs.alertsEnabled = true;
    await setUserPrefs(userId, prefs);
    await enableAlerts(userId);

    // Build summary of what was configured
    const summary = [];
    if (prefs.email_digest?.enabled) {
      summary.push(`Daily email digest at ${prefs.email_digest.time || "08:00"}`);
      summary.push(`Max emails: ${prefs.email_digest.max_emails || 50}`);
      summary.push(`CRM enrichment: ${prefs.email_digest.crm_enrichment !== false ? "on" : "off"}`);
      summary.push(`Auto Outlook actions: ${prefs.email_digest.auto_actions !== false ? "on" : "off"}`);
      summary.push(`Hide noise: ${prefs.email_digest.hide_noise ? "on" : "off"}`);
    } else {
      summary.push("Daily email digest: disabled");
    }

    console.log(`${LOG} Config file applied for ${userId}`);
    return { success: true, timezone: prefs.timezone, alerts: summary };
  } catch (e) {
    console.error(`${LOG} Config file parse error:`, e.message);
    return { error: `Invalid config file: ${e.message}` };
  }
}

// ══════════════════════════════════════════════════════════
// MANUAL TRIGGER
// ══════════════════════════════════════════════════════════

/**
 * Manually trigger an email digest for a user (bypasses time check and dedup lock).
 * For testing purposes.
 */
async function triggerEmailDigest(userId) {
  if (!redisClient || !m365AuthModule || !graphModule || !sendMessageFn) {
    return { error: "Email scheduler not fully initialized" };
  }

  try {
    const prefs = await getUserPrefs(userId);

    // Get M365 token
    const tokenData = await m365AuthModule.getValidToken(userId);
    if (!tokenData || !tokenData.token) {
      return { error: `No M365 token for ${userId}. User needs to run 'juju connect outlook'.` };
    }

    // Fetch unread emails
    const maxEmails = prefs.email_digest?.max_emails || 50;
    const emails = await graphModule.getUnreadEmails(tokenData.token, maxEmails);
    if (!emails || emails._error) {
      return { error: `Failed to fetch emails: ${JSON.stringify(emails?._error || emails?.status || emails?.message || "unknown")}` };
    }
    if (emails.length === 0) {
      return { success: true, message: "No unread emails", preview: "Inbox is clean!" };
    }

    // Classify
    let classified;
    if (ANTHROPIC_API_KEY) {
      classified = await classifyEmails(emails, userId);
    } else {
      classified = emails.map(e => ({
        ...e,
        category: e.importance === "high" ? "URGENT" : "FYI",
        action_needed: "",
      }));
    }

    // Apply Outlook actions if enabled
    if (prefs.email_digest?.auto_actions !== false) {
      await applyOutlookActions(tokenData.token, classified, graphModule);
    }

    // CRM enrichment if available
    let crmContext = {};
    if (prefs.email_digest?.crm_enrichment !== false && sfAuthModule && sfApiModule) {
      crmContext = await enrichWithCRM(userId, classified);
    }

    // Build and send
    const text = buildEmailDigest(classified, crmContext, prefs);
    await sendMessageFn(userId, text);
    console.log(`${LOG} Manual email digest sent to ${userId}`);
    return { success: true, message: "Email digest sent", preview: text.substring(0, 200) };
  } catch (e) {
    console.error(`${LOG} Manual digest error:`, e.message);
    return { error: e.message };
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
  return (date.getUTCHours() + offset + 24) % 24;
}

function getLocalMinute(date, timezone) {
  // Minutes are the same regardless of integer hour offset
  return date.getUTCMinutes();
}

function formatLocalDate(date, timezone) {
  const offset = getTimezoneOffset(timezone);
  const localDate = new Date(date.getTime() + offset * 3600 * 1000);
  const yyyy = localDate.getUTCFullYear();
  const mm = String(localDate.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(localDate.getUTCDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
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

// ── Stop ──────────────────────────────────────────────────

function stop() {
  if (dailyTimer) {
    clearInterval(dailyTimer);
    dailyTimer = null;
  }
  if (followupTimer) {
    clearInterval(followupTimer);
    followupTimer = null;
  }
  profileCache.clear();
  console.log(`${LOG} Schedulers stopped`);
}

// ── Exports ───────────────────────────────────────────────

/**
 * Retroactively apply a rule: find matching emails and move them to the category folder.
 * Called when a new rule is created to handle existing emails.
 */
async function applyRuleRetroactively(userId, rule) {
  if (!m365AuthModule || !graphModule) return { error: "Email not configured" };

  try {
    const tokenData = await m365AuthModule.getValidToken(userId);
    if (!tokenData || !tokenData.token) return { error: "No email token" };

    // Search for matching emails — search each value separately and filter by match_type
    const allMatching = [];
    for (const value of (rule.match_values || [])) {
      const results = await graphModule.getEmailsFromSender(tokenData.token, value, 50);
      if (results && !results._error) {
        for (const email of results) {
          // Verify the match is actually on the right field
          let isMatch = false;
          const val = value.toLowerCase();
          if (rule.match_type === "sender") {
            isMatch = (email.from || "").toLowerCase().includes(val) ||
                       (email.fromEmail || "").toLowerCase().includes(val);
          } else if (rule.match_type === "subject") {
            isMatch = (email.subject || "").toLowerCase().includes(val);
          } else if (rule.match_type === "domain") {
            isMatch = (email.fromEmail || "").toLowerCase().includes(val);
          }
          if (isMatch && !allMatching.find(e => e.id === email.id)) {
            allMatching.push(email);
          }
        }
      }
    }

    if (allMatching.length === 0) return { moved: 0 };

    let moved = 0;
    for (const email of allMatching) {
      try {
        await graphModule.setCategories(tokenData.token, email.id, [rule.category]);
        await graphModule.moveToFolder(tokenData.token, email.id, rule.category);
        moved++;
      } catch {}
    }

    console.log(`${LOG} Retroactively moved ${moved} emails to ${rule.category} folder for ${userId}`);
    return { moved, total: emails.length };
  } catch (e) {
    console.error(`${LOG} Retroactive rule apply error:`, e.message);
    return { error: e.message };
  }
}

module.exports = {
  init,
  stop,
  getUserPrefs,
  setUserPrefs,
  enableAlerts,
  disableAlerts,
  applyConfigFile,
  triggerEmailDigest,
  // Rules management
  getClassificationRules,
  setClassificationRules,
  addClassificationRule,
  removeClassificationRule,
  applyRuleRetroactively,
  // Exposed for testing
  classifyEmails,
  buildEmailDigest,
  applyOutlookActions,
  checkFollowups,
};
