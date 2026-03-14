/**
 * Calendar Intent Handler — Dual Backend (Outlook + Google)
 *
 * Detects calendar-related intents from user messages and dispatches
 * to the appropriate API (Microsoft Graph or Google Calendar).
 *
 * Mirrors email-intents.js architecture for consistency.
 */

const LOG = "[Calendar-Intents]";

let m365CalendarModule = null;
let m365AuthModule = null;
let googleCalendarModule = null;
let gmailAuthModule = null;
let callOpenClawFn = null;
let redisClient = null;

// ── Init ─────────────────────────────────────────────────

function init({ m365CalendarMod, m365AuthMod, googleCalendarMod, gmailAuthMod, callOpenClaw, redis }) {
  m365CalendarModule = m365CalendarMod;
  m365AuthModule = m365AuthMod;
  googleCalendarModule = googleCalendarMod;
  gmailAuthModule = gmailAuthMod;
  callOpenClawFn = callOpenClaw;
  redisClient = redis;
  console.log(`${LOG} Initialized (Outlook: ${!!m365CalendarMod}, Google: ${!!googleCalendarMod})`);
}

// ── Provider Resolution ─────────────────────────────────

/**
 * Resolve which calendar provider to use for a user.
 * Checks Google first (already linked via Gmail), then M365.
 */
async function resolveProvider(userId) {
  // Try Google Calendar (uses same token as Gmail)
  if (googleCalendarModule && gmailAuthModule) {
    const gResult = await gmailAuthModule.getValidToken(userId);
    if (gResult) {
      return {
        provider: "google",
        token: gResult.token,
        email: gResult.email,
        api: googleCalendarModule,
      };
    }
  }

  // Try Outlook Calendar (uses same token as M365 email)
  if (m365CalendarModule && m365AuthModule) {
    const mResult = await m365AuthModule.getValidToken(userId);
    if (mResult) {
      return {
        provider: "outlook",
        token: mResult.token,
        email: mResult.email,
        api: m365CalendarModule,
      };
    }
  }

  return null;
}

// ── Intent Detection ────────────────────────────────────

function detectCalendarIntent(message) {
  const msg = message.toLowerCase().trim();

  // Today's meetings/schedule
  if (/\b(today'?s?\s+(meeting|calendar|schedule|agenda|event)|meeting.*today|what('?s| is| do i have)\s+(on\s+)?my\s+(calendar|schedule|agenda)\s*(today)?|what\s+(meeting|event)s?\s+do\s+i\s+have\s+today|my\s+(meeting|event)s?\s+today)\b/i.test(msg)) {
    return { type: "calendar_today" };
  }

  // Tomorrow's meetings/schedule
  if (/\b(tomorrow'?s?\s+(meeting|calendar|schedule|agenda|event)|meeting.*tomorrow|what('?s| is| do i have)\s+(on\s+)?my\s+(calendar|schedule|agenda)\s+tomorrow|what\s+(meeting|event)s?\s+do\s+i\s+have\s+tomorrow|my\s+(meeting|event)s?\s+tomorrow)\b/i.test(msg)) {
    return { type: "calendar_tomorrow" };
  }

  // This week's meetings/schedule
  if (/\b(this\s+week'?s?\s+(meeting|calendar|schedule|agenda|event)|meeting.*this\s+week|my\s+week(ly)?\s+(schedule|calendar|agenda)|schedule\s+for\s+(the\s+)?week|what.*week.*schedule)\b/i.test(msg)) {
    return { type: "calendar_week" };
  }

  // Find free slots / availability
  if (/\b(free\s+slot|available\s+slot|find\s+(a\s+)?time|when\s+am\s+i\s+(free|available)|availability|open\s+slot|free\s+time|slot\s+for|schedule\s+a\s+time)\b/i.test(msg)) {
    // Extract duration if mentioned
    const durationMatch = msg.match(/(\d+)\s*(min|minute|hour|hr)/i);
    let duration = 30;
    if (durationMatch) {
      const val = parseInt(durationMatch[1], 10);
      const unit = durationMatch[2].toLowerCase();
      duration = unit.startsWith("h") ? val * 60 : val;
    }
    // Extract day reference
    let day = "today";
    if (/tomorrow/i.test(msg)) day = "tomorrow";
    else if (/this\s+week/i.test(msg)) day = "week";
    return { type: "calendar_free_slots", duration, day };
  }

  // Create meeting
  if (/\b(create|schedule|set\s+up|book|add|plan)\s+(a\s+)?(meeting|event|appointment|call|sync|catch-?up)\b/i.test(msg)) {
    return { type: "calendar_create", instructions: message };
  }

  // Reschedule/move meeting
  if (/\b(reschedule|move|postpone|push\s+back|change\s+the\s+time|change\s+the\s+date)\s+(the\s+)?(meeting|event|appointment|call)\b/i.test(msg)) {
    return { type: "calendar_reschedule", instructions: message };
  }

  // Cancel meeting
  if (/\b(cancel|delete|remove)\s+(the\s+)?(meeting|event|appointment|call)\b/i.test(msg)) {
    return { type: "calendar_cancel", instructions: message };
  }

  // Accept meeting
  if (/\b(accept|confirm)\s+(the\s+)?(meeting|event|invitation|invite)\b/i.test(msg)) {
    return { type: "calendar_accept", instructions: message };
  }

  // Decline meeting
  if (/\b(decline|reject|refuse)\s+(the\s+)?(meeting|event|invitation|invite)\b/i.test(msg)) {
    return { type: "calendar_decline", instructions: message };
  }

  // Meeting details / preparation briefing
  if (/\b(meeting\s+detail|detail.*meeting|prepare\s+(for|me)|brief(ing)?\s+(for|on|about)\s+(the\s+)?meeting|what('?s| is)\s+(the\s+)?next\s+meeting|next\s+meeting|upcoming\s+meeting)\b/i.test(msg)) {
    return { type: "calendar_details", instructions: message };
  }

  // Follow-up calendar questions (e.g. after viewing a meeting)
  // Patterns: "and after this one?", "what's next?", "and the next one?",
  //           "next meeting?", "what about after?", "and then?", "what comes after?"
  if (/^(and\s+)?(after\s+(this|that)\s+one|the\s+next\s+one|what('?s|\s+is)\s+next|next\s+(one|meeting)|what\s+(about\s+)?after|and\s+then|what\s+comes\s+(next|after))\s*\??$/i.test(msg)) {
    return { type: "calendar_next", instructions: message };
  }

  // Smart catch-all: any message with calendar/meeting/schedule keywords
  if (/\b(calendar|meeting|schedule|agenda|appointment|event)\b/i.test(msg)) {
    return { type: "calendar_smart_query", query: message };
  }

  return null;
}

// ── Intent Handlers ─────────────────────────────────────

async function handleCalendarIntent(userId, intent, originalMessage) {
  const resolved = await resolveProvider(userId);
  if (!resolved) {
    return "You haven't connected a calendar yet. Use **jojo connect outlook** or **jojo connect gmail** to link your account.";
  }

  const { provider, token, email, api } = resolved;
  const providerLabel = provider === "google" ? "Google Calendar" : "Outlook Calendar";

  try {
    // Reset the "next meeting" index for fresh calendar queries
    if (intent.type !== "calendar_next" && redisClient) {
      await redisClient.del(`cal_next_idx:${userId}`).catch(() => {});
    }

    switch (intent.type) {
      case "calendar_today":
        return await handleTodayEvents(api, token, providerLabel);
      case "calendar_tomorrow":
        return await handleTomorrowEvents(api, token, providerLabel);
      case "calendar_week":
        return await handleWeekEvents(api, token, providerLabel);
      case "calendar_free_slots":
        return await handleFreeSlots(api, token, intent, providerLabel);
      case "calendar_create":
        return await handleCreateEvent(api, token, userId, intent, providerLabel);
      case "calendar_reschedule":
        return await handleRescheduleEvent(api, token, userId, intent, providerLabel);
      case "calendar_cancel":
        return await handleCancelEvent(api, token, userId, intent, providerLabel);
      case "calendar_accept":
        return await handleAcceptEvent(api, token, userId, intent, providerLabel);
      case "calendar_decline":
        return await handleDeclineEvent(api, token, userId, intent, providerLabel);
      case "calendar_next":
        return await handleNextMeeting(api, token, userId, intent, providerLabel);
      case "calendar_details":
        return await handleMeetingDetails(api, token, userId, intent, providerLabel);
      case "calendar_smart_query":
        return await handleSmartQuery(api, token, userId, intent, providerLabel);
      case "calendar_confirm_create":
        return await handleConfirmCreate(api, token, userId, providerLabel);
      case "calendar_confirm_cancel":
        return await handleConfirmCancel(api, token, userId, providerLabel);
      default:
        return "I didn't understand that calendar request. Try asking about today's meetings, free slots, or scheduling a meeting.";
    }
  } catch (err) {
    console.error(`${LOG} Error handling ${intent.type}:`, err.message);
    return `Sorry, there was an error accessing your calendar: ${err.message}`;
  }
}

// ── Today / Tomorrow / Week ─────────────────────────────

async function handleTodayEvents(api, token, providerLabel) {
  const events = await api.getTodayEvents(token);
  if (!events || events._error) return calendarErrorMessage(events, providerLabel);
  if (events.length === 0) return `No meetings scheduled for today (${providerLabel}).`;
  return formatEventList(events, "Today's Schedule", providerLabel);
}

async function handleTomorrowEvents(api, token, providerLabel) {
  const events = await api.getTomorrowEvents(token);
  if (!events || events._error) return calendarErrorMessage(events, providerLabel);
  if (events.length === 0) return `No meetings scheduled for tomorrow (${providerLabel}).`;
  return formatEventList(events, "Tomorrow's Schedule", providerLabel);
}

async function handleWeekEvents(api, token, providerLabel) {
  const events = await api.getWeekEvents(token);
  if (!events || events._error) return calendarErrorMessage(events, providerLabel);
  if (events.length === 0) return `No meetings scheduled for this week (${providerLabel}).`;
  return formatEventList(events, "This Week's Schedule", providerLabel);
}

function calendarErrorMessage(events, providerLabel) {
  if (!events) return "Sorry, I couldn't access your calendar right now.";
  const status = events.status || "unknown";
  if (status === 403 || status === 401) {
    return `Calendar access denied. Your account may not have calendar permissions.\n\nPlease re-link: **jojo disconnect ${providerLabel === "Google Calendar" ? "gmail" : "outlook"}** then **jojo connect ${providerLabel === "Google Calendar" ? "gmail" : "outlook"}** to grant calendar access.`;
  }
  return `Sorry, I couldn't access your calendar (error ${status}).`;
}

// ── Free Slots ──────────────────────────────────────────

async function handleFreeSlots(api, token, intent, providerLabel) {
  const duration = intent.duration || 30;
  let startISO, endISO;

  if (intent.day === "tomorrow") {
    const tmrw = new Date();
    tmrw.setDate(tmrw.getDate() + 1);
    tmrw.setHours(8, 0, 0, 0);
    const tmrwEnd = new Date(tmrw);
    tmrwEnd.setHours(18, 0, 0, 0);
    startISO = tmrw.toISOString();
    endISO = tmrwEnd.toISOString();
  } else if (intent.day === "week") {
    const now = new Date();
    const dayOfWeek = now.getDay();
    const diffToMon = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
    const monday = new Date(now);
    monday.setDate(now.getDate() + diffToMon);
    monday.setHours(8, 0, 0, 0);
    const friday = new Date(monday);
    friday.setDate(monday.getDate() + 4);
    friday.setHours(18, 0, 0, 0);
    startISO = monday.toISOString();
    endISO = friday.toISOString();
  } else {
    // Today
    const now = new Date();
    const hour = now.getHours();
    if (hour >= 18) {
      return "It's past business hours. Would you like me to check tomorrow's availability?";
    }
    now.setMinutes(Math.ceil(now.getMinutes() / 15) * 15, 0, 0); // Round to next 15 min
    const todayEnd = new Date(now);
    todayEnd.setHours(18, 0, 0, 0);
    startISO = now.toISOString();
    endISO = todayEnd.toISOString();
  }

  const slots = await api.findFreeSlots(token, startISO, endISO, duration);
  if (!slots || slots.length === 0) {
    return `No free ${duration}-minute slots available for ${intent.day} (${providerLabel}).`;
  }

  const display = slots.slice(0, 10).map((s, i) => {
    const start = formatTime(s.start);
    const end = formatTime(s.end);
    return `${i + 1}. ${start} — ${end}`;
  }).join("\n");

  return `**Free ${duration}-min Slots** (${providerLabel}):\n\n${display}${slots.length > 10 ? `\n\n...and ${slots.length - 10} more` : ""}`;
}

// ── Create Event ────────────────────────────────────────

async function handleCreateEvent(api, token, userId, intent, providerLabel) {
  // Use AI to parse the meeting details from the instruction
  const events = await api.getTodayEvents(token);
  const todayContext = events && !events._error ? `User's existing meetings today: ${JSON.stringify(events.slice(0, 5))}` : "";

  const aiPrompt = `The user wants to create a calendar meeting. Parse their request and output ONLY a JSON object with these fields (no other text):
{
  "subject": "meeting title",
  "date": "YYYY-MM-DD",
  "startTime": "HH:MM",
  "endTime": "HH:MM",
  "location": "location or empty string",
  "attendees": ["email1@example.com"],
  "body": "meeting description or empty string",
  "isOnlineMeeting": true/false
}

Today's date is ${new Date().toISOString().split("T")[0]}.
${todayContext}

User request: "${intent.instructions}"

If any field can't be determined, use reasonable defaults (30 min duration, no attendees, etc). Output ONLY the JSON.`;

  const aiResponse = await callOpenClawFn(aiPrompt, []);
  if (!aiResponse) return "Sorry, I couldn't parse the meeting details. Please try again with more specifics.";

  let meetingData;
  try {
    const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
    meetingData = JSON.parse(jsonMatch[0]);
  } catch (e) {
    return "Sorry, I couldn't parse the meeting details. Please try something like: 'Schedule a meeting with john@example.com tomorrow at 2pm for 30 minutes about project review'.";
  }

  // Build ISO datetime
  const startISO = `${meetingData.date}T${meetingData.startTime}:00`;
  const endISO = `${meetingData.date}T${meetingData.endTime}:00`;

  // Store pending creation for confirmation
  if (redisClient) {
    await redisClient.set(`cal_pending:${userId}`, JSON.stringify({
      action: "create",
      subject: meetingData.subject,
      start: startISO,
      end: endISO,
      location: meetingData.location,
      body: meetingData.body,
      attendees: meetingData.attendees,
      isOnlineMeeting: meetingData.isOnlineMeeting,
      provider: providerLabel,
    }), { EX: 300 }); // 5 min TTL
  }

  const attendeeStr = meetingData.attendees && meetingData.attendees.length > 0
    ? `\nAttendees: ${meetingData.attendees.join(", ")}`
    : "";
  const locationStr = meetingData.location ? `\nLocation: ${meetingData.location}` : "";
  const onlineStr = meetingData.isOnlineMeeting ? "\nOnline meeting: Yes" : "";

  return `**Meeting Draft** (${providerLabel}):\n\nSubject: ${meetingData.subject}\nDate: ${meetingData.date}\nTime: ${meetingData.startTime} — ${meetingData.endTime}${locationStr}${attendeeStr}${onlineStr}\n\nShall I create this meeting? Reply **yes** to confirm or **no** to cancel.`;
}

// ── Confirm Create ──────────────────────────────────────

async function handleConfirmCreate(api, token, userId, providerLabel) {
  if (!redisClient) return "No pending meeting to confirm.";

  const raw = await redisClient.get(`cal_pending:${userId}`);
  if (!raw) return "No pending meeting to confirm. The request may have expired.";

  const pending = JSON.parse(raw);
  if (pending.action !== "create") return "No pending meeting creation.";

  const result = await api.createEvent(token, {
    subject: pending.subject,
    start: pending.start,
    end: pending.end,
    location: pending.location,
    body: pending.body,
    attendees: pending.attendees,
    isOnlineMeeting: pending.isOnlineMeeting,
  });

  await redisClient.del(`cal_pending:${userId}`);

  if (!result || result._error) {
    return "Sorry, failed to create the meeting. Please try again.";
  }

  return `Meeting **"${pending.subject}"** has been created on your ${providerLabel}.`;
}

// ── Cancel Event ────────────────────────────────────────

async function handleCancelEvent(api, token, userId, intent, providerLabel) {
  // Find the meeting to cancel
  const events = await api.getTodayEvents(token);
  if (!events || events._error || events.length === 0) {
    return "I couldn't find any meetings to cancel.";
  }

  // Use AI to identify which meeting
  const aiPrompt = `The user wants to cancel a meeting. Given their request and the list of meetings, identify which meeting they mean.
Output ONLY a JSON: { "index": <0-based index>, "reason": "brief reason" }

Meetings:
${events.map((e, i) => `${i}. "${e.subject}" at ${formatTime(e.start)} with ${e.organizer}`).join("\n")}

User request: "${intent.instructions}"

If unclear, pick the best match. Output ONLY JSON.`;

  const aiResponse = await callOpenClawFn(aiPrompt, []);
  let match;
  try {
    const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
    match = JSON.parse(jsonMatch[0]);
  } catch (e) {
    return "I couldn't determine which meeting to cancel. Please be more specific.";
  }

  const event = events[match.index];
  if (!event) return "I couldn't find that meeting.";

  // Store pending cancellation for confirmation
  if (redisClient) {
    await redisClient.set(`cal_pending:${userId}`, JSON.stringify({
      action: "cancel",
      eventId: event.id,
      subject: event.subject,
      provider: providerLabel,
    }), { EX: 300 });
  }

  return `Are you sure you want to cancel **"${event.subject}"** (${formatTime(event.start)})? Reply **yes** to confirm.`;
}

async function handleConfirmCancel(api, token, userId, providerLabel) {
  if (!redisClient) return "No pending cancellation.";

  const raw = await redisClient.get(`cal_pending:${userId}`);
  if (!raw) return "No pending cancellation. The request may have expired.";

  const pending = JSON.parse(raw);
  if (pending.action !== "cancel") return "No pending cancellation.";

  const result = await api.cancelEvent(token, pending.eventId, "Cancelled via AI assistant");
  await redisClient.del(`cal_pending:${userId}`);

  if (!result) return "Sorry, failed to cancel the meeting.";
  return `Meeting **"${pending.subject}"** has been cancelled.`;
}

// ── Reschedule Event ────────────────────────────────────

async function handleRescheduleEvent(api, token, userId, intent, providerLabel) {
  const events = await api.getTodayEvents(token);
  const weekEvents = await api.getWeekEvents(token);
  const allEvents = [...(events || []), ...(weekEvents || [])];
  const uniqueEvents = allEvents.filter((e, i, arr) => arr.findIndex(x => x.id === e.id) === i);

  if (uniqueEvents.length === 0) return "I couldn't find any meetings to reschedule.";

  const aiPrompt = `The user wants to reschedule a meeting. Identify which meeting and the new time.
Output ONLY JSON: { "index": <0-based index>, "newDate": "YYYY-MM-DD", "newStartTime": "HH:MM", "newEndTime": "HH:MM" }

Today: ${new Date().toISOString().split("T")[0]}
Meetings:
${uniqueEvents.map((e, i) => `${i}. "${e.subject}" at ${e.start}`).join("\n")}

User request: "${intent.instructions}"

Output ONLY JSON.`;

  const aiResponse = await callOpenClawFn(aiPrompt, []);
  let match;
  try {
    const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
    match = JSON.parse(jsonMatch[0]);
  } catch (e) {
    return "I couldn't parse the reschedule request. Please specify which meeting and the new time.";
  }

  const event = uniqueEvents[match.index];
  if (!event) return "I couldn't find that meeting.";

  const newStart = `${match.newDate}T${match.newStartTime}:00`;
  const newEnd = `${match.newDate}T${match.newEndTime}:00`;

  const result = await api.updateEvent(token, event.id, { start: newStart, end: newEnd });
  if (!result || result._error) return "Sorry, failed to reschedule the meeting.";

  return `Meeting **"${event.subject}"** rescheduled to ${match.newDate} at ${match.newStartTime} — ${match.newEndTime} (${providerLabel}).`;
}

// ── Accept / Decline ────────────────────────────────────

async function handleAcceptEvent(api, token, userId, intent, providerLabel) {
  return await handleRSVP(api, token, userId, intent, providerLabel, "accept");
}

async function handleDeclineEvent(api, token, userId, intent, providerLabel) {
  return await handleRSVP(api, token, userId, intent, providerLabel, "decline");
}

async function handleRSVP(api, token, userId, intent, providerLabel, action) {
  const events = await api.getTodayEvents(token);
  const weekEvents = await api.getWeekEvents(token);
  const allEvents = [...(events || []), ...(weekEvents || [])];
  const uniqueEvents = allEvents.filter((e, i, arr) => arr.findIndex(x => x.id === e.id) === i);

  if (uniqueEvents.length === 0) return `No meetings found to ${action}.`;

  const aiPrompt = `The user wants to ${action} a meeting. Identify which one.
Output ONLY JSON: { "index": <0-based index> }

Meetings:
${uniqueEvents.map((e, i) => `${i}. "${e.subject}" at ${e.start}`).join("\n")}

User request: "${intent.instructions}"

Output ONLY JSON.`;

  const aiResponse = await callOpenClawFn(aiPrompt, []);
  let match;
  try {
    const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
    match = JSON.parse(jsonMatch[0]);
  } catch (e) {
    return `I couldn't determine which meeting to ${action}. Please be more specific.`;
  }

  const event = uniqueEvents[match.index];
  if (!event) return `I couldn't find that meeting.`;

  const fn = action === "accept" ? api.acceptEvent : api.declineEvent;
  const result = await fn(token, event.id, `${action === "accept" ? "Accepted" : "Declined"} via AI assistant`);

  if (!result) return `Sorry, failed to ${action} the meeting.`;
  return `Meeting **"${event.subject}"** has been **${action}ed** (${providerLabel}).`;
}

// ── Next Meeting (follow-up) ────────────────────────────

async function handleNextMeeting(api, token, userId, intent, providerLabel) {
  // Get today's events sorted by time
  const events = await api.getTodayEvents(token);
  const allEvents = [];
  if (events && !events._error) allEvents.push(...events);

  // Also get tomorrow's events as continuation
  const tomorrowEvents = await api.getTomorrowEvents(token);
  if (tomorrowEvents && !tomorrowEvents._error) allEvents.push(...tomorrowEvents);

  if (allEvents.length === 0) {
    return `No meetings coming up (${providerLabel}).`;
  }

  // Track which event index was last shown for this user
  const redisKey = `cal_next_idx:${userId}`;
  let lastIdx = -1;
  if (redisClient) {
    const stored = await redisClient.get(redisKey).catch(() => null);
    if (stored !== null) lastIdx = parseInt(stored, 10);
  }

  const nextIdx = lastIdx + 1;

  if (nextIdx >= allEvents.length) {
    // Reset index for next time
    if (redisClient) await redisClient.del(redisKey).catch(() => {});
    return `No more meetings after that (${providerLabel}).`;
  }

  // Store the index for the next "and after?" follow-up
  if (redisClient) {
    await redisClient.set(redisKey, String(nextIdx), { EX: 1800 }).catch(() => {}); // 30min TTL
  }

  const isTomorrow = events && !events._error && nextIdx >= events.length;
  const label = isTomorrow ? "Next Meeting (tomorrow)" : "Next Meeting";
  return formatSingleEvent(allEvents[nextIdx], label, providerLabel);
}

function formatSingleEvent(event, title, providerLabel) {
  let output = `**${title}** (${providerLabel}):\n\n`;
  output += `**${event.subject}**\n`;
  output += `Time: ${formatTime(event.start)} — ${formatTime(event.end)}\n`;
  if (event.location) output += `Location: ${event.location}\n`;
  if (event.isOnlineMeeting) output += `Online meeting\n`;
  if (event.organizer) output += `Organizer: ${event.organizer}\n`;
  if (event.attendees && event.attendees.length > 0 && event.attendees.length <= 5) {
    output += `With: ${event.attendees.map(a => a.name || a.email).join(", ")}\n`;
  }
  return output;
}

// ── Meeting Details ─────────────────────────────────────

async function handleMeetingDetails(api, token, userId, intent, providerLabel) {
  // Get upcoming events — check today first, then tomorrow
  let events = await api.getTodayEvents(token);
  if (events && events._error) {
    const status = events.status || "unknown";
    if (status === 403 || status === 401) {
      return `Calendar access denied (${status}). You may need to re-link your account: **jojo disconnect gmail** then **jojo connect gmail** to grant calendar permissions.`;
    }
    return `Sorry, I couldn't access your calendar (error ${status}). Please try again.`;
  }
  let label = "today";
  if (!events || events.length === 0) {
    // Try tomorrow
    events = await api.getTomorrowEvents(token);
    if (events && events._error) return `Sorry, I couldn't access your calendar right now.`;
    label = "tomorrow";
  }
  if (!events || events.length === 0) {
    return `No meetings found for today or tomorrow (${providerLabel}).`;
  }

  // Find next upcoming meeting (or let AI pick based on instructions)
  let targetEvent;
  if (intent.instructions && !/next\s+meeting/i.test(intent.instructions)) {
    const aiPrompt = `Which meeting is the user asking about?
Output ONLY JSON: { "index": <0-based index> }

Meetings:
${events.map((e, i) => `${i}. "${e.subject}" at ${formatTime(e.start)} with ${e.organizer}`).join("\n")}

User: "${intent.instructions}"
Output ONLY JSON.`;

    const aiResponse = await callOpenClawFn(aiPrompt, []);
    try {
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      const match = JSON.parse(jsonMatch[0]);
      targetEvent = events[match.index];
    } catch (e) {
      targetEvent = events[0]; // fallback to first
    }
  } else {
    // Find next meeting (soonest that hasn't ended)
    const now = new Date();
    targetEvent = events.find(e => new Date(e.end) > now) || events[0];
  }

  if (!targetEvent) return "No upcoming meeting found.";

  // Store the index of the shown event so "next" follow-ups work
  const shownIdx = events.indexOf(targetEvent);
  if (redisClient && shownIdx >= 0) {
    await redisClient.set(`cal_next_idx:${userId}`, String(shownIdx), { EX: 1800 }).catch(() => {});
  }

  // Get full details
  const detail = await api.getEventById(token, targetEvent.id);
  if (!detail || detail._error) return "Sorry, couldn't load meeting details.";

  let output = `**Meeting: ${detail.subject}**\n\n`;
  output += `Time: ${formatTime(detail.start)} — ${formatTime(detail.end)}\n`;
  if (detail.location) output += `Location: ${detail.location}\n`;
  if (detail.isOnlineMeeting && detail.onlineMeetingUrl) output += `Online: ${detail.onlineMeetingUrl}\n`;
  output += `Organizer: ${detail.organizer}\n`;

  if (detail.attendees && detail.attendees.length > 0) {
    output += `\nAttendees:\n`;
    for (const a of detail.attendees) {
      const status = a.status === "accepted" ? "Accepted" : a.status === "declined" ? "Declined" : a.status === "tentative" ? "Tentative" : "Pending";
      output += `  - ${a.name || a.email} (${status})\n`;
    }
  }

  if (detail.body) {
    output += `\nDescription:\n${detail.body.substring(0, 2000)}\n`;
  }

  output += `\n_(${providerLabel})_`;
  return output;
}

// ── Smart Query ─────────────────────────────────────────

async function handleSmartQuery(api, token, userId, intent, providerLabel) {
  // Get today's and tomorrow's events for context
  const todayEvents = await api.getTodayEvents(token);
  const tomorrowEvents = await api.getTomorrowEvents(token);

  const calendarData = {
    today: todayEvents && !todayEvents._error ? todayEvents : [],
    tomorrow: tomorrowEvents && !tomorrowEvents._error ? tomorrowEvents : [],
  };

  const aiPrompt = `You are an executive AI assistant. The user asked a calendar-related question. Answer it using the calendar data below.

Calendar data (${providerLabel}):
Today's meetings: ${JSON.stringify(calendarData.today)}
Tomorrow's meetings: ${JSON.stringify(calendarData.tomorrow)}

User question: "${intent.query}"

Provide a concise, helpful answer. Format meeting times clearly.`;

  const response = await callOpenClawFn(aiPrompt, []);
  return response || "Sorry, I couldn't process that calendar request.";
}

// ── Pending Action Check ────────────────────────────────

/**
 * Check if the user has a pending calendar action (create/cancel) and
 * the message is a confirmation (yes/no).
 */
async function checkPendingAction(userId, message) {
  if (!redisClient) return null;

  const msg = message.toLowerCase().trim();
  const isYes = /^(yes|y|ok|confirm|go\s+ahead|do\s+it|sure|absolutely|yep|oui)$/i.test(msg);
  const isNo = /^(no|n|cancel|nope|non|forget\s+it|never\s+mind)$/i.test(msg);

  if (!isYes && !isNo) return null;

  const raw = await redisClient.get(`cal_pending:${userId}`);
  if (!raw) return null;

  if (isNo) {
    await redisClient.del(`cal_pending:${userId}`);
    return "Calendar action cancelled.";
  }

  const pending = JSON.parse(raw);
  if (pending.action === "create") {
    return { type: "calendar_confirm_create" };
  } else if (pending.action === "cancel") {
    return { type: "calendar_confirm_cancel" };
  }

  return null;
}

// ── Formatting Helpers ──────────────────────────────────

function formatEventList(events, title, providerLabel) {
  let output = `**${title}** (${providerLabel}):\n\n`;
  for (const e of events) {
    const time = `${formatTime(e.start)} — ${formatTime(e.end)}`;
    const loc = e.location ? ` | ${e.location}` : "";
    const online = e.isOnlineMeeting ? " [Online]" : "";
    output += `- **${time}** ${e.subject}${loc}${online}\n`;
    if (e.attendees && e.attendees.length > 0 && e.attendees.length <= 5) {
      output += `  _with ${e.attendees.map(a => a.name || a.email).join(", ")}_\n`;
    }
  }
  return output;
}

function formatTime(isoString) {
  if (!isoString) return "??:??";
  const d = new Date(isoString);
  if (isNaN(d.getTime())) {
    // Might be a date-only string
    return isoString;
  }
  return d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", hour12: false });
}

module.exports = {
  init,
  detectCalendarIntent,
  handleCalendarIntent,
  resolveProvider,
  checkPendingAction,
};
