/**
 * Microsoft Graph API Connector — Outlook Calendar Operations
 *
 * All methods require a valid access token (from auth.js).
 * Uses Node 22 built-in fetch — no extra dependencies.
 */

const LOG = "[Calendar-Graph]";
const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

// Map Graph API timezone IDs to UTC offsets for correct date parsing.
// Graph returns dateTime WITHOUT offset — we must append it so new Date() works.
function getTimezoneOffset(tzId) {
  const now = new Date();
  const month = now.getUTCMonth();
  // Approximate DST: last Sunday of March to last Sunday of October (EU rules)
  const isDST = month > 2 && month < 9 ||
    (month === 2 && now.getUTCDate() >= 31 - new Date(now.getUTCFullYear(), 2, 31).getUTCDay()) ||
    (month === 9 && now.getUTCDate() < 31 - new Date(now.getUTCFullYear(), 9, 31).getUTCDay());

  const offsets = {
    "Romance Standard Time": isDST ? "+02:00" : "+01:00",  // Paris, Brussels, Madrid
    "W. Europe Standard Time": isDST ? "+02:00" : "+01:00", // Berlin, Amsterdam, Rome
    "Central European Standard Time": isDST ? "+02:00" : "+01:00",
    "GMT Standard Time": isDST ? "+01:00" : "+00:00",       // London
    "Eastern Standard Time": isDST ? "-04:00" : "-05:00",   // New York
    "Central Standard Time": isDST ? "-05:00" : "-06:00",   // Chicago
    "Mountain Standard Time": isDST ? "-06:00" : "-07:00",  // Denver
    "Pacific Standard Time": isDST ? "-07:00" : "-08:00",   // LA
    "Tokyo Standard Time": "+09:00",
    "China Standard Time": "+08:00",
    "Singapore Standard Time": "+08:00",
    "Arabian Standard Time": "+04:00",                       // Dubai
    "AUS Eastern Standard Time": isDST ? "+11:00" : "+10:00",
    "UTC": "+00:00",
    // Europe/Paris style (used in Prefer header)
    "Europe/Paris": isDST ? "+02:00" : "+01:00",
    "Europe/London": isDST ? "+01:00" : "+00:00",
    "Europe/Berlin": isDST ? "+02:00" : "+01:00",
    "America/New_York": isDST ? "-04:00" : "-05:00",
    "America/Chicago": isDST ? "-05:00" : "-06:00",
    "America/Los_Angeles": isDST ? "-07:00" : "-08:00",
    "Asia/Tokyo": "+09:00",
  };
  return offsets[tzId] || (isDST ? "+02:00" : "+01:00"); // Default to Paris
}

// ── Read Operations ──────────────────────────────────────

/**
 * Get events for today.
 */
async function getTodayEvents(token, timeZone = "Europe/Paris") {
  const { start, end } = getDayRange(0, timeZone);
  return fetchEvents(token, start, end, timeZone);
}

/**
 * Get events for tomorrow.
 */
async function getTomorrowEvents(token, timeZone = "Europe/Paris") {
  const { start, end } = getDayRange(1, timeZone);
  return fetchEvents(token, start, end, timeZone);
}

/**
 * Get events for the current week (Mon-Sun).
 */
async function getWeekEvents(token, timeZone = "Europe/Paris") {
  const now = new Date();
  const dayOfWeek = now.getDay(); // 0=Sun
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
 * Get a single event by ID (includes body/details).
 */
async function getEventById(token, eventId) {
  const resp = await graphFetch(token, `/me/events/${eventId}?$select=id,subject,body,start,end,location,organizer,attendees,isOnlineMeeting,onlineMeetingUrl,recurrence,importance,sensitivity,showAs`);
  if (!resp || resp._error) return resp;
  return normalizeEvent(resp, true);
}

/**
 * Find free/busy slots for a given time range.
 */
async function findFreeSlots(token, startISO, endISO, durationMinutes = 30, timeZone = "Europe/Paris") {
  const resp = await graphFetch(token, "/me/calendar/getSchedule", {
    method: "POST",
    body: JSON.stringify({
      schedules: ["me"],
      startTime: { dateTime: startISO, timeZone },
      endTime: { dateTime: endISO, timeZone },
      availabilityViewInterval: durationMinutes,
    }),
  });

  if (!resp || resp._error || !resp.value || resp.value.length === 0) {
    // Fallback: get events and compute gaps
    return findFreeSlotsFromEvents(token, startISO, endISO, durationMinutes, timeZone);
  }

  const schedule = resp.value[0];
  const slots = [];
  const view = schedule.availabilityView || "";
  const start = new Date(startISO);
  const intervalMs = durationMinutes * 60 * 1000;

  for (let i = 0; i < view.length; i++) {
    if (view[i] === "0") { // 0 = free
      const slotStart = new Date(start.getTime() + i * intervalMs);
      const slotEnd = new Date(slotStart.getTime() + intervalMs);
      // Only include business hours (8:00-18:00)
      const hour = slotStart.getHours();
      if (hour >= 8 && hour < 18) {
        slots.push({
          start: slotStart.toISOString(),
          end: slotEnd.toISOString(),
          duration: durationMinutes,
        });
      }
    }
  }
  return slots;
}

// ── Write Operations ─────────────────────────────────────

/**
 * Create a new calendar event.
 */
async function createEvent(token, { subject, start, end, location, body, attendees, isOnlineMeeting, timeZone }) {
  const tz = timeZone || "Europe/Paris";
  const event = {
    subject,
    start: { dateTime: start, timeZone: tz },
    end: { dateTime: end, timeZone: tz },
  };
  if (location) event.location = { displayName: location };
  if (body) event.body = { contentType: "Text", content: body };
  if (attendees && attendees.length > 0) {
    event.attendees = attendees.map(a => ({
      emailAddress: { address: typeof a === "string" ? a : a.email, name: typeof a === "string" ? undefined : a.name },
      type: "required",
    }));
  }
  if (isOnlineMeeting) event.isOnlineMeeting = true;

  const resp = await graphFetch(token, "/me/events", {
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
  if (updates.subject) patch.subject = updates.subject;
  if (updates.start) patch.start = { dateTime: updates.start, timeZone: updates.timeZone || "Europe/Paris" };
  if (updates.end) patch.end = { dateTime: updates.end, timeZone: updates.timeZone || "Europe/Paris" };
  if (updates.location) patch.location = { displayName: updates.location };
  if (updates.body) patch.body = { contentType: "Text", content: updates.body };

  const resp = await graphFetch(token, `/me/events/${eventId}`, {
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
  if (comment) {
    // Send cancellation with message
    const resp = await graphFetch(token, `/me/events/${eventId}/cancel`, {
      method: "POST",
      body: JSON.stringify({ comment }),
    });
    return resp !== null && !resp._error;
  }
  // Simple delete
  const resp = await graphFetch(token, `/me/events/${eventId}`, { method: "DELETE" });
  return resp !== null;
}

/**
 * Accept a meeting invitation.
 */
async function acceptEvent(token, eventId, comment) {
  const resp = await graphFetch(token, `/me/events/${eventId}/accept`, {
    method: "POST",
    body: JSON.stringify({ comment: comment || "", sendResponse: true }),
  });
  return resp !== null && !resp._error;
}

/**
 * Decline a meeting invitation.
 */
async function declineEvent(token, eventId, comment) {
  const resp = await graphFetch(token, `/me/events/${eventId}/decline`, {
    method: "POST",
    body: JSON.stringify({ comment: comment || "", sendResponse: true }),
  });
  return resp !== null && !resp._error;
}

// ── Internal Helpers ─────────────────────────────────────

async function graphFetch(token, path, options = {}) {
  const url = path.startsWith("http") ? path : `${GRAPH_BASE}${path}`;
  try {
    const resp = await fetch(url, {
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        Prefer: 'outlook.timezone="Europe/Paris"',
        ...options.headers,
      },
      body: options.body,
      signal: AbortSignal.timeout(15000),
    });

    if (resp.status === 204 || resp.status === 202) return {};
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error(`${LOG} Graph API ${resp.status} on ${path.substring(0, 80)}: ${errText.substring(0, 200)}`);
      if (resp.status === 429) {
        const retryAfter = resp.headers.get("Retry-After") || "60";
        return { _error: true, status: 429, retryAfter: parseInt(retryAfter, 10) };
      }
      return { _error: true, status: resp.status, message: errText.substring(0, 200) };
    }

    const text = await resp.text();
    return text ? JSON.parse(text) : {};
  } catch (err) {
    console.error(`${LOG} Graph API error on ${path.substring(0, 80)}:`, err.message);
    return null;
  }
}

async function fetchEvents(token, startISO, endISO, timeZone) {
  const params = new URLSearchParams({
    startDateTime: startISO,
    endDateTime: endISO,
    $orderby: "start/dateTime",
    $top: "50",
    $select: "id,subject,body,bodyPreview,start,end,location,organizer,attendees,isOnlineMeeting,onlineMeetingUrl,importance,showAs,isCancelled",
  });
  const resp = await graphFetch(token, `/me/calendarView?${params}`, {
    headers: { Prefer: `outlook.timezone="${timeZone}"` },
  });
  if (!resp || resp._error) return resp;
  if (!resp.value) return [];
  return resp.value.filter(e => !e.isCancelled).map(e => normalizeEvent(e, true));
}

function normalizeEvent(e, includeBody) {
  // Graph API returns dateTime in the requested timezone (e.g., Europe/Paris)
  // but WITHOUT a timezone suffix. We must append the timezone offset so
  // new Date() parses it correctly instead of treating it as UTC.
  const tzId = e.start?.timeZone || e.end?.timeZone || "";
  const offset = getTimezoneOffset(tzId);
  const startRaw = e.start?.dateTime || e.start;
  const endRaw = e.end?.dateTime || e.end;
  // Only append offset if the value looks like a bare datetime (no Z, no +/-)
  const needsOffset = (v) => typeof v === "string" && !v.endsWith("Z") && !/[+-]\d{2}:\d{2}$/.test(v);
  const result = {
    id: e.id,
    subject: e.subject || "(no subject)",
    start: needsOffset(startRaw) ? startRaw.replace(/\.\d+$/, "") + offset : startRaw,
    end: needsOffset(endRaw) ? endRaw.replace(/\.\d+$/, "") + offset : endRaw,
    location: e.location?.displayName || "",
    organizer: e.organizer?.emailAddress?.name || e.organizer?.emailAddress?.address || "",
    organizerEmail: e.organizer?.emailAddress?.address || "",
    isOnlineMeeting: !!e.isOnlineMeeting,
    onlineMeetingUrl: e.onlineMeetingUrl || "",
    importance: e.importance || "normal",
    showAs: e.showAs || "busy",
  };

  if (e.attendees && e.attendees.length > 0) {
    result.attendees = e.attendees.map(a => ({
      name: a.emailAddress?.name || a.emailAddress?.address || "",
      email: a.emailAddress?.address || "",
      status: a.status?.response || "none",
    }));
  }

  if (includeBody && e.body) {
    let bodyText = e.body.content || "";
    if (e.body.contentType === "html" || e.body.contentType === "HTML") {
      bodyText = bodyText.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "");
      bodyText = bodyText.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    }
    result.body = bodyText.substring(0, 5000);
  }

  return result;
}

function getDayRange(offsetDays, timeZone) {
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

  const slots = [];
  const busyPeriods = events.map(e => ({
    start: new Date(e.start).getTime(),
    end: new Date(e.end).getTime(),
  })).sort((a, b) => a.start - b.start);

  const rangeStart = new Date(startISO).getTime();
  const rangeEnd = new Date(endISO).getTime();
  const durationMs = durationMinutes * 60 * 1000;

  let cursor = rangeStart;
  for (const busy of busyPeriods) {
    if (cursor + durationMs <= busy.start) {
      // Free gap before this event
      let slotStart = cursor;
      while (slotStart + durationMs <= busy.start) {
        const s = new Date(slotStart);
        const hour = s.getHours();
        if (hour >= 8 && hour < 18) {
          slots.push({
            start: s.toISOString(),
            end: new Date(slotStart + durationMs).toISOString(),
            duration: durationMinutes,
          });
        }
        slotStart += durationMs;
      }
    }
    cursor = Math.max(cursor, busy.end);
  }
  // Gap after last event
  if (cursor + durationMs <= rangeEnd) {
    let slotStart = cursor;
    while (slotStart + durationMs <= rangeEnd && slots.length < 20) {
      const s = new Date(slotStart);
      const hour = s.getHours();
      if (hour >= 8 && hour < 18) {
        slots.push({
          start: s.toISOString(),
          end: new Date(slotStart + durationMs).toISOString(),
          duration: durationMinutes,
        });
      }
      slotStart += durationMs;
    }
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
