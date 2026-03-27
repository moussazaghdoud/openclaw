/**
 * Sales Agent — Core Orchestrator
 *
 * Initializes the sales module, detects sales-specific intents,
 * and routes to the appropriate handler. Integrates with agent.js
 * by registering sales tools into the agentic loop.
 *
 * Phase 1: Read-only pipeline analysis via agent tools.
 */

const salesTools = require("./sales-tools");
const LOG = "[Sales-Agent]";

let sfAuthModule = null;
let sfApiModule = null;
let redisClient = null;
let initialized = false;

function init(deps) {
  sfAuthModule = deps.sfAuth || null;
  sfApiModule = deps.sfApi || null;
  redisClient = deps.redis || null;

  salesTools.init({
    sfAuth: sfAuthModule,
    sfApi: sfApiModule,
    redis: redisClient,
  });

  initialized = true;
  console.log(`${LOG} Initialized (available: ${isAvailable()})`);
}

function isAvailable() {
  return !!(initialized && sfAuthModule && sfApiModule);
}

// ══════════════════════════════════════════════════════════
// INTENT DETECTION
// ══════════════════════════════════════════════════════════

/**
 * Detect if a message is a sales/pipeline query.
 * Returns true if the message should be handled by the sales agent.
 */
function isSalesQuery(message) {
  if (!message) return false;
  return /\b(pipeline|deal[s ]?risk|stale.?deal|at.?risk|ghost.?deal|next.?step|pipeline.?health|pipeline.?summary|sales.?report|forecast|deal.?review|pipeline.?review|win.?rate|deal.?stuck|no.?activity|follow.?up.?miss|missing.?next|pipeline.?coverage|quota|sales.?performance|deal.?slip|close.?date|pipeline.?discipline|fake.?pipeline)\b/i.test(message);
}

/**
 * Get tool definitions to register in agent.js.
 */
function getToolDefinitions() {
  if (!isAvailable()) return [];
  return salesTools.getToolDefinitions();
}

/**
 * Execute a sales tool (called from agent.js executeTool).
 */
async function executeTool(toolName, input, userId) {
  return salesTools.executeTool(toolName, input, userId);
}

/**
 * Execute a pending write action (after user confirms "yes").
 */
async function executePendingAction(userId) {
  return salesTools.executePendingAction(userId);
}

/**
 * Get progress message for a sales tool (for onProgress callback).
 */
function getProgressMessage(toolName) {
  const map = {
    analyze_pipeline: "Analyzing pipeline...",
    get_deal_risks: "Checking deal risks...",
    get_stale_deals: "Finding stale deals...",
    get_missing_next_steps: "Checking next steps...",
    get_pipeline_summary: "Building pipeline summary...",
    get_deal_details: "Looking up deal details...",
    get_ghost_deals: "Detecting ghost deals...",
    get_deals_by_owner: "Analyzing rep performance...",
  };
  return map[toolName] || null;
}

module.exports = {
  init,
  isAvailable,
  isSalesQuery,
  getToolDefinitions,
  executeTool,
  executePendingAction,
  getProgressMessage,
};
