/**
 * Sales Agent — Agent Tools for Agentic Loop
 *
 * Defines tools for the AI agent (agent.js) to analyze pipeline,
 * detect risks, and provide sales insights. Phase 1: read-only tools.
 *
 * Tool pattern matches agent.js: each tool has a definition (name,
 * description, input_schema) and an execution handler.
 */

const analyzer = require("./sales-analyzer");
const templates = require("./sales-templates");
const cfg = require("./sales-config");
let dashboard = null;
try { dashboard = require("./sales-dashboard"); } catch {}
const LOG = "[Sales-Tools]";

let sfAuthModule = null;
let sfApiModule = null;
let redisClient = null;

function init(deps) {
  sfAuthModule = deps.sfAuth || null;
  sfApiModule = deps.sfApi || null;
  redisClient = deps.redis || null;
  analyzer.init({ sfApi: sfApiModule, redis: redisClient });
  console.log(`${LOG} Initialized (sfAuth: ${!!sfAuthModule}, sfApi: ${!!sfApiModule}, dashboard: ${!!dashboard})`);
}

function isAvailable() {
  return !!(sfAuthModule && sfApiModule);
}

// ══════════════════════════════════════════════════════════
// TOOL DEFINITIONS
// ══════════════════════════════════════════════════════════

function getToolDefinitions() {
  return [
    {
      name: "analyze_pipeline",
      description: "Run full pipeline health analysis. Returns risk scores, stale deals, missing next steps, and pipeline summary. Use when user asks about pipeline health, deal risks, or wants an overview.",
      input_schema: {
        type: "object",
        properties: {
          refresh: { type: "boolean", description: "Force refresh (ignore cache). Default false." },
        },
      },
    },
    {
      name: "get_deal_risks",
      description: "Get deals sorted by risk level (High → Medium → Low). Shows risk score, issues, and recommended actions. Use when user asks 'which deals are at risk' or 'risky deals'.",
      input_schema: {
        type: "object",
        properties: {
          risk_level: { type: "string", enum: ["High", "Medium", "Low", "all"], description: "Filter by risk level. Default 'all' (High + Medium)." },
          max_results: { type: "number", description: "Max deals to return (default 10)" },
        },
      },
    },
    {
      name: "get_stale_deals",
      description: "Get deals with no recent activity (stale or ghost deals). Use when user asks about inactive deals, forgotten deals, or deals without recent follow-up.",
      input_schema: {
        type: "object",
        properties: {
          min_days: { type: "number", description: "Minimum days of inactivity (default 14)" },
          max_results: { type: "number", description: "Max deals to return (default 10)" },
        },
      },
    },
    {
      name: "get_missing_next_steps",
      description: "Get deals that have no next step defined. Use when user asks 'which deals have no next step' or wants to ensure pipeline discipline.",
      input_schema: {
        type: "object",
        properties: {
          max_results: { type: "number", description: "Max deals to return (default 10)" },
        },
      },
    },
    {
      name: "get_pipeline_summary",
      description: "Get executive pipeline summary: total pipeline value, weighted pipeline, stage distribution, risk breakdown, team performance. Use for high-level overview or management questions.",
      input_schema: {
        type: "object",
        properties: {},
      },
    },
    {
      name: "get_deal_details",
      description: "Get detailed analysis of a specific deal by name. Shows risk score, all issues, activity history, and recommendations. Use when user asks about a specific opportunity or deal.",
      input_schema: {
        type: "object",
        properties: {
          deal_name: { type: "string", description: "Deal/opportunity name to search for (partial match supported)" },
        },
        required: ["deal_name"],
      },
    },
    {
      name: "get_ghost_deals",
      description: "Get ghost deals — opportunities with no activity in 30+ days that are still open. These may be fake pipeline that should be closed or re-engaged.",
      input_schema: {
        type: "object",
        properties: {
          max_results: { type: "number", description: "Max deals to return (default 10)" },
        },
      },
    },
    {
      name: "get_deals_by_owner",
      description: "Get pipeline breakdown by owner/sales rep. Shows deal count, total value, risk distribution per rep. Use when manager asks about team performance or specific rep's pipeline.",
      input_schema: {
        type: "object",
        properties: {
          owner_name: { type: "string", description: "Owner/rep name to filter by (optional — omit for all reps)" },
        },
      },
    },
  ];
}

// ══════════════════════════════════════════════════════════
// TOOL EXECUTION
// ══════════════════════════════════════════════════════════

async function executeTool(toolName, input, userId) {
  // Get Salesforce token
  const tokenData = await sfAuthModule.getValidToken(userId);
  if (!tokenData) {
    return { error: "Salesforce not connected. Ask user to send 'juju connect salesforce'." };
  }

  const { token, instanceUrl } = tokenData;

  try {
    switch (toolName) {
      case "analyze_pipeline": {
        if (input.refresh) await analyzer.invalidateCache(userId);
        const report = await analyzer.analyzePipeline(token, instanceUrl, userId);
        if (!report || report.error) return { error: report?.error || "Analysis failed" };
        const formatted = templates.formatForAgent(report);

        // Dashboard: capture raw data + anonymize + capture anonymized
        if (dashboard) {
          dashboard.captureRaw(userId, "analyze_pipeline", formatted);
          const { anonymizedData, mapping } = dashboard.anonymizeSalesData(formatted);
          dashboard.captureAnonymized(userId, anonymizedData, mapping);
          // Return anonymized data to agent (AI sees placeholders)
          return anonymizedData;
        }

        return formatted;
      }

      case "get_deal_risks": {
        const report = await analyzer.analyzePipeline(token, instanceUrl, userId);
        if (!report || report.error) return { error: report?.error || "Analysis failed" };

        let deals = analyzer.getAtRiskDealsList(report.deals);
        const level = input.risk_level || "all";
        if (level !== "all") {
          deals = deals.filter(d => d.riskLevel === level);
        }

        const max = Math.min(input.max_results || 10, 20);
        const result = {
          totalAtRisk: deals.length,
          deals: deals.slice(0, max).map(d => ({
            name: d.name,
            account: d.account,
            amount: d.amount,
            stage: d.stage,
            riskScore: d.riskScore,
            riskLevel: d.riskLevel,
            owner: d.owner,
            closeDate: d.closeDate,
            daysSinceActivity: d.daysSinceActivity,
            issues: d.issues.map(i => i.message),
          })),
        };

        if (dashboard) {
          dashboard.captureRaw(userId, "get_deal_risks", result);
          const { anonymizedData, mapping } = dashboard.anonymizeSalesData(result);
          dashboard.captureAnonymized(userId, anonymizedData, mapping);
          return anonymizedData;
        }
        return result;
      }

      case "get_stale_deals": {
        const report = await analyzer.analyzePipeline(token, instanceUrl, userId);
        if (!report || report.error) return { error: report?.error || "Analysis failed" };

        const minDays = input.min_days || cfg.STALE_DEAL_DAYS;
        let deals = report.deals.filter(d => d.daysSinceActivity >= minDays);
        deals.sort((a, b) => b.daysSinceActivity - a.daysSinceActivity);

        const max = Math.min(input.max_results || 10, 20);
        return {
          totalStale: deals.length,
          minDaysThreshold: minDays,
          deals: deals.slice(0, max).map(d => ({
            name: d.name,
            account: d.account,
            amount: d.amount,
            stage: d.stage,
            owner: d.owner,
            daysSinceActivity: d.daysSinceActivity,
            lastActivityDate: d.lastActivityDate || "never",
            closeDate: d.closeDate,
          })),
        };
      }

      case "get_missing_next_steps": {
        const report = await analyzer.analyzePipeline(token, instanceUrl, userId);
        if (!report || report.error) return { error: report?.error || "Analysis failed" };

        const deals = analyzer.getMissingNextStepsList(report.deals);
        const max = Math.min(input.max_results || 10, 20);
        return {
          totalMissing: deals.length,
          deals: deals.slice(0, max).map(d => ({
            name: d.name,
            account: d.account,
            amount: d.amount,
            stage: d.stage,
            owner: d.owner,
            closeDate: d.closeDate,
            riskScore: d.riskScore,
          })),
        };
      }

      case "get_pipeline_summary": {
        const report = await analyzer.analyzePipeline(token, instanceUrl, userId);
        if (!report || report.error) return { error: report?.error || "Analysis failed" };

        if (dashboard) {
          dashboard.captureRaw(userId, "get_pipeline_summary", report.summary);
          const { anonymizedData, mapping } = dashboard.anonymizeSalesData(report.summary);
          dashboard.captureAnonymized(userId, anonymizedData, mapping);
          return anonymizedData;
        }
        return report.summary;
      }

      case "get_deal_details": {
        const report = await analyzer.analyzePipeline(token, instanceUrl, userId);
        if (!report || report.error) return { error: report?.error || "Analysis failed" };

        const searchName = (input.deal_name || "").toLowerCase();
        const deal = report.deals.find(d =>
          d.name.toLowerCase().includes(searchName) ||
          d.account.toLowerCase().includes(searchName)
        );

        if (!deal) {
          return { error: `No open deal found matching "${input.deal_name}". Try a different name or check closed deals in Salesforce.` };
        }

        // Fetch recent activity for this deal's account
        let activity = { tasks: [], events: [] };
        if (deal.accountId) {
          try {
            activity = await sfApiModule.getRecentActivity(token, instanceUrl, { accountId: deal.accountId, limit: 5 });
          } catch {}
        }

        return {
          ...deal,
          recentActivity: {
            tasks: (activity.tasks || []).slice(0, 5),
            events: (activity.events || []).slice(0, 5),
          },
        };
      }

      case "get_ghost_deals": {
        const report = await analyzer.analyzePipeline(token, instanceUrl, userId);
        if (!report || report.error) return { error: report?.error || "Analysis failed" };

        const deals = analyzer.getGhostDealsList(report.deals);
        const max = Math.min(input.max_results || 10, 20);
        return {
          totalGhostDeals: deals.length,
          message: deals.length > 0
            ? `Found ${deals.length} ghost deals with no activity in 30+ days. These should be reviewed — either re-engage or close them.`
            : "No ghost deals found.",
          deals: deals.slice(0, max).map(d => ({
            name: d.name,
            account: d.account,
            amount: d.amount,
            stage: d.stage,
            owner: d.owner,
            daysSinceActivity: d.daysSinceActivity,
            closeDate: d.closeDate,
          })),
        };
      }

      case "get_deals_by_owner": {
        const report = await analyzer.analyzePipeline(token, instanceUrl, userId);
        if (!report || report.error) return { error: report?.error || "Analysis failed" };

        if (input.owner_name) {
          const ownerLower = input.owner_name.toLowerCase();
          const ownerDeals = report.deals.filter(d =>
            d.owner.toLowerCase().includes(ownerLower)
          );
          if (ownerDeals.length === 0) {
            return { error: `No deals found for owner matching "${input.owner_name}".` };
          }
          return {
            owner: ownerDeals[0].owner,
            totalDeals: ownerDeals.length,
            totalAmount: ownerDeals.reduce((s, d) => s + d.amount, 0),
            riskBreakdown: {
              high: ownerDeals.filter(d => d.riskLevel === "High").length,
              medium: ownerDeals.filter(d => d.riskLevel === "Medium").length,
              low: ownerDeals.filter(d => d.riskLevel === "Low").length,
            },
            deals: ownerDeals.map(d => ({
              name: d.name,
              account: d.account,
              amount: d.amount,
              stage: d.stage,
              riskLevel: d.riskLevel,
              riskScore: d.riskScore,
            })),
          };
        }

        // All owners summary
        const ownerMap = {};
        for (const d of report.deals) {
          const owner = d.owner || "Unassigned";
          if (!ownerMap[owner]) ownerMap[owner] = { count: 0, amount: 0, highRisk: 0 };
          ownerMap[owner].count++;
          ownerMap[owner].amount += d.amount;
          if (d.riskLevel === "High") ownerMap[owner].highRisk++;
        }
        return {
          totalOwners: Object.keys(ownerMap).length,
          owners: Object.entries(ownerMap)
            .sort((a, b) => b[1].amount - a[1].amount)
            .map(([name, data]) => ({
              name,
              deals: data.count,
              totalAmount: data.amount,
              highRiskDeals: data.highRisk,
            })),
        };
      }

      default:
        return { error: `Unknown sales tool: ${toolName}` };
    }
  } catch (e) {
    console.error(`${LOG} Tool ${toolName} error:`, e.message);
    return { error: e.message };
  }
}

module.exports = {
  init,
  isAvailable,
  getToolDefinitions,
  executeTool,
};
