/**
 * AI Agent — Agentic loop with tool calling via Anthropic API.
 *
 * The agent receives a user question and has access to tools (email, calendar, etc.).
 * It decides which tools to call, processes results, and may call more tools
 * before generating a final response. This is a real AI agent, not a search engine.
 */

const LOG = "[Agent]";
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || "";
const MODEL = "claude-sonnet-4-20250514";
const MAX_LOOPS = 5; // Max tool-call rounds to prevent infinite loops
const TIMEOUT_MS = 30000;

let graphModule = null;
let calendarGraphModule = null;
let m365AuthModule = null;
let gmailAuthModule = null;
let gmailApiModule = null;
let calendarGoogleModule = null;
let redisClient = null;

function init(deps) {
  graphModule = deps.graph || null;
  calendarGraphModule = deps.calendarGraph || null;
  m365AuthModule = deps.m365Auth || null;
  gmailAuthModule = deps.gmailAuth || null;
  gmailApiModule = deps.gmailApi || null;
  calendarGoogleModule = deps.calendarGoogle || null;
  redisClient = deps.redis || null;
  console.log(`${LOG} Initialized (email: ${!!graphModule}, calendar: ${!!calendarGraphModule}, anthropic: ${!!ANTHROPIC_API_KEY})`);
}

function isAvailable() {
  return !!(ANTHROPIC_API_KEY && (graphModule || calendarGraphModule));
}

// ── Tool Definitions ────────────────────────────────────

function getTools() {
  const tools = [];

  if (graphModule) {
    tools.push({
      name: "search_emails",
      description: "Search emails by keyword. Searches sender names, subjects, and content. Returns a list of matching emails with id, sender, subject, date, and preview.",
      input_schema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search keyword (sender name, subject keyword, etc.)" },
          max_results: { type: "number", description: "Maximum results to return (default 20)" },
        },
        required: ["query"],
      },
    });
    tools.push({
      name: "get_recent_emails",
      description: "Get the most recent emails from the inbox, ordered by date (newest first).",
      input_schema: {
        type: "object",
        properties: {
          count: { type: "number", description: "Number of emails to fetch (default 20, max 50)" },
        },
      },
    });
    tools.push({
      name: "get_email_detail",
      description: "Get the full content of a specific email by its ID. Use this to read the full body when you need more than the preview.",
      input_schema: {
        type: "object",
        properties: {
          email_id: { type: "string", description: "The email ID from a previous search result" },
        },
        required: ["email_id"],
      },
    });
    tools.push({
      name: "send_email",
      description: "Send an email. ALWAYS confirm with the user before calling this.",
      input_schema: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email address" },
          subject: { type: "string", description: "Email subject" },
          body: { type: "string", description: "Email body text" },
        },
        required: ["to", "subject", "body"],
      },
    });
  }

  if (calendarGraphModule || calendarGoogleModule) {
    tools.push({
      name: "get_calendar_events",
      description: "Get calendar events for a date range. Returns meetings with subject, time, organizer, attendees.",
      input_schema: {
        type: "object",
        properties: {
          period: { type: "string", enum: ["today", "tomorrow", "week", "two_weeks"], description: "Time period to fetch events for" },
        },
        required: ["period"],
      },
    });
    tools.push({
      name: "get_event_detail",
      description: "Get full details of a specific calendar event by ID, including body/notes and online meeting link.",
      input_schema: {
        type: "object",
        properties: {
          event_id: { type: "string", description: "The event ID from a previous calendar result" },
        },
        required: ["event_id"],
      },
    });
  }

  return tools;
}

// ── Tool Execution ──────────────────────────────────────

async function resolveEmailProvider(userId) {
  if (gmailAuthModule && gmailApiModule) {
    const token = await gmailAuthModule.getValidToken(userId);
    if (token) return { api: gmailApiModule, token: token.token };
  }
  if (m365AuthModule && graphModule) {
    const token = await m365AuthModule.getValidToken(userId);
    if (token) return { api: graphModule, token: token.token };
  }
  return null;
}

async function resolveCalendarProvider(userId) {
  if (gmailAuthModule && calendarGoogleModule) {
    const token = await gmailAuthModule.getValidToken(userId);
    if (token) return { api: calendarGoogleModule, token: token.token };
  }
  if (m365AuthModule && calendarGraphModule) {
    const token = await m365AuthModule.getValidToken(userId);
    if (token) return { api: calendarGraphModule, token: token.token };
  }
  return null;
}

async function executeTool(toolName, input, userId) {
  try {
    switch (toolName) {
      case "search_emails": {
        const ep = await resolveEmailProvider(userId);
        if (!ep) return { error: "No email account connected. Ask user to connect with 'jojo connect outlook'." };
        const query = input.query || "";
        const max = Math.min(input.max_results || 20, 50);
        // Broad search
        const results = await ep.api.getEmailsFromSender(ep.token, query, max);
        if (!results || results._error) return { error: `Email search failed: ${results?._error || "unknown error"}` };
        return results.map(e => ({
          id: e.id,
          from: `${e.from} <${e.fromEmail}>`,
          subject: e.subject,
          date: e.receivedAt,
          preview: (e.preview || "").substring(0, 150),
          unread: !e.isRead,
        }));
      }

      case "get_recent_emails": {
        const ep = await resolveEmailProvider(userId);
        if (!ep) return { error: "No email account connected." };
        const count = Math.min(input.count || 20, 50);
        const results = await ep.api.getRecentEmails(ep.token, count);
        if (!results || results._error) return { error: "Failed to fetch recent emails." };
        return results.map(e => ({
          id: e.id,
          from: `${e.from} <${e.fromEmail}>`,
          subject: e.subject,
          date: e.receivedAt,
          preview: (e.preview || "").substring(0, 150),
          unread: !e.isRead,
        }));
      }

      case "get_email_detail": {
        const ep = await resolveEmailProvider(userId);
        if (!ep) return { error: "No email account connected." };
        const email = await ep.api.getEmailById(ep.token, input.email_id);
        if (!email || email._error) return { error: "Failed to fetch email details." };
        return {
          id: email.id,
          from: `${email.from} <${email.fromEmail}>`,
          subject: email.subject,
          date: email.receivedAt,
          body: (email.body || email.preview || "").substring(0, 3000),
          hasAttachments: email.hasAttachments,
        };
      }

      case "send_email": {
        const ep = await resolveEmailProvider(userId);
        if (!ep) return { error: "No email account connected." };
        const sent = await ep.api.sendEmail(ep.token, {
          to: input.to,
          subject: input.subject,
          body: input.body,
        });
        return sent ? { success: true, message: `Email sent to ${input.to}` } : { error: "Failed to send email." };
      }

      case "get_calendar_events": {
        const cp = await resolveCalendarProvider(userId);
        if (!cp) return { error: "No calendar connected. Ask user to connect with 'jojo connect outlook'." };

        let events;
        switch (input.period) {
          case "today":
            events = await cp.api.getTodayEvents(cp.token);
            break;
          case "tomorrow":
            events = await cp.api.getTomorrowEvents(cp.token);
            break;
          case "week":
            events = await cp.api.getWeekEvents(cp.token);
            break;
          case "two_weeks": {
            const now = new Date();
            const start = new Date(now); start.setHours(0, 0, 0, 0);
            const end = new Date(now); end.setDate(end.getDate() + 14); end.setHours(23, 59, 59, 999);
            events = await cp.api.getEventsInRange(cp.token, start.toISOString(), end.toISOString());
            break;
          }
          default:
            events = await cp.api.getWeekEvents(cp.token);
        }

        if (!events || events._error) return { error: "Failed to fetch calendar events." };
        return events.map(e => ({
          id: e.id,
          subject: e.subject,
          start: e.start,
          end: e.end,
          organizer: e.organizer,
          location: e.location,
          attendees: (e.attendees || []).slice(0, 10).map(a => a.name || a.email),
        }));
      }

      case "get_event_detail": {
        const cp = await resolveCalendarProvider(userId);
        if (!cp) return { error: "No calendar connected." };
        const event = await cp.api.getEventById(cp.token, input.event_id);
        if (!event || event._error) return { error: "Failed to fetch event details." };
        return {
          id: event.id,
          subject: event.subject,
          start: event.start,
          end: event.end,
          organizer: event.organizer,
          location: event.location,
          body: (event.body || "").substring(0, 2000),
          attendees: (event.attendees || []).map(a => ({ name: a.name, email: a.email, status: a.status })),
          isOnlineMeeting: event.isOnlineMeeting,
          onlineMeetingUrl: event.onlineMeetingUrl,
        };
      }

      default:
        return { error: `Unknown tool: ${toolName}` };
    }
  } catch (e) {
    console.error(`${LOG} Tool ${toolName} error:`, e.message);
    return { error: e.message };
  }
}

// ── Agentic Loop ────────────────────────────────────────

async function run(userId, userMessage, conversationHistory = []) {
  if (!ANTHROPIC_API_KEY) return null;

  const tools = getTools();
  if (tools.length === 0) return null;

  const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  const messages = [
    ...conversationHistory.slice(-10).map(h => ({ role: h.role, content: h.content })),
    { role: "user", content: userMessage },
  ];

  const systemPrompt = `You are an executive AI assistant with access to the user's email and calendar. Today is ${today}.

When asked about emails or meetings, USE YOUR TOOLS to fetch real data. Do not guess or make up information.

Strategy for finding emails from a person:
- Search with their name first
- If you find emails, look at the full sender name (e.g. "CHEN Jack Lixin") and search again with the full name if needed
- Always verify your results match what the user asked

When composing replies: read the original email first using get_email_detail, understand the context, then draft a thoughtful response. NEVER send an email without explicit user confirmation.

Be concise and direct in your responses.`;

  let currentMessages = [...messages];

  for (let loop = 0; loop < MAX_LOOPS; loop++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": ANTHROPIC_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          system: systemPrompt,
          messages: currentMessages,
          tools,
          max_tokens: 2000,
        }),
        signal: controller.signal,
      });
      clearTimeout(timeout);

      if (!response.ok) {
        const errBody = await response.text().catch(() => "");
        console.error(`${LOG} Anthropic API ${response.status}: ${errBody.substring(0, 200)}`);
        return null;
      }

      const data = await response.json();

      // Check if AI wants to use tools
      const toolUseBlocks = (data.content || []).filter(b => b.type === "tool_use");
      const textBlocks = (data.content || []).filter(b => b.type === "text");

      if (toolUseBlocks.length === 0) {
        // No tool calls — AI is done, return the text response
        const finalText = textBlocks.map(b => b.text).join("\n");
        console.log(`${LOG} Done in ${loop + 1} loop(s), response: ${finalText.length} chars`);
        return finalText || null;
      }

      // Execute tools and continue the loop
      console.log(`${LOG} Loop ${loop + 1}: ${toolUseBlocks.length} tool call(s): ${toolUseBlocks.map(b => b.name).join(", ")}`);

      // Add assistant message with tool calls
      currentMessages.push({ role: "assistant", content: data.content });

      // Execute each tool and collect results
      const toolResults = [];
      for (const toolBlock of toolUseBlocks) {
        const result = await executeTool(toolBlock.name, toolBlock.input, userId);
        toolResults.push({
          type: "tool_result",
          tool_use_id: toolBlock.id,
          content: JSON.stringify(result).substring(0, 10000), // Limit result size
        });
      }

      // Add tool results
      currentMessages.push({ role: "user", content: toolResults });

    } catch (e) {
      clearTimeout(timeout);
      console.error(`${LOG} Loop ${loop + 1} error:`, e.message);
      return null;
    }
  }

  console.warn(`${LOG} Max loops (${MAX_LOOPS}) reached`);
  return null;
}

module.exports = {
  init,
  isAvailable,
  run,
};
