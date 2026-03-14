/**
 * SharePoint / OneDrive API Connector — Document Operations
 *
 * Uses Microsoft Graph API for SharePoint document access.
 * All methods require a valid M365 access token (from auth.js).
 * Requires scopes: Sites.Read.All, Files.Read.All
 *
 * Uses Node 22 built-in fetch — no extra dependencies.
 */

const LOG = "[SharePoint-API]";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

// ── Search ──────────────────────────────────────────────

/**
 * Search documents across SharePoint and OneDrive.
 */
async function searchDocuments(token, query, top = 10) {
  const resp = await graphFetch(token, "/search/query", {
    method: "POST",
    body: JSON.stringify({
      requests: [{
        entityTypes: ["driveItem"],
        query: { queryString: query },
        from: 0,
        size: top,
        fields: ["name", "webUrl", "lastModifiedDateTime", "lastModifiedBy", "size", "parentReference", "createdBy", "createdDateTime"],
      }],
    }),
  });

  if (!resp || resp._error) return resp;
  const hits = resp.value?.[0]?.hitsContainers?.[0]?.hits || [];
  return hits.map(h => normalizeDocument(h.resource));
}

/**
 * List recent documents from user's OneDrive.
 */
async function getRecentDocuments(token, top = 10) {
  const resp = await graphFetch(token, `/me/drive/recent?$top=${top}`);
  if (!resp || resp._error) return resp;
  if (!resp.value) return [];
  return resp.value.map(normalizeDocument);
}

/**
 * List documents in a specific SharePoint site/drive folder.
 */
async function listFolderContents(token, driveId, folderId, top = 20) {
  const path = folderId
    ? `/drives/${driveId}/items/${folderId}/children?$top=${top}&$orderby=lastModifiedDateTime desc`
    : `/drives/${driveId}/root/children?$top=${top}&$orderby=lastModifiedDateTime desc`;
  const resp = await graphFetch(token, path);
  if (!resp || resp._error) return resp;
  if (!resp.value) return [];
  return resp.value.map(normalizeDocument);
}

// ── Get Document Info ───────────────────────────────────

/**
 * Get document metadata by ID.
 */
async function getDocumentById(token, driveId, itemId) {
  const resp = await graphFetch(token, `/drives/${driveId}/items/${itemId}`);
  if (!resp || resp._error) return resp;
  return normalizeDocument(resp);
}

/**
 * Get document by path (e.g. "/Documents/report.docx").
 */
async function getDocumentByPath(token, sitePath) {
  const resp = await graphFetch(token, `/me/drive/root:${sitePath}`);
  if (!resp || resp._error) return resp;
  return normalizeDocument(resp);
}

// ── Download & Content Extraction ───────────────────────

/**
 * Download document content (returns Buffer).
 */
async function downloadDocument(token, driveId, itemId) {
  const url = `${GRAPH_BASE}/drives/${driveId}/items/${itemId}/content`;
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      console.error(`${LOG} Download failed: ${resp.status}`);
      return null;
    }

    const buffer = Buffer.from(await resp.arrayBuffer());
    return buffer;
  } catch (err) {
    console.error(`${LOG} Download error:`, err.message);
    return null;
  }
}

/**
 * Download from user's OneDrive by item ID.
 */
async function downloadMyDocument(token, itemId) {
  const url = `${GRAPH_BASE}/me/drive/items/${itemId}/content`;
  try {
    const resp = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
      redirect: "follow",
      signal: AbortSignal.timeout(30000),
    });

    if (!resp.ok) {
      console.error(`${LOG} Download failed: ${resp.status}`);
      return null;
    }

    return Buffer.from(await resp.arrayBuffer());
  } catch (err) {
    console.error(`${LOG} Download error:`, err.message);
    return null;
  }
}

/**
 * Extract text content from a document (for summarization).
 * Supports: .txt, .csv, .md — via direct download
 * For .docx, .pdf, .pptx — returns download URL for bot to process with existing extractors
 */
async function extractDocumentContent(token, doc) {
  const name = (doc.name || "").toLowerCase();
  const ext = name.split(".").pop();

  // Text-based files: download and return content directly
  if (["txt", "csv", "md", "json", "xml", "html", "css", "js", "py", "sql", "yaml", "yml"].includes(ext)) {
    const driveId = doc.driveId || doc.parentReference?.driveId;
    const buffer = driveId
      ? await downloadDocument(token, driveId, doc.id)
      : await downloadMyDocument(token, doc.id);
    if (!buffer) return { type: "error", error: "Failed to download" };
    return { type: "text", content: buffer.toString("utf8").substring(0, 30000) };
  }

  // Binary documents: return metadata + download info for bot's existing processors
  if (["docx", "pdf", "pptx", "xlsx"].includes(ext)) {
    const driveId = doc.driveId || doc.parentReference?.driveId;
    const buffer = driveId
      ? await downloadDocument(token, driveId, doc.id)
      : await downloadMyDocument(token, doc.id);
    if (!buffer) return { type: "error", error: "Failed to download" };
    return { type: ext, buffer, name: doc.name };
  }

  return { type: "unsupported", message: `Cannot extract content from .${ext} files` };
}

// ── SharePoint Sites ────────────────────────────────────

/**
 * Search SharePoint sites.
 */
async function searchSites(token, query) {
  const resp = await graphFetch(token, `/sites?search=${encodeURIComponent(query)}&$top=10`);
  if (!resp || resp._error) return resp;
  if (!resp.value) return [];
  return resp.value.map(s => ({
    id: s.id,
    name: s.displayName || s.name,
    url: s.webUrl,
    description: s.description || "",
  }));
}

/**
 * Get drives (document libraries) for a site.
 */
async function getSiteDrives(token, siteId) {
  const resp = await graphFetch(token, `/sites/${siteId}/drives`);
  if (!resp || resp._error) return resp;
  if (!resp.value) return [];
  return resp.value.map(d => ({
    id: d.id,
    name: d.name,
    type: d.driveType,
    url: d.webUrl,
    quota: d.quota ? { total: d.quota.total, used: d.quota.used } : null,
  }));
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

    if (resp.status === 204 || resp.status === 202) return {};
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error(`${LOG} Graph API ${resp.status} on ${path.substring(0, 80)}: ${errText.substring(0, 200)}`);
      if (resp.status === 429) {
        const retryAfter = resp.headers.get("Retry-After") || "60";
        return { _error: true, status: 429, retryAfter: parseInt(retryAfter, 10) };
      }
      return { _error: true, status: resp.status, message: errText.substring(0, 200) };
    }

    const text = await resp.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    console.error(`${LOG} Graph API error on ${path.substring(0, 80)}:`, err.message);
    return null;
  }
}

function normalizeDocument(item) {
  return {
    id: item.id,
    name: item.name || "",
    webUrl: item.webUrl || "",
    size: item.size || 0,
    mimeType: item.file?.mimeType || "",
    isFolder: !!item.folder,
    createdAt: item.createdDateTime || "",
    modifiedAt: item.lastModifiedDateTime || "",
    createdBy: item.createdBy?.user?.displayName || "",
    modifiedBy: item.lastModifiedBy?.user?.displayName || "",
    driveId: item.parentReference?.driveId || "",
    path: item.parentReference?.path || "",
  };
}

function formatFileSize(bytes) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let size = bytes;
  while (size >= 1024 && i < units.length - 1) { size /= 1024; i++; }
  return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

module.exports = {
  searchDocuments,
  getRecentDocuments,
  listFolderContents,
  getDocumentById,
  getDocumentByPath,
  downloadDocument,
  downloadMyDocument,
  extractDocumentContent,
  searchSites,
  getSiteDrives,
  formatFileSize,
};
