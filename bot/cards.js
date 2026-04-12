/**
 * Adaptive Card Builder — Rich interactive messages for Rainbow S2S.
 *
 * Based on Rainbow S2S Adaptive Card spec:
 *   - Cards sent via contents[]: { type: "form/json", data: JSON.stringify(card) }
 *   - Button clicks return as rainbow/json with messageBack type
 *   - Version 1.5, schema: http://adaptivecards.io/schemas/adaptive-card.json
 *
 * Usage:
 *   const cards = require("./cards");
 *   const payload = cards.confirmation("Send this email?", { to: "yann@co.com", subject: "Q2" });
 *   await sendAdaptiveCard(convId, "Send this email?", payload.card, conversation);
 */

const LOG = "[Cards]";

// ── Base Card Shell ─────────────────────────────────────

function shell(body, actions) {
  const card = {
    type: "AdaptiveCard",
    "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
    version: "1.5",
    body,
  };
  if (actions && actions.length > 0) card.actions = actions;
  return card;
}

function submitButton(title, payload) {
  return {
    type: "Action.Submit",
    title,
    data: {
      rainbow: {
        type: "messageBack",
        value: { response: payload },
        text: title,
      },
    },
  };
}

function openUrlButton(title, url) {
  return {
    type: "Action.OpenUrl",
    title,
    url,
  };
}

// ── Message Payload Builder ─────────────────────────────

/**
 * Build a full Rainbow message payload with:
 * - Adaptive Card (for iOS/Android/desktop Rainbow apps)
 * - rainbow/suggest buttons (for web client fallback)
 * - Plain text body (for clients that support neither)
 *
 * buttons: [{ title: "Option A", value: "option_a" }] — optional suggest buttons for web
 */
function toPayload(fallbackText, card, buttons) {
  const msg = {
    message: {
      subject: fallbackText.substring(0, 20) + "...",
      body: fallbackText,
      contents: [
        { type: "form/json", data: JSON.stringify(card) },
      ],
      lang: "en",
    },
  };

  // Add rainbow/suggest for web client (renders as clickable chips)
  if (buttons && buttons.length > 0) {
    const suggestData = buttons.map(b => ({
      title: b.title,
      value: b.value || b.title,
    }));
    msg.message.alternativeContent = [
      { type: "rainbow/suggest", content: JSON.stringify(suggestData) },
    ];
  }

  return msg;
}

// ── Card Templates ──────────────────────────────────────

/**
 * Yes/No confirmation card with optional detail facts.
 * details: { "To": "yann@co.com", "Subject": "Q2 numbers" }
 */
function confirmation(question, details, yesLabel = "Yes", noLabel = "No") {
  const body = [
    { type: "TextBlock", text: question, wrap: true, weight: "Bolder", size: "Medium" },
  ];

  if (details && Object.keys(details).length > 0) {
    body.push({
      type: "FactSet",
      facts: Object.entries(details).map(([k, v]) => ({ title: k, value: String(v) })),
    });
  }

  body.push({
    type: "ActionSet",
    actions: [
      submitButton(yesLabel, "yes"),
      submitButton(noLabel, "no"),
    ],
  });

  const buttons = [
    { title: yesLabel, value: "yes" },
    { title: noLabel, value: "no" },
  ];
  return { card: shell(body), fallback: question, buttons };
}

/**
 * Multiple choice disambiguation card.
 * choices: [{ title: "Option A", value: "a" }, ...]
 */
function choices(question, options) {
  const body = [
    { type: "TextBlock", text: question, wrap: true, weight: "Bolder" },
    {
      type: "ActionSet",
      actions: options.map(c => submitButton(c.title, c.value || c.title)),
    },
  ];
  const buttons = options.map(c => ({ title: c.title, value: c.value || c.title }));
  return { card: shell(body), fallback: question, buttons };
}

/**
 * Meeting alert card with summary, attendees, agenda, and action buttons.
 */
function meetingAlert({ subject, startTime, endTime, location, organizer, attendees, body, onlineMeetingUrl, minutesLeft }) {
  const cardBody = [
    {
      type: "ColumnSet",
      columns: [
        {
          type: "Column", width: "auto",
          items: [{ type: "TextBlock", text: "⏰", size: "Large" }],
        },
        {
          type: "Column", width: "stretch",
          items: [
            { type: "TextBlock", text: `Meeting in ${minutesLeft} min`, weight: "Bolder", size: "Medium" },
            { type: "TextBlock", text: subject || "(no subject)", wrap: true, size: "Default", color: "Accent" },
          ],
        },
      ],
    },
    {
      type: "FactSet",
      facts: [
        { title: "Time", value: `${startTime} - ${endTime}` },
        ...(location ? [{ title: "Location", value: location }] : []),
        ...(organizer ? [{ title: "Organizer", value: organizer }] : []),
      ],
    },
  ];

  // Attendees
  if (attendees && attendees.length > 0) {
    const names = attendees.slice(0, 10).map(a => typeof a === "string" ? a : a.name || a.email || a);
    cardBody.push({
      type: "TextBlock", text: `👥 Participants (${attendees.length})`, weight: "Bolder", spacing: "Medium",
    });
    cardBody.push({
      type: "TextBlock",
      text: names.join(", ") + (attendees.length > 10 ? ` ... +${attendees.length - 10} more` : ""),
      wrap: true, size: "Small",
    });
  }

  // Agenda/body
  if (body && body.trim()) {
    cardBody.push({
      type: "TextBlock", text: "📝 Agenda", weight: "Bolder", spacing: "Medium",
    });
    cardBody.push({
      type: "TextBlock", text: body.substring(0, 500), wrap: true, size: "Small",
    });
  }

  // Action buttons
  const actions = [];
  if (onlineMeetingUrl) {
    actions.push(openUrlButton("Join Meeting", onlineMeetingUrl));
  }
  actions.push(submitButton("Snooze 10 min", "snooze:10"));
  actions.push(submitButton("Dismiss", "dismiss"));

  const buttons = [];
  if (onlineMeetingUrl) buttons.push({ title: "Join Meeting", value: onlineMeetingUrl });
  buttons.push({ title: "Snooze 10 min", value: "snooze:10" });
  buttons.push({ title: "Dismiss", value: "dismiss" });
  return { card: shell(cardBody, actions), fallback: `⏰ Meeting in ${minutesLeft} min: ${subject}`, buttons };
}

/**
 * Reminder card.
 */
function reminder(message, ruleId) {
  const body = [
    {
      type: "ColumnSet",
      columns: [
        { type: "Column", width: "auto", items: [{ type: "TextBlock", text: "🔔", size: "Large" }] },
        {
          type: "Column", width: "stretch",
          items: [
            { type: "TextBlock", text: "Reminder", weight: "Bolder", size: "Medium" },
            { type: "TextBlock", text: message, wrap: true },
          ],
        },
      ],
    },
  ];

  const actions = [
    submitButton("Done", "reminder:done:" + (ruleId || "")),
    submitButton("Snooze 30 min", "reminder:snooze:30:" + (ruleId || "")),
  ];

  const buttons = [
    { title: "Done", value: "reminder:done:" + (ruleId || "") },
    { title: "Snooze 30 min", value: "reminder:snooze:30:" + (ruleId || "") },
  ];
  return { card: shell(body, actions), fallback: `🔔 Reminder: ${message}`, buttons };
}

/**
 * Email draft confirmation card.
 */
function emailDraft({ to, subject, bodyPreview, action = "send" }) {
  const body = [
    { type: "TextBlock", text: `📧 ${action === "reply" ? "Reply" : "Email"} Draft`, weight: "Bolder", size: "Medium" },
    {
      type: "FactSet",
      facts: [
        { title: "To", value: to || "—" },
        { title: "Subject", value: subject || "—" },
      ],
    },
  ];

  if (bodyPreview) {
    body.push({ type: "TextBlock", text: bodyPreview.substring(0, 300), wrap: true, size: "Small", isSubtle: true });
  }

  body.push({
    type: "ActionSet",
    actions: [
      submitButton("Send", "yes"),
      submitButton("Cancel", "no"),
      submitButton("Edit", "edit"),
    ],
  });

  const buttons = [
    { title: "Send", value: "yes" },
    { title: "Cancel", value: "no" },
    { title: "Edit", value: "edit" },
  ];
  return { card: shell(body), fallback: `📧 Draft to ${to}: ${subject}`, buttons };
}

/**
 * CRM write confirmation card (deal update, close, etc.)
 */
function crmConfirmation({ action, dealName, changes }) {
  const body = [
    { type: "TextBlock", text: `📊 ${action}`, weight: "Bolder", size: "Medium" },
    { type: "TextBlock", text: dealName || "", wrap: true, color: "Accent" },
  ];

  if (changes && Object.keys(changes).length > 0) {
    body.push({
      type: "FactSet",
      facts: Object.entries(changes).map(([k, v]) => ({ title: k, value: String(v) })),
    });
  }

  body.push({
    type: "ActionSet",
    actions: [
      submitButton("Confirm", "yes"),
      submitButton("Cancel", "no"),
    ],
  });

  const buttons = [
    { title: "Confirm", value: "yes" },
    { title: "Cancel", value: "no" },
  ];
  return { card: shell(body), fallback: `${action}: ${dealName}`, buttons };
}

/**
 * Calendar event confirmation card (create/cancel meeting).
 */
function calendarConfirmation({ action, subject, date, time, location, attendees }) {
  const body = [
    { type: "TextBlock", text: `📅 ${action}`, weight: "Bolder", size: "Medium" },
    {
      type: "FactSet",
      facts: [
        { title: "Subject", value: subject || "—" },
        { title: "Date", value: date || "—" },
        ...(time ? [{ title: "Time", value: time }] : []),
        ...(location ? [{ title: "Location", value: location }] : []),
      ],
    },
  ];

  if (attendees && attendees.length > 0) {
    body.push({ type: "TextBlock", text: `👥 ${attendees.join(", ")}`, wrap: true, size: "Small" });
  }

  body.push({
    type: "ActionSet",
    actions: [
      submitButton("Confirm", "yes"),
      submitButton("Cancel", "no"),
    ],
  });

  const buttons = [
    { title: "Confirm", value: "yes" },
    { title: "Cancel", value: "no" },
  ];
  return { card: shell(body), fallback: `${action}: ${subject}`, buttons };
}

/**
 * Automation status card.
 */
function automationCreated({ type, description, schedule }) {
  const body = [
    { type: "TextBlock", text: "✅ Automation Created", weight: "Bolder", size: "Medium", color: "Good" },
    {
      type: "FactSet",
      facts: [
        { title: "Type", value: type },
        { title: "Description", value: description },
        ...(schedule ? [{ title: "Schedule", value: schedule }] : []),
      ],
    },
  ];

  return { card: shell(body), fallback: `✅ Automation created: ${description}` };
}

/**
 * Email digest card — summary row per email with priority indicator.
 * emails: [{ from, subject, priority, preview }]
 */
function emailDigestItem({ from, subject, priority, preview, emailId }) {
  const priorityColors = { URGENT: "Attention", ACTION: "Warning", EMT: "Accent", FYI: "Default" };
  const priorityEmoji = { URGENT: "🔴", ACTION: "🟡", EMT: "🔵", FYI: "⚪" };

  const body = [
    {
      type: "ColumnSet",
      columns: [
        {
          type: "Column", width: "auto",
          items: [{ type: "TextBlock", text: priorityEmoji[priority] || "⚪" }],
        },
        {
          type: "Column", width: "stretch",
          items: [
            { type: "TextBlock", text: from, weight: "Bolder", size: "Small" },
            { type: "TextBlock", text: subject, wrap: true, size: "Default", color: priorityColors[priority] || "Default" },
            ...(preview ? [{ type: "TextBlock", text: preview.substring(0, 150), wrap: true, size: "Small", isSubtle: true }] : []),
          ],
        },
      ],
    },
  ];

  const actions = [
    submitButton("Read", `email:read:${emailId || ""}`),
    submitButton("Reply", `email:reply:${emailId || ""}`),
  ];

  return { card: shell(body, actions), fallback: `${priorityEmoji[priority] || ""} ${from}: ${subject}` };
}

// ── Parse Card Responses ────────────────────────────────

/**
 * Parse an incoming message for Adaptive Card button responses.
 * Returns { isCard: true, response: "yes", inputValues: {} } or { isCard: false }
 */
function parseCardResponse(message) {
  // Check alternativeContent (SDK path)
  if (message && message.alternativeContent) {
    for (const alt of message.alternativeContent) {
      if (alt.type === "rainbow/json") {
        try {
          const data = typeof alt.content === "string" ? JSON.parse(alt.content) : alt.content;
          if (data?.rainbow?.type === "messageBack") {
            const value = data.rainbow.value || {};
            const { response, ...inputValues } = value;
            return {
              isCard: true,
              response: response || data.rainbow.text || "",
              inputValues: Object.keys(inputValues).length > 0 ? inputValues : undefined,
            };
          }
        } catch {}
      }
    }
  }

  // Check contents[] (S2S webhook path)
  if (message && message.contents) {
    for (const content of message.contents) {
      if (content.type === "rainbow/json") {
        try {
          const data = typeof content.data === "string" ? JSON.parse(content.data) : content.data;
          if (data?.rainbow?.type === "messageBack") {
            const value = data.rainbow.value || {};
            const { response, ...inputValues } = value;
            return {
              isCard: true,
              response: response || data.rainbow.text || "",
              inputValues: Object.keys(inputValues).length > 0 ? inputValues : undefined,
            };
          }
        } catch {}
      }
    }
  }

  return { isCard: false };
}

// ── Exports ─────────────────────────────────────────────

module.exports = {
  // Low-level
  shell,
  submitButton,
  openUrlButton,
  toPayload,

  // Templates
  confirmation,
  choices,
  meetingAlert,
  reminder,
  emailDraft,
  crmConfirmation,
  calendarConfirmation,
  automationCreated,
  emailDigestItem,

  // Parsing
  parseCardResponse,
};
