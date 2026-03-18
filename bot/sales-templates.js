/**
 * Sales Agent — Message Templates
 *
 * Formats analysis results into human-readable messages
 * for Rainbow chat. All templates output Markdown.
 */

const LOG = "[Sales-Templates]";

/**
 * Format currency (compact notation).
 */
function fmtAmount(amount) {
  if (!amount || amount === 0) return "$0";
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(1)}M`;
  if (amount >= 1_000) return `$${(amount / 1_000).toFixed(0)}K`;
  return `$${amount.toLocaleString()}`;
}

/**
 * Risk level emoji indicator.
 */
function riskIcon(level) {
  switch (level) {
    case "High": return "🔴";
    case "Medium": return "🟡";
    case "Low": return "🟢";
    default: return "⚪";
  }
}

/**
 * Priority indicator.
 */
function priorityIcon(priority) {
  switch (priority) {
    case "Critical": return "🚨";
    case "High": return "🔴";
    case "Medium": return "🟡";
    case "Low": return "🟢";
    default: return "⚪";
  }
}

// ══════════════════════════════════════════════════════════
// DEAL TEMPLATES
// ══════════════════════════════════════════════════════════

/**
 * Format a single deal alert.
 */
function formatDealAlert(deal) {
  const lines = [
    `${riskIcon(deal.riskLevel)} **${deal.name}**`,
    `Account: ${deal.account || "N/A"}`,
    `Stage: ${deal.stage} | Amount: ${fmtAmount(deal.amount)}`,
    `Risk: ${deal.riskLevel} (score: ${deal.riskScore}/100)`,
    `Owner: ${deal.owner || "Unassigned"}`,
  ];
  if (deal.closeDate) lines.push(`Close Date: ${deal.closeDate}`);
  if (deal.nextStep) lines.push(`Next Step: ${deal.nextStep}`);
  if (deal.daysSinceActivity > 0) lines.push(`Last Activity: ${deal.daysSinceActivity} days ago`);
  if (deal.issues && deal.issues.length > 0) {
    lines.push(`Issues: ${deal.issues.map(i => i.message).join("; ")}`);
  }
  return lines.join("\n");
}

/**
 * Format a compact deal row for lists.
 */
function formatDealRow(deal, index) {
  const status = `${riskIcon(deal.riskLevel)} ${deal.riskLevel}`;
  return `${index + 1}. **${deal.name}** (${deal.account}) — ${fmtAmount(deal.amount)} — ${status} — ${deal.stage}`;
}

// ══════════════════════════════════════════════════════════
// LIST TEMPLATES
// ══════════════════════════════════════════════════════════

/**
 * Format a list of at-risk deals.
 */
function formatRiskReport(deals, maxItems = 10) {
  if (!deals || deals.length === 0) return "No deals at risk. Pipeline looks healthy.";

  const lines = [`**Deals at Risk** (${deals.length} total)\n`];
  const shown = deals.slice(0, maxItems);
  for (let i = 0; i < shown.length; i++) {
    const d = shown[i];
    lines.push(`${riskIcon(d.riskLevel)} **${d.name}** (${d.account})`);
    lines.push(`   ${fmtAmount(d.amount)} | ${d.stage} | Score: ${d.riskScore}/100`);
    if (d.issues.length > 0) {
      lines.push(`   Issues: ${d.issues.map(i => i.message).join("; ")}`);
    }
    lines.push("");
  }
  if (deals.length > maxItems) {
    lines.push(`...and ${deals.length - maxItems} more deals at risk.`);
  }
  return lines.join("\n");
}

/**
 * Format stale deals list.
 */
function formatStaleDealsList(deals, maxItems = 10) {
  if (!deals || deals.length === 0) return "No stale deals found. Activity levels look good.";

  const lines = [`**Stale Deals** — no recent activity (${deals.length} total)\n`];
  const shown = deals.slice(0, maxItems);
  for (let i = 0; i < shown.length; i++) {
    const d = shown[i];
    lines.push(`${i + 1}. **${d.name}** (${d.account}) — ${fmtAmount(d.amount)}`);
    lines.push(`   Last activity: ${d.daysSinceActivity} days ago | ${d.stage} | Owner: ${d.owner}`);
  }
  if (deals.length > maxItems) {
    lines.push(`\n...and ${deals.length - maxItems} more stale deals.`);
  }
  return lines.join("\n");
}

/**
 * Format missing next steps list.
 */
function formatMissingNextStepsList(deals, maxItems = 10) {
  if (!deals || deals.length === 0) return "All deals have next steps defined.";

  const lines = [`**Deals Without Next Steps** (${deals.length} total)\n`];
  const shown = deals.slice(0, maxItems);
  for (let i = 0; i < shown.length; i++) {
    const d = shown[i];
    lines.push(`${i + 1}. **${d.name}** (${d.account}) — ${fmtAmount(d.amount)} — ${d.stage}`);
    lines.push(`   Owner: ${d.owner} | Close: ${d.closeDate || "N/A"}`);
  }
  if (deals.length > maxItems) {
    lines.push(`\n...and ${deals.length - maxItems} more deals without next steps.`);
  }
  return lines.join("\n");
}

/**
 * Format ghost deals list.
 */
function formatGhostDealsList(deals, maxItems = 10) {
  if (!deals || deals.length === 0) return "No ghost deals detected.";

  const lines = [`🚨 **Ghost Deals** — no activity in 30+ days (${deals.length} total)\n`];
  const shown = deals.slice(0, maxItems);
  for (let i = 0; i < shown.length; i++) {
    const d = shown[i];
    lines.push(`${i + 1}. **${d.name}** (${d.account}) — ${fmtAmount(d.amount)}`);
    lines.push(`   ${d.daysSinceActivity} days inactive | ${d.stage} | Owner: ${d.owner}`);
  }
  if (deals.length > maxItems) {
    lines.push(`\n...and ${deals.length - maxItems} more ghost deals.`);
  }
  return lines.join("\n");
}

// ══════════════════════════════════════════════════════════
// PIPELINE SUMMARY TEMPLATE
// ══════════════════════════════════════════════════════════

/**
 * Format full pipeline summary.
 */
function formatPipelineSummary(summary) {
  if (!summary) return "Unable to generate pipeline summary.";

  const lines = [
    "**Pipeline Summary**\n",
    `Total Pipeline: ${fmtAmount(summary.totalPipeline)}`,
    `Weighted Pipeline: ${fmtAmount(summary.weightedPipeline)}`,
    `Total Deals: ${summary.totalDeals}`,
    `High-Value Deals (≥$100K): ${summary.highValueDeals}`,
    `Strategic Deals (≥$500K): ${summary.strategicDeals}`,
    "",
    "**Risk Distribution**",
    `🔴 High: ${summary.riskDistribution.High} | 🟡 Medium: ${summary.riskDistribution.Medium} | 🟢 Low: ${summary.riskDistribution.Low}`,
    "",
    "**Issues Found**",
  ];

  const ic = summary.issueCounts;
  if (ic.staleDeals > 0) lines.push(`- Stale deals: ${ic.staleDeals}`);
  if (ic.ghostDeals > 0) lines.push(`- Ghost deals: ${ic.ghostDeals}`);
  if (ic.missingNextSteps > 0) lines.push(`- Missing next steps: ${ic.missingNextSteps}`);
  if (ic.pastCloseDate > 0) lines.push(`- Past close date: ${ic.pastCloseDate}`);
  if (ic.stageInconsistency > 0) lines.push(`- Stage inconsistencies: ${ic.stageInconsistency}`);

  if (ic.staleDeals === 0 && ic.ghostDeals === 0 && ic.missingNextSteps === 0 &&
      ic.pastCloseDate === 0 && ic.stageInconsistency === 0) {
    lines.push("- No issues found — pipeline is healthy!");
  }

  // Stage breakdown
  if (summary.stageDistribution && Object.keys(summary.stageDistribution).length > 0) {
    lines.push("");
    lines.push("**Stage Breakdown**");
    for (const [stage, data] of Object.entries(summary.stageDistribution)) {
      lines.push(`- ${stage}: ${data.count} deals (${fmtAmount(data.totalAmount)})`);
    }
  }

  return lines.join("\n");
}

// ══════════════════════════════════════════════════════════
// TOOL RESULT FORMATTERS (for agent tool responses)
// ══════════════════════════════════════════════════════════

/**
 * Format analysis results as a concise JSON-like structure
 * suitable for the AI agent to process and present.
 */
function formatForAgent(report) {
  if (!report || report.error) return report;

  return {
    timestamp: report.timestamp,
    totalDeals: report.totalOpportunities,
    summary: report.summary,
    topRiskDeals: report.deals.slice(0, 15).map(d => ({
      name: d.name,
      account: d.account,
      amount: d.amount,
      stage: d.stage,
      riskScore: d.riskScore,
      riskLevel: d.riskLevel,
      priority: d.priority,
      owner: d.owner,
      closeDate: d.closeDate,
      daysSinceActivity: d.daysSinceActivity,
      nextStep: d.nextStep || "(none)",
      issues: d.issues.map(i => i.message),
    })),
    criticalAlerts: report.alerts.filter(a => a.level === "critical").length,
    highAlerts: report.alerts.filter(a => a.level === "high").length,
  };
}

module.exports = {
  fmtAmount,
  riskIcon,
  priorityIcon,
  formatDealAlert,
  formatDealRow,
  formatRiskReport,
  formatStaleDealsList,
  formatMissingNextStepsList,
  formatGhostDealsList,
  formatPipelineSummary,
  formatForAgent,
};
