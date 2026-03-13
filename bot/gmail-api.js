/**
 * Gmail API Connector — Email Operations
 *
 * All methods require a valid access token (from gmail-auth.js).
 * Uses Node 22 built-in fetch — no extra dependencies.
 *
 * Gmail REST API: https://gmail.googleapis.com/gmail/v1/users/me/...
 */

const LOG = "[Gmail-API]";
const GMAIL_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

// ── Read Operations ──────────────────────────────────────

/**
 * Get unread emails from inbox.
 */
async function getUnreadEmails(token, top = 20) {
  const params = new URLSearchParams({
    q: "is:unread in:inbox",
    maxResults: String(top),
  });
  return fetchMessageList(token, params);
}

/**
 * Get recent emails from inbox (read and unread).
 */
async function getRecentEmails(token, top = 20) {
  const params = new URLSearchParams({
    q: "in:inbox",
    maxResults: String(top),
  });
  return fetchMessageList(token, params);
}

/**
 * Search emails by query string.
 */
async function searchEmails(token, query, top = 20) {
  const params = new URLSearchParams({
    q: query,
    maxResults: String(top),
  });
  return fetchMessageList(token, params);
}

/**
 * Search emails from a specific sender.
 */
async function getEmailsFromSender(token, senderName, top = 10) {
  const params = new URLSearchParams({
    q: `from:${senderName}`,
    maxResults: String(top),
  });
  return fetchMessageList(token, params);
}

/**
 * Get full email by ID (includes body).
 */
async function getEmailById(token, messageId) {
  const resp = await gmailFetch(token, `/messages/${messageId}?format=full`);
  if (!resp || resp._error) return resp;
  return normalizeEmail(resp, true);
}

/**
 * Get email thread (all messages in the same thread).
 */
async function getEmailThread(token, threadId, top = 30) {
  const resp = await gmailFetch(token, `/threads/${threadId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Date`);
  if (!resp || resp._error) return resp;
  if (!resp.messages) return [];
  return resp.messages.map(m => normalizeEmail(m, false));
}

/**
 * Get user profile info.
 */
async function getUserProfile(token) {
  return gmailFetch(token, "/profile");
}

// ── Write Operations ─────────────────────────────────────

/**
 * Send a new email.
 */
async function sendEmail(token, { to, subject, body, cc, importance }) {
  const headers = [
    `To: ${Array.isArray(to) ? to.join(", ") : to}`,
    `Subject: ${subject}`,
    `Content-Type: text/plain; charset="UTF-8"`,
  ];
  if (cc) headers.push(`Cc: ${Array.isArray(cc) ? cc.join(", ") : cc}`);
  if (importance === "high") headers.push("Importance: high");

  const rawMessage = `${headers.join("\r\n")}\r\n\r\n${body}`;
  const encoded = Buffer.from(rawMessage).toString("base64url");

  const resp = await gmailFetch(token, "/messages/send", {
    method: "POST",
    body: JSON.stringify({ raw: encoded }),
  });
  return resp !== null && !resp._error;
}

/**
 * Reply to an email.
 */
async function replyToEmail(token, messageId, comment) {
  // First get the original message to build reply headers
  const original = await gmailFetch(token, `/messages/${messageId}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=In-Reply-To`);
  if (!original || original._error) return false;

  const getHeader = (name) => {
    const h = original.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase());
    return h?.value || "";
  };

  const from = getHeader("From");
  const subject = getHeader("Subject");
  const messageIdHeader = getHeader("Message-ID");
  const references = getHeader("References");

  const replySubject = subject.startsWith("Re:") ? subject : `Re: ${subject}`;
  const replyReferences = references ? `${references} ${messageIdHeader}` : messageIdHeader;

  const headers = [
    `To: ${from}`,
    `Subject: ${replySubject}`,
    `In-Reply-To: ${messageIdHeader}`,
    `References: ${replyReferences}`,
    `Content-Type: text/plain; charset="UTF-8"`,
  ];

  const rawMessage = `${headers.join("\r\n")}\r\n\r\n${comment}`;
  const encoded = Buffer.from(rawMessage).toString("base64url");

  const resp = await gmailFetch(token, "/messages/send", {
    method: "POST",
    body: JSON.stringify({ raw: encoded, threadId: original.threadId }),
  });
  return resp !== null && !resp._error;
}

/**
 * Forward an email.
 */
async function forwardEmail(token, messageId, to, comment) {
  // Get original message
  const original = await gmailFetch(token, `/messages/${messageId}?format=full`);
  if (!original || original._error) return false;

  const getHeader = (name) => {
    const h = original.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase());
    return h?.value || "";
  };

  const subject = getHeader("Subject");
  const fwdSubject = subject.startsWith("Fwd:") ? subject : `Fwd: ${subject}`;
  const originalBody = extractBody(original.payload);

  const toStr = Array.isArray(to) ? to.join(", ") : (typeof to === "string" ? to : "");
  const headers = [
    `To: ${toStr}`,
    `Subject: ${fwdSubject}`,
    `Content-Type: text/plain; charset="UTF-8"`,
  ];

  const body = comment ? `${comment}\r\n\r\n---------- Forwarded message ----------\r\n${originalBody}` : originalBody;
  const rawMessage = `${headers.join("\r\n")}\r\n\r\n${body}`;
  const encoded = Buffer.from(rawMessage).toString("base64url");

  const resp = await gmailFetch(token, "/messages/send", {
    method: "POST",
    body: JSON.stringify({ raw: encoded }),
  });
  return resp !== null && !resp._error;
}

// ── Management Operations ────────────────────────────────

/**
 * Mark email as read (remove UNREAD label).
 */
async function markAsRead(token, messageId) {
  return modifyLabels(token, messageId, [], ["UNREAD"]);
}

/**
 * Mark email as unread (add UNREAD label).
 */
async function markAsUnread(token, messageId) {
  return modifyLabels(token, messageId, ["UNREAD"], []);
}

/**
 * Star an email (Gmail equivalent of flag).
 */
async function flagEmail(token, messageId) {
  return modifyLabels(token, messageId, ["STARRED"], []);
}

/**
 * Unstar an email.
 */
async function unflagEmail(token, messageId) {
  return modifyLabels(token, messageId, [], ["STARRED"]);
}

/**
 * Move email to a label/folder.
 */
async function moveToFolder(token, messageId, folderName) {
  const labelId = await resolveLabelId(token, folderName);
  if (!labelId) return false;
  // Remove from INBOX, add target label
  return modifyLabels(token, messageId, [labelId], ["INBOX"]);
}

/**
 * Archive an email (remove INBOX label).
 */
async function archiveEmail(token, messageId) {
  return modifyLabels(token, messageId, [], ["INBOX"]);
}

/**
 * Trash an email.
 */
async function trashEmail(token, messageId) {
  const resp = await gmailFetch(token, `/messages/${messageId}/trash`, { method: "POST" });
  return resp !== null && !resp._error;
}

/**
 * Get labels (Gmail folders).
 */
async function getFolders(token) {
  const resp = await gmailFetch(token, "/labels");
  if (!resp || resp._error || !resp.labels) return [];
  return resp.labels.map(l => ({
    id: l.id,
    name: l.name,
    unread: l.messagesUnread || 0,
    total: l.messagesTotal || 0,
  }));
}

// ── Internal Helpers ─────────────────────────────────────

async function gmailFetch(token, path, options = {}) {
  const url = path.startsWith("http") ? path : `${GMAIL_BASE}${path}`;
  try {
    const resp = await fetch(url, {
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
      body: options.body,
      signal: AbortSignal.timeout(15000),
    });

    if (resp.status === 204 || resp.status === 202) return {};
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error(`${LOG} Gmail API ${resp.status} on ${path.substring(0, 80)}: ${errText.substring(0, 200)}`);

      if (resp.status === 429) {
        const retryAfter = resp.headers.get("Retry-After") || "60";
        return { _error: true, status: 429, retryAfter: parseInt(retryAfter, 10) };
      }
      return { _error: true, status: resp.status, message: errText.substring(0, 200) };
    }

    return await resp.json();
  } catch (err) {
    console.error(`${LOG} Gmail API error on ${path.substring(0, 80)}:`, err.message);
    return null;
  }
}

/**
 * Fetch a list of message IDs and then get metadata for each.
 */
async function fetchMessageList(token, params) {
  const resp = await gmailFetch(token, `/messages?${params}`);
  if (!resp || resp._error) return resp;
  if (!resp.messages || resp.messages.length === 0) return [];

  // Batch-fetch metadata for each message
  const emails = [];
  for (const msg of resp.messages) {
    const detail = await gmailFetch(token, `/messages/${msg.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=To&metadataHeaders=Cc&metadataHeaders=Date&metadataHeaders=Importance`);
    if (detail && !detail._error) {
      emails.push(normalizeEmail(detail, false));
    }
  }
  return emails;
}

/**
 * Normalize a Gmail message to the same format as graph.js normalizeEmail.
 */
function normalizeEmail(msg, includeBody) {
  const getHeader = (name) => {
    const h = msg.payload?.headers?.find(h => h.name.toLowerCase() === name.toLowerCase());
    return h?.value || "";
  };

  const from = getHeader("From");
  const fromEmail = extractEmailAddress(from);
  const fromName = extractDisplayName(from) || fromEmail;
  const labels = msg.labelIds || [];

  const result = {
    id: msg.id,
    subject: getHeader("Subject") || "(no subject)",
    from: fromName,
    fromEmail: fromEmail,
    receivedAt: msg.internalDate ? new Date(parseInt(msg.internalDate, 10)).toISOString() : getHeader("Date"),
    preview: (msg.snippet || "").substring(0, 200),
    isRead: !labels.includes("UNREAD"),
    importance: getHeader("Importance")?.toLowerCase() === "high" || labels.includes("IMPORTANT") ? "high" : "normal",
    hasAttachments: hasAttachments(msg.payload),
    conversationId: msg.threadId,
  };

  if (includeBody && msg.payload) {
    let bodyText = extractBody(msg.payload);
    result.body = bodyText.substring(0, 15000);
  }

  const to = getHeader("To");
  if (to) result.to = to;
  const cc = getHeader("Cc");
  if (cc) result.cc = cc;
  if (labels.includes("STARRED")) result.flagged = true;

  return result;
}

/**
 * Extract plain text body from a Gmail message payload.
 */
function extractBody(payload) {
  if (!payload) return "";

  // Direct body
  if (payload.body?.data) {
    const decoded = Buffer.from(payload.body.data, "base64url").toString("utf8");
    if (payload.mimeType === "text/plain") return decoded;
    if (payload.mimeType === "text/html") return stripHtml(decoded);
  }

  // Multipart — prefer text/plain
  if (payload.parts) {
    // First look for text/plain
    for (const part of payload.parts) {
      if (part.mimeType === "text/plain" && part.body?.data) {
        return Buffer.from(part.body.data, "base64url").toString("utf8");
      }
    }
    // Fall back to text/html
    for (const part of payload.parts) {
      if (part.mimeType === "text/html" && part.body?.data) {
        return stripHtml(Buffer.from(part.body.data, "base64url").toString("utf8"));
      }
    }
    // Recurse into nested multipart
    for (const part of payload.parts) {
      if (part.parts) {
        const nested = extractBody(part);
        if (nested) return nested;
      }
    }
  }

  return "";
}

function stripHtml(html) {
  let text = html.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
  text = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return text;
}

function hasAttachments(payload) {
  if (!payload) return false;
  if (payload.filename && payload.filename.length > 0 && payload.body?.attachmentId) return true;
  if (payload.parts) {
    return payload.parts.some(p => hasAttachments(p));
  }
  return false;
}

function extractEmailAddress(fromHeader) {
  const match = fromHeader.match(/<([^>]+)>/);
  return match ? match[1] : fromHeader.trim();
}

function extractDisplayName(fromHeader) {
  const match = fromHeader.match(/^"?([^"<]+)"?\s*</);
  return match ? match[1].trim() : "";
}

async function modifyLabels(token, messageId, addLabels, removeLabels) {
  const resp = await gmailFetch(token, `/messages/${messageId}/modify`, {
    method: "POST",
    body: JSON.stringify({
      addLabelIds: addLabels,
      removeLabelIds: removeLabels,
    }),
  });
  return resp !== null && !resp._error;
}

async function resolveLabelId(token, labelName) {
  const lower = labelName.toLowerCase();
  // Well-known Gmail labels
  const wellKnown = {
    inbox: "INBOX", sent: "SENT", drafts: "DRAFT",
    trash: "TRASH", spam: "SPAM", starred: "STARRED",
    important: "IMPORTANT", unread: "UNREAD",
  };
  if (wellKnown[lower]) return wellKnown[lower];

  // Search custom labels
  const labels = await getFolders(token);
  const match = labels.find(l => l.name.toLowerCase() === lower);
  return match?.id || null;
}

module.exports = {
  // Read
  getUnreadEmails,
  getRecentEmails,
  searchEmails,
  getEmailsFromSender,
  getEmailById,
  getEmailThread,
  getUserProfile,
  // Write
  sendEmail,
  replyToEmail,
  forwardEmail,
  // Manage
  markAsRead,
  markAsUnread,
  flagEmail,
  unflagEmail,
  moveToFolder,
  archiveEmail,
  trashEmail,
  getFolders,
};
