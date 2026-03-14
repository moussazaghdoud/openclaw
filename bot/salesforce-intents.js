/**
 * Salesforce CRM Intent Handler
 *
 * Detects CRM-related intents from user messages and dispatches
 * to the Salesforce REST API.
 *
 * Follows the same architecture as email-intents.js and calendar-intents.js.
 */

const LOG = "[Salesforce-Intents]";

let sfApiModule = null;
let sfAuthModule = null;
let callOpenClawFn = null;
let redisClient = null;

// ── Init ─────────────────────────────────────────────────

function init({ salesforceApiMod, salesforceAuthMod, callOpenClaw, redis }) {
  sfApiModule = salesforceApiMod;
  sfAuthModule = salesforceAuthMod;
  callOpenClawFn = callOpenClaw;
  redisClient = redis;
  console.log(`${LOG} Initialized`);
}

// ── Provider Resolution ─────────────────────────────────

async function resolveProvider(userId) {
  if (!sfApiModule || !sfAuthModule) return null;
  const result = await sfAuthModule.getValidToken(userId);
  if (!result) return null;
  return {
    token: result.token,
    instanceUrl: result.instanceUrl,
    email: result.email,
  };
}

// ── Intent Detection ────────────────────────────────────

function detectSalesforceIntent(message) {
  const msg = message.toLowerCase().trim();

  // Search accounts / company info
  if (/\b(search|find|look\s*up|get|show)\s+(account|company|customer|client|organisation|organization)s?\s*(named|called|for)?\s+(.+)/i.test(message)) {
    const match = message.match(/\b(?:search|find|look\s*up|get|show)\s+(?:account|company|customer|client|organisation|organization)s?\s*(?:named|called|for)?\s+(.+?)(?:\?|$)/i);
    return { type: "sf_search_accounts", query: match ? match[1].trim() : message };
  }

  // Account details
  if (/\b(account|company|customer|client)\s+(info|details|summary|overview|data)\s*(for|about|on)?\s+(.+)/i.test(message)) {
    const match = message.match(/\b(?:account|company|customer|client)\s+(?:info|details|summary|overview|data)\s*(?:for|about|on)?\s+(.+?)(?:\?|$)/i);
    return { type: "sf_account_details", query: match ? match[1].trim() : message };
  }

  // Search contacts
  if (/\b(search|find|look\s*up|get|show)\s+(contact|person|people)s?\s*(named|called|for|from)?\s+(.+)/i.test(message)) {
    const match = message.match(/\b(?:search|find|look\s*up|get|show)\s+(?:contact|person|people)s?\s*(?:named|called|for|from)?\s+(.+?)(?:\?|$)/i);
    return { type: "sf_search_contacts", query: match ? match[1].trim() : message };
  }

  // Opportunities / pipeline / deals
  if (/\b(opportunit|pipeline|deal|open\s+deal|active\s+deal|sales\s+pipeline)/i.test(msg)) {
    // Extract account name if present
    const accMatch = message.match(/\b(?:opportunit\w*|deals?|pipeline)\s+(?:for|with|at|from)\s+(.+?)(?:\?|$)/i);
    return { type: "sf_opportunities", accountQuery: accMatch ? accMatch[1].trim() : null };
  }

  // CRM activity / recent updates
  if (/\b(recent\s+activit|crm\s+activit|customer\s+activit|recent\s+update|crm\s+update|activity\s+log|activity\s+history)\b/i.test(msg)) {
    const accMatch = message.match(/\bactivit\w*\s+(?:for|with|at|from|on)\s+(.+?)(?:\?|$)/i);
    return { type: "sf_activity", accountQuery: accMatch ? accMatch[1].trim() : null };
  }

  // Prepare briefing for customer meeting
  if (/\b(prepare|brief|briefing|crm\s+brief|customer\s+brief|meeting\s+prep)\b/i.test(msg) &&
      /\b(customer|client|account|company|meeting|with)\b/i.test(msg)) {
    const accMatch = message.match(/\b(?:for|about|with|on)\s+(.+?)(?:\?|$)/i);
    return { type: "sf_briefing", query: accMatch ? accMatch[1].trim() : message };
  }

  // Global CRM search
  if (/\b(crm|salesforce)\s+(search|find|look)/i.test(msg)) {
    const match = message.match(/\b(?:crm|salesforce)\s+(?:search|find|look)\s*(?:for|up)?\s+(.+?)(?:\?|$)/i);
    return { type: "sf_global_search", query: match ? match[1].trim() : message };
  }

  // Smart catch-all: any message with CRM/Salesforce/customer context keywords
  if (/\b(salesforce|crm|pipeline|opportunity|account\s+info|customer\s+data)\b/i.test(msg)) {
    return { type: "sf_smart_query", query: message };
  }

  return null;
}

// ── Intent Handlers ─────────────────────────────────────

async function handleSalesforceIntent(userId, intent, originalMessage) {
  const resolved = await resolveProvider(userId);
  if (!resolved) {
    return "You haven't connected Salesforce yet. Use **jojo connect salesforce** to link your account.";
  }

  const { token, instanceUrl } = resolved;

  try {
    switch (intent.type) {
      case "sf_search_accounts":
        return await handleSearchAccounts(token, instanceUrl, intent);
      case "sf_account_details":
        return await handleAccountDetails(token, instanceUrl, intent);
      case "sf_search_contacts":
        return await handleSearchContacts(token, instanceUrl, intent);
      case "sf_opportunities":
        return await handleOpportunities(token, instanceUrl, intent);
      case "sf_activity":
        return await handleActivity(token, instanceUrl, intent);
      case "sf_briefing":
        return await handleBriefing(token, instanceUrl, userId, intent);
      case "sf_global_search":
        return await handleGlobalSearch(token, instanceUrl, intent);
      case "sf_smart_query":
        return await handleSmartQuery(token, instanceUrl, userId, intent);
      default:
        return "I didn't understand that CRM request.";
    }
  } catch (err) {
    console.error(`${LOG} Error handling ${intent.type}:`, err.message);
    return `Sorry, there was an error accessing Salesforce: ${err.message}`;
  }
}

// ── Search Accounts ─────────────────────────────────────

async function handleSearchAccounts(token, instanceUrl, intent) {
  const accounts = await sfApiModule.searchAccounts(token, instanceUrl, intent.query);
  if (!accounts || accounts.length === 0) {
    return `No accounts found matching "${intent.query}".`;
  }

  let output = `**Accounts matching "${intent.query}":**\n\n`;
  for (const a of accounts) {
    output += `- **${a.name}**`;
    if (a.industry) output += ` | ${a.industry}`;
    if (a.city) output += ` | ${a.city}`;
    if (a.revenue) output += ` | Revenue: ${formatCurrency(a.revenue)}`;
    output += "\n";
  }
  return output;
}

// ── Account Details ─────────────────────────────────────

async function handleAccountDetails(token, instanceUrl, intent) {
  // First search for the account
  const accounts = await sfApiModule.searchAccounts(token, instanceUrl, intent.query, 1);
  if (!accounts || accounts.length === 0) {
    return `No account found matching "${intent.query}".`;
  }

  const account = accounts[0];

  // Get contacts and opportunities for this account
  const [contacts, opportunities] = await Promise.all([
    sfApiModule.getContactsByAccount(token, instanceUrl, account.id, 5),
    sfApiModule.getOpportunities(token, instanceUrl, account.id, 5),
  ]);

  let output = `**${account.name}**\n\n`;
  if (account.industry) output += `Industry: ${account.industry}\n`;
  if (account.type) output += `Type: ${account.type}\n`;
  if (account.phone) output += `Phone: ${account.phone}\n`;
  if (account.website) output += `Website: ${account.website}\n`;
  if (account.city || account.country) output += `Location: ${[account.city, account.country].filter(Boolean).join(", ")}\n`;
  if (account.revenue) output += `Annual Revenue: ${formatCurrency(account.revenue)}\n`;
  if (account.employees) output += `Employees: ${account.employees.toLocaleString()}\n`;
  if (account.owner) output += `Owner: ${account.owner}\n`;

  if (contacts && contacts.length > 0) {
    output += `\n**Key Contacts:**\n`;
    for (const c of contacts) {
      output += `- ${c.name}`;
      if (c.title) output += ` — ${c.title}`;
      if (c.email) output += ` (${c.email})`;
      output += "\n";
    }
  }

  if (opportunities && opportunities.length > 0) {
    output += `\n**Open Opportunities:**\n`;
    for (const o of opportunities) {
      output += `- **${o.name}** — ${o.stage}`;
      if (o.amount) output += ` | ${formatCurrency(o.amount)}`;
      if (o.closeDate) output += ` | Close: ${o.closeDate}`;
      output += "\n";
    }
  }

  if (account.description) {
    output += `\nDescription: ${account.description.substring(0, 500)}\n`;
  }

  return output;
}

// ── Search Contacts ─────────────────────────────────────

async function handleSearchContacts(token, instanceUrl, intent) {
  const contacts = await sfApiModule.searchContacts(token, instanceUrl, intent.query);
  if (!contacts || contacts.length === 0) {
    return `No contacts found matching "${intent.query}".`;
  }

  let output = `**Contacts matching "${intent.query}":**\n\n`;
  for (const c of contacts) {
    output += `- **${c.name}**`;
    if (c.title) output += ` — ${c.title}`;
    if (c.account) output += ` @ ${c.account}`;
    if (c.email) output += ` | ${c.email}`;
    if (c.phone) output += ` | ${c.phone}`;
    output += "\n";
  }
  return output;
}

// ── Opportunities ───────────────────────────────────────

async function handleOpportunities(token, instanceUrl, intent) {
  let opportunities;

  if (intent.accountQuery) {
    // Find the account first
    const accounts = await sfApiModule.searchAccounts(token, instanceUrl, intent.accountQuery, 1);
    if (!accounts || accounts.length === 0) {
      return `No account found matching "${intent.accountQuery}".`;
    }
    opportunities = await sfApiModule.getOpportunities(token, instanceUrl, accounts[0].id);
    if (!opportunities || opportunities.length === 0) {
      return `No open opportunities found for ${accounts[0].name}.`;
    }
  } else {
    opportunities = await sfApiModule.getOpenOpportunities(token, instanceUrl);
    if (!opportunities || opportunities.length === 0) {
      return "No open opportunities in the pipeline.";
    }
  }

  let totalAmount = 0;
  let output = `**${intent.accountQuery ? `Opportunities for "${intent.accountQuery}"` : "Open Pipeline"}:**\n\n`;

  for (const o of opportunities) {
    output += `- **${o.name}**`;
    if (o.account) output += ` (${o.account})`;
    output += `\n  Stage: ${o.stage}`;
    if (o.amount) { output += ` | Amount: ${formatCurrency(o.amount)}`; totalAmount += o.amount; }
    if (o.probability) output += ` | Prob: ${o.probability}%`;
    if (o.closeDate) output += ` | Close: ${o.closeDate}`;
    if (o.nextStep) output += `\n  Next: ${o.nextStep}`;
    output += "\n\n";
  }

  if (totalAmount > 0) {
    output += `**Total Pipeline:** ${formatCurrency(totalAmount)}`;
  }

  return output;
}

// ── Activity ────────────────────────────────────────────

async function handleActivity(token, instanceUrl, intent) {
  let opts = {};

  if (intent.accountQuery) {
    const accounts = await sfApiModule.searchAccounts(token, instanceUrl, intent.accountQuery, 1);
    if (accounts && accounts.length > 0) {
      opts.accountId = accounts[0].id;
    }
  }

  const activity = await sfApiModule.getRecentActivity(token, instanceUrl, opts);
  if (!activity) return "Sorry, couldn't load activity data.";

  const hasTasks = activity.tasks && activity.tasks.length > 0;
  const hasEvents = activity.events && activity.events.length > 0;

  if (!hasTasks && !hasEvents) {
    return intent.accountQuery
      ? `No recent activity found for "${intent.accountQuery}".`
      : "No recent CRM activity found.";
  }

  let output = `**Recent CRM Activity${intent.accountQuery ? ` for "${intent.accountQuery}"` : ""}:**\n\n`;

  if (hasTasks) {
    output += "**Tasks:**\n";
    for (const t of activity.tasks) {
      output += `- ${t.subject} — ${t.status}`;
      if (t.priority && t.priority !== "Normal") output += ` [${t.priority}]`;
      if (t.date) output += ` | ${t.date}`;
      if (t.contact) output += ` | ${t.contact}`;
      output += "\n";
    }
    output += "\n";
  }

  if (hasEvents) {
    output += "**Events:**\n";
    for (const e of activity.events) {
      output += `- ${e.subject}`;
      if (e.start) output += ` | ${new Date(e.start).toLocaleString("fr-FR")}`;
      if (e.contact) output += ` | ${e.contact}`;
      output += "\n";
    }
  }

  return output;
}

// ── Customer Meeting Briefing ───────────────────────────

async function handleBriefing(token, instanceUrl, userId, intent) {
  // Search for the account/company
  const accounts = await sfApiModule.searchAccounts(token, instanceUrl, intent.query, 1);
  if (!accounts || accounts.length === 0) {
    return `No account found matching "${intent.query}" in Salesforce.`;
  }

  const account = accounts[0];

  // Fetch all relevant data in parallel
  const [contacts, opportunities, activity] = await Promise.all([
    sfApiModule.getContactsByAccount(token, instanceUrl, account.id, 10),
    sfApiModule.getOpportunities(token, instanceUrl, account.id, 10),
    sfApiModule.getRecentActivity(token, instanceUrl, { accountId: account.id, limit: 5 }),
  ]);

  // Build context for AI briefing
  const context = {
    account,
    contacts: contacts || [],
    opportunities: opportunities || [],
    recentTasks: activity?.tasks || [],
    recentEvents: activity?.events || [],
  };

  const aiPrompt = `You are an executive AI assistant preparing a customer meeting briefing.

Based on the Salesforce CRM data below, create a concise, executive-friendly briefing for a meeting with ${account.name}.

CRM Data:
${JSON.stringify(context, null, 2)}

Structure your briefing as:
1. **Company Overview** — key facts (industry, size, revenue)
2. **Key Contacts** — who to expect, their roles
3. **Active Opportunities** — current deals, stages, amounts
4. **Recent Activity** — latest interactions
5. **Suggested Talking Points** — based on the data, what to discuss
6. **Risks & Attention Items** — any deals at risk, overdue tasks

Keep it concise and actionable.`;

  const response = await callOpenClawFn(aiPrompt, []);
  return response || `Here's what I found for ${account.name}:\n\n${JSON.stringify(context, null, 2)}`;
}

// ── Global Search ───────────────────────────────────────

async function handleGlobalSearch(token, instanceUrl, intent) {
  const results = await sfApiModule.globalSearch(token, instanceUrl, intent.query);
  if (!results || results._error) return "Sorry, the search failed.";

  const hasResults = (results.accounts?.length || 0) + (results.contacts?.length || 0) + (results.opportunities?.length || 0) > 0;
  if (!hasResults) return `No CRM results found for "${intent.query}".`;

  let output = `**CRM Search: "${intent.query}"**\n\n`;

  if (results.accounts?.length > 0) {
    output += "**Accounts:**\n";
    for (const a of results.accounts) {
      output += `- ${a.name}`;
      if (a.industry) output += ` | ${a.industry}`;
      if (a.phone) output += ` | ${a.phone}`;
      output += "\n";
    }
    output += "\n";
  }

  if (results.contacts?.length > 0) {
    output += "**Contacts:**\n";
    for (const c of results.contacts) {
      output += `- ${c.name}`;
      if (c.account) output += ` @ ${c.account}`;
      if (c.email) output += ` | ${c.email}`;
      output += "\n";
    }
    output += "\n";
  }

  if (results.opportunities?.length > 0) {
    output += "**Opportunities:**\n";
    for (const o of results.opportunities) {
      output += `- ${o.name}`;
      if (o.account) output += ` (${o.account})`;
      if (o.stage) output += ` — ${o.stage}`;
      if (o.amount) output += ` | ${formatCurrency(o.amount)}`;
      output += "\n";
    }
  }

  return output;
}

// ── Smart Query ─────────────────────────────────────────

async function handleSmartQuery(token, instanceUrl, userId, intent) {
  // Get some context data
  const [recentAccounts, pipeline] = await Promise.all([
    sfApiModule.getRecentAccounts(token, instanceUrl, 5),
    sfApiModule.getOpenOpportunities(token, instanceUrl, 5),
  ]);

  const aiPrompt = `You are an executive AI assistant with access to Salesforce CRM data.
Answer the user's question using the CRM data below.

Recent accounts: ${JSON.stringify(recentAccounts)}
Open pipeline: ${JSON.stringify(pipeline)}

User question: "${intent.query}"

Provide a concise, helpful answer.`;

  const response = await callOpenClawFn(aiPrompt, []);
  return response || "Sorry, I couldn't process that CRM request.";
}

// ── Helpers ─────────────────────────────────────────────

function formatCurrency(amount) {
  if (!amount) return "$0";
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 }).format(amount);
}

module.exports = {
  init,
  detectSalesforceIntent,
  handleSalesforceIntent,
  resolveProvider,
};
