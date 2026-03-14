/**
 * SharePoint / OneDrive Intent Handler
 *
 * Detects document-related intents from user messages and dispatches
 * to the SharePoint/OneDrive API (Microsoft Graph).
 *
 * Follows the same architecture as email-intents.js.
 */

const LOG = "[SharePoint-Intents]";

let spApiModule = null;
let m365AuthModule = null;
let callOpenClawFn = null;
let redisClient = null;

// External extractors (set during init)
let mammothModule = null;
let jsZipModule = null;
let pdfParseModule = null;

// ── Init ─────────────────────────────────────────────────

function init({ sharepointApiMod, m365AuthMod, callOpenClaw, redis, mammoth, JSZip, pdfParse }) {
  spApiModule = sharepointApiMod;
  m365AuthModule = m365AuthMod;
  callOpenClawFn = callOpenClaw;
  redisClient = redis;
  mammothModule = mammoth || null;
  jsZipModule = JSZip || null;
  pdfParseModule = pdfParse || null;
  console.log(`${LOG} Initialized`);
}

// ── Intent Detection ────────────────────────────────────

function detectSharePointIntent(message) {
  const msg = message.toLowerCase().trim();

  // Search documents
  if (/\b(search|find|look\s*(?:for|up)|locate)\s+(?:(?:sharepoint|onedrive|shared)\s+)?(?:document|file|doc|report|presentation|spreadsheet|deck)s?\s+(?:about|for|on|related\s+to|named|called)\s+(.+)/i.test(message)) {
    const match = message.match(/\b(?:search|find|look\s*(?:for|up)|locate)\s+(?:(?:sharepoint|onedrive|shared)\s+)?(?:document|file|doc|report|presentation|spreadsheet|deck)s?\s+(?:about|for|on|related\s+to|named|called)\s+(.+?)(?:\?|$)/i);
    return { type: "sp_search", query: match ? match[1].trim() : message };
  }

  // "find documents about X" / "documents related to X"
  if (/\b(document|file|doc|report)s?\s+(?:about|related\s+to|on|for|regarding)\s+(.+)/i.test(message)) {
    const match = message.match(/\b(?:document|file|doc|report)s?\s+(?:about|related\s+to|on|for|regarding)\s+(.+?)(?:\?|$)/i);
    return { type: "sp_search", query: match ? match[1].trim() : message };
  }

  // Recent documents
  if (/\b(recent|latest|last)\s+(?:sharepoint\s+)?(?:document|file|doc)s?\b/i.test(msg)) {
    return { type: "sp_recent" };
  }

  // Summarize a document
  if (/\b(summarize|summary\s+of|summarise|overview\s+of)\s+(?:the\s+)?(?:document|file|doc|report)\s+(.+)/i.test(message)) {
    const match = message.match(/\b(?:summarize|summary\s+of|summarise|overview\s+of)\s+(?:the\s+)?(?:document|file|doc|report)\s+(.+?)(?:\?|$)/i);
    return { type: "sp_summarize", query: match ? match[1].trim() : message };
  }

  // Download a document
  if (/\b(download|get|fetch|grab)\s+(?:the\s+)?(?:document|file|doc|report)\s+(.+)/i.test(message)) {
    const match = message.match(/\b(?:download|get|fetch|grab)\s+(?:the\s+)?(?:document|file|doc|report)\s+(.+?)(?:\?|$)/i);
    return { type: "sp_download", query: match ? match[1].trim() : message };
  }

  // Search SharePoint sites
  if (/\b(sharepoint\s+site|site)\s+(search|find|list|show)/i.test(msg) || /\b(search|find)\s+(?:sharepoint\s+)?sites?\s+(.+)/i.test(msg)) {
    const match = message.match(/\bsites?\s+(?:for|about|named|called)?\s*(.+?)(?:\?|$)/i);
    return { type: "sp_sites", query: match ? match[1].trim() : "" };
  }

  // Smart catch-all
  if (/\b(sharepoint|onedrive|shared\s+document|shared\s+file|document\s+library)\b/i.test(msg)) {
    return { type: "sp_smart_query", query: message };
  }

  return null;
}

// ── Intent Handlers ─────────────────────────────────────

async function handleSharePointIntent(userId, intent, originalMessage) {
  if (!m365AuthModule) {
    return "SharePoint requires a Microsoft 365 connection. Use **jojo connect outlook** to link your account.";
  }

  const tokenResult = await m365AuthModule.getValidToken(userId);
  if (!tokenResult) {
    return "You haven't connected Microsoft 365 yet. Use **jojo connect outlook** to link your account.";
  }

  const { token } = tokenResult;

  try {
    switch (intent.type) {
      case "sp_search":
        return await handleSearch(token, intent);
      case "sp_recent":
        return await handleRecent(token);
      case "sp_summarize":
        return await handleSummarize(token, userId, intent);
      case "sp_download":
        return await handleDownload(token, userId, intent);
      case "sp_sites":
        return await handleSites(token, intent);
      case "sp_smart_query":
        return await handleSmartQuery(token, userId, intent);
      default:
        return "I didn't understand that document request.";
    }
  } catch (err) {
    console.error(`${LOG} Error handling ${intent.type}:`, err.message);
    return `Sorry, there was an error accessing SharePoint: ${err.message}`;
  }
}

// ── Search Documents ────────────────────────────────────

async function handleSearch(token, intent) {
  const docs = await spApiModule.searchDocuments(token, intent.query);
  if (!docs || docs._error) return "Sorry, I couldn't search SharePoint right now.";
  if (docs.length === 0) return `No documents found matching "${intent.query}".`;

  let output = `**Documents matching "${intent.query}":**\n\n`;
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    output += `${i + 1}. **${d.name}**`;
    if (d.modifiedBy) output += ` — modified by ${d.modifiedBy}`;
    if (d.modifiedAt) output += ` (${formatDate(d.modifiedAt)})`;
    if (d.size) output += ` | ${spApiModule.formatFileSize(d.size)}`;
    output += "\n";
  }
  output += `\nSay "summarize document #N" to get a summary.`;

  // Store search results for follow-up
  if (redisClient) {
    await redisClient.set(`sp_ctx:${intent.query.substring(0, 50)}`, JSON.stringify(docs), { EX: 1800 }).catch(() => {});
  }

  return output;
}

// ── Recent Documents ────────────────────────────────────

async function handleRecent(token) {
  const docs = await spApiModule.getRecentDocuments(token, 10);
  if (!docs || docs._error) return "Sorry, I couldn't access your recent documents.";
  if (docs.length === 0) return "No recent documents found.";

  let output = "**Recent Documents:**\n\n";
  for (let i = 0; i < docs.length; i++) {
    const d = docs[i];
    output += `${i + 1}. **${d.name}**`;
    if (d.modifiedBy) output += ` — ${d.modifiedBy}`;
    if (d.modifiedAt) output += ` (${formatDate(d.modifiedAt)})`;
    output += "\n";
  }
  return output;
}

// ── Summarize Document ──────────────────────────────────

async function handleSummarize(token, userId, intent) {
  // Search for the document
  const docs = await spApiModule.searchDocuments(token, intent.query, 3);
  if (!docs || docs._error || docs.length === 0) {
    return `No document found matching "${intent.query}".`;
  }

  const doc = docs[0];
  const content = await spApiModule.extractDocumentContent(token, doc);

  if (!content || content.type === "error") {
    return `Found "${doc.name}" but couldn't extract its content: ${content?.error || "unknown error"}.`;
  }

  if (content.type === "unsupported") {
    return `Found "${doc.name}" but ${content.message}.`;
  }

  let textContent = "";

  if (content.type === "text") {
    textContent = content.content;
  } else if (content.type === "docx" && mammothModule) {
    try {
      const result = await mammothModule.extractRawText({ buffer: content.buffer });
      textContent = result.value.substring(0, 30000);
    } catch (e) {
      return `Found "${doc.name}" but couldn't extract DOCX content.`;
    }
  } else if (content.type === "pdf" && pdfParseModule) {
    try {
      const result = await pdfParseModule(content.buffer);
      textContent = result.text.substring(0, 30000);
    } catch (e) {
      return `Found "${doc.name}" but couldn't extract PDF content.`;
    }
  } else if (content.type === "pptx" && jsZipModule) {
    try {
      const zip = await jsZipModule.loadAsync(content.buffer);
      const texts = [];
      for (const fname of Object.keys(zip.files).filter(f => f.match(/ppt\/slides\/slide\d+\.xml$/)).sort()) {
        const xml = await zip.file(fname).async("string");
        const slideTexts = [...xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map(m => m[1]);
        if (slideTexts.length > 0) texts.push(slideTexts.join(" "));
      }
      textContent = texts.join("\n\n").substring(0, 30000);
    } catch (e) {
      return `Found "${doc.name}" but couldn't extract PPTX content.`;
    }
  } else {
    return `Found "${doc.name}" (${content.type}) but no extractor is available for this format.`;
  }

  if (!textContent || textContent.trim().length < 10) {
    return `Found "${doc.name}" but it appears to be empty or contains only images.`;
  }

  // Ask AI to summarize
  const aiPrompt = `Summarize the following document in a concise, executive-friendly format.
Include: key points, main conclusions, action items if any.
Keep it under 500 words.

Document: "${doc.name}"
Modified: ${formatDate(doc.modifiedAt)} by ${doc.modifiedBy}

Content:
${textContent}`;

  const summary = await callOpenClawFn(userId, aiPrompt);
  if (!summary) return `Found "${doc.name}" but couldn't generate a summary.`;

  return `**Document Summary: ${doc.name}**\n_(${spApiModule.formatFileSize(doc.size)} | Last modified: ${formatDate(doc.modifiedAt)})_\n\n${summary}`;
}

// ── Download Document ───────────────────────────────────

async function handleDownload(token, userId, intent) {
  const docs = await spApiModule.searchDocuments(token, intent.query, 3);
  if (!docs || docs._error || docs.length === 0) {
    return `No document found matching "${intent.query}".`;
  }

  const doc = docs[0];
  if (doc.webUrl) {
    return `**${doc.name}** (${spApiModule.formatFileSize(doc.size)})\n\nOpen in browser: ${doc.webUrl}`;
  }

  return `Found "${doc.name}" but couldn't generate a download link.`;
}

// ── SharePoint Sites ────────────────────────────────────

async function handleSites(token, intent) {
  const sites = await spApiModule.searchSites(token, intent.query || "*");
  if (!sites || sites._error) return "Sorry, couldn't search SharePoint sites.";
  if (sites.length === 0) return `No SharePoint sites found${intent.query ? ` matching "${intent.query}"` : ""}.`;

  let output = "**SharePoint Sites:**\n\n";
  for (const s of sites) {
    output += `- **${s.name}**`;
    if (s.description) output += ` — ${s.description.substring(0, 100)}`;
    if (s.url) output += `\n  ${s.url}`;
    output += "\n";
  }
  return output;
}

// ── Smart Query ─────────────────────────────────────────

async function handleSmartQuery(token, userId, intent) {
  const recentDocs = await spApiModule.getRecentDocuments(token, 5);

  const aiPrompt = `You are an executive AI assistant. The user asked a document-related question. Answer using the data below.

Recent documents: ${JSON.stringify(recentDocs && !recentDocs._error ? recentDocs : [])}

User question: "${intent.query}"

If you need to search for specific documents, tell the user to ask "find documents about <topic>".`;

  const response = await callOpenClawFn(userId, aiPrompt);
  return response || "Sorry, I couldn't process that document request.";
}

// ── Helpers ─────────────────────────────────────────────

function formatDate(isoString) {
  if (!isoString) return "";
  const d = new Date(isoString);
  if (isNaN(d.getTime())) return isoString;
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

module.exports = {
  init,
  detectSharePointIntent,
  handleSharePointIntent,
};
