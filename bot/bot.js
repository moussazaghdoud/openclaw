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

// ── Send message to bubble via REST API ─────────────────

async function sendMessageToBubble(bubble, text) {
  // Method 1: SDK s2s.sendMessageInConversation with conversation dbId
  try {
    let conversation = await sdk.conversations.openConversationForBubble(bubble);
    // Poll for dbId (can take a few seconds in S2S mode)
    for (let i = 0; i < 10 && !conversation?.dbId; i++) {
      await new Promise(r => setTimeout(r, 500));
      conversation = await sdk.conversations.openConversationForBubble(bubble);
    }
    if (conversation?.dbId) {
      if (sdk.s2s && typeof sdk.s2s.sendMessageInConversation === "function") {
        await sdk.s2s.sendMessageInConversation(conversation.dbId, {
          message: { body: text, lang: "en" },
        });
        console.log(`${LOG} Sent to bubble "${bubble.name}" via s2s.sendMessageInConversation dbId=${conversation.dbId}`);
        return true;
      }
      // Fallback: im.sendMessageToConversation
      await sdk.im.sendMessageToConversation(conversation, text);
      console.log(`${LOG} Sent to bubble "${bubble.name}" via im.sendMessageToConversation`);
      return true;
    }
  } catch (err) {
    console.warn(`${LOG} SDK bubble send failed:`, err.message);
  }

  // Method 2: Direct S2S REST API (create conversation + send)
  if (s2sConnectionId && authToken) {
    try {
      const host = rainbowHost || "openrainbow.com";
      // Create S2S conversation for this bubble
      const convUrl = `https://${host}/api/rainbow/ucs/v1.0/connections/${s2sConnectionId}/conversations`;
      const convResp = await fetch(convUrl, {
        method: "POST",
        headers: { "Authorization": `Bearer ${authToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ conversation: { peerId: bubble.id } }),
      });
      const convData = await convResp.json();
      const convId = convData?.data?.id || convData?.id;
      console.log(`${LOG} S2S conversation created: ${convId} (status ${convResp.status})`);

      if (convId) {
        const msgUrl = `https://${host}/api/rainbow/ucs/v1.0/connections/${s2sConnectionId}/conversations/${convId}/messages`;
        const msgResp = await fetch(msgUrl, {
          method: "POST",
          headers: { "Authorization": `Bearer ${authToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ message: { body: text, lang: "en" } }),
        });
        if (msgResp.ok) {
          console.log(`${LOG} Sent to bubble "${bubble.name}" via S2S REST convId=${convId}`);
          return true;
        }
        const msgErr = await msgResp.text();
        console.warn(`${LOG} S2S REST send failed (${msgResp.status}): ${msgErr.substring(0, 300)}`);
      }
    } catch (err) {
      console.warn(`${LOG} S2S REST bubble send error:`, err.message);
    }
  }

  console.error(`${LOG} All bubble send methods failed for "${bubble.name}"`);
  return false;
}

// ── Join all rooms ──────────────────────────────────────

async function joinAllRooms() {
  if (!s2sConnectionId || !authToken) {
    console.warn(`${LOG} joinAllRooms: missing cnxId=${!!s2sConnectionId} token=${!!authToken}`);
    return false;
  }
  const host = rainbowHost || "openrainbow.com";

  // Bulk join all rooms via S2S REST API
  try {
    const resp = await fetch(`https://${host}/api/rainbow/ucs/v1.0/connections/${s2sConnectionId}/rooms/join`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${authToken}`, "Content-Type": "application/json" },
      body: "{}",
    });
    const text = await resp.text();
    console.log(`${LOG} joinAllRooms(${s2sConnectionId}): status=${resp.status} body=${text.substring(0, 200)}`);
    if (resp.ok) {
      console.log(`${LOG} Joined all rooms successfully`);
      return true;
    }
    return false;
  } catch (err) {
    console.warn(`${LOG} joinAllRooms error:`, err.message);
    return false;
  }
}

// ── First-contact tracking ──────────────────────────────

const greeted = new Set();

// ── Bubble caches ───────────────────────────────────────

const bubbleList = new Map();    // bubbleId → bubble
const bubbleByJid = new Map();   // bubbleJid → bubble
const bubbleByMember = new Map(); // memberJid → [bubbles]

// ── Stats ───────────────────────────────────────────────

let stats = { received: 0, replied: 0, errors: 0, startedAt: Date.now() };
const processedMsgIds = new Set();

// ── Create Express app for S2S callbacks ────────────────

const app = express();
app.use(express.json());

// Store last messages for debug
const debugMessages = [];

// Store raw S2S callbacks for debug
const debugCallbacks = [];

// Log ALL incoming requests (before SDK handles them)
app.use((req, res, next) => {
  if (req.method === "POST") {
    const fullUrl = req.originalUrl || req.url || req.path;
    const cb = { path: fullUrl, method: req.method, body: JSON.stringify(req.body || {}).substring(0, 800), time: new Date().toISOString() };
    debugCallbacks.push(cb);
    if (debugCallbacks.length > 20) debugCallbacks.shift();
    console.log(`${LOG} HTTP ${req.method} ${fullUrl} body=${cb.body.substring(0, 500)}`);

    // Log full body for non-receipt/non-presence callbacks (to debug bubble messages)
    if (!fullUrl.includes("/receipt") && !fullUrl.includes("/presence")) {
      console.log(`${LOG} FULL CALLBACK: ${JSON.stringify(req.body || {}).substring(0, 2000)}`);
      interceptedMessages.push({ url: fullUrl, body: req.body, time: new Date().toISOString() });
      if (interceptedMessages.length > 20) interceptedMessages.shift();
    }

    // Extract s2sConnectionId from callback
    if (!s2sConnectionId) {
      // Try body 'id' field
      const bodyId = req.body?.id;
      // Try resource field from presence callbacks
      const resource = req.body?.presence?.resource;
      // Try URL path
      const cnxMatch = fullUrl.match(/\/connections\/([a-f0-9-]+)\//i);

      if (bodyId) {
        s2sConnectionId = bodyId;
        console.log(`${LOG} Got s2sConnectionId from body.id: ${s2sConnectionId}`);
      } else if (resource) {
        s2sConnectionId = resource;
        console.log(`${LOG} Got s2sConnectionId from resource: ${s2sConnectionId}`);
      } else if (cnxMatch) {
        s2sConnectionId = cnxMatch[1];
        console.log(`${LOG} Got s2sConnectionId from URL: ${s2sConnectionId}`);
      }

      if (s2sConnectionId) {
        // Try joining rooms with this ID, then try resource if it fails
        joinAllRooms().then(ok => {
          if (!ok && resource && s2sConnectionId !== resource) {
            console.log(`${LOG} Retrying with resource ID: ${resource}`);
            s2sConnectionId = resource;
            joinAllRooms();
          }
        });
      }
    }
  }
  next();
});

// ── Intercept S2S callbacks for bubble messages the SDK drops ────
const interceptedMessages = [];

// Intercept ALL POST callbacks to find the real S2S connection ID
// and handle bubble messages that the SDK drops
app.post("*", (req, res, next) => {
  const body = req.body || {};

  // Extract connection ID from any callback that has it
  if (body.id && !s2sConnectionId) {
    // The 'id' field in S2S callbacks IS the connection ID
    s2sConnectionId = body.id;
    console.log(`${LOG} Got S2S connection ID from callback: ${s2sConnectionId}`);
    // Join rooms now that we have a valid connection
    joinAllRooms();
  }

  // Handle room messages that the SDK will reject
  // Room messages arrive at /message with a conversation that is type "room"
  if (body.message && body.message.body && body.message.body.trim()) {
    const msg = body.message;
    const convId = msg.conversation_id || body.conversation_id || "";
    const fromUserId = msg.from || body.from || "";
    const content = msg.body || "";

    // Check if this is from someone else (not the bot)
    if (fromUserId && fromUserId !== botUserId) {
      console.log(`${LOG} RAW MESSAGE CALLBACK: from=${fromUserId} conv=${convId} content=${content.substring(0, 80)}`);

      // If the SDK won't handle it (userId mismatch), we process it
      if (body.userId !== botUserId && body.userId !== (sdk?.connectedUser?.id || "___")) {
        console.log(`${LOG} Processing as bubble message (SDK would reject: userId=${body.userId})`);
        processBubbleCallback(body);
        if (!res.headersSent) res.status(200).json({ status: "ok" });
        return; // Don't pass to SDK
      }
    }
  }

  next();
});

// ── Admin dashboard ─────────────────────────────────────

let botPaused = false;

app.get("/", (req, res) => {
  const bubbles = [];
  for (const [id, b] of bubbleList) {
    bubbles.push({ id, name: b.name, jid: b.jid, members: (b.users || []).length });
  }
  const uptime = Math.floor((Date.now() - stats.startedAt) / 1000);
  const uptimeStr = `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${uptime % 60}s`;
  const sdkState = sdk ? (botPaused ? "PAUSED" : "RUNNING") : "NOT STARTED";

  res.send(`<!DOCTYPE html>
<html><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenClaw Bot</title>
<style>
  body { font-family: -apple-system, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; background: #0d1117; color: #c9d1d9; }
  h1 { color: #58a6ff; }
  .status { display: inline-block; padding: 4px 12px; border-radius: 12px; font-weight: bold; }
  .running { background: #238636; color: #fff; }
  .paused { background: #d29922; color: #000; }
  .stopped { background: #da3633; color: #fff; }
  .btn { padding: 10px 24px; border: none; border-radius: 6px; font-size: 16px; cursor: pointer; margin: 5px; }
  .btn-stop { background: #da3633; color: #fff; }
  .btn-start { background: #238636; color: #fff; }
  .btn-restart { background: #1f6feb; color: #fff; }
  .btn:hover { opacity: 0.85; }
  .section { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 16px; margin: 16px 0; }
  .stat { display: inline-block; margin: 0 20px 10px 0; }
  .stat-value { font-size: 24px; font-weight: bold; color: #58a6ff; }
  .stat-label { font-size: 12px; color: #8b949e; }
  table { width: 100%; border-collapse: collapse; }
  td, th { padding: 6px 10px; text-align: left; border-bottom: 1px solid #30363d; font-size: 13px; }
  th { color: #8b949e; }
  .mono { font-family: monospace; font-size: 12px; color: #8b949e; }
</style>
</head><body>
<h1>OpenClaw Bot</h1>
<div class="section">
  <span class="status ${sdkState === "RUNNING" ? "running" : sdkState === "PAUSED" ? "paused" : "stopped"}">${sdkState}</span>
  <span style="margin-left:20px;color:#8b949e">Uptime: ${uptimeStr}</span>
  <div style="margin-top:16px">
    <form method="POST" action="/admin/pause" style="display:inline">
      <button class="btn btn-stop" ${botPaused ? "disabled" : ""}>Pause Bot</button>
    </form>
    <form method="POST" action="/admin/resume" style="display:inline">
      <button class="btn btn-start" ${!botPaused ? "disabled" : ""}>Resume Bot</button>
    </form>
    <form method="POST" action="/admin/restart" style="display:inline">
      <button class="btn btn-restart">Restart SDK</button>
    </form>
  </div>
</div>
<div class="section">
  <div class="stat"><div class="stat-value">${stats.received}</div><div class="stat-label">Received</div></div>
  <div class="stat"><div class="stat-value">${stats.replied}</div><div class="stat-label">Replied</div></div>
  <div class="stat"><div class="stat-value">${stats.errors}</div><div class="stat-label">Errors</div></div>
  <div class="stat"><div class="stat-value">${bubbles.length}</div><div class="stat-label">Bubbles</div></div>
</div>
<div class="section">
  <h3 style="margin-top:0;color:#8b949e">Connection</h3>
  <table>
    <tr><td>S2S Connection</td><td class="mono">${s2sConnectionId || "NOT FOUND"}</td></tr>
    <tr><td>Bot User ID</td><td class="mono">${botUserId || "N/A"}</td></tr>
    <tr><td>Bot JID</td><td class="mono">${sdk?.connectedUser?.jid_im || "N/A"}</td></tr>
  </table>
</div>
${bubbles.length ? `<div class="section">
  <h3 style="margin-top:0;color:#8b949e">Bubbles</h3>
  <table><tr><th>Name</th><th>Members</th><th>ID</th></tr>
  ${bubbles.map(b => `<tr><td>${b.name}</td><td>${b.members}</td><td class="mono">${b.id}</td></tr>`).join("")}
  </table>
</div>` : ""}
<div class="section">
  <h3 style="margin-top:0;color:#8b949e">Recent Messages</h3>
  <table><tr><th>From</th><th>Content</th><th>Type</th></tr>
  ${debugMessages.slice(-5).reverse().map(m => `<tr><td class="mono">${m.fromJid || "?"}</td><td>${m.content || ""}</td><td>${m.isBubble ? "bubble" : "1:1"}</td></tr>`).join("") || "<tr><td colspan=3>No messages yet</td></tr>"}
  </table>
</div>
<div style="margin-top:20px;color:#484f58;font-size:12px">OpenClaw Bot &middot; Refreshed ${new Date().toISOString()}</div>
</body></html>`);
});

// Admin actions
app.post("/admin/pause", (req, res) => {
  botPaused = true;
  console.log(`${LOG} Bot PAUSED via admin dashboard`);
  res.redirect("/");
});

app.post("/admin/resume", (req, res) => {
  botPaused = false;
  console.log(`${LOG} Bot RESUMED via admin dashboard`);
  res.redirect("/");
});

app.post("/admin/restart", async (req, res) => {
  console.log(`${LOG} Bot RESTART requested via admin dashboard`);
  botPaused = false;
  restartCount = 0; // Reset counter so start() works
  res.redirect("/");
  // Start fresh
  try {
    if (sdk) {
      sdk.events.removeAllListeners();
      await sdk.stop().catch(() => {});
      sdk = null;
    }
  } catch {}
  start();
});

// Debug endpoint: show intercepted non-receipt callbacks
app.get("/api/intercepted", (req, res) => {
  res.json(interceptedMessages);
});

// JSON API (for programmatic access)
app.get("/api/status", (req, res) => {
  const bubbles = [];
  for (const [id, b] of bubbleList) {
    bubbles.push({ id, name: b.name, jid: b.jid, members: (b.users || []).length });
  }
  res.json({ status: botPaused ? "paused" : "running", uptime: Math.floor((Date.now() - stats.startedAt) / 1000), stats, s2sConnectionId: s2sConnectionId || null, bubbles, lastMessages: debugMessages.slice(-5) });
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

async function extractSdkInfo() {
  try {
    authToken = sdk._core?._rest?.token
      || sdk._core?._rest?._token
      || sdk._core?.token
      || null;
    rainbowHost = sdk._core?._rest?.host
      || sdk._core?.host
      || "openrainbow.com";

    // Get SDK-managed connection ID (valid for callbacks, not REST API)
    const cnxInfo = sdk._core?._rest?.connectionS2SInfo;
    s2sConnectionId = cnxInfo?.id || cnxInfo?._id || null;

    console.log(`${LOG} S2S info: cnxId=${s2sConnectionId || "NOT FOUND"}, token=${authToken ? "OK" : "NOT FOUND"}, host=${rainbowHost}`);
  } catch (err) {
    console.warn(`${LOG} Could not extract SDK internals:`, err.message);
  }
}

// ── Process bubble message from intercepted S2S callback ─────
async function processBubbleCallback(body) {
  try {
    if (botPaused) return;

    const msg = body.message || {};
    const content = msg.body || msg.content || "";
    if (!content || !content.trim()) return;

    // Extract sender and room info
    const fromJid = msg.fromJid || msg.from || body.fromJid || "";
    const roomJid = msg.toJid || msg.to || body.roomJid || "";
    const msgId = msg.id || msg.messageId || body.id || "";

    console.log(`${LOG} processBubbleCallback: from=${fromJid}, room=${roomJid}, content=${content.substring(0, 80)}`);

    // Skip bot's own messages
    const botJid = sdk?.connectedUser?.jid_im || "";
    if (botJid && fromJid === botJid) return;
    if (fromJid && fromJid.includes(config.login.replace("@", "_"))) return;

    // Deduplicate
    if (msgId && processedMsgIds.has(msgId)) return;
    if (msgId) {
      processedMsgIds.add(msgId);
      if (processedMsgIds.size > 200) {
        const first = processedMsgIds.values().next().value;
        processedMsgIds.delete(first);
      }
    }

    // Check for bot trigger
    const contentLower = content.toLowerCase();
    const botName = (sdk?.connectedUser?.displayName || "").toLowerCase();
    const botFirstName = (sdk?.connectedUser?.firstName || "").toLowerCase();
    const hasBotTrigger = (botName && contentLower.includes(botName))
      || (botFirstName && botFirstName.length > 2 && contentLower.includes(botFirstName))
      || contentLower.includes("@bot")
      || contentLower.includes("@ai")
      || contentLower.startsWith("bot:")
      || contentLower.startsWith("bot :");

    if (!hasBotTrigger) {
      console.log(`${LOG} Bubble message ignored (no bot trigger): ${content.substring(0, 50)}`);
      return;
    }

    stats.received++;
    console.log(`${LOG} [${stats.received}] [BUBBLE-INTERCEPT] Message from ${fromJid}: ${content.substring(0, 80)}`);

    // Find the bubble by room JID
    let bubble = roomJid ? bubbleByJid.get(roomJid) : null;
    if (!bubble) {
      // Try to find by partial match
      for (const [jid, b] of bubbleByJid) {
        if (roomJid && jid.includes(roomJid.split("@")[0])) {
          bubble = b;
          break;
        }
      }
    }

    // Call OpenClaw
    const result = await callOpenClaw(fromJid, content);
    const responseText = result?.content || config.fallbackMsg;

    // Send reply to bubble
    if (bubble) {
      const sent = await sendMessageToBubble(bubble, responseText);
      if (sent) {
        stats.replied++;
        console.log(`${LOG} [${stats.replied}] Replied in bubble "${bubble.name}" via intercept (${responseText.length} chars)`);
      } else {
        stats.errors++;
        console.error(`${LOG} Failed to reply in bubble "${bubble.name}" via intercept`);
      }
    } else if (s2sConnectionId && authToken) {
      // Fallback: send directly via REST using the room JID
      console.warn(`${LOG} Bubble not found for ${roomJid}, trying direct REST send`);
      stats.errors++;
    } else {
      stats.errors++;
      console.error(`${LOG} No bubble found and no S2S connection for reply`);
    }
  } catch (err) {
    stats.errors++;
    console.error(`${LOG} processBubbleCallback error:`, err.message);
  }
}

let restartCount = 0;
const MAX_RESTARTS = 10;
let restartTimer = null;

async function start() {
  // Prevent overlapping restarts
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }

  // Stop previous SDK instance cleanly before creating a new one
  if (sdk) {
    try {
      sdk.events.removeAllListeners();
      await sdk.stop().catch(() => {});
    } catch {}
    sdk = null;
  }

  restartCount++;
  if (restartCount > MAX_RESTARTS) {
    console.error(`${LOG} Too many restart attempts (${MAX_RESTARTS}). Waiting 5 minutes before next try...`);
    restartTimer = setTimeout(() => { restartCount = 0; start(); }, 5 * 60 * 1000);
    return;
  }

  console.log(`${LOG} ================================================`);
  console.log(`${LOG} OpenClaw Rainbow Bot starting (S2S mode) [attempt ${restartCount}]...`);
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
    restartCount = 0; // Reset on successful connection
    console.log(`${LOG} Bot ready -- listening for messages`);
    const user = sdk.connectedUser;
    if (user) {
      botUserId = user.id;
      console.log(`${LOG}   Name  : ${user.displayName || user.loginEmail}`);
      console.log(`${LOG}   ID    : ${user.id}`);
      console.log(`${LOG}   JID   : ${user.jid_im}`);
    }

    // Extract S2S connection ID and auth token
    await extractSdkInfo();

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

    // Cache all bubbles first
    try {
      const bubbles = await sdk.bubbles.getAll();
      console.log(`${LOG} Found ${bubbles?.length || 0} bubbles`);
      for (const bubble of (bubbles || [])) {
        bubbleList.set(bubble.id, bubble);
        if (bubble.jid) bubbleByJid.set(bubble.jid, bubble);
        for (const member of (bubble.users || [])) {
          const jid = member.jid_im || member.jid || "";
          if (jid && jid !== sdk.connectedUser?.jid_im) {
            if (!bubbleByMember.has(jid)) bubbleByMember.set(jid, []);
            bubbleByMember.get(jid).push(bubble);
          }
        }
        try {
          await sdk.bubbles.setBubblePresence(bubble, true);
        } catch {}
      }
      console.log(`${LOG} Cached ${bubbleList.size} bubbles, indexed ${bubbleByMember.size} members`);
    } catch (err) {
      console.warn(`${LOG} Failed to cache bubbles:`, err.message);
    }

    // Join all rooms via REST (AFTER bubbles are cached so individual join works)
    await joinAllRooms();

    // Monkeypatch: intercept S2S callbacks that the SDK rejects (empty userId)
    // The SDK drops bubble message callbacks because userId doesn't match the bot.
    // We wrap the SDK's S2S event handler to catch and process these ourselves.
    try {
      const s2sHandler = sdk._core?._s2s?.s2sEventHandler || sdk.s2s?.s2sEventHandler;
      if (s2sHandler && typeof s2sHandler.handleS2SEvent === "function") {
        const originalHandler = s2sHandler.handleS2SEvent.bind(s2sHandler);
        s2sHandler.handleS2SEvent = function(req, res) {
          const body = req?.body || {};
          const callbackUserId = body.userId || "";
          const myUserId = botUserId || sdk.connectedUser?.id || "";

          // If userId doesn't match bot AND body has a message, process it as bubble message
          if (callbackUserId !== myUserId && body.message && body.message.body) {
            console.log(`${LOG} INTERCEPTED rejected S2S callback: ${JSON.stringify(body).substring(0, 1000)}`);
            processBubbleCallback(body);
            // Still respond 200 to Rainbow so it doesn't retry
            if (res && !res.headersSent) res.status(200).json({ status: "ok" });
            return;
          }

          return originalHandler(req, res);
        };
        console.log(`${LOG} Monkeypatched S2S event handler for bubble message support`);
      } else {
        console.warn(`${LOG} Could not find S2S event handler to monkeypatch`);
      }
    } catch (err) {
      console.warn(`${LOG} Failed to monkeypatch S2S handler:`, err.message);
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
      // Ignore messages when bot is paused
      if (botPaused) return;
      // Ignore own messages — multiple checks for S2S reliability
      if (message.side === "L") return;

      const fromJid = message.fromJid || message.from?.jid_im || "";
      const fromId = message.fromUserId || message.from?.id || "";
      const fromName = message.from?.displayName || message.from?.loginEmail || fromJid;
      const content = message.content || message.data || "";
      const conversationId = message.conversationId || "";

      // Skip bot's own messages (robust: check ID, JID, and login email)
      if (fromId && fromId === botUserId) return;
      const botJid = sdk.connectedUser?.jid_im || "";
      if (botJid && fromJid === botJid) return;
      const botLogin = sdk.connectedUser?.loginEmail || config.login;
      if (botLogin && fromJid.startsWith(botLogin.replace("@", "_").split("/")[0])) return;
      if (fromId && sdk.connectedUser?.id && fromId === sdk.connectedUser.id) return;
      if (!content || !content.trim()) return;

      // Deduplicate: skip if we already processed this message ID recently
      const msgId = message.id || message.messageId || "";
      if (msgId && processedMsgIds.has(msgId)) return;
      if (msgId) {
        processedMsgIds.add(msgId);
        // Keep set bounded
        if (processedMsgIds.size > 200) {
          const first = processedMsgIds.values().next().value;
          processedMsgIds.delete(first);
        }
      }

      // Detect if this is a bubble (group) message
      // S2S mode doesn't populate fromBubbleJid — check conversation object too
      const conv = message.conversation || {};
      let isBubble = !!(message.fromBubbleJid || message.fromBubbleId
        || (conv.type === 1) || (conv.bubble && conv.bubble.id)
        || (conv.id && conv.id.includes("room_")));

      // Check if message contains bot trigger keywords
      const contentLower = content.toLowerCase();
      const botName = (sdk.connectedUser?.displayName || "").toLowerCase();
      const botFirstName = (sdk.connectedUser?.firstName || "").toLowerCase();
      const hasBotTrigger = (botName && contentLower.includes(botName))
        || (botFirstName && botFirstName.length > 2 && contentLower.includes(botFirstName))
        || contentLower.includes("@bot")
        || contentLower.includes("@ai")
        || contentLower.startsWith("bot:")
        || contentLower.startsWith("bot :");

      // S2S workaround: if sender is in a bubble AND message has bot trigger,
      // treat it as a bubble message (SDK doesn't set fromBubbleJid in S2S mode)
      let targetBubble = null;
      if (!isBubble && hasBotTrigger && fromJid && bubbleByMember.has(fromJid)) {
        const memberBubbles = bubbleByMember.get(fromJid);
        if (memberBubbles.length > 0) {
          // Use the most recently active bubble this user is in
          targetBubble = memberBubbles[memberBubbles.length - 1];
          isBubble = true;
          console.log(`${LOG} S2S workaround: treating as bubble message for "${targetBubble.name}"`);
        }
      }

      // In bubbles, only respond when @mentioned
      if (isBubble && !hasBotTrigger) return;

      stats.received++;
      console.log(`${LOG} [${stats.received}] ${isBubble ? "[BUBBLE]" : "[1:1]"} Message from ${fromName}: ${content.substring(0, 80)}${content.length > 80 ? "..." : ""}`);
      // Direct property reads
      let convTypeVal = null, convBubbleVal = null, convDbId = null;
      try { convTypeVal = conv.type; } catch {}
      try { convBubbleVal = conv.bubble; } catch {}
      try { convDbId = conv.dbId; } catch {}

      // Dump ALL non-null string/number values from conversation
      let convDump = {};
      try {
        for (const k of Object.keys(conv)) {
          const v = conv[k];
          if (v !== null && v !== undefined && (typeof v === "string" || typeof v === "number" || typeof v === "boolean")) {
            convDump[k] = v;
          }
        }
      } catch {}

      const msgDebug = {
        fromJid: message.fromJid || null,
        toJid: message.toJid || null,
        fromBubbleJid: message.fromBubbleJid || null,
        isBubble,
        convType: convTypeVal,
        convBubble: convBubbleVal ? { id: convBubbleVal.id, jid: convBubbleVal.jid, name: convBubbleVal.name } : null,
        convDbId: convDbId,
        convDump,
        content: content.substring(0, 50),
      };
      debugMessages.push(msgDebug);
      if (debugMessages.length > 10) debugMessages.shift();
      console.log(`${LOG}   DEBUG: ${JSON.stringify(msgDebug)}`);

      // Get conversation object for reply
      let conversation = null;

      // Try by conversationId first
      if (conversationId) {
        try {
          conversation = sdk.conversations.getConversationById(conversationId);
        } catch {}
      }

      // Fallback depends on message type
      if (!conversation) {
        if (isBubble) {
          // For bubble messages, find the bubble and open its conversation
          const bubble = targetBubble
            || (message.fromBubbleId && await sdk.bubbles.getBubbleById(message.fromBubbleId).catch(() => null))
            || (message.fromBubbleJid && await sdk.bubbles.getBubbleByJid(message.fromBubbleJid).catch(() => null));
          if (bubble) {
            try {
              // Ensure bot is an occupant of the bubble
              try {
                await sdk.bubbles.setBubblePresence(bubble, true);
              } catch {}
              conversation = await sdk.conversations.openConversationForBubble(bubble);
              console.log(`${LOG} Opened bubble conversation: ${bubble.name}, dbId=${conversation?.dbId}`);
            } catch (err) {
              console.warn(`${LOG} Bubble conversation lookup failed:`, err.message);
            }
          }
        } else if (fromJid) {
          // For 1:1 messages, find contact and open conversation
          try {
            const contact = await sdk.contacts.getContactByJid(fromJid);
            if (contact) {
              conversation = await sdk.conversations.openConversationForContact(contact);
            }
          } catch (err) {
            console.warn(`${LOG} Contact conversation lookup failed:`, err.message);
          }
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

      // Resolve the bubble object for bubble messages
      const replyBubble = targetBubble
        || (message.fromBubbleId && bubbleList.get(message.fromBubbleId))
        || null;

      // Send thinking message and typing indicator
      try {
        if (isBubble && replyBubble) {
          await sendMessageToBubble(replyBubble, "Thinking...");
        } else {
          await sdk.im.sendMessageToConversation(conversation, "Thinking...");
        }
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
        if (isBubble && replyBubble) {
          // Reply to bubble via dedicated bubble send method
          const sent = await sendMessageToBubble(replyBubble, responseText);
          if (sent) {
            stats.replied++;
            console.log(`${LOG} [${stats.replied}] Replied in bubble "${replyBubble.name}" (${responseText.length} chars)`);
          } else {
            stats.errors++;
            console.error(`${LOG} All bubble reply methods failed for "${replyBubble.name}"`);
          }
        } else {
          // 1:1 reply via S2S or IM
          if (conversation.dbId && sdk.s2s && typeof sdk.s2s.sendMessageInConversation === "function") {
            await sdk.s2s.sendMessageInConversation(conversation.dbId, {
              message: { body: responseText, lang: "en" },
            });
          } else {
            await sdk.im.sendMessageToConversation(conversation, responseText);
          }
          stats.replied++;
          console.log(`${LOG} [${stats.replied}] Replied to ${fromName} (${responseText.length} chars)`);
        }
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
    restartTimer = setTimeout(() => start(), 30000);
  });

  sdk.events.on("rainbow_onfailed", () => {
    console.error(`${LOG} Login failed -- check credentials. Retrying in 60s`);
    restartTimer = setTimeout(() => start(), 60000);
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
    console.log(`${LOG} Retrying in 60s...`);
    restartTimer = setTimeout(() => start(), 60000);
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
