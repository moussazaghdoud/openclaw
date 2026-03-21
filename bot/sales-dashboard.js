/**
 * Sales Dashboard — 3-Step PII Visualization
 *
 * Provides 3 web pages showing the data journey:
 *   /sales/raw         — Raw Salesforce data (before anonymization)
 *   /sales/anonymized  — Anonymized data (what AI sees)
 *   /sales/result      — Final AI response (what user receives)
 *
 * Captures data at each stage of the pipeline analysis flow
 * to demonstrate PII protection transparently.
 */

const crypto = require("crypto");
const LOG = "[Sales-Dashboard]";

let piiModule = null;
let redisClient = null;

// Store multiple sessions, keyed by unique session ID
// Each session: { id, raw, anonymized, result }
const sessions = new Map();
const MAX_SESSIONS = 50; // keep last 50 sessions

// Current session being built (set during a tool execution)
let currentSessionId = null;

function init(app, deps) {
  piiModule = deps.pii || null;
  redisClient = deps.redis || null;

  // Session-specific routes: /sales/dashboard/:id, /sales/raw/:id, etc.
  app.get("/sales/dashboard/:id", (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).send(renderNotFound());
    res.send(renderDashboard(session));
  });
  app.get("/sales/raw/:id", (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).send(renderNotFound());
    res.send(renderPage("raw", session));
  });
  app.get("/sales/anonymized/:id", (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).send(renderNotFound());
    res.send(renderPage("anonymized", session));
  });
  app.get("/sales/result/:id", (req, res) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).send(renderNotFound());
    res.send(renderPage("result", session));
  });
  // List all sessions
  app.get("/sales/history", (req, res) => res.send(renderHistory()));

  console.log(`${LOG} Dashboard routes registered (/sales/dashboard/:id, /sales/history)`);
}

// ══════════════════════════════════════════════════════════
// DATA CAPTURE
// ══════════════════════════════════════════════════════════

let newDataFlag = false;

function hasNewData() {
  const had = newDataFlag;
  newDataFlag = false;
  return had;
}

/**
 * Get the current session ID (returns the URL path for the dashboard link).
 */
function getCurrentSessionId() {
  return currentSessionId;
}

function captureRaw(userId, query, data) {
  // Reuse current session if one exists (multiple tools in same agent run)
  if (currentSessionId && sessions.has(currentSessionId)) {
    const session = sessions.get(currentSessionId);
    // Merge data into existing raw
    if (session.raw && session.raw.data) {
      // Append tool results
      if (!session.raw.toolResults) session.raw.toolResults = [session.raw.data];
      session.raw.toolResults.push(data);
      session.raw.data = data; // keep latest as primary
    }
    console.log(`${LOG} Updated RAW stage — session ${currentSessionId} (tool: ${query})`);
    newDataFlag = true;
    return;
  }

  // Create a new session
  const id = crypto.randomBytes(6).toString("hex");
  currentSessionId = id;

  const session = {
    id,
    createdAt: new Date().toISOString(),
    userId,
    query,
    raw: { timestamp: new Date().toISOString(), userId, query, data },
    anonymized: null,
    result: null,
  };
  sessions.set(id, session);
  newDataFlag = true;

  // Prune old sessions
  if (sessions.size > MAX_SESSIONS) {
    const oldest = sessions.keys().next().value;
    sessions.delete(oldest);
  }

  console.log(`${LOG} Captured RAW stage — session ${id}`);
}

function captureAnonymized(userId, data, mapping) {
  if (!currentSessionId || !sessions.has(currentSessionId)) return;
  const session = sessions.get(currentSessionId);
  session.anonymized = {
    timestamp: new Date().toISOString(),
    userId,
    data,
    mapping,
  };
  console.log(`${LOG} Captured ANONYMIZED stage — session ${currentSessionId} (${Object.keys(mapping || {}).length} replacements)`);
}

function captureResult(userId, response) {
  if (!currentSessionId || !sessions.has(currentSessionId)) return;
  const session = sessions.get(currentSessionId);
  session.result = {
    timestamp: new Date().toISOString(),
    userId,
    response,
  };
  console.log(`${LOG} Captured RESULT stage — session ${currentSessionId}`);
  // Reset so next request creates a new session
  const completedId = currentSessionId;
  currentSessionId = null;
  return completedId;
}

// ══════════════════════════════════════════════════════════
// ANONYMIZATION HELPER
// ══════════════════════════════════════════════════════════

/**
 * Anonymize Salesforce data for AI consumption.
 * Replaces account names, owner names, deal names with placeholders.
 * Returns { anonymizedText, mapping }.
 */
function anonymizeSalesData(text) {
  if (!text) return { anonymizedText: "", mapping: {} };

  const mapping = {};
  let result = typeof text === "string" ? text : JSON.stringify(text, null, 2);
  let counters = { account: 0, person: 0, deal: 0 };

  // We do our own sales-specific anonymization:
  // Extract and replace structured data patterns
  // Account names, owner names, deal names from the JSON

  if (typeof text === "object") {
    // Deep clone for anonymization
    const clone = JSON.parse(JSON.stringify(text));
    anonymizeObject(clone, mapping, counters);
    return { anonymizedData: clone, anonymizedText: JSON.stringify(clone, null, 2), mapping };
  }

  return { anonymizedData: text, anonymizedText: result, mapping };
}

function anonymizeObject(obj, mapping, counters) {
  if (!obj || typeof obj !== "object") return;

  if (Array.isArray(obj)) {
    for (const item of obj) anonymizeObject(item, mapping, counters);
    return;
  }

  for (const [key, value] of Object.entries(obj)) {
    if (typeof value === "string" && value.trim()) {
      const lk = key.toLowerCase();

      // Account / company names
      if (lk === "account" || lk === "accountname" || lk === "account_name") {
        const placeholder = getOrCreatePlaceholder(mapping, value, "ACCOUNT", counters, "account");
        if (placeholder) obj[key] = placeholder;
      }
      // Person / owner names
      else if (lk === "owner" || lk === "ownername" || lk === "owner_name" || lk === "contact" ||
               lk === "name" && isPersonName(value)) {
        const placeholder = getOrCreatePlaceholder(mapping, value, "PERSON", counters, "person");
        if (placeholder) obj[key] = placeholder;
      }
      // Deal / opportunity names
      else if (lk === "deal" || lk === "opportunity" || (lk === "name" && !isPersonName(value))) {
        const placeholder = getOrCreatePlaceholder(mapping, value, "DEAL", counters, "deal");
        if (placeholder) obj[key] = placeholder;
      }
      // Email addresses
      else if (lk === "email" && value.includes("@")) {
        const placeholder = getOrCreatePlaceholder(mapping, value, "EMAIL", counters, "person");
        if (placeholder) obj[key] = placeholder;
      }
    } else if (typeof value === "object") {
      anonymizeObject(value, mapping, counters);
    }
  }
}

function getOrCreatePlaceholder(mapping, value, type, counters, counterKey) {
  if (!value || value === "N/A" || value === "Unassigned" || value === "(none)" || value === "shared") return null;

  // Check if already mapped
  for (const [placeholder, original] of Object.entries(mapping)) {
    if (original === value) return placeholder;
  }

  counters[counterKey]++;
  const placeholder = `[${type}_${counters[counterKey]}]`;
  mapping[placeholder] = value;
  return placeholder;
}

function isPersonName(value) {
  // Simple heuristic: if it contains a space and no special chars, likely a person name
  return /^[A-Z][a-z]+ [A-Z]/.test(value) && !/[0-9$€£#@]/.test(value);
}

// ══════════════════════════════════════════════════════════
// HTML RENDERING
// ══════════════════════════════════════════════════════════

const CSS = `
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #f8f9fa; color: #1a1a2e; }
  .header { background: linear-gradient(135deg, #1a1a2e 0%, #16213e 100%); color: white; padding: 24px 40px; }
  .header h1 { font-size: 22px; font-weight: 600; }
  .header .subtitle { color: #a0aec0; font-size: 13px; margin-top: 4px; }
  .nav { display: flex; gap: 0; background: #16213e; padding: 0 40px; }
  .nav a { color: #a0aec0; text-decoration: none; padding: 12px 20px; font-size: 13px; font-weight: 500;
           border-bottom: 2px solid transparent; transition: all 0.2s; }
  .nav a:hover { color: white; background: rgba(255,255,255,0.05); }
  .nav a.active { color: #60a5fa; border-bottom-color: #60a5fa; }
  .container { max-width: 1200px; margin: 24px auto; padding: 0 24px; }
  .card { background: white; border-radius: 12px; box-shadow: 0 1px 3px rgba(0,0,0,0.08); margin-bottom: 20px; overflow: hidden; }
  .card-header { padding: 16px 24px; border-bottom: 1px solid #e2e8f0; display: flex; align-items: center; justify-content: space-between; }
  .card-header h2 { font-size: 16px; font-weight: 600; }
  .card-body { padding: 24px; }
  .badge { display: inline-block; padding: 3px 10px; border-radius: 12px; font-size: 11px; font-weight: 600; }
  .badge-blue { background: #dbeafe; color: #1d4ed8; }
  .badge-green { background: #dcfce7; color: #15803d; }
  .badge-red { background: #fee2e2; color: #dc2626; }
  .badge-yellow { background: #fef3c7; color: #b45309; }
  .badge-purple { background: #ede9fe; color: #7c3aed; }
  .timestamp { color: #94a3b8; font-size: 12px; }
  .empty { text-align: center; padding: 60px 20px; color: #94a3b8; }
  .empty h3 { font-size: 18px; margin-bottom: 8px; color: #64748b; }
  pre { background: #f1f5f9; border-radius: 8px; padding: 16px; font-size: 12px; line-height: 1.6;
        overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; padding: 10px 12px; background: #f8fafc; color: #64748b; font-weight: 600;
       font-size: 11px; text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 2px solid #e2e8f0; }
  td { padding: 10px 12px; border-bottom: 1px solid #f1f5f9; vertical-align: top; }
  tr:hover td { background: #f8fafc; }
  .amount { font-weight: 600; color: #059669; }
  .risk-high { color: #dc2626; font-weight: 600; }
  .risk-medium { color: #d97706; font-weight: 600; }
  .risk-low { color: #16a34a; }
  .mapping-table td:first-child { font-family: monospace; color: #7c3aed; font-weight: 600; }
  .mapping-table td:last-child { color: #dc2626; }
  .step-indicator { display: flex; align-items: center; gap: 8px; margin-bottom: 20px; }
  .step { width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center;
          font-weight: 700; font-size: 14px; }
  .step-active { background: #3b82f6; color: white; }
  .step-done { background: #22c55e; color: white; }
  .step-pending { background: #e2e8f0; color: #94a3b8; }
  .step-line { width: 40px; height: 2px; background: #e2e8f0; }
  .step-line-done { background: #22c55e; }
  .arrow { font-size: 20px; color: #3b82f6; margin: 0 8px; }
  .highlight { background: #fef3c7; padding: 2px 4px; border-radius: 3px; }
  .result-text { font-size: 14px; line-height: 1.8; white-space: pre-wrap; }
  .auto-refresh { font-size: 11px; color: #94a3b8; }
`;

function renderNav(activePage, sessionId) {
  const s = sessionId ? `/${sessionId}` : "";
  const pages = [
    { id: "dashboard", url: `/sales/dashboard${s}`, label: "Dashboard Overview" },
    { id: "raw", url: `/sales/raw${s}`, label: "Step 1: Raw Salesforce Data" },
    { id: "anonymized", url: `/sales/anonymized${s}`, label: "Step 2: Anonymized Data" },
    { id: "result", url: `/sales/result${s}`, label: "Step 3: Final Result" },
    { id: "history", url: "/sales/history", label: "All Reports" },
  ];
  return `<div class="nav">${pages.map(p =>
    `<a href="${p.url}" class="${p.id === activePage ? 'active' : ''}">${p.label}</a>`
  ).join("")}</div>`;
}

function renderStepIndicator(activeStep) {
  const steps = [
    { n: 1, label: "Salesforce" },
    { n: 2, label: "Anonymize" },
    { n: 3, label: "AI Result" },
  ];
  return `<div class="step-indicator">${steps.map((s, i) => {
    const cls = s.n < activeStep ? "step-done" : s.n === activeStep ? "step-active" : "step-pending";
    const lineClass = s.n < activeStep ? "step-line step-line-done" : "step-line";
    return `<div class="step ${cls}">${s.n}</div><div style="font-size:12px;color:${cls === 'step-active' ? '#3b82f6' : cls === 'step-done' ? '#22c55e' : '#94a3b8'};font-weight:500">${s.label}</div>${i < steps.length - 1 ? `<div class="${lineClass}"></div>` : ''}`;
  }).join("")}</div>`;
}

function fmtAmount(amount) {
  if (!amount || amount === 0) return "$0";
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(0)}K`;
  return `$${amount.toLocaleString()}`;
}

function escHtml(str) {
  if (!str) return "";
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function renderPage(page, session) {
  const stage = session[page];
  let body = "";

  if (!stage) {
    body = `<div class="empty"><h3>Data not yet available for this step</h3><p>This step hasn't completed yet. The page auto-refreshes every 5 seconds.</p></div>`;
  } else if (page === "raw") {
    body = renderRawPage(stage);
  } else if (page === "anonymized") {
    body = renderAnonymizedPage(stage);
  } else if (page === "result") {
    body = renderResultPage(stage);
  }

  const stepNum = page === "raw" ? 1 : page === "anonymized" ? 2 : 3;
  const title = page === "raw" ? "Raw Data" : page === "anonymized" ? "Anonymized" : "Result";

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sales Pipeline — ${title}</title>
<style>${CSS}</style></head><body>
<div class="header"><h1>Sales Pipeline — PII Protection Visualization</h1>
<div class="subtitle">Query: "${escHtml(session.query)}" — Session: ${session.id} — ${session.createdAt}</div></div>
${renderNav(page, session.id)}
<div class="container">
${renderStepIndicator(stepNum)}
${body}
</div></body></html>`;
}

function renderRawPage(stage) {
  const data = stage.data;
  let html = "";

  html += `<div class="card"><div class="card-header"><h2>Raw Salesforce Data</h2>
<div><span class="badge badge-red">SENSITIVE — NOT ANONYMIZED</span> <span class="timestamp">${stage.timestamp}</span></div></div>`;

  html += `<div class="card-body"><p style="margin-bottom:16px;color:#64748b;font-size:13px">
User query: <strong>"${escHtml(stage.query)}"</strong> — This is the raw data fetched from Salesforce containing real company names, deal names, and people names.</p>`;

  // Summary section
  if (data && data.summary) {
    const s = data.summary;
    html += `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:20px">
      <div style="background:#f0fdf4;padding:12px;border-radius:8px;text-align:center">
        <div style="font-size:22px;font-weight:700;color:#059669">${fmtAmount(s.totalPipeline)}</div><div style="font-size:11px;color:#64748b">Total Pipeline</div></div>
      <div style="background:#eff6ff;padding:12px;border-radius:8px;text-align:center">
        <div style="font-size:22px;font-weight:700;color:#2563eb">${s.totalDeals || 0}</div><div style="font-size:11px;color:#64748b">Total Deals</div></div>
      <div style="background:#fef2f2;padding:12px;border-radius:8px;text-align:center">
        <div style="font-size:22px;font-weight:700;color:#dc2626">${s.riskDistribution?.High || 0}</div><div style="font-size:11px;color:#64748b">High Risk</div></div>
      <div style="background:#fefce8;padding:12px;border-radius:8px;text-align:center">
        <div style="font-size:22px;font-weight:700;color:#d97706">${s.riskDistribution?.Medium || 0}</div><div style="font-size:11px;color:#64748b">Medium Risk</div></div>
    </div>`;
  }

  // Deals table
  if (data && data.topRiskDeals && data.topRiskDeals.length > 0) {
    html += `<table><thead><tr><th>#</th><th>Deal Name</th><th>Account</th><th>Owner</th><th>Amount</th><th>Stage</th><th>Risk</th><th>Issues</th></tr></thead><tbody>`;
    data.topRiskDeals.forEach((d, i) => {
      const riskClass = d.riskLevel === "High" ? "risk-high" : d.riskLevel === "Medium" ? "risk-medium" : "risk-low";
      html += `<tr>
        <td>${i + 1}</td>
        <td><strong>${escHtml(d.name)}</strong></td>
        <td>${escHtml(d.account)}</td>
        <td>${escHtml(d.owner)}</td>
        <td class="amount">${fmtAmount(d.amount)}</td>
        <td>${escHtml(d.stage)}</td>
        <td class="${riskClass}">${d.riskLevel} (${d.riskScore})</td>
        <td style="font-size:11px;color:#64748b">${(d.issues || []).join("; ")}</td>
      </tr>`;
    });
    html += `</tbody></table>`;
  }

  html += `</div></div>`;

  // Raw JSON
  html += `<div class="card"><div class="card-header"><h2>Raw JSON</h2><span class="badge badge-blue">Full Payload</span></div>
<div class="card-body"><pre>${escHtml(JSON.stringify(data, null, 2))}</pre></div></div>`;

  return html;
}

function renderAnonymizedPage(stage) {
  const data = stage.data;
  const mapping = stage.mapping || {};
  let html = "";

  html += `<div class="card"><div class="card-header"><h2>Anonymized Data — What AI Sees</h2>
<div><span class="badge badge-green">SAFE — PII REMOVED</span> <span class="timestamp">${stage.timestamp}</span></div></div>`;

  html += `<div class="card-body"><p style="margin-bottom:16px;color:#64748b;font-size:13px">
This is the same data after anonymization. Real names have been replaced with placeholders like [ACCOUNT_1], [PERSON_1], [DEAL_1].
The AI never sees the actual company names, people names, or deal names.</p>`;

  // Mapping table
  if (Object.keys(mapping).length > 0) {
    html += `<div style="margin-bottom:20px"><h3 style="font-size:14px;margin-bottom:8px;color:#7c3aed">Anonymization Mapping (${Object.keys(mapping).length} replacements)</h3>`;
    html += `<table class="mapping-table"><thead><tr><th>Placeholder (AI sees this)</th><th>Original Value (hidden from AI)</th></tr></thead><tbody>`;
    for (const [placeholder, original] of Object.entries(mapping)) {
      html += `<tr><td>${escHtml(placeholder)}</td><td>${escHtml(original)}</td></tr>`;
    }
    html += `</tbody></table></div>`;
  }

  // Anonymized deals table
  if (data && data.topRiskDeals && data.topRiskDeals.length > 0) {
    html += `<table><thead><tr><th>#</th><th>Deal Name</th><th>Account</th><th>Owner</th><th>Amount</th><th>Stage</th><th>Risk</th></tr></thead><tbody>`;
    data.topRiskDeals.forEach((d, i) => {
      const riskClass = d.riskLevel === "High" ? "risk-high" : d.riskLevel === "Medium" ? "risk-medium" : "risk-low";
      html += `<tr>
        <td>${i + 1}</td>
        <td><strong class="highlight">${escHtml(d.name)}</strong></td>
        <td><span class="highlight">${escHtml(d.account)}</span></td>
        <td><span class="highlight">${escHtml(d.owner)}</span></td>
        <td class="amount">${fmtAmount(d.amount)}</td>
        <td>${escHtml(d.stage)}</td>
        <td class="${riskClass}">${d.riskLevel} (${d.riskScore})</td>
      </tr>`;
    });
    html += `</tbody></table>`;
  }

  html += `</div></div>`;

  // Anonymized JSON
  html += `<div class="card"><div class="card-header"><h2>Anonymized JSON</h2><span class="badge badge-purple">Sent to AI</span></div>
<div class="card-body"><pre>${escHtml(JSON.stringify(data, null, 2))}</pre></div></div>`;

  return html;
}

function markdownToHtml(text) {
  if (!text) return "";
  return escHtml(text)
    // Headers
    .replace(/^###\s+(.+)$/gm, '<h3 style="font-size:15px;font-weight:600;color:#1a1a2e;margin:16px 0 8px">$1</h3>')
    .replace(/^##\s+(.+)$/gm, '<h2 style="font-size:17px;font-weight:700;color:#1a1a2e;margin:20px 0 10px">$1</h2>')
    .replace(/^#\s+(.+)$/gm, '<h1 style="font-size:20px;font-weight:700;color:#1a1a2e;margin:24px 0 12px">$1</h1>')
    // Horizontal rule
    .replace(/^[-*_]{3,}$/gm, '<hr style="border:none;border-top:1px solid #e2e8f0;margin:16px 0">')
    // Bold
    .replace(/\*\*([^*]+)\*\*/g, '<strong style="color:#1a1a2e">$1</strong>')
    // Italic
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, '<em>$1</em>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code style="background:#f1f5f9;padding:2px 6px;border-radius:4px;font-size:12px">$1</code>')
    // Numbered lists
    .replace(/^(\d+)\.\s+(.+)$/gm, '<div style="margin:4px 0;padding-left:12px"><span style="color:#3b82f6;font-weight:600">$1.</span> $2</div>')
    // Bullet lists (indented)
    .replace(/^\s+[-•*]\s+(.+)$/gm, '<div style="margin:2px 0;padding-left:28px;color:#475569">◦ $1</div>')
    // Bullet lists
    .replace(/^[-•*]\s+(.+)$/gm, '<div style="margin:4px 0;padding-left:12px">• $1</div>')
    // Double line breaks → paragraph spacing
    .replace(/\n\n/g, '<div style="margin:12px 0"></div>')
    // Single line breaks
    .replace(/\n/g, '<br>');
}

function renderResultPage(stage) {
  let html = "";

  html += `<div class="card"><div class="card-header"><h2>AI Analysis Result</h2>
<div><span class="badge badge-blue">FINAL RESPONSE</span> <span class="timestamp">${stage.timestamp}</span></div></div>`;

  html += `<div class="card-body">`;
  html += `<div style="font-size:14px;line-height:1.8;color:#1e293b">${markdownToHtml(stage.response)}</div>`;
  html += `</div></div>`;

  return html;
}

function renderDashboard(session) {
  const rawReady = !!session.raw;
  const anonReady = !!session.anonymized;
  const resultReady = !!session.result;
  const id = session.id;
  const needsRefresh = !resultReady;

  let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sales Pipeline — Dashboard</title>
<style>${CSS}</style></head><body>
<div class="header"><h1>Sales Pipeline — PII Protection Dashboard</h1>
<div class="subtitle">Query: "${escHtml(session.query)}" — Session: ${id} — ${session.createdAt}</div></div>
${renderNav("dashboard", id)}
<div class="container">

<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-bottom:24px">

<a href="/sales/raw/${id}" style="text-decoration:none">
<div class="card" style="border-left:4px solid ${rawReady ? '#dc2626' : '#e2e8f0'}">
<div class="card-body" style="text-align:center;padding:30px">
<div class="step ${rawReady ? 'step-done' : 'step-pending'}" style="margin:0 auto 12px;width:48px;height:48px;font-size:20px">1</div>
<h3 style="font-size:15px;margin-bottom:4px;color:#1a1a2e">Raw Salesforce Data</h3>
<p style="font-size:12px;color:#94a3b8">${rawReady ? 'Data captured — click to view' : 'Waiting for query...'}</p>
${rawReady ? `<span class="badge badge-red" style="margin-top:8px">SENSITIVE</span>` : ''}
</div></div></a>

<a href="/sales/anonymized/${id}" style="text-decoration:none">
<div class="card" style="border-left:4px solid ${anonReady ? '#22c55e' : '#e2e8f0'}">
<div class="card-body" style="text-align:center;padding:30px">
<div class="step ${anonReady ? 'step-done' : 'step-pending'}" style="margin:0 auto 12px;width:48px;height:48px;font-size:20px">2</div>
<h3 style="font-size:15px;margin-bottom:4px;color:#1a1a2e">Anonymized Data</h3>
<p style="font-size:12px;color:#94a3b8">${anonReady ? 'Anonymization complete — click to view' : 'Waiting...'}</p>
${anonReady ? `<span class="badge badge-green" style="margin-top:8px">PII REMOVED</span>` : ''}
</div></div></a>

<a href="/sales/result/${id}" style="text-decoration:none">
<div class="card" style="border-left:4px solid ${resultReady ? '#3b82f6' : '#e2e8f0'}">
<div class="card-body" style="text-align:center;padding:30px">
<div class="step ${resultReady ? 'step-done' : 'step-pending'}" style="margin:0 auto 12px;width:48px;height:48px;font-size:20px">3</div>
<h3 style="font-size:15px;margin-bottom:4px;color:#1a1a2e">Final AI Result</h3>
<p style="font-size:12px;color:#94a3b8">${resultReady ? 'Response ready — click to view' : 'Waiting...'}</p>
${resultReady ? `<span class="badge badge-blue" style="margin-top:8px">DEANONYMIZED</span>` : ''}
</div></div></a>

</div>

<div class="card"><div class="card-header"><h2>How it works</h2></div>
<div class="card-body" style="font-size:13px;line-height:1.8;color:#475569">
<p><strong>Step 1:</strong> User asks "${escHtml(session.query)}" on Rainbow. The bot fetches data from Salesforce via REST API. This raw data contains real company names, deal names, and sales rep names.</p>
<p style="margin-top:8px"><strong>Step 2:</strong> Before sending to Claude AI, all sensitive fields are anonymized: account names become [ACCOUNT_1], people become [PERSON_1], deals become [DEAL_1]. The AI only sees placeholders — never real data.</p>
<p style="margin-top:8px"><strong>Step 3:</strong> Claude analyzes the anonymized data and produces insights. The bot then deanonymizes the response — replacing placeholders back with real names — and sends the final answer to the user on Rainbow.</p>
</div></div>

</div></body></html>`;

  return html;
}

function renderHistory() {
  const allSessions = [...sessions.values()].reverse(); // newest first

  let rows = "";
  for (const s of allSessions) {
    const status = s.result ? "Complete" : s.anonymized ? "Processing" : "Started";
    const statusBadge = s.result ? "badge-green" : s.anonymized ? "badge-yellow" : "badge-blue";
    rows += `<tr>
      <td><a href="/sales/dashboard/${s.id}" style="color:#3b82f6;font-weight:600">${s.id}</a></td>
      <td>${escHtml(s.query)}</td>
      <td>${s.createdAt}</td>
      <td><span class="badge ${statusBadge}">${status}</span></td>
      <td>
        <a href="/sales/raw/${s.id}" style="color:#dc2626;font-size:12px;margin-right:8px">Raw</a>
        <a href="/sales/anonymized/${s.id}" style="color:#22c55e;font-size:12px;margin-right:8px">Anonymized</a>
        <a href="/sales/result/${s.id}" style="color:#3b82f6;font-size:12px">Result</a>
      </td>
    </tr>`;
  }

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sales Pipeline — Report History</title>
<style>${CSS}</style></head><body>
<div class="header"><h1>Sales Pipeline — Report History</h1>
<div class="subtitle">All pipeline analysis reports (${allSessions.length} total)</div></div>
${renderNav("history", null)}
<div class="container">
<div class="card"><div class="card-body">
${allSessions.length === 0
  ? '<div class="empty"><h3>No reports yet</h3><p>Ask the bot a sales question on Rainbow to generate a report.</p></div>'
  : `<table><thead><tr><th>Session</th><th>Query</th><th>Time</th><th>Status</th><th>View</th></tr></thead><tbody>${rows}</tbody></table>`
}
</div></div>
</div></body></html>`;
}

function renderNotFound() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Not Found</title>
<style>${CSS}</style></head><body>
<div class="header"><h1>Sales Pipeline Dashboard</h1></div>
${renderNav("", null)}
<div class="container"><div class="empty"><h3>Session not found</h3>
<p>This report may have expired. <a href="/sales/history" style="color:#3b82f6">View all reports</a></p>
</div></div></body></html>`;
}

module.exports = {
  init,
  captureRaw,
  captureAnonymized,
  captureResult,
  anonymizeSalesData,
  hasNewData,
  getCurrentSessionId,
};
