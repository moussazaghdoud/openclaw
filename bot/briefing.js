/**
 * Cross-System Context Aggregation & Executive Briefing Builder
 *
 * Combines data from Email (Outlook/Gmail), Calendar (Outlook/Google),
 * Salesforce CRM, and SharePoint Documents into unified insights.
 *
 * Includes:
 * - entityResolver: resolve identities across systems
 * - peopleMatcher: match people across email/calendar/CRM
 * - accountMatcher: match companies via email domains + Salesforce
 * - topicMatcher: identify topics across systems
 * - briefingBuilder: generate unified executive briefings
 */

const LOG = "[Briefing]";

let emailIntentsMod = null;
let calendarIntentsMod = null;
let sfIntentsMod = null;
let spIntentsMod = null;
let callOpenClawFn = null;
let redisClient = null;

// API modules (set during init)
let m365AuthMod = null;
let gmailAuthMod = null;
let sfAuthMod = null;
let m365GraphMod = null;
let gmailApiMod = null;
let calendarGraphMod = null;
let calendarGoogleMod = null;
let sfApiMod = null;
let spApiMod = null;

// ── Init ─────────────────────────────────────────────────

function init(deps) {
  emailIntentsMod = deps.emailIntents || null;
  calendarIntentsMod = deps.calendarIntents || null;
  sfIntentsMod = deps.sfIntents || null;
  spIntentsMod = deps.spIntents || null;
  callOpenClawFn = deps.callOpenClaw;
  redisClient = deps.redis;
  m365AuthMod = deps.m365Auth || null;
  gmailAuthMod = deps.gmailAuth || null;
  sfAuthMod = deps.sfAuth || null;
  m365GraphMod = deps.m365Graph || null;
  gmailApiMod = deps.gmailApi || null;
  calendarGraphMod = deps.calendarGraph || null;
  calendarGoogleMod = deps.calendarGoogle || null;
  sfApiMod = deps.sfApi || null;
  spApiMod = deps.spApi || null;
  console.log(`${LOG} Initialized`);
}

// ── Intent Detection ────────────────────────────────────

function detectBriefingIntent(message) {
  const msg = message.toLowerCase().trim();

  // Morning/daily/executive briefing
  if (/\b(morning|daily|executive|today'?s?)\s+(briefing|brief|digest|summary|overview|update|report)\b/i.test(msg) ||
      /\b(briefing|brief|digest)\s+(for\s+)?(today|this\s+morning|the\s+day)\b/i.test(msg) ||
      /\bwhat('?s|\s+is|\s+do\s+i\s+have)\s+(on\s+)?(my\s+)?(plate|agenda|to\s+do)\s+today\b/i.test(msg) ||
      /\bwhat\s+needs?\s+my\s+attention\b/i.test(msg) ||
      /\bprepare\s+my\s+(morning\s+)?briefing\b/i.test(msg)) {
    return { type: "briefing_daily" };
  }

  // Prepare for meeting with X (cross-system)
  if (/\b(prepare|brief)\s+(me\s+)?(for|about)\s+(my\s+)?(meeting|call|sync)\s+(with|about)\s+(.+)/i.test(message)) {
    const match = message.match(/\b(?:prepare|brief)\s+(?:me\s+)?(?:for|about)\s+(?:my\s+)?(?:meeting|call|sync)\s+(?:with|about)\s+(.+?)(?:\?|$)/i);
    return { type: "briefing_meeting", query: match ? match[1].trim() : message };
  }

  // Customer/account context ("tell me about X", "context for X")
  if (/\b(context|background|info|information|tell\s+me\s+about|everything\s+(?:about|on))\s+(?:for\s+|on\s+|about\s+)?(.+)/i.test(message) &&
      /\b(customer|client|account|company)\b/i.test(msg)) {
    const match = message.match(/\b(?:context|background|info|information|tell\s+me\s+about|everything\s+(?:about|on))\s+(?:for\s+|on\s+|about\s+)?(.+?)(?:\?|$)/i);
    return { type: "briefing_customer", query: match ? match[1].trim() : message };
  }

  // Weekly summary
  if (/\b(week(?:ly)?|this\s+week'?s?)\s+(briefing|brief|summary|digest|overview|report)\b/i.test(msg)) {
    return { type: "briefing_weekly" };
  }

  // Follow-up tracking
  if (/\b(pending|open)\s+(follow[- ]?ups?|action\s+items?|tasks?)\b/i.test(msg) ||
      /\bfollow[- ]?ups?\b/i.test(msg) && /\b(what|show|list|any|pending)\b/i.test(msg)) {
    return { type: "briefing_followups" };
  }

  return null;
}

// ── Intent Handlers ─────────────────────────────────────

async function handleBriefingIntent(userId, intent, originalMessage) {
  try {
    switch (intent.type) {
      case "briefing_daily":
        return await buildDailyBriefing(userId);
      case "briefing_meeting":
        return await buildMeetingBriefing(userId, intent.query);
      case "briefing_customer":
        return await buildCustomerBriefing(userId, intent.query);
      case "briefing_weekly":
        return await buildWeeklyBriefing(userId);
      case "briefing_followups":
        return await buildFollowUpReport(userId);
      default:
        return "I didn't understand that briefing request.";
    }
  } catch (err) {
    console.error(`${LOG} Error handling ${intent.type}:`, err.message);
    return `Sorry, there was an error building the briefing: ${err.message}`;
  }
}

// ── Daily Briefing ──────────────────────────────────────

async function buildDailyBriefing(userId) {
  const connected = await getConnectedServices(userId);
  if (connected.length === 0) {
    return "You haven't connected any services yet. Use **jojo connect gmail**, **jojo connect outlook**, or **jojo connect salesforce** to get started.";
  }

  // Gather data from all connected services in parallel
  const tasks = [];
  const labels = [];

  // Email
  const emailProvider = await resolveEmailProvider(userId);
  if (emailProvider) {
    tasks.push(emailProvider.api.getUnreadEmails(emailProvider.token, 15).catch(() => []));
    labels.push("unreadEmails");
  }

  // Calendar
  const calProvider = await resolveCalendarProvider(userId);
  if (calProvider) {
    tasks.push(calProvider.api.getTodayEvents(calProvider.token).catch(() => []));
    labels.push("todayMeetings");
  }

  // Salesforce
  const sfProvider = await resolveSalesforceProvider(userId);
  if (sfProvider) {
    tasks.push(sfApiMod.getOpenOpportunities(sfProvider.token, sfProvider.instanceUrl, 5).catch(() => []));
    labels.push("pipeline");
  }

  const results = await Promise.all(tasks);
  const data = {};
  labels.forEach((label, i) => { data[label] = results[i]; });

  // Build the briefing via AI
  const aiPrompt = `You are an executive AI assistant. Create a concise morning briefing for today.

Connected services: ${connected.join(", ")}
Today's date: ${new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}

${data.unreadEmails ? `UNREAD EMAILS (${Array.isArray(data.unreadEmails) ? data.unreadEmails.length : 0}):
${JSON.stringify(data.unreadEmails)}` : ""}

${data.todayMeetings ? `TODAY'S MEETINGS (${Array.isArray(data.todayMeetings) ? data.todayMeetings.length : 0}):
${JSON.stringify(data.todayMeetings)}` : ""}

${data.pipeline ? `OPEN PIPELINE (${Array.isArray(data.pipeline) ? data.pipeline.length : 0}):
${JSON.stringify(data.pipeline)}` : ""}

Create a structured briefing with these sections (only include sections with data):
1. **Schedule** — today's meetings with times
2. **Priority Emails** — urgent/important emails needing attention
3. **Action Items** — emails requiring decisions or follow-up
4. **Pipeline Updates** — key deals (if Salesforce connected)
5. **Suggested Actions** — what to focus on first

Keep it concise, executive-friendly. Use bullet points. Max 600 words.`;

  const response = await callOpenClawFn(userId, aiPrompt);
  return response || "Sorry, I couldn't generate the briefing.";
}

// ── Meeting Briefing (Cross-System) ─────────────────────

async function buildMeetingBriefing(userId, query) {
  const tasks = [];
  const labels = [];

  // Get today's meetings to find the relevant one
  const calProvider = await resolveCalendarProvider(userId);
  if (calProvider) {
    tasks.push(calProvider.api.getTodayEvents(calProvider.token).catch(() => []));
    labels.push("meetings");
    // Also get tomorrow's
    tasks.push(calProvider.api.getTomorrowEvents(calProvider.token).catch(() => []));
    labels.push("tomorrowMeetings");
  }

  // Get emails related to the query
  const emailProvider = await resolveEmailProvider(userId);
  if (emailProvider) {
    tasks.push(emailProvider.api.searchEmails(emailProvider.token, query, 10).catch(() => []));
    labels.push("relatedEmails");
  }

  // Get Salesforce data if it looks like a company/customer
  const sfProvider = await resolveSalesforceProvider(userId);
  if (sfProvider) {
    tasks.push(sfApiMod.searchAccounts(sfProvider.token, sfProvider.instanceUrl, query, 3).catch(() => []));
    labels.push("accounts");
  }

  const results = await Promise.all(tasks);
  const data = {};
  labels.forEach((label, i) => { data[label] = results[i]; });

  // Find the matching meeting
  const allMeetings = [...(data.meetings || []), ...(data.tomorrowMeetings || [])];

  // If we found a Salesforce account, fetch more context
  let sfContext = null;
  if (data.accounts && data.accounts.length > 0 && sfProvider) {
    const account = data.accounts[0];
    const [contacts, opportunities] = await Promise.all([
      sfApiMod.getContactsByAccount(sfProvider.token, sfProvider.instanceUrl, account.id, 5).catch(() => []),
      sfApiMod.getOpportunities(sfProvider.token, sfProvider.instanceUrl, account.id, 5).catch(() => []),
    ]);
    sfContext = { account, contacts, opportunities };
  }

  const aiPrompt = `You are an executive AI assistant preparing a meeting briefing.

The user wants to prepare for a meeting related to: "${query}"

CALENDAR DATA:
${JSON.stringify(allMeetings)}

RELATED EMAILS:
${JSON.stringify(data.relatedEmails || [])}

${sfContext ? `SALESFORCE CRM DATA:
Account: ${JSON.stringify(sfContext.account)}
Key Contacts: ${JSON.stringify(sfContext.contacts)}
Opportunities: ${JSON.stringify(sfContext.opportunities)}` : ""}

Create a structured meeting briefing:
1. **Meeting Details** — time, participants, objective
2. **Participant Context** — who they are (from CRM if available)
3. **Recent Communication** — relevant email threads
4. **Business Context** — active deals, account status (from CRM if available)
5. **Preparation Suggestions** — key points to cover, questions to ask
6. **Risks / Attention Items** — anything to watch out for

Be concise and actionable. Max 600 words.`;

  const response = await callOpenClawFn(userId, aiPrompt);
  return response || "Sorry, I couldn't generate the meeting briefing.";
}

// ── Customer Briefing (Cross-System) ────────────────────

async function buildCustomerBriefing(userId, query) {
  const tasks = [];
  const labels = [];

  // Email
  const emailProvider = await resolveEmailProvider(userId);
  if (emailProvider) {
    tasks.push(emailProvider.api.searchEmails(emailProvider.token, query, 10).catch(() => []));
    labels.push("emails");
  }

  // Calendar
  const calProvider = await resolveCalendarProvider(userId);
  if (calProvider) {
    tasks.push(calProvider.api.getWeekEvents(calProvider.token).catch(() => []));
    labels.push("weekMeetings");
  }

  // Salesforce
  const sfProvider = await resolveSalesforceProvider(userId);
  if (sfProvider) {
    tasks.push(sfApiMod.searchAccounts(sfProvider.token, sfProvider.instanceUrl, query, 3).catch(() => []));
    labels.push("accounts");
  }

  const results = await Promise.all(tasks);
  const data = {};
  labels.forEach((label, i) => { data[label] = results[i]; });

  // Deep Salesforce data
  let sfDeep = null;
  if (data.accounts && data.accounts.length > 0 && sfProvider) {
    const account = data.accounts[0];
    const [contacts, opportunities, activity] = await Promise.all([
      sfApiMod.getContactsByAccount(sfProvider.token, sfProvider.instanceUrl, account.id, 10).catch(() => []),
      sfApiMod.getOpportunities(sfProvider.token, sfProvider.instanceUrl, account.id, 10).catch(() => []),
      sfApiMod.getRecentActivity(sfProvider.token, sfProvider.instanceUrl, { accountId: account.id }).catch(() => null),
    ]);
    sfDeep = { account, contacts, opportunities, activity };
  }

  // Filter meetings related to the query
  const relatedMeetings = (data.weekMeetings || []).filter(m => {
    const text = `${m.subject} ${(m.attendees || []).map(a => `${a.name} ${a.email}`).join(" ")}`.toLowerCase();
    return query.toLowerCase().split(/\s+/).some(word => text.includes(word));
  });

  const aiPrompt = `You are an executive AI assistant building a comprehensive customer context briefing.

Customer/Company query: "${query}"

RECENT EMAILS (${(data.emails || []).length}):
${JSON.stringify(data.emails || [])}

RELATED MEETINGS THIS WEEK (${relatedMeetings.length}):
${JSON.stringify(relatedMeetings)}

${sfDeep ? `SALESFORCE CRM:
Account: ${JSON.stringify(sfDeep.account)}
Contacts: ${JSON.stringify(sfDeep.contacts)}
Opportunities: ${JSON.stringify(sfDeep.opportunities)}
Recent Activity: ${JSON.stringify(sfDeep.activity)}` : "No CRM data available."}

Create a comprehensive customer briefing:
1. **Company Overview** — key facts from CRM
2. **Key Contacts** — people involved, their roles
3. **Communication History** — recent email highlights
4. **Upcoming Meetings** — scheduled interactions
5. **Active Deals** — opportunities, stages, amounts
6. **Recent Activity** — latest CRM interactions
7. **Suggested Actions** — recommended next steps

Be concise and executive-friendly. Max 800 words.`;

  const response = await callOpenClawFn(userId, aiPrompt);
  return response || "Sorry, I couldn't generate the customer briefing.";
}

// ── Weekly Briefing ─────────────────────────────────────

async function buildWeeklyBriefing(userId) {
  const tasks = [];
  const labels = [];

  const emailProvider = await resolveEmailProvider(userId);
  if (emailProvider) {
    tasks.push(emailProvider.api.getUnreadEmails(emailProvider.token, 20).catch(() => []));
    labels.push("unread");
  }

  const calProvider = await resolveCalendarProvider(userId);
  if (calProvider) {
    tasks.push(calProvider.api.getWeekEvents(calProvider.token).catch(() => []));
    labels.push("weekMeetings");
  }

  const sfProvider = await resolveSalesforceProvider(userId);
  if (sfProvider) {
    tasks.push(sfApiMod.getOpenOpportunities(sfProvider.token, sfProvider.instanceUrl, 10).catch(() => []));
    labels.push("pipeline");
  }

  const results = await Promise.all(tasks);
  const data = {};
  labels.forEach((label, i) => { data[label] = results[i]; });

  const aiPrompt = `You are an executive AI assistant creating a weekly overview.

UNREAD EMAILS: ${JSON.stringify(data.unread || [])}
THIS WEEK'S MEETINGS: ${JSON.stringify(data.weekMeetings || [])}
OPEN PIPELINE: ${JSON.stringify(data.pipeline || [])}

Create a weekly overview:
1. **Week at a Glance** — # of meetings, key events
2. **Priority Emails** — what needs attention
3. **Key Meetings** — important meetings this week with prep hints
4. **Pipeline Summary** — deal status, closing this week
5. **Recommended Focus Areas** — what to prioritize

Max 600 words.`;

  const response = await callOpenClawFn(userId, aiPrompt);
  return response || "Sorry, I couldn't generate the weekly briefing.";
}

// ── Follow-Up Report ────────────────────────────────────

async function buildFollowUpReport(userId) {
  const tasks = [];
  const labels = [];

  const emailProvider = await resolveEmailProvider(userId);
  if (emailProvider) {
    tasks.push(emailProvider.api.getRecentEmails(emailProvider.token, 30).catch(() => []));
    labels.push("recentEmails");
  }

  const sfProvider = await resolveSalesforceProvider(userId);
  if (sfProvider) {
    tasks.push(sfApiMod.getRecentActivity(sfProvider.token, sfProvider.instanceUrl, { limit: 15 }).catch(() => null));
    labels.push("activity");
  }

  const results = await Promise.all(tasks);
  const data = {};
  labels.forEach((label, i) => { data[label] = results[i]; });

  const aiPrompt = `You are an executive AI assistant tracking follow-ups.

RECENT EMAILS: ${JSON.stringify(data.recentEmails || [])}
CRM ACTIVITY: ${JSON.stringify(data.activity || {})}

Analyze and identify:
1. **Emails Awaiting Reply** — sent emails with no response
2. **Action Items from Emails** — commitments made in recent emails
3. **Pending CRM Tasks** — open tasks from Salesforce
4. **Overdue Items** — anything past deadline

For each follow-up, indicate urgency (High/Medium/Low).
Max 500 words.`;

  const response = await callOpenClawFn(userId, aiPrompt);
  return response || "Sorry, I couldn't generate the follow-up report.";
}

// ── Entity Resolution Helpers ───────────────────────────

/**
 * Match a person across email, calendar, and CRM.
 * Uses email domain matching and name fuzzy matching.
 */
async function matchPerson(userId, nameOrEmail) {
  const results = { email: null, calendar: null, crm: null };

  // Search email
  const emailProvider = await resolveEmailProvider(userId);
  if (emailProvider) {
    const emails = await emailProvider.api.searchEmails(emailProvider.token, nameOrEmail, 5).catch(() => []);
    if (emails && emails.length > 0) {
      results.email = {
        name: emails[0].from,
        email: emails[0].fromEmail,
        recentEmails: emails.length,
      };
    }
  }

  // Search CRM
  const sfProvider = await resolveSalesforceProvider(userId);
  if (sfProvider) {
    const contacts = await sfApiMod.searchContacts(sfProvider.token, sfProvider.instanceUrl, nameOrEmail, 3).catch(() => []);
    if (contacts && contacts.length > 0) {
      results.crm = contacts[0];
    }
  }

  return results;
}

/**
 * Match a company/account across email domains and Salesforce.
 */
async function matchAccount(userId, companyName) {
  const results = { crm: null, emailDomain: null, recentEmails: 0 };

  // Search Salesforce
  const sfProvider = await resolveSalesforceProvider(userId);
  if (sfProvider) {
    const accounts = await sfApiMod.searchAccounts(sfProvider.token, sfProvider.instanceUrl, companyName, 3).catch(() => []);
    if (accounts && accounts.length > 0) {
      results.crm = accounts[0];
    }
  }

  // Search emails
  const emailProvider = await resolveEmailProvider(userId);
  if (emailProvider) {
    const emails = await emailProvider.api.searchEmails(emailProvider.token, companyName, 10).catch(() => []);
    if (emails && emails.length > 0) {
      results.recentEmails = emails.length;
      // Extract domain from first matching email
      const firstEmail = emails[0].fromEmail || "";
      const domain = firstEmail.split("@")[1];
      if (domain) results.emailDomain = domain;
    }
  }

  return results;
}

// ── Provider Resolution ─────────────────────────────────

async function resolveEmailProvider(userId) {
  // Gmail first, then M365
  if (gmailApiMod && gmailAuthMod) {
    const result = await gmailAuthMod.getValidToken(userId);
    if (result) return { provider: "gmail", token: result.token, api: gmailApiMod };
  }
  if (m365GraphMod && m365AuthMod) {
    const result = await m365AuthMod.getValidToken(userId);
    if (result) return { provider: "outlook", token: result.token, api: m365GraphMod };
  }
  return null;
}

async function resolveCalendarProvider(userId) {
  if (calendarGoogleMod && gmailAuthMod) {
    const result = await gmailAuthMod.getValidToken(userId);
    if (result) return { provider: "google", token: result.token, api: calendarGoogleMod };
  }
  if (calendarGraphMod && m365AuthMod) {
    const result = await m365AuthMod.getValidToken(userId);
    if (result) return { provider: "outlook", token: result.token, api: calendarGraphMod };
  }
  return null;
}

async function resolveSalesforceProvider(userId) {
  if (sfApiMod && sfAuthMod) {
    const result = await sfAuthMod.getValidToken(userId);
    if (result) return { token: result.token, instanceUrl: result.instanceUrl };
  }
  return null;
}

async function getConnectedServices(userId) {
  const services = [];
  if (await resolveEmailProvider(userId)) services.push("Email");
  if (await resolveCalendarProvider(userId)) services.push("Calendar");
  if (await resolveSalesforceProvider(userId)) services.push("Salesforce");
  // SharePoint uses same M365 token
  if (m365AuthMod && spApiMod) {
    const result = await m365AuthMod.getValidToken(userId);
    if (result) services.push("SharePoint");
  }
  return services;
}

module.exports = {
  init,
  detectBriefingIntent,
  handleBriefingIntent,
  // Cross-system helpers (can be used by other modules)
  matchPerson,
  matchAccount,
  getConnectedServices,
};
