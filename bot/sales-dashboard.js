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

const LOG = "[Sales-Dashboard]";

let piiModule = null;
let redisClient = null;

// Last captured stages (in-memory, one per user — latest wins)
const stages = {
  raw: null,          // { timestamp, userId, query, data }
  anonymized: null,   // { timestamp, userId, data, mapping }
  result: null,       // { timestamp, userId, response }
};

function init(app, deps) {
  piiModule = deps.pii || null;
  redisClient = deps.redis || null;

  // Register Express routes
  app.get("/sales/raw", (req, res) => res.send(renderPage("raw")));
  app.get("/sales/anonymized", (req, res) => res.send(renderPage("anonymized")));
  app.get("/sales/result", (req, res) => res.send(renderPage("result")));
  app.get("/sales/dashboard", (req, res) => res.send(renderDashboard()));
  // API endpoint for auto-refresh
  app.get("/api/sales/stages", (req, res) => res.json(stages));

  console.log(`${LOG} Dashboard routes registered (/sales/raw, /sales/anonymized, /sales/result, /sales/dashboard)`);
}

// ══════════════════════════════════════════════════════════
// DATA CAPTURE
// ══════════════════════════════════════════════════════════

// Track whether new data was captured during the current agent run
let newDataFlag = false;

function hasNewData() {
  const had = newDataFlag;
  newDataFlag = false; // reset after check
  return had;
}

function captureRaw(userId, query, data) {
  stages.raw = {
    timestamp: new Date().toISOString(),
    userId,
    query,
    data,
  };
  newDataFlag = true;
  console.log(`${LOG} Captured RAW stage (${typeof data === "object" ? JSON.stringify(data).length : 0} bytes)`);
}

function captureAnonymized(userId, data, mapping) {
  stages.anonymized = {
    timestamp: new Date().toISOString(),
    userId,
    data,
    mapping,
  };
  console.log(`${LOG} Captured ANONYMIZED stage (${Object.keys(mapping || {}).length} replacements)`);
}

function captureResult(userId, response) {
  stages.result = {
    timestamp: new Date().toISOString(),
    userId,
    response,
  };
  console.log(`${LOG} Captured RESULT stage (${(response || "").length} chars)`);
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

function renderNav(activePage) {
  const pages = [
    { id: "dashboard", url: "/sales/dashboard", label: "Dashboard Overview" },
    { id: "raw", url: "/sales/raw", label: "Step 1: Raw Salesforce Data" },
    { id: "anonymized", url: "/sales/anonymized", label: "Step 2: Anonymized Data" },
    { id: "result", url: "/sales/result", label: "Step 3: Final Result" },
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

function renderPage(page) {
  const stage = stages[page];
  let body = "";

  if (!stage) {
    body = `<div class="empty"><h3>No data yet</h3><p>Ask the bot "pipeline health" on Rainbow to trigger the analysis.</p><p class="auto-refresh">This page auto-refreshes every 5 seconds.</p></div>`;
  } else if (page === "raw") {
    body = renderRawPage(stage);
  } else if (page === "anonymized") {
    body = renderAnonymizedPage(stage);
  } else if (page === "result") {
    body = renderResultPage(stage);
  }

  const stepNum = page === "raw" ? 1 : page === "anonymized" ? 2 : 3;

  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sales Pipeline — ${page === "raw" ? "Raw Data" : page === "anonymized" ? "Anonymized" : "Result"}</title>
<meta http-equiv="refresh" content="5">
<style>${CSS}</style></head><body>
<div class="header"><h1>Sales Pipeline — PII Protection Visualization</h1>
<div class="subtitle">Demonstrating how sensitive sales data is protected before reaching AI</div></div>
${renderNav(page)}
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

function renderResultPage(stage) {
  let html = "";

  html += `<div class="card"><div class="card-header"><h2>Final Result — Sent to User</h2>
<div><span class="badge badge-blue">DEANONYMIZED</span> <span class="timestamp">${stage.timestamp}</span></div></div>`;

  html += `<div class="card-body"><p style="margin-bottom:16px;color:#64748b;font-size:13px">
This is the AI's response after deanonymization. The AI analyzed the anonymized data and produced insights.
Placeholders like [ACCOUNT_1] have been replaced back with real names before sending to the user on Rainbow.</p>`;

  html += `<div class="result-text" style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:20px">${escHtml(stage.response)}</div>`;

  html += `</div></div>`;

  return html;
}

function renderDashboard() {
  const rawReady = !!stages.raw;
  const anonReady = !!stages.anonymized;
  const resultReady = !!stages.result;

  let html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Sales Pipeline — Dashboard</title>
<meta http-equiv="refresh" content="5">
<style>${CSS}</style></head><body>
<div class="header"><h1>Sales Pipeline — PII Protection Dashboard</h1>
<div class="subtitle">Real-time visualization of the data anonymization process</div></div>
${renderNav("dashboard")}
<div class="container">

<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:20px;margin-bottom:24px">

<a href="/sales/raw" style="text-decoration:none">
<div class="card" style="border-left:4px solid ${rawReady ? '#dc2626' : '#e2e8f0'}">
<div class="card-body" style="text-align:center;padding:30px">
<div class="step ${rawReady ? 'step-done' : 'step-pending'}" style="margin:0 auto 12px;width:48px;height:48px;font-size:20px">1</div>
<h3 style="font-size:15px;margin-bottom:4px;color:#1a1a2e">Raw Salesforce Data</h3>
<p style="font-size:12px;color:#94a3b8">${rawReady ? 'Data captured — click to view' : 'Waiting for query...'}</p>
${rawReady ? `<span class="badge badge-red" style="margin-top:8px">SENSITIVE</span>` : ''}
</div></div></a>

<a href="/sales/anonymized" style="text-decoration:none">
<div class="card" style="border-left:4px solid ${anonReady ? '#22c55e' : '#e2e8f0'}">
<div class="card-body" style="text-align:center;padding:30px">
<div class="step ${anonReady ? 'step-done' : 'step-pending'}" style="margin:0 auto 12px;width:48px;height:48px;font-size:20px">2</div>
<h3 style="font-size:15px;margin-bottom:4px;color:#1a1a2e">Anonymized Data</h3>
<p style="font-size:12px;color:#94a3b8">${anonReady ? 'Anonymization complete — click to view' : 'Waiting...'}</p>
${anonReady ? `<span class="badge badge-green" style="margin-top:8px">PII REMOVED</span>` : ''}
</div></div></a>

<a href="/sales/result" style="text-decoration:none">
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
<p><strong>Step 1:</strong> User asks "pipeline health" on Rainbow. The bot fetches all open opportunities from Salesforce via REST API. This raw data contains real company names, deal names, and sales rep names.</p>
<p style="margin-top:8px"><strong>Step 2:</strong> Before sending to Claude AI, all sensitive fields are anonymized: account names become [ACCOUNT_1], people become [PERSON_1], deals become [DEAL_1]. The AI only sees placeholders — never real data.</p>
<p style="margin-top:8px"><strong>Step 3:</strong> Claude analyzes the anonymized data and produces insights (risk scores, recommendations). The bot then deanonymizes the response — replacing [ACCOUNT_1] back with the real company name — and sends the final answer to the user on Rainbow.</p>
</div></div>

<div class="card"><div class="card-body" style="text-align:center;color:#94a3b8;font-size:12px">
Ask the bot <strong>"pipeline health"</strong> on Rainbow to see the full flow.
<br>Pages auto-refresh every 5 seconds.
</div></div>

</div></body></html>`;

  return html;
}

module.exports = {
  init,
  captureRaw,
  captureAnonymized,
  captureResult,
  anonymizeSalesData,
  hasNewData,
};
