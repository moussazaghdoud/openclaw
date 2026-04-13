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
    {
      name: "list_opportunities",
      description: "List opportunities from Salesforce. Use when user asks to see opportunities, deals, or pipeline. Supports sorting and filtering. For 'biggest opportunity' use sort_by='Amount' sort_dir='DESC'. For '2026 opportunities' use year=2026.",
      input_schema: {
        type: "object",
        properties: {
          account_name: { type: "string", description: "Filter by account name (optional)" },
          limit: { type: "number", description: "Max results (default 15, max 20). Keep low for faster responses." },
          sort_by: { type: "string", enum: ["Amount", "CloseDate", "Probability", "Name", "CreatedDate"], description: "Sort field (default CloseDate)" },
          sort_dir: { type: "string", enum: ["ASC", "DESC"], description: "Sort direction (default ASC). Use DESC for biggest/highest/latest." },
          year: { type: "number", description: "Filter by close date year (e.g. 2026)" },
          min_amount: { type: "number", description: "Filter by minimum amount (e.g. 100000)" },
        },
      },
    },
    {
      name: "search_crm",
      description: "Search Salesforce CRM across accounts, contacts, and opportunities. Use when user asks to search/find/look up a specific deal, account, contact, or any CRM record by name.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search term — deal name, account name, contact name, or keyword" },
        },
        required: ["query"],
      },
    },
    {
      name: "get_opportunity_details",
      description: "Get full details of a specific opportunity by its Salesforce ID. Use after search_crm returns an opportunity ID.",
      input_schema: {
        type: "object",
        properties: {
          opportunity_id: { type: "string", description: "Salesforce Opportunity ID (18-char)" },
        },
        required: ["opportunity_id"],
      },
    },
    {
      name: "get_account_details",
      description: "Get account details and its contacts, opportunities, and recent activity. Use when user asks about a specific company/customer.",
      input_schema: {
        type: "object",
        properties: {
          account_name: { type: "string", description: "Account/company name to search for" },
        },
        required: ["account_name"],
      },
    },

    // ── Write tools DISABLED — read-only mode (Stage 1) ──────────────────
    // update_opportunity, create_task, log_activity, close_deal removed

    // ── Forecast tools ──────────────────────────────────────
    {
      name: "get_forecast",
      description: "Get pipeline forecast: coverage, weighted/unweighted pipeline, closed-won totals, and quarter-over-quarter comparison. Use when user asks about forecast, quota attainment, or pipeline coverage.",
      input_schema: {
        type: "object",
        properties: {
          quarter: { type: "string", description: "Target quarter (e.g. 'Q1 2026'). Defaults to current quarter." },
          compare_previous: { type: "boolean", description: "Compare with previous quarter (default true)" },
        },
      },
    },
    // set_quota REMOVED — read-only mode (Stage 1)

    // ── Competitor tools ────────────────────────────────────
    {
      name: "get_competitors",
      description: "List competitors on a deal. Provide either the opportunity ID or the deal name.",
      input_schema: {
        type: "object",
        properties: {
          opportunity_id: { type: "string", description: "Salesforce Opportunity ID" },
          deal_name: { type: "string", description: "Deal name to search for (partial match)" },
        },
      },
    },
    // add_competitor REMOVED — read-only mode (Stage 1)
    {
      name: "search_deals_by_competitor",
      description: "Find all deals where a specific competitor is present. Use to understand competitive landscape across pipeline.",
      input_schema: {
        type: "object",
        properties: {
          competitor_name: { type: "string", description: "Competitor company name to search for" },
        },
        required: ["competitor_name"],
      },
    },

    // ── Alert management ────────────────────────────────────
    {
      name: "manage_sales_alerts",
      description: "Enable, disable, or configure proactive sales alerts (daily/weekly pipeline notifications). Use when user asks to set up or manage sales alerts.",
      input_schema: {
        type: "object",
        properties: {
          action: { type: "string", enum: ["enable", "disable", "configure", "status"], description: "Action to perform" },
          timezone: { type: "string", description: "User timezone (e.g. 'Europe/Paris')" },
          daily_time: { type: "string", description: "Daily alert time (HH:MM, 24h format)" },
          weekly_day: { type: "string", description: "Weekly summary day (e.g. 'Monday')" },
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
    const result = await executeToolInner(toolName, input, token, instanceUrl, userId);

    // Dashboard: capture for visualization only — don't modify what AI sees
    if (dashboard && result && !result.error) {
      dashboard.captureRaw(userId, toolName, result);
      const { anonymizedData, mapping } = dashboard.anonymizeSalesData(result);
      dashboard.captureAnonymized(userId, anonymizedData, mapping);
    }

    return result;
  } catch (e) {
    console.error(`${LOG} Tool ${toolName} error:`, e.message);
    return { error: e.message };
  }
}

async function executeToolInner(toolName, input, token, instanceUrl, userId) {
  try {
    switch (toolName) {
      case "analyze_pipeline": {
        if (input.refresh) await analyzer.invalidateCache(userId);
        const report = await analyzer.analyzePipeline(token, instanceUrl, userId);
        if (!report || report.error) return { error: report?.error || "Analysis failed" };
        return templates.formatForAgent(report);
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

      case "list_opportunities": {
        const limit = Math.min(input.limit || 15, 20);
        let opps;
        if (input.account_name) {
          const accounts = await sfApiModule.searchAccounts(token, instanceUrl, input.account_name, 1);
          if (accounts && accounts.length > 0) {
            opps = await sfApiModule.getOpportunities(token, instanceUrl, accounts[0].id, limit);
          } else {
            return { error: `No account found matching "${input.account_name}"` };
          }
        } else {
          opps = await sfApiModule.getOpenOpportunities(token, instanceUrl, {
            limit,
            sortBy: input.sort_by || "CloseDate",
            sortDir: input.sort_dir || "ASC",
            year: input.year || null,
            minAmount: input.min_amount || null,
          });
        }
        if (!opps) return { error: "Failed to fetch opportunities" };
        return {
          count: opps.length,
          opportunities: opps.map(o => ({
            name: o.name,
            account: o.account,
            stage: o.stage,
            amount: o.amount,
            closeDate: o.closeDate,
            probability: o.probability,
            owner: o.owner,
            nextStep: o.nextStep || "(none)",
          })),
        };
      }

      case "search_crm": {
        // Try SOSL global search first
        let results = await sfApiModule.globalSearch(token, instanceUrl, input.query);
        const hasResults = results && !results._error &&
          ((results.accounts?.length || 0) + (results.contacts?.length || 0) + (results.opportunities?.length || 0)) > 0;

        // If SOSL returned nothing, fallback to SOQL LIKE search on key objects
        if (!hasResults) {
          const escaped = input.query.replace(/'/g, "\\'");
          const [accts, opps, contacts] = await Promise.all([
            sfApiModule.searchAccounts(token, instanceUrl, input.query, 5).catch(() => []),
            sfApiModule.getOpportunities(token, instanceUrl, null, 50).then(all =>
              (all || []).filter(o => o.name.toLowerCase().includes(input.query.toLowerCase()))
            ).catch(() => []),
            sfApiModule.searchContacts(token, instanceUrl, input.query, 5).catch(() => []),
          ]);
          results = { accounts: accts || [], contacts: contacts || [], opportunities: opps || [] };
        }

        return {
          query: input.query,
          accounts: results.accounts || [],
          contacts: results.contacts || [],
          opportunities: results.opportunities || [],
          totalResults: (results.accounts?.length || 0) + (results.contacts?.length || 0) + (results.opportunities?.length || 0),
        };
      }

      case "get_opportunity_details": {
        const opp = await sfApiModule.getOpportunityDetails(token, instanceUrl, input.opportunity_id);
        if (!opp || opp._error) return { error: "Failed to fetch opportunity details" };
        // Also fetch activity
        let activity = { tasks: [], events: [] };
        if (opp.accountId) {
          try { activity = await sfApiModule.getRecentActivity(token, instanceUrl, { accountId: opp.accountId, limit: 5 }); } catch {}
        }
        return { ...opp, recentActivity: activity };
      }

      case "get_account_details": {
        const accounts = await sfApiModule.searchAccounts(token, instanceUrl, input.account_name, 3);
        if (!accounts || accounts.length === 0) return { error: `No account found matching "${input.account_name}"` };
        const account = accounts[0];
        // Fetch related data in parallel
        const [contacts, opportunities, activity] = await Promise.all([
          sfApiModule.getContactsByAccount(token, instanceUrl, account.id, 10).catch(() => []),
          sfApiModule.getOpportunities(token, instanceUrl, account.id, 10).catch(() => []),
          sfApiModule.getRecentActivity(token, instanceUrl, { accountId: account.id, limit: 5 }).catch(() => ({ tasks: [], events: [] })),
        ]);
        return {
          account,
          contacts: contacts || [],
          opportunities: opportunities || [],
          recentActivity: activity,
        };
      }

      // ── Write tools DISABLED — read-only mode (Stage 1) ──────────────────

      case "update_opportunity": {
        return { error: "Read-only mode: Salesforce writes are disabled." };
      }
      case "create_task": {
        return { error: "Read-only mode: Salesforce writes are disabled." };
      }
      case "log_activity": {
        return { error: "Read-only mode: Salesforce writes are disabled." };
      }
      case "close_deal": {
        return { error: "Read-only mode: Salesforce writes are disabled." };
      }
      case "add_competitor": {
        return { error: "Read-only mode: Salesforce writes are disabled." };
      }
      case "set_quota": {
        return { error: "Read-only mode: Salesforce writes are disabled." };
      }

      case "_disabled_update_opportunity": {
        if (!input.opportunity_id) return { error: "opportunity_id is required" };
        const updates = {};
        if (input.stage !== undefined) updates.StageName = input.stage;
        if (input.close_date !== undefined) updates.CloseDate = input.close_date;
        if (input.amount !== undefined) updates.Amount = input.amount;
        if (input.next_step !== undefined) updates.NextStep = input.next_step;
        if (input.probability !== undefined) updates.Probability = input.probability;
        if (Object.keys(updates).length === 0) return { error: "No fields to update. Provide at least one of: stage, close_date, amount, next_step, probability." };

        const pendingKey = `sales:pending:${userId}`;
        const pendingAction = {
          action: "update_opportunity",
          opportunity_id: input.opportunity_id,
          updates,
          token,
          instanceUrl,
          createdAt: new Date().toISOString(),
        };
        if (redisClient) {
          await redisClient.set(pendingKey, JSON.stringify(pendingAction), { EX: 300 });
        }
        return {
          confirmation_needed: true,
          action: "update_opportunity",
          details: { opportunity_id: input.opportunity_id, updates },
          message: `I'll update opportunity ${input.opportunity_id} with: ${Object.entries(updates).map(([k, v]) => `${k}=${v}`).join(", ")}. Please confirm.`,
        };
      }

      case "create_task": {
        if (!input.subject) return { error: "subject is required" };
        const taskData = {
          Subject: input.subject,
          Priority: input.priority || "Normal",
          Status: "Not Started",
        };
        if (input.opportunity_id) taskData.WhatId = input.opportunity_id;
        if (input.contact_id) taskData.WhoId = input.contact_id;
        if (input.due_date) taskData.ActivityDate = input.due_date;
        if (input.description) taskData.Description = input.description;

        const result = await sfApiModule.createTask(token, instanceUrl, taskData);
        if (!result || result._error) return { error: result?._error || "Failed to create task" };
        return {
          success: true,
          task_id: result.id,
          message: `Task "${input.subject}" created successfully.`,
          details: taskData,
        };
      }

      case "log_activity": {
        if (!input.subject) return { error: "subject is required" };
        const activityData = {
          Subject: input.subject,
          Type: input.type || "Note",
          Status: "Completed",
        };
        if (input.account_id) activityData.WhatId = input.account_id;
        if (input.opportunity_id) activityData.WhatId = input.opportunity_id;
        if (input.description) activityData.Description = input.description;

        const result = await sfApiModule.logActivity(token, instanceUrl, activityData);
        if (!result || result._error) return { error: result?._error || "Failed to log activity" };
        return {
          success: true,
          activity_id: result.id,
          message: `${activityData.Type} "${input.subject}" logged successfully.`,
          details: activityData,
        };
      }

      case "close_deal": {
        if (!input.opportunity_id) return { error: "opportunity_id is required" };
        if (input.won === undefined) return { error: "won (true/false) is required" };

        const updates = {
          StageName: input.won ? "Closed Won" : "Closed Lost",
        };
        if (input.amount !== undefined) updates.Amount = input.amount;
        if (input.close_reason) updates.CloseReason = input.close_reason;

        const pendingKey = `sales:pending:${userId}`;
        const pendingAction = {
          action: "close_deal",
          opportunity_id: input.opportunity_id,
          updates,
          won: input.won,
          token,
          instanceUrl,
          createdAt: new Date().toISOString(),
        };
        if (redisClient) {
          await redisClient.set(pendingKey, JSON.stringify(pendingAction), { EX: 300 });
        }
        return {
          confirmation_needed: true,
          action: "close_deal",
          details: { opportunity_id: input.opportunity_id, won: input.won, updates },
          message: `I'll close deal ${input.opportunity_id} as ${input.won ? "Won" : "Lost"}${input.close_reason ? ` (reason: ${input.close_reason})` : ""}. Please confirm.`,
        };
      }

      // ── Forecast tools ──────────────────────────────────────

      case "get_forecast": {
        const report = await analyzer.analyzePipeline(token, instanceUrl, userId);
        if (!report || report.error) return { error: report?.error || "Analysis failed" };

        const [closedWonCurrent, closedWonPrevious] = await Promise.all([
          sfApiModule.getClosedWonThisQuarter(token, instanceUrl).catch(() => []),
          sfApiModule.getClosedWonLastQuarter(token, instanceUrl).catch(() => []),
        ]);

        // Load quota from Redis
        let quota = null;
        if (redisClient) {
          const quotaRaw = await redisClient.get(`sales:quota:${userId}`);
          if (quotaRaw) {
            try { quota = JSON.parse(quotaRaw); } catch {}
          }
        }

        const totalPipeline = report.deals.reduce((s, d) => s + d.amount, 0);
        const weightedPipeline = report.deals.reduce((s, d) => s + (d.amount * (d.probability || 0) / 100), 0);
        const closedWonAmount = (closedWonCurrent || []).reduce((s, d) => s + (d.amount || 0), 0);
        const closedWonPreviousAmount = (closedWonPrevious || []).reduce((s, d) => s + (d.amount || 0), 0);

        const quarterQuota = quota?.quarter === input.quarter && quota?.amount ? quota.amount : (quota?.annual ? quota.annual / 4 : null);
        const pipelineCoverage = quarterQuota ? totalPipeline / quarterQuota : null;

        const forecast = {
          quarter: input.quarter || "current",
          totalPipeline,
          weightedPipeline,
          closedWon: closedWonAmount,
          closedWonDealCount: (closedWonCurrent || []).length,
          openDealCount: report.deals.length,
          quota: quarterQuota,
          pipelineCoverage: pipelineCoverage ? `${(pipelineCoverage * 100).toFixed(0)}%` : "N/A (no quota set)",
        };

        if (input.compare_previous !== false) {
          forecast.comparison = {
            previousQuarterClosedWon: closedWonPreviousAmount,
            previousQuarterDealCount: (closedWonPrevious || []).length,
            changePercent: closedWonPreviousAmount > 0
              ? `${(((closedWonAmount - closedWonPreviousAmount) / closedWonPreviousAmount) * 100).toFixed(1)}%`
              : "N/A",
          };
        }

        return forecast;
      }

      case "set_quota": {
        const quotaData = {};
        if (input.annual !== undefined) quotaData.annual = input.annual;
        if (input.quarter !== undefined) quotaData.quarter = input.quarter;
        if (input.amount !== undefined) quotaData.amount = input.amount;

        if (Object.keys(quotaData).length === 0) return { error: "Provide at least one of: annual, quarter + amount." };

        if (redisClient) {
          await redisClient.set(`sales:quota:${userId}`, JSON.stringify(quotaData));
        }
        return {
          success: true,
          message: `Quota saved: ${input.annual ? `Annual $${input.annual.toLocaleString()}` : ""}${input.quarter ? ` ${input.quarter}: $${(input.amount || 0).toLocaleString()}` : ""}`.trim(),
          quota: quotaData,
        };
      }

      // ── Competitor tools ────────────────────────────────────

      case "get_competitors": {
        let oppId = input.opportunity_id;
        if (!oppId && input.deal_name) {
          // Search for the deal first
          const report = await analyzer.analyzePipeline(token, instanceUrl, userId);
          if (report && !report.error) {
            const searchName = input.deal_name.toLowerCase();
            const deal = report.deals.find(d =>
              d.name.toLowerCase().includes(searchName) ||
              d.account.toLowerCase().includes(searchName)
            );
            if (deal) oppId = deal.id;
          }
          if (!oppId) return { error: `No deal found matching "${input.deal_name}"` };
        }
        if (!oppId) return { error: "Provide either opportunity_id or deal_name" };

        const competitors = await sfApiModule.getCompetitors(token, instanceUrl, oppId);
        if (!competitors || competitors._error) return { error: competitors?._error || "Failed to fetch competitors" };
        return {
          opportunity_id: oppId,
          competitors: competitors || [],
          count: (competitors || []).length,
        };
      }

      case "add_competitor": {
        if (!input.opportunity_id) return { error: "opportunity_id is required" };
        if (!input.competitor_name) return { error: "competitor_name is required" };

        const pendingKey = `sales:pending:${userId}`;
        const pendingAction = {
          action: "add_competitor",
          opportunity_id: input.opportunity_id,
          competitor_name: input.competitor_name,
          strengths: input.strengths || null,
          weaknesses: input.weaknesses || null,
          token,
          instanceUrl,
          createdAt: new Date().toISOString(),
        };
        if (redisClient) {
          await redisClient.set(pendingKey, JSON.stringify(pendingAction), { EX: 300 });
        }
        return {
          confirmation_needed: true,
          action: "add_competitor",
          details: {
            opportunity_id: input.opportunity_id,
            competitor_name: input.competitor_name,
            strengths: input.strengths || null,
            weaknesses: input.weaknesses || null,
          },
          message: `I'll add "${input.competitor_name}" as a competitor on opportunity ${input.opportunity_id}. Please confirm.`,
        };
      }

      case "search_deals_by_competitor": {
        if (!input.competitor_name) return { error: "competitor_name is required" };
        const deals = await sfApiModule.searchDealsByCompetitor(token, instanceUrl, input.competitor_name);
        if (!deals || deals._error) return { error: deals?._error || "Failed to search deals by competitor" };
        return {
          competitor: input.competitor_name,
          count: (deals || []).length,
          deals: deals || [],
        };
      }

      // ── Alert management ────────────────────────────────────

      case "manage_sales_alerts": {
        let scheduler = null;
        try { scheduler = require("./sales-scheduler"); } catch {}
        if (!scheduler) return { error: "Sales scheduler module not available" };

        const action = input.action || "status";

        switch (action) {
          case "status": {
            const prefs = await scheduler.getUserPrefs(userId);
            return { action: "status", prefs: prefs || { enabled: false } };
          }
          case "enable": {
            const prefs = {
              enabled: true,
              timezone: input.timezone || "UTC",
              dailyTime: input.daily_time || "08:00",
              weeklyDay: input.weekly_day || "Monday",
            };
            await scheduler.setUserPrefs(userId, prefs);
            await scheduler.enableAlerts(userId);
            return { success: true, message: `Sales alerts enabled. Daily at ${prefs.dailyTime} (${prefs.timezone}), weekly on ${prefs.weeklyDay}.`, prefs };
          }
          case "disable": {
            await scheduler.disableAlerts(userId);
            return { success: true, message: "Sales alerts disabled." };
          }
          case "configure": {
            const existingPrefs = await scheduler.getUserPrefs(userId) || {};
            const updatedPrefs = {
              ...existingPrefs,
              enabled: existingPrefs.enabled !== false,
              timezone: input.timezone || existingPrefs.timezone || "UTC",
              dailyTime: input.daily_time || existingPrefs.dailyTime || "08:00",
              weeklyDay: input.weekly_day || existingPrefs.weeklyDay || "Monday",
            };
            await scheduler.setUserPrefs(userId, updatedPrefs);
            return { success: true, message: "Sales alert preferences updated.", prefs: updatedPrefs };
          }
          default:
            return { error: `Unknown alert action: ${action}. Use enable, disable, configure, or status.` };
        }
      }

      default:
        return { error: `Unknown sales tool: ${toolName}` };
    }
  } catch (e) {
    console.error(`${LOG} Tool ${toolName} error:`, e.message);
    return { error: e.message };
  }
}

// ══════════════════════════════════════════════════════════
// PENDING ACTION EXECUTION
// ══════════════════════════════════════════════════════════

async function executePendingAction(userId) {
  if (!redisClient) return { error: "Redis not available" };

  const pendingKey = `sales:pending:${userId}`;
  const raw = await redisClient.get(pendingKey);
  if (!raw) return { error: "No pending action found. It may have expired (5-minute TTL)." };

  let pending;
  try { pending = JSON.parse(raw); } catch { return { error: "Failed to parse pending action" }; }

  const { action, token, instanceUrl } = pending;

  try {
    let result;

    switch (action) {
      case "update_opportunity": {
        result = await sfApiModule.updateOpportunity(token, instanceUrl, pending.opportunity_id, pending.updates);
        if (!result || result._error) return { error: result?._error || "Failed to update opportunity" };
        break;
      }
      case "close_deal": {
        result = await sfApiModule.updateOpportunity(token, instanceUrl, pending.opportunity_id, pending.updates);
        if (!result || result._error) return { error: result?._error || "Failed to close deal" };
        break;
      }
      case "add_competitor": {
        result = await sfApiModule.addCompetitor(token, instanceUrl, pending.opportunity_id, {
          competitorName: pending.competitor_name,
          strengths: pending.strengths,
          weaknesses: pending.weaknesses,
        });
        if (!result || result._error) return { error: result?._error || "Failed to add competitor" };
        break;
      }
      default:
        return { error: `Unknown pending action: ${action}` };
    }

    // Delete the pending key after successful execution
    await redisClient.del(pendingKey);

    return {
      success: true,
      action,
      message: `${action} executed successfully.`,
      result,
    };
  } catch (e) {
    console.error(`${LOG} executePendingAction error:`, e.message);
    return { error: e.message };
  }
}

module.exports = {
  init,
  isAvailable,
  getToolDefinitions,
  executeTool,
  executePendingAction,
};
