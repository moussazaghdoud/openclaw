#!/usr/bin/env node
require("dotenv").config();
/**
 * OpenClaw Rainbow Bot — S2S mode with real Express server
 *
 * Rainbow sends webhook callbacks to our Express server.
 * We forward user messages to OpenClaw AI and reply via S2S REST API.
 */

const express = require("express");
const LOG = "[OpenClawBot]";

// ── Configuration ────────────────────────────────────────

const PORT = process.env.PORT || 3000;

const config = {
  // Rainbow
  login: process.env.RAINBOW_BOT_LOGIN || "",
  password: process.env.RAINBOW_BOT_PASSWORD || "",
  appId: process.env.RAINBOW_APP_ID || "",
  appSecret: process.env.RAINBOW_APP_SECRET || "",
  host: process.env.RAINBOW_HOST || "official",
  hostCallback: process.env.RAINBOW_HOST_CALLBACK || "",

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
  if (!config.hostCallback) missing.push("RAINBOW_HOST_CALLBACK");
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

const conversationHistories = new Map();
const MAX_HISTORY = 20;

function getHistory(userId) {
  if (!conversationHistories.has(userId)) {
    conversationHistories.set(userId, []);
  }
  return conversationHistories.get(userId);
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
    console.log(`${LOG} -> OpenClaw request for ${userId}`);

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
    const assistantMessage = data.choices?.[0]?.message?.content || "";

    addMessage(userId, "user", userMessage);
    addMessage(userId, "assistant", assistantMessage);

    console.log(`${LOG} <- OpenClaw response (${assistantMessage.length} chars)`);
    return { content: assistantMessage, model: data.model, usage: data.usage };
  } catch (err) {
    clearTimeout(timeout);
    console.error(`${LOG} OpenClaw error:`, err.message);
    return null;
  }
}

// ── First-contact tracking ──────────────────────────────

const greeted = new Set();

// ── Stats ───────────────────────────────────────────────

let stats = { received: 0, replied: 0, errors: 0, startedAt: Date.now() };

// ── Create Express app for S2S callbacks ────────────────

const app = express();
app.use(express.json());

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", uptime: Math.floor((Date.now() - stats.startedAt) / 1000), stats });
});

// Start Express immediately so Railway sees the port is bound
const server = app.listen(PORT, () => {
  console.log(`${LOG} Express listening on port ${PORT}`);
});

// Wrap app so SDK doesn't call listen() again
const appForSdk = Object.create(app);
appForSdk.listen = (port, cb) => { if (cb) cb(); return server; };

// ── Start Bot ───────────────────────────────────────────

let sdk = null;
let botUserId = null;
let s2sConnectionId = null;
let authToken = null;
let rainbowHost = null;

function extractSdkInfo() {
  try {
    s2sConnectionId = sdk._core?._s2s?._connectionId
      || sdk._core?.s2s?.connectionId
      || sdk.s2s?._connectionId
      || sdk.s2s?.connectionId
      || null;
    authToken = sdk._core?._rest?.token
      || sdk._core?.token
      || null;
    rainbowHost = sdk._core?._rest?.host
      || sdk._core?.host
      || "openrainbow.com";
    console.log(`${LOG} S2S info: cnxId=${s2sConnectionId || "NOT FOUND"}, token=${authToken ? "OK" : "NOT FOUND"}, host=${rainbowHost}`);
  } catch (err) {
    console.warn(`${LOG} Could not extract SDK internals:`, err.message);
  }
}

async function start() {
  console.log(`${LOG} ================================================`);
  console.log(`${LOG} OpenClaw Rainbow Bot starting (S2S mode)...`);
  console.log(`${LOG} Rainbow host    : ${config.host}`);
  console.log(`${LOG} Bot account     : ${config.login}`);
  console.log(`${LOG} Host callback   : ${config.hostCallback}`);
  console.log(`${LOG} Express port    : ${PORT}`);
  console.log(`${LOG} OpenClaw        : ${config.endpoint}`);
  console.log(`${LOG} Agent           : ${config.agentId}`);
  console.log(`${LOG} ================================================`);

  const RainbowSDK =
    require("rainbow-node-sdk").default || require("rainbow-node-sdk");

  sdk = new RainbowSDK({
    rainbow: { host: config.host, mode: "s2s" },
    s2s: {
      hostCallback: config.hostCallback,
      locallistenningport: String(PORT),
      expressEngine: appForSdk,
    },
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
      s2s: { start_up: true },
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

  sdk.events.on("rainbow_onready", async () => {
    console.log(`${LOG} Bot ready -- listening for messages`);
    const user = sdk.connectedUser;
    if (user) {
      botUserId = user.id;
      console.log(`${LOG}   Name  : ${user.displayName || user.loginEmail}`);
      console.log(`${LOG}   ID    : ${user.id}`);
      console.log(`${LOG}   JID   : ${user.jid_im}`);
    }

    // Extract S2S connection ID and auth token
    extractSdkInfo();

    // Set presence to ONLINE via REST API (critical for S2S mode)
    try {
      if (sdk.presence && typeof sdk.presence.setPresenceTo === "function") {
        await sdk.presence.setPresenceTo("online");
        console.log(`${LOG} Presence set to ONLINE via SDK`);
      } else if (s2sConnectionId && authToken) {
        await fetch(`https://${rainbowHost}/api/rainbow/ucs/v1.0/connections/${s2sConnectionId}/presences`, {
          method: "PUT",
          headers: { "Authorization": `Bearer ${authToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ presence: { show: "online", status: "Bot ready" } }),
        });
        console.log(`${LOG} Presence set to ONLINE via REST`);
      }
    } catch (err) {
      console.warn(`${LOG} Failed to set presence:`, err.message);
    }

    // Join all rooms (critical for S2S)
    try {
      if (s2sConnectionId && authToken) {
        await fetch(`https://${rainbowHost}/api/rainbow/ucs/v1.0/connections/${s2sConnectionId}/rooms/join`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${authToken}`, "Content-Type": "application/json" },
          body: "{}",
        });
        console.log(`${LOG} Joined all rooms via REST`);
      }
    } catch (err) {
      console.warn(`${LOG} Failed to join rooms:`, err.message);
    }
  });

  sdk.events.on("rainbow_onconnected", () => {
    console.log(`${LOG} Connected to Rainbow`);
  });

  sdk.events.on("rainbow_onstarted", () => {
    console.log(`${LOG} SDK started event fired`);
  });

  // ── Instant Message Received ───────────────────────

  sdk.events.on("rainbow_onmessagereceived", async (message) => {
    try {
      // Ignore own messages
      if (message.side === "L") return;

      const fromJid = message.fromJid || message.from?.jid_im || "";
      const fromId = message.fromUserId || message.from?.id || "";
      const fromName = message.from?.displayName || message.from?.loginEmail || fromJid;
      const content = message.content || message.data || "";
      const conversationId = message.conversationId || "";

      // Skip bot's own messages
      if (fromId && fromId === botUserId) return;
      if (!content || !content.trim()) return;

      // Detect if this is a bubble (group) message
      const isBubble = !!(message.fromBubbleJid || message.fromBubbleId);

      // In bubbles, only respond when @mentioned by name
      if (isBubble) {
        const botName = (sdk.connectedUser?.displayName || "").toLowerCase();
        const botFirstName = (sdk.connectedUser?.firstName || "").toLowerCase();
        const contentLower = content.toLowerCase();
        const mentioned = (botName && contentLower.includes(botName))
          || (botFirstName && contentLower.includes(botFirstName))
          || contentLower.includes("@bot")
          || contentLower.includes("@ai");
        if (!mentioned) return; // Not addressed to the bot — ignore
      }

      stats.received++;
      console.log(`${LOG} [${stats.received}] ${isBubble ? "[BUBBLE]" : "[1:1]"} Message from ${fromName}: ${content.substring(0, 80)}${content.length > 80 ? "..." : ""}`);

      // Get conversation object for reply
      // In S2S mode, conversationId may be empty — look up by contact
      let conversation = null;

      // Try by conversationId first
      if (conversationId) {
        try {
          conversation = sdk.conversations.getConversationById(conversationId);
        } catch {}
      }

      // Fallback: find or open conversation by contact JID
      if (!conversation && fromJid) {
        try {
          const contact = await sdk.contacts.getContactByJid(fromJid);
          if (contact) {
            conversation = await sdk.conversations.openConversationForContact(contact);
          }
        } catch (err) {
          console.warn(`${LOG} Fallback conversation lookup failed:`, err.message);
        }
      }

      if (!conversation) {
        console.error(`${LOG} No conversation found for ${fromName} (${fromJid})`);
        return;
      }

      // Welcome message on first contact
      if (config.welcomeMsg && !greeted.has(fromJid)) {
        greeted.add(fromJid);
        if (!conversationHistories.has(fromJid)) {
          try {
            await sdk.im.sendMessageToConversation(conversation, config.welcomeMsg);
          } catch (err) {
            console.error(`${LOG} Failed to send welcome:`, err.message);
          }
        }
      }

      // Send thinking message and typing indicator
      try {
        await sdk.im.sendMessageToConversation(conversation, "Thinking...");
        sdk.im.sendIsTypingStateInConversation(conversation, true);
      } catch {}

      // Call OpenClaw
      const result = await callOpenClaw(fromJid, content);
      const responseText = result?.content || config.fallbackMsg;

      // Typing indicator OFF
      try {
        sdk.im.sendIsTypingStateInConversation(conversation, false);
      } catch {}

      // Send response back
      try {
        // Try S2S method first, fallback to im method
        if (conversation.dbId && sdk.s2s && typeof sdk.s2s.sendMessageInConversation === "function") {
          await sdk.s2s.sendMessageInConversation(conversation.dbId, {
            message: { body: responseText, lang: "en" },
          });
        } else {
          await sdk.im.sendMessageToConversation(conversation, responseText);
        }
        stats.replied++;
        console.log(`${LOG} [${stats.replied}] Replied to ${fromName} (${responseText.length} chars)`);
      } catch (err) {
        stats.errors++;
        console.error(`${LOG} Failed to send reply:`, err.message);
      }
    } catch (err) {
      stats.errors++;
      console.error(`${LOG} Error handling message:`, err);
    }
  });

  // ── Bubble invitation — auto-accept ────────────────

  sdk.events.on("rainbow_onbubbleinvitationreceived", async (bubble) => {
    try {
      console.log(`${LOG} Bubble invitation: ${bubble.name}`);
      await sdk.bubbles.acceptInvitationToJoinBubble(bubble);
      console.log(`${LOG} Joined bubble: ${bubble.name}`);
    } catch (err) {
      console.error(`${LOG} Failed to join bubble:`, err.message);
    }
  });

  // ── Contact invitation — auto-accept ──────────────

  sdk.events.on("rainbow_oncontactinvitationreceived", async (invitation) => {
    try {
      console.log(`${LOG} Contact invitation from: ${invitation.contactId}`);
      await sdk.contacts.acceptInvitation(invitation);
      console.log(`${LOG} Contact accepted`);
    } catch (err) {
      console.error(`${LOG} Failed to accept invitation:`, err.message);
    }
  });

  // ── Error handling & reconnection ─────────────────

  sdk.events.on("rainbow_onstopped", () => {
    console.warn(`${LOG} SDK stopped -- restarting in 30s`);
    setTimeout(() => start(), 30000);
  });

  sdk.events.on("rainbow_onfailed", () => {
    console.error(`${LOG} Login failed -- check credentials. Retrying in 30s`);
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
    console.log(`${LOG} SDK started`);
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
  console.log(`${LOG} Stats: ${stats.received} received, ${stats.replied} replied, ${stats.errors} errors`);
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log(`${LOG} Interrupted`);
  process.exit(0);
});
