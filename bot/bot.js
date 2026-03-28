#!/usr/bin/env node
require("dotenv").config();
/**
 * OpenClaw Rainbow Bot — S2S mode with real Express server
 *
 * Rainbow sends webhook callbacks to our Express server.
 * We forward user messages to OpenClaw AI and reply via S2S REST API.
 */

const express = require("express");
const { createClient } = require("redis");
let mammoth;
try { mammoth = require("mammoth"); } catch (_) { mammoth = null; }
let JSZip;
try { JSZip = require("jszip"); } catch (_) { JSZip = null; }
let pdfParse;
try { pdfParse = require("pdf-parse"); } catch (_) { pdfParse = null; }
let pii;
try { pii = require("./pii"); console.log("[OpenClawBot] PII module loaded OK"); } catch (e) { pii = null; console.warn("[OpenClawBot] PII module failed to load:", e.message); }
let m365Auth;
try { m365Auth = require("./auth"); console.log("[OpenClawBot] M365 auth module loaded OK"); } catch (e) { m365Auth = null; console.warn("[OpenClawBot] M365 auth module failed to load:", e.message); }
let m365Graph;
try { m365Graph = require("./graph"); console.log("[OpenClawBot] M365 graph module loaded OK"); } catch (e) { m365Graph = null; console.warn("[OpenClawBot] M365 graph module failed to load:", e.message); }
let gmailAuth;
try { gmailAuth = require("./gmail-auth"); console.log("[OpenClawBot] Gmail auth module loaded OK"); } catch (e) { gmailAuth = null; console.warn("[OpenClawBot] Gmail auth module failed to load:", e.message); }
let gmailApi;
try { gmailApi = require("./gmail-api"); console.log("[OpenClawBot] Gmail API module loaded OK"); } catch (e) { gmailApi = null; console.warn("[OpenClawBot] Gmail API module failed to load:", e.message); }
let emailIntents;
try { emailIntents = require("./email-intents"); console.log("[OpenClawBot] Email intents module loaded OK"); } catch (e) { emailIntents = null; console.warn("[OpenClawBot] Email intents module failed to load:", e.message); }
let calendarGraph;
try { calendarGraph = require("./calendar-graph"); console.log("[OpenClawBot] Calendar Graph module loaded OK"); } catch (e) { calendarGraph = null; console.warn("[OpenClawBot] Calendar Graph module failed to load:", e.message); }
let calendarGoogle;
try { calendarGoogle = require("./calendar-google"); console.log("[OpenClawBot] Calendar Google module loaded OK"); } catch (e) { calendarGoogle = null; console.warn("[OpenClawBot] Calendar Google module failed to load:", e.message); }
let calendarIntents;
try { calendarIntents = require("./calendar-intents"); console.log("[OpenClawBot] Calendar intents module loaded OK"); } catch (e) { calendarIntents = null; console.warn("[OpenClawBot] Calendar intents module failed to load:", e.message); }
let sfAuth;
try { sfAuth = require("./salesforce-auth"); console.log("[OpenClawBot] Salesforce auth module loaded OK"); } catch (e) { sfAuth = null; console.warn("[OpenClawBot] Salesforce auth module failed to load:", e.message); }
let sfApi;
try { sfApi = require("./salesforce-api"); console.log("[OpenClawBot] Salesforce API module loaded OK"); } catch (e) { sfApi = null; console.warn("[OpenClawBot] Salesforce API module failed to load:", e.message); }
let sfIntents;
try { sfIntents = require("./salesforce-intents"); console.log("[OpenClawBot] Salesforce intents module loaded OK"); } catch (e) { sfIntents = null; console.warn("[OpenClawBot] Salesforce intents module failed to load:", e.message); }
let spApi;
try { spApi = require("./sharepoint-api"); console.log("[OpenClawBot] SharePoint API module loaded OK"); } catch (e) { spApi = null; console.warn("[OpenClawBot] SharePoint API module failed to load:", e.message); }
let spIntents;
try { spIntents = require("./sharepoint-intents"); console.log("[OpenClawBot] SharePoint intents module loaded OK"); } catch (e) { spIntents = null; console.warn("[OpenClawBot] SharePoint intents module failed to load:", e.message); }
let briefing;
try { briefing = require("./briefing"); console.log("[OpenClawBot] Briefing module loaded OK"); } catch (e) { briefing = null; console.warn("[OpenClawBot] Briefing module failed to load:", e.message); }
let enterprise;
try { enterprise = require("./enterprise"); console.log("[OpenClawBot] Enterprise module loaded OK"); } catch (e) { enterprise = null; console.warn("[OpenClawBot] Enterprise module failed to load:", e.message); }
let agent;
try { agent = require("./agent"); console.log("[OpenClawBot] Agent module loaded OK"); } catch (e) { agent = null; console.warn("[OpenClawBot] Agent module failed to load:", e.message); }
let salesAgent;
try { salesAgent = require("./sales-agent"); console.log("[OpenClawBot] Sales agent module loaded OK"); } catch (e) { salesAgent = null; console.warn("[OpenClawBot] Sales agent module failed to load:", e.message); }
let salesDashboard;
try { salesDashboard = require("./sales-dashboard"); console.log("[OpenClawBot] Sales dashboard module loaded OK"); } catch (e) { salesDashboard = null; console.warn("[OpenClawBot] Sales dashboard module failed to load:", e.message); }
let salesScheduler;
try { salesScheduler = require("./sales-scheduler"); console.log("[OpenClawBot] Sales scheduler module loaded OK"); } catch (e) { salesScheduler = null; console.warn("[OpenClawBot] Sales scheduler module failed to load:", e.message); }
let emailScheduler;
try { emailScheduler = require("./email-scheduler"); console.log("[OpenClawBot] Email scheduler module loaded OK"); } catch (e) { emailScheduler = null; console.warn("[OpenClawBot] Email scheduler module failed to load:", e.message); }
let emailIntelligence;
try { emailIntelligence = require("./email-intelligence"); console.log("[OpenClawBot] Email intelligence module loaded OK"); } catch (e) { emailIntelligence = null; console.warn("[OpenClawBot] Email intelligence module failed to load:", e.message); }
let userDefaults;
try { userDefaults = require("./user-defaults"); console.log("[OpenClawBot] User defaults module loaded OK"); } catch (e) { userDefaults = null; console.warn("[OpenClawBot] User defaults module failed to load:", e.message); }
let contextManager;
try { contextManager = require("./context-manager"); console.log("[OpenClawBot] Context manager loaded OK"); } catch (e) { contextManager = null; console.warn("[OpenClawBot] Context manager failed to load:", e.message); }
let tenant;
try { tenant = require("./tenant"); console.log("[OpenClawBot] Tenant module loaded OK"); } catch (e) { tenant = null; console.warn("[OpenClawBot] Tenant module failed to load:", e.message); }
let tenantResolver;
try { tenantResolver = require("./tenant-resolver"); console.log("[OpenClawBot] Tenant resolver module loaded OK"); } catch (e) { tenantResolver = null; console.warn("[OpenClawBot] Tenant resolver module failed to load:", e.message); }
let superAdmin;
try { superAdmin = require("./super-admin"); console.log("[OpenClawBot] Super-admin module loaded OK"); } catch (e) { superAdmin = null; console.warn("[OpenClawBot] Super-admin module failed to load:", e.message); }
let emailWebhook;
try { emailWebhook = require("./email-webhook"); console.log("[OpenClawBot] Email webhook module loaded OK"); } catch (e) { emailWebhook = null; console.warn("[OpenClawBot] Email webhook module failed to load:", e.message); }
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
  timeoutMs: parseInt(process.env.OPENCLAW_TIMEOUT_MS || "60000", 10),
  welcomeMsg: process.env.OPENCLAW_WELCOME_MSG || "",
  fallbackMsg: process.env.OPENCLAW_FALLBACK_MSG || "Sorry, I'm temporarily unavailable. Please try again later.",

  // Presidio PII service
  presidioUrl: process.env.PRESIDIO_URL || "",
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

// ── Redis (persistent storage) ───────────────────────────

let redis = null;
const REDIS_URL = process.env.REDIS_URL || "";

async function initRedis() {
  if (!REDIS_URL) {
    console.log(`${LOG} No REDIS_URL — using in-memory storage (data lost on redeploy)`);
    return;
  }
  try {
    redis = createClient({ url: REDIS_URL });
    redis.on("error", (err) => console.warn(`${LOG} Redis error:`, err.message));
    await redis.connect();
    console.log(`${LOG} Connected to Redis — conversation history will persist`);
    // Load greeted set from Redis
    const greetedArr = await redis.sMembers("greeted");
    greetedArr.forEach((jid) => greeted.add(jid));
    console.log(`${LOG} Loaded ${greeted.size} greeted users from Redis`);
    if (pii) pii.init(redis);
    if (m365Auth) m365Auth.init(redis);
    if (gmailAuth) gmailAuth.init(redis);
    if (emailIntents) {
      const hasM365 = !!(m365Auth && m365Graph);
      const hasGmail = !!(gmailAuth && gmailApi);
      if (hasM365 || hasGmail) {
        emailIntents.init({
          m365GraphModule: hasM365 ? m365Graph : null,
          m365AuthModule: hasM365 ? m365Auth : null,
          gmailApiModule: hasGmail ? gmailApi : null,
          gmailAuthModule: hasGmail ? gmailAuth : null,
          callOpenClaw: async (...args) => { const r = await callAIStandalone(...args); return r ? { content: r } : null; }, pii, redis,
        });
        console.log(`${LOG} Email intents initialized (M365: ${hasM365 ? "YES" : "NO"}, Gmail: ${hasGmail ? "YES" : "NO"})`);
      }
    }
    if (calendarIntents) {
      const hasOutlookCal = !!(m365Auth && calendarGraph);
      const hasGoogleCal = !!(gmailAuth && calendarGoogle);
      if (hasOutlookCal || hasGoogleCal) {
        calendarIntents.init({
          m365CalendarMod: hasOutlookCal ? calendarGraph : null,
          m365AuthMod: hasOutlookCal ? m365Auth : null,
          googleCalendarMod: hasGoogleCal ? calendarGoogle : null,
          gmailAuthMod: hasGoogleCal ? gmailAuth : null,
          callOpenClaw: callAIStandalone, redis,
        });
        console.log(`${LOG} Calendar intents initialized (Outlook: ${hasOutlookCal ? "YES" : "NO"}, Google: ${hasGoogleCal ? "YES" : "NO"})`);
      }
    }
    if (sfAuth) sfAuth.init(redis);
    if (sfIntents && sfAuth && sfApi) {
      sfIntents.init({ salesforceApiMod: sfApi, salesforceAuthMod: sfAuth, callOpenClaw: callAIStandalone, redis });
      console.log(`${LOG} Salesforce intents initialized`);
    }
    if (spIntents && spApi && m365Auth) {
      spIntents.init({ sharepointApiMod: spApi, m365AuthMod: m365Auth, callOpenClaw: callAIStandalone, redis, mammoth, JSZip, pdfParse: pdfParse });
      console.log(`${LOG} SharePoint intents initialized`);
    }
    if (briefing) {
      briefing.init({
        emailIntents, calendarIntents, sfIntents, spIntents,
        callOpenClaw: callAIStandalone, redis,
        m365Auth, gmailAuth: gmailAuth, sfAuth,
        m365Graph: m365Graph, gmailApi: gmailApi,
        calendarGraph, calendarGoogle, sfApi, spApi,
      });
      console.log(`${LOG} Briefing module initialized`);
    }
    if (enterprise) {
      enterprise.init(redis, { m365Auth, sfAuth, userDefaults: userDefaults || null });
      console.log(`${LOG} Enterprise module initialized`);
    }
    if (contextManager) {
      contextManager.init(redis);
      console.log(`${LOG} Context manager initialized`);
    }
    if (tenant) {
      tenant.init(redis);
      console.log(`${LOG} Tenant module initialized`);
    }
    if (tenantResolver) {
      tenantResolver.init(redis);
      console.log(`${LOG} Tenant resolver initialized`);
    }
    if (salesAgent && sfAuth && sfApi) {
      salesAgent.init({ sfAuth, sfApi, redis });
      console.log(`${LOG} Sales agent module initialized (available: ${salesAgent.isAvailable()})`);
    }
    if (salesScheduler && sfAuth && sfApi) {
      salesScheduler.init({
        redis,
        sfAuth,
        sfApi,
        analyzer: require("./sales-analyzer"),
        sendMessage: async (userJid, text) => {
          // Reuse the proactive send pattern from email-webhook
          try {
            const contact = await sdk.contacts.getContactByJid(userJid);
            const conv = await sdk.conversations.openConversationForContact(contact);
            await sdk.s2s.sendMessageInConversation(conv.dbId, { message: { body: text, lang: "en" } });
          } catch (e) {
            console.warn(`${LOG} Scheduler proactive send failed:`, e.message);
          }
        },
      });
      console.log(`${LOG} Sales scheduler initialized`);
    }
    if (emailScheduler && m365Auth && m365Graph) {
      emailScheduler.init({
        redis,
        m365Auth,
        graph: m365Graph,
        sfAuth: sfAuth || null,
        sfApi: sfApi || null,
        sendMessage: async (userJid, text) => {
          try {
            const contact = await sdk.contacts.getContactByJid(userJid);
            const conv = await sdk.conversations.openConversationForContact(contact);
            await sdk.s2s.sendMessageInConversation(conv.dbId, { message: { body: text, lang: "en" } });
          } catch (e) {
            console.warn(`${LOG} Email scheduler send failed:`, e.message);
          }
        },
      });
      console.log(`${LOG} Email scheduler initialized`);
    }
    if (emailIntelligence) {
      emailIntelligence.init(redis);
      console.log(`${LOG} Email intelligence initialized`);
    }
    if (userDefaults) {
      userDefaults.init({
        redis,
        emailScheduler: emailScheduler || null,
        salesScheduler: salesScheduler || null,
        emailIntelligence: emailIntelligence || null,
      });
      console.log(`${LOG} User defaults initialized`);
    }
    if (agent) {
      agent.init({
        graph: m365Graph, calendarGraph, m365Auth,
        gmailAuth, gmailApi: gmailApi, calendarGoogle,
        redis,
        salesAgent: salesAgent || null,
        contextManager: contextManager || null,
        emailIntelligence: emailIntelligence || null,
      });
      console.log(`${LOG} Agent module initialized (available: ${agent.isAvailable()})`);
    }
    if (emailWebhook && m365Auth && m365Graph) {
      emailWebhook.init(app, {
        redis,
        m365Auth,
        graph: m365Graph,
        agent: agent || null,
        sendMessage: async (userJid, text, urgency = "std") => {
          console.log(`${LOG} Proactive send to ${userJid} (urgency=${urgency}): ${text.substring(0, 80)}`);
          const isUrgent = urgency && urgency !== "std";

          // For urgent messages, prefer REST with explicit urgency field — SDK may not pass it in S2S mode
          // Try all known urgency formats to maximize compatibility
          const msgPayload = { body: text, lang: "en" };
          // Rainbow S2S rejects unknown urgency values — do NOT set urgency on REST payload
          // Urgency is only supported via SDK sendMessageToConversation parameter

          // SDK path — use s2s.sendMessageInConversation directly with correct urgency
          // Note: sdk.im.sendMessageToConversation has a bug in S2S mode — it sets
          // urgency to the UrgencyType enum object instead of the string value
          try {
            const contact = await sdk.contacts.getContactByJid(userJid);
            if (contact) {
              const conv = await sdk.conversations.openConversationForContact(contact);
              if (conv && conv.dbId) {
                const msg = { message: { body: text, lang: "en" } };
                if (isUrgent) msg.message.urgency = urgency; // string "high"
                await sdk.s2s.sendMessageInConversation(conv.dbId, msg);
                console.log(`${LOG} Proactive send OK via S2S SDK (urgency=${isUrgent ? urgency : "std"})`);
                return;
              }
            }
          } catch (e) { console.warn(`${LOG} SDK proactive send failed:`, e.message); }
          // Fallback: S2S REST — use existing conversation if we have one
          if (s2sConnectionId && authToken) {
            const host = rainbowHost || "openrainbow.com";
            try {
              // Find existing conversation for this JID
              const convId = conversationByJid?.get(userJid);
              if (convId) {
                await fetch(`https://${host}/api/rainbow/ucs/v1.0/connections/${s2sConnectionId}/conversations/${convId}/messages`, {
                  method: "POST",
                  headers: { "Authorization": `Bearer ${authToken}`, "Content-Type": "application/json" },
                  body: JSON.stringify({ message: msgPayload }),
                });
                console.log(`${LOG} Proactive send OK via REST (conv ${convId})`);
                return;
              }
              // No existing conversation — try to create one
              // Need the Rainbow userId, not JID — extract from rawCallbackMap or SDK
              console.warn(`${LOG} No existing conversation for ${userJid} — cannot send proactive message`);
            } catch (e) { console.warn(`${LOG} REST proactive send failed:`, e.message); }
          }
        },
      });
      console.log(`${LOG} Email webhook module initialized`);
    }
  } catch (err) {
    console.warn(`${LOG} Redis connection failed, falling back to in-memory:`, err.message);
    redis = null;
  }
}

// ── Conversation History (Redis-backed with in-memory cache) ──

const conversationHistories = new Map(); // in-memory cache
const MAX_HISTORY = 20;

async function getHistory(userId) {
  if (conversationHistories.has(userId)) {
    return conversationHistories.get(userId);
  }
  // Try loading from Redis
  if (redis) {
    try {
      const data = await redis.get(`history:${userId}`);
      if (data) {
        const history = JSON.parse(data);
        conversationHistories.set(userId, history);
        return history;
      }
    } catch (err) {
      console.warn(`${LOG} Redis getHistory error:`, err.message);
    }
  }
  conversationHistories.set(userId, []);
  return conversationHistories.get(userId);
}

async function addMessage(userId, role, content) {
  const history = await getHistory(userId);
  history.push({ role, content });
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }
  // Persist to Redis
  if (redis) {
    try {
      await redis.set(`history:${userId}`, JSON.stringify(history), { EX: 7 * 24 * 3600 }); // expire after 7 days
    } catch (err) {
      console.warn(`${LOG} Redis addMessage error:`, err.message);
    }
  }
}

async function saveGreeted(jid) {
  greeted.add(jid);
  if (redis) {
    try { await redis.sAdd("greeted", jid); } catch {}
  }
}

// ── OpenClaw API ─────────────────────────────────────────

/**
 * Translate a .docx by replacing paragraph text in the XML while preserving layout/images/styles.
 */
async function executeTranslateDocument(args) {
  const { source_filename, translated_paragraphs } = args;
  if (!JSZip) return JSON.stringify({ error: "jszip not installed" });
  if (!translated_paragraphs || !Array.isArray(translated_paragraphs)) {
    return JSON.stringify({ error: "translated_paragraphs must be an array" });
  }

  // Find stored docx buffer
  const key = source_filename.toLowerCase();
  let docxBuf = storedDocxFiles.get(key)?.buffer;
  if (!docxBuf && redis) {
    try {
      const b64 = await redis.get(`docx:${key}`);
      if (b64) docxBuf = Buffer.from(b64, "base64");
    } catch {}
  }
  if (!docxBuf) {
    return JSON.stringify({ error: `Original document '${source_filename}' not found. The user must share the file first.` });
  }

  try {
    const zip = await JSZip.loadAsync(docxBuf);
    const docXmlFile = zip.file("word/document.xml");
    if (!docXmlFile) return JSON.stringify({ error: "Invalid docx: no word/document.xml" });

    let docXml = await docXmlFile.async("string");

    // Single-pass: replace text in paragraphs while preserving images/drawings
    let textParaIndex = 0;
    let totalTextParas = 0;
    const newDocXml = docXml.replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paraXml) => {
      // Skip paragraphs that contain images/drawings — leave them untouched
      if (/<w:drawing\b|<w:pict\b|<mc:AlternateContent\b/.test(paraXml)) {
        return paraXml;
      }
      // Skip paragraphs with no text content
      const textContent = paraXml.replace(/<[^>]+>/g, "").trim();
      if (textContent.length === 0) return paraXml;

      totalTextParas++;
      // If we have a translation for this paragraph, replace the text
      if (textParaIndex < translated_paragraphs.length) {
        const newText = translated_paragraphs[textParaIndex++];
        let first = true;
        return paraXml.replace(/<w:t([^>]*)>[^<]*<\/w:t>/g, (match, attrs) => {
          if (first) {
            first = false;
            const escaped = newText.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
            return `<w:t${attrs}>${escaped}</w:t>`;
          }
          return `<w:t${attrs}></w:t>`;
        });
      }
      return paraXml;
    });

    console.log(`${LOG} translate_document: ${totalTextParas} text paragraphs found, ${textParaIndex} translated`);

    zip.file("word/document.xml", newDocXml);
    const newDocxBuf = await zip.generateAsync({ type: "nodebuffer" });

    // Host the translated docx
    const outName = source_filename.replace(/\.docx?$/i, "_translated.docx");
    const url = hostFile(outName, newDocxBuf, true);
    console.log(`${LOG} translate_document: created ${outName} (${newDocxBuf.length} bytes) -> ${url}`);
    return JSON.stringify({ success: true, filename: outName, download_url: url });
  } catch (err) {
    console.error(`${LOG} translate_document error:`, err);
    return JSON.stringify({ error: err.message });
  }
}

// ── Intent Detection ─────────────────────────────────────
// The bot decides what to do — the AI is just a content engine.
// Returns: { type: "chat" | "translate_docx" | "create_file", ...metadata }

/**
 * Convert markdown text to styled HTML for Rainbow rich messages.
 * Returns { body: plainText, content: htmlText } for S2S message payload.
 */
function formatForRainbow(text) {
  if (!text) return { body: "", content: "" };

  let html = text
    // Escape HTML entities first
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    // Headers: ### text → h3, ## text → h2, # text → h1
    .replace(/^###\s+(.+)$/gm, '<div style="font-size:14px;font-weight:bold;color:#1a73e8;margin:8px 0 4px">$1</div>')
    .replace(/^##\s+(.+)$/gm, '<div style="font-size:15px;font-weight:bold;color:#1a73e8;margin:10px 0 4px">$1</div>')
    .replace(/^#\s+(.+)$/gm, '<div style="font-size:16px;font-weight:bold;color:#1a73e8;margin:12px 0 4px">$1</div>')
    // Horizontal rule: --- or *** or ___
    .replace(/^[-*_]{3,}$/gm, '<hr style="border:none;border-top:1px solid #dadce0;margin:8px 0">')
    // Bold: **text** → <b style="color:#1a73e8">text</b> (blue for emphasis)
    .replace(/\*\*([^*]+)\*\*/g, '<b style="color:#1a73e8">$1</b>')
    // Italic: *text* → <i>text</i>
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "<i>$1</i>")
    // Inline code: `text` → styled span
    .replace(/`([^`]+)`/g, '<span style="background:#f1f3f4;padding:1px 4px;border-radius:3px;font-family:monospace;font-size:12px">$1</span>')
    // Numbered lists: 1. text → styled line
    .replace(/^(\d+)\.\s+(.+)$/gm, '<div style="margin:2px 0;padding-left:8px"><b style="color:#e8710a">$1.</b> $2</div>')
    // Bullet lists: - text or * text → styled line
    .replace(/^[-•*]\s+(.+)$/gm, '<div style="margin:2px 0;padding-left:8px">• $1</div>')
    // Indented bullets:   - text → nested
    .replace(/^  [-•*]\s+(.+)$/gm, '<div style="margin:2px 0;padding-left:20px">◦ $1</div>')
    // Headers-like lines (lines ending with :) → bold colored
    .replace(/^([A-Z][^:\n]{3,50}):$/gm, '<div style="color:#5f6368;font-weight:bold;margin-top:6px">$1:</div>')
    // Line breaks
    .replace(/\n/g, "<br>");

  // Wrap in a styled container
  html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:13px;line-height:1.5">${html}</div>`;

  return { body: text, content: html };
}

/**
 * Build Rainbow S2S message payload with both plain text and HTML.
 */
function stripMarkdown(text) {
  if (!text) return "";
  return text
    // Headers: ## text → text (keep the text, remove #)
    .replace(/^#{1,3}\s+/gm, "")
    // Bold: **text** → text
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    // Italic: *text* → text
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1")
    // Inline code: `text` → text
    .replace(/`([^`]+)`/g, "$1")
    // Horizontal rules: --- → ────
    .replace(/^[-*_]{3,}$/gm, "────────────────────────")
    // Keep bullets and numbered lists as-is (they look fine in plain text)
    .trim();
}

function buildMessage(text) {
  const cleanBody = stripMarkdown(text);
  return { message: { body: cleanBody, lang: "en" } };
}

/**
 * Generate a short reformulation of the user's intent for immediate feedback.
 */
function describeIntent(intent) {
  switch (intent.type) {
    case "translate_docx":
      return `Translating Word document to ${intent.language}...`;
    case "translate_pdf":
      return `Translating PDF to ${intent.language}...`;
    case "translate_pptx":
      return `Translating PowerPoint to ${intent.language}...`;
    case "translate_any":
      return `Translating document to ${intent.language}...`;
    case "anonymize_pptx":
    case "anonymize_pdf":
    case "anonymize_docx":
    case "anonymize_any":
      return `Anonymizing document...`;
    case "create_file":
      return `Creating ${intent.format.toUpperCase()} file...`;
    case "email_summarize_unread":
      return `Checking your unread emails...`;
    case "email_list_recent":
      return `Fetching recent emails...`;
    case "email_from_sender":
      return `Searching emails from ${intent.sender}...`;
    case "email_search":
      return `Searching emails for "${intent.query}"...`;
    case "email_action_needed":
      return `Analyzing emails for action items...`;
    case "email_briefing":
      return `Preparing inbox briefing...`;
    case "email_compose_new":
      return `Drafting email...`;
    case "email_draft_reply":
      return `Drafting reply...`;
    case "email_send_confirm":
      return `Sending email...`;
    case "email_archive":
      return `Archiving email...`;
    case "email_mark_read":
      return `Marking emails as read...`;
    case "email_flag":
      return `Flagging email...`;
    case "email_smart_query":
      return `Checking your emails...`;
    case "calendar_today":
      return `Checking today's schedule...`;
    case "calendar_tomorrow":
      return `Checking tomorrow's schedule...`;
    case "calendar_week":
      return `Checking this week's schedule...`;
    case "calendar_free_slots":
      return `Finding free slots...`;
    case "calendar_create":
      return `Preparing meeting...`;
    case "calendar_reschedule":
      return `Rescheduling meeting...`;
    case "calendar_cancel":
      return `Processing cancellation...`;
    case "calendar_accept":
      return `Accepting meeting...`;
    case "calendar_decline":
      return `Declining meeting...`;
    case "calendar_details":
      return `Loading meeting details...`;
    case "calendar_smart_query":
      return `Checking your calendar...`;
    case "calendar_confirm_create":
      return `Creating meeting...`;
    case "calendar_confirm_cancel":
      return `Cancelling meeting...`;
    case "sf_search_accounts":
      return `Searching Salesforce accounts...`;
    case "sf_account_details":
      return `Loading account details...`;
    case "sf_search_contacts":
      return `Searching Salesforce contacts...`;
    case "sf_opportunities":
      return `Loading opportunities...`;
    case "sf_activity":
      return `Loading CRM activity...`;
    case "sf_briefing":
      return `Preparing customer briefing...`;
    case "sf_global_search":
      return `Searching CRM...`;
    case "sf_smart_query":
      return `Checking CRM data...`;
    case "sp_search":
      return `Searching documents...`;
    case "sp_recent":
      return `Loading recent documents...`;
    case "sp_summarize":
      return `Summarizing document...`;
    case "sp_download":
      return `Finding document...`;
    case "sp_sites":
      return `Searching SharePoint sites...`;
    case "sp_smart_query":
      return `Checking documents...`;
    case "briefing_daily":
      return `Preparing your morning briefing...`;
    case "briefing_meeting":
      return `Preparing meeting briefing...`;
    case "briefing_customer":
      return `Building customer context...`;
    case "briefing_weekly":
      return `Preparing weekly overview...`;
    case "briefing_followups":
      return `Checking follow-ups...`;
    case "agent":
      return `Thinking...`;
    default:
      return null; // no confirmation needed for regular chat
  }
}

function detectIntent(userMessage) {
  const msg = userMessage.toLowerCase();

  // 1. Translate a document — detect "translate to <lang>" with a stored file
  const transPatterns = [
    /\btranslat\w*\b.*?\bto\s+(\w+)/i,
    /\btraduir\w*\b.*?\ben\s+(\w+)/i,
    /\btraduc\w*\b.*?\b(?:al|a|en)\s+(\w+)/i,
    /\bübersetzen?\b.*?\b(?:auf|ins?)\s+(\w+)/i,
    /\btranslat\w*\b.*?\bin\s+(\w+)/i,
  ];
  for (const re of transPatterns) {
    const m = userMessage.match(re);
    if (m) {
      // Check stored files — most recently uploaded type wins
      for (const [key] of storedPptxFiles) {
        return { type: "translate_pptx", language: m[1], fileKey: key };
      }
      for (const [key] of storedPdfFiles) {
        return { type: "translate_pdf", language: m[1], fileKey: key };
      }
      for (const [key] of storedDocxFiles) {
        return { type: "translate_docx", language: m[1], docxKey: key };
      }
      // Also try to find a filename mentioned in the message
      const pptxMatch = userMessage.match(/[\w\s-]+\.pptx?\b/i);
      if (pptxMatch) {
        return { type: "translate_pptx", language: m[1], fileKey: pptxMatch[0].trim().toLowerCase() };
      }
      const docxMatch = userMessage.match(/[\w\s-]+\.docx?\b/i);
      if (docxMatch) {
        return { type: "translate_docx", language: m[1], docxKey: docxMatch[0].trim().toLowerCase() };
      }
      const pdfMatch = userMessage.match(/[\w\s-]+\.pdf\b/i);
      if (pdfMatch) {
        return { type: "translate_pdf", language: m[1], fileKey: pdfMatch[0].trim().toLowerCase() };
      }
      // No specific file found — check Redis for any stored file
      return { type: "translate_any", language: m[1], fileKey: "__last_file__" };
    }
  }

  // 2. Anonymize a document — detect "anonymize/anonymise/redact/mask" with a stored file
  if (/\b(anonymi[sz]e|redact|mask|hide\s+(pii|personal|sensitive)|remove\s+(pii|personal|names|sensitive)|anonym\w*)\b/i.test(userMessage)) {
    for (const [key] of storedPptxFiles) {
      return { type: "anonymize_pptx", fileKey: key };
    }
    for (const [key] of storedPdfFiles) {
      return { type: "anonymize_pdf", fileKey: key };
    }
    for (const [key] of storedDocxFiles) {
      return { type: "anonymize_docx", fileKey: key };
    }
    return { type: "anonymize_any" };
  }

  // 3. Create a file — detect "create/generate/write/make ... file/document/report/..."
  const filePatterns = [
    /\b(creat|generat|writ|mak|produc|build|draft|prepar)\w*\b[^.?!]{0,40}\b(file|document|report|csv|html|script|spreadsheet|page|letter|email|template|contract|memo|resume|cv)\b/i,
    /\b(sav|export|convert)\w*\b[^.?!]{0,30}\b(as|to|into)\s+\w*\s*(file|\.?\w{2,4})\b/i,
    /\b(give|send|provide)\w*\b[^.?!]{0,30}\b(me|us)?\s*(a|the)?\s*(file|document|download)\b/i,
  ];
  for (const re of filePatterns) {
    if (re.test(userMessage)) {
      // Try to detect desired format from message
      let format = "html"; // default
      if (/\.csv\b|csv\s+file|spreadsheet/i.test(msg)) format = "csv";
      else if (/\.json\b|json\s+file/i.test(msg)) format = "json";
      else if (/\.txt\b|text\s+file/i.test(msg)) format = "txt";
      else if (/\.md\b|markdown/i.test(msg)) format = "md";
      else if (/\.py\b|python\s+(script|file)/i.test(msg)) format = "py";
      else if (/\.js\b|javascript\s+(script|file)/i.test(msg)) format = "js";
      else if (/\.sql\b|sql\s+(file|script|query)/i.test(msg)) format = "sql";
      else if (/\.xml\b|xml\s+file/i.test(msg)) format = "xml";
      else if (/\.yaml\b|\.yml\b|yaml\s+file/i.test(msg)) format = "yaml";
      else if (/\.sh\b|shell\s+script|bash/i.test(msg)) format = "sh";
      else if (/\.css\b|css\s+file|stylesheet/i.test(msg)) format = "css";
      return { type: "create_file", format };
    }
  }

  // 3. AI Agent — handles email and calendar with tool calling (agentic loop)
  console.log(`${LOG} Agent check: loaded=${!!agent}, available=${agent ? agent.isAvailable() : 'N/A'}`);
  if (agent && agent.isAvailable()) {
    if (/\b(email|mail|inbox|unread|outlook|sender|draft|reply|forward|archive|flag)\b/i.test(userMessage)) {
      console.log(`${LOG} → Agent intent (email)`);
      return { type: "agent", query: userMessage };
    }
    if (/\b(meeting|calendar|schedule|agenda|appointment|free.?slot|busy|event)\b/i.test(userMessage))
      return { type: "agent", query: userMessage };
    if (/^(and\s+)?(after|next|then)\b.*\??$/i.test(msg) || /\bnext\s+(one|meeting)\b/i.test(msg))
      return { type: "agent", query: userMessage };
  }

  // Fallback: old handlers if agent not available
  if (emailIntents && /\b(email|mail|inbox|unread|outlook|sender|draft|reply|forward|archive|flag)\b/i.test(userMessage)) {
    return { type: "email_smart_query", query: userMessage };
  }
  if (calendarIntents) {
    if (/\b(meeting|calendar|schedule|agenda|appointment|free.?slot|busy|event)\b/i.test(userMessage))
      return { type: "calendar_smart_query", query: userMessage };
    if (/^(and\s+)?(after|next|then)\b.*\??$/i.test(msg) || /\bnext\s+(one|meeting)\b/i.test(msg))
      return { type: "calendar_smart_query", query: userMessage };
  }

  // Briefing
  if (briefing && /\b(briefing|brief me|prepare.*meeting|morning.?report|weekly.?summary|follow.?up|action.?item)\b/i.test(userMessage))
    return { type: "briefing_daily", query: userMessage };

  // Salesforce
  if (sfIntents && /\b(salesforce|crm|pipeline|opportunity|account|deal|lead)\b/i.test(userMessage))
    return { type: "sf_smart_query", query: userMessage };

  // SharePoint
  if (spIntents && /\b(sharepoint|onedrive|document|file.*share|shared.*file)\b/i.test(userMessage))
    return { type: "sp_smart_query", query: userMessage };

  // Default — regular chat
  return { type: "chat" };
}

// NOTE: detectIntentAI was removed — the agent module (agent.js) now handles
// all email/calendar queries via Anthropic API with tool calling.
// The regex-based detectIntent() routes to type "agent" when agent.isAvailable().

// ── Intent Handlers ──────────────────────────────────────

/**
 * Handle docx translation: extract paragraphs, ask AI to translate,
 * rebuild the docx with translated text preserving layout/images.
 */
async function handleDocxTranslation(userId, userMessage, language, docxKey) {
  console.log(`${LOG} [INTENT] translate_docx: lang=${language}, file=${docxKey}`);

  let activeKey = docxKey;

  // If no docx in memory for this key, scan Redis for any stored docx
  if (!storedDocxFiles.get(activeKey) && redis) {
    try {
      // Try exact key first
      let b64 = await redis.get(`docx:${activeKey}`);
      if (!b64) {
        // Scan Redis for any docx key
        const keys = await redis.keys("docx:*");
        if (keys.length > 0) {
          // Use the most recent one (last in the list)
          const foundKey = keys[keys.length - 1];
          b64 = await redis.get(foundKey);
          activeKey = foundKey.replace(/^docx:/, "");
          console.log(`${LOG} Found docx in Redis: ${activeKey}`);
        }
      }
      if (b64) {
        storedDocxFiles.set(activeKey, { buffer: Buffer.from(b64, "base64"), storedAt: Date.now() });
        console.log(`${LOG} Loaded docx from Redis: ${activeKey}`);
      }
    } catch (err) { console.warn(`${LOG} Redis docx load failed:`, err.message); }
  }

  if (!storedDocxFiles.get(activeKey)) {
    console.warn(`${LOG} No stored docx found for key: ${activeKey}`);
    return `I don't have any document stored. Please share the .docx file first, then ask me to translate it.`;
  }

  let paragraphs;
  try {
    const zip = await JSZip.loadAsync(storedDocxFiles.get(activeKey).buffer);
    const docXml = await zip.file("word/document.xml").async("string");
    paragraphs = [];
    const paraRegex = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
    let match;
    while ((match = paraRegex.exec(docXml)) !== null) {
      const paraXml = match[0];
      if (/<w:drawing\b|<w:pict\b|<mc:AlternateContent\b/.test(paraXml)) continue;
      const text = paraXml.replace(/<[^>]+>/g, "").trim();
      if (text.length > 0) paragraphs.push(text);
    }
  } catch (err) {
    console.error(`${LOG} Docx paragraph extraction failed:`, err.message);
    return `Sorry, I couldn't read the document. Please share it again.`;
  }

  if (paragraphs.length === 0) return `The document appears to have no text content to translate.`;
  console.log(`${LOG} Extracted ${paragraphs.length} paragraphs for translation`);

  // Translate via dedicated call (longer timeout, chunking, no history)
  const translated = await callTranslation(paragraphs, language);
  if (!translated) return `Sorry, the translation request failed. Please try again.`;

  console.log(`${LOG} Got ${translated.length} translated paragraphs`);

  const result = await executeTranslateDocument({
    source_filename: activeKey,
    translated_paragraphs: translated,
  });

  const parsed = JSON.parse(result);
  if (parsed.success) {
    return `Here's your translated document (${language}):\n\n📎 ${parsed.filename}\n${parsed.download_url}`;
  }
  console.error(`${LOG} translate_document failed:`, parsed.error);
  return `Sorry, something went wrong building the translated document. Please try again.`;
}

/**
 * Handle PDF translation: extract text, translate via AI, output as .docx
 */
async function handlePdfTranslation(userId, userMessage, language, fileKey) {
  console.log(`${LOG} [INTENT] translate_pdf: lang=${language}, file=${fileKey}`);

  let activeKey = fileKey;

  // If no PDF in memory, try Redis
  if (!storedPdfFiles.get(activeKey) && redis) {
    try {
      let b64 = await redis.get(`pdf:${activeKey}`);
      if (!b64) {
        const keys = await redis.keys("pdf:*");
        if (keys.length > 0) {
          const foundKey = keys[keys.length - 1];
          b64 = await redis.get(foundKey);
          activeKey = foundKey.replace(/^pdf:/, "");
          console.log(`${LOG} Found PDF in Redis: ${activeKey}`);
        }
      }
      if (b64) {
        storedPdfFiles.set(activeKey, { buffer: Buffer.from(b64, "base64"), storedAt: Date.now() });
        console.log(`${LOG} Loaded PDF from Redis: ${activeKey}`);
      }
    } catch (err) { console.warn(`${LOG} Redis PDF load failed:`, err.message); }
  }

  if (!storedPdfFiles.get(activeKey)) {
    console.warn(`${LOG} No stored PDF found for key: ${activeKey}`);
    return `I don't have any PDF document stored. Please share the PDF file first, then ask me to translate it.`;
  }

  if (!pdfParse) {
    return `Sorry, PDF parsing is not available. Please share a .docx file instead.`;
  }

  // Extract text from PDF
  let paragraphs;
  try {
    const pdfData = await pdfParse(storedPdfFiles.get(activeKey).buffer);
    if (!pdfData.text || pdfData.text.trim().length === 0) {
      return `The PDF appears to have no extractable text (it might be a scanned image). Please share a text-based PDF or a .docx file.`;
    }
    // Split by double newlines (paragraph breaks in PDF text)
    paragraphs = pdfData.text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);
  } catch (err) {
    console.error(`${LOG} PDF text extraction failed:`, err.message);
    return `Sorry, I couldn't read the PDF. Please try again or share a .docx file instead.`;
  }

  if (paragraphs.length === 0) return `The PDF appears to have no text content to translate.`;
  console.log(`${LOG} Extracted ${paragraphs.length} paragraphs from PDF for translation`);

  // Translate via dedicated call (longer timeout, chunking, no history)
  const translated = await callTranslation(paragraphs, language);
  if (!translated) return `Sorry, the translation request failed. Please try again.`;

  console.log(`${LOG} Got ${translated.length} translated paragraphs from PDF`);

  // Build a .docx from the translated paragraphs
  if (!JSZip) return `Sorry, document creation is not available. Translation:\n\n${translated.join("\n\n")}`;

  try {
    const zip = new JSZip();
    // Build minimal docx XML
    const escapedParas = translated.map(p => {
      const escaped = p.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
      return `<w:p><w:r><w:t xml:space="preserve">${escaped}</w:t></w:r></w:p>`;
    }).join("");

    const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"
            xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
            xmlns:o="urn:schemas-microsoft-com:office:office"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
            xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"
            xmlns:v="urn:schemas-microsoft-com:vml"
            xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
            xmlns:w10="urn:schemas-microsoft-com:office:word"
            xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"
            xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"
            xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk"
            xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml"
            xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"
            mc:Ignorable="w14 wp14">
  <w:body>${escapedParas}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body>
</w:document>`;

    zip.file("word/document.xml", docXml);
    zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
    zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
    zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`);

    const docxBuffer = await zip.generateAsync({ type: "nodebuffer" });
    const baseName = activeKey.replace(/\.pdf$/i, "");
    const outFilename = `${baseName}_translated_${language}.docx`;
    const url = hostFile(outFilename, docxBuffer);
    console.log(`${LOG} PDF translation complete: ${outFilename} (${docxBuffer.length} bytes) -> ${url}`);
    return `Here's your translated document (${language}):\n\n📎 ${outFilename}\n${url}`;
  } catch (err) {
    console.error(`${LOG} PDF translation docx creation failed:`, err.message);
    return `Sorry, something went wrong creating the translated document. Please try again.`;
  }
}

/**
 * Handle translation when no file is in memory — check Redis for PDF or docx.
 */
/**
 * Handle PPTX translation: copy the pptx, replace text in each slide, preserve layout/images.
 */
async function handlePptxTranslation(userId, userMessage, language, fileKey) {
  console.log(`${LOG} [INTENT] translate_pptx: lang=${language}, file=${fileKey}`);

  let activeKey = fileKey;

  // If no PPTX in memory, try Redis
  if (!storedPptxFiles.get(activeKey) && redis) {
    try {
      let b64 = await redis.get(`pptx:${activeKey}`);
      if (!b64) {
        const keys = await redis.keys("pptx:*");
        if (keys.length > 0) {
          const foundKey = keys[keys.length - 1];
          b64 = await redis.get(foundKey);
          activeKey = foundKey.replace(/^pptx:/, "");
          console.log(`${LOG} Found PPTX in Redis: ${activeKey}`);
        }
      }
      if (b64) {
        storedPptxFiles.set(activeKey, { buffer: Buffer.from(b64, "base64"), storedAt: Date.now() });
        console.log(`${LOG} Loaded PPTX from Redis: ${activeKey}`);
      }
    } catch (err) { console.warn(`${LOG} Redis PPTX load failed:`, err.message); }
  }

  if (!storedPptxFiles.get(activeKey)) {
    console.warn(`${LOG} No stored PPTX found for key: ${activeKey}`);
    return `I don't have any PowerPoint file stored. Please share the .pptx file first, then ask me to translate it.`;
  }

  if (!JSZip) return `Sorry, PPTX processing is not available.`;

  let zip;
  try {
    zip = await JSZip.loadAsync(storedPptxFiles.get(activeKey).buffer);
  } catch (err) {
    console.error(`${LOG} PPTX load failed:`, err.message);
    return `Sorry, I couldn't read the PowerPoint file. Please share it again.`;
  }

  // Collect all text paragraphs from all slides
  const slideEntries = [];
  for (const [path] of Object.entries(zip.files)) {
    if (/^ppt\/slides\/slide\d+\.xml$/i.test(path)) {
      slideEntries.push(path);
    }
  }
  slideEntries.sort(); // slide1, slide2, ...

  // Extract all text paragraphs across all slides
  const allParagraphs = []; // { slideIdx, text }
  const slideXmls = [];
  for (let i = 0; i < slideEntries.length; i++) {
    const xml = await zip.file(slideEntries[i]).async("string");
    slideXmls.push(xml);
    // Match <a:p> paragraphs and extract text
    const paraRegex = /<a:p\b[^>]*>[\s\S]*?<\/a:p>/g;
    let match;
    while ((match = paraRegex.exec(xml)) !== null) {
      const paraXml = match[0];
      // Skip paragraphs with images/drawings
      if (/<a:blipFill\b|<a:prstGeom\b/.test(paraXml)) continue;
      // Extract text from <a:t> tags
      const textParts = paraXml.match(/<a:t>[^<]*<\/a:t>/g) || [];
      const text = textParts.map(t => t.replace(/<\/?a:t>/g, "")).join("").trim();
      if (text.length > 0) {
        allParagraphs.push({ slideIdx: i, text });
      }
    }
  }

  if (allParagraphs.length === 0) return `The presentation appears to have no text content to translate.`;
  console.log(`${LOG} Extracted ${allParagraphs.length} text paragraphs from ${slideEntries.length} slides`);

  // Translate via dedicated call (longer timeout, chunking, no history)
  const pptxTexts = allParagraphs.map(p => p.text);
  const translated = await callTranslation(pptxTexts, language);
  if (!translated) return `Sorry, the translation request failed. Please try again.`;

  console.log(`${LOG} Got ${translated.length} translated paragraphs for PPTX`);

  // Replace text in each slide XML — same approach as docx: replace <a:t> content
  let transIdx = 0;
  for (let i = 0; i < slideEntries.length; i++) {
    let xml = slideXmls[i];
    xml = xml.replace(/<a:p\b[^>]*>[\s\S]*?<\/a:p>/g, (paraXml) => {
      // Skip image paragraphs
      if (/<a:blipFill\b|<a:prstGeom\b/.test(paraXml)) return paraXml;
      const textParts = paraXml.match(/<a:t>[^<]*<\/a:t>/g) || [];
      const text = textParts.map(t => t.replace(/<\/?a:t>/g, "")).join("").trim();
      if (text.length === 0) return paraXml;
      if (transIdx >= translated.length) return paraXml;

      const newText = translated[transIdx++];
      // Put all translated text in the first <a:r><a:t> and clear the rest
      let firstRun = true;
      const result = paraXml.replace(/<a:r\b[^>]*>[\s\S]*?<\/a:r>/g, (runXml) => {
        if (!/<a:t>/.test(runXml)) return runXml; // no text in this run
        if (firstRun) {
          firstRun = false;
          // Replace <a:t>...</a:t> with translated text
          const escaped = newText.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
          return runXml.replace(/<a:t>[^<]*<\/a:t>/, `<a:t>${escaped}</a:t>`);
        }
        // Clear subsequent runs' text
        return runXml.replace(/<a:t>[^<]*<\/a:t>/, "<a:t></a:t>");
      });
      return result;
    });
    zip.file(slideEntries[i], xml);
  }

  try {
    const pptxBuffer = await zip.generateAsync({ type: "nodebuffer" });
    const baseName = activeKey.replace(/\.pptx?$/i, "");
    const outFilename = `${baseName}_translated_${language}.pptx`;
    const url = hostFile(outFilename, pptxBuffer);
    console.log(`${LOG} PPTX translation complete: ${outFilename} (${pptxBuffer.length} bytes) -> ${url}`);
    return `Here's your translated presentation (${language}):\n\n📎 ${outFilename}\n${url}`;
  } catch (err) {
    console.error(`${LOG} PPTX translation output failed:`, err.message);
    return `Sorry, something went wrong creating the translated presentation. Please try again.`;
  }
}

async function handleAnyTranslation(userId, userMessage, language) {
  console.log(`${LOG} [INTENT] translate_any: lang=${language}, checking Redis for stored files...`);
  if (redis) {
    try {
      // Check for PPTX first
      const pptxKeys = await redis.keys("pptx:*");
      if (pptxKeys.length > 0) {
        const foundKey = pptxKeys[pptxKeys.length - 1];
        const fileKey = foundKey.replace(/^pptx:/, "");
        return handlePptxTranslation(userId, userMessage, language, fileKey);
      }
      // Then PDF
      const pdfKeys = await redis.keys("pdf:*");
      if (pdfKeys.length > 0) {
        const foundKey = pdfKeys[pdfKeys.length - 1];
        const fileKey = foundKey.replace(/^pdf:/, "");
        return handlePdfTranslation(userId, userMessage, language, fileKey);
      }
      // Then docx
      const docxKeys = await redis.keys("docx:*");
      if (docxKeys.length > 0) {
        const foundKey = docxKeys[docxKeys.length - 1];
        const docxKey = foundKey.replace(/^docx:/, "");
        return handleDocxTranslation(userId, userMessage, language, docxKey);
      }
    } catch (err) { console.warn(`${LOG} Redis file scan failed:`, err.message); }
  }
  return `I don't have any document stored. Please share a PDF or .docx file first, then ask me to translate it.`;
}

/**
 * Handle document anonymization: extract text, run through PII anonymizer,
 * rebuild document with anonymized text. Supports PPTX, PDF, and DOCX.
 */
async function handleAnonymizeDocument(userId, intentType, fileKey) {
  if (!pii) return "Anonymization is not available (PII module not loaded).";
  if (!JSZip) return "Document processing is not available (JSZip not installed).";

  console.log(`${LOG} [INTENT] ${intentType}: file=${fileKey || "auto"}`);

  // Resolve which file type to anonymize
  let type = null; // "pptx", "pdf", "docx"
  let activeKey = fileKey;
  let buffer = null;

  if (intentType === "anonymize_pptx" || intentType === "anonymize_any") {
    // Check PPTX
    for (const [key, val] of storedPptxFiles) {
      type = "pptx"; activeKey = key; buffer = val.buffer; break;
    }
    if (!buffer && redis) {
      try {
        const keys = await redis.keys("pptx:*");
        if (keys.length > 0) {
          const b64 = await redis.get(keys[keys.length - 1]);
          if (b64) { type = "pptx"; activeKey = keys[keys.length - 1].replace(/^pptx:/, ""); buffer = Buffer.from(b64, "base64"); }
        }
      } catch {}
    }
  }
  if (!buffer && (intentType === "anonymize_pdf" || intentType === "anonymize_any")) {
    for (const [key, val] of storedPdfFiles) {
      type = "pdf"; activeKey = key; buffer = val.buffer; break;
    }
    if (!buffer && redis) {
      try {
        const keys = await redis.keys("pdf:*");
        if (keys.length > 0) {
          const b64 = await redis.get(keys[keys.length - 1]);
          if (b64) { type = "pdf"; activeKey = keys[keys.length - 1].replace(/^pdf:/, ""); buffer = Buffer.from(b64, "base64"); }
        }
      } catch {}
    }
  }
  if (!buffer && (intentType === "anonymize_docx" || intentType === "anonymize_any")) {
    for (const [key, val] of storedDocxFiles) {
      type = "docx"; activeKey = key; buffer = val.buffer; break;
    }
    if (!buffer && redis) {
      try {
        const keys = await redis.keys("docx:*");
        if (keys.length > 0) {
          const b64 = await redis.get(keys[keys.length - 1]);
          if (b64) { type = "docx"; activeKey = keys[keys.length - 1].replace(/^docx:/, ""); buffer = Buffer.from(b64, "base64"); }
        }
      } catch {}
    }
  }

  if (!buffer) return "I don't have any document stored. Please share a file first, then ask me to anonymize it.";
  console.log(`${LOG} Anonymizing ${type} file: ${activeKey} (${buffer.length} bytes)`);

  try {
    if (type === "pptx") {
      return await anonymizePptx(activeKey, buffer);
    } else if (type === "docx") {
      return await anonymizeDocx(activeKey, buffer);
    } else if (type === "pdf") {
      return await anonymizePdf(activeKey, buffer);
    }
  } catch (err) {
    console.error(`${LOG} Anonymize error:`, err.message);
    return "Sorry, something went wrong anonymizing the document. Please try again.";
  }
}

async function anonymizePptx(activeKey, buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const slideEntries = [];
  for (const [path] of Object.entries(zip.files)) {
    if (/^ppt\/slides\/slide\d+\.xml$/i.test(path)) slideEntries.push(path);
  }
  slideEntries.sort();

  let totalAnonymized = 0;
  for (const slidePath of slideEntries) {
    let xml = await zip.file(slidePath).async("string");
    xml = await replaceTextInXml(xml, /<a:t>([^<]*)<\/a:t>/g, async (fullMatch, text) => {
      if (text.trim().length === 0) return fullMatch;
      const { anonymizedText } = await pii.anonymize(text);
      if (anonymizedText !== text) totalAnonymized++;
      return `<a:t>${escapeXml(anonymizedText)}</a:t>`;
    });
    zip.file(slidePath, xml);
  }

  const outBuffer = await zip.generateAsync({ type: "nodebuffer" });
  const baseName = activeKey.replace(/\.pptx?$/i, "");
  const outFilename = `${baseName}_anonymized.pptx`;
  const url = hostFile(outFilename, outBuffer);
  console.log(`${LOG} PPTX anonymized: ${outFilename} (${totalAnonymized} replacements) -> ${url}`);
  return `Here's your anonymized presentation:\n\n📎 ${outFilename}\n${url}\n\n${totalAnonymized} text segments anonymized.`;
}

async function anonymizeDocx(activeKey, buffer) {
  const zip = await JSZip.loadAsync(buffer);
  const docXmlFile = zip.file("word/document.xml");
  if (!docXmlFile) return "Invalid docx file.";

  let xml = await docXmlFile.async("string");
  let totalAnonymized = 0;
  xml = await replaceTextInXml(xml, /<w:t([^>]*)>([^<]*)<\/w:t>/g, async (fullMatch, attrs, text) => {
    if (text.trim().length === 0) return fullMatch;
    const { anonymizedText } = await pii.anonymize(text);
    if (anonymizedText !== text) totalAnonymized++;
    return `<w:t${attrs}>${escapeXml(anonymizedText)}</w:t>`;
  });
  zip.file("word/document.xml", xml);

  const outBuffer = await zip.generateAsync({ type: "nodebuffer" });
  const baseName = activeKey.replace(/\.docx?$/i, "");
  const outFilename = `${baseName}_anonymized.docx`;
  const url = hostFile(outFilename, outBuffer);
  console.log(`${LOG} DOCX anonymized: ${outFilename} (${totalAnonymized} replacements) -> ${url}`);
  return `Here's your anonymized document:\n\n📎 ${outFilename}\n${url}\n\n${totalAnonymized} text segments anonymized.`;
}

async function anonymizePdf(activeKey, buffer) {
  if (!pdfParse) return "PDF parsing is not available.";

  const pdfData = await pdfParse(buffer);
  if (!pdfData.text || pdfData.text.trim().length === 0) {
    return "The PDF has no extractable text (might be a scanned image).";
  }

  // Split into paragraphs, anonymize each, output as docx
  const paragraphs = pdfData.text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);
  const anonymizedParas = [];
  let totalAnonymized = 0;
  for (const para of paragraphs) {
    const { anonymizedText } = await pii.anonymize(para);
    if (anonymizedText !== para) totalAnonymized++;
    anonymizedParas.push(anonymizedText);
  }

  // Build a docx from anonymized text
  const zip = new JSZip();
  const escapedParas = anonymizedParas.map(p => {
    const escaped = p.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    return `<w:p><w:r><w:t xml:space="preserve">${escaped}</w:t></w:r></w:p>`;
  }).join("");

  const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"
            xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
            xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            mc:Ignorable="w14 wp14">
  <w:body>${escapedParas}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body>
</w:document>`;

  zip.file("word/document.xml", docXml);
  zip.file("[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.file("_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.file("word/_rels/document.xml.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`);

  const docxBuffer = await zip.generateAsync({ type: "nodebuffer" });
  const baseName = activeKey.replace(/\.pdf$/i, "");
  const outFilename = `${baseName}_anonymized.docx`;
  const url = hostFile(outFilename, docxBuffer);
  console.log(`${LOG} PDF anonymized: ${outFilename} (${totalAnonymized} replacements) -> ${url}`);
  return `Here's your anonymized document (PDF → DOCX):\n\n📎 ${outFilename}\n${url}\n\n${totalAnonymized} text segments anonymized.`;
}

/**
 * Helper: async regex replace for XML text nodes.
 * Runs the async replacer on each match sequentially.
 */
async function replaceTextInXml(xml, regex, asyncReplacer) {
  const matches = [];
  let match;
  const re = new RegExp(regex.source, regex.flags);
  while ((match = re.exec(xml)) !== null) {
    matches.push({ fullMatch: match[0], index: match.index, groups: match.slice(1) });
  }
  // Process in reverse order to preserve indices
  let result = xml;
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    const replacement = await asyncReplacer(m.fullMatch, ...m.groups);
    result = result.substring(0, m.index) + replacement + result.substring(m.index + m.fullMatch.length);
  }
  return result;
}

function escapeXml(text) {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Handle file creation: ask AI to generate content only, bot creates the file.
 */
async function handleCreateFile(userId, userMessage, format) {
  console.log(`${LOG} [INTENT] create_file: format=${format}`);

  // Tell AI to generate raw content only — no tools, no file paths, no links
  const formatHints = {
    html: "Return the content as a complete HTML document with inline CSS. No markdown wrapping.",
    csv: "Return the content as raw CSV (comma-separated values). No markdown wrapping.",
    json: "Return the content as raw JSON. No markdown wrapping.",
    txt: "Return the content as plain text. No markdown wrapping.",
    md: "Return the content as Markdown.",
    py: "Return the Python code only. No markdown wrapping.",
    js: "Return the JavaScript code only. No markdown wrapping.",
    sql: "Return the SQL code only. No markdown wrapping.",
    xml: "Return the content as raw XML. No markdown wrapping.",
    yaml: "Return the content as raw YAML. No markdown wrapping.",
    sh: "Return the shell script only. No markdown wrapping.",
    css: "Return the CSS code only. No markdown wrapping.",
  };
  const hint = formatHints[format] || "Return the raw file content only.";

  const contentPrompt = `${userMessage}

IMPORTANT INSTRUCTION: Generate ONLY the file content. ${hint}
Do NOT include any explanation, commentary, or surrounding text.
Do NOT mention file paths, downloads, or tools.
Start directly with the content.`;

  const result = await callOpenClaw(userId, contentPrompt);
  if (!result?.content) return `Sorry, I couldn't generate the file content. Please try again.`;

  let content = result.content;

  // Strip markdown code block wrapper if AI added one
  const codeBlockMatch = content.match(/^```\w*\n([\s\S]*?)```\s*$/);
  if (codeBlockMatch) {
    content = codeBlockMatch[1];
  }

  // Generate a descriptive filename
  let filename = `document.${format}`;
  // Try to extract a meaningful name from the user message
  const nameMatch = userMessage.match(/(?:called|named|titled|filename)\s+["']?([^"'\n,]+)/i)
    || userMessage.match(/\b(\w[\w\s-]{2,30})\.(html|csv|json|txt|md|py|js|sql|xml|yaml|sh|css)\b/i);
  if (nameMatch) {
    const name = nameMatch[1].trim().replace(/\s+/g, "_").replace(/[^\w.-]/g, "");
    filename = `${name}.${format}`;
  }

  const url = hostFile(filename, content);
  console.log(`${LOG} [INTENT] File created: ${filename} (${content.length} chars) -> ${url}`);

  return `Here's your file:\n\n📎 ${filename}\n${url}`;
}

async function callOpenClaw(userId, userMessage, attempt = 1) {
  const history = await getHistory(userId);

  const messages = [];
  const fileNote = `When users share files, their content appears in conversation history. You can read and reference file contents directly.
Do NOT upload files to tmpfiles.org, transfer.sh, or any external service. Do NOT reference paths like /.openclaw/workspace/.
Do NOT mention tools, downloads, or file creation capabilities. Just answer naturally — the system handles file delivery automatically.
You are an AI assistant integrated with the user's calendar, email, and CRM. When meeting details, email summaries, or CRM data appear in the conversation history, treat them as real data you retrieved. Answer follow-up questions about them confidently using the data in the conversation. Never say you don't have access to the calendar or email — you do, and the data is in the conversation history.`;
  let sysPrompt = config.systemPrompt
    ? `${config.systemPrompt}\n\n${fileNote}`
    : fileNote;

  // Inject unified context (entities, agent summaries, file refs)
  if (contextManager) {
    try {
      const ctx = await contextManager.getContextForChat(userId);
      if (ctx) sysPrompt += `\n\n${ctx}`;
    } catch (e) {
      console.warn(`${LOG} Context injection error:`, e.message);
    }
  }

  messages.push({ role: "system", content: sysPrompt });
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
    const choice = data.choices?.[0];
    const assistantMessage = choice?.message?.content || "";

    await addMessage(userId, "user", userMessage);
    await addMessage(userId, "assistant", assistantMessage);

    // Write to unified context store
    if (contextManager) {
      contextManager.addEntry(userId, "user", userMessage, { path: "chat" }).catch(() => {});
      contextManager.addEntry(userId, "assistant", assistantMessage, {
        path: "chat",
        summary: contextManager.generateSummary(assistantMessage),
      }).catch(() => {});
    }

    console.log(`${LOG} <- OpenClaw response (${assistantMessage.length} chars)`);
    return { content: assistantMessage, model: data.model, usage: data.usage };
  } catch (err) {
    clearTimeout(timeout);
    console.error(`${LOG} OpenClaw error (attempt ${attempt}):`, err.message);
    // Retry once on failure
    if (attempt < 2) {
      console.log(`${LOG} Retrying OpenClaw request in 3s...`);
      await new Promise(r => setTimeout(r, 3000));
      return callOpenClaw(userId, userMessage, attempt + 1);
    }
    return null;
  }
}

/**
 * Standalone AI call — no conversation history, just system + user prompt.
 * Used by intent modules for AI-powered features (parsing, summarizing, smart queries).
 */
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const SONNET_MODEL = "claude-sonnet-4-20250514";

async function callAIStandalone(userIdOrPrompt, promptOrUndefined) {
  // Supports both callAIStandalone(prompt) and callAIStandalone(userId, prompt)
  const userPrompt = promptOrUndefined !== undefined ? promptOrUndefined : userIdOrPrompt;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000); // 20s hard timeout

  // Call Anthropic API directly with Sonnet (fast model) — bypass OpenClaw
  if (ANTHROPIC_API_KEY) {
    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: SONNET_MODEL,
          system: "Be concise.",
          messages: [{ role: "user", content: userPrompt }],
          max_tokens: 1000,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (!response.ok) {
        const errBody = await response.text().catch(() => "");
        console.error(`${LOG} Anthropic API ${response.status}: ${errBody.substring(0, 200)}`);
        return null;
      }
      const data = await response.json();
      return data.content?.[0]?.text || null;
    } catch (e) {
      clearTimeout(timeout);
      console.error(`${LOG} callAIStandalone error:`, e.message);
      return null;
    }
  }

  // Fallback: use OpenClaw if no direct API key
  try {
    const response = await fetch(`${config.endpoint}/v1/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: `openclaw:${config.agentId}`,
        messages: [
          { role: "system", content: "Be concise." },
          { role: "user", content: userPrompt },
        ],
        max_tokens: 1000,
        stream: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const data = await response.json();
    return data.choices?.[0]?.message?.content || null;
  } catch (e) {
    clearTimeout(timeout);
    console.error(`${LOG} callAIStandalone error:`, e.message);
    return null;
  }
}

/**
 * Dedicated translation call — longer timeout, no conversation history, chunking for large docs.
 * Returns the full translated JSON array or null on failure.
 */
async function callTranslation(paragraphs, language) {
  const CHUNK_SIZE = 40; // max paragraphs per API call
  const TRANSLATION_TIMEOUT = 180000; // 3 minutes per chunk

  const allTranslated = [];

  for (let start = 0; start < paragraphs.length; start += CHUNK_SIZE) {
    const chunk = paragraphs.slice(start, start + CHUNK_SIZE);
    const numberedParas = chunk.map((p, i) => `[${i}] ${p}`).join("\n");
    const prompt = `Translate each numbered paragraph below to ${language}. Return ONLY a JSON array of translated strings (same order, same count). No explanation, no markdown, just the JSON array.

${numberedParas}`;

    console.log(`${LOG} Translation chunk ${Math.floor(start / CHUNK_SIZE) + 1}/${Math.ceil(paragraphs.length / CHUNK_SIZE)}: ${chunk.length} paragraphs`);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TRANSLATION_TIMEOUT);

    try {
      const response = await fetch(`${config.endpoint}/v1/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: `openclaw:${config.agentId}`,
          messages: [
            { role: "system", content: "You are a professional translator. Return ONLY the JSON array of translated strings. No commentary." },
            { role: "user", content: prompt },
          ],
          max_tokens: config.maxTokens,
          stream: false,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        const errText = await response.text();
        console.error(`${LOG} Translation API error: ${response.status} ${errText.substring(0, 200)}`);
        return null;
      }

      const data = await response.json();
      const content = data.choices?.[0]?.message?.content || "";
      const jsonMatch = content.match(/\[[\s\S]*\]/);
      if (!jsonMatch) { console.error(`${LOG} No JSON array in translation response`); return null; }
      const parsed = JSON.parse(jsonMatch[0]);
      if (!Array.isArray(parsed)) { console.error(`${LOG} Translation response is not an array`); return null; }

      allTranslated.push(...parsed);
      console.log(`${LOG} Chunk translated: got ${parsed.length} paragraphs`);
    } catch (err) {
      clearTimeout(timeout);
      console.error(`${LOG} Translation call failed:`, err.message);
      return null;
    }
  }

  return allTranslated;
}

// ── File Creation & Upload ───────────────────────────────

/**
 * Parse AI response for [FILE:name]content[/FILE] markers.
 * Returns { text: cleanedResponse, files: [{ filename, content }] }
 */
function parseFileMarkers(response) {
  const files = [];
  const regex = /\[FILE:([^\]]+)\]\n?([\s\S]*?)\[\/FILE\]/g;
  let match;
  let text = response;

  while ((match = regex.exec(response)) !== null) {
    const fname = match[1].trim();
    files.push({ filename: fname, content: match[2], placeholder: `{{FILE_LINK:${fname}}}` });
    text = text.replace(match[0], `{{FILE_LINK:${fname}}}`);
  }

  return { text: text.trim(), files };
}

/**
 * Upload a file to Rainbow fileserver and send it in a conversation.
 */
async function uploadAndSendFile(filename, content, convId) {
  console.log(`${LOG} uploadAndSendFile: filename=${filename}, contentLen=${content.length}, convId=${convId}`);
  const buf = Buffer.from(content, "utf-8");
  const mime = guessMime(filename);
  const host = rainbowHost || "openrainbow.com";

  // Helper: wrap a promise with a timeout so nothing hangs forever
  function withTimeout(promise, ms, label) {
    return Promise.race([
      promise,
      new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)),
    ]);
  }

  // Strategy 1: SDK internal REST helper
  try {
    const restService = sdk._core?._rest;
    if (restService && typeof restService.post === "function") {
      const createPath = "/api/rainbow/fileserver/v1.0/files";
      const createBody = { fileName: filename, extension: filename.split(".").pop(), typeMIME: mime, size: buf.length };
      console.log(`${LOG} [S1] SDK REST POST ${createPath}`);

      const createResult = await withTimeout(new Promise((resolve, reject) => {
        restService.post(createPath, null, createBody, (err, response, body) => {
          if (err) return reject(err);
          resolve({ response, body });
        });
      }), 10000, "S1 POST");

      const fileMeta = typeof createResult.body === "string" ? JSON.parse(createResult.body) : createResult.body;
      const fileId = fileMeta?.data?.id || fileMeta?.id;
      console.log(`${LOG} [S1] File created: ${fileId}, resp: ${JSON.stringify(fileMeta).substring(0, 300)}`);

      if (fileId && typeof restService.put === "function") {
        const uploadPath = `/api/rainbow/fileserver/v1.0/files/${fileId}`;
        await withTimeout(new Promise((resolve, reject) => {
          restService.put(uploadPath, null, buf, mime, (err, response, body) => {
            if (err) return reject(err);
            resolve({ response, body });
          });
        }), 10000, "S1 PUT");
        console.log(`${LOG} [S1] File uploaded: ${filename} (${buf.length} bytes)`);
        const fileUrl = `https://${host}/api/rainbow/fileserver/v1.0/files/${fileId}`;
        return { ok: true, url: fileUrl, fileId };
      }
    } else {
      const methods = restService ? Object.getOwnPropertyNames(Object.getPrototypeOf(restService)).filter(m => /post|put|get|send|upload|file/i.test(m)).join(", ") : "no restService";
      console.log(`${LOG} [S1] restService.post not available, methods: ${methods}`);
    }
  } catch (err) {
    console.warn(`${LOG} [S1] SDK REST upload failed:`, err.message);
  }

  // Strategy 2: SDK fileStorage service
  try {
    const fsSvc = sdk.fileStorage || sdk._core?._fileStorage || sdk._core?.fileStorage;
    if (fsSvc) {
      const methods = Object.getOwnPropertyNames(Object.getPrototypeOf(fsSvc)).filter(m => /upload|create|file|descriptor/i.test(m));
      console.log(`${LOG} [S2] fileStorage methods: ${methods.join(", ")}`);

      if (typeof fsSvc.createFileDescriptor === "function") {
        const descriptor = await withTimeout(fsSvc.createFileDescriptor(filename, "", mime, buf.length), 10000, "S2 createFileDescriptor");
        console.log(`${LOG} [S2] descriptor: ${JSON.stringify(descriptor).substring(0, 300)}`);
        const fileId = descriptor?.id || descriptor?.data?.id;
        if (fileId && typeof fsSvc.uploadFileToStorage === "function") {
          await withTimeout(fsSvc.uploadFileToStorage(descriptor, buf), 10000, "S2 uploadFileToStorage");
          console.log(`${LOG} [S2] File uploaded: ${filename}`);
          const fileUrl = `https://${host}/api/rainbow/fileserver/v1.0/files/${fileId}`;
          return { ok: true, url: fileUrl, fileId };
        }
      }
    } else {
      console.log(`${LOG} [S2] No fileStorage service found`);
    }
  } catch (err) {
    console.warn(`${LOG} [S2] SDK fileStorage failed:`, err.message);
  }

  // Strategy 3: Direct REST with Bearer token
  if (authToken) {
    try {
      const baseUrl = `https://${host}/api/rainbow/fileserver/v1.0/files`;
      console.log(`${LOG} [S3] Direct REST POST ${baseUrl}`);
      const createResp = await withTimeout(fetch(baseUrl, {
        method: "POST",
        headers: { "Authorization": `Bearer ${authToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ fileName: filename, extension: filename.split(".").pop(), typeMIME: mime, size: buf.length }),
      }), 10000, "S3 POST");
      const createText = await createResp.text();
      console.log(`${LOG} [S3] Response (${createResp.status}): ${createText.substring(0, 300)}`);
      if (createResp.ok) {
        const fileMeta = JSON.parse(createText);
        const fileId = fileMeta?.data?.id || fileMeta?.id;
        if (fileId) {
          const uploadResp = await withTimeout(fetch(`${baseUrl}/${fileId}`, {
            method: "PUT",
            headers: { "Authorization": `Bearer ${authToken}`, "Content-Type": mime },
            body: buf,
          }), 10000, "S3 PUT");
          if (uploadResp.ok) {
            console.log(`${LOG} [S3] File uploaded: ${filename}`);
            return { ok: true, url: `${baseUrl}/${fileId}`, fileId };
          }
        }
      }
    } catch (err) {
      console.warn(`${LOG} [S3] Direct REST failed:`, err.message);
    }
  }

  console.error(`${LOG} All file upload strategies failed for ${filename}`);
  return { ok: false, url: null };
}

function guessMime(filename) {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  const mimes = {
    txt: "text/plain", csv: "text/csv", json: "application/json",
    xml: "application/xml", html: "text/html", htm: "text/html",
    md: "text/markdown", js: "application/javascript", py: "text/x-python",
    css: "text/css", sql: "text/x-sql", yaml: "application/x-yaml",
    yml: "application/x-yaml", sh: "text/x-shellscript",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    doc: "application/msword",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xls: "application/vnd.ms-excel",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ppt: "application/vnd.ms-powerpoint",
    pdf: "application/pdf",
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    svg: "image/svg+xml", zip: "application/zip",
  };
  return mimes[ext] || "application/octet-stream";
}

// ── File Download ────────────────────────────────────────

/**
 * Extract file info from a message (SDK-parsed or raw callback).
 * Returns { fileId, url, mime, filename, filesize } or null.
 */
function extractFileInfo(message, rawCb, convId) {
  // 1. SDK-parsed oob (from S2S attachment mapping)
  const oob = message.oob || message.attachment || {};
  // 2. Raw callback attachment (fallback if SDK didn't parse)
  const rawAttach = rawCb?.attachment || {};

  // Only check if the current message actually has a file attachment
  const hasDirectAttachment = !!(oob.url || oob.fileId || rawAttach.url || rawAttach.fileId);
  if (!hasDirectAttachment) return null;

  const url = oob.url || rawAttach.url || "";
  const fileId = oob.fileId || rawAttach.fileId || url.split("/").pop() || "";

  if (!fileId || !url) return null;

  return {
    fileId,
    url,
    mime: oob.mime || rawAttach.mime || "application/octet-stream",
    filename: oob.filename || rawAttach.filename || `file_${fileId}`,
    filesize: parseInt(oob.filesize || oob.size || rawAttach.filesize || rawAttach.size || "0", 10),
  };
}

/**
 * Download a file from Rainbow using multiple strategies.
 * Returns { buffer, mime, filename, filesize } or null.
 */
// Store last download result for debugging
let lastDownloadResult = null;

async function downloadFile(fileInfo, attempt = 1) {
  const { fileId, url, mime, filename, filesize } = fileInfo;
  console.log(`${LOG} Downloading file: ${filename} (${fileId}, ${mime}, ${filesize} bytes) [attempt ${attempt}]`);

  // Strategy 1: SDK fileStorage.downloadFile (handles auth + chunking)
  try {
    if (sdk.fileStorage && typeof sdk.fileStorage.downloadFile === "function") {
      const fd = { id: fileId, url, typeMIME: mime, size: filesize, fileName: filename };
      const result = await sdk.fileStorage.downloadFile(fd);
      if (result && result.buffer) {
        const buf = Buffer.isBuffer(result.buffer) ? result.buffer : Buffer.from(result.buffer);
        console.log(`${LOG} Downloaded via SDK: ${filename} (${buf.length} bytes, expected ${filesize})`);
        // SDK sometimes returns 1-byte garbage — only accept if we got meaningful data
        if (buf.length > 10 && (filesize === 0 || buf.length >= filesize * 0.5)) {
          return { buffer: buf, mime: result.type || mime, filename: result.fileName || filename, filesize: buf.length };
        }
        console.warn(`${LOG} SDK download too small (${buf.length}/${filesize}), trying next strategy`);
      }
    }
  } catch (err) {
    console.warn(`${LOG} SDK downloadFile failed:`, err.message);
  }

  // Strategy 2: Get temporary URL from SDK, then fetch
  try {
    if (sdk.fileStorage && typeof sdk.fileStorage.getFilesTemporaryURL === "function") {
      const tmpResult = await sdk.fileStorage.getFilesTemporaryURL(fileId);
      console.log(`${LOG} Temp URL result type: ${typeof tmpResult}, value: ${JSON.stringify(tmpResult).substring(0, 300)}`);
      // Result may be a string URL or an object with url property
      const tmpUrl = typeof tmpResult === "string" ? tmpResult : (tmpResult?.url || tmpResult?.uri || null);
      if (tmpUrl && typeof tmpUrl === "string") {
        const resp = await fetch(tmpUrl);
        if (resp.ok) {
          const buf = Buffer.from(await resp.arrayBuffer());
          console.log(`${LOG} Downloaded via temp URL: ${filename} (${buf.length} bytes)`);
          if (buf.length > 10) {
            lastDownloadResult = { fileId, filename, ok: true, bytes: buf.length, strategy: "temp-url", time: new Date().toISOString() };
            return { buffer: buf, mime, filename, filesize: buf.length };
          }
        }
      }
    }
  } catch (err) {
    console.warn(`${LOG} Temp URL download failed:`, err.message);
  }

  // Strategy 3: Use SDK's internal REST helper (handles auth properly)
  try {
    const restService = sdk._core?._rest;
    if (restService && typeof restService.get === "function") {
      const filePath = `/api/rainbow/fileserver/v1.0/files/${fileId}`;
      console.log(`${LOG} Trying SDK REST helper: ${filePath}`);
      const result = await new Promise((resolve, reject) => {
        restService.get(filePath, null, (err, response, body) => {
          if (err) return reject(err);
          resolve({ response, body });
        });
      });
      if (result.body && result.body.length > 10) {
        const buf = Buffer.isBuffer(result.body) ? result.body : Buffer.from(result.body);
        console.log(`${LOG} Downloaded via SDK REST helper: ${filename} (${buf.length} bytes)`);
        lastDownloadResult = { fileId, filename, ok: true, bytes: buf.length, strategy: "sdk-rest-helper", time: new Date().toISOString() };
        return { buffer: buf, mime, filename, filesize: buf.length };
      }
    }
  } catch (err) {
    console.warn(`${LOG} SDK REST helper failed:`, err.message);
  }

  // Strategy 4: Direct REST API call with auth token
  if (authToken) {
    try {
      const host = rainbowHost || "openrainbow.com";
      const fileUrl = url.startsWith("http") ? url : `https://${host}${url}`;
      console.log(`${LOG} REST download URL: ${fileUrl}`);
      console.log(`${LOG} Auth token prefix: ${authToken.substring(0, 20)}...`);
      const resp = await fetch(fileUrl, {
        headers: { "Authorization": `Bearer ${authToken}`, "Accept": "*/*" },
        redirect: "follow",
      });
      if (resp.ok) {
        const contentType = resp.headers.get("content-type") || "";
        const buf = Buffer.from(await resp.arrayBuffer());
        console.log(`${LOG} REST response: ${buf.length} bytes, content-type: ${contentType}`);
        // If we got JSON metadata instead of file content, try extracting download URL
        if (contentType.includes("application/json") && buf.length < 5000) {
          try {
            const meta = JSON.parse(buf.toString("utf-8"));
            const dlUrl = meta.url || meta.location || meta.downloadUrl || null;
            console.log(`${LOG} REST got metadata, download URL: ${dlUrl}`);
            if (dlUrl) {
              const dlResp = await fetch(dlUrl, {
                headers: { "Authorization": `Bearer ${authToken}` },
                redirect: "follow",
              });
              if (dlResp.ok) {
                const dlBuf = Buffer.from(await dlResp.arrayBuffer());
                console.log(`${LOG} Downloaded via REST redirect: ${filename} (${dlBuf.length} bytes)`);
                if (dlBuf.length > 10) { lastDownloadResult = { fileId, filename, ok: true, bytes: dlBuf.length, strategy: "rest-redirect", time: new Date().toISOString() }; return { buffer: dlBuf, mime, filename, filesize: dlBuf.length }; }
              }
            }
          } catch (_) {}
        }
        // Direct binary content
        if (buf.length > 10) {
          console.log(`${LOG} Downloaded via REST: ${filename} (${buf.length} bytes)`);
          lastDownloadResult = { fileId, filename, ok: true, bytes: buf.length, strategy: "rest-direct", time: new Date().toISOString() };
          return { buffer: buf, mime, filename, filesize: buf.length };
        }
      }
      console.warn(`${LOG} REST download failed (${resp.status}): ${await resp.text().catch(() => "")}`);
    } catch (err) {
      console.warn(`${LOG} REST download error:`, err.message);
    }
  }

  // Retry with delay (file might not be fully uploaded to fileserver yet)
  if (attempt < 3) {
    const delay = attempt * 2000; // 2s, 4s
    console.log(`${LOG} Download attempt ${attempt} failed, retrying in ${delay}ms...`);
    await new Promise(r => setTimeout(r, delay));
    return downloadFile(fileInfo, attempt + 1);
  }

  console.error(`${LOG} All download strategies failed for ${filename} (${fileId}) after ${attempt} attempts`);
  lastDownloadResult = { fileId, filename, ok: false, time: new Date().toISOString() };
  return null;
}

/**
 * Describe a file for the AI context (text summary of the file).
 * For text/code files, includes the content. For others, describes metadata.
 */
async function describeFileForAI(fileInfo, downloaded) {
  if (!downloaded) return `[File shared: ${fileInfo.filename} (${fileInfo.mime}, ${fileInfo.filesize} bytes) — download failed]`;

  const { buffer, mime, filename } = downloaded;

  // Text-based files: include content directly
  const textTypes = ["text/", "application/json", "application/xml", "application/javascript",
    "application/csv", "application/yaml", "application/x-yaml"];
  const textExtensions = [".txt", ".md", ".csv", ".json", ".xml", ".yaml", ".yml", ".js", ".ts",
    ".py", ".java", ".go", ".rs", ".html", ".css", ".sql", ".sh", ".bat", ".log", ".conf", ".ini", ".env"];

  const isText = textTypes.some(t => mime.startsWith(t))
    || textExtensions.some(ext => filename.toLowerCase().endsWith(ext));

  if (isText && buffer.length < 50000) {
    const text = buffer.toString("utf-8");
    return `[File: ${filename}]\n\`\`\`\n${text}\n\`\`\``;
  }

  // Word documents (.docx): extract text only (lightweight), store raw buffer for translate_document tool
  if ((mime.includes("wordprocessingml") || filename.toLowerCase().endsWith(".docx")) && mammoth) {
    // Store raw docx buffer so translate_document tool can use it later
    // Clear old stored files when a new one is uploaded
    storedPdfFiles.clear();
    storedPptxFiles.clear();
    storedDocxFiles.set(filename.toLowerCase(), { buffer, storedAt: Date.now() });
    if (redis) {
      // Clean old PDF/PPTX keys and store new docx
      redis.keys("pdf:*").then(keys => keys.forEach(k => redis.del(k))).catch(() => {});
      redis.keys("pptx:*").then(keys => keys.forEach(k => redis.del(k))).catch(() => {});
      redis.set(`docx:${filename.toLowerCase()}`, buffer.toString("base64"), { EX: 24 * 3600 }).catch(() => {});
    }
    console.log(`${LOG} Stored raw docx: ${filename} (${buffer.length} bytes)`);
    try {
      const result = await mammoth.extractRawText({ buffer });
      if (result.value && result.value.trim().length > 0) {
        const text = result.value.trim().substring(0, 50000);
        return `[Word document: ${filename}]\n\`\`\`\n${text}\n\`\`\`\nTo translate or modify this document, use the translate_document tool. It will produce a proper .docx file preserving the original layout, images, and formatting.`;
      }
    } catch (err) {
      console.warn(`${LOG} mammoth extraction failed:`, err.message);
    }
  }

  // PDF: extract text and store buffer for translation
  if (mime === "application/pdf" || filename.toLowerCase().endsWith(".pdf")) {
    // Clear old stored files when a new one is uploaded
    storedDocxFiles.clear();
    storedPptxFiles.clear();
    storedPdfFiles.set(filename.toLowerCase(), { buffer, storedAt: Date.now() });
    if (redis) {
      // Clean old docx/PPTX keys and store new PDF
      redis.keys("docx:*").then(keys => keys.forEach(k => redis.del(k))).catch(() => {});
      redis.keys("pptx:*").then(keys => keys.forEach(k => redis.del(k))).catch(() => {});
      redis.set(`pdf:${filename.toLowerCase()}`, buffer.toString("base64"), { EX: 24 * 3600 }).catch(() => {});
    }
    console.log(`${LOG} Stored raw PDF: ${filename} (${buffer.length} bytes)`);

    if (pdfParse) {
      try {
        const pdfData = await pdfParse(buffer);
        if (pdfData.text && pdfData.text.trim().length > 0) {
          const text = pdfData.text.trim().substring(0, 50000);
          return `[PDF document: ${filename}]\n\`\`\`\n${text}\n\`\`\`\nTo translate this document, just ask me to translate it to any language.`;
        }
      } catch (err) {
        console.warn(`${LOG} PDF text extraction failed:`, err.message);
      }
    }
    return `[PDF file shared: ${filename} (${buffer.length} bytes) — file stored for translation]`;
  }

  // PowerPoint (.pptx): extract text from slides, store buffer for translation
  if (mime.includes("presentationml") || filename.toLowerCase().endsWith(".pptx")) {
    // Clear old stored files
    storedDocxFiles.clear();
    storedPdfFiles.clear();
    storedPptxFiles.set(filename.toLowerCase(), { buffer, storedAt: Date.now() });
    if (redis) {
      redis.keys("docx:*").then(keys => keys.forEach(k => redis.del(k))).catch(() => {});
      redis.keys("pdf:*").then(keys => keys.forEach(k => redis.del(k))).catch(() => {});
      redis.set(`pptx:${filename.toLowerCase()}`, buffer.toString("base64"), { EX: 24 * 3600 }).catch(() => {});
    }
    console.log(`${LOG} Stored raw PPTX: ${filename} (${buffer.length} bytes)`);

    if (JSZip) {
      try {
        const zip = await JSZip.loadAsync(buffer);
        const texts = [];
        // Extract text from all slides
        for (const [path, file] of Object.entries(zip.files)) {
          if (/^ppt\/slides\/slide\d+\.xml$/i.test(path)) {
            const xml = await file.async("string");
            // Extract text from <a:t> tags
            const matches = xml.match(/<a:t>[^<]*<\/a:t>/g) || [];
            const slideText = matches.map(m => m.replace(/<\/?a:t>/g, "")).join(" ").trim();
            if (slideText) texts.push(slideText);
          }
        }
        if (texts.length > 0) {
          const text = texts.join("\n\n").substring(0, 50000);
          return `[PowerPoint: ${filename}]\n\`\`\`\n${text}\n\`\`\`\nTo translate this presentation, just ask me to translate it to any language.`;
        }
      } catch (err) {
        console.warn(`${LOG} PPTX text extraction failed:`, err.message);
      }
    }
    return `[PowerPoint file shared: ${filename} (${buffer.length} bytes) — file stored for translation]`;
  }

  // Images: describe metadata (AI can't see the image through text API)
  if (mime.startsWith("image/")) {
    return `[Image shared: ${filename} (${mime}, ${buffer.length} bytes)]`;
  }

  // Other binary files
  return `[File shared: ${filename} (${mime}, ${buffer.length} bytes)]`;
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

// ── Active bubble conversations ─────────────────────────
// Tracks bubbles where the bot recently spoke, so it can evaluate follow-ups
const activeConversations = new Map(); // historyKey → { lastActivity: timestamp }
const CONVO_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Ask the AI whether a message in a bubble is directed at the bot.
 * Uses a fast, cheap evaluation prompt. Returns true/false.
 */
async function isMessageForBot(historyKey, fromName, content) {
  const history = await getHistory(historyKey);
  // Build recent context (last 6 messages max for speed)
  const recentHistory = history.slice(-6);

  const evalMessages = [
    {
      role: "system",
      content: `You are evaluating whether a message in a group chat is directed at the AI bot (you) or is just a conversation between humans.

The bot was recently active in this conversation. Consider:
- Is the user replying to something the bot said?
- Is the user asking a question the bot could answer?
- Is the user giving feedback on the bot's previous response (thanks, ok, yes, no, etc.)?
- Or is this clearly a message between humans that doesn't involve the bot?

Respond with ONLY "YES" or "NO". Nothing else.`
    },
    ...recentHistory,
    { role: "user", content: `[${fromName}]: ${content}` },
    { role: "user", content: "Is the above message directed at the bot? Reply YES or NO only." }
  ];

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const url = `${config.endpoint}/v1/chat/completions`;
    const resp = await fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: `openclaw:${config.agentId}`, messages: evalMessages, max_tokens: 5, stream: false }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!resp.ok) return false;
    const data = await resp.json();
    const answer = (data.choices?.[0]?.message?.content || "").trim().toUpperCase();
    console.log(`${LOG} Intent check for "${content.substring(0, 50)}": ${answer}`);
    return answer.startsWith("YES");
  } catch (err) {
    console.warn(`${LOG} Intent check failed:`, err.message);
    return false;
  }
}

// ── Bubble caches ───────────────────────────────────────

const bubbleList = new Map();    // bubbleId → bubble
const bubbleByJid = new Map();   // bubbleJid → bubble
const bubbleByMember = new Map(); // memberJid → [bubbles]

// ── Stats ───────────────────────────────────────────────

let stats = { received: 0, replied: 0, errors: 0, startedAt: Date.now() };
const processedMsgIds = new Set();

// ── Process file messages directly from S2S callback ────
// (SDK doesn't fire rainbow_onmessagereceived for file-only messages in S2S mode)
const processedFileIds = new Set();
async function processFileFromCallback(msg, convId, fromUserId, isGroup) {
  const fileKey = `${msg.id || ""}:${msg.attachment?.url || ""}`;
  if (processedFileIds.has(fileKey)) return; // already handled by SDK event
  processedFileIds.add(fileKey);
  if (processedFileIds.size > 200) { const f = processedFileIds.values().next().value; processedFileIds.delete(f); }

  console.log(`${LOG} processFileFromCallback: ${msg.attachment?.filename} from ${fromUserId} in conv ${convId}`);

  const att = msg.attachment;
  if (!att || !att.url) return;

  const fileInfo = {
    fileId: att.url.split("/").pop() || "",
    url: att.url,
    mime: att.mime || "application/octet-stream",
    filename: att.filename || "file",
    filesize: parseInt(att.size || "0", 10),
  };

  const downloaded = await downloadFile(fileInfo);
  const fileContext = await describeFileForAI(fileInfo, downloaded);
  console.log(`${LOG} File callback context: ${fileContext.substring(0, 200)}`);

  // Store in conversation history
  const historyKey = isGroup ? `bubble:${convId}` : (fromUserId || convId);
  const fromName = fromUserId; // Best we have from raw callback
  await addMessage(historyKey, "user", `[${fromName} shared a file]\n${fileContext}`);

  // Write file context to unified store
  if (contextManager) {
    contextManager.addEntry(historyKey, "system", `File shared: ${fileInfo.filename}. ${fileContext.substring(0, 500)}`, {
      path: "file_upload",
      filesReferenced: [fileInfo.filename],
    }).catch(() => {});
  }

  // Detect alert config file (JSON with alert keys)
  if (salesScheduler && fileInfo.filename.toLowerCase().endsWith(".json")) {
    let jsonText = null;
    if (downloaded && downloaded.buffer) {
      jsonText = downloaded.buffer.toString("utf-8");
    } else if (fileContext) {
      const jsonMatch = fileContext.match(/```\n([\s\S]*?)\n```/);
      if (jsonMatch) jsonText = jsonMatch[1];
    }
    if (jsonText) {
      try {
        const parsed = JSON.parse(jsonText);
        if (parsed.daily_digest || parsed.weekly_summary || parsed.stale_deal_alert || parsed.close_date_alert || parsed.high_value_alert) {
          const alertUserId = fromUserId || convId;
          console.log(`${LOG} Alert config detected in ${fileInfo.filename} for ${alertUserId}`);
          const result = await salesScheduler.applyConfigFile(alertUserId, parsed);
          const configMsg = result.success
            ? `Alert configuration applied (${result.timezone}):\n${result.alerts.map(a => `- ${a}`).join("\n")}`
            : `Failed to apply config: ${result.error}`;
          console.log(`${LOG} Alert config result: ${configMsg.substring(0, 200)}`);
          // Don't return — let it fall through to the normal confirmation handler
          // but replace confirmMsg content
          fileContext = configMsg;
        }
      } catch (e) {
        console.warn(`${LOG} Alert config parse error:`, e.message);
      }
    }
  }

  // Send confirmation — fileContext may have been replaced by alert config result
  const isAlertConfig = fileContext && fileContext.startsWith("Alert configuration");
  const fileSize = fileInfo.filesize ? ` (${Math.round(fileInfo.filesize / 1024)}KB)` : "";
  const confirmMsg = isAlertConfig
    ? fileContext
    : downloaded
      ? `📎 **${fileInfo.filename}**${fileSize} received and ready.\n\nYou can now ask me to:\n- Translate it\n- Summarize it\n- Anonymize it\n- Or ask any question about its content`
      : `📎 I see **${fileInfo.filename}** was shared, but I couldn't download it. Try pasting the content directly.`;

  let sent = false;
  console.log(`${LOG} File confirmation: convId=${convId}, fromUserId=${fromUserId}, s2s=${!!s2sConnectionId}, isAlert=${isAlertConfig}`);

  // Method 1: S2S REST with conversation_id
  if (convId && s2sConnectionId && authToken) {
    try {
      const host = rainbowHost || "openrainbow.com";
      const resp = await fetch(`https://${host}/api/rainbow/ucs/v1.0/connections/${s2sConnectionId}/conversations/${convId}/messages`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${authToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message: { body: confirmMsg, lang: "en" } }),
      });
      sent = resp.ok;
      if (sent) console.log(`${LOG} File confirmation sent via REST conv ${convId}`);
      else console.warn(`${LOG} File confirmation REST failed: ${resp.status} ${await resp.text().catch(() => "")}`);
    } catch (e) {
      console.warn(`${LOG} File confirmation REST error:`, e.message);
    }
  }

  // Method 2: SDK — try by user ID first, then by JID
  if (!sent && sdk && fromUserId) {
    try {
      let contact = null;
      // fromUserId might be a user ID or a JID — try both
      try { contact = await sdk.contacts.getContactById(fromUserId); } catch {}
      if (!contact) { try { contact = await sdk.contacts.getContactByJid(fromUserId); } catch {} }
      if (contact) {
        const conv = await sdk.conversations.openConversationForContact(contact);
        if (conv) {
          await sdk.im.sendMessageToConversation(conv, confirmMsg);
          sent = true;
          console.log(`${LOG} File confirmation sent via SDK`);
        }
      }
    } catch (e) { console.warn(`${LOG} File confirmation SDK failed:`, e.message); }
  }
  if (!sent) console.warn(`${LOG} Could not send file confirmation for ${fileInfo.filename} (convId=${convId}, userId=${fromUserId})`);
}

// ── Create Express app for S2S callbacks ────────────────

const app = express();
app.use(express.json());

// Initialize sales dashboard routes
if (salesDashboard) {
  salesDashboard.init(app, { pii, redis: null }); // redis set later in initRedis
}
// Initialize super-admin portal
if (superAdmin && tenant) {
  superAdmin.init(app, { redis: null, tenant }); // redis set later in initRedis
}

// Store last messages for debug
const debugMessages = [];

// Store raw S2S callbacks for debug
const debugCallbacks = [];

// Map message IDs to raw callback data (so onmessagereceived can detect is_group)
const rawCallbackMap = new Map();
const conversationByJid = new Map(); // JID → conversation_id for proactive messaging
// Map conversation_id to bubble JID (built from callbacks)
const convIdToBubbleJid = new Map();
// Map conversation_id to most recent file attachment (so follow-up messages can access it)
const recentFilesByConv = new Map();

// Log ALL incoming requests (before SDK handles them)
app.use((req, res, next) => {
  if (req.method === "POST") {
    const fullUrl = req.originalUrl || req.url || req.path;
    const cb = { path: fullUrl, method: req.method, body: JSON.stringify(req.body || {}).substring(0, 800), time: new Date().toISOString() };
    debugCallbacks.push(cb);
    if (debugCallbacks.length > 20) debugCallbacks.shift();
    console.log(`${LOG} HTTP ${req.method} ${fullUrl} body=${cb.body.substring(0, 500)}`);

    // Log full body for message callbacks (to debug bubble messages)
    if (fullUrl.includes("/message")) {
      console.log(`${LOG} FULL CALLBACK: ${JSON.stringify(req.body || {}).substring(0, 2000)}`);
      interceptedMessages.push({ url: fullUrl, body: req.body, time: new Date().toISOString() });
      if (interceptedMessages.length > 20) interceptedMessages.shift();
    }

    // Store raw callback data for bubble detection
    const msg = req.body?.message;
    if (msg) {
      const msgId = msg.id || "";
      const convId = msg.conversation_id || req.body?.conversation_id || "";
      if (msgId) {
        rawCallbackMap.set(msgId, {
          is_group: !!msg.is_group,
          conversation_id: convId,
          from_userId: msg.from || req.body?.from || "",
          attachment: msg.attachment || null,
        });
        // Bound the map
        if (rawCallbackMap.size > 100) {
          const first = rawCallbackMap.keys().next().value;
          rawCallbackMap.delete(first);
        }
      }
      // Store attachment per conversation so follow-up messages can find it
      if (msg.attachment && convId) {
        recentFilesByConv.set(convId, {
          attachment: msg.attachment,
          from: msg.from || req.body?.from || "",
          time: Date.now(),
        });
        console.log(`${LOG} File attachment stored for conv ${convId}: ${msg.attachment.filename}`);

        // Process file directly from callback (SDK doesn't fire rainbow_onmessagereceived for file messages in S2S)
        const fromUserId = msg.from || req.body?.from || "";
        // Skip bot's own messages
        console.log(`${LOG} File callback trigger: from=${fromUserId}, botUserId=${botUserId}, skip=${fromUserId === botUserId}`);
        if (fromUserId !== botUserId) {
          const msgCopy = JSON.parse(JSON.stringify(msg)); // deep copy before Express recycles req
          setTimeout(() => {
            processFileFromCallback(msgCopy, convId, fromUserId, !!msgCopy.is_group)
              .catch(err => console.error(`${LOG} processFileFromCallback ERROR:`, err));
          }, 2000);
        }
      }
    }
  }
  next();
});

// ── Intercepted messages log ────
const interceptedMessages = [];

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

// Debug endpoint: test file download with a given fileId
// Debug: inspect a hosted file's metadata without downloading
app.get("/api/file-info/:id", (req, res) => {
  const fileId = req.params.id.replace(/[*_`~\[\]()]+$/g, "");
  const file = hostedFiles.get(fileId);
  if (!file) return res.json({ found: false, id: fileId, hostedCount: hostedFiles.size });
  res.json({
    found: true, id: fileId,
    filename: file.filename, mime: file.mime, binary: file.binary,
    contentType: typeof file.content,
    isBuffer: Buffer.isBuffer(file.content),
    contentLength: file.content?.length || 0,
    createdAt: new Date(file.createdAt).toISOString(),
  });
});

app.get("/api/file-test/:fileId", async (req, res) => {
  const fileId = req.params.fileId;
  const fileInfo = {
    fileId,
    url: `https://openrainbow.com/api/rainbow/fileserver/v1.0/files/${fileId}`,
    mime: "text/plain",
    filename: "test",
    filesize: 0,
  };
  try {
    const result = await downloadFile(fileInfo);
    if (result) {
      res.json({ ok: true, bytes: result.buffer.length, preview: result.buffer.toString("utf-8").substring(0, 500) });
    } else {
      res.json({ ok: false, error: "all strategies failed" });
    }
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

// Debug: last file download result
app.get("/api/last-download", (req, res) => {
  res.json(lastDownloadResult || { message: "no download attempted yet" });
});

// ── Self-hosted file downloads ──────────────────────────
const hostedFiles = new Map(); // id → { filename, content, mime, createdAt }
const storedDocxFiles = new Map(); // filename → { buffer, storedAt }
const storedPdfFiles = new Map();  // filename → { buffer, storedAt }
const storedPptxFiles = new Map(); // filename → { buffer, storedAt }
const HOSTED_FILE_TTL = 24 * 60 * 60 * 1000; // 24 hours

app.get("/files/:id", async (req, res) => {
  try {
    // Strip trailing markdown chars (**,_,`) that may leak into URLs from chat formatting
    const fileId = req.params.id.replace(/[*_`~\[\]()]+$/g, "");
    console.log(`${LOG} File download request: ${fileId}`);
    let file = hostedFiles.get(fileId);
    // Fall back to Redis if not in memory (survives redeployments)
    if (!file && redis) {
      try {
        const data = await redis.get(`file:${fileId}`);
        if (data) {
          const parsed = JSON.parse(data);
          if (parsed.binary && parsed.content) parsed.content = Buffer.from(parsed.content, "base64");
          hostedFiles.set(fileId, parsed); // re-cache in memory
          file = parsed;
          console.log(`${LOG} File loaded from Redis: ${fileId} (${parsed.filename})`);
        }
      } catch (err) { console.warn(`${LOG} Redis file fetch error:`, err.message); }
    }
    if (!file) {
      console.warn(`${LOG} File not found: ${fileId}`);
      return res.status(404).send("File not found or expired");
    }
    const buf = file.binary ? file.content : Buffer.from(file.content, "utf-8");
    console.log(`${LOG} Serving file: ${file.filename} (${buf.length} bytes, mime=${file.mime})`);
    res.setHeader("Content-Type", file.mime || "application/octet-stream");
    res.setHeader("Content-Length", buf.length);
    // Sanitize filename for Content-Disposition header (no special chars)
    const safeFilename = file.filename.replace(/[^\w.\-]/g, "_");
    res.setHeader("Content-Disposition", `attachment; filename="${safeFilename}"`);
    res.end(buf);
  } catch (err) {
    console.error(`${LOG} File serve error:`, err);
    if (!res.headersSent) res.status(500).send(`File serve error: ${err.message}`);
  }
});

function hostFile(filename, content, binary = false) {
  const id = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  const mime = guessMime(filename);
  const entry = { filename, content, mime, createdAt: Date.now(), binary };
  hostedFiles.set(id, entry);
  // Persist to Redis so files survive redeployments
  if (redis) {
    const toStore = { ...entry };
    if (binary && Buffer.isBuffer(content)) toStore.content = content.toString("base64");
    redis.set(`file:${id}`, JSON.stringify(toStore), { EX: 24 * 3600 }).catch(err =>
      console.warn(`${LOG} Redis file persist error:`, err.message)
    );
  }
  // Cleanup expired files from memory
  for (const [fid, f] of hostedFiles) {
    if (Date.now() - f.createdAt > HOSTED_FILE_TTL) hostedFiles.delete(fid);
  }
  const baseUrl = config.hostCallback || `http://localhost:${PORT}`;
  return `${baseUrl}/files/${id}`;
}

/**
 * Detect external file URLs in AI response, download them, re-host locally.
 * Handles: tmpfiles.org, workspace paths, and other external URLs.
 */
async function rewriteFileUrls(text) {
  // Match URLs to common file hosting services
  // Match external file URLs — also catch tmpfiles.org non-/dl/ URLs (they redirect to /dl/)
  const urlRegex = /https?:\/\/(?:tmpfiles\.org\/\S+|transfer\.sh\/\S+|file\.io\/\S+|0x0\.st\/\S+)[^\s*)\]>]*/gi;
  let matches = text.match(urlRegex);
  if (!matches || matches.length === 0) return text;
  // Clean trailing markdown/punctuation from URLs
  matches = matches.map(u => u.replace(/[*_`~\[\]()]+$/g, ""));

  let result = text;
  for (const originalUrl of matches) {
    try {
      console.log(`${LOG} Downloading external file: ${originalUrl}`);
      const resp = await fetch(originalUrl, { redirect: "follow" });
      if (!resp.ok) {
        console.warn(`${LOG} External file download failed (${resp.status}): ${originalUrl}`);
        continue;
      }
      const buf = Buffer.from(await resp.arrayBuffer());
      // Extract filename from URL or Content-Disposition
      const disp = resp.headers.get("content-disposition") || "";
      let filename = disp.match(/filename="?([^";\n]+)"?/)?.[1]
        || originalUrl.split("/").pop().split("?")[0]
        || "download.bin";
      // Clean filename
      filename = filename.replace(/[^\w.\-]/g, "_");

      const localUrl = hostFile(filename, buf, true);
      result = result.replace(originalUrl, localUrl);
      console.log(`${LOG} Re-hosted: ${originalUrl} -> ${localUrl} (${filename}, ${buf.length} bytes)`);
    } catch (err) {
      console.warn(`${LOG} Failed to re-host ${originalUrl}:`, err.message);
    }
  }

  // Also replace workspace paths with a note
  result = result.replace(/\/?\.openclaw\/workspace\/[\w.\-/]+/g, (path) => {
    console.log(`${LOG} Stripped workspace path: ${path}`);
    return "(file created — see download link above)";
  });

  return result;
}

// JSON API (for programmatic access)
app.get("/api/status", (req, res) => {
  const bubbles = [];
  for (const [id, b] of bubbleList) {
    bubbles.push({ id, name: b.name, jid: b.jid, members: (b.users || []).length });
  }
  res.json({ status: botPaused ? "paused" : "running", uptime: Math.floor((Date.now() - stats.startedAt) / 1000), stats, s2sConnectionId: s2sConnectionId || null, m365: { configured: !!(m365Auth && m365Auth.isConfigured()) }, gmail: { configured: !!(gmailAuth && gmailAuth.isConfigured()) }, calendar: { outlookReady: !!(m365Auth && calendarGraph), googleReady: !!(gmailAuth && calendarGoogle) }, salesforce: { configured: !!(sfAuth && sfAuth.isConfigured()) }, sharepoint: { ready: !!(m365Auth && spApi) }, briefing: { ready: !!briefing }, enterprise: { enabled: !!(enterprise && enterprise.isEnterpriseMode()), loaded: !!enterprise }, bubbles, lastMessages: debugMessages.slice(-5) });
});

// Agent status
app.get("/api/agent-status", (req, res) => {
  res.json({
    loaded: !!agent,
    available: agent ? agent.isAvailable() : false,
    hasApiKey: !!process.env.ANTHROPIC_API_KEY,
    apiKeyLength: (process.env.ANTHROPIC_API_KEY || "").length,
  });
});

// Agent test — actually runs the agent with a test message
app.get("/api/agent-test", async (req, res) => {
  if (!agent || !agent.isAvailable()) return res.json({ error: "Agent not available" });
  const msg = req.query.q || "hello";
  const userId = req.query.uid || "test";
  try {
    const result = await agent.run(userId, msg, []);
    res.json({ result, trace: agent.getLastRunTrace() });
  } catch (e) {
    res.json({ error: e.message, trace: agent.getLastRunTrace() });
  }
});

// Last message debug — shows what the handler saw
let lastMessageDebug = {};

// Agent debug endpoint
app.get("/api/agent-debug", (req, res) => {
  res.json({
    agentTrace: agent ? agent.getLastRunTrace() : null,
    lastMessage: lastMessageDebug,
  });
});

// Sales alert test endpoint
app.get("/api/sales-alert-test", async (req, res) => {
  const uid = req.query.uid;
  if (!uid) return res.json({ error: "Missing uid parameter" });
  if (!salesScheduler || !salesScheduler.triggerDailyDigest) return res.json({ error: "Scheduler not available" });
  const result = await salesScheduler.triggerDailyDigest(uid);
  res.json(result);
});

// Email digest test endpoint
app.get("/api/email-digest-test", async (req, res) => {
  const uid = req.query.uid;
  if (!uid) return res.json({ error: "Missing uid parameter" });
  if (!emailScheduler || !emailScheduler.triggerEmailDigest) return res.json({ error: "Email scheduler not available" });
  const result = await emailScheduler.triggerEmailDigest(uid);
  res.json(result);
});

// Salesforce auth debug endpoint
app.get("/api/sf-debug", async (req, res) => {
  if (!sfAuth) return res.json({ error: "sfAuth module not loaded" });
  const info = {
    configured: sfAuth.isConfigured(),
    sharedMode: sfAuth.isSharedMode ? sfAuth.isSharedMode() : "N/A",
  };
  try {
    const token = await sfAuth.getValidToken("debug-test");
    info.tokenObtained = !!token;
    info.instanceUrl = token?.instanceUrl || null;
    info.email = token?.email || null;
    if (token?.token) info.tokenLength = token.token.length;
  } catch (e) {
    info.tokenError = e.message;
  }
  if (sfAuth.getLastError) info.lastError = sfAuth.getLastError();
  info.loginUrl = process.env.SF_LOGIN_URL || process.env.SALESFORCE_LOGIN_URL || "(default)";
  info.clientIdSet = !!(process.env.SF_CLIENT_ID || process.env.SALESFORCE_CLIENT_ID);
  info.clientSecretSet = !!(process.env.SF_CLIENT_SECRET || process.env.SALESFORCE_CLIENT_SECRET);
  res.json(info);
});

// Register M365 OAuth routes
if (m365Auth && m365Auth.isConfigured()) {
  m365Auth.registerRoutes(app, async (result) => {
    // Called when a user successfully links their Microsoft account
    // Send confirmation back to the user in Rainbow
    console.log(`${LOG} M365 link complete: ${result.rainbowUserId} → ${result.email}`);
    // We'll send the confirmation when we can resolve the user's conversation
    // Store the link result so the next message from this user triggers a confirmation
    if (redis) {
      await redis.set(`oauth:linked_pending:${result.rainbowUserId}`, JSON.stringify({
        email: result.email,
        linkedAt: Date.now(),
      }), { EX: 3600 }).catch(() => {});
    }
    // Auto-subscribe to email notifications
    if (emailWebhook) {
      const tokenResult = await m365Auth.getValidToken(result.rainbowUserId);
      if (tokenResult) {
        emailWebhook.onAccountLinked(result.rainbowUserId, tokenResult.token).catch(err => {
          console.warn(`${LOG} Email webhook auto-subscribe failed:`, err.message);
        });
      }
    }
  });
  console.log(`${LOG} M365 integration: ENABLED (client_id=${process.env.M365_CLIENT_ID?.substring(0, 8)}...)`);
} else {
  console.log(`${LOG} M365 integration: DISABLED (M365_CLIENT_ID/SECRET/REDIRECT_URI not set)`);
}

// Register Gmail OAuth routes
if (gmailAuth && gmailAuth.isConfigured()) {
  gmailAuth.registerRoutes(app, async (result) => {
    console.log(`${LOG} Gmail link complete: ${result.rainbowUserId} → ${result.email}`);
    if (redis) {
      await redis.set(`gmail:linked_pending:${result.rainbowUserId}`, JSON.stringify({
        email: result.email,
        linkedAt: Date.now(),
      }), { EX: 3600 }).catch(() => {});
    }
  });
  console.log(`${LOG} Gmail integration: ENABLED (client_id=${process.env.GMAIL_CLIENT_ID?.substring(0, 8)}...)`);
} else {
  console.log(`${LOG} Gmail integration: DISABLED (GMAIL_CLIENT_ID/SECRET/REDIRECT_URI not set)`);
}

// Register Salesforce OAuth routes
if (sfAuth && sfAuth.isConfigured()) {
  sfAuth.registerRoutes(app, async (result) => {
    console.log(`${LOG} Salesforce link complete: ${result.rainbowUserId} → ${result.email}`);
    if (redis) {
      await redis.set(`sf:linked_pending:${result.rainbowUserId}`, JSON.stringify({
        email: result.email,
        linkedAt: Date.now(),
      }), { EX: 3600 }).catch(() => {});
    }
  });
  console.log(`${LOG} Salesforce integration: ENABLED (client_id=${process.env.SALESFORCE_CLIENT_ID?.substring(0, 8)}...)`);
} else {
  console.log(`${LOG} Salesforce integration: DISABLED (SALESFORCE_CLIENT_ID/SECRET/REDIRECT_URI not set)`);
}

// Register Enterprise deployment routes
if (enterprise) {
  enterprise.registerRoutes(app, {
    sendInviteEmail: async (user, activateUrl) => {
      // Try to send via Microsoft Graph using tenant admin token
      try {
        const tenantCfg = await enterprise.getTenantConfig();
        if (!tenantCfg || !tenantCfg.adminRainbowJid) return false;
        const adminToken = m365Auth ? await m365Auth.getValidToken(tenantCfg.adminRainbowJid) : null;
        if (!adminToken) return false;

        const graph = require("./graph");
        const sent = await graph.sendEmail(adminToken, {
          to: user.email,
          subject: "Your AI Assistant is Ready",
          body: `Hello ${user.firstName},\n\nYour AI assistant has been set up and is ready for you.\n\nClick the link below to activate your account (takes about 60 seconds):\n\n${activateUrl}\n\nThis link expires in 48 hours.\n\nOnce activated, open Rainbow and start chatting with the bot!\n\nBest regards,\nAI Assistant Admin`,
          importance: "high",
        });
        if (sent) console.log(`${LOG} Invite email sent to ${user.email}`);
        return sent;
      } catch (e) {
        console.warn(`${LOG} Could not send invite email:`, e.message);
        return false;
      }
    },
  });
  console.log(`${LOG} Enterprise portal: ${process.env.ADMIN_PASSWORD ? "ENABLED" : "DISABLED (ADMIN_PASSWORD not set)"}`);
}

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

    // Try multiple paths for S2S connection ID
    // Path 1: SDK S2S service (used by aleweb reference)
    s2sConnectionId = sdk._core?._s2s?._connectionId
      || sdk._core?.s2s?.connectionId
      || sdk.s2s?._connectionId
      || sdk.s2s?.connectionId
      || null;

    // Path 2: REST connectionS2SInfo (fallback)
    if (!s2sConnectionId) {
      const cnxInfo = sdk._core?._rest?.connectionS2SInfo;
      s2sConnectionId = cnxInfo?.id || cnxInfo?._id || null;
    }

    console.log(`${LOG} S2S info: cnxId=${s2sConnectionId || "NOT FOUND"}, token=${authToken ? "OK" : "NOT FOUND"}, host=${rainbowHost}`);

    // Log all possible paths for debugging
    const paths = {
      "_core._s2s._connectionId": sdk._core?._s2s?._connectionId,
      "_core.s2s.connectionId": sdk._core?.s2s?.connectionId,
      "s2s._connectionId": sdk.s2s?._connectionId,
      "s2s.connectionId": sdk.s2s?.connectionId,
      "connectionS2SInfo.id": sdk._core?._rest?.connectionS2SInfo?.id,
    };
    console.log(`${LOG} S2S ID paths: ${JSON.stringify(paths)}`);
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

    // Enterprise access control
    if (enterprise && enterprise.isEnterpriseMode()) {
      try {
        let bubbleEmail = body.from_email || "";
        if (!bubbleEmail && fromJid && fromJid.includes("@")) {
          const jidLocal = fromJid.split("@")[0];
          const lastUnderscore = jidLocal.lastIndexOf("_");
          if (lastUnderscore > 0) {
            bubbleEmail = jidLocal.substring(0, lastUnderscore) + "@" + jidLocal.substring(lastUnderscore + 1);
          }
        }
        // Fallback: look up contact by user ID via SDK
        const bubbleFromId = body.message?.from || "";
        if (!bubbleEmail && bubbleFromId && sdk) {
          try {
            const contact = await sdk.contacts.getContactById(bubbleFromId);
            bubbleEmail = contact?.loginEmail || contact?.email || "";
          } catch (e2) { /* ignore */ }
        }
        console.log(`${LOG} Enterprise check (bubble): jid=${fromJid} email=${bubbleEmail}`);
        const access = await enterprise.checkAccess(fromJid, bubbleEmail);
        if (!access.allowed) {
          console.log(`${LOG} Access denied (bubble): ${fromJid} (${bubbleEmail})`);
          // Send feedback to the user instead of silently dropping
          if (body.conversation_id && s2sConnectionId && authToken) {
            const host = rainbowHost || "openrainbow.com";
            fetch(`https://${host}/api/rainbow/ucs/v1.0/connections/${s2sConnectionId}/conversations/${body.conversation_id}/messages`, {
              method: "POST",
              headers: { "Authorization": `Bearer ${authToken}`, "Content-Type": "application/json" },
              body: JSON.stringify({ message: { body: "Sorry, your account is not active. Please contact your administrator for access.", lang: "en" } }),
            }).catch(() => {});
          }
          return;
        }
      } catch (e) {
        console.error(`${LOG} Enterprise check ERROR (bubble, allowing):`, e.message);
      }
    }

    // Check for bot trigger
    const contentLower = content.toLowerCase();
    const botName = (sdk?.connectedUser?.displayName || "").toLowerCase();
    const botFirstName = (sdk?.connectedUser?.firstName || "").toLowerCase();
    const hasBotTrigger = (botName && contentLower.includes(botName))
      || (botFirstName && botFirstName.length > 2 && contentLower.includes(botFirstName))
      || contentLower.includes("juju")
      || contentLower.includes("@ai")
      || contentLower.startsWith("bot:")
      || contentLower.startsWith("bot :");

    if (!hasBotTrigger) {
      console.log(`${LOG} Bubble message ignored (no bot trigger): ${content.substring(0, 50)}`);
      return;
    }

    // "juju secure" / "juju unsecure" — intercept before LLM
    if (pii && (contentLower.trim() === "juju secure" || contentLower.trim() === "juju unsecure")) {
      const enabling = contentLower.trim() === "juju secure";
      const histKey = `bubble:${body.conversation_id || roomJid}`;
      await pii.setSecureMode(histKey, enabling);
      const confirmMsg = enabling
        ? "🔒 **Secure mode ON** — PII will be anonymized before reaching the AI. Send \"juju unsecure\" to turn it off."
        : "🔓 **Secure mode OFF** — normal processing resumed.";
      // Send confirmation via bubble
      const bbl = roomJid ? bubbleByJid.get(roomJid) : null;
      if (bbl) {
        await sendMessageToBubble(bbl, confirmMsg);
      } else if (body.conversation_id && s2sConnectionId && authToken) {
        const host = rainbowHost || "openrainbow.com";
        await fetch(`https://${host}/api/rainbow/ucs/v1.0/connections/${s2sConnectionId}/conversations/${body.conversation_id}/messages`, {
          method: "POST",
          headers: { "Authorization": `Bearer ${authToken}`, "Content-Type": "application/json" },
          body: JSON.stringify({ message: { body: confirmMsg, lang: "en" } }),
        }).catch(e => console.warn(`${LOG} Failed to send secure-mode confirmation:`, e.message));
      }
      console.log(`${LOG} Secure mode ${enabling ? "ON" : "OFF"} for ${histKey} (bubble-intercept)`);
      return;
    }

    // "jojo connect/disconnect email/outlook/gmail/salesforce" — account linking
    const emailConnectMatch = contentLower.trim().match(/^juju\s+(connect|disconnect)\s+(email|outlook|gmail|salesforce)$/i);
    if (emailConnectMatch) {
      const isConnect = emailConnectMatch[1].toLowerCase() === "connect";
      const target = emailConnectMatch[2].toLowerCase(); // email, outlook, or gmail
      const sendReply = async (msg) => {
        const bbl = roomJid ? bubbleByJid.get(roomJid) : null;
        if (bbl) await sendMessageToBubble(bbl, msg).catch(() => {});
        else if (body.conversation_id && s2sConnectionId && authToken) {
          const host = rainbowHost || "openrainbow.com";
          await fetch(`https://${host}/api/rainbow/ucs/v1.0/connections/${s2sConnectionId}/conversations/${body.conversation_id}/messages`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${authToken}`, "Content-Type": "application/json" },
            body: JSON.stringify({ message: { body: msg, lang: "en" } }),
          }).catch(() => {});
        }
      };

      // Determine which provider to use
      const useGmail = target === "gmail" || (target === "email" && gmailAuth && gmailAuth.isConfigured() && !(m365Auth && m365Auth.isConfigured()));
      const useM365 = target === "outlook" || target === "email" && !useGmail;

      if (useGmail && gmailAuth && gmailAuth.isConfigured()) {
        if (isConnect) {
          const already = await gmailAuth.isLinked(fromJid);
          if (already) {
            const email = await gmailAuth.getLinkedEmail(fromJid);
            await sendReply(`Your Gmail is already connected (${email}). Send "juju disconnect gmail" first to reconnect.`);
          } else {
            const authUrl = await gmailAuth.getAuthUrl(fromJid, { conversationId: body.conversation_id, roomJid, isBubble: true });
            await sendReply(`Click this link to connect your Gmail:\n\n${authUrl}\n\n(Link expires in 10 minutes)`);
          }
        } else {
          const linked = await gmailAuth.isLinked(fromJid);
          if (!linked) {
            await sendReply(`Your Gmail is not connected. Send "juju connect gmail" to link it.`);
          } else {
            await gmailAuth.unlinkAccount(fromJid);
            await sendReply(`Gmail disconnected. Your tokens have been deleted.`);
          }
        }
        return;
      } else if (useM365 && m365Auth && m365Auth.isConfigured()) {
        if (isConnect) {
          const already = await m365Auth.isLinked(fromJid);
          if (already) {
            const email = await m365Auth.getLinkedEmail(fromJid);
            await sendReply(`Your Outlook is already connected (${email}). Send "juju disconnect outlook" first to reconnect.`);
          } else {
            const authUrl = await m365Auth.getAuthUrl(fromJid, { conversationId: body.conversation_id, roomJid, isBubble: true });
            await sendReply(`Click this link to connect your Outlook:\n\n${authUrl}\n\n(Link expires in 10 minutes)`);
          }
        } else {
          const linked = await m365Auth.isLinked(fromJid);
          if (!linked) {
            await sendReply(`Your Outlook is not connected. Send "juju connect outlook" to link it.`);
          } else {
            await m365Auth.unlinkAccount(fromJid);
            await sendReply(`Outlook disconnected. Your tokens have been deleted.`);
          }
        }
        return;
      } else if (target === "salesforce" && sfAuth && sfAuth.isConfigured()) {
        if (sfAuth.isSharedMode && sfAuth.isSharedMode()) {
          if (isConnect) {
            await sendReply(`Salesforce is connected via shared service account. No individual connection needed.`);
          } else {
            sfAuth.unlinkAccount(fromJid); // clears cached token
            await sendReply(`Salesforce token cache cleared. Will re-authenticate on next request.`);
          }
          return;
        }
        if (isConnect) {
          const already = await sfAuth.isLinked(fromJid);
          if (already) {
            const email = await sfAuth.getLinkedEmail(fromJid);
            await sendReply(`Your Salesforce is already connected (${email}). Send "juju disconnect salesforce" first to reconnect.`);
          } else {
            const authUrl = await sfAuth.getAuthUrl(fromJid, { conversationId: body.conversation_id, roomJid, isBubble: true });
            await sendReply(`Click this link to connect your Salesforce:\n\n${authUrl}\n\n(Link expires in 10 minutes)`);
          }
        } else {
          const linked = await sfAuth.isLinked(fromJid);
          if (!linked) {
            await sendReply(`Your Salesforce is not connected. Send "juju connect salesforce" to link it.`);
          } else {
            await sfAuth.unlinkAccount(fromJid);
            await sendReply(`Salesforce disconnected. Your tokens have been deleted.`);
          }
        }
        return;
      } else {
        await sendReply(`${target === "gmail" ? "Gmail" : target === "outlook" ? "Outlook" : target === "salesforce" ? "Salesforce" : "Email"} integration is not configured.`);
        return;
      }
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

    // Intent-driven processing (same as main handler)
    let intent = detectIntent(content);
    if (!intent) intent = { type: "chat" };
    console.log(`${LOG} [BUBBLE-INTERCEPT] Intent: ${intent.type}`);

    // Send short confirmation before starting the task
    const confirmation = describeIntent(intent);
    if (confirmation && bubble) {
      sendMessageToBubble(bubble, confirmation).catch(() => {});
    }

    let responseText = null;

    if (intent.type === "agent" && agent) {
      const history = await getHistory(fromJid);
      responseText = await Promise.race([
        agent.run(fromJid, content, history),
        new Promise(r => setTimeout(() => r("Sorry, the request timed out. Please try again."), 120000)),
      ]);
    } else if (intent.type === "translate_docx") {
      responseText = await handleDocxTranslation(fromJid, content, intent.language, intent.docxKey);
    } else if (intent.type === "translate_pdf") {
      responseText = await handlePdfTranslation(fromJid, content, intent.language, intent.fileKey);
    } else if (intent.type === "translate_pptx") {
      responseText = await handlePptxTranslation(fromJid, content, intent.language, intent.fileKey);
    } else if (intent.type === "translate_any") {
      responseText = await handleAnyTranslation(fromJid, content, intent.language);
    } else if (intent.type.startsWith("anonymize_")) {
      responseText = await handleAnonymizeDocument(fromJid, intent.type, intent.fileKey);
    } else if (intent.type === "create_file") {
      responseText = await handleCreateFile(fromJid, content, intent.format);
    } else if (intent.type.startsWith("email_") && emailIntents) {
      responseText = await emailIntents.handleEmailIntent(fromJid, intent, content);
    } else if (intent.type.startsWith("calendar_") && calendarIntents) {
      responseText = await calendarIntents.handleCalendarIntent(fromJid, intent, content);
    } else if (intent.type.startsWith("sf_") && sfIntents) {
      responseText = await sfIntents.handleSalesforceIntent(fromJid, intent, content);
    } else if (intent.type.startsWith("sp_") && spIntents) {
      responseText = await spIntents.handleSharePointIntent(fromJid, intent, content);
    } else if (intent.type.startsWith("briefing_") && briefing) {
      responseText = await briefing.handleBriefingIntent(fromJid, intent, content);
    }

    if (!responseText) {
      // Check for pending calendar confirmations (yes/no answers)
      if (calendarIntents) {
        const pendingResult = await calendarIntents.checkPendingAction(fromJid, content);
        if (pendingResult) {
          if (typeof pendingResult === "string") {
            responseText = pendingResult;
          } else {
            responseText = await calendarIntents.handleCalendarIntent(fromJid, pendingResult, content);
          }
        }
      }
    }

    // If an intent handler produced a response, add to history for context
    if (responseText) {
      const bubbleHistKey = `bubble:${body.conversation_id || roomJid}`;
      await addMessage(bubbleHistKey, "user", content);
      await addMessage(bubbleHistKey, "assistant", responseText);
    }

    if (!responseText) {
      const result = await callOpenClaw(fromJid, content);
      responseText = result?.content || config.fallbackMsg;
    }

    // Host any [FILE:] markers as downloadable links
    responseText = responseText.replace(/\[FILE:([^\]]+)\]\n?([\s\S]*?)\[\/FILE\]/g, (_, fname, fcontent) => {
      const url = hostFile(fname.trim(), fcontent);
      console.log(`${LOG} File hosted: ${fname.trim()} -> ${url}`);
      return `📎 **${fname.trim()}**: ${url}`;
    });

    // Re-host any external file URLs (tmpfiles.org, etc.) on our server
    responseText = await rewriteFileUrls(responseText);

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
      fileServer: { start_up: true },
      fileStorage: { start_up: true },
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

    // Cache all bubbles and join them
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
        // Join bubble as occupant (critical for receiving and sending room messages)
        try {
          await sdk.bubbles.setBubblePresence(bubble, true);
        } catch (e) {
          console.warn(`${LOG} setBubblePresence failed for "${bubble.name}":`, e.message);
        }
        // Open conversation to pre-populate convId → bubble mapping
        try {
          const conv = await sdk.conversations.openConversationForBubble(bubble);
          if (conv?.dbId && bubble.jid) {
            convIdToBubbleJid.set(conv.dbId, bubble.jid);
            console.log(`${LOG} Mapped convId ${conv.dbId} → ${bubble.name}`);
          }
        } catch {}
      }
      console.log(`${LOG} Cached ${bubbleList.size} bubbles, indexed ${bubbleByMember.size} members, mapped ${convIdToBubbleJid.size} conversations`);
    } catch (err) {
      console.warn(`${LOG} Failed to cache bubbles:`, err.message);
    }

    // Join all rooms via S2S REST API
    const joinOk = await joinAllRooms();
    console.log(`${LOG} joinAllRooms result: ${joinOk ? "OK" : "FAILED"}`);
    console.log(`${LOG} Ready — listening for bubble + 1:1 messages`);
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

      // Enterprise access control
      if (enterprise && enterprise.isEnterpriseMode()) {
        try {
          // Try multiple sources for the user's email
          let rainbowEmail = message.from?.loginEmail || message.from?.email || "";
          // Extract email from JID if needed (JID format: user_domain.com@openrainbow.com)
          if (!rainbowEmail && fromJid && fromJid.includes("@")) {
            const jidLocal = fromJid.split("@")[0];
            const lastUnderscore = jidLocal.lastIndexOf("_");
            if (lastUnderscore > 0) {
              rainbowEmail = jidLocal.substring(0, lastUnderscore) + "@" + jidLocal.substring(lastUnderscore + 1);
            }
          }
          // Fallback: look up contact by user ID via SDK to get loginEmail
          // fromId may be empty in S2S — try raw callback's from_userId
          const rawCbEnt = msgId ? rawCallbackMap.get(msgId) : null;
          const resolvedFromId = fromId || rawCbEnt?.from_userId || "";
          if (!rainbowEmail && resolvedFromId && sdk) {
            try {
              const contact = await sdk.contacts.getContactById(resolvedFromId);
              rainbowEmail = contact?.loginEmail || contact?.email || "";
              if (rainbowEmail) console.log(`${LOG} Resolved email from SDK contact: ${rainbowEmail}`);
            } catch (e2) {
              console.log(`${LOG} SDK contact lookup failed for ${resolvedFromId}: ${e2.message}`);
            }
          }
          console.log(`${LOG} Enterprise check: jid=${fromJid} fromId=${resolvedFromId} email=${rainbowEmail}`);
          const access = await enterprise.checkAccess(fromJid, rainbowEmail);
          if (!access.allowed) {
            console.log(`${LOG} Access denied (1:1): ${fromJid} (${rainbowEmail})`);
            // Send feedback to the user instead of silently dropping
            if (conversationId && s2sConnectionId && authToken) {
              const host = rainbowHost || "openrainbow.com";
              fetch(`https://${host}/api/rainbow/ucs/v1.0/connections/${s2sConnectionId}/conversations/${conversationId}/messages`, {
                method: "POST",
                headers: { "Authorization": `Bearer ${authToken}`, "Content-Type": "application/json" },
                body: JSON.stringify({ message: { body: "Sorry, your account is not active. Please contact your administrator for access.", lang: "en" } }),
              }).catch(() => {});
            }
            return;
          }
          console.log(`${LOG} Access granted: ${fromJid}`);
        } catch (e) {
          console.error(`${LOG} Enterprise check ERROR (allowing):`, e.message);
          // Don't block on enterprise errors — allow the message through
        }
      }

      // Detect if this is a bubble (group) message
      const conv = message.conversation || {};

      // Primary: check raw callback is_group flag (most reliable in S2S mode)
      const rawCb = msgId ? rawCallbackMap.get(msgId) : null;

      // Detect and download attached files
      const rawConvId = rawCb?.conversation_id || conversationId || "";
      const fileInfo = extractFileInfo(message, rawCb, rawConvId);
      let fileContext = "";
      console.log(`${LOG} File check: oob=${!!message.oob}, rawAttach=${!!rawCb?.attachment}, convFile=${!!recentFilesByConv.get(rawConvId)}, result=${!!fileInfo}`);
      if (fileInfo) {
        // Mark as processed so callback handler doesn't double-process
        const fileKey = `${msgId}:${fileInfo.url}`;
        processedFileIds.add(fileKey);
        console.log(`${LOG} File detected (SDK event): ${fileInfo.filename} (${fileInfo.mime}, ${fileInfo.filesize} bytes)`);
        let downloaded = null;
        try {
          downloaded = await Promise.race([
            downloadFile(fileInfo),
            new Promise(r => setTimeout(() => r(null), 30000)), // 30s download timeout
          ]);
        } catch (e) { console.warn(`${LOG} File download failed:`, e.message); }
        fileContext = await describeFileForAI(fileInfo, downloaded);
        console.log(`${LOG} File context: ${fileContext.substring(0, 200)}`);

        // Store file context in conversation history so follow-up messages can reference it
        const fHistoryKey = (rawCb?.is_group && (rawCb?.conversation_id || ""))
          ? `bubble:${rawCb.conversation_id}` : fromJid;

        // PII secure mode: anonymize file content before storing in history
        if (pii && await pii.isSecureMode(fHistoryKey)) {
          const { anonymizedText, mapping } = await pii.anonymize(fileContext);
          await pii.storePiiMapping(fHistoryKey, mapping);
          fileContext = anonymizedText;
          console.log(`${LOG} [PII] File content anonymized for ${fHistoryKey}`);
        }

        await addMessage(fHistoryKey, "user", `[${fromName} shared a file]\n${fileContext}`);

        // Write file context to unified store
        if (contextManager) {
          contextManager.addEntry(fHistoryKey, "system", `File shared: ${fileInfo.filename}. ${fileContext.substring(0, 500)}`, {
            path: "file_upload",
            filesReferenced: [fileInfo.filename],
          }).catch(() => {});
        }

        // Detect alert config file (JSON with alert keys)
        if (salesScheduler && fileInfo.filename.toLowerCase().endsWith(".json")) {
          let jsonText = null;
          if (downloaded && downloaded.buffer) {
            jsonText = downloaded.buffer.toString("utf-8");
          } else if (fileContext) {
            // Extract JSON from fileContext (describeFileForAI wraps in code blocks)
            const jsonMatch = fileContext.match(/```\n([\s\S]*?)\n```/);
            if (jsonMatch) jsonText = jsonMatch[1];
          }
          if (jsonText) {
            try {
              const parsed = JSON.parse(jsonText);
              if (parsed.daily_digest || parsed.weekly_summary || parsed.stale_deal_alert || parsed.close_date_alert || parsed.high_value_alert) {
                const result = await salesScheduler.applyConfigFile(fromJid, parsed);
                const configMsg = result.success
                  ? `Alert configuration applied (${result.timezone}):\n${result.alerts.map(a => `- ${a}`).join("\n")}`
                  : `Failed to apply config: ${result.error}`;
                const cfgConvId = rawCb?.conversation_id || conversationId;
                console.log(`${LOG} Alert config detected in ${fileInfo.filename} for ${fromJid}`);
                fileContext = configMsg;
                console.log(`${LOG} Alert config result: ${fileContext.substring(0, 200)}`);
              }
              // Email digest config
              if (parsed.email_digest && emailScheduler && emailScheduler.applyConfigFile) {
                const emailResult = await emailScheduler.applyConfigFile(fromJid, parsed);
                const emailMsg = emailResult.success
                  ? `Email digest configured: ${emailResult.alerts?.join(", ") || "enabled"}`
                  : `Email digest config failed: ${emailResult.error}`;
                fileContext = fileContext ? `${fileContext}\n\n${emailMsg}` : emailMsg;
                console.log(`${LOG} Email digest config applied for ${fromJid}`);
              }
            } catch (e) {
              console.warn(`${LOG} Config parse error:`, e.message);
            }
          }
        }

        // Send confirmation to user — fileContext may have been replaced by config result
        const isAlertConfig = fileContext && (fileContext.startsWith("Alert configuration") || fileContext.startsWith("Email digest"));
        const fileSize = fileInfo.filesize ? ` (${Math.round(fileInfo.filesize / 1024)}KB)` : "";
        const confirmMsg = isAlertConfig
          ? fileContext
          : downloaded
            ? `📎 **${fileInfo.filename}**${fileSize} received and ready.\n\nYou can now ask me to:\n- Translate it\n- Summarize it\n- Anonymize it\n- Or ask any question about its content`
            : `📎 I see **${fileInfo.filename}** was shared, but I couldn't download it. Try sending a text file (.txt, .csv, .json) or paste the content directly.`;

        // Send confirmation via S2S REST + SDK fallback + direct REST
        const confirmConvId = rawCb?.conversation_id || conversationId;
        let confirmSent = false;
        console.log(`${LOG} Sending file confirmation: confirmConvId=${confirmConvId}, s2s=${!!s2sConnectionId}`);

        // Method 1: S2S REST
        if (confirmConvId && s2sConnectionId && authToken) {
          try {
            const host = rainbowHost || "openrainbow.com";
            const resp = await fetch(`https://${host}/api/rainbow/ucs/v1.0/connections/${s2sConnectionId}/conversations/${confirmConvId}/messages`, {
              method: "POST",
              headers: { "Authorization": `Bearer ${authToken}`, "Content-Type": "application/json" },
              body: JSON.stringify({ message: { body: confirmMsg, lang: "en" } }),
            });
            confirmSent = resp.ok;
            console.log(`${LOG} File confirm REST: ${resp.ok ? "OK" : resp.status}`);
          } catch (e) {
            console.warn(`${LOG} S2S file confirmation failed:`, e.message);
          }
        }
        // Method 2: SDK — find contact and send via conversation
        if (!confirmSent) {
          try {
            // Try by JID first, then by user ID from raw callback
            const rawFromId = rawCb?.from_userId || "";
            let contact = null;
            if (fromJid) try { contact = await sdk.contacts.getContactByJid(fromJid); } catch {}
            if (!contact && rawFromId) try { contact = await sdk.contacts.getContactById(rawFromId); } catch {}
            if (contact) {
              const fileConv = await sdk.conversations.openConversationForContact(contact);
              if (fileConv) {
                await sdk.im.sendMessageToConversation(fileConv, confirmMsg);
                confirmSent = true;
                console.log(`${LOG} File confirm SDK contact: OK`);
              }
            }
          } catch (e) {
            console.warn(`${LOG} SDK file confirmation failed:`, e.message);
          }
        }
        // Method 3: SDK s2s with conversation dbId
        if (!confirmSent && conversation?.dbId && sdk.s2s) {
          try {
            await sdk.s2s.sendMessageInConversation(conversation.dbId, { message: { body: confirmMsg, lang: "en" } });
            confirmSent = true;
            console.log(`${LOG} File confirm S2S dbId: OK`);
          } catch (e) {
            console.warn(`${LOG} S2S SDK file confirmation failed:`, e.message);
          }
        }
        if (!confirmSent) console.warn(`${LOG} Could not send file confirmation to ${fromJid} (convId=${confirmConvId}, rawFrom=${rawCb?.from_userId})`);

        // File received — just acknowledge, don't call AI until user asks
        console.log(`${LOG} File stored in history for ${fHistoryKey}, awaiting user question`);
        return;
      }

      // Skip messages with no content
      if (!content || !content.trim()) return;
      let isBubble = !!(rawCb?.is_group)
        || !!(message.fromBubbleJid || message.fromBubbleId)
        || (conv.type === 1) || !!(conv.bubble && conv.bubble.id)
        || !!(conv.id && String(conv.id).includes("room_"));
      let rawConversationId = rawCb?.conversation_id || "";

      // Check if message contains bot trigger keywords
      const contentLower = content.toLowerCase();
      const botName = (sdk.connectedUser?.displayName || "").toLowerCase();
      const botFirstName = (sdk.connectedUser?.firstName || "").toLowerCase();
      const hasBotTrigger = (botName && contentLower.includes(botName))
        || (botFirstName && botFirstName.length > 2 && contentLower.includes(botFirstName))
        || contentLower.includes("juju")
        || contentLower.includes("@ai")
        || contentLower.startsWith("bot ")
        || contentLower.startsWith("bot:")
        || contentLower.startsWith("bot :");

      // Find the actual bubble for this message
      let targetBubble = null;
      if (isBubble) {
        // Try SDK fields first
        targetBubble = (message.fromBubbleId && bubbleList.get(message.fromBubbleId))
          || (message.fromBubbleJid && bubbleByJid.get(message.fromBubbleJid))
          || null;
        // If not found, try to find by conversation_id → bubble mapping
        if (!targetBubble && rawConversationId) {
          const bubbleJid = convIdToBubbleJid.get(rawConversationId);
          if (bubbleJid) targetBubble = bubbleByJid.get(bubbleJid);
        }
        console.log(`${LOG} Bubble detected: is_group=${rawCb?.is_group}, rawConvId=${rawConversationId}, targetBubble=${targetBubble?.name || "NOT FOUND"}`);
      }

      // For bubble messages: always store in history, but only reply when triggered
      // Use rawConversationId as history key so all participants share context
      const historyKey = (isBubble && rawConversationId) ? `bubble:${rawConversationId}` : fromJid;

      // Track JID → conversation_id for proactive messaging (email webhooks)
      if (!isBubble && fromJid && rawConversationId) {
        conversationByJid.set(fromJid, rawConversationId);
      }

      // "sleep" command: force bot back to sleep (clear active conversation)
      if (isBubble && contentLower.trim() === "sleep") {
        activeConversations.delete(historyKey);
        console.log(`${LOG} Sleep command: bot going to sleep in ${historyKey}`);
        await addMessage(historyKey, "user", `[${fromName}]: sleep`);
        return;
      }

      // "stop" — cancel running agent request
      if (contentLower.trim() === "stop" || contentLower.trim() === "cancel" || contentLower.trim() === "juju stop") {
        if (agent && agent.cancelRequest) {
          agent.cancelRequest(fromJid);
          const stopMsg = "Stopping current request...";
          const stopConvId = rawConversationId || conversationId;
          if (stopConvId && s2sConnectionId && authToken) {
            const host = rainbowHost || "openrainbow.com";
            await fetch(`https://${host}/api/rainbow/ucs/v1.0/connections/${s2sConnectionId}/conversations/${stopConvId}/messages`, {
              method: "POST",
              headers: { "Authorization": `Bearer ${authToken}`, "Content-Type": "application/json" },
              body: JSON.stringify({ message: { body: stopMsg, lang: "en" } }),
            }).catch(() => {});
          }
        }
        return;
      }

      // "juju secure" / "juju unsecure" — toggle PII secure mode (intercept before LLM)
      console.log(`${LOG} CMD check: pii=${!!pii}, contentLower="${contentLower.trim()}", match=${contentLower.trim() === "juju secure" || contentLower.trim() === "juju unsecure"}`);
      const secCmd = contentLower.trim();
      if (pii && (secCmd === "juju secure" || secCmd === "juju unsecure" || secCmd === "jojo secure" || secCmd === "jojo unsecure")) {
        const enabling = secCmd === "juju secure" || secCmd === "jojo secure";
        await pii.setSecureMode(historyKey, enabling);
        const confirmMsg = enabling
          ? "🔒 **Secure mode ON** — PII will be anonymized before reaching the AI. Send \"juju unsecure\" to turn it off."
          : "🔓 **Secure mode OFF** — normal processing resumed.";
        console.log(`${LOG} Secure mode ${enabling ? "ON" : "OFF"} for ${historyKey}`);

        // Try S2S REST first (works for both bubble and 1:1 if we have a conversation ID)
        const piiConvId = rawConversationId || conversationId;
        let piiSent = false;
        if (piiConvId && s2sConnectionId && authToken) {
          try {
            const host = rainbowHost || "openrainbow.com";
            const resp = await fetch(`https://${host}/api/rainbow/ucs/v1.0/connections/${s2sConnectionId}/conversations/${piiConvId}/messages`, {
              method: "POST",
              headers: { "Authorization": `Bearer ${authToken}`, "Content-Type": "application/json" },
              body: JSON.stringify({ message: { body: confirmMsg, lang: "en" } }),
            });
            piiSent = resp.ok;
          } catch (e) { console.warn(`${LOG} S2S secure-mode confirm failed:`, e.message); }
        }
        // Fallback: resolve conversation via contact JID and use SDK
        if (!piiSent && fromJid) {
          try {
            const contact = await sdk.contacts.getContactByJid(fromJid);
            if (contact) {
              const conv = await sdk.conversations.openConversationForContact(contact);
              if (conv) {
                await sdk.im.sendMessageToConversation(conv, confirmMsg);
                piiSent = true;
              }
            }
          } catch (e) { console.warn(`${LOG} SDK secure-mode confirm failed:`, e.message); }
        }
        if (!piiSent) console.warn(`${LOG} Could not send secure-mode confirmation to ${fromJid}`);
        return;
      }

      // "jojo connect/disconnect email/outlook/gmail/salesforce" — account linking
      const emailConnectMatch2 = contentLower.trim().match(/^juju\s+(connect|disconnect)\s+(email|outlook|gmail|salesforce)$/i);
      if (emailConnectMatch2) {
        const isConnect = emailConnectMatch2[1].toLowerCase() === "connect";
        const target = emailConnectMatch2[2].toLowerCase();
        const sendReply = async (msg) => {
          const convId = rawConversationId || conversationId;
          let sent = false;
          if (convId && s2sConnectionId && authToken) {
            try {
              const host = rainbowHost || "openrainbow.com";
              const resp = await fetch(`https://${host}/api/rainbow/ucs/v1.0/connections/${s2sConnectionId}/conversations/${convId}/messages`, {
                method: "POST",
                headers: { "Authorization": `Bearer ${authToken}`, "Content-Type": "application/json" },
                body: JSON.stringify({ message: { body: msg, lang: "en" } }),
              });
              sent = resp.ok;
            } catch {}
          }
          if (!sent && fromJid) {
            try {
              const contact = await sdk.contacts.getContactByJid(fromJid);
              if (contact) {
                const conv2 = await sdk.conversations.openConversationForContact(contact);
                if (conv2) { await sdk.im.sendMessageToConversation(conv2, msg); sent = true; }
              }
            } catch {}
          }
        };

        const useGmail = target === "gmail" || (target === "email" && gmailAuth && gmailAuth.isConfigured() && !(m365Auth && m365Auth.isConfigured()));
        const useM365 = target === "outlook" || (target === "email" && !useGmail);

        if (useGmail && gmailAuth && gmailAuth.isConfigured()) {
          if (isConnect) {
            const already = await gmailAuth.isLinked(fromJid);
            if (already) {
              const email = await gmailAuth.getLinkedEmail(fromJid);
              await sendReply(`Your Gmail is already connected (${email}). Send "juju disconnect gmail" first to reconnect.`);
            } else {
              const authUrl = await gmailAuth.getAuthUrl(fromJid, { conversationId: rawConversationId || conversationId, isBubble });
              await sendReply(`Click this link to connect your Gmail:\n\n${authUrl}\n\n(Link expires in 10 minutes)`);
            }
          } else {
            const linked = await gmailAuth.isLinked(fromJid);
            if (!linked) {
              await sendReply(`Your Gmail is not connected. Send "juju connect gmail" to link it.`);
            } else {
              await gmailAuth.unlinkAccount(fromJid);
              await sendReply(`Gmail disconnected. Your tokens have been deleted.`);
            }
          }
          return;
        } else if (useM365 && m365Auth && m365Auth.isConfigured()) {
          if (isConnect) {
            const already = await m365Auth.isLinked(fromJid);
            if (already) {
              const email = await m365Auth.getLinkedEmail(fromJid);
              await sendReply(`Your Outlook is already connected (${email}). Send "juju disconnect outlook" first to reconnect.`);
            } else {
              const authUrl = await m365Auth.getAuthUrl(fromJid, { conversationId: rawConversationId || conversationId, isBubble });
              await sendReply(`Click this link to connect your Outlook:\n\n${authUrl}\n\n(Link expires in 10 minutes)`);
            }
          } else {
            const linked = await m365Auth.isLinked(fromJid);
            if (!linked) {
              await sendReply(`Your Outlook is not connected. Send "juju connect outlook" to link it.`);
            } else {
              await m365Auth.unlinkAccount(fromJid);
              await sendReply(`Outlook disconnected. Your tokens have been deleted.`);
            }
          }
          return;
        } else if (target === "salesforce" && sfAuth && sfAuth.isConfigured()) {
          if (sfAuth.isSharedMode && sfAuth.isSharedMode()) {
            if (isConnect) {
              await sendReply(`Salesforce is connected via shared service account. No individual connection needed.`);
            } else {
              sfAuth.unlinkAccount(fromJid);
              await sendReply(`Salesforce token cache cleared. Will re-authenticate on next request.`);
            }
          } else if (isConnect) {
            const already = await sfAuth.isLinked(fromJid);
            if (already) {
              const email = await sfAuth.getLinkedEmail(fromJid);
              await sendReply(`Your Salesforce is already connected (${email}). Send "juju disconnect salesforce" first to reconnect.`);
            } else {
              const authUrl = await sfAuth.getAuthUrl(fromJid, { conversationId: rawConversationId || conversationId, isBubble });
              await sendReply(`Click this link to connect your Salesforce:\n\n${authUrl}\n\n(Link expires in 10 minutes)`);
            }
          } else {
            const linked = await sfAuth.isLinked(fromJid);
            if (!linked) {
              await sendReply(`Your Salesforce is not connected. Send "juju connect salesforce" to link it.`);
            } else {
              await sfAuth.unlinkAccount(fromJid);
              await sendReply(`Salesforce disconnected. Your tokens have been deleted.`);
            }
          }
          return;
        } else {
          await sendReply(`${target === "gmail" ? "Gmail" : target === "outlook" ? "Outlook" : target === "salesforce" ? "Salesforce" : "Email"} integration is not configured.`);
          return;
        }
      }

      // In bubbles: respond on explicit trigger, or evaluate intent if conversation is active (5min window)
      if (isBubble && !hasBotTrigger) {
        const active = activeConversations.get(historyKey);
        const isActive = active && (Date.now() - active.lastActivity) < CONVO_TIMEOUT_MS;

        if (isActive) {
          const forBot = await isMessageForBot(historyKey, fromName, content);
          if (!forBot) {
            await addMessage(historyKey, "user", `[${fromName}]: ${content}`);
            return;
          }
          console.log(`${LOG} AI intent: message IS for bot, responding`);
        } else {
          await addMessage(historyKey, "user", `[${fromName}]: ${content}`);
          return;
        }
      }

      stats.received++;

      // Check for pending M365 link confirmation
      if (m365Auth && redis) {
        try {
          const pendingLink = await redis.get(`oauth:linked_pending:${fromJid}`);
          if (pendingLink) {
            await redis.del(`oauth:linked_pending:${fromJid}`);
            const { email } = JSON.parse(pendingLink);
            const linkMsg = `Outlook connected! (${email})\nYou can now ask me about your emails. Try: "summarize my unread emails"`;
            const convId = rawConversationId || conversationId;
            if (convId && s2sConnectionId && authToken) {
              const host = rainbowHost || "openrainbow.com";
              fetch(`https://${host}/api/rainbow/ucs/v1.0/connections/${s2sConnectionId}/conversations/${convId}/messages`, {
                method: "POST",
                headers: { "Authorization": `Bearer ${authToken}`, "Content-Type": "application/json" },
                body: JSON.stringify({ message: { body: linkMsg, lang: "en" } }),
              }).catch(() => {});
            }
          }
        } catch {}
      }

      // Check for pending Gmail link confirmation
      if (gmailAuth && redis) {
        try {
          const pendingGmail = await redis.get(`gmail:linked_pending:${fromJid}`);
          if (pendingGmail) {
            await redis.del(`gmail:linked_pending:${fromJid}`);
            const { email } = JSON.parse(pendingGmail);
            const linkMsg = `Gmail connected! (${email})\nYou can now ask me about your emails. Try: "summarize my unread emails"`;
            const convId = rawConversationId || conversationId;
            if (convId && s2sConnectionId && authToken) {
              const host = rainbowHost || "openrainbow.com";
              fetch(`https://${host}/api/rainbow/ucs/v1.0/connections/${s2sConnectionId}/conversations/${convId}/messages`, {
                method: "POST",
                headers: { "Authorization": `Bearer ${authToken}`, "Content-Type": "application/json" },
                body: JSON.stringify({ message: { body: linkMsg, lang: "en" } }),
              }).catch(() => {});
            }
          }
        } catch {}
      }

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
        await saveGreeted(fromJid);
        if (!conversationHistories.has(fromJid)) {
          try {
            await sdk.im.sendMessageToConversation(conversation, config.welcomeMsg);
          } catch (err) {
            console.error(`${LOG} Failed to send welcome:`, err.message);
          }
        }
      }

      // Typing indicator ON — refresh every 5s so it persists when user switches conversations
      let typingInterval = null;
      const sendTyping = () => {
        try { if (conversation) sdk.im.sendIsTypingStateInConversation(conversation, true); } catch {}
      };
      sendTyping();
      typingInterval = setInterval(sendTyping, 5000);

      // Call OpenClaw (use historyKey so bubble messages share conversation context)
      // Append file context to the user message if a file was shared
      let userMessage = fileContext ? `${content}\n\n${fileContext}` : content;

      // ── Email context: check for pending actions and number-only replies ──
      if (emailIntents && redis) {
        const trimmed = content.trim().toLowerCase();
        // "yes" with a pending email send
        if (trimmed === "yes" || trimmed === "oui") {
          const pending = await redis.get(`pending:${fromJid}`).catch(() => null);
          if (pending) {
            const resolved = await emailIntents.resolveProvider(fromJid);
            if (resolved) {
              const responseText = await emailIntents.handleEmailIntent(fromJid, { type: "email_send_confirm" }, content);
              // Send response and return early
              const convId = rawConversationId || conversationId;
              if (convId && s2sConnectionId && authToken) {
                const host = rainbowHost || "openrainbow.com";
                await fetch(`https://${host}/api/rainbow/ucs/v1.0/connections/${s2sConnectionId}/conversations/${convId}/messages`, {
                  method: "POST", headers: { "Authorization": `Bearer ${authToken}`, "Content-Type": "application/json" },
                  body: JSON.stringify({ message: { body: responseText, lang: "en" } }),
                }).catch(() => {});
              } else if (conversation) {
                await sdk.im.sendMessageToConversation(conversation, responseText).catch(() => {});
              }
              if (typingInterval) clearInterval(typingInterval);
              return;
            }
          }
        }
        // "no" cancels pending action
        if (trimmed === "no" || trimmed === "non" || trimmed === "cancel") {
          const pending = await redis.get(`pending:${fromJid}`).catch(() => null);
          if (pending) {
            await redis.del(`pending:${fromJid}`);
            const responseText = "Email cancelled.";
            const convId = rawConversationId || conversationId;
            if (convId && s2sConnectionId && authToken) {
              const host = rainbowHost || "openrainbow.com";
              await fetch(`https://${host}/api/rainbow/ucs/v1.0/connections/${s2sConnectionId}/conversations/${convId}/messages`, {
                method: "POST", headers: { "Authorization": `Bearer ${authToken}`, "Content-Type": "application/json" },
                body: JSON.stringify({ message: { body: responseText, lang: "en" } }),
              }).catch(() => {});
            } else if (conversation) {
              await sdk.im.sendMessageToConversation(conversation, responseText).catch(() => {});
            }
            if (typingInterval) clearInterval(typingInterval);
            return;
          }
        }
        // Number-only reply → email detail if email context exists
        const numMatch = trimmed.match(/^(\d+)$/);
        if (numMatch) {
          const emailContext = await redis.get(`email:context:${fromJid}`).catch(() => null);
          if (emailContext) {
            const responseText = await emailIntents.handleEmailIntent(fromJid, { type: "email_detail_number", number: parseInt(numMatch[1], 10) }, content);
            if (responseText) {
              const convId = rawConversationId || conversationId;
              if (convId && s2sConnectionId && authToken) {
                const host = rainbowHost || "openrainbow.com";
                await fetch(`https://${host}/api/rainbow/ucs/v1.0/connections/${s2sConnectionId}/conversations/${convId}/messages`, {
                  method: "POST", headers: { "Authorization": `Bearer ${authToken}`, "Content-Type": "application/json" },
                  body: JSON.stringify({ message: { body: responseText, lang: "en" } }),
                }).catch(() => {});
              } else if (conversation) {
                await sdk.im.sendMessageToConversation(conversation, responseText).catch(() => {});
              }
              if (typingInterval) clearInterval(typingInterval);
              return;
            }
          }
        }
      }

      // ── Sales pending action confirmation (yes/no for CRM write operations) ──
      if (salesAgent && redis) {
        const trimmedCmd = content.trim().toLowerCase();
        if (trimmedCmd === "yes" || trimmedCmd === "oui" || trimmedCmd === "confirm") {
          const salesPending = await redis.get(`sales:pending:${fromJid}`).catch(() => null);
          if (salesPending) {
            const result = await salesAgent.executePendingAction(fromJid);
            const msg = result?.success ? result.message : (result?.error || "Action failed.");
            const convId = rawConversationId || conversationId;
            if (convId && s2sConnectionId && authToken) {
              const host = rainbowHost || "openrainbow.com";
              await fetch(`https://${host}/api/rainbow/ucs/v1.0/connections/${s2sConnectionId}/conversations/${convId}/messages`, {
                method: "POST", headers: { "Authorization": `Bearer ${authToken}`, "Content-Type": "application/json" },
                body: JSON.stringify({ message: { body: msg, lang: "en" } }),
              }).catch(() => {});
            }
            if (typingInterval) clearInterval(typingInterval);
            return;
          }
        }
        if (trimmedCmd === "no" || trimmedCmd === "non" || trimmedCmd === "cancel") {
          const salesPending = await redis.get(`sales:pending:${fromJid}`).catch(() => null);
          if (salesPending) {
            await redis.del(`sales:pending:${fromJid}`);
            const convId = rawConversationId || conversationId;
            if (convId && s2sConnectionId && authToken) {
              const host = rainbowHost || "openrainbow.com";
              await fetch(`https://${host}/api/rainbow/ucs/v1.0/connections/${s2sConnectionId}/conversations/${convId}/messages`, {
                method: "POST", headers: { "Authorization": `Bearer ${authToken}`, "Content-Type": "application/json" },
                body: JSON.stringify({ message: { body: "Action cancelled.", lang: "en" } }),
              }).catch(() => {});
            }
            if (typingInterval) clearInterval(typingInterval);
            return;
          }
        }
      }

      // ── Intent-driven processing: bot decides, AI generates content ──
      let intent = detectIntent(content);
      if (!intent) intent = { type: "chat" };
      console.log(`${LOG} Intent: ${intent.type} for ${fromName}`);

      // Send short confirmation before starting the task
      const confirmation = describeIntent(intent);
      if (confirmation) {
        try {
          if (isBubble && targetBubble) {
            sendMessageToBubble(targetBubble, confirmation).catch(() => {});
          } else if (conversation) {
            sdk.im.sendMessageToConversation(conversation, confirmation).catch(() => {});
          }
        } catch {}
      }

      let responseText = null;

      // Force agent for email/calendar when available — bypass detectIntent result
      // Route through the AI agent by default — let the agent decide which tools to use.
      // Only skip the agent for document processing (translate/anonymize/create_file)
      // which depends on stored file state the agent can't access.
      const isDocumentIntent = intent && /^(translate_|anonymize_|create_file)/.test(intent.type);
      const useAgent = agent && agent.isAvailable() && !isDocumentIntent;

      lastMessageDebug = {
        content: (content || "").substring(0, 200),
        useAgent,
        agentLoaded: !!agent,
        agentAvailable: agent ? agent.isAvailable() : false,
        intentType: intent?.type,
        isBubble,
        fromJid,
        timestamp: new Date().toISOString(),
      };
      console.log(`${LOG} useAgent=${useAgent}, content="${(content||"").substring(0,50)}", agentLoaded=${!!agent}, agentAvail=${agent?agent.isAvailable():false}`);

      if (useAgent) {
        console.log(`${LOG} >>> AGENT FORCED for: "${content.substring(0, 80)}"`);
        try {
          const history = await getHistory(historyKey);
          // Progress callback: send status updates to user while agent works
          const sendProgress = async (msg) => {
            const convId = rawConversationId || conversationId;
            if (convId && s2sConnectionId && authToken) {
              const host = rainbowHost || "openrainbow.com";
              await fetch(`https://${host}/api/rainbow/ucs/v1.0/connections/${s2sConnectionId}/conversations/${convId}/messages`, {
                method: "POST",
                headers: { "Authorization": `Bearer ${authToken}`, "Content-Type": "application/json" },
                body: JSON.stringify({ message: { body: msg, lang: "en" } }),
              }).catch(() => {});
            }
          };
          // Send patience messages at intervals while agent works
          const progressConvId = rawConversationId || conversationId;
          const patienceMessages = [
            { delay: 0, text: "Let me check..." },
            { delay: 6000, text: "Working on it..." },
            { delay: 14000, text: "Almost there, just a moment..." },
          ];
          const patienceTimers = [];
          if (progressConvId && s2sConnectionId && authToken) {
            const host = rainbowHost || "openrainbow.com";
            for (const pm of patienceMessages) {
              const timer = setTimeout(() => {
                fetch(`https://${host}/api/rainbow/ucs/v1.0/connections/${s2sConnectionId}/conversations/${progressConvId}/messages`, {
                  method: "POST",
                  headers: { "Authorization": `Bearer ${authToken}`, "Content-Type": "application/json" },
                  body: JSON.stringify({ message: { body: pm.text, lang: "en" } }),
                }).catch(() => {});
              }, pm.delay);
              patienceTimers.push(timer);
            }
          }

          responseText = await agent.run(fromJid, content, history, sendProgress);

          // Clear any pending patience messages
          for (const t of patienceTimers) clearTimeout(t);
          console.log(`${LOG} Agent returned: ${responseText ? responseText.substring(0, 100) : "NULL"}`);

          // Write to unified context + sync agent memory
          if (contextManager && responseText) {
            const agentTrace = agent.getLastRunTrace();
            contextManager.addEntry(fromJid, "user", content, { path: "agent" }).catch(() => {});
            contextManager.addEntry(fromJid, "assistant", responseText, {
              path: "agent",
              toolsUsed: agentTrace?.tools || [],
              summary: contextManager.generateSummary(responseText),
            }).catch(() => {});
            // Sync entities from agent working memory
            agent.getWorkingMemory(fromJid).then(mem => {
              if (mem) contextManager.syncAgentMemory(fromJid, mem);
            }).catch(() => {});
          }

          // Capture final result for sales dashboard + append unique link
          if (salesDashboard && responseText) {
            const sessionId = salesDashboard.getCurrentSessionId();
            if (sessionId) {
              salesDashboard.captureResult(fromJid, responseText);
              const resultUrl = `${config.hostCallback}/sales/result/${sessionId}`;
              responseText += `\n\nView full report: ${resultUrl}`;
            }
          }
        } catch (agentErr) {
          console.error(`${LOG} Agent crashed:`, agentErr.message);
          responseText = "Sorry, I encountered an error processing your request. Please try again.";
        }
      } else if (intent.type === "translate_docx") {
        responseText = await handleDocxTranslation(historyKey, userMessage, intent.language, intent.docxKey);
      } else if (intent.type === "translate_pdf") {
        responseText = await handlePdfTranslation(historyKey, userMessage, intent.language, intent.fileKey);
      } else if (intent.type === "translate_pptx") {
        responseText = await handlePptxTranslation(historyKey, userMessage, intent.language, intent.fileKey);
      } else if (intent.type === "translate_any") {
        responseText = await handleAnyTranslation(historyKey, userMessage, intent.language);
      } else if (intent.type.startsWith("anonymize_")) {
        responseText = await handleAnonymizeDocument(historyKey, intent.type, intent.fileKey);
      } else if (intent.type === "create_file") {
        responseText = await handleCreateFile(historyKey, userMessage, intent.format);
      } else if (intent.type.startsWith("email_") && emailIntents) {
        responseText = await Promise.race([
          emailIntents.handleEmailIntent(fromJid, intent, userMessage),
          new Promise(r => setTimeout(() => r("Sorry, the email request timed out. Please try again."), 25000)),
        ]);
      } else if (intent.type.startsWith("calendar_") && calendarIntents) {
        responseText = await Promise.race([
          calendarIntents.handleCalendarIntent(fromJid, intent, userMessage),
          new Promise(r => setTimeout(() => r("Sorry, the calendar request timed out. Please try again."), 25000)),
        ]);
      } else if (intent.type.startsWith("sf_") && sfIntents) {
        responseText = await Promise.race([
          sfIntents.handleSalesforceIntent(fromJid, intent, userMessage),
          new Promise(r => setTimeout(() => r("Sorry, the CRM request timed out. Please try again."), 25000)),
        ]);
      } else if (intent.type.startsWith("sp_") && spIntents) {
        responseText = await Promise.race([
          spIntents.handleSharePointIntent(fromJid, intent, userMessage),
          new Promise(r => setTimeout(() => r("Sorry, the document request timed out. Please try again."), 25000)),
        ]);
      } else if (intent.type.startsWith("briefing_") && briefing) {
        responseText = await Promise.race([
          briefing.handleBriefingIntent(fromJid, intent, userMessage),
          new Promise(r => setTimeout(() => r("Sorry, the briefing request timed out. Please try again."), 25000)),
        ]);
      }

      if (!responseText) {
        // Check for pending calendar confirmations (yes/no answers)
        if (calendarIntents) {
          const pendingResult = await calendarIntents.checkPendingAction(fromJid, userMessage);
          if (pendingResult) {
            if (typeof pendingResult === "string") {
              responseText = pendingResult;
            } else {
              responseText = await calendarIntents.handleCalendarIntent(fromJid, pendingResult, userMessage);
            }
          }
        }
      }

      // If an intent handler produced a response, add both user message and
      // bot response to conversation history so follow-up questions have context.
      if (responseText) {
        await addMessage(historyKey, "user", userMessage);
        await addMessage(historyKey, "assistant", responseText);
      }

      if (!responseText) {
        // Regular chat or fallback if intent handler returned null
        // PII secure mode: anonymize user message before sending to LLM
        const secureOn = pii ? await pii.isSecureMode(historyKey) : false;
        if (secureOn) {
          const { anonymizedText, mapping } = await pii.anonymize(userMessage);
          await pii.storePiiMapping(historyKey, mapping);
          userMessage = anonymizedText;
          console.log(`${LOG} [PII] User message anonymized for ${historyKey}`);
        }

        const result = await callOpenClaw(historyKey, userMessage);
        responseText = result?.content || config.fallbackMsg;

        // PII secure mode: deanonymize AI response
        if (secureOn) {
          const mapping = await pii.getPiiMapping(historyKey);
          responseText = await pii.deanonymize(responseText, mapping);
          console.log(`${LOG} [PII] AI response deanonymized for ${historyKey}`);
        }
      }

      // Fallback: host any [FILE:] markers as downloadable links
      responseText = responseText.replace(/\[FILE:([^\]]+)\]\n?([\s\S]*?)\[\/FILE\]/g, (_, fname, fcontent) => {
        const url = hostFile(fname.trim(), fcontent);
        console.log(`${LOG} File hosted (fallback): ${fname.trim()} -> ${url}`);
        return `📎 **${fname.trim()}**: ${url}`;
      });

      // Re-host any external file URLs (tmpfiles.org, etc.) on our server
      responseText = await rewriteFileUrls(responseText);

      // Typing indicator OFF
      if (typingInterval) clearInterval(typingInterval);
      try {
        if (conversation) sdk.im.sendIsTypingStateInConversation(conversation, false);
      } catch {}

      // Send response back
      try {
        let sent = false;

        if (isBubble) {
          // For bubble messages, try multiple send methods in order of reliability
          console.log(`${LOG} Sending bubble reply: targetBubble=${targetBubble?.name || "none"}, rawConvId=${rawConversationId}, convDbId=${conversation?.dbId}`);

          // Method 1: Use raw conversation_id from callback via S2S REST
          if (!sent && rawConversationId && s2sConnectionId && authToken) {
            try {
              const host = rainbowHost || "openrainbow.com";
              const msgUrl = `https://${host}/api/rainbow/ucs/v1.0/connections/${s2sConnectionId}/conversations/${rawConversationId}/messages`;
              const resp = await fetch(msgUrl, {
                method: "POST",
                headers: { "Authorization": `Bearer ${authToken}`, "Content-Type": "application/json" },
                body: JSON.stringify(buildMessage(responseText)),
              });
              if (resp.ok) {
                sent = true;
                console.log(`${LOG} Sent via S2S REST rawConvId=${rawConversationId}`);
              } else {
                const errText = await resp.text();
                console.warn(`${LOG} S2S REST rawConvId failed (${resp.status}): ${errText.substring(0, 200)}`);
              }
            } catch (err) {
              console.warn(`${LOG} S2S REST rawConvId error:`, err.message);
            }
          }

          // Method 2: Use conversation.dbId via sdk.s2s.sendMessageInConversation
          if (!sent && conversation?.dbId && sdk.s2s && typeof sdk.s2s.sendMessageInConversation === "function") {
            try {
              await sdk.s2s.sendMessageInConversation(conversation.dbId, buildMessage(responseText));
              sent = true;
              console.log(`${LOG} Sent via sdk.s2s.sendMessageInConversation dbId=${conversation.dbId}`);
            } catch (err) {
              console.warn(`${LOG} sdk.s2s.sendMessageInConversation failed:`, err.message);
            }
          }

          // Method 3: Use sendMessageToBubble (opens new conversation)
          if (!sent && targetBubble) {
            sent = await sendMessageToBubble(targetBubble, responseText);
            if (sent) console.log(`${LOG} Sent via sendMessageToBubble "${targetBubble.name}"`);
          }

          if (sent) {
            stats.replied++;
            console.log(`${LOG} [${stats.replied}] Replied in bubble (${responseText.length} chars)`);
          } else {
            stats.errors++;
            console.error(`${LOG} All bubble reply methods failed`);
          }
        } else {
          // 1:1 reply via S2S or IM — with HTML formatting
          if (conversation.dbId && sdk.s2s && typeof sdk.s2s.sendMessageInConversation === "function") {
            await sdk.s2s.sendMessageInConversation(conversation.dbId, buildMessage(responseText));
          } else {
            await sdk.im.sendMessageToConversation(conversation, responseText);
          }
          stats.replied++;
          console.log(`${LOG} [${stats.replied}] Replied to ${fromName} (${responseText.length} chars)`);
        }
      // Mark bubble conversation as active so follow-ups get intent evaluation
      if (isBubble) {
        activeConversations.set(historyKey, { lastActivity: Date.now() });
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
setTimeout(async () => {
  await initRedis();
  start();
}, 3000);

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
