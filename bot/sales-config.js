/**
 * Sales Agent — Configuration Constants
 *
 * All tunable thresholds, intervals, and weights for the sales
 * pipeline analysis engine. Modify these to match your org's
 * sales process and cadence.
 */

module.exports = {
  // ── Stale Deal Detection ──────────────────────────────────
  STALE_DEAL_DAYS: 14,              // No activity for N days = stale
  GHOST_DEAL_DAYS: 30,              // No activity for N days = ghost deal
  CLOSE_DATE_WARNING_DAYS: 7,       // Warn if close date within N days
  PAST_CLOSE_DATE_GRACE_DAYS: 0,    // Deals past close date (0 = flag immediately)

  // ── Risk Score Weights (must sum to 1.0) ──────────────────
  RISK_WEIGHTS: {
    inactivity: 0.30,   // Days since last activity
    engagement: 0.25,    // Interaction frequency
    stage: 0.20,         // Stage progression consistency
    amount: 0.15,        // Deal size (larger = higher risk impact)
    time: 0.10,          // Close date pressure
  },

  // ── Risk Thresholds ───────────────────────────────────────
  RISK_HIGH: 70,         // Score >= 70 = High risk
  RISK_MEDIUM: 40,       // Score >= 40 = Medium risk
                         // Score < 40 = Low risk

  // ── Stage Definitions ─────────────────────────────────────
  // Stages where a next step is mandatory
  NEXT_STEP_REQUIRED_STAGES: [
    "Qualification",
    "Needs Analysis",
    "Value Proposition",
    "Id. Decision Makers",
    "Perception Analysis",
    "Proposal/Price Quote",
    "Negotiation/Review",
  ],

  // Expected minimum probability per stage (for inconsistency detection)
  STAGE_PROBABILITY_MAP: {
    "Prospecting": 10,
    "Qualification": 20,
    "Needs Analysis": 30,
    "Value Proposition": 40,
    "Id. Decision Makers": 50,
    "Perception Analysis": 60,
    "Proposal/Price Quote": 70,
    "Negotiation/Review": 80,
    "Closed Won": 100,
    "Closed Lost": 0,
  },

  // Max days a deal should stay in a single stage
  MAX_STAGE_DURATION_DAYS: 30,

  // ── Pipeline Analysis ─────────────────────────────────────
  MAX_OPPORTUNITIES_FETCH: 200,     // Max opps to analyze per run
  ACTIVITY_LOOKBACK_DAYS: 90,       // How far back to fetch activity

  // ── Redis Cache ───────────────────────────────────────────
  CACHE_TTL_SECONDS: 4 * 3600,      // 4 hours cache for analysis results
  CACHE_PREFIX: "sales:",

  // ── Amount Thresholds ─────────────────────────────────────
  HIGH_VALUE_THRESHOLD: 100000,      // Deals above this are high-value
  STRATEGIC_THRESHOLD: 500000,       // Deals above this are strategic
};
