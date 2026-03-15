/**
 * Microsoft Graph API Connector — Outlook Email Operations
 *
 * All methods require a valid access token (from auth.js).
 * Uses Node 22 built-in fetch — no extra dependencies.
 */

const LOG = "[M365-Graph]";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

// ── Read Operations ──────────────────────────────────────

/**
 * Get unread emails from inbox.
 * Returns array of { id, subject, from, receivedAt, preview, isRead, importance, hasAttachments }
 */
async function getUnreadEmails(token, top = 20) {
  const params = new URLSearchParams({
    $filter: "isRead eq false",
    $orderby: "receivedDateTime desc",
    $top: String(top),
    $select: "id,subject,from,receivedDateTime,bodyPreview,isRead,importance,hasAttachments,conversationId",
  });
  return fetchEmails(token, `/me/mailFolders/inbox/messages?${params}`);
}

/**
 * Get recent emails from inbox (read and unread).
 */
async function getRecentEmails(token, top = 20) {
  const params = new URLSearchParams({
    $orderby: "receivedDateTime desc",
    $top: String(top),
    $select: "id,subject,from,receivedDateTime,bodyPreview,isRead,importance,hasAttachments,conversationId",
  });
  return fetchEmails(token, `/me/mailFolders/inbox/messages?${params}`);
}

/**
 * Search emails by query string (searches subject, body, from).
 */
async function searchEmails(token, query, top = 20) {
  const params = new URLSearchParams({
    $search: `"${query}"`,
    $orderby: "receivedDateTime desc",
    $top: String(top),
    $select: "id,subject,from,receivedDateTime,bodyPreview,isRead,importance,hasAttachments,conversationId",
  });
  return fetchEmails(token, `/me/messages?${params}`);
}

/**
 * Search emails from a specific sender.
 */
async function getEmailsFromSender(token, senderName, top = 10) {
  const cleanName = senderName.replace(/"/g, '\\"');
  const select = "id,subject,from,receivedDateTime,bodyPreview,isRead,importance,hasAttachments,conversationId";

  // Broad search — finds name in from, subject, body
  const params = new URLSearchParams({ $search: `"${cleanName}"`, $top: String(top), $select: select });
  const results = await fetchEmails(token, `/me/messages?${params}`);

  if (!results || results._error || results.length === 0) return results || [];

  // Filter to emails where sender contains the search term
  const filtered = results.filter(e =>
    (e.from || "").toLowerCase().includes(cleanName.toLowerCase()) ||
    (e.fromEmail || "").toLowerCase().includes(cleanName.toLowerCase())
  );

  return filtered.length > 0 ? filtered : results;
}

/**
 * Get full email by ID (includes body).
 */
async function getEmailById(token, messageId) {
  const params = new URLSearchParams({
    $select: "id,subject,from,toRecipients,ccRecipients,receivedDateTime,body,bodyPreview,isRead,importance,hasAttachments,conversationId,flag",
  });
  const resp = await graphFetch(token, `/me/messages/${messageId}?${params}`);
  if (!resp) return null;
  return normalizeEmail(resp, true);
}

/**
 * Get email thread (all messages in the same conversation).
 */
async function getEmailThread(token, conversationId, top = 30) {
  const params = new URLSearchParams({
    $filter: `conversationId eq '${conversationId}'`,
    $orderby: "receivedDateTime asc",
    $top: String(top),
    $select: "id,subject,from,toRecipients,receivedDateTime,bodyPreview,isRead,importance,hasAttachments",
  });
  return fetchEmails(token, `/me/messages?${params}`);
}

/**
 * Get user profile info.
 */
async function getUserProfile(token) {
  return graphFetch(token, "/me?$select=displayName,mail,userPrincipalName");
}

// ── Write Operations ─────────────────────────────────────

/**
 * Send a new email.
 */
async function sendEmail(token, { to, subject, body, cc, importance }) {
  const message = {
    subject,
    body: { contentType: "Text", content: body },
    toRecipients: arrayifyRecipients(to),
    importance: importance || "normal",
  };
  if (cc) message.ccRecipients = arrayifyRecipients(cc);

  const resp = await graphFetch(token, "/me/sendMail", {
    method: "POST",
    body: JSON.stringify({ message, saveToSentItems: true }),
  });
  return resp !== null; // sendMail returns 202 with no body
}

/**
 * Reply to an email.
 */
async function replyToEmail(token, messageId, comment) {
  const resp = await graphFetch(token, `/me/messages/${messageId}/reply`, {
    method: "POST",
    body: JSON.stringify({ comment }),
  });
  return resp !== null;
}

/**
 * Forward an email.
 */
async function forwardEmail(token, messageId, to, comment) {
  const resp = await graphFetch(token, `/me/messages/${messageId}/forward`, {
    method: "POST",
    body: JSON.stringify({
      comment: comment || "",
      toRecipients: arrayifyRecipients(to),
    }),
  });
  return resp !== null;
}

// ── Management Operations ────────────────────────────────

/**
 * Mark email as read.
 */
async function markAsRead(token, messageId) {
  return patchEmail(token, messageId, { isRead: true });
}

/**
 * Mark email as unread.
 */
async function markAsUnread(token, messageId) {
  return patchEmail(token, messageId, { isRead: false });
}

/**
 * Flag an email.
 */
async function flagEmail(token, messageId) {
  return patchEmail(token, messageId, { flag: { flagStatus: "flagged" } });
}

/**
 * Unflag an email.
 */
async function unflagEmail(token, messageId) {
  return patchEmail(token, messageId, { flag: { flagStatus: "notFlagged" } });
}

/**
 * Move email to a folder (by folder name or ID).
 */
async function moveToFolder(token, messageId, folderName) {
  // Resolve folder name to ID
  const folderId = await resolveFolderId(token, folderName);
  if (!folderId) return false;

  const resp = await graphFetch(token, `/me/messages/${messageId}/move`, {
    method: "POST",
    body: JSON.stringify({ destinationId: folderId }),
  });
  return resp !== null;
}

/**
 * Archive an email (move to Archive folder).
 */
async function archiveEmail(token, messageId) {
  return moveToFolder(token, messageId, "archive");
}

/**
 * Get mail folders.
 */
async function getFolders(token) {
  const resp = await graphFetch(token, "/me/mailFolders?$top=50");
  if (!resp || !resp.value) return [];
  return resp.value.map(f => ({ id: f.id, name: f.displayName, unread: f.unreadItemCount, total: f.totalItemCount }));
}

// ── Internal Helpers ─────────────────────────────────────

async function graphFetch(token, path, options = {}) {
  const url = path.startsWith("http") ? path : `${GRAPH_BASE}${path}`;
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

    if (resp.status === 204 || resp.status === 202) return {}; // success, no body
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error(`${LOG} Graph API ${resp.status} on ${path.substring(0, 80)}: ${errText.substring(0, 200)}`);

      // Return error info for throttling
      if (resp.status === 429) {
        const retryAfter = resp.headers.get("Retry-After") || "60";
        return { _error: true, status: 429, retryAfter: parseInt(retryAfter, 10) };
      }
      return { _error: true, status: resp.status, message: errText.substring(0, 200) };
    }

    return await resp.json();
  } catch (err) {
    console.error(`${LOG} Graph API error on ${path.substring(0, 80)}:`, err.message);
    return null;
  }
}

async function fetchEmails(token, path) {
  const resp = await graphFetch(token, path);
  if (!resp || resp._error) return resp;
  if (!resp.value) return [];
  return resp.value.map(e => normalizeEmail(e, false));
}

function normalizeEmail(e, includeBody) {
  const result = {
    id: e.id,
    subject: e.subject || "(no subject)",
    from: e.from?.emailAddress?.name || e.from?.emailAddress?.address || "unknown",
    fromEmail: e.from?.emailAddress?.address || "",
    receivedAt: e.receivedDateTime,
    preview: (e.bodyPreview || "").substring(0, 200),
    isRead: e.isRead,
    importance: e.importance,
    hasAttachments: e.hasAttachments,
    conversationId: e.conversationId,
  };
  if (includeBody && e.body) {
    // Strip HTML tags for AI consumption
    let bodyText = e.body.content || "";
    if (e.body.contentType === "html" || e.body.contentType === "HTML") {
      bodyText = bodyText.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
      bodyText = bodyText.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    }
    result.body = bodyText.substring(0, 15000);
  }
  if (e.toRecipients) {
    result.to = e.toRecipients.map(r => r.emailAddress?.name || r.emailAddress?.address).join(", ");
  }
  if (e.ccRecipients) {
    result.cc = e.ccRecipients.map(r => r.emailAddress?.name || r.emailAddress?.address).join(", ");
  }
  if (e.flag) {
    result.flagged = e.flag.flagStatus === "flagged";
  }
  return result;
}

async function patchEmail(token, messageId, patch) {
  const resp = await graphFetch(token, `/me/messages/${messageId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return resp !== null && !resp._error;
}

async function resolveFolderId(token, folderName) {
  const lower = folderName.toLowerCase();
  // Well-known folder names
  const wellKnown = {
    inbox: "inbox", sent: "sentitems", drafts: "drafts",
    deleted: "deleteditems", trash: "deleteditems", junk: "junkemail",
    archive: "archive", outbox: "outbox",
  };
  if (wellKnown[lower]) return wellKnown[lower];

  // Search by display name
  const folders = await getFolders(token);
  const match = folders.find(f => f.name.toLowerCase() === lower);
  return match?.id || null;
}

function arrayifyRecipients(recipients) {
  if (typeof recipients === "string") {
    return recipients.split(/[,;]\s*/).map(addr => ({
      emailAddress: { address: addr.trim() },
    }));
  }
  if (Array.isArray(recipients)) {
    return recipients.map(r => {
      if (typeof r === "string") return { emailAddress: { address: r } };
      return r;
    });
  }
  return [];
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
  getFolders,
};
