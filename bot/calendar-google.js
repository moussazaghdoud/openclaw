/**
 * Google Calendar API Connector — Calendar Operations
 *
 * All methods require a valid access token (from gmail-auth.js).
 * Uses Node 22 built-in fetch — no extra dependencies.
 *
 * Google Calendar API: https://www.googleapis.com/calendar/v3/...
 */

const LOG = "[Calendar-Google]";
const GCAL_BASE = "https://www.googleapis.com/calendar/v3";

// ── Read Operations ──────────────────────────────────────

/**
 * Get events for today.
 */
async function getTodayEvents(token, timeZone = "Europe/Paris") {
  const { start, end } = getDayRange(0);
  return fetchEvents(token, start, end, timeZone);
}

/**
 * Get events for tomorrow.
 */
async function getTomorrowEvents(token, timeZone = "Europe/Paris") {
  const { start, end } = getDayRange(1);
  return fetchEvents(token, start, end, timeZone);
}

/**
 * Get events for the current week (Mon-Sun).
 */
async function getWeekEvents(token, timeZone = "Europe/Paris") {
  const now = new Date();
  const dayOfWeek = now.getDay();
  const diffToMon = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  const monday = new Date(now);
  monday.setDate(now.getDate() + diffToMon);
  monday.setHours(0, 0, 0, 0);
  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);
  sunday.setHours(23, 59, 59, 999);
  return fetchEvents(token, monday.toISOString(), sunday.toISOString(), timeZone);
}

/**
 * Get events for a specific date range.
 */
async function getEventsInRange(token, startISO, endISO, timeZone = "Europe/Paris") {
  return fetchEvents(token, startISO, endISO, timeZone);
}

/**
 * Get a single event by ID (includes description/details).
 */
async function getEventById(token, eventId) {
  const resp = await gcalFetch(token, `/calendars/primary/events/${eventId}`);
  if (!resp || resp._error) return resp;
  return normalizeEvent(resp, true);
}

/**
 * Find free/busy slots for a given time range.
 */
async function findFreeSlots(token, startISO, endISO, durationMinutes = 30, timeZone = "Europe/Paris") {
  // Use freeBusy API
  const resp = await gcalFetch(token, "/freeBusy", {
    method: "POST",
    body: JSON.stringify({
      timeMin: startISO,
      timeMax: endISO,
      timeZone,
      items: [{ id: "primary" }],
    }),
  });

  if (!resp || resp._error || !resp.calendars?.primary) {
    // Fallback: compute from events
    return findFreeSlotsFromEvents(token, startISO, endISO, durationMinutes, timeZone);
  }

  const busyPeriods = (resp.calendars.primary.busy || []).map(b => ({
    start: new Date(b.start).getTime(),
    end: new Date(b.end).getTime(),
  })).sort((a, b) => a.start - b.start);

  return computeFreeSlots(busyPeriods, startISO, endISO, durationMinutes);
}

// ── Write Operations ─────────────────────────────────────

/**
 * Create a new calendar event.
 */
async function createEvent(token, { subject, start, end, location, body, attendees, isOnlineMeeting, timeZone }) {
  const tz = timeZone || "Europe/Paris";
  const event = {
    summary: subject,
    start: { dateTime: start, timeZone: tz },
    end: { dateTime: end, timeZone: tz },
  };
  if (location) event.location = location;
  if (body) event.description = body;
  if (attendees && attendees.length > 0) {
    event.attendees = attendees.map(a => ({
      email: typeof a === "string" ? a : a.email,
      displayName: typeof a === "string" ? undefined : a.name,
    }));
  }
  if (isOnlineMeeting) {
    event.conferenceData = {
      createRequest: { requestId: `meet-${Date.now()}`, conferenceSolutionKey: { type: "hangoutsMeet" } },
    };
  }

  const params = isOnlineMeeting ? "?conferenceDataVersion=1" : "";
  const resp = await gcalFetch(token, `/calendars/primary/events${params}`, {
    method: "POST",
    body: JSON.stringify(event),
  });
  if (!resp || resp._error) return resp;
  return normalizeEvent(resp, false);
}

/**
 * Update/reschedule an event.
 */
async function updateEvent(token, eventId, updates) {
  const patch = {};
  if (updates.subject) patch.summary = updates.subject;
  if (updates.start) patch.start = { dateTime: updates.start, timeZone: updates.timeZone || "Europe/Paris" };
  if (updates.end) patch.end = { dateTime: updates.end, timeZone: updates.timeZone || "Europe/Paris" };
  if (updates.location) patch.location = updates.location;
  if (updates.body) patch.description = updates.body;

  const resp = await gcalFetch(token, `/calendars/primary/events/${eventId}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  if (!resp || resp._error) return resp;
  return normalizeEvent(resp, false);
}

/**
 * Cancel/delete an event.
 */
async function cancelEvent(token, eventId, comment) {
  // Google Calendar doesn't support cancellation messages — just delete
  const resp = await gcalFetch(token, `/calendars/primary/events/${eventId}`, { method: "DELETE" });
  return resp !== null;
}

/**
 * Accept a meeting invitation (RSVP).
 */
async function acceptEvent(token, eventId, comment) {
  // Get current event, update own attendee status
  const event = await gcalFetch(token, `/calendars/primary/events/${eventId}`);
  if (!event || event._error) return false;

  // Find self in attendees and set responseStatus
  if (event.attendees) {
    for (const a of event.attendees) {
      if (a.self) {
        a.responseStatus = "accepted";
        break;
      }
    }
  }

  const resp = await gcalFetch(token, `/calendars/primary/events/${eventId}`, {
    method: "PATCH",
    body: JSON.stringify({ attendees: event.attendees }),
  });
  return resp !== null && !resp._error;
}

/**
 * Decline a meeting invitation (RSVP).
 */
async function declineEvent(token, eventId, comment) {
  const event = await gcalFetch(token, `/calendars/primary/events/${eventId}`);
  if (!event || event._error) return false;

  if (event.attendees) {
    for (const a of event.attendees) {
      if (a.self) {
        a.responseStatus = "declined";
        break;
      }
    }
  }

  const resp = await gcalFetch(token, `/calendars/primary/events/${eventId}`, {
    method: "PATCH",
    body: JSON.stringify({ attendees: event.attendees }),
  });
  return resp !== null && !resp._error;
}

// ── Internal Helpers ─────────────────────────────────────

async function gcalFetch(token, path, options = {}) {
  const url = path.startsWith("http") ? path : `${GCAL_BASE}${path}`;
  try {
    const resp = await fetch(url, {
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
      body: options.body,
      signal: AbortSignal.timeout(15000),
    });

    if (resp.status === 204 || resp.status === 202) return {};
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error(`${LOG} Calendar API ${resp.status} on ${path.substring(0, 80)}: ${errText.substring(0, 200)}`);
      if (resp.status === 429) {
        const retryAfter = resp.headers.get("Retry-After") || "60";
        return { _error: true, status: 429, retryAfter: parseInt(retryAfter, 10) };
      }
      return { _error: true, status: resp.status, message: errText.substring(0, 200) };
    }

    const text = await resp.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    console.error(`${LOG} Calendar API error on ${path.substring(0, 80)}:`, err.message);
    return null;
  }
}

async function fetchEvents(token, startISO, endISO, timeZone) {
  const params = new URLSearchParams({
    timeMin: startISO,
    timeMax: endISO,
    singleEvents: "true",
    orderBy: "startTime",
    maxResults: "50",
    timeZone,
  });
  const resp = await gcalFetch(token, `/calendars/primary/events?${params}`);
  if (!resp || resp._error) return resp;
  if (!resp.items) return [];
  return resp.items.filter(e => e.status !== "cancelled").map(e => normalizeEvent(e, false));
}

function normalizeEvent(e, includeBody) {
  const result = {
    id: e.id,
    subject: e.summary || "(no subject)",
    start: e.start?.dateTime || e.start?.date || "",
    end: e.end?.dateTime || e.end?.date || "",
    location: e.location || "",
    organizer: e.organizer?.displayName || e.organizer?.email || "",
    organizerEmail: e.organizer?.email || "",
    isOnlineMeeting: !!(e.hangoutLink || e.conferenceData),
    onlineMeetingUrl: e.hangoutLink || e.conferenceData?.entryPoints?.[0]?.uri || "",
    importance: "normal",
    showAs: e.transparency === "transparent" ? "free" : "busy",
  };

  if (e.attendees && e.attendees.length > 0) {
    result.attendees = e.attendees.map(a => ({
      name: a.displayName || a.email || "",
      email: a.email || "",
      status: a.responseStatus || "needsAction",
    }));
  }

  if (includeBody) {
    result.body = (e.description || "").substring(0, 5000);
  }

  return result;
}

function getDayRange(offsetDays) {
  const now = new Date();
  const target = new Date(now);
  target.setDate(now.getDate() + offsetDays);
  target.setHours(0, 0, 0, 0);
  const end = new Date(target);
  end.setHours(23, 59, 59, 999);
  return { start: target.toISOString(), end: end.toISOString() };
}

async function findFreeSlotsFromEvents(token, startISO, endISO, durationMinutes, timeZone) {
  const events = await fetchEvents(token, startISO, endISO, timeZone);
  if (!events || events._error) return [];

  const busyPeriods = events.map(e => ({
    start: new Date(e.start).getTime(),
    end: new Date(e.end).getTime(),
  })).sort((a, b) => a.start - b.start);

  return computeFreeSlots(busyPeriods, startISO, endISO, durationMinutes);
}

function computeFreeSlots(busyPeriods, startISO, endISO, durationMinutes) {
  const slots = [];
  const rangeStart = new Date(startISO).getTime();
  const rangeEnd = new Date(endISO).getTime();
  const durationMs = durationMinutes * 60 * 1000;

  let cursor = rangeStart;
  for (const busy of busyPeriods) {
    while (cursor + durationMs <= busy.start && slots.length < 20) {
      const s = new Date(cursor);
      const hour = s.getHours();
      if (hour >= 8 && hour < 18) {
        slots.push({
          start: s.toISOString(),
          end: new Date(cursor + durationMs).toISOString(),
          duration: durationMinutes,
        });
      }
      cursor += durationMs;
    }
    cursor = Math.max(cursor, busy.end);
  }
  while (cursor + durationMs <= rangeEnd && slots.length < 20) {
    const s = new Date(cursor);
    const hour = s.getHours();
    if (hour >= 8 && hour < 18) {
      slots.push({
        start: s.toISOString(),
        end: new Date(cursor + durationMs).toISOString(),
        duration: durationMinutes,
      });
    }
    cursor += durationMs;
  }
  return slots;
}

module.exports = {
  // Read
  getTodayEvents,
  getTomorrowEvents,
  getWeekEvents,
  getEventsInRange,
  getEventById,
  findFreeSlots,
  // Write
  createEvent,
  updateEvent,
  cancelEvent,
  acceptEvent,
  declineEvent,
};
