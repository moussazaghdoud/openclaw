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

async function callOpenClaw(userId, userMessage, attempt = 1) {
  const history = await getHistory(userId);

  const messages = [];
  const fileInstructions = `When users share files, their content is automatically extracted and included in the conversation history. You CAN read and work with file contents directly from the chat. Never say you can't see a file if its content appears in the conversation history.

FILE CREATION — CRITICAL INSTRUCTIONS:
You have the ability to create and send real files to users. When you need to create a file, you MUST use the exact marker format below. The system will parse these markers, upload the file to the server, and deliver it to the user as a downloadable attachment.

Format (you MUST follow this exactly):
[FILE:filename.ext]
file content here
[/FILE]

RULES:
- ALWAYS use the [FILE:...][/FILE] markers when creating files. NEVER just describe a file or pretend to send one.
- Do NOT say "Here's your file:" without actually including the [FILE:] markers — that does nothing.
- You can include explanatory text before or after the [FILE:] block.
- Supported formats: .txt, .csv, .json, .xml, .html, .md, .js, .py, .css, .sql, .yaml, .sh
- Binary formats (.xlsx, .docx, .pdf, .png, .jpg, .zip) CANNOT be created. For spreadsheet data, use .csv instead of .xlsx. For documents, use .html or .md instead of .docx.
- If asked for .xlsx or .xls, create a .csv file instead and explain that CSV can be opened in Excel.

Examples:
[FILE:report.csv]Name,Department,Score
Alice,Engineering,95
Bob,Marketing,87[/FILE]

[FILE:notes.md]# Meeting Notes
- Discussed project timeline
- Next deadline: March 20[/FILE]`;
  const sysPrompt = config.systemPrompt
    ? `${config.systemPrompt}\n\n${fileInstructions}`
    : fileInstructions;
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
    const assistantMessage = data.choices?.[0]?.message?.content || "";

    await addMessage(userId, "user", userMessage);
    await addMessage(userId, "assistant", assistantMessage);

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
  console.log(`${LOG} uploadAndSendFile: filename=${filename}, contentLen=${content.length}, convId=${convId}, auth=${authToken ? "OK" : "MISSING"}, cnxId=${s2sConnectionId || "MISSING"}`);
  if (!authToken || !s2sConnectionId) {
    console.warn(`${LOG} Cannot upload file: no auth/connection`);
    return { ok: false, url: null };
  }

  const host = rainbowHost || "openrainbow.com";
  const buf = Buffer.from(content, "utf-8");
  const mime = guessMime(filename);

  try {
    // Step 1: Create file entry on Rainbow fileserver
    const createBody = { fileName: filename, extension: filename.split(".").pop(), typeMIME: mime, size: buf.length };
    console.log(`${LOG} File create request: ${JSON.stringify(createBody)}`);
    const createResp = await fetch(`https://${host}/api/rainbow/fileserver/v1.0/files`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${authToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(createBody),
    });

    const createText = await createResp.text();
    console.log(`${LOG} File create response (${createResp.status}): ${createText.substring(0, 500)}`);
    if (!createResp.ok) {
      return { ok: false, url: null };
    }

    const fileMeta = JSON.parse(createText);
    const fileId = fileMeta.data?.id || fileMeta.id;
    console.log(`${LOG} File entry created: ${fileId}`);

    // Step 2: Upload file content
    const uploadResp = await fetch(`https://${host}/api/rainbow/fileserver/v1.0/files/${fileId}`, {
      method: "PUT",
      headers: {
        "Authorization": `Bearer ${authToken}`,
        "Content-Type": mime,
        "Content-Length": String(buf.length),
      },
      body: buf,
    });

    if (!uploadResp.ok) {
      console.warn(`${LOG} File upload failed (${uploadResp.status}): ${await uploadResp.text().catch(() => "")}`);
      return { ok: false, url: null };
    }

    console.log(`${LOG} File uploaded: ${filename} (${buf.length} bytes)`);

    const fileUrl = `https://${host}/api/rainbow/fileserver/v1.0/files/${fileId}`;

    // Step 3: Try to share the file (add viewers) so recipients can download
    try {
      await fetch(`https://${host}/api/rainbow/fileserver/v1.0/files/${fileId}/viewers`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${authToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ viewerId: convId, type: "conversation" }),
      });
      console.log(`${LOG} File shared with conversation ${convId}`);
    } catch (shareErr) {
      console.warn(`${LOG} File share (viewers) failed:`, shareErr.message);
    }

    // Step 4: File uploaded successfully — the caller will include the download URL in the text response
    // No need to send a separate message here; the URL is returned to the caller
    console.log(`${LOG} File uploaded to conversation: ${filename} (url=${fileUrl})`);
    return { ok: true, url: fileUrl, fileId };
  } catch (err) {
    console.error(`${LOG} uploadAndSendFile error:`, err.message);
    return { ok: false, url: null };
  }
}

function guessMime(filename) {
  const ext = (filename.split(".").pop() || "").toLowerCase();
  const mimes = {
    txt: "text/plain", csv: "text/csv", json: "application/json",
    xml: "application/xml", html: "text/html", htm: "text/html",
    md: "text/markdown", js: "application/javascript", py: "text/x-python",
    css: "text/css", sql: "text/x-sql", yaml: "application/x-yaml",
    yml: "application/x-yaml", sh: "text/x-shellscript",
  };
  return mimes[ext] || "text/plain";
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

  // Word documents (.docx): extract text with mammoth
  if ((mime.includes("wordprocessingml") || filename.toLowerCase().endsWith(".docx")) && mammoth) {
    try {
      const result = await mammoth.extractRawText({ buffer });
      if (result.value && result.value.trim().length > 0) {
        const text = result.value.trim().substring(0, 50000);
        return `[File: ${filename}]\n\`\`\`\n${text}\n\`\`\``;
      }
    } catch (err) {
      console.warn(`${LOG} mammoth extraction failed:`, err.message);
    }
  }

  // PDF: include raw text extraction attempt
  if (mime === "application/pdf") {
    return `[PDF file shared: ${filename} (${buffer.length} bytes) — content not extractable inline, but file was received]`;
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

  // Send confirmation
  const confirmMsg = downloaded
    ? `📎 Got it — **${fileInfo.filename}** received and ready. You can ask me about it.`
    : `📎 I see **${fileInfo.filename}** was shared, but I couldn't download it. Try pasting the content directly.`;

  if (convId && s2sConnectionId && authToken) {
    try {
      const host = rainbowHost || "openrainbow.com";
      await fetch(`https://${host}/api/rainbow/ucs/v1.0/connections/${s2sConnectionId}/conversations/${convId}/messages`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${authToken}`, "Content-Type": "application/json" },
        body: JSON.stringify({ message: { body: confirmMsg, lang: "en" } }),
      });
      console.log(`${LOG} File confirmation sent to conv ${convId}`);
    } catch (e) {
      console.warn(`${LOG} Failed to send file confirmation:`, e.message);
    }
  }
}

// ── Create Express app for S2S callbacks ────────────────

const app = express();
app.use(express.json());

// Store last messages for debug
const debugMessages = [];

// Store raw S2S callbacks for debug
const debugCallbacks = [];

// Map message IDs to raw callback data (so onmessagereceived can detect is_group)
const rawCallbackMap = new Map();
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
    let responseText = result?.content || config.fallbackMsg;

    // Handle file creation markers in AI response
    const { text: cleanedText, files } = parseFileMarkers(responseText);
    if (files.length > 0) {
      console.log(`${LOG} Found ${files.length} file marker(s) in AI response`);
      // Get a conversation ID for file uploads
      let fileConvId = null;
      if (s2sConnectionId && authToken) {
        // Try creating an S2S conversation for this bubble
        if (bubble) {
          try {
            const host = rainbowHost || "openrainbow.com";
            const convResp = await fetch(`https://${host}/api/rainbow/ucs/v1.0/connections/${s2sConnectionId}/conversations`, {
              method: "POST",
              headers: { "Authorization": `Bearer ${authToken}`, "Content-Type": "application/json" },
              body: JSON.stringify({ conversation: { peerId: bubble.id } }),
            });
            const convText = await convResp.text();
            console.log(`${LOG} File conv creation response (${convResp.status}): ${convText.substring(0, 300)}`);
            try {
              const convData = JSON.parse(convText);
              fileConvId = convData?.data?.id || convData?.id;
            } catch {}
          } catch (err) {
            console.warn(`${LOG} Failed to create conv for file upload:`, err.message);
          }
        }
      } else {
        console.warn(`${LOG} Cannot upload files: s2sConnectionId=${s2sConnectionId}, authToken=${authToken ? "OK" : "MISSING"}`);
      }

      let fileText = cleanedText;
      if (fileConvId) {
        for (const f of files) {
          console.log(`${LOG} Uploading file ${f.filename} to convId=${fileConvId}...`);
          const result2 = await uploadAndSendFile(f.filename, f.content, fileConvId);
          console.log(`${LOG} File creation ${f.filename}: ${result2.ok ? "SUCCESS" : "FAILED"}${result2.url ? " url=" + result2.url : ""}`);
          if (result2.ok && result2.url) {
            fileText = fileText.replace(f.placeholder, `📎 ${f.filename}: ${result2.url}`);
          } else {
            fileText = fileText.replace(f.placeholder, `(failed to create ${f.filename})`);
          }
        }
      } else {
        console.warn(`${LOG} Cannot upload files: no conversation ID (bubble=${bubble?.name || "none"})`);
        for (const f of files) {
          fileText = fileText.replace(f.placeholder, `(could not upload ${f.filename})`);
        }
      }
      responseText = fileText;
    }

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
        console.log(`${LOG} File detected (SDK event): ${fileInfo.filename} (${fileInfo.mime})`);
        const downloaded = await downloadFile(fileInfo);
        fileContext = await describeFileForAI(fileInfo, downloaded);
        console.log(`${LOG} File context: ${fileContext.substring(0, 200)}`);

        // Store file context in conversation history so follow-up messages can reference it
        const fHistoryKey = (rawCb?.is_group && (rawCb?.conversation_id || ""))
          ? `bubble:${rawCb.conversation_id}` : fromJid;
        await addMessage(fHistoryKey, "user", `[${fromName} shared a file]\n${fileContext}`);

        // Send confirmation to user
        const confirmMsg = downloaded
          ? `📎 Got it — **${fileInfo.filename}** received and ready. You can ask me about it.`
          : `📎 I see **${fileInfo.filename}** was shared, but I couldn't download it. Try sending a text file (.txt, .csv, .json) or paste the content directly.`;

        // Send confirmation via S2S REST (quick, no need to resolve full conversation)
        const confirmConvId = rawCb?.conversation_id || conversationId;
        if (confirmConvId && s2sConnectionId && authToken) {
          try {
            const host = rainbowHost || "openrainbow.com";
            await fetch(`https://${host}/api/rainbow/ucs/v1.0/connections/${s2sConnectionId}/conversations/${confirmConvId}/messages`, {
              method: "POST",
              headers: { "Authorization": `Bearer ${authToken}`, "Content-Type": "application/json" },
              body: JSON.stringify({ message: { body: confirmMsg, lang: "en" } }),
            });
          } catch (e) {
            console.warn(`${LOG} Failed to send file confirmation:`, e.message);
          }
        }

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

      // "sleep" command: force bot back to sleep (clear active conversation)
      if (isBubble && contentLower.trim() === "sleep") {
        activeConversations.delete(historyKey);
        console.log(`${LOG} Sleep command: bot going to sleep in ${historyKey}`);
        await addMessage(historyKey, "user", `[${fromName}]: sleep`);
        return;
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

      // Typing indicator ON
      try {
        if (conversation) sdk.im.sendIsTypingStateInConversation(conversation, true);
      } catch {}

      // Call OpenClaw (use historyKey so bubble messages share conversation context)
      // Append file context to the user message if a file was shared
      const userMessage = fileContext ? `${content}\n\n${fileContext}` : content;
      const result = await callOpenClaw(historyKey, userMessage);
      let responseText = result?.content || config.fallbackMsg;

      // Handle file creation markers in AI response
      const { text: cleanedText, files: filesToSend } = parseFileMarkers(responseText);
      if (filesToSend.length > 0) {
        // Determine conversation ID for file upload
        const fileUploadConvId = rawConversationId || conversation?.dbId || "";
        let fileText = cleanedText;
        if (fileUploadConvId && s2sConnectionId && authToken) {
          for (const f of filesToSend) {
            const result2 = await uploadAndSendFile(f.filename, f.content, fileUploadConvId);
            console.log(`${LOG} File creation ${f.filename}: ${result2.ok ? "SUCCESS" : "FAILED"}${result2.url ? " url=" + result2.url : ""}`);
            if (result2.ok && result2.url) {
              fileText = fileText.replace(f.placeholder, `📎 ${f.filename}: ${result2.url}`);
            } else {
              fileText = fileText.replace(f.placeholder, `(failed to create ${f.filename})`);
            }
          }
        } else {
          console.warn(`${LOG} Cannot upload files: no conversation ID or auth`);
          for (const f of filesToSend) {
            fileText = fileText.replace(f.placeholder, `(could not upload ${f.filename})`);
          }
        }
        responseText = fileText;
      }

      // Typing indicator OFF
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
                body: JSON.stringify({ message: { body: responseText, lang: "en" } }),
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
              await sdk.s2s.sendMessageInConversation(conversation.dbId, {
                message: { body: responseText, lang: "en" },
              });
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
