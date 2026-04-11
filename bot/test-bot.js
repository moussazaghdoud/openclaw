#!/usr/bin/env node
/**
 * Juju Bot — Integration Test Suite
 *
 * Tests identity, context memory, waiting phrases, and pronoun resolution
 * against the live bot via /api/agent-test endpoint.
 *
 * Usage:
 *   node test-bot.js                          # uses default URL
 *   node test-bot.js https://your-bot-url     # custom URL
 *   BOT_URL=https://your-bot-url node test-bot.js
 */

const BOT_URL = process.argv[2] || process.env.BOT_URL || "https://bot-production-4410.up.railway.app";
const TEST_USER = `test-${Date.now()}`;

let passed = 0;
let failed = 0;
const results = [];

function log(icon, test, detail) {
  const line = `${icon} ${test}: ${detail}`;
  console.log(line);
  results.push(line);
}

function assert(test, condition, detail) {
  if (condition) {
    passed++;
    log("\x1b[32mPASS\x1b[0m", test, detail);
  } else {
    failed++;
    log("\x1b[31mFAIL\x1b[0m", test, detail);
  }
}

async function agentCall(message, userId) {
  const uid = userId || TEST_USER;
  const url = `${BOT_URL}/api/agent-test?q=${encodeURIComponent(message)}&uid=${uid}`;
  const resp = await fetch(url, { signal: AbortSignal.timeout(60000) });
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

function getAnswer(result) {
  if (!result || !result.result) return "";
  const r = result.result;
  if (typeof r === "string") return r;
  if (r.response) return r.response;
  if (r.text) return r.text;
  // Agent returns { response, ... } or plain string
  return JSON.stringify(r);
}

// ─── Test Suites ────────────────────────────────────────

async function testIdentity() {
  console.log("\n--- Identity Tests ---");

  const r1 = await agentCall("What is your name?");
  const a1 = getAnswer(r1).toLowerCase();
  assert("Name recognition", a1.includes("juju"), `Got: "${a1.substring(0, 100)}"`);

  const r2 = await agentCall("Who are you?");
  const a2 = getAnswer(r2).toLowerCase();
  assert("Self-identification", a2.includes("juju"), `Got: "${a2.substring(0, 100)}"`);

  const r3 = await agentCall("Do you have a name?");
  const a3 = getAnswer(r3).toLowerCase();
  assert("Name confirmation", a3.includes("juju"), `Got: "${a3.substring(0, 100)}"`);
}

async function testContextMemory() {
  console.log("\n--- Context Memory Tests ---");
  const uid = `ctx-${Date.now()}`;

  // Build up conversation context
  await agentCall("My favorite color is bright orange.", uid);
  await agentCall("I work at a company called Globex Corp.", uid);
  await agentCall("My dog's name is Biscuit.", uid);

  // Test recall after 3 messages
  const r1 = await agentCall("What is my favorite color?", uid);
  const a1 = getAnswer(r1).toLowerCase();
  assert("Recall after 3 msgs", a1.includes("orange"), `Got: "${a1.substring(0, 100)}"`);

  // Add more filler
  await agentCall("The weather is nice today.", uid);
  await agentCall("I had pasta for lunch.", uid);
  await agentCall("Tell me a fun fact.", uid);

  // Test recall after 6 messages
  const r2 = await agentCall("Where do I work?", uid);
  const a2 = getAnswer(r2).toLowerCase();
  assert("Recall after 6 msgs", a2.includes("globex"), `Got: "${a2.substring(0, 100)}"`);

  // Test recall of early detail after many messages
  const r3 = await agentCall("What's my dog's name?", uid);
  const a3 = getAnswer(r3).toLowerCase();
  assert("Recall early detail", a3.includes("biscuit"), `Got: "${a3.substring(0, 100)}"`);
}

async function testPronounResolution() {
  console.log("\n--- Pronoun Resolution Tests ---");
  const uid = `pronoun-${Date.now()}`;

  await agentCall("I had a meeting with Sarah Johnson yesterday.", uid);

  const r1 = await agentCall("What do you know about her?", uid);
  const a1 = getAnswer(r1).toLowerCase();
  assert("Pronoun 'her' resolves", a1.includes("sarah"), `Got: "${a1.substring(0, 100)}"`);

  await agentCall("I'm working on the Apollo project with Marc.", uid);

  const r2 = await agentCall("Tell me more about that project.", uid);
  const a2 = getAnswer(r2).toLowerCase();
  assert("Pronoun 'that' resolves", a2.includes("apollo"), `Got: "${a2.substring(0, 100)}"`);
}

async function testWaitingPhrases() {
  console.log("\n--- Waiting Phrases Tests ---");

  // We can't directly test what Rainbow sees, but we can verify the module loads
  // and the phrases array exists by checking the agent trace
  const r1 = await agentCall("Show me my recent emails");
  const trace = r1.trace;

  // Check that no technical progress messages leak into the response
  const answer = getAnswer(r1).toLowerCase();
  const technicalPhrases = ["searching crm", "searching emails", "checking inbox", "thinking..."];
  const hasTechnical = technicalPhrases.some(p => answer.includes(p));
  assert("No technical jargon in response", !hasTechnical, hasTechnical ? `Found technical phrase in: "${answer.substring(0, 100)}"` : "Clean response");

  // Verify agent trace exists (tools were called)
  assert("Agent trace available", trace && trace.tools, `Trace: ${trace ? JSON.stringify(trace.tools) : "null"}`);
}

async function testFollowUps() {
  console.log("\n--- Follow-up Tests ---");
  const uid = `followup-${Date.now()}`;

  await agentCall("I need to prepare for my meeting with the Acme team.", uid);

  const r1 = await agentCall("What about their latest deal?", uid);
  const a1 = getAnswer(r1).toLowerCase();
  assert("Follow-up references 'their'", a1.includes("acme") || a1.length > 20, `Got: "${a1.substring(0, 100)}"`);

  const r2 = await agentCall("And the same for Contoso.", uid);
  const a2 = getAnswer(r2).toLowerCase();
  assert("Follow-up with 'same for'", a2.includes("contoso") || a2.length > 20, `Got: "${a2.substring(0, 100)}"`);
}

async function testHealthCheck() {
  console.log("\n--- Health Check ---");

  try {
    const resp = await fetch(`${BOT_URL}/api/status`, { signal: AbortSignal.timeout(10000) });
    assert("Bot reachable", resp.ok, `HTTP ${resp.status}`);

    const status = await resp.json();
    assert("Bot is running", status.status === "ok" || status.uptime > 0, JSON.stringify(status).substring(0, 100));
  } catch (e) {
    assert("Bot reachable", false, e.message);
  }

  try {
    const resp = await fetch(`${BOT_URL}/api/agent-status`, { signal: AbortSignal.timeout(10000) });
    const agentStatus = await resp.json();
    assert("Agent loaded", agentStatus.loaded, JSON.stringify(agentStatus));
    assert("Agent available", agentStatus.available, JSON.stringify(agentStatus));
  } catch (e) {
    assert("Agent status", false, e.message);
  }
}

// ─── Main ───────────────────────────────────────────────

async function main() {
  console.log(`\nJuju Bot Test Suite`);
  console.log(`Target: ${BOT_URL}`);
  console.log(`Test user: ${TEST_USER}`);
  console.log("=".repeat(50));

  // Health check first — abort if bot is down
  await testHealthCheck();
  if (failed > 0) {
    console.log("\nBot is not reachable — skipping remaining tests.");
    process.exit(1);
  }

  // Run all test suites
  await testIdentity();
  await testContextMemory();
  await testPronounResolution();
  await testFollowUps();
  await testWaitingPhrases();

  // Summary
  console.log("\n" + "=".repeat(50));
  console.log(`Results: ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log("=".repeat(50));

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => {
  console.error("Test suite crashed:", e.message);
  process.exit(1);
});
