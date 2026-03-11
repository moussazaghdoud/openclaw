#!/usr/bin/env node
require("dotenv").config();
/**
 * OpenClaw Rainbow Bot
 *
 * A Rainbow bot that receives instant messages from users and responds
 * using the OpenClaw AI gateway (OpenAI-compatible chat completions API).
 *
 * Based on the Rainbow C# SDK BotBasicMessages pattern:
 *   - Connect to Rainbow as a bot account
 *   - Listen for instant messages (1:1 and bubble/group)
 *   - Forward messages to OpenClaw for AI processing
 *   - Send AI responses back to the Rainbow user
 *   - Auto-accept contact and bubble invitations
 *
 * Configuration via environment variables:
 *   RAINBOW_BOT_LOGIN      - Bot Rainbow account email
 *   RAINBOW_BOT_PASSWORD   - Bot Rainbow account password
 *   RAINBOW_APP_ID         - Rainbow application ID
 *   RAINBOW_APP_SECRET     - Rainbow application secret
 *   RAINBOW_HOST           - "official" or "sandbox" (default: official)
 *   OPENCLAW_ENDPOINT      - OpenClaw gateway URL (e.g. https://openclaw-xxx.up.railway.app)
 *   OPENCLAW_API_KEY       - OpenClaw gateway auth token
 *   OPENCLAW_AGENT_ID      - OpenClaw agent ID (default: main)
 *   OPENCLAW_SYSTEM_PROMPT - System prompt for AI (optional)
 *   OPENCLAW_MAX_TOKENS    - Max response tokens (default: 4096)
 *   OPENCLAW_WELCOME_MSG   - Welcome message for new users (optional)
 *   OPENCLAW_FALLBACK_MSG  - Fallback when OpenClaw is unreachable
 */

const LOG = "[OpenClawBot]";

// ── Configuration ────────────────────────────────────────

const config = {
  // Rainbow
  login: process.env.RAINBOW_BOT_LOGIN || "",
  password: process.env.RAINBOW_BOT_PASSWORD || "",
  appId: process.env.RAINBOW_APP_ID || "",
  appSecret: process.env.RAINBOW_APP_SECRET || "",
  host: process.env.RAINBOW_HOST || "official",

  // OpenClaw
  endpoint: process.env.OPENCLAW_ENDPOINT || "",
  apiKey: process.env.OPENCLAW_API_KEY || "",
  agentId: process.env.OPENCLAW_AGENT_ID || "main",
  systemPrompt: process.env.OPENCLAW_SYSTEM_PROMPT || "",
  maxTokens: parseInt(process.env.OPENCLAW_MAX_TOKENS || "4096", 10),
  timeoutMs: parseInt(process.env.OPENCLAW_TIMEOUT_MS || "30000", 10),
  welcomeMsg: process.env.OPENCLAW_WELCOME_MSG || "",
  fallbackMsg: process.env.OPENCLAW_FALLBACK_MSG || "Sorry, I'm temporarily unavailable. Please try again later.",
};

// ── Validate ─────────────────────────────────────────────

function validateConfig() {
  const missing = [];
  if (!config.login) missing.push("RAINBOW_BOT_LOGIN");
  if (!config.password) missing.push("RAINBOW_BOT_PASSWORD");
  if (!config.appId) missing.push("RAINBOW_APP_ID");
  if (!config.appSecret) missing.push("RAINBOW_APP_SECRET");
  if (!config.endpoint) missing.push("OPENCLAW_ENDPOINT");
  if (!config.apiKey) missing.push("OPENCLAW_API_KEY");

  if (missing.length > 0) {
    console.error(`${LOG} Missing required environment variables:`);
    missing.forEach((v) => console.error(`  - ${v}`));
    process.exit(1);
  }
}

validateConfig();

// ── Conversation History (per user, in-memory) ──────────

const conversations = new Map();
const MAX_HISTORY = 20;

function getHistory(userId) {
  if (!conversations.has(userId)) {
    conversations.set(userId, []);
  }
  return conversations.get(userId);
}

function addMessage(userId, role, content) {
  const history = getHistory(userId);
  history.push({ role, content });
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
}

// ── OpenClaw API ─────────────────────────────────────────

async function callOpenClaw(userId, userMessage) {
  const history = getHistory(userId);

  // Build messages array
  const messages = [];
  if (config.systemPrompt) {
    messages.push({ role: "system", content: config.systemPrompt });
  }
  messages.push(...history);
  messages.push({ role: "user", content: userMessage });

  const body = {
    model: `openclaw:${config.agentId}`,
    messages,
    max_tokens: config.maxTokens,
    stream: false,
    user: userId,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const url = `${config.endpoint}/v1/chat/completions`;
    console.log(`${LOG} → OpenClaw request for ${userId}`);

    const response = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenClaw returned ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const choice = data.choices?.[0];
    const assistantMessage = choice?.message?.content || "";

    // Update conversation history
    addMessage(userId, "user", userMessage);
    addMessage(userId, "assistant", assistantMessage);

    console.log(`${LOG} ← OpenClaw response (${assistantMessage.length} chars, model: ${data.model || "?"})`);

    return {
      content: assistantMessage,
      model: data.model,
      usage: data.usage,
    };
  } catch (err) {
    clearTimeout(timeout);
    console.error(`${LOG} OpenClaw error:`, err.message);
    return null;
  }
}

// ── (NoopExpress removed — using XMPP mode) ────────────

// ── First-contact tracking ──────────────────────────────

const greeted = new Set();

// ── Message stats ───────────────────────────────────────

let stats = { received: 0, replied: 0, errors: 0, startedAt: Date.now() };

// ── Start Bot ───────────────────────────────────────────

async function start() {
  console.log(`${LOG} ═══════════════════════════════════════════`);
  console.log(`${LOG} OpenClaw Rainbow Bot starting...`);
  console.log(`${LOG} Rainbow host : ${config.host}`);
  console.log(`${LOG} Bot account  : ${config.login}`);
  console.log(`${LOG} OpenClaw     : ${config.endpoint}`);
  console.log(`${LOG} Agent        : ${config.agentId}`);
  console.log(`${LOG} ═══════════════════════════════════════════`);

  const RainbowSDK =
    require("rainbow-node-sdk").default || require("rainbow-node-sdk");

  const sdk = new RainbowSDK({
    rainbow: { host: config.host, mode: "xmpp" },
    credentials: { login: config.login, password: config.password },
    application: { appID: config.appId, appSecret: config.appSecret },
    logs: {
      enableConsoleLogs: false,
      enableFileLogs: false,
      color: false,
      level: "warn",
    },
    im: {
      sendReadReceipt: true,
      messageMaxLength: 16384,
      copyMessage: false,
      storeMessages: false,
      autoLoadConversations: true,
      autoLoadContacts: true,
    },
    servicesToStart: {
      telephony: { start_up: false },
      bubbles: { start_up: true },
      channels: { start_up: false },
      admin: { start_up: false },
      fileServer: { start_up: false },
      fileStorage: { start_up: false },
      calllog: { start_up: false },
      favorites: { start_up: false },
      im: { start_up: true },
      contacts: { start_up: true },
      conversations: { start_up: true },
      presence: { start_up: true },
    },
  });

  // ── Bot Ready ──────────────────────────────────────

  sdk.events.on("rainbow_onready", () => {
    console.log(`${LOG} ✓ Bot ready — listening for messages`);
    const user = sdk.connectedUser;
    if (user) {
      console.log(`${LOG}   Name  : ${user.displayName || user.loginEmail}`);
      console.log(`${LOG}   ID    : ${user.id}`);
      console.log(`${LOG}   JID   : ${user.jid_im}`);
    }
  });

  sdk.events.on("rainbow_onconnected", () => {
    console.log(`${LOG} ✓ Connected to Rainbow`);
  });

  sdk.events.on("rainbow_onstarted", () => {
    console.log(`${LOG} ✓ SDK started event fired`);
  });

  // ── Instant Message Received ───────────────────────
  // This is the equivalent of BotBasicMessages.InstantMessageReceivedAsync()

  sdk.events.on("rainbow_onmessagereceived", async (message) => {
    try {
      // Ignore own messages
      if (message.side === "L") return;

      const fromJid = message.fromJid || message.from?.jid_im || "";
      const fromName =
        message.from?.displayName || message.from?.loginEmail || fromJid;
      const content = message.content || message.data || "";
      const conversationId = message.conversationId || "";

      if (!content || !content.trim()) return;

      stats.received++;
      console.log(
        `${LOG} [${stats.received}] Message from ${fromName}: ${content.substring(0, 80)}${content.length > 80 ? "..." : ""}`
      );

      // Get conversation object
      let conversation;
      try {
        conversation = sdk.conversations.getConversationById(conversationId);
      } catch {
        console.error(`${LOG} Cannot find conversation ${conversationId}`);
        return;
      }

      if (!conversation) {
        console.error(`${LOG} No conversation for ${conversationId}`);
        return;
      }

      // Welcome message on first contact
      if (config.welcomeMsg && !greeted.has(fromJid)) {
        greeted.add(fromJid);
        if (!conversations.has(fromJid)) {
          try {
            await sdk.im.sendMessageToConversation(
              conversation,
              config.welcomeMsg
            );
          } catch (err) {
            console.error(`${LOG} Failed to send welcome:`, err.message);
          }
        }
      }

      // Typing indicator ON
      try {
        sdk.im.sendIsTypingStateInConversation(conversation, true);
      } catch {}

      // Call OpenClaw
      const result = await callOpenClaw(fromJid, content);
      const responseText = result?.content || config.fallbackMsg;

      // Typing indicator OFF
      try {
        sdk.im.sendIsTypingStateInConversation(conversation, false);
      } catch {}

      // Send response back to Rainbow user
      try {
        await sdk.im.sendMessageToConversation(conversation, responseText);
        stats.replied++;
        console.log(
          `${LOG} [${stats.replied}] Replied to ${fromName} (${responseText.length} chars)`
        );
      } catch (err) {
        stats.errors++;
        console.error(`${LOG} Failed to send reply:`, err.message);
      }
    } catch (err) {
      stats.errors++;
      console.error(`${LOG} Error handling message:`, err);
    }
  });

  // ── Bubble (group) invitation — auto-accept ────────
  // Equivalent of BotBasicMessages.BubbleInvitationReceivedAsync()

  sdk.events.on("rainbow_onbubbleinvitationreceived", async (bubble) => {
    try {
      console.log(`${LOG} Bubble invitation: ${bubble.name}`);
      await sdk.bubbles.acceptInvitationToJoinBubble(bubble);
      console.log(`${LOG} ✓ Joined bubble: ${bubble.name}`);
    } catch (err) {
      console.error(`${LOG} Failed to join bubble:`, err.message);
    }
  });

  // ── Contact invitation — auto-accept ──────────────

  sdk.events.on("rainbow_oncontactinvitationreceived", async (invitation) => {
    try {
      console.log(`${LOG} Contact invitation from: ${invitation.contactId}`);
      await sdk.contacts.acceptInvitation(invitation);
      console.log(`${LOG} ✓ Contact accepted`);
    } catch (err) {
      console.error(`${LOG} Failed to accept invitation:`, err.message);
    }
  });

  // ── Error handling & reconnection ─────────────────

  sdk.events.on("rainbow_onstopped", () => {
    console.warn(`${LOG} SDK stopped — restarting in 30s`);
    setTimeout(() => start(), 30000);
  });

  sdk.events.on("rainbow_onfailed", () => {
    console.error(`${LOG} Login failed — check credentials. Retrying in 30s`);
    setTimeout(() => start(), 30000);
  });

  sdk.events.on("rainbow_onconnectionerror", (err) => {
    console.error(`${LOG} Connection error:`, JSON.stringify(err?.error || err?.msg || err, null, 2));
  });

  sdk.events.on("rainbow_onreconnecting", () => {
    console.log(`${LOG} Reconnecting...`);
  });

  // ── Start SDK ──────────────────────────────────────

  try {
    await sdk.start();
    console.log(`${LOG} ✓ SDK started`);
  } catch (err) {
    console.error(`${LOG} Failed to start:`, err.message);
    console.log(`${LOG} Retrying in 30s...`);
    setTimeout(() => start(), 30000);
  }
}

// ── Launch ───────────────────────────────────────────────

console.log(`${LOG} Starting in 3s...`);
setTimeout(() => start(), 3000);

// ── Graceful shutdown ────────────────────────────────────

process.on("SIGTERM", () => {
  console.log(`${LOG} Shutting down...`);
  console.log(
    `${LOG} Stats: ${stats.received} received, ${stats.replied} replied, ${stats.errors} errors`
  );
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log(`${LOG} Interrupted`);
  process.exit(0);
});
