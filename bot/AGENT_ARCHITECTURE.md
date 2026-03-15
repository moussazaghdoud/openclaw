# OpenClaw AI Agent Redesign

## 1. Honest Diagnosis of Previous System

The original OpenClaw bot suffered from fundamental architectural limitations that prevented it from handling real conversational interactions:

- **Regex-based intent detection was fragile and couldn't handle natural language.** The system relied on pattern matching (e.g., `/last\s+(\d+)\s+emails?\s+from\s+(.+)/i`) which only worked when users phrased requests in the exact expected syntax. Any deviation resulted in a miss.

- **Hardcoded patterns broke on typos, partial names, and follow-up questions.** A request like "emails from Jack" would fail because the regex expected a count. "Emails form Jack" (typo) would fail silently. "What did he send me?" was completely unrecognizable.

- **No iterative reasoning -- one search, dump results.** The system performed a single API call and returned whatever came back. If the search returned too many results, too few, or the wrong ones, there was no mechanism to refine, filter, or try again with different parameters.

- **No entity resolution -- "Jack" couldn't be resolved to "CHEN Jack Lixin".** The system passed user input directly as search queries. Partial names, nicknames, and informal references all failed because there was no layer to map human-friendly names to directory entries.

- **No working memory -- each message was independent.** Every incoming message was processed in complete isolation. The bot had no concept of "the person we were just talking about" or "the emails I just showed you." Every turn required the user to re-specify all context from scratch.

- **`callOpenClawFn` had wrong argument order, breaking all AI-powered features.** The function signature expected parameters in one order, but callers passed them in another. This meant summarization, drafting, and other AI-augmented features silently produced garbage or errors.

- **OpenClaw gateway with Opus added 5-7s latency per call.** Routing every reasoning step through the OpenClaw gateway introduced significant overhead. For multi-step tasks, this compounded to 15-30s of wait time, making the bot feel unresponsive.

---

## 2. Architecture Decision

After evaluating the options, we chose **Option B: Direct Claude API for agent reasoning**.

| Concern | Decision |
|---|---|
| Main conversation flow | OpenClaw retained for cross-service correlation and enterprise features |
| Agent reasoning & tool-calling | Direct Claude API (Sonnet) -- eliminates gateway latency |
| Writing & drafting | Direct Claude API (Opus) -- higher quality output for user-facing text |
| Fallback | Old regex handlers remain active when `ANTHROPIC_API_KEY` is not set |

**Rationale:** The OpenClaw gateway is valuable for its cross-service orchestration and enterprise compliance features, but using it as an intermediary for every reasoning step introduced unacceptable latency. By calling the Claude API directly for agent loops, we get sub-second tool-call cycles while preserving OpenClaw for the features where it adds genuine value.

---

## 3. Target Architecture

```
+------------------------------------------------------------------+
|                                                                  |
|  Layer 5: Response Layer (Rainbow-optimized)                     |
|  - Adaptive Card formatting for Teams                            |
|  - Markdown rendering for rich responses                         |
|  - Token-aware truncation to stay within message limits          |
|                                                                  |
+------------------------------------------------------------------+
|                                                                  |
|  Layer 4: Entity Resolution                                      |
|  - update_memory tool lets Claude store discovered identities    |
|  - Partial name matching: "Jack" -> "CHEN Jack Lixin"            |
|  - Pronoun resolution: "he" -> last resolved person              |
|  - Cross-turn identity tracking via working memory               |
|                                                                  |
+------------------------------------------------------------------+
|                                                                  |
|  Layer 3: Working Memory (Redis-backed)                          |
|  - Per-user session state with TTL                               |
|  - Resolved entities, recent results, current target             |
|  - Loaded at agent start, persisted after each run               |
|                                                                  |
+------------------------------------------------------------------+
|                                                                  |
|  Layer 2: Agent Orchestration (Iterative Loop)                   |
|  - Claude Sonnet drives reasoning via tool_use                   |
|  - Multi-step: search -> analyze -> refine -> respond            |
|  - Max iterations capped to prevent runaway loops                |
|  - Conversation history passed for context continuity            |
|                                                                  |
+------------------------------------------------------------------+
|                                                                  |
|  Layer 1: Tool Layer (Connectors)                                |
|  - Email: Microsoft Graph API (search, read, send)               |
|  - Calendar: Microsoft Graph API (search, read events)           |
|  - Sender details: Graph directory lookups                       |
|  - Memory: Redis read/write for entity persistence               |
|                                                                  |
+------------------------------------------------------------------+
```

**Data flow for a typical request:**

```
User message
    |
    v
bot.js (keyword routing)
    |
    v
agent.js :: runAgent()
    |
    +---> Load working memory (Layer 3)
    |
    +---> Build system prompt with memory context
    |
    +---> Enter agent loop (Layer 2):
    |       |
    |       +---> Claude API call (Sonnet or Opus)
    |       |
    |       +---> If tool_use in response:
    |       |       |
    |       |       +---> Execute tool (Layer 1)
    |       |       +---> Entity resolution (Layer 4)
    |       |       +---> Append result to messages
    |       |       +---> Loop back
    |       |
    |       +---> If text response (stop_reason: end_turn):
    |               +---> Break loop
    |
    +---> Save working memory (Layer 3)
    |
    +---> Format response (Layer 5)
    |
    v
Adaptive Card sent to user
```

---

## 4. Refactoring Plan

### New Files

| File | Purpose |
|---|---|
| `agent.js` | Full agentic system: tool definitions, agent loop, memory management, Claude API integration |

### Modified Files

| File | Changes |
|---|---|
| `bot.js` | Keyword-based routing added at the top of message handling. If the message looks like an email/calendar/person query and `ANTHROPIC_API_KEY` is set, route to `agent.runAgent()`. Otherwise, fall through to existing regex-based handlers. |
| `graph.js` | Sender search improvements: new `searchSender()` function that searches the directory by partial name and returns structured results (displayName, email, jobTitle, department). |

### Preserved Files (Fallback)

All existing modules are kept intact and serve as the fallback path:

- `email-intents.js` -- regex-based email handling (used when no API key)
- `calendar-intents.js` -- regex-based calendar handling (used when no API key)
- `salesforce-intents.js` -- Salesforce queries (unchanged)
- `sharepoint-intents.js` -- SharePoint queries (unchanged)
- `briefing.js` -- daily briefing (unchanged)

**Migration strategy:** The old handlers are never deleted. The routing in `bot.js` checks for `ANTHROPIC_API_KEY` before engaging the agent. If the key is absent, the bot behaves exactly as before. This allows gradual rollout and instant rollback.

---

## 5. Working Memory Design

### Storage

- **Backend:** Redis
- **Key format:** `agent:memory:{userId}`
- **TTL:** 1 hour (3600 seconds) -- resets on each interaction
- **Serialization:** JSON

### Schema

```json
{
  "resolvedEntities": {
    "Jack": {
      "displayName": "CHEN Jack Lixin",
      "email": "jack.chen@company.com",
      "jobTitle": "Senior Engineer",
      "department": "Platform"
    }
  },
  "lastEmails": [
    {
      "id": "AAMk...",
      "subject": "RE: Platform migration timeline",
      "from": "jack.chen@company.com",
      "receivedDateTime": "2026-03-14T09:23:00Z",
      "bodyPreview": "I have concerns about the Q3 deadline..."
    }
  ],
  "lastEvents": [
    {
      "id": "AAMk...",
      "subject": "Platform Review with Jack",
      "start": "2026-03-16T14:00:00Z",
      "end": "2026-03-16T15:00:00Z",
      "attendees": ["jack.chen@company.com", "user@company.com"]
    }
  ],
  "currentTarget": {
    "displayName": "CHEN Jack Lixin",
    "email": "jack.chen@company.com"
  },
  "topics": ["platform migration", "Q3 deadline", "resource allocation"]
}
```

### Lifecycle

1. **Load:** At the start of `runAgent()`, fetch the memory from Redis. If the key does not exist, initialize an empty memory object.
2. **Inject:** The memory contents are serialized into the system prompt so Claude has full context of prior interactions.
3. **Update:** During the agent loop, the `update_memory` tool allows Claude to write new entities, update the current target, or store discovered topics.
4. **Save:** After the agent loop completes (whether successfully or via timeout), the updated memory is written back to Redis with a refreshed TTL.

---

## 6. Entity Resolution Design

### The `update_memory` Tool

Claude is given a tool called `update_memory` that accepts structured updates to the working memory:

```json
{
  "name": "update_memory",
  "description": "Store resolved identities, context, and topics in working memory for cross-turn reference.",
  "input_schema": {
    "type": "object",
    "properties": {
      "resolvedEntities": {
        "type": "object",
        "description": "Map of informal name -> full identity object"
      },
      "currentTarget": {
        "type": "object",
        "description": "The person currently being discussed"
      },
      "topics": {
        "type": "array",
        "items": { "type": "string" },
        "description": "Key topics discovered in the conversation"
      }
    }
  }
}
```

### System Prompt Instructions

The system prompt includes explicit instructions for entity resolution:

> When the user mentions a person by partial name, nickname, or pronoun:
> 1. Check working memory for previously resolved entities.
> 2. If not found, use `get_sender_details` to search the directory.
> 3. If multiple matches are found, ask the user to disambiguate.
> 4. Once resolved, call `update_memory` to store the mapping for future turns.
> 5. For pronouns ("he", "she", "they"), resolve from `currentTarget` in memory.

### Resolution Chain

```
"Jack"
  -> Check memory.resolvedEntities["Jack"]
  -> Not found? Call get_sender_details("Jack")
  -> Returns: [{displayName: "CHEN Jack Lixin", email: "jack.chen@..."},
               {displayName: "MARTIN Jack", email: "jack.martin@..."}]
  -> Single strong match or user disambiguates
  -> Call update_memory({resolvedEntities: {"Jack": {...}}, currentTarget: {...}})

"he" (next turn)
  -> Check memory.currentTarget
  -> Resolves to "CHEN Jack Lixin" / "jack.chen@company.com"
  -> No tool call needed
```

---

## 7. Tool Orchestration Model

### Email Tools

| Tool | Purpose | Key Parameters |
|---|---|---|
| `search_emails` | Search emails by keyword, sender, date range | `query`, `from`, `maxResults` |
| `get_recent_emails` | Fetch the N most recent emails (no filter) | `count` |
| `read_email` | Read the full body of a specific email by ID | `emailId` |
| `read_thread` | Read all messages in a conversation thread | `conversationId` |

### Email Actions

| Tool | Purpose | Key Parameters |
|---|---|---|
| `send_email` | Send or reply to an email | `to`, `subject`, `body`, `replyToId` |
| `get_sender_details` | Look up a person in the directory by name | `name` |

### Calendar Tools

| Tool | Purpose | Key Parameters |
|---|---|---|
| `search_calendar` | Search calendar events by keyword, attendee, date range | `query`, `attendee`, `startDate`, `endDate` |
| `read_event` | Read full details of a specific calendar event | `eventId` |

### Memory Tools

| Tool | Purpose | Key Parameters |
|---|---|---|
| `update_memory` | Store resolved entities, current target, and topics | `resolvedEntities`, `currentTarget`, `topics` |

### Tool Design Principles

- **Minimal surface area:** Each tool does one thing. Searching and reading are separate operations so Claude can decide what to read after scanning search results.
- **Structured output:** All tools return JSON objects, not raw text. This lets Claude parse and reason about results programmatically.
- **Idempotent reads:** Search and read tools have no side effects. Only `send_email` and `update_memory` modify state.
- **Fail-safe:** Every tool call is wrapped in try/catch. On failure, the error message is returned to Claude as a tool result so it can reason about the failure and try an alternative approach.

---

## 8. Example Reasoning Flows

### Scenario 1: "What are the last 2 emails from Jack?"

```
USER: "What are the last 2 emails from Jack?"

--- Agent Loop Iteration 1 ---
CLAUDE thinks: User wants emails from "Jack". I need to resolve who Jack is first.
CLAUDE calls: get_sender_details({ name: "Jack" })
TOOL returns: [
  { displayName: "CHEN Jack Lixin", email: "jack.chen@company.com", department: "Platform" },
  { displayName: "MARTIN Jack", email: "jack.martin@company.com", department: "Sales" }
]

--- Agent Loop Iteration 2 ---
CLAUDE thinks: Two matches. "CHEN Jack Lixin" is in Platform (more likely for a
  technical user). But I should not assume -- however, I'll search for both and
  see which has recent emails. Actually, let me first store both and ask if
  ambiguous. But the user said "Jack" casually, suggesting a frequent contact.
  Let me search emails from both and present the most relevant.
CLAUDE calls: search_emails({ from: "jack.chen@company.com", maxResults: 2 })
TOOL returns: [
  { id: "msg1", subject: "RE: Platform migration timeline",
    receivedDateTime: "2026-03-14T09:23:00Z",
    bodyPreview: "I have concerns about the Q3 deadline..." },
  { id: "msg2", subject: "Resource allocation for Q2",
    receivedDateTime: "2026-03-13T16:45:00Z",
    bodyPreview: "Can we discuss the headcount..." }
]

--- Agent Loop Iteration 3 ---
CLAUDE thinks: Got 2 recent emails from CHEN Jack Lixin. Let me store the
  resolution and these results in memory for follow-ups.
CLAUDE calls: update_memory({
  resolvedEntities: { "Jack": { displayName: "CHEN Jack Lixin",
    email: "jack.chen@company.com", department: "Platform" } },
  currentTarget: { displayName: "CHEN Jack Lixin",
    email: "jack.chen@company.com" },
  lastEmails: [msg1, msg2],
  topics: ["platform migration", "resource allocation"]
})
TOOL returns: { success: true }

--- Agent Loop Iteration 4 (final) ---
CLAUDE responds with text:
  "Here are the last 2 emails from **CHEN Jack Lixin** (Platform):
   1. **RE: Platform migration timeline** (Mar 14) -- He raises concerns
      about the Q3 deadline...
   2. **Resource allocation for Q2** (Mar 13) -- He asks to discuss
      headcount..."

MEMORY after turn:
  resolvedEntities: { "Jack": "CHEN Jack Lixin" }
  currentTarget: "CHEN Jack Lixin"
  lastEmails: [msg1, msg2]
  topics: ["platform migration", "resource allocation"]
```

---

### Scenario 2: "What concerns did he raise?" (follow-up)

```
USER: "What concerns did he raise?"

--- Memory loaded ---
  currentTarget: { displayName: "CHEN Jack Lixin", email: "jack.chen@company.com" }
  lastEmails: [msg1 (Platform migration), msg2 (Resource allocation)]

--- Agent Loop Iteration 1 ---
CLAUDE thinks: "he" -> currentTarget -> CHEN Jack Lixin. The user wants to know
  about concerns. The bodyPreview of msg1 mentioned "concerns about Q3 deadline".
  I should read the full email body to give a detailed answer.
CLAUDE calls: read_email({ emailId: "msg1" })
TOOL returns: {
  id: "msg1",
  subject: "RE: Platform migration timeline",
  body: "Hi team,\n\nI have concerns about the Q3 deadline for the platform
    migration:\n1. The data layer refactoring is only 40% complete\n2. We
    haven't started integration testing\n3. The vendor dependency on CloudStore
    is unresolved -- they pushed their API release to August\n\nI think we need
    to either descope or push to Q4.\n\nBest,\nJack"
}

--- Agent Loop Iteration 2 ---
CLAUDE thinks: I also want to check if msg2 has concerns.
CLAUDE calls: read_email({ emailId: "msg2" })
TOOL returns: {
  id: "msg2",
  subject: "Resource allocation for Q2",
  body: "Hi,\n\nCan we discuss the headcount situation? We lost two engineers
    to the AI team and the remaining team is stretched thin. I'm worried we
    won't be able to maintain velocity on both the migration and BAU work.\n\nJack"
}

--- Agent Loop Iteration 3 ---
CLAUDE thinks: Now I have full context on both emails. Let me update topics
  in memory and provide a comprehensive answer.
CLAUDE calls: update_memory({
  topics: ["platform migration", "Q3 deadline", "data layer refactoring",
    "integration testing", "CloudStore vendor dependency", "headcount",
    "resource allocation"]
})
TOOL returns: { success: true }

--- Agent Loop Iteration 4 (final) ---
CLAUDE responds with text:
  "Jack raised several concerns across his recent emails:

   **Platform Migration (Mar 14):**
   1. Data layer refactoring is only 40% complete
   2. Integration testing hasn't started yet
   3. CloudStore vendor pushed their API release to August
   4. Recommends descoping or pushing to Q4

   **Resource Allocation (Mar 13):**
   5. Lost two engineers to the AI team
   6. Remaining team is stretched thin across migration and BAU work"

MEMORY after turn:
  (unchanged except topics updated with more detail)
```

---

### Scenario 3: "Propose a powerful answer" (follow-up)

```
USER: "Propose a powerful answer"

--- Memory loaded ---
  currentTarget: CHEN Jack Lixin
  lastEmails: [msg1, msg2] (full bodies now cached)
  topics: [platform migration, Q3 deadline, ...]

--- Agent Loop Iteration 1 ---
CLAUDE thinks: The user wants to draft a reply to Jack's concerns. This is a
  writing/drafting task, so I should compose a strong, executive-level response
  that addresses each concern with actionable next steps.

  [MODEL SELECTION: This request triggers Opus because it involves drafting
   a reply / composing an email. The keyword "answer" in the context of
   email follow-up maps to the drafting use case.]

CLAUDE (Opus) responds with text:
  "Here's a proposed reply to Jack:

   ---

   **Subject:** RE: Platform migration timeline

   Jack,

   Thank you for the candid assessment. These are exactly the risks we need
   to surface now rather than in Q3. Here's what I propose:

   **1. CloudStore dependency -- Immediate action**
   I'll set up a call with their VP of Engineering this week. If we can't
   get a firm commitment for a June API delivery, we activate Plan B:
   the abstraction layer that lets us swap providers.

   **2. Data layer & testing -- Revised timeline**
   Let's split the migration into two phases:
   - Phase 1 (Q3): Core services migration with the completed data layer
   - Phase 2 (Q4): Remaining services + full integration test suite

   **3. Headcount -- Reinforcement**
   I'm escalating the resource gap to the leadership meeting on Thursday.
   My ask: two contractors for 6 months to cover BAU while the core team
   focuses on migration.

   Can we block 30 minutes this week to align on this plan before I take
   it to leadership?

   Best regards"

MEMORY after turn:
  (unchanged -- no new entities or searches needed)
```

---

### Scenario 4: "Do I have a meeting with him?" (follow-up)

```
USER: "Do I have a meeting with him?"

--- Memory loaded ---
  currentTarget: { displayName: "CHEN Jack Lixin", email: "jack.chen@company.com" }

--- Agent Loop Iteration 1 ---
CLAUDE thinks: "him" -> currentTarget -> CHEN Jack Lixin. I need to search the
  user's calendar for upcoming meetings with jack.chen@company.com.
CLAUDE calls: search_calendar({
  attendee: "jack.chen@company.com",
  startDate: "2026-03-15T00:00:00Z",
  endDate: "2026-03-22T23:59:59Z"
})
TOOL returns: [
  {
    id: "evt1",
    subject: "Platform Review with Jack",
    start: "2026-03-16T14:00:00Z",
    end: "2026-03-16T15:00:00Z",
    location: "Teams Meeting",
    attendees: ["jack.chen@company.com", "user@company.com",
      "sarah.liu@company.com"]
  }
]

--- Agent Loop Iteration 2 ---
CLAUDE thinks: Found one meeting. Let me store it in memory and respond.
CLAUDE calls: update_memory({
  lastEvents: [{
    id: "evt1",
    subject: "Platform Review with Jack",
    start: "2026-03-16T14:00:00Z",
    attendees: ["jack.chen@company.com", "user@company.com",
      "sarah.liu@company.com"]
  }]
})
TOOL returns: { success: true }

--- Agent Loop Iteration 3 (final) ---
CLAUDE responds with text:
  "Yes, you have a meeting with **CHEN Jack Lixin** tomorrow:

   **Platform Review with Jack**
   - Date: Monday, March 16 at 2:00 PM - 3:00 PM
   - Location: Teams Meeting
   - Attendees: You, Jack Chen, Sarah Liu"

MEMORY after turn:
  lastEvents: [evt1]
  (currentTarget and resolvedEntities unchanged)
```

---

### Scenario 5: "Prepare me for the discussion" (follow-up)

```
USER: "Prepare me for the discussion"

--- Memory loaded ---
  currentTarget: CHEN Jack Lixin
  lastEmails: [msg1 (migration concerns), msg2 (resource allocation)]
  lastEvents: [evt1 (Platform Review, tomorrow 2 PM)]
  topics: [platform migration, Q3 deadline, data layer refactoring,
    integration testing, CloudStore vendor dependency, headcount,
    resource allocation]

--- Agent Loop Iteration 1 ---
CLAUDE thinks: The user wants preparation for the "Platform Review with Jack"
  meeting tomorrow. I have Jack's concerns from memory. I should also check
  if there are any other recent emails in the thread for additional context.
CLAUDE calls: read_thread({ conversationId: "msg1_conversationId" })
TOOL returns: [
  { from: "user@company.com", subject: "Platform migration timeline",
    body: "Team, please provide status updates on the migration..." },
  { from: "jack.chen@company.com", subject: "RE: Platform migration timeline",
    body: "(the concerns email we already have)" },
  { from: "sarah.liu@company.com", subject: "RE: Platform migration timeline",
    body: "I agree with Jack's assessment. The QA team also needs 3 more
    weeks for test environment setup..." }
]

--- Agent Loop Iteration 2 ---
CLAUDE thinks: Sarah Liu is also an attendee and she has added concerns.
  Let me also check if there are recent emails from Sarah on related topics.
CLAUDE calls: search_emails({ from: "sarah.liu@company.com",
  query: "platform migration", maxResults: 3 })
TOOL returns: [
  { id: "msg3", subject: "QA Environment for Migration",
    receivedDateTime: "2026-03-14T11:00:00Z",
    bodyPreview: "The test environment provisioning is blocked on IT..." }
]

--- Agent Loop Iteration 3 ---
CLAUDE calls: read_email({ emailId: "msg3" })
TOOL returns: {
  body: "Hi team,\n\nThe test environment provisioning is blocked on IT
    approvals. I've escalated but no ETA yet. Without the test env, we
    can't start integration testing even if the data layer is ready.\n\nSarah"
}

--- Agent Loop Iteration 4 ---
CLAUDE thinks: Now I have comprehensive context. This is a preparation/briefing
  task that requires synthesizing information into a structured executive
  document. This triggers Opus for quality.

  [MODEL SELECTION: "Prepare me" is a drafting/executive summary task ->
   routed to Opus for higher quality output.]

CLAUDE calls: update_memory({
  resolvedEntities: {
    "Jack": { displayName: "CHEN Jack Lixin", email: "jack.chen@company.com" },
    "Sarah": { displayName: "LIU Sarah", email: "sarah.liu@company.com" }
  },
  topics: ["platform migration", "Q3 deadline", "data layer refactoring",
    "integration testing", "CloudStore vendor dependency", "headcount",
    "resource allocation", "QA test environment", "IT approvals"]
})
TOOL returns: { success: true }

--- Agent Loop Iteration 5 (final) ---
CLAUDE (Opus) responds with text:

  "## Briefing: Platform Review with Jack
   **Monday, March 16 | 2:00 - 3:00 PM | Teams**
   **Attendees:** You, CHEN Jack Lixin (Platform), LIU Sarah (QA)

   ---

   ### Key Issues on the Table

   | # | Issue | Raised By | Severity |
   |---|---|---|---|
   | 1 | Data layer refactoring at 40% | Jack | High |
   | 2 | CloudStore API delayed to August | Jack | Critical |
   | 3 | Integration testing not started | Jack | High |
   | 4 | QA test environment blocked on IT | Sarah | High |
   | 5 | Lost 2 engineers to AI team | Jack | Medium |

   ### Recommended Positions

   **On the timeline:**
   Come prepared to propose a two-phase approach: Phase 1 (Q3) covers core
   services with the completed data layer; Phase 2 (Q4) handles the rest.
   This shows pragmatism without conceding the full deadline.

   **On CloudStore:**
   This is the critical path item. Propose scheduling a vendor escalation
   call this week. Have a fallback position ready: an abstraction layer
   that decouples you from their timeline.

   **On resources:**
   Frame the ask as time-bound contractors (6 months) rather than permanent
   headcount. This is easier to approve and directly addresses Jack's concern.

   **On test environment:**
   Ask Sarah for the specific IT ticket numbers so you can escalate directly.
   This demonstrates responsiveness and unblocks a key dependency.

   ### Talking Points
   1. Acknowledge the team's transparency -- you want more of this, not less
   2. Present the phased approach as a collaborative solution
   3. Commit to specific actions with deadlines (vendor call by Friday,
      headcount ask at Thursday leadership meeting)
   4. Ask each attendee: 'What's the one thing I can unblock for you this week?'

   ### Watch Out For
   - Jack may push for a full Q4 delay -- be ready to hold the line on
     Phase 1 in Q3
   - Sarah's QA blocker could cascade if not resolved this week
   - If both Jack and Sarah align on delay, don't fight it in the meeting --
     take it offline and come back with data"

MEMORY after turn:
  resolvedEntities: { "Jack": ..., "Sarah": ... }
  lastEmails: [msg1, msg2]
  lastEvents: [evt1]
  topics: (expanded list)
```

---

## 9. Model Strategy

### Model Assignment

| Model | Use Cases | Rationale |
|---|---|---|
| **SONNET** (claude-sonnet-4-20250514) | Reasoning, search orchestration, tool-calling, analysis, summarization | Fast iteration cycles, cost-effective for multi-turn agent loops, strong tool-use performance |
| **OPUS** (claude-opus-4-20250514) | Drafting email replies, composing messages, executive summaries, meeting preparation briefs | Superior writing quality, nuanced tone matching, better structural coherence for long-form output |

### Selection Logic

The model is selected based on keyword detection in the user's message and the inferred task type:

```javascript
function selectModel(userMessage, conversationContext) {
  const draftingKeywords = [
    'draft', 'compose', 'write', 'reply', 'respond',
    'answer',  // in email context
    'prepare', 'brief', 'summarize for',
    'propose'  // as in "propose a response"
  ];

  const message = userMessage.toLowerCase();

  // Check if the message matches drafting/writing intent
  const isDrafting = draftingKeywords.some(kw => message.includes(kw));

  // Also check conversation context: if last turn was about emails
  // and this turn asks to "propose a powerful answer", it's drafting
  const isFollowUpDraft = conversationContext.lastEmails?.length > 0
    && ['answer', 'propose', 'prepare'].some(kw => message.includes(kw));

  if (isDrafting || isFollowUpDraft) {
    return 'claude-opus-4-20250514';
  }

  return 'claude-sonnet-4-20250514';
}
```

### Cost and Latency Considerations

- Sonnet calls in the agent loop typically complete in 0.5-1.5s each, enabling responsive multi-step reasoning.
- Opus is only invoked for the final drafting step, typically a single call, so the cost premium is bounded.
- A typical 5-scenario conversation uses approximately 8-12 Sonnet calls and 2-3 Opus calls.

---

## 10. Testing Plan

### Entity Resolution Tests

| Test Case | Input | Expected Behavior |
|---|---|---|
| Partial first name | "emails from Jack" | Resolves via `get_sender_details`, stores in memory |
| Partial last name | "emails from Chen" | Resolves to CHEN Jack Lixin (or disambiguates if multiple Chens) |
| Ambiguous name | "emails from Alex" | Returns multiple matches, asks user to choose |
| Exact match | "emails from jack.chen@company.com" | Skips directory lookup, searches directly |
| Nickname | "emails from Jackie" | Attempts directory search, falls back to email search if no match |
| Case insensitivity | "emails from JACK" | Normalizes and resolves correctly |

### Iterative Tool Call Tests

| Test Case | Input | Expected Behavior |
|---|---|---|
| Search then read | "what did Jack say about migration?" | search_emails -> read_email (for relevant result) |
| Search refinement | "emails about the project" (too broad) | First search returns many results -> Claude narrows with additional keywords |
| Empty results retry | "emails from Jackk" (typo) | First search returns nothing -> Claude tries variations or asks for clarification |
| Multi-source | "prepare me for the meeting" | Reads emails + calendar + thread in multiple iterations |

### Cross-Turn Reference Tests

| Test Case | Turn 1 | Turn 2 | Expected Behavior |
|---|---|---|---|
| Pronoun "he" | "emails from Jack" | "what did he say?" | Resolves "he" to Jack from `currentTarget` |
| Pronoun "she" | "emails from Sarah" | "did she reply?" | Resolves "she" to Sarah from `currentTarget` |
| "that email" | "last email from Jack" | "summarize that email" | References `lastEmails[0]` from memory |
| "the meeting" | "do I have a meeting with him?" | "prepare me for the meeting" | References `lastEvents[0]` from memory |
| Target persistence | "emails from Jack" | "his calendar events?" | `currentTarget` persists, calendar searched for Jack |
| Target switch | "emails from Jack" then "emails from Sarah" | "what did she say?" | `currentTarget` updated to Sarah |

### Email Summarization Tests

| Test Case | Input | Expected Behavior |
|---|---|---|
| Single email summary | "summarize the last email from Jack" | Searches, reads full body, provides concise summary |
| Multi-email summary | "summarize my last 5 emails" | Fetches recent emails, provides bullet-point summary of each |
| Thread summary | "summarize the migration thread" | Reads full thread, provides chronological summary with key decisions |
| Long email handling | Email with >2000 words | Truncates intelligently, focuses on key points |

### Reply Drafting Tests (Must Use Opus)

| Test Case | Input | Expected Behavior |
|---|---|---|
| Simple reply | "draft a reply to Jack's email" | Uses Opus, generates contextual reply, matches professional tone |
| Directive reply | "propose a powerful answer" | Uses Opus, generates assertive reply with action items |
| Tone matching | "write a gentle pushback" | Uses Opus, adjusts tone to be diplomatic but firm |
| Model verification | Any drafting request | Verify that the API call uses `claude-opus-4-20250514`, not Sonnet |

### Calendar Linking Tests

| Test Case | Input | Expected Behavior |
|---|---|---|
| Email person to calendar | "emails from Jack" then "do I have a meeting with him?" | Uses resolved email to search calendar by attendee |
| Meeting with unknown person | "do I have a meeting with Dr. Smith?" | Resolves name first, then searches calendar |
| Date range | "meetings this week" | Searches calendar with current week date range |
| Meeting preparation | "prepare me for the discussion" | Links email context + calendar event + attendee info |

### Working Memory Persistence Tests

| Test Case | Validation |
|---|---|
| Memory creation | After first turn, verify Redis key `agent:memory:{userId}` exists |
| Memory content | After entity resolution, verify `resolvedEntities` contains the mapping |
| TTL refresh | After second turn, verify TTL is reset to 3600s |
| Memory expiry | After 1 hour of inactivity, verify key is deleted |
| Memory isolation | Two different users have independent memory stores |
| Memory across turns | Information from turn 1 is available in turn 3 without re-fetching |

### Timeout Handling Tests

| Test Case | Setup | Expected Behavior |
|---|---|---|
| Agent loop timeout | Set max iterations to 3; give a query requiring 5 iterations | Agent returns best available answer after 3 iterations with a note that results may be incomplete |
| API timeout | Mock Claude API to respond after 30s | Agent returns a timeout error message, memory is still saved |
| Tool timeout | Mock Graph API to hang | Individual tool returns error, Claude retries or uses alternative approach |
| Graceful degradation | Kill Redis mid-conversation | Agent continues without memory, treats each turn as independent (like the old system) |

### Fallback Tests (No ANTHROPIC_API_KEY)

| Test Case | Setup | Expected Behavior |
|---|---|---|
| No API key set | Unset `ANTHROPIC_API_KEY` | `bot.js` routes to old regex handlers, agent is never invoked |
| Invalid API key | Set `ANTHROPIC_API_KEY` to "invalid" | First API call fails, bot falls back to old handlers for that turn |
| Partial fallback | API key set but API is down | Returns error message, suggests user try again; does not crash |
| Feature parity check | Run old test suite without API key | All existing regex-based features continue to work unchanged |
