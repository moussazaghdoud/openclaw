/**
 * Microsoft Graph Email Webhooks — Real-time Email Notifications
 *
 * Subscribes to Graph change notifications for new emails.
 * When a new email arrives, notifies the user on Rainbow immediately.
 *
 * Uses Node 22 built-in crypto and fetch — no extra dependencies.
 */

const crypto = require("crypto");
const LOG = "[EmailWebhook]";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const SUBSCRIPTION_RESOURCE = "me/messages";
const CHANGE_TYPE = "created";
// Graph max for mail resources is 4230 minutes (~2.94 days)
const MAX_EXPIRY_MINUTES = 4230;
// Renew when less than 12 hours remain
const RENEWAL_THRESHOLD_MS = 12 * 60 * 60 * 1000;
// Check for renewals every 30 minutes
const RENEWAL_INTERVAL_MS = 30 * 60 * 1000;

let redisClient = null;
let m365AuthModule = null;
let graphModule = null;
let agentModule = null;
let sendRainbowMessage = null; // function(userId, text) => Promise
let renewalTimer = null;

// ── Init ──────────────────────────────────────────────────

/**
 * Initialize the email webhook module.
 *
 * @param {Express.Application} app - Express app to register routes on
 * @param {Object} deps - Dependencies
 * @param {Object} deps.redis - Redis client
 * @param {Object} deps.m365Auth - M365 auth module (getValidToken, etc.)
 * @param {Object} deps.graph - Microsoft Graph API module (getEmailById)
 * @param {Object} deps.agent - AI agent module (optional, for summaries)
 * @param {Function} deps.sendMessage - function(userId, text) to send Rainbow message
 */
function init(app, deps) {
  redisClient = deps.redis || null;
  m365AuthModule = deps.m365Auth || null;
  graphModule = deps.graph || null;
  agentModule = deps.agent || null;
  sendRainbowMessage = deps.sendMessage || null;

  if (!redisClient) {
    console.warn(`${LOG} Redis not available — subscriptions will not persist`);
  }
  if (!m365AuthModule) {
    console.warn(`${LOG} M365 auth module not available — cannot manage subscriptions`);
  }

  // Register the webhook endpoint
  registerRoutes(app);

  // Start the renewal timer
  startRenewalTimer();

  console.log(`${LOG} Initialized (graph: ${!!graphModule}, agent: ${!!agentModule}, sendMessage: ${!!sendRainbowMessage})`);
}

// ── Express Routes ────────────────────────────────────────

function registerRoutes(app) {
  /**
   * POST /webhooks/email — Microsoft Graph notification endpoint
   *
   * Two modes:
   * 1. Validation: Graph sends ?validationToken= on subscription creation
   *    Must respond with the token as plain text, 200 OK
   * 2. Notification: Graph sends POST body with { value: [...] } change data
   *    Must respond 202 Accepted within 3 seconds
   */
  app.post("/webhooks/email", async (req, res) => {
    // Mode 1: Subscription validation
    const validationToken = req.query.validationToken;
    if (validationToken) {
      console.log(`${LOG} Validation request received — responding with token`);
      res.set("Content-Type", "text/plain");
      return res.status(200).send(validationToken);
    }

    // Mode 2: Change notification — respond immediately, process async
    res.status(202).send();

    const notifications = req.body?.value;
    if (!Array.isArray(notifications) || notifications.length === 0) {
      console.warn(`${LOG} Empty or invalid notification payload`);
      return;
    }

    console.log(`${LOG} Received ${notifications.length} notification(s)`);

    // Process each notification asynchronously
    for (const notification of notifications) {
      processNotification(notification).catch((err) => {
        console.error(`${LOG} Notification processing error:`, err.message);
      });
    }
  });

  console.log(`${LOG} Webhook route registered: POST /webhooks/email`);
}

// ── Notification Processing ───────────────────────────────

async function processNotification(notification) {
  const { subscriptionId, clientState, resource, resourceData, changeType } = notification;

  if (changeType !== "created") {
    console.log(`${LOG} Ignoring changeType: ${changeType}`);
    return;
  }

  // Look up which user owns this subscription
  const subInfo = await getSubscriptionInfo(subscriptionId);
  if (!subInfo) {
    console.warn(`${LOG} Unknown subscription: ${subscriptionId}`);
    return;
  }

  // Verify clientState to prevent spoofed notifications
  if (subInfo.clientState !== clientState) {
    console.warn(`${LOG} Client state mismatch for subscription ${subscriptionId} — ignoring`);
    return;
  }

  const userId = subInfo.userId;
  const emailId = resourceData?.id;
  if (!emailId) {
    console.warn(`${LOG} No email ID in notification for user ${userId}`);
    return;
  }

  console.log(`${LOG} New email for user ${userId}: ${emailId}`);

  // Deduplicate: skip if we already notified about this email (e.g. moved between folders)
  if (redisClient) {
    const dedupeKey = `email_notified:${userId}:${emailId}`;
    const alreadySeen = await redisClient.get(dedupeKey).catch(() => null);
    if (alreadySeen) {
      console.log(`${LOG} Skipping duplicate notification for email ${emailId} (already notified)`);
      return;
    }
    await redisClient.set(dedupeKey, "1", { EX: 86400 }).catch(() => {}); // 24h TTL
  }

  // Fetch the email details via Graph API (retry once after 2s if token not ready)
  let tokenResult = await m365AuthModule.getValidToken(userId);
  if (!tokenResult) {
    await new Promise(r => setTimeout(r, 2000));
    tokenResult = await m365AuthModule.getValidToken(userId);
  }
  if (!tokenResult) {
    console.warn(`${LOG} Cannot get token for user ${userId} — skipping notification`);
    return;
  }

  const email = await graphModule.getEmailById(tokenResult.token, emailId);
  if (!email || email._error) {
    console.warn(`${LOG} Failed to fetch email ${emailId} for user ${userId}`);
    return;
  }

  // Skip old emails being moved between folders (not genuinely new)
  if (email.receivedAt) {
    const emailAge = Date.now() - new Date(email.receivedAt).getTime();
    if (emailAge > 5 * 60 * 1000) { // older than 5 minutes
      console.log(`${LOG} Skipping old email (${Math.round(emailAge / 60000)}min old) — likely a folder move`);
      return;
    }
  }

  // Skip emails sent by the account owner (no need to notify about own emails)
  const ownerEmail = tokenResult.email || "";
  const senderEmail = email.fromEmail || "";
  if (ownerEmail && senderEmail && ownerEmail.toLowerCase() === senderEmail.toLowerCase()) {
    console.log(`${LOG} Skipping own email from ${senderEmail} for user ${userId}`);
    return;
  }

  // Build the notification message
  const sender = email.from || "Unknown";
  const subject = email.subject || "(no subject)";
  let messageText = `New email from ${sender}: ${subject}`;

  // Check notification rules for urgency
  let urgency = "std";
  const rules = await getNotificationRules(userId);
  if (rules.length > 0) {
    const senderLower = (sender + " " + senderEmail).toLowerCase();
    const subjectLower = (subject || "").toLowerCase();
    for (const rule of rules) {
      const keyword = (rule.keyword || "").toLowerCase();
      if (keyword && (senderLower.includes(keyword) || subjectLower.includes(keyword))) {
        urgency = rule.urgency || "high";
        console.log(`${LOG} Rule matched: "${rule.keyword}" → urgency=${urgency}`);
        break;
      }
    }
  }

  // Optionally use the agent to provide a brief summary
  if (agentModule && agentModule.isAvailable() && email.preview) {
    try {
      const summary = await generateBriefSummary(email);
      if (summary) {
        messageText += `\n${summary}`;
      }
    } catch (err) {
      console.warn(`${LOG} Agent summary failed:`, err.message);
    }
  }

  if (urgency === "high") {
    messageText = `🔴 URGENT — ${messageText}`;
  }

  // Send the Rainbow notification with urgency
  if (sendRainbowMessage) {
    try {
      await sendRainbowMessage(userId, messageText, urgency);
      console.log(`${LOG} Notification sent to user ${userId}: "${subject}" (urgency=${urgency})`);
    } catch (err) {
      console.error(`${LOG} Failed to send Rainbow notification to ${userId}:`, err.message);
    }
  } else {
    console.warn(`${LOG} No sendMessage function — cannot notify user ${userId}`);
  }
}

/**
 * Generate a brief summary of an email using the AI agent.
 * Returns a short summary string, or null if unavailable.
 */
async function generateBriefSummary(email) {
  // Use direct Anthropic API (callAIStandalone) — no tools needed, just summarize
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
  if (!ANTHROPIC_API_KEY) return null;

  const preview = (email.preview || email.body || "").substring(0, 500);
  if (!preview.trim()) return null;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    const resp = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-20250514",
        system: "Summarize in one short sentence. No preamble.",
        messages: [{ role: "user", content: `From: ${email.from}\nSubject: ${email.subject}\n\n${preview}` }],
        max_tokens: 100,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return null;
    const data = await resp.json();
    const summary = data.content?.[0]?.text;
    if (summary && summary.length < 200) return `Summary: ${summary.trim()}`;
  } catch {
    // Silently fail — summary is optional
  }
  return null;
}

// ── Subscription Management ───────────────────────────────

/**
 * Create a Graph subscription for new emails.
 * Stores subscription metadata in Redis.
 *
 * @param {string} userId - Rainbow user ID
 * @param {string} [token] - Optional Graph access token (fetched automatically if not provided)
 * @returns {Object|null} Subscription data or null on failure
 */
async function createSubscription(userId, token) {
  if (!m365AuthModule && !token) {
    console.error(`${LOG} Cannot create subscription — no auth module and no token provided`);
    return null;
  }

  // Get token if not provided
  if (!token) {
    const tokenResult = await m365AuthModule.getValidToken(userId);
    if (!tokenResult) {
      console.warn(`${LOG} Cannot get token for user ${userId} — cannot create subscription`);
      return null;
    }
    token = tokenResult.token;
  }

  // Check if subscription already exists
  const existing = await getSubscriptionByUserId(userId);
  if (existing) {
    console.log(`${LOG} Subscription already exists for user ${userId}: ${existing.subscriptionId}`);
    // Renew it instead
    const renewed = await renewSubscription(userId, token, existing.subscriptionId);
    return renewed ? existing : null;
  }

  const notificationUrl = `${process.env.RAINBOW_HOST_CALLBACK || ""}/webhooks/email`;
  const clientState = crypto.randomBytes(32).toString("hex");

  // Expiration: max allowed is ~3 days from now
  const expirationDateTime = new Date(Date.now() + MAX_EXPIRY_MINUTES * 60 * 1000).toISOString();

  const subscriptionPayload = {
    changeType: CHANGE_TYPE,
    notificationUrl,
    resource: SUBSCRIPTION_RESOURCE,
    expirationDateTime,
    clientState,
  };

  console.log(`${LOG} Creating subscription for user ${userId}, notificationUrl: ${notificationUrl}`);

  try {
    const resp = await fetch(`${GRAPH_BASE}/subscriptions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(subscriptionPayload),
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error(`${LOG} Subscription creation failed (${resp.status}): ${errText.substring(0, 300)}`);
      return null;
    }

    const sub = await resp.json();
    console.log(`${LOG} Subscription created: ${sub.id} (expires: ${sub.expirationDateTime})`);

    // Store in Redis
    await storeSubscriptionInfo(userId, {
      subscriptionId: sub.id,
      userId,
      clientState,
      resource: SUBSCRIPTION_RESOURCE,
      expirationDateTime: sub.expirationDateTime,
      createdAt: new Date().toISOString(),
    });

    return sub;
  } catch (err) {
    console.error(`${LOG} Subscription creation error:`, err.message);
    return null;
  }
}

/**
 * Renew a Graph subscription before it expires.
 *
 * @param {string} userId - Rainbow user ID
 * @param {string} [token] - Optional Graph access token
 * @param {string} subscriptionId - Graph subscription ID
 * @returns {boolean} True if renewal succeeded
 */
async function renewSubscription(userId, token, subscriptionId) {
  if (!token) {
    const tokenResult = await m365AuthModule?.getValidToken(userId);
    if (!tokenResult) {
      console.warn(`${LOG} Cannot get token for renewal — user ${userId}`);
      return false;
    }
    token = tokenResult.token;
  }

  const expirationDateTime = new Date(Date.now() + MAX_EXPIRY_MINUTES * 60 * 1000).toISOString();

  try {
    const resp = await fetch(`${GRAPH_BASE}/subscriptions/${subscriptionId}`, {
      method: "PATCH",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ expirationDateTime }),
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error(`${LOG} Subscription renewal failed (${resp.status}): ${errText.substring(0, 300)}`);

      // If subscription not found (404), clean up Redis
      if (resp.status === 404) {
        console.log(`${LOG} Subscription ${subscriptionId} not found — removing from Redis`);
        await removeSubscriptionInfo(userId);
      }
      return false;
    }

    const sub = await resp.json();
    console.log(`${LOG} Subscription renewed: ${subscriptionId} (new expiry: ${sub.expirationDateTime})`);

    // Update expiration in Redis
    const subInfo = await getSubscriptionInfo(subscriptionId);
    if (subInfo) {
      subInfo.expirationDateTime = sub.expirationDateTime;
      await storeSubscriptionInfo(userId, subInfo);
    }

    return true;
  } catch (err) {
    console.error(`${LOG} Subscription renewal error:`, err.message);
    return false;
  }
}

/**
 * Delete a Graph subscription and clean up Redis.
 *
 * @param {string} userId - Rainbow user ID
 * @param {string} [token] - Optional Graph access token
 * @param {string} [subscriptionId] - Graph subscription ID (looked up from Redis if not provided)
 * @returns {boolean} True if deletion succeeded
 */
async function deleteSubscription(userId, token, subscriptionId) {
  // Look up subscription ID if not provided
  if (!subscriptionId) {
    const subInfo = await getSubscriptionByUserId(userId);
    if (!subInfo) {
      console.log(`${LOG} No subscription found for user ${userId} — nothing to delete`);
      return true;
    }
    subscriptionId = subInfo.subscriptionId;
  }

  if (!token) {
    const tokenResult = await m365AuthModule?.getValidToken(userId);
    if (!tokenResult) {
      // Can't reach Graph but still clean up Redis
      console.warn(`${LOG} Cannot get token for deletion — cleaning up Redis only`);
      await removeSubscriptionInfo(userId);
      return true;
    }
    token = tokenResult.token;
  }

  try {
    const resp = await fetch(`${GRAPH_BASE}/subscriptions/${subscriptionId}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${token}`,
      },
      signal: AbortSignal.timeout(30000),
    });

    if (resp.ok || resp.status === 204 || resp.status === 404) {
      console.log(`${LOG} Subscription deleted: ${subscriptionId} (status: ${resp.status})`);
    } else {
      const errText = await resp.text().catch(() => "");
      console.warn(`${LOG} Subscription deletion returned ${resp.status}: ${errText.substring(0, 200)}`);
    }
  } catch (err) {
    console.warn(`${LOG} Subscription deletion error (will clean up Redis):`, err.message);
  }

  // Always clean up Redis
  await removeSubscriptionInfo(userId);
  return true;
}

// ── Redis Storage ─────────────────────────────────────────

/**
 * Store subscription info in Redis.
 * Two keys for bidirectional lookup:
 *   email_webhook:{userId} → subscription data (JSON)
 *   email_webhook_sub:{subscriptionId} → userId
 */
async function storeSubscriptionInfo(userId, subInfo) {
  if (!redisClient) return;
  try {
    const ttl = MAX_EXPIRY_MINUTES * 60 + 3600; // sub lifetime + 1 hour buffer
    await redisClient.set(
      `email_webhook:${userId}`,
      JSON.stringify(subInfo),
      { EX: ttl }
    );
    await redisClient.set(
      `email_webhook_sub:${subInfo.subscriptionId}`,
      userId,
      { EX: ttl }
    );
  } catch (err) {
    console.error(`${LOG} Failed to store subscription info:`, err.message);
  }
}

/**
 * Get subscription info by Graph subscription ID.
 * Returns the full subscription metadata object.
 */
async function getSubscriptionInfo(subscriptionId) {
  if (!redisClient) return null;
  try {
    // Look up userId from subscriptionId
    const userId = await redisClient.get(`email_webhook_sub:${subscriptionId}`);
    if (!userId) return null;
    const raw = await redisClient.get(`email_webhook:${userId}`);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error(`${LOG} Failed to get subscription info:`, err.message);
    return null;
  }
}

/**
 * Get subscription info by Rainbow user ID.
 */
async function getSubscriptionByUserId(userId) {
  if (!redisClient) return null;
  try {
    const raw = await redisClient.get(`email_webhook:${userId}`);
    return raw ? JSON.parse(raw) : null;
  } catch (err) {
    console.error(`${LOG} Failed to get subscription by userId:`, err.message);
    return null;
  }
}

/**
 * Remove subscription info from Redis.
 */
async function removeSubscriptionInfo(userId) {
  if (!redisClient) return;
  try {
    const raw = await redisClient.get(`email_webhook:${userId}`);
    if (raw) {
      const subInfo = JSON.parse(raw);
      if (subInfo.subscriptionId) {
        await redisClient.del(`email_webhook_sub:${subInfo.subscriptionId}`);
      }
    }
    await redisClient.del(`email_webhook:${userId}`);
  } catch (err) {
    console.error(`${LOG} Failed to remove subscription info:`, err.message);
  }
}

/**
 * Get all active subscription user IDs from Redis.
 * Uses SCAN to avoid blocking on large keyspaces.
 */
async function getAllSubscriptionUserIds() {
  if (!redisClient) return [];
  const userIds = [];
  try {
    let cursor = 0;
    do {
      const result = await redisClient.scan(cursor, { MATCH: "email_webhook:*", COUNT: 100 });
      cursor = result.cursor;
      for (const key of result.keys) {
        // Skip the reverse-lookup keys
        if (!key.startsWith("email_webhook_sub:")) {
          const userId = key.replace("email_webhook:", "");
          userIds.push(userId);
        }
      }
    } while (cursor !== 0);
  } catch (err) {
    console.error(`${LOG} Failed to scan subscriptions:`, err.message);
  }
  return userIds;
}

// ── Subscription Renewal Cron ─────────────────────────────

function startRenewalTimer() {
  if (renewalTimer) {
    clearInterval(renewalTimer);
  }

  renewalTimer = setInterval(async () => {
    try {
      await checkAndRenewSubscriptions();
    } catch (err) {
      console.error(`${LOG} Renewal check error:`, err.message);
    }
  }, RENEWAL_INTERVAL_MS);

  // Don't block process exit
  if (renewalTimer.unref) {
    renewalTimer.unref();
  }

  console.log(`${LOG} Renewal timer started (every ${RENEWAL_INTERVAL_MS / 60000} minutes)`);
}

async function checkAndRenewSubscriptions() {
  const userIds = await getAllSubscriptionUserIds();
  if (userIds.length === 0) return;

  console.log(`${LOG} Checking ${userIds.length} subscription(s) for renewal`);
  let renewed = 0;
  let failed = 0;

  for (const userId of userIds) {
    try {
      const subInfo = await getSubscriptionByUserId(userId);
      if (!subInfo) continue;

      const expiresAt = new Date(subInfo.expirationDateTime).getTime();
      const timeRemaining = expiresAt - Date.now();

      if (timeRemaining < RENEWAL_THRESHOLD_MS) {
        console.log(`${LOG} Renewing subscription for ${userId} (expires in ${Math.round(timeRemaining / 60000)} min)`);
        const success = await renewSubscription(userId, null, subInfo.subscriptionId);
        if (success) {
          renewed++;
        } else {
          failed++;
          // If renewal failed, try to re-create
          console.log(`${LOG} Renewal failed, attempting re-creation for ${userId}`);
          await removeSubscriptionInfo(userId);
          const newSub = await createSubscription(userId);
          if (newSub) {
            renewed++;
            failed--;
          }
        }
      }
    } catch (err) {
      console.error(`${LOG} Renewal error for ${userId}:`, err.message);
      failed++;
    }
  }

  if (renewed > 0 || failed > 0) {
    console.log(`${LOG} Renewal check complete: ${renewed} renewed, ${failed} failed`);
  }
}

// ── Auto-subscribe Hook ───────────────────────────────────

/**
 * Called when a user successfully links their M365 account.
 * Automatically creates a Graph subscription for email notifications.
 *
 * @param {string} userId - Rainbow user ID
 * @param {string} token - Valid Graph access token
 */
async function onAccountLinked(userId, token) {
  console.log(`${LOG} M365 account linked for ${userId} — creating email subscription`);
  try {
    const sub = await createSubscription(userId, token);
    if (sub) {
      console.log(`${LOG} Auto-subscribed ${userId} to email notifications`);
      if (sendRainbowMessage) {
        await sendRainbowMessage(userId, "Email notifications enabled. I will notify you when new emails arrive.").catch(() => {});
      }
    } else {
      console.warn(`${LOG} Auto-subscribe failed for ${userId}`);
    }
  } catch (err) {
    console.error(`${LOG} Auto-subscribe error for ${userId}:`, err.message);
  }
}

// ── Cleanup ───────────────────────────────────────────────

function stop() {
  if (renewalTimer) {
    clearInterval(renewalTimer);
    renewalTimer = null;
    console.log(`${LOG} Renewal timer stopped`);
  }
}

// ══════════════════════════════════════════════════════════
// NOTIFICATION RULES — user-defined urgency rules
// ══════════════════════════════════════════════════════════

/**
 * Add a notification rule for a user.
 * Rule: { keyword: "Yann", urgency: "high" }
 * When an email matches the keyword (sender or subject), urgency is set.
 */
async function addNotificationRule(userId, keyword, urgency = "high") {
  if (!redisClient) return false;
  const rules = await getNotificationRules(userId);
  // Avoid duplicates
  if (rules.some(r => r.keyword.toLowerCase() === keyword.toLowerCase())) {
    return false;
  }
  rules.push({ keyword, urgency, createdAt: new Date().toISOString() });
  await redisClient.set(`email_rules:${userId}`, JSON.stringify(rules));
  console.log(`${LOG} Rule added for ${userId}: "${keyword}" → ${urgency}`);
  return true;
}

async function removeNotificationRule(userId, keyword) {
  if (!redisClient) return false;
  const rules = await getNotificationRules(userId);
  const filtered = rules.filter(r => r.keyword.toLowerCase() !== keyword.toLowerCase());
  if (filtered.length === rules.length) return false;
  await redisClient.set(`email_rules:${userId}`, JSON.stringify(filtered));
  console.log(`${LOG} Rule removed for ${userId}: "${keyword}"`);
  return true;
}

async function getNotificationRules(userId) {
  if (!redisClient) return [];
  try {
    const raw = await redisClient.get(`email_rules:${userId}`);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

async function listNotificationRules(userId) {
  return getNotificationRules(userId);
}

module.exports = {
  init,
  createSubscription,
  renewSubscription,
  deleteSubscription,
  onAccountLinked,
  addNotificationRule,
  removeNotificationRule,
  listNotificationRules,
  stop,
};
