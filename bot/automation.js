/**
 * Automation Engine — Unified rule-based automation for Juju bot.
 *
 * Supports:
 *   - meeting_alert:    Alert N minutes before meetings with summary + attendees
 *   - reminder:         One-shot or recurring reminders at a specific date/time
 *   - scheduled_send:   Send a drafted email at a scheduled time
 *
 * Architecture:
 *   - Single polling loop (every 30 seconds)
 *   - Rules stored in Redis per user: automations:{userId}
 *   - Agent tool: manage_automations (create/list/delete/pause/resume)
 *   - Proactive Rainbow messages via sendMessage callback
 */

const LOG = "[Automation]";
const cards = require("./cards");
const POLL_INTERVAL_MS = 30 * 1000; // 30 seconds
const REDIS_KEY_USERS = "automation:users";
const REDIS_KEY_RULES = (userId) => `automation:rules:${userId}`;
const REDIS_KEY_LOCK = (userId, ruleId, dateKey) => `automation:lock:${userId}:${ruleId}:${dateKey}`;

let redis = null;
let sendMessageFn = null;
let sendCardFn = null;
let calendarApi = null;
let calendarAuth = null;
let emailSendFn = null;
let agentModule = null;
let pollTimer = null;

// ── Initialization ──────────────────────────────────────

function init(deps) {
  redis = deps.redis;
  sendMessageFn = deps.sendMessage;
  sendCardFn = deps.sendCard || null;
  calendarApi = deps.calendarApi || null;
  calendarAuth = deps.calendarAuth || null;
  emailSendFn = deps.emailSend || null;
  agentModule = deps.agent || null;

  if (!redis) {
    console.warn(`${LOG} No Redis — automation engine disabled`);
    return;
  }

  // Start polling loop — run first check immediately, then every 30s
  console.log(`${LOG} Automation engine started (polling every ${POLL_INTERVAL_MS / 1000}s), redis connected=${redis !== null}`);

  function safePoll() {
    try {
      console.log(`${LOG} safePoll triggered`);
      checkAllRules().then(() => {
        // silent success
      }).catch(e => {
        console.error(`${LOG} Poll promise rejected:`, e.message, e.stack);
      });
    } catch (e) {
      console.error(`${LOG} Poll sync crash:`, e.message, e.stack);
    }
  }

  setTimeout(safePoll, 5000);
  pollTimer = setInterval(safePoll, POLL_INTERVAL_MS);
}

function stop() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

// ── Rule CRUD ───────────────────────────────────────────

function generateId() {
  return `auto_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

async function getRules(userId) {
  if (!redis) return [];
  try {
    const data = await redis.get(REDIS_KEY_RULES(userId));
    return data ? JSON.parse(data) : [];
  } catch (e) {
    console.warn(`${LOG} getRules error:`, e.message);
    return [];
  }
}

async function saveRules(userId, rules) {
  if (!redis) return;
  try {
    await redis.set(REDIS_KEY_RULES(userId), JSON.stringify(rules));
    // Ensure user is in the automation users set
    if (rules.length > 0) {
      await redis.sAdd(REDIS_KEY_USERS, userId);
    }
  } catch (e) {
    console.warn(`${LOG} saveRules error:`, e.message);
  }
}

async function createRule(userId, rule) {
  const rules = await getRules(userId);
  const newRule = {
    id: generateId(),
    type: rule.type,
    description: rule.description || "",
    active: true,
    created: new Date().toISOString(),
    ...buildRuleConfig(rule),
  };
  rules.push(newRule);
  await saveRules(userId, rules);
  return newRule;
}

async function deleteRule(userId, ruleId) {
  let rules = await getRules(userId);
  const before = rules.length;
  rules = rules.filter(r => r.id !== ruleId);
  if (rules.length === before) return { error: `Rule ${ruleId} not found.` };
  await saveRules(userId, rules);
  if (rules.length === 0) {
    try { await redis.sRem(REDIS_KEY_USERS, userId); } catch {}
  }
  return { success: true, remaining: rules.length };
}

async function toggleRule(userId, ruleId, active) {
  const rules = await getRules(userId);
  const rule = rules.find(r => r.id === ruleId);
  if (!rule) return { error: `Rule ${ruleId} not found.` };
  rule.active = active;
  await saveRules(userId, rules);
  return { success: true, rule };
}

function buildRuleConfig(rule) {
  switch (rule.type) {
    case "meeting_alert":
      return {
        minutes_before: rule.minutes_before || 30,
        include_summary: rule.include_summary !== false,
        include_attendees: rule.include_attendees !== false,
        include_body: rule.include_body !== false,
      };
    case "reminder":
      return {
        message: rule.message || "",
        trigger_at: rule.trigger_at || null,        // ISO datetime for one-shot
        recurring: rule.recurring || null,           // { day: "monday", time: "09:00" } or { interval: "daily", time: "09:00" }
        timezone: rule.timezone || "Europe/Paris",
      };
    case "scheduled_send":
      return {
        send_at: rule.send_at || null,               // ISO datetime
        email_to: rule.email_to || "",
        email_subject: rule.email_subject || "",
        email_body: rule.email_body || "",
        timezone: rule.timezone || "Europe/Paris",
      };
    default:
      return {};
  }
}

// ── Polling Loop ────────────────────────────────────────

let pollCount = 0;
async function checkAllRules() {
  if (!redis) return;
  pollCount++;
  try {
    const users = await redis.sMembers(REDIS_KEY_USERS);
    // Log every 10th poll (~5 min) or first 3 polls for debugging
    if (pollCount <= 3 || pollCount % 10 === 0) {
      console.log(`${LOG} Poll #${pollCount}: ${users.length} user(s) with automations, calendarApi=${!!calendarApi}, calendarAuth=${!!calendarAuth}, sendCard=${!!sendCardFn}`);
    }
    for (const userId of users) {
      try {
        await checkUserRules(userId);
      } catch (e) {
        console.warn(`${LOG} Error checking rules for ${userId}:`, e.message);
      }
    }
  } catch (e) {
    console.warn(`${LOG} Polling error:`, e.message);
  }
}

async function checkUserRules(userId) {
  const rules = await getRules(userId);
  const now = new Date();
  let modified = false;

  for (const rule of rules) {
    if (!rule.active) continue;
    try {
      switch (rule.type) {
        case "meeting_alert":
          await checkMeetingAlert(userId, rule, now);
          break;
        case "reminder":
          const fired = await checkReminder(userId, rule, now);
          if (fired && !rule.recurring) {
            rule.active = false; // One-shot: disable after firing
            modified = true;
          }
          break;
        case "scheduled_send":
          const sent = await checkScheduledSend(userId, rule, now);
          if (sent) {
            rule.active = false; // One-shot: disable after sending
            modified = true;
          }
          break;
      }
    } catch (e) {
      console.warn(`${LOG} Rule ${rule.id} (${rule.type}) error:`, e.message);
    }
  }

  if (modified) {
    await saveRules(userId, rules);
  }
}

// ── Meeting Alerts ──────────────────────────────────────

async function checkMeetingAlert(userId, rule, now) {
  if (!calendarApi || !calendarAuth) {
    console.warn(`${LOG} Meeting alert skip: calendarApi=${!!calendarApi}, calendarAuth=${!!calendarAuth}`);
    return;
  }

  // Get token for this user — m365Auth.getValidToken returns { token, ... }
  let token;
  try {
    // Debug: check what OAuth keys exist for this user
    if (redis) {
      const oauthKey = await redis.get(`oauth:${userId}`);
      console.log(`${LOG} Token lookup: oauth:${userId} exists=${!!oauthKey}`);
      if (!oauthKey) {
        // Try scanning for any oauth key to find the right format
        const keys = await redis.keys("oauth:*").catch(() => []);
        const oauthKeys = keys.filter(k => k.startsWith("oauth:") && !k.includes(":state:") && !k.includes(":linked"));
        console.log(`${LOG} All oauth keys: ${oauthKeys.join(", ") || "none"}`);
      }
    }
    const tokenData = await calendarAuth.getValidToken(userId);
    if (!tokenData || !tokenData.token) {
      console.warn(`${LOG} Meeting alert skip: no valid token for ${userId}`);
      return;
    }
    token = tokenData.token;
  } catch (e) {
    console.warn(`${LOG} Meeting alert token error for ${userId}:`, e.message);
    return;
  }

  // Fetch today's events
  let events;
  try {
    events = await calendarApi.getTodayEvents(token);
    if (!events || events._error) {
      console.warn(`${LOG} Meeting alert: failed to fetch events for ${userId}`);
      return;
    }
  } catch (e) {
    console.warn(`${LOG} Meeting alert fetch error for ${userId}:`, e.message);
    return;
  }

  console.log(`${LOG} Meeting alert check for ${userId}: ${events.length} events today, checking ${rule.minutes_before}min window, server time=${now.toISOString()}`);

  const alertWindowMs = (rule.minutes_before || 30) * 60 * 1000;

  for (const event of events) {
    const startTime = new Date(event.start);
    const diff = startTime.getTime() - now.getTime();
    const diffMin = Math.round(diff / 60000);

    console.log(`${LOG}   Event "${event.subject}" start=${event.start} parsed=${startTime.toISOString()} diff=${diffMin}min inWindow=${diff > 0 && diff <= alertWindowMs}`);

    // Alert window: between 0 and alertWindowMs before the meeting
    // e.g., for 30min alert: fire when meeting is 0-30 min away
    if (diff > 0 && diff <= alertWindowMs) {
      const dateKey = `${event.id}:${startTime.toISOString().split("T")[0]}`;
      const lockKey = REDIS_KEY_LOCK(userId, rule.id, dateKey);

      // Check dedup lock — don't alert twice for same meeting
      try {
        const locked = await redis.get(lockKey);
        if (locked) {
          console.log(`${LOG}   Skipped (already alerted): lockKey=${lockKey}`);
          continue;
        }
        await redis.set(lockKey, "1", { EX: 24 * 3600 }); // 24h TTL
      } catch {}

      // Build alert — fetch body if needed
      const minutesLeft = Math.round(diff / 60000);
      let bodyText = event.body || "";
      if (!bodyText && (rule.include_body || rule.include_summary)) {
        try {
          const fullEvent = await calendarApi.getEventById(token, event.id);
          if (fullEvent && fullEvent.body) bodyText = fullEvent.body;
        } catch {}
      }

      // Build Adaptive Card for meeting alert
      const alertCard = cards.meetingAlert({
        subject: event.subject,
        startTime: formatTime(startTime),
        endTime: formatTime(new Date(event.end)),
        location: event.location,
        organizer: event.organizer,
        attendees: rule.include_attendees ? (event.attendees || []) : [],
        body: bodyText,
        onlineMeetingUrl: event.isOnlineMeeting ? event.onlineMeetingUrl : null,
        minutesLeft,
      });

      // Send as Adaptive Card (with fallback text)
      if (sendCardFn) {
        try {
          await sendCardFn(userId, alertCard.fallback, alertCard.card);
          console.log(`${LOG} Meeting alert card sent to ${userId}: "${event.subject}" in ${minutesLeft}min`);
        } catch (e) {
          console.warn(`${LOG} Card send failed, falling back to text:`, e.message);
          // Fallback to plain text
          if (sendMessageFn) await sendMessageFn(userId, alertCard.fallback).catch(() => {});
        }
      } else if (sendMessageFn) {
        try {
          await sendMessageFn(userId, alertCard.fallback);
          console.log(`${LOG} Meeting alert sent to ${userId}: "${event.subject}" in ${minutesLeft}min`);
        } catch (e) {
          console.warn(`${LOG} Failed to send meeting alert:`, e.message);
        }
      }
    }
  }
}

// ── Reminders ───────────────────────────────────────────

async function checkReminder(userId, rule, now) {
  if (rule.recurring) {
    return await checkRecurringReminder(userId, rule, now);
  }

  // One-shot reminder
  if (!rule.trigger_at) return false;
  const triggerTime = new Date(rule.trigger_at);
  const diff = now.getTime() - triggerTime.getTime();

  // Fire if we're within 0-90 seconds past the trigger time
  if (diff >= 0 && diff < 90000) {
    const lockKey = REDIS_KEY_LOCK(userId, rule.id, triggerTime.toISOString().split("T")[0]);
    try {
      const locked = await redis.get(lockKey);
      if (locked) return false;
      await redis.set(lockKey, "1", { EX: 24 * 3600 });
    } catch {}

    const reminderCard = cards.reminder(rule.message || rule.description, rule.id);
    if (sendCardFn) {
      try {
        await sendCardFn(userId, reminderCard.fallback, reminderCard.card);
        console.log(`${LOG} Reminder card sent to ${userId}: "${rule.message || rule.description}"`);
      } catch (e) {
        if (sendMessageFn) await sendMessageFn(userId, reminderCard.fallback).catch(() => {});
      }
    } else if (sendMessageFn) {
      try {
        await sendMessageFn(userId, reminderCard.fallback);
        console.log(`${LOG} Reminder sent to ${userId}: "${rule.message || rule.description}"`);
      } catch (e) {
        console.warn(`${LOG} Failed to send reminder:`, e.message);
      }
    }
    return true;
  }
  return false;
}

async function checkRecurringReminder(userId, rule, now) {
  const rec = rule.recurring;
  const tz = rule.timezone || "Europe/Paris";
  const localTime = getLocalTime(now, tz);

  // Check if today matches the schedule
  let shouldFire = false;

  if (rec.interval === "daily") {
    shouldFire = true;
  } else if (rec.interval === "weekly" || rec.day) {
    const dayName = localTime.dayName.toLowerCase();
    const targetDay = (rec.day || "monday").toLowerCase();
    shouldFire = dayName === targetDay;
  } else if (rec.interval === "weekdays") {
    const dow = localTime.dayOfWeek;
    shouldFire = dow >= 1 && dow <= 5;
  }

  if (!shouldFire) return false;

  // Check time match (±2 min window)
  const targetTime = rec.time || "09:00";
  const [targetH, targetM] = targetTime.split(":").map(Number);
  const diffMin = Math.abs((localTime.hours * 60 + localTime.minutes) - (targetH * 60 + targetM));
  if (diffMin > 2) return false;

  // Dedup
  const dateKey = now.toISOString().split("T")[0];
  const lockKey = REDIS_KEY_LOCK(userId, rule.id, dateKey);
  try {
    const locked = await redis.get(lockKey);
    if (locked) return false;
    await redis.set(lockKey, "1", { EX: 24 * 3600 });
  } catch {}

  const reminderCard = cards.reminder(`${rule.message || rule.description} (${rec.interval || "weekly"})`, rule.id);
  if (sendCardFn) {
    try {
      await sendCardFn(userId, reminderCard.fallback, reminderCard.card);
      console.log(`${LOG} Recurring reminder card sent to ${userId}: "${rule.message || rule.description}"`);
    } catch (e) {
      if (sendMessageFn) await sendMessageFn(userId, reminderCard.fallback).catch(() => {});
    }
  } else if (sendMessageFn) {
    try {
      await sendMessageFn(userId, reminderCard.fallback);
      console.log(`${LOG} Recurring reminder sent to ${userId}: "${rule.message || rule.description}"`);
    } catch (e) {
      console.warn(`${LOG} Failed to send recurring reminder:`, e.message);
    }
  }
  return true;
}

// ── Scheduled Send ──────────────────────────────────────

async function checkScheduledSend(userId, rule, now) {
  if (!rule.send_at) return false;
  const sendTime = new Date(rule.send_at);
  const diff = now.getTime() - sendTime.getTime();

  // Fire if we're within 0-90 seconds past the scheduled time
  if (diff >= 0 && diff < 90000) {
    const lockKey = REDIS_KEY_LOCK(userId, rule.id, sendTime.toISOString().split("T")[0]);
    try {
      const locked = await redis.get(lockKey);
      if (locked) return false;
      await redis.set(lockKey, "1", { EX: 24 * 3600 });
    } catch {}

    // Try to send the email
    if (emailSendFn) {
      try {
        await emailSendFn(userId, {
          to: rule.email_to,
          subject: rule.email_subject,
          body: rule.email_body,
        });
        const confirm = `✅ **Scheduled email sent**\n\nTo: ${rule.email_to}\nSubject: ${rule.email_subject}`;
        if (sendMessageFn) await sendMessageFn(userId, confirm);
        console.log(`${LOG} Scheduled email sent for ${userId}: "${rule.email_subject}" to ${rule.email_to}`);
        return true;
      } catch (e) {
        const fail = `❌ **Scheduled email failed**\n\nTo: ${rule.email_to}\nSubject: ${rule.email_subject}\nError: ${e.message}`;
        if (sendMessageFn) await sendMessageFn(userId, fail);
        console.warn(`${LOG} Scheduled send failed:`, e.message);
        return true; // Still mark as fired to prevent retry loop
      }
    } else {
      const msg = `⚠️ **Scheduled email could not be sent** — email sending is not configured.\n\nTo: ${rule.email_to}\nSubject: ${rule.email_subject}\nBody: ${rule.email_body}`;
      if (sendMessageFn) await sendMessageFn(userId, msg);
      return true;
    }
  }
  return false;
}

// ── Agent Tool ──────────────────────────────────────────

function getToolDefinition() {
  return {
    name: "manage_automations",
    description: "Create, list, delete, pause, or resume automations. Use when user says 'alert me before meetings', 'remind me', 'schedule sending', 'show my rules', 'remove automation', 'set up a rule', or any request about recurring/scheduled tasks.",
    input_schema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["create", "list", "delete", "pause", "resume"],
          description: "Action to perform",
        },
        rule_id: {
          type: "string",
          description: "Rule ID (for delete/pause/resume)",
        },
        type: {
          type: "string",
          enum: ["meeting_alert", "reminder", "scheduled_send"],
          description: "Automation type (for create)",
        },
        description: {
          type: "string",
          description: "Human-readable description of the automation",
        },
        // meeting_alert params
        minutes_before: {
          type: "number",
          description: "Minutes before meeting to alert (default: 30)",
        },
        include_summary: {
          type: "boolean",
          description: "Include meeting body/agenda in alert (default: true)",
        },
        include_attendees: {
          type: "boolean",
          description: "Include participant list in alert (default: true)",
        },
        // reminder params
        message: {
          type: "string",
          description: "Reminder message text",
        },
        trigger_at: {
          type: "string",
          description: "ISO datetime for one-shot reminder (e.g. '2026-04-14T09:00:00')",
        },
        recurring: {
          type: "object",
          description: "Recurring schedule: { interval: 'daily'|'weekly'|'weekdays', day: 'monday', time: '09:00' }",
          properties: {
            interval: { type: "string", enum: ["daily", "weekly", "weekdays"] },
            day: { type: "string", enum: ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"] },
            time: { type: "string", description: "HH:MM format" },
          },
        },
        timezone: {
          type: "string",
          description: "Timezone (default: Europe/Paris)",
        },
        // scheduled_send params
        send_at: {
          type: "string",
          description: "ISO datetime to send the email",
        },
        email_to: {
          type: "string",
          description: "Recipient email address",
        },
        email_subject: {
          type: "string",
          description: "Email subject",
        },
        email_body: {
          type: "string",
          description: "Email body content",
        },
      },
      required: ["action"],
    },
  };
}

async function executeTool(userId, input) {
  switch (input.action) {
    case "create": {
      if (!input.type) return { error: "Missing 'type'. Must be meeting_alert, reminder, or scheduled_send." };
      const rule = await createRule(userId, input);
      return {
        success: true,
        message: `Automation created: ${rule.description || rule.type}`,
        rule,
      };
    }
    case "list": {
      const rules = await getRules(userId);
      if (rules.length === 0) return { message: "No automations configured.", rules: [] };
      return {
        count: rules.length,
        rules: rules.map(r => ({
          id: r.id,
          type: r.type,
          description: r.description,
          active: r.active,
          created: r.created,
          ...(r.type === "meeting_alert" ? { minutes_before: r.minutes_before } : {}),
          ...(r.type === "reminder" ? { message: r.message, trigger_at: r.trigger_at, recurring: r.recurring } : {}),
          ...(r.type === "scheduled_send" ? { send_at: r.send_at, email_to: r.email_to, email_subject: r.email_subject } : {}),
        })),
      };
    }
    case "delete": {
      if (!input.rule_id) return { error: "Missing 'rule_id'. Use list action to see rule IDs." };
      return await deleteRule(userId, input.rule_id);
    }
    case "pause": {
      if (!input.rule_id) return { error: "Missing 'rule_id'." };
      return await toggleRule(userId, input.rule_id, false);
    }
    case "resume": {
      if (!input.rule_id) return { error: "Missing 'rule_id'." };
      return await toggleRule(userId, input.rule_id, true);
    }
    default:
      return { error: `Unknown action: ${input.action}` };
  }
}

// ── Helpers ─────────────────────────────────────────────

function formatTime(date) {
  return date.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: true });
}

// Timezone offsets (simplified — same approach as email-scheduler.js)
const TZ_OFFSETS = {
  "Europe/Paris": { standard: 1, dst: 2 },
  "Europe/London": { standard: 0, dst: 1 },
  "Europe/Berlin": { standard: 1, dst: 2 },
  "Europe/Rome": { standard: 1, dst: 2 },
  "Europe/Madrid": { standard: 1, dst: 2 },
  "Europe/Amsterdam": { standard: 1, dst: 2 },
  "America/New_York": { standard: -5, dst: -4 },
  "America/Chicago": { standard: -6, dst: -5 },
  "America/Denver": { standard: -7, dst: -6 },
  "America/Los_Angeles": { standard: -8, dst: -7 },
  "Asia/Tokyo": { standard: 9, dst: 9 },
  "Asia/Shanghai": { standard: 8, dst: 8 },
  "Asia/Dubai": { standard: 4, dst: 4 },
  "Asia/Singapore": { standard: 8, dst: 8 },
  "Australia/Sydney": { standard: 11, dst: 10 },
  UTC: { standard: 0, dst: 0 },
};

function isDST(date) {
  const month = date.getUTCMonth(); // 0-11
  if (month > 2 && month < 9) return true; // Apr-Sep
  if (month === 2) {
    const lastSunday = 31 - new Date(date.getUTCFullYear(), 2, 31).getUTCDay();
    return date.getUTCDate() >= lastSunday;
  }
  if (month === 9) {
    const lastSunday = 31 - new Date(date.getUTCFullYear(), 9, 31).getUTCDay();
    return date.getUTCDate() < lastSunday;
  }
  return false;
}

function getLocalTime(date, tz) {
  const offsets = TZ_OFFSETS[tz] || TZ_OFFSETS["Europe/Paris"];
  const offset = isDST(date) ? offsets.dst : offsets.standard;
  const local = new Date(date.getTime() + offset * 3600000);
  const days = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
  return {
    hours: local.getUTCHours(),
    minutes: local.getUTCMinutes(),
    dayOfWeek: local.getUTCDay(),
    dayName: days[local.getUTCDay()],
  };
}

// ── API Status ──────────────────────────────────────────

async function getStatus() {
  if (!redis) return { enabled: false };
  try {
    const users = await redis.sMembers(REDIS_KEY_USERS);
    let totalRules = 0;
    for (const u of users) {
      const rules = await getRules(u);
      totalRules += rules.length;
    }
    return { enabled: true, users: users.length, totalRules };
  } catch {
    return { enabled: true, users: 0, totalRules: 0 };
  }
}

// ── Exports ─────────────────────────────────────────────

module.exports = {
  init,
  stop,
  getRules,
  createRule,
  deleteRule,
  toggleRule,
  getToolDefinition,
  executeTool,
  getStatus,
};
