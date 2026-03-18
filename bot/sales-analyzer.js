/**
 * Sales Agent — Pipeline Analysis Engine
 *
 * Core intelligence module: risk scoring, stale deal detection,
 * missing next steps, stage inconsistencies, ghost deals,
 * and pipeline summary generation.
 *
 * All methods require a valid Salesforce token + instanceUrl.
 */

const cfg = require("./sales-config");
const LOG = "[Sales-Analyzer]";

let sfApiModule = null;
let redisClient = null;

function init(deps) {
  sfApiModule = deps.sfApi || null;
  redisClient = deps.redis || null;
  console.log(`${LOG} Initialized (sfApi: ${!!sfApiModule}, redis: ${!!redisClient})`);
}

// ══════════════════════════════════════════════════════════
// PIPELINE DATA FETCHING
// ══════════════════════════════════════════════════════════

/**
 * Fetch all open opportunities with last activity data.
 * Uses relationship query to minimize API calls.
 */
async function fetchPipelineData(token, instanceUrl) {
  if (!sfApiModule) return null;

  // Fetch open opportunities with key fields
  const oppSoql = `SELECT Id, Name, StageName, Amount, CloseDate, Probability,
    Type, LeadSource, Account.Name, AccountId, OwnerId, Owner.Name,
    NextStep, LastActivityDate, CreatedDate, FiscalYear, FiscalQuarter
    FROM Opportunity
    WHERE IsClosed = false
    ORDER BY Amount DESC NULLS LAST
    LIMIT ${cfg.MAX_OPPORTUNITIES_FETCH}`;

  const opps = await sfQuery(token, instanceUrl, oppSoql);
  if (!opps) return null;

  return opps.map(o => ({
    id: o.Id,
    name: o.Name || "",
    stage: o.StageName || "",
    amount: o.Amount || 0,
    closeDate: o.CloseDate || "",
    probability: o.Probability || 0,
    type: o.Type || "",
    account: o.Account?.Name || "",
    accountId: o.AccountId || "",
    ownerId: o.OwnerId || "",
    owner: o.Owner?.Name || "",
    nextStep: o.NextStep || "",
    lastActivityDate: o.LastActivityDate || "",
    createdDate: o.CreatedDate || "",
  }));
}

/**
 * Fetch recent activity for a specific opportunity.
 */
async function fetchOppActivity(token, instanceUrl, accountId, limit = 10) {
  if (!sfApiModule || !accountId) return { tasks: [], events: [] };
  return sfApiModule.getRecentActivity(token, instanceUrl, { accountId, limit });
}

// ══════════════════════════════════════════════════════════
// ANALYSIS FUNCTIONS
// ══════════════════════════════════════════════════════════

/**
 * Full pipeline analysis — runs all detection functions.
 * Returns structured report with categorized findings.
 */
async function analyzePipeline(token, instanceUrl, userId) {
  // Check cache first
  const cacheKey = `${cfg.CACHE_PREFIX}analysis:${userId}`;
  if (redisClient) {
    try {
      const cached = await redisClient.get(cacheKey);
      if (cached) {
        console.log(`${LOG} Returning cached analysis for ${userId}`);
        return JSON.parse(cached);
      }
    } catch {}
  }

  const opps = await fetchPipelineData(token, instanceUrl);
  if (!opps || opps.length === 0) {
    return { error: "No open opportunities found", opportunities: [] };
  }

  const now = new Date();
  const results = [];

  for (const opp of opps) {
    const analysis = analyzeOpportunity(opp, now);
    results.push(analysis);
  }

  // Sort by risk score (highest first)
  results.sort((a, b) => b.riskScore - a.riskScore);

  const report = {
    timestamp: now.toISOString(),
    totalOpportunities: opps.length,
    summary: buildPipelineSummary(opps, results, now),
    deals: results,
    alerts: buildAlerts(results),
  };

  // Cache results
  if (redisClient) {
    try {
      await redisClient.set(cacheKey, JSON.stringify(report), { EX: cfg.CACHE_TTL_SECONDS });
    } catch {}
  }

  return report;
}

/**
 * Analyze a single opportunity — compute risk score and detect issues.
 */
function analyzeOpportunity(opp, now) {
  const issues = [];
  const scores = {};

  // ── Inactivity Score ──────────────────────────────────
  const daysSinceActivity = opp.lastActivityDate
    ? daysBetween(new Date(opp.lastActivityDate), now)
    : daysBetween(new Date(opp.createdDate), now);

  if (daysSinceActivity >= cfg.GHOST_DEAL_DAYS) {
    issues.push({ type: "ghost_deal", severity: "critical", message: `No activity in ${daysSinceActivity} days — potential ghost deal` });
  } else if (daysSinceActivity >= cfg.STALE_DEAL_DAYS) {
    issues.push({ type: "stale", severity: "high", message: `No activity in ${daysSinceActivity} days` });
  }
  // Normalize: 0 days = 0 score, 30+ days = 100 score
  scores.inactivity = Math.min(100, (daysSinceActivity / cfg.GHOST_DEAL_DAYS) * 100);

  // ── Close Date Pressure ───────────────────────────────
  const daysUntilClose = opp.closeDate ? daysBetween(now, new Date(opp.closeDate)) : 999;

  if (daysUntilClose < 0) {
    issues.push({ type: "past_close_date", severity: "high", message: `Close date was ${Math.abs(daysUntilClose)} days ago — needs update` });
    scores.time = 100;
  } else if (daysUntilClose <= cfg.CLOSE_DATE_WARNING_DAYS) {
    issues.push({ type: "close_date_approaching", severity: "medium", message: `Close date in ${daysUntilClose} days` });
    scores.time = Math.min(100, ((cfg.CLOSE_DATE_WARNING_DAYS - daysUntilClose) / cfg.CLOSE_DATE_WARNING_DAYS) * 100);
  } else {
    scores.time = 0;
  }

  // ── Missing Next Step ─────────────────────────────────
  if (!opp.nextStep || opp.nextStep.trim() === "") {
    const isRequiredStage = cfg.NEXT_STEP_REQUIRED_STAGES.some(
      s => s.toLowerCase() === opp.stage.toLowerCase()
    );
    if (isRequiredStage) {
      issues.push({ type: "missing_next_step", severity: "high", message: `No next step defined (stage: ${opp.stage})` });
    } else {
      issues.push({ type: "missing_next_step", severity: "medium", message: `No next step defined` });
    }
  }

  // ── Stage/Probability Inconsistency ───────────────────
  const expectedProb = getExpectedProbability(opp.stage);
  if (expectedProb !== null && opp.probability > 0) {
    const diff = Math.abs(opp.probability - expectedProb);
    if (diff > 20) {
      issues.push({
        type: "stage_inconsistency",
        severity: "medium",
        message: `Probability (${opp.probability}%) doesn't match stage "${opp.stage}" (expected ~${expectedProb}%)`,
      });
    }
  }
  scores.stage = expectedProb !== null && opp.probability > 0
    ? Math.min(100, Math.abs(opp.probability - expectedProb) * 2)
    : 0;

  // ── Engagement Score ──────────────────────────────────
  // Based on inactivity + stage duration (higher inactivity in later stages = worse)
  const stageWeight = expectedProb ? expectedProb / 100 : 0.5;
  scores.engagement = Math.min(100, scores.inactivity * (0.5 + stageWeight * 0.5));

  // ── Amount Score ──────────────────────────────────────
  // Higher value deals get amplified risk (more to lose)
  if (opp.amount >= cfg.STRATEGIC_THRESHOLD) {
    scores.amount = 80;
  } else if (opp.amount >= cfg.HIGH_VALUE_THRESHOLD) {
    scores.amount = 50;
  } else {
    scores.amount = Math.min(40, (opp.amount / cfg.HIGH_VALUE_THRESHOLD) * 40);
  }

  // ── Weighted Risk Score ───────────────────────────────
  const riskScore = Math.round(
    scores.inactivity * cfg.RISK_WEIGHTS.inactivity +
    scores.engagement * cfg.RISK_WEIGHTS.engagement +
    scores.stage * cfg.RISK_WEIGHTS.stage +
    scores.amount * cfg.RISK_WEIGHTS.amount +
    scores.time * cfg.RISK_WEIGHTS.time
  );

  const riskLevel = riskScore >= cfg.RISK_HIGH ? "High"
    : riskScore >= cfg.RISK_MEDIUM ? "Medium"
    : "Low";

  // ── Priority Classification ───────────────────────────
  let priority = "Low";
  if (riskLevel === "High" || (opp.amount >= cfg.STRATEGIC_THRESHOLD && riskScore >= cfg.RISK_MEDIUM)) {
    priority = "Critical";
  } else if (riskLevel === "High" || opp.amount >= cfg.HIGH_VALUE_THRESHOLD) {
    priority = "High";
  } else if (riskLevel === "Medium") {
    priority = "Medium";
  }

  return {
    id: opp.id,
    name: opp.name,
    account: opp.account,
    stage: opp.stage,
    amount: opp.amount,
    closeDate: opp.closeDate,
    probability: opp.probability,
    owner: opp.owner,
    nextStep: opp.nextStep,
    lastActivityDate: opp.lastActivityDate,
    daysSinceActivity,
    daysUntilClose,
    riskScore,
    riskLevel,
    priority,
    issues,
    scores,
  };
}

// ══════════════════════════════════════════════════════════
// SPECIFIC DETECTORS
// ══════════════════════════════════════════════════════════

/**
 * Get all stale deals (no activity beyond threshold).
 */
function getStaleDealsList(analysisResults) {
  return analysisResults.filter(d =>
    d.issues.some(i => i.type === "stale" || i.type === "ghost_deal")
  );
}

/**
 * Get all deals missing next steps.
 */
function getMissingNextStepsList(analysisResults) {
  return analysisResults.filter(d =>
    d.issues.some(i => i.type === "missing_next_step")
  );
}

/**
 * Get all deals at risk (sorted by risk score).
 */
function getAtRiskDealsList(analysisResults) {
  return analysisResults.filter(d => d.riskLevel === "High" || d.riskLevel === "Medium");
}

/**
 * Get ghost deals (no activity in 30+ days).
 */
function getGhostDealsList(analysisResults) {
  return analysisResults.filter(d =>
    d.issues.some(i => i.type === "ghost_deal")
  );
}

/**
 * Get deals with past close dates.
 */
function getPastCloseDateList(analysisResults) {
  return analysisResults.filter(d =>
    d.issues.some(i => i.type === "past_close_date")
  );
}

// ══════════════════════════════════════════════════════════
// PIPELINE SUMMARY
// ══════════════════════════════════════════════════════════

function buildPipelineSummary(opps, results, now) {
  const totalPipeline = opps.reduce((sum, o) => sum + (o.amount || 0), 0);
  const weightedPipeline = opps.reduce((sum, o) => sum + (o.amount || 0) * ((o.probability || 0) / 100), 0);

  // Stage distribution
  const stageDistribution = {};
  for (const o of opps) {
    const stage = o.stage || "Unknown";
    if (!stageDistribution[stage]) {
      stageDistribution[stage] = { count: 0, totalAmount: 0 };
    }
    stageDistribution[stage].count++;
    stageDistribution[stage].totalAmount += o.amount || 0;
  }

  // Risk distribution
  const riskCounts = { High: 0, Medium: 0, Low: 0 };
  for (const r of results) {
    riskCounts[r.riskLevel]++;
  }

  // Issue counts
  const issueCounts = {
    staleDeals: results.filter(r => r.issues.some(i => i.type === "stale" || i.type === "ghost_deal")).length,
    missingNextSteps: results.filter(r => r.issues.some(i => i.type === "missing_next_step")).length,
    pastCloseDate: results.filter(r => r.issues.some(i => i.type === "past_close_date")).length,
    stageInconsistency: results.filter(r => r.issues.some(i => i.type === "stage_inconsistency")).length,
    ghostDeals: results.filter(r => r.issues.some(i => i.type === "ghost_deal")).length,
  };

  // Owner distribution
  const ownerDeals = {};
  for (const o of opps) {
    const owner = o.owner || "Unassigned";
    if (!ownerDeals[owner]) {
      ownerDeals[owner] = { count: 0, totalAmount: 0 };
    }
    ownerDeals[owner].count++;
    ownerDeals[owner].totalAmount += o.amount || 0;
  }

  return {
    totalPipeline,
    weightedPipeline,
    totalDeals: opps.length,
    stageDistribution,
    riskDistribution: riskCounts,
    issueCounts,
    ownerDistribution: ownerDeals,
    highValueDeals: opps.filter(o => (o.amount || 0) >= cfg.HIGH_VALUE_THRESHOLD).length,
    strategicDeals: opps.filter(o => (o.amount || 0) >= cfg.STRATEGIC_THRESHOLD).length,
  };
}

// ══════════════════════════════════════════════════════════
// ALERTS
// ══════════════════════════════════════════════════════════

function buildAlerts(results) {
  const alerts = [];

  for (const deal of results) {
    if (deal.priority === "Critical") {
      alerts.push({
        level: "critical",
        deal: deal.name,
        account: deal.account,
        amount: deal.amount,
        owner: deal.owner,
        message: deal.issues.map(i => i.message).join("; "),
        riskScore: deal.riskScore,
      });
    } else if (deal.priority === "High") {
      alerts.push({
        level: "high",
        deal: deal.name,
        account: deal.account,
        amount: deal.amount,
        owner: deal.owner,
        message: deal.issues.map(i => i.message).join("; "),
        riskScore: deal.riskScore,
      });
    }
  }

  return alerts;
}

// ══════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════

function daysBetween(date1, date2) {
  const d1 = new Date(date1);
  const d2 = new Date(date2);
  return Math.floor((d2 - d1) / (1000 * 60 * 60 * 24));
}

function getExpectedProbability(stageName) {
  if (!stageName) return null;
  // Try exact match first
  if (cfg.STAGE_PROBABILITY_MAP[stageName] !== undefined) {
    return cfg.STAGE_PROBABILITY_MAP[stageName];
  }
  // Try case-insensitive match
  const lower = stageName.toLowerCase();
  for (const [key, val] of Object.entries(cfg.STAGE_PROBABILITY_MAP)) {
    if (key.toLowerCase() === lower) return val;
  }
  return null;
}

/**
 * SOQL query helper — mirrors salesforce-api.js pattern.
 */
async function sfQuery(token, instanceUrl, soql) {
  const API_VERSION = "v59.0";
  const url = `${instanceUrl}/services/data/${API_VERSION}/query/?q=${encodeURIComponent(soql)}`;
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      signal: AbortSignal.timeout(15000),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error(`${LOG} SOQL error ${resp.status}: ${errText.substring(0, 200)}`);
      return null;
    }
    const data = await resp.json();
    return data.records || [];
  } catch (err) {
    console.error(`${LOG} SOQL error:`, err.message);
    return null;
  }
}

/**
 * Invalidate cached analysis for a user.
 */
async function invalidateCache(userId) {
  if (!redisClient) return;
  try {
    await redisClient.del(`${cfg.CACHE_PREFIX}analysis:${userId}`);
  } catch {}
}

module.exports = {
  init,
  analyzePipeline,
  analyzeOpportunity,
  fetchPipelineData,
  fetchOppActivity,
  getStaleDealsList,
  getMissingNextStepsList,
  getAtRiskDealsList,
  getGhostDealsList,
  getPastCloseDateList,
  buildPipelineSummary,
  invalidateCache,
};
