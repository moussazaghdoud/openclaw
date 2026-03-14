# OpenClaw Project — Context

## Overview

OpenClaw is a standalone project (NOT part of ConnectPlus) that provides an AI chatbot on Rainbow (ALE's UCaaS platform) powered by Claude Opus via the OpenClaw AI gateway.

**Flow:** Rainbow user sends IM → Rainbow bot receives it → bot calls OpenClaw gateway API → OpenClaw forwards to Claude Opus → AI response → bot sends reply back to Rainbow user.

The bot has evolved into a full **Executive AI Assistant** capable of managing emails (Outlook + Gmail), calendars (Outlook + Google), CRM data (Salesforce), document processing (translation, anonymization), and cross-system executive briefings — all accessible exclusively through Rainbow chat.

## Architecture

Two Railway services deployed from the same GitHub repo (`moussazaghdoud/openclaw`):

### 1. OpenClaw Gateway Service
- **Root directory:** `/` (repo root)
- **Public URL:** `https://openclaw-production-6a99.up.railway.app`
- **Port:** 18789
- **Base image:** `ghcr.io/openclaw/openclaw:latest`
- **What it does:** Local-first AI gateway exposing an OpenAI-compatible API (`POST /v1/chat/completions`)
- **Auth:** Bearer token (`sk-openclaw-...`)
- **Agent selection:** via model field `"model": "openclaw:<agentId>"`
- **Response format:** Standard OpenAI `choices[0].message.content`
- **Config baked into Docker image:** `openclaw.json` → `/home/node/.openclaw/openclaw.json`
- **Note:** OpenClaw does NOT reliably pass through `tools`/`tool_choice` parameters to Claude. The bot handles all file creation logic itself.
- **Railway env vars:**
  - `ANTHROPIC_API_KEY` — Claude API key
  - `OPENCLAW_GATEWAY_TOKEN` — Token for gateway auth

### 2. Rainbow Bot Service
- **Root directory:** `bot`
- **Public URL:** `https://bot-production-4410.up.railway.app`
- **Port:** 8080 (Railway `PORT` env var)
- **Base image:** `node:22-slim`
- **What it does:** Rainbow S2S bot that receives IMs and forwards to OpenClaw
- **Railway env vars:**
  - `RAINBOW_BOT_LOGIN` — Bot Rainbow account email (`ale-corp-chat@al-enterprise.com`)
  - `RAINBOW_BOT_PASSWORD` — Bot account password
  - `RAINBOW_APP_ID` — Rainbow application ID (registered on openrainbow.com)
  - `RAINBOW_APP_SECRET` — Rainbow application secret
  - `RAINBOW_HOST` — `official` (openrainbow.com, NOT sandbox)
  - `RAINBOW_HOST_CALLBACK` — Bot's public URL for S2S callbacks (`https://bot-production-4410.up.railway.app`)
  - `OPENCLAW_ENDPOINT` — Gateway URL (`https://openclaw-production-6a99.up.railway.app`)
  - `OPENCLAW_API_KEY` — Gateway auth token
  - `OPENCLAW_AGENT_ID` — Agent ID (default: `main`)
  - `OPENCLAW_SYSTEM_PROMPT` — System prompt for AI
  - `OPENCLAW_WELCOME_MSG` — Welcome message for new users
  - `REDIS_URL` — Redis connection string (from Railway Redis service)
  - `M365_CLIENT_ID` — Microsoft Entra app client ID (for Outlook email + calendar)
  - `M365_CLIENT_SECRET` — Microsoft Entra app client secret
  - `M365_REDIRECT_URI` — OAuth callback URL (`https://bot-production-4410.up.railway.app/auth/microsoft/callback`)
  - `M365_TENANT_ID` — Azure AD tenant (default: `common`)
  - `M365_TOKEN_ENCRYPTION_KEY` — 32-byte hex key for AES-256-GCM token encryption (shared across all providers)
  - `GMAIL_CLIENT_ID` — Google OAuth2 client ID (for Gmail + Google Calendar)
  - `GMAIL_CLIENT_SECRET` — Google OAuth2 client secret
  - `GMAIL_REDIRECT_URI` — OAuth callback URL (`https://bot-production-4410.up.railway.app/auth/gmail/callback`)
  - `SALESFORCE_CLIENT_ID` — Salesforce Connected App client ID
  - `SALESFORCE_CLIENT_SECRET` — Salesforce Connected App client secret
  - `SALESFORCE_REDIRECT_URI` — OAuth callback URL (`https://bot-production-4410.up.railway.app/auth/salesforce/callback`)
  - `SALESFORCE_LOGIN_URL` — Salesforce login URL (default: `https://login.salesforce.com`, use `https://test.salesforce.com` for sandbox)
  - `PRESIDIO_URL` — Optional Presidio PII anonymization service URL
  - `ADMIN_USERNAME` — Enterprise admin portal username (default: `admin`)
  - `ADMIN_PASSWORD` — Enterprise admin portal password (enables enterprise mode when set)
  - `JWT_SECRET` — JWT signing secret for admin sessions (auto-generated if not set)

## File Structure

```
openclaw/
├── Dockerfile              # OpenClaw gateway Docker image
├── openclaw.json           # Gateway config (auth token, controlUi, chatCompletions)
├── _context.md             # This file
└── bot/
    ├── Dockerfile          # Bot Docker image (node:22-slim), uses COPY *.js ./
    ├── bot.js              # Main bot: Rainbow SDK, Express, intent detection, all handlers
    ├── pii.js              # PII/PPI anonymization module (secure mode)
    ├── package.json        # Dependencies: dotenv, express, rainbow-node-sdk, redis, mammoth, jszip, pdf-parse
    │
    │── # Email Integration (Dual Backend)
    ├── auth.js             # Microsoft Entra OAuth2 (M365 tokens, scopes: Mail + Calendars.ReadWrite)
    ├── graph.js            # Microsoft Graph API connector (Outlook email operations)
    ├── gmail-auth.js       # Google OAuth2 (Gmail + Calendar tokens, scopes: gmail.* + calendar.*)
    ├── gmail-api.js        # Gmail REST API connector (email operations)
    ├── email-intents.js    # Dual-backend email intent handler (auto-detects Gmail vs Outlook)
    │
    │── # Calendar Integration (Dual Backend)
    ├── calendar-graph.js   # Microsoft Graph API connector (Outlook Calendar operations)
    ├── calendar-google.js  # Google Calendar REST API connector
    ├── calendar-intents.js # Dual-backend calendar intent handler (auto-detects Google vs Outlook)
    │
    │── # Salesforce CRM Integration
    ├── salesforce-auth.js  # Salesforce OAuth2 (Connected App tokens)
    ├── salesforce-api.js   # Salesforce REST API connector (SOQL queries, SOSL search)
    ├── salesforce-intents.js # CRM intent handler (accounts, contacts, opportunities, briefings)
    │
    │── # SharePoint / OneDrive Integration
    ├── sharepoint-api.js   # Microsoft Graph API connector (document search, download, content extraction)
    ├── sharepoint-intents.js # Document intent handler (search, summarize, download, sites)
    │
    │── # Cross-System Context Aggregation
    ├── briefing.js         # Executive briefing builder + entity/people/account/topic matching
    │
    │── # Enterprise Deployment Layer
    ├── enterprise.js       # User registry, magic-link invites, SSO activation, access control, admin portal
    │
    ├── .env                # Local env vars (gitignored)
    ├── .env.example        # Template
    └── config/             # Legacy config files (NOT used — bot reads env vars only)
        ├── credentials.json
        └── botConfiguration.json
```

## Bot Technical Details (`bot/bot.js`)

### Rainbow SDK Configuration
- **Mode:** S2S (Server-to-Server) with real Express server
- **SDK version:** `rainbow-node-sdk` 2.42.0-lts.1
- **Express:** Started immediately on `PORT` for Railway health check; wrapped via `Object.create(app)` so SDK doesn't call `listen()` again
- **Services enabled:** bubbles, s2s, im, contacts, conversations, presence, fileServer, fileStorage

### Intent-Driven Architecture (Bot Decides, AI Generates Content)

The bot uses **intent detection** to decide what to do. The AI is a pure text engine — it never decides whether to create files, call tools, or generate download links. This ensures 100% reliable file creation.

#### Intent Detection (`detectIntent()`)
Analyzes the user message and returns one of:
- **`translate_docx`** — User wants to translate a Word document (e.g. "translate to French")
- **`translate_pdf`** — User wants to translate a PDF document
- **`translate_pptx`** — User wants to translate a PowerPoint presentation
- **`translate_any`** — Translation requested but no file in memory (checks Redis for any stored file)
- **`anonymize_pptx/docx/pdf`** — User wants to anonymize a document (redact PII)
- **`create_file`** — User wants a file created (e.g. "create a report", "generate a CSV")
- **`email_*`** — Email intents (delegated to `email-intents.js`): summarize_unread, list_recent, from_sender, search, action_needed, briefing, compose_new, draft_reply, send_confirm, archive, mark_read, flag, smart_query
- **`calendar_*`** — Calendar intents (delegated to `calendar-intents.js`): today, tomorrow, week, free_slots, create, reschedule, cancel, accept, decline, details, smart_query, confirm_create, confirm_cancel
- **`sf_*`** — Salesforce intents (delegated to `salesforce-intents.js`): search_accounts, account_details, search_contacts, opportunities, activity, briefing, global_search, smart_query
- **`sp_*`** — SharePoint intents (delegated to `sharepoint-intents.js`): search, recent, summarize, download, sites, smart_query
- **`briefing_*`** — Cross-system briefing intents (delegated to `briefing.js`): daily, meeting, customer, weekly, followups
- **`chat`** — Default: regular AI conversation

#### Intent Confirmation (`describeIntent()`)
Before starting any task, the bot sends a short reformulation of the user's request as immediate feedback (e.g. "Translating Word document to French..."). This confirms the bot understood the order before the actual work begins.

#### translate_docx Flow
1. Bot extracts text paragraphs from the stored .docx XML (skipping image/drawing elements)
2. Sends paragraphs to `callTranslation()` for translation (with chunking and 3-min timeout)
3. Parses the JSON array from AI response
4. Opens the original .docx via `jszip`, replaces `<w:t>` text content per paragraph (single-pass regex, preserving images/styles/layout)
5. Generates new .docx buffer, hosts it, sends download link
6. **Key:** Images, styles, formatting are completely preserved — only text is swapped

#### translate_pdf Flow
1. Bot extracts text from PDF via `pdf-parse` (splits by double newlines into paragraphs)
2. Sends paragraphs to `callTranslation()` for translation
3. Builds a new .docx from translated paragraphs using `jszip` (minimal valid docx XML structure)
4. Hosts the .docx and sends download link
5. **Note:** Output is .docx (not PDF) since PDFs cannot be easily rebuilt

#### translate_pptx Flow
1. Bot opens the .pptx via `jszip`, iterates all `ppt/slides/slide*.xml` files
2. Extracts text from `<a:t>` tags within `<a:p>` paragraphs (skips image paragraphs with `<a:blipFill>`)
3. Sends all paragraph texts to `callTranslation()` for translation
4. Replaces text in the original slide XMLs: first `<a:r>` run gets translated text, subsequent runs cleared
5. Generates new .pptx buffer, hosts it, sends download link
6. **Key:** Slide layout, images, shapes, styles are fully preserved — only text is swapped

#### Dedicated Translation API (`callTranslation()`)
All translation handlers use `callTranslation()` instead of `callOpenClaw()`:
- **Longer timeout:** 180s (3 minutes) per chunk vs 60s default
- **No conversation history:** Sends only the translation prompt with a minimal system message ("You are a professional translator")
- **Chunking:** Large documents split into chunks of 40 paragraphs per API call, results merged
- **Standalone:** Does not pollute conversation history with translation data

#### File Upload Exclusivity
When a new file is uploaded, all previously stored files of other types are cleared from both memory and Redis:
- Upload .docx → clears stored PDFs and PPTXs
- Upload .pdf → clears stored DOCXs and PPTXs
- Upload .pptx → clears stored DOCXs and PDFs
This prevents stale files from being picked up after the user clears chat history.

#### create_file Flow
1. Detects desired format from message (html, csv, json, txt, md, py, js, sql, etc.)
2. Sends message to AI with instructions: "Generate ONLY the raw file content, no explanation"
3. Strips markdown code block wrappers if AI added them
4. Hosts the content as a downloadable file via Express

#### Document Anonymization Flow
1. User uploads a PPTX, DOCX, or PDF and asks to anonymize it
2. Bot extracts text from XML nodes (`<a:t>` for PPTX, `<w:t>` for DOCX) or via pdf-parse
3. Text is run through `pii.anonymize()` (ALE PPI terms + Presidio personal data detection)
4. For PPTX/DOCX: rebuilt with anonymized text preserving layout. For PDF: outputs as anonymized DOCX
5. Custom `replaceTextInXml()` processes regex matches in reverse order for async anonymization

#### chat Flow (default)
- Normal AI call via `callOpenClaw()`, no file logic

### Key Behaviors

#### 1:1 Messages
- On `rainbow_onmessagereceived`, looks up conversation by ID first, then falls back to finding contact by JID and opening a conversation
- Replies via `sdk.s2s.sendMessageInConversation(conversation.dbId, ...)` or falls back to `sdk.im.sendMessageToConversation()`

#### Bubble (Group) Messages
- **Detection:** Uses `is_group` flag from raw S2S callback (stored in `rawCallbackMap` keyed by message ID). The SDK's `fromBubbleJid`/`fromBubbleId` fields are NOT populated in S2S mode.
- **Bot trigger keyword:** `jojo` (also responds to bot's display name, `@ai`, `bot:`, `bot :`)
- **Silent listening:** All bubble messages are stored in conversation history for context, but bot only replies when triggered
- **Active conversation mode:** After bot replies in a bubble, follow-up messages within 5 minutes are evaluated by AI intent to decide if they're directed at the bot (no trigger needed)
- **Reply method (3-tier fallback):**
  1. **S2S REST with raw `conversation_id`:** `POST /connections/{cnxId}/conversations/{rawConvId}/messages` — uses the exact conversation_id from the incoming callback (most reliable)
  2. **SDK `s2s.sendMessageInConversation`** with the conversation's `dbId`
  3. **`sendMessageToBubble()`** — opens a new conversation for the bubble and sends via SDK or REST
- **Startup:** All bubbles are cached, conversations pre-opened (mapping `convId → bubbleJid`), and `setBubblePresence(bubble, true)` is called for each

#### File Download Support (Receiving Files from Users)
- **Detection:** Raw S2S callback middleware detects `msg.attachment` field and stores in `rawCallbackMap` and `recentFilesByConv`
- **Processing:** Files are processed directly from the callback middleware (SDK does NOT fire `rainbow_onmessagereceived` for file messages in S2S mode). Uses `processFileFromCallback()` with a 2s delay and deep-copied message data.
- **Download strategies (4-tier fallback):**
  1. **SDK `fileStorage.downloadFile()`** — returns 1-byte garbage in S2S mode (skipped if buffer < 10 bytes)
  2. **SDK `fileStorage.getFilesTemporaryURL()`** — returns object not string, URL extracted from `.url` property
  3. **SDK internal REST helper** (`sdk._core._rest.get()`) — handles auth natively, **this is what works**
  4. **Direct REST fetch** with Bearer token — fallback, handles JSON metadata redirect
- **Retry:** Up to 3 attempts with 2s/4s delays (file may not be available immediately after upload)
- **File types supported:**
  - **Text files** (.txt, .md, .csv, .json, .xml, .js, .py, etc.): Content included directly in AI context
  - **Word documents** (.docx): Text extracted via `mammoth.extractRawText()`, raw buffer stored for translation. Buffer persisted to Redis (`docx:<filename>` key, base64-encoded, 24h TTL)
  - **PDF** (.pdf): Text extracted via `pdf-parse`, raw buffer stored for translation. Buffer persisted to Redis (`pdf:<filename>` key, base64-encoded, 24h TTL)
  - **PowerPoint** (.pptx): Text extracted from slide XMLs via `jszip`, raw buffer stored for translation. Buffer persisted to Redis (`pptx:<filename>` key, base64-encoded, 24h TTL)
  - **Images** (.png, .jpg, etc.): Metadata stored (AI can't see images via text API)
- **Behavior:** On file receipt, bot downloads and stores content in conversation history, sends confirmation message ("Got it — filename received and ready"). AI is NOT called until user explicitly asks about the file.
- **Deduplication:** `processedFileIds` set prevents double-processing if both callback and SDK event fire

#### File Creation & Hosting (Sending Files to Users)
- **Self-hosted files:** Express endpoint `GET /files/:id` serves files from in-memory `hostedFiles` Map with Redis fallback
- **Storage:** `hostedFiles` Map (fast in-memory cache) + Redis (`file:<id>` key, 24h TTL) for persistence across redeployments
- **Binary files:** Stored as base64 in Redis, decoded on fetch. `Content-Length` header set explicitly for Railway proxy compatibility.
- **Filename sanitization:** Special characters replaced with underscores in `Content-Disposition` header to prevent HTTP header errors
- **MIME types:** Full map including .docx, .xlsx, .pptx, .ppt, .pdf, .png, .jpg, .zip. Default: `application/octet-stream`
- **TTL:** 24 hours in both memory and Redis
- **URL rewriting:** `rewriteFileUrls()` catches tmpfiles.org/transfer.sh URLs in AI responses, downloads files, re-hosts on bot's server
- **`[FILE:]` markers:** Fallback parser for `[FILE:name]content[/FILE]` patterns in AI responses

#### Document Translation Engine
- **Docx** (`executeTranslateDocument()`): Uses `jszip` to open the original .docx (ZIP of XML). Single-pass regex on `word/document.xml` replaces text in `<w:t>` tags per paragraph. Preserves images (`<w:drawing>`, `<w:pict>`, `<mc:AlternateContent>`), styles, layout, formatting. For each text paragraph, puts translated text in the first `<w:t>`, empties the rest.
- **PDF** (`handlePdfTranslation()`): Extracts text via `pdf-parse`, translates, outputs as a new .docx (since PDFs can't be easily rebuilt). Creates minimal valid docx XML structure with `jszip`.
- **PPTX** (`handlePptxTranslation()`): Opens via `jszip`, processes each `ppt/slides/slide*.xml`. Extracts text from `<a:t>` tags within `<a:p>` paragraphs (skips `<a:blipFill>` image paragraphs). Replaces text in original slide XMLs preserving all layout, images, shapes. First `<a:r>` run gets translated text, subsequent runs cleared.
- **XML escaping:** `&`, `<`, `>` properly escaped in all translated text

#### Common Behaviors
- **Self-message prevention:** Multiple checks — userId, JID, loginEmail, message deduplication via `processedMsgIds` set
- **Conversation history:** Redis-backed with in-memory cache, per user/bubble (max 20 messages), 7-day TTL. Keyed by sender JID (1:1) or `bubble:<conversationId>` (group)
- **Welcome message:** Sent on first contact if `OPENCLAW_WELCOME_MSG` is set
- **Auto-accept:** Contact invitations and bubble invitations are auto-accepted
- **Typing indicator:** Refreshed every 5 seconds during AI processing so it persists when users switch conversations. Cleared after response.
- **Presence:** Set to ONLINE via SDK on ready; REST API fallback using extracted S2S connection ID
- **Room join:** `joinAllRooms()` via REST API on ready (bulk join all rooms)
- **Reconnection:** Auto-restarts on SDK stop/fail (30s delay, max 10 retries then 5-min cooldown)

### PII/PPI Secure Mode (`bot/pii.js`)

Activated by sending `juju secure` in chat, deactivated with `juju unsecure`.

#### Two-layer anonymization:
1. **ALE PPI terms (built-in):** 130+ proprietary product/brand names (OmniSwitch, Rainbow, OpenTouch, etc.) replaced with `[PRODUCT_N]` placeholders. List loaded from `DEFAULT_PPI_TERMS` array, persisted in Redis (`ppi:custom_terms` key). Matched case-insensitively, sorted longest-first to avoid partial matches.
2. **Presidio API (optional):** If `PRESIDIO_URL` env var is set, personal data (names, emails, phones) anonymized via external Presidio service.

#### Flow:
- User message → PPI anonymization → Presidio anonymization → sent to AI
- AI response → Presidio deanonymization → PPI deanonymization → sent to user
- Mappings stored in Redis per conversation (`pii:mapping:<key>`, 7-day TTL)
- Secure mode flag stored in Redis per conversation (`pii:secure:<key>`, 7-day TTL)

### Email Integration (`email-intents.js`, `graph.js`, `gmail-api.js`)

Dual-backend email system supporting both Outlook (Microsoft Graph) and Gmail (Google REST API).

#### Architecture
- **`auth.js`** — M365 OAuth2 (Entra ID), scopes: `Mail.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Sites.Read.All Files.Read.All`
- **`gmail-auth.js`** — Google OAuth2, scopes: `gmail.readonly gmail.send gmail.modify gmail.labels calendar.readonly calendar.events`
- **`graph.js`** — Microsoft Graph API connector (Outlook email operations)
- **`gmail-api.js`** — Gmail REST API connector (same function signatures as graph.js)
- **`email-intents.js`** — Unified intent handler with `resolveProvider(userId)` auto-detecting Gmail vs Outlook

#### Provider Resolution
`resolveProvider(userId)` checks Gmail token first, then M365. Returns `{ provider, token, email, api }` where `api` is either `graph.js` or `gmail-api.js` module.

#### Account Linking
- `jojo connect gmail` / `jojo connect outlook` — sends OAuth URL to user
- `jojo disconnect gmail` / `jojo disconnect outlook` — removes tokens from Redis
- OAuth routes: `/auth/gmail/start`, `/auth/gmail/callback`, `/auth/microsoft/start`, `/auth/microsoft/callback`
- Tokens stored encrypted in Redis (`gmail:{userId}`, `oauth:{userId}`)

#### Email Capabilities
- Read: unread emails, recent emails, search, sender-specific, email by ID, thread
- Write: send new email, reply, forward (all require explicit user confirmation)
- Manage: mark read/unread, flag/unflag, archive, move to folder, trash
- AI features: smart query (any email-related question answered via AI with inbox context), compose new (AI drafts from instructions), inbox briefing

#### Safety Rules
- Emails are NEVER sent without explicit user confirmation ("yes" to confirm draft)
- Pending drafts stored in Redis with 5-min TTL
- Email context stored for follow-up commands (archive #3, mark #1 as read)

### Calendar Integration (`calendar-intents.js`, `calendar-graph.js`, `calendar-google.js`)

Dual-backend calendar system supporting both Outlook Calendar (Microsoft Graph) and Google Calendar.

#### Architecture
- **`calendar-graph.js`** — Microsoft Graph API: `calendarView`, events CRUD, `getSchedule` for free/busy
- **`calendar-google.js`** — Google Calendar REST API: events list, CRUD, `freeBusy` endpoint
- **`calendar-intents.js`** — Unified intent handler with same `resolveProvider()` pattern

#### Calendar Capabilities
- Read: today's/tomorrow's/week's events, event details, find free slots
- Write: create meeting (AI parses natural language → JSON → confirmation → create), reschedule, cancel
- RSVP: accept/decline meeting invitations
- AI features: smart query, meeting preparation briefing (attendees, objective, related context)

#### Meeting Creation Flow
1. User says "schedule a meeting with john@example.com tomorrow at 2pm about project review"
2. AI parses into structured JSON: `{ subject, date, startTime, endTime, attendees, location, isOnlineMeeting }`
3. Bot shows draft summary, asks for confirmation
4. On "yes": creates event via Graph API or Google Calendar API
5. Pending creations stored in Redis (`cal_pending:{userId}`, 5-min TTL)

#### Free Slots
- Uses `getSchedule` (Graph) or `freeBusy` (Google) API with fallback to gap computation from events
- Business hours filter (8:00–18:00), configurable duration
- Supports today/tomorrow/week range

### Salesforce CRM Integration (`salesforce-intents.js`, `salesforce-api.js`, `salesforce-auth.js`)

Full Salesforce CRM integration for customer context, pipeline management, and executive briefings.

#### Architecture
- **`salesforce-auth.js`** — Salesforce OAuth2 (Connected App), token refresh every 90 minutes
- **`salesforce-api.js`** — Salesforce REST API v59.0 (SOQL queries + SOSL global search)
- **`salesforce-intents.js`** — CRM intent handler

#### Account Linking
- `jojo connect salesforce` / `jojo disconnect salesforce`
- OAuth routes: `/auth/salesforce/start`, `/auth/salesforce/callback`
- Tokens stored encrypted in Redis (`sf:{userId}`)

#### CRM Capabilities
- **Accounts:** Search by name, get details (with contacts + opportunities), recent accounts
- **Contacts:** Search by name/email, list contacts for an account
- **Opportunities:** Open pipeline, account-specific deals, opportunity details (stage, amount, close date, next step)
- **Activity:** Recent tasks and events for an account/contact
- **Global Search:** SOSL cross-object search (accounts + contacts + opportunities)
- **Customer Meeting Briefing:** AI-powered briefing combining account info, key contacts, active opportunities, recent activity, and suggested talking points

#### Customer Briefing Flow (Example: "Prepare briefing for my meeting with SNCF")
1. Search Salesforce for account matching "SNCF"
2. Fetch in parallel: contacts, opportunities, recent activity
3. Send all data to AI (via OpenClaw → Claude) with executive briefing prompt
4. AI generates structured briefing: company overview, key contacts, active deals, recent interactions, talking points, risks

### SharePoint / OneDrive Integration (`sharepoint-intents.js`, `sharepoint-api.js`)

Document discovery, summarization, and content extraction from SharePoint and OneDrive.

#### Architecture
- **`sharepoint-api.js`** — Microsoft Graph API: search (`/search/query`), recent docs, download, content extraction, site discovery
- **`sharepoint-intents.js`** — Document intent handler
- Uses same M365 OAuth token as Outlook (scopes: `Sites.Read.All`, `Files.Read.All`)

#### Capabilities
- **Search:** Cross-tenant document search via Microsoft Graph Search API
- **Recent:** User's recently accessed OneDrive documents
- **Summarize:** Download document → extract text (via existing mammoth/jszip/pdf-parse) → AI summary
- **Download:** Returns browser-openable link (`webUrl`)
- **Sites:** Search/list SharePoint sites and document libraries
- **Content Extraction:** Supports .txt, .csv, .md, .json (direct), .docx (mammoth), .pdf (pdf-parse), .pptx (jszip)

### Cross-System Context Aggregation (`briefing.js`)

Unified executive briefing builder that correlates data across Email, Calendar, Salesforce, and SharePoint.

#### Architecture
`briefing.js` includes all 5 aggregation components from the spec:
- **entityResolver** — resolve identities across systems via `matchPerson(userId, nameOrEmail)`
- **peopleMatcher** — match people across email, calendar, and CRM contacts
- **accountMatcher** — match companies via email domains + Salesforce accounts via `matchAccount(userId, companyName)`
- **topicMatcher** — AI-powered topic identification across all connected services
- **briefingBuilder** — generate unified executive briefings combining all data sources

#### Briefing Types
- **Daily Briefing** (`briefing_daily`) — "Prepare my morning briefing" / "What needs my attention today?"
  - Fetches: unread emails + today's meetings + open pipeline
  - AI generates: schedule, priority emails, action items, pipeline updates, suggested actions
- **Meeting Briefing** (`briefing_meeting`) — "Prepare for my meeting with SNCF"
  - Fetches: calendar events + related emails + Salesforce account + contacts + opportunities
  - AI generates: meeting details, participant context, communication history, business context, preparation suggestions
- **Customer Briefing** (`briefing_customer`) — "Tell me everything about customer SNCF"
  - Fetches: emails + week's meetings + Salesforce deep data (account + contacts + opportunities + activity)
  - AI generates: company overview, key contacts, communication history, upcoming meetings, active deals, suggested actions
- **Weekly Briefing** (`briefing_weekly`) — "Weekly summary"
  - Fetches: unread emails + week's meetings + open pipeline
  - AI generates: week at a glance, priority emails, key meetings, pipeline summary, focus areas
- **Follow-Up Report** (`briefing_followups`) — "Show my pending follow-ups"
  - Fetches: recent emails + CRM activity
  - AI identifies: awaiting reply, action items, pending tasks, overdue items with urgency levels

#### Data Flow
All briefings follow the same pattern:
1. Detect which services are connected for the user
2. Fetch data from all connected services in parallel
3. Combine into a structured AI prompt
4. AI generates concise, executive-friendly output

### Enterprise Deployment Layer (`enterprise.js`)

Scalable user provisioning and access control system for deploying the AI assistant to hundreds or thousands of users.

#### Architecture
- **`enterprise.js`** — User registry, magic-link invitations, Microsoft SSO activation, auto-linking of services, access control, admin portal
- **Backward compatible:** Enterprise mode activates only when `ADMIN_PASSWORD` env var is set. Without it, the bot allows all users (existing behavior).
- **Data storage:** All enterprise data stored in Redis (no additional database required)

#### 3-Layer Deployment Model
1. **Tenant-Level Configuration (Admin Once):** Admin sets up Microsoft 365, Salesforce, and Rainbow connections via the admin portal. These apply to all users.
2. **User Provisioning:** Admin adds users (single or CSV bulk import) through the admin portal. Users start in PENDING status.
3. **User Activation:** User receives magic link via email, authenticates with Microsoft SSO, system auto-links M365 + Salesforce + Rainbow. User becomes ACTIVE.

#### User Lifecycle States
- **PENDING** — Created by admin, awaiting activation
- **ACTIVE** — Activated via SSO, can use the bot
- **INACTIVE** — Deactivated by admin, bot access revoked

#### Magic Link System
- Admin creates invite → system generates secure 32-byte random token
- Token hash stored in Redis (`invite:{hash}`, 48h TTL)
- Activation URL: `{baseUrl}/api/activate?token={unhashed_token}`
- On click: validates token → starts Microsoft SSO → activates user → marks invite used

#### SSO Activation Flow
1. User clicks magic link → validates invite token
2. Redirects to Microsoft SSO with `login_hint` pre-filled to user's email
3. Microsoft callback → exchanges code for tokens (Mail, Calendar, SharePoint scopes)
4. Fetches Microsoft profile → stores encrypted tokens in Redis (same format as `auth.js`)
5. Auto-links Salesforce contact by email (if tenant Salesforce is configured)
6. Updates user status to ACTIVE

#### Access Control
- `checkAccess(jid)` called on every incoming Rainbow message (both 1:1 and bubbles)
- Only ACTIVE users can interact with the bot
- Non-enterprise mode (no `ADMIN_PASSWORD`): all users allowed (backward compatible)

#### Admin Portal
- **URL:** `GET /admin` — self-contained HTML/JS admin interface
- **Auth:** Username/password login → JWT session token (24h expiry)
- **Features:**
  - Dashboard with stats (total users, active, pending, activation rate)
  - Add single user (first name, last name, email) with auto-invite
  - Bulk CSV import
  - User table with status badges, connected services, actions
  - Invite/resend invite, deactivate/reactivate users
  - Tenant configuration page

#### Enterprise API Endpoints
- `POST /api/admin/login` — Admin authentication (returns JWT)
- `GET /api/admin/users` — List all users
- `POST /api/admin/users` — Create user
- `POST /api/admin/users/import` — Bulk CSV import
- `POST /api/admin/users/:id/invite` — Create and send invitation
- `PATCH /api/admin/users/:id` — Update user (status, etc.)
- `DELETE /api/admin/users/:id` — Delete user
- `GET /api/admin/stats` — Analytics dashboard data
- `GET /api/admin/audit` — Audit log entries
- `GET /api/admin/tenant` — Get tenant configuration
- `PUT /api/admin/tenant` — Update tenant configuration
- `GET /api/activate?token=xxx` — Magic link handler (starts SSO)
- `GET /api/activate/callback` — Microsoft SSO callback (completes activation)

#### Invite Email System
- When admin sends invite, system attempts to send email via Microsoft Graph (using admin's M365 token)
- Email includes welcome message, bot capabilities explanation, and magic activation link
- Falls back to URL-only (admin copies and shares manually) if Graph not available

#### Security
- JWT session tokens for admin API (HS256, configurable expiry)
- Invite tokens: 32-byte random, SHA-256 hashed before storage
- OAuth tokens: AES-256-GCM encrypted (same `M365_TOKEN_ENCRYPTION_KEY`)
- Rate limiting on admin endpoints (100 req/min per IP)
- Audit logging of all admin actions (user creates, invites, activations, deletions)

#### Redis Keys
- `user:{id}` — User profile JSON
- `user:email:{email}` — Email → user ID index
- `user:rainbow:{jid}` — Rainbow JID → user ID index
- `tenant:users` — Set of all user IDs
- `tenant:config` — Encrypted tenant configuration
- `invite:{hash}` — Invite record (48h TTL)
- `activate:state:{state}` — SSO activation state (10min TTL)
- `audit:log` — List of audit log entries (last 1000)

### Admin Dashboard & API
- **`GET /`** — HTML dashboard with status, stats, bubble list, recent messages, and Pause/Resume/Restart buttons
- **`GET /api/status`** — JSON status endpoint (includes m365, gmail, calendar, salesforce, sharepoint, briefing, enterprise readiness)
- **`GET /api/intercepted`** — Debug: recent raw S2S message callbacks
- **`GET /api/last-download`** — Debug: last file download result
- **`GET /api/file-info/:id`** — Debug: inspect hosted file metadata (filename, mime, size, isBuffer)
- **`GET /api/file-test/:fileId`** — Debug: test Rainbow file download with a given fileId
- **`POST /admin/pause`** — Pause message processing
- **`POST /admin/resume`** — Resume message processing
- **`POST /admin/restart`** — Full SDK restart (cleanup + fresh start)
- **OAuth routes:**
  - `GET /auth/microsoft/start?uid=...` → `GET /auth/microsoft/callback` (M365 OAuth)
  - `GET /auth/gmail/start?uid=...` → `GET /auth/gmail/callback` (Google OAuth)
  - `GET /auth/salesforce/start?uid=...` → `GET /auth/salesforce/callback` (Salesforce OAuth)

### S2S Internals (extracted from SDK)
- `extractSdkInfo()` pulls `s2sConnectionId`, `authToken`, and `rainbowHost` from SDK internals
- **Connection ID paths tried** (in order): `sdk._core._s2s._connectionId`, `sdk._core.s2s.connectionId`, `sdk.s2s._connectionId`, `sdk.s2s.connectionId`, `sdk._core._rest.connectionS2SInfo.id`
- These are used for direct REST API calls (presence, room join, message send) when SDK methods aren't available

### Raw Callback Middleware
- Express middleware logs all POST callbacks and extracts metadata from raw S2S bodies
- Stores `is_group`, `conversation_id`, `attachment`, and `from_userId` in `rawCallbackMap` keyed by message ID
- Stores file attachments per `conversation_id` in `recentFilesByConv` (so follow-up text messages can reference recently shared files)
- **Directly processes file messages** via `processFileFromCallback()` since SDK doesn't fire events for file messages in S2S mode
- This data is also consumed by `rainbow_onmessagereceived` to reliably detect bubble messages (since the SDK doesn't populate `fromBubbleJid` in S2S mode)

### Persistence (Redis)
- **Conversation history:** Stored per user/bubble with 7-day TTL, in-memory cache for fast access
- **Greeted users:** Set of users who received welcome message, persisted across redeployments
- **Hosted files:** Stored as JSON with base64 content, 24h TTL (`file:<id>` keys)
- **Document buffers:** Raw files stored as base64 for translation, 24h TTL (`docx:<filename>`, `pdf:<filename>`, `pptx:<filename>` keys). Only one file type stored at a time — uploading a new file clears old keys of other types.
- **PPI terms:** ALE proprietary term list (`ppi:custom_terms` key)
- **PII secure mode:** Per-conversation flag and mappings (`pii:secure:<key>`, `pii:mapping:<key>`)
- **M365 OAuth tokens:** `oauth:{userId}` — encrypted, 90-day TTL
- **M365 OAuth state:** `oauth:state:{stateId}` — CSRF protection, 10-min TTL
- **Gmail OAuth tokens:** `gmail:{userId}` — encrypted, 90-day TTL
- **Gmail OAuth state:** `gmail:state:{stateId}` — CSRF protection, 10-min TTL
- **Gmail link pending:** `gmail:linked_pending:{userId}` — post-auth notification, 1h TTL
- **Salesforce OAuth tokens:** `sf:{userId}` — encrypted, 90-day TTL
- **Salesforce OAuth state:** `sf:state:{stateId}` — CSRF protection, 10-min TTL
- **Email context:** `email_ctx:{userId}` — recent emails for follow-up commands, 30-min TTL
- **Pending email drafts:** `email_pending:{userId}` — drafts awaiting confirmation, 5-min TTL
- **Pending calendar actions:** `cal_pending:{userId}` — meeting create/cancel awaiting confirmation, 5-min TTL
- **Enterprise users:** `user:{id}` — user profile JSON (no TTL)
- **Enterprise email index:** `user:email:{email}` — email → user ID mapping
- **Enterprise Rainbow index:** `user:rainbow:{jid}` — Rainbow JID → user ID mapping
- **Enterprise user set:** `tenant:users` — set of all user IDs
- **Enterprise tenant config:** `tenant:config` — encrypted tenant configuration
- **Enterprise invites:** `invite:{hash}` — invite record, 48h TTL
- **Enterprise SSO state:** `activate:state:{state}` — activation SSO state, 10-min TTL
- **Enterprise audit log:** `audit:log` — list of last 1000 audit entries
- **Connection:** Via `REDIS_URL` env var (Railway Redis service)

## Issues Resolved During Development

1. **OpenClaw gateway 502:** Gateway bound to loopback. Fixed with `--bind lan` in Dockerfile CMD.
2. **Control UI origin error:** Fixed with `dangerouslyAllowHostHeaderOriginFallback: true` in openclaw.json.
3. **Railway Start Command corrupts long strings:** Fixed by using custom Dockerfile instead of Start Command.
4. **Config key camelCase:** `controlUi` not `control_ui`.
5. **Token env var not interpolated:** Hardcoded token in openclaw.json (env vars don't interpolate in JSON).
6. **Node 24 incompatible with rainbow-node-sdk:** Fixed by using Node 22 Docker image.
7. **Rainbow 401 auth:** App ID rejected by sandbox — user's app was registered on official (openrainbow.com), not sandbox. Fixed `RAINBOW_HOST=official`.
8. **XMPP mode socket closes:** SDK 2.42.0-lts.1 doesn't support XMPP mode well. Switched to S2S.
9. **S2S NoopExpress:** Bot connected but never received messages. Fixed by using real Express server with public callback URL.
10. **Bot and gateway sharing URL:** Bot needs its own Railway service and public domain for S2S callbacks.
11. **Root directory misconfigured:** Both services initially had wrong root directories on Railway. Gateway needs `/`, bot needs `bot`.
12. **Empty conversationId in S2S:** `message.conversationId` is empty in S2S mode. Fixed by falling back to contact JID lookup via `sdk.contacts.getContactByJid()` + `sdk.conversations.openConversationForContact()`.
13. **Message loop (infinite spam):** Bot received its own replies in S2S mode, causing infinite message loop. Fixed with JID-based self-detection + email-based detection + message ID deduplication.
14. **SDK restart loop:** `start()` created new SDK instances without cleanup, accumulating duplicate event handlers. Fixed with `removeAllListeners()` + `sdk.stop()` + max 10 retries with 5-min cooldown.
15. **Bubble messages — wrong reply target:** SDK doesn't populate `fromBubbleJid`/`fromBubbleId` in S2S mode. The S2S workaround (detecting bubbles by sender membership) picked the wrong bubble. Fixed by using `is_group` flag from raw S2S callbacks and replying via the message's own `conversation_id` through S2S REST API.
16. **Bubble messages — "Only occupants allowed":** Bot tried to reply via `openConversationForBubble()` which created a different conversation than the incoming one. Fixed by using the raw `conversation_id` directly for the reply: `POST /connections/{cnxId}/conversations/{rawConvId}/messages`.
17. **File download — SDK returns 1 byte:** `sdk.fileStorage.downloadFile()` returns a 1-byte garbage buffer in S2S mode. Fixed by validating buffer size (must be > 10 bytes and at least 50% of expected size) and falling through to next strategy.
18. **File download — SDK event not fired:** `rainbow_onmessagereceived` does NOT fire for file messages in S2S mode. Fixed by processing files directly from the raw callback middleware via `processFileFromCallback()`.
19. **File download — temp URL returns object:** `getFilesTemporaryURL()` returns an object, not a string. Fixed by extracting `.url` property.
20. **File download — REST 404 with /download suffix:** Rainbow fileserver API does not use `/download` suffix. Removed it; file URL serves content directly with proper auth.
21. **File download — working strategy:** SDK's internal REST helper (`sdk._core._rest.get()`) handles authentication natively and successfully downloads files.
22. **File download — stale msg reference:** `setTimeout` in middleware fired 2s later when Express had already recycled `req.body`. Fixed by deep-copying `msg` before the timeout.
23. **Hosted files lost on redeploy:** `hostedFiles` was in-memory only. Fixed by persisting to Redis with 24h TTL. `/files/:id` handler falls back to Redis when memory cache misses.
24. **File URL with trailing markdown `**`:** Bot formatted links as `📎 **filename**: url`, causing `**` to bleed into clickable URLs. Fixed by putting filename and URL on separate lines. Also strips trailing markdown chars from file IDs in the route handler.
25. **AI ignores tools:** OpenClaw gateway doesn't reliably pass `tools`/`tool_choice` to Claude. AI ignored `create_file` and `translate_document` tools. Fixed by removing tool calling entirely and switching to **intent-driven architecture** where the bot detects intent and handles all file creation deterministically.
26. **Translation loses images:** Original approach used `mammoth.convertToHtml()` which embedded images as base64, making the AI payload huge and slow. New approach: `jszip` opens the raw .docx XML, replaces only `<w:t>` text content, skips paragraphs containing `<w:drawing>`/`<w:pict>` elements. Images/styles/layout fully preserved.
27. **Translation timeout:** Base64 images in AI payload caused timeouts. Fixed by extracting text only (lightweight) and hosting images separately.
28. **File download ERR_INVALID_RESPONSE:** Missing `Content-Length` header caused Railway's proxy to hang. Also `.docx` MIME type was missing from the map (defaulted to `text/plain`). Fixed by adding `Content-Length`, proper MIME map, and using `res.end(buf)`.
29. **File download Content-Disposition crash:** Filenames with special characters (apostrophes, quotes) caused `Invalid character in header content` error. Fixed by sanitizing filenames to alphanumeric + dots + hyphens only.
30. **Typing indicator disappears:** Rainbow clears the typing indicator when users switch conversations. Fixed by refreshing the `isTyping` state every 5 seconds during AI processing.
31. **Translation falls through to chat:** After redeploy, `storedDocxFiles` Map was empty. `detectIntent` couldn't find a stored docx, so the translation request fell through to regular chat and the AI responded with nonsense. Fixed by always matching `translate_docx` intent when translation is detected, scanning Redis for any stored docx, and returning user-friendly error messages instead of `null` (which caused fallthrough).
32. **PDF not supported for translation:** PDF files were received but not stored or extractable. Fixed by adding `pdf-parse` dependency, storing PDF buffers in memory + Redis, and creating `handlePdfTranslation()` which extracts text and outputs a translated .docx.
33. **PPTX not supported for translation:** PowerPoint files had no translation support. Fixed by adding `handlePptxTranslation()` which uses `jszip` to open .pptx, extract text from `<a:t>` tags across all slides, translate, and replace text while preserving slide layout/images/shapes.
34. **Stale files picked up after history clear:** User cleared chat history but old docx was still in `storedDocxFiles` Map, so `detectIntent` returned the old file instead of the newly uploaded one. Fixed by clearing all stored files of other types when a new file is uploaded (both memory Maps and Redis keys).
35. **Translation timeout on large documents:** `callOpenClaw()` had a 60s timeout and sent full conversation history with the translation prompt, causing timeouts on large PDFs/PPTXs. Fixed by creating `callTranslation()` with 180s timeout, no conversation history, minimal system prompt, and chunking (40 paragraphs per API call).
36. **Modules not loading on Railway:** Dockerfile only copied `bot.js` and `pii.js`. New modules (`gmail-auth.js`, `gmail-api.js`, etc.) were missing in container. Fixed by changing Dockerfile COPY to `COPY *.js ./`.
37. **Google OAuth `redirect_uri_mismatch`:** Redirect URI in Google Console didn't match `GMAIL_REDIRECT_URI` env var. Fixed by aligning both to `https://bot-production-4410.up.railway.app/auth/gmail/callback`.
38. **Email intent detection too narrow:** Natural language email queries ("is there any email for flight registration") fell through to regular chat. Fixed by adding sender-before-email patterns, smart catch-all `email_smart_query` for any message mentioning "email", and restricting sender regex to prevent false matches.
39. **Email address truncated in regex:** Period in `.com` matched the regex terminator. Fixed by adding priority regex for full email addresses and replacing `.` terminator with `(?:\s+and\s)` lookahead.
40. **Calendar "No meetings found" on scope error:** After adding calendar scopes to `gmail-auth.js`, existing Gmail tokens didn't have calendar permissions. The Google Calendar API returned 403 but the handler treated it as "no meetings." Fixed by adding `calendarErrorMessage()` that detects 401/403 and guides the user to re-link their account. Also improved `handleMeetingDetails` to check tomorrow when today is empty and to distinguish API errors from empty results.

## Important: OAuth Scope Expansion

When new API scopes are added to `auth.js` or `gmail-auth.js`, **existing user tokens do NOT automatically gain the new permissions**. Users must re-link their accounts to authorize the expanded scopes:

- `jojo disconnect gmail` → `jojo connect gmail` (for Google Calendar scopes added in Phase 1)
- `jojo disconnect outlook` → `jojo connect outlook` (for Calendar + SharePoint scopes)

The bot now detects 401/403 errors from calendar/SharePoint APIs and displays a message guiding users to re-link.

## Railway Deployment

- **GitHub repo:** `moussazaghdoud/openclaw` (branch: `master`)
- **Project:** openclaw on Railway
- Both services auto-deploy on push to `master`
- Each service has its own root directory, Dockerfile, env vars, and public domain
- **Redis:** Railway Redis service connected to bot service via `REDIS_URL`

## Related Projects

- **ConnectPlus** (`C:\Users\zaghdoud\connectplus`): Separate Next.js project with telephony S2S worker. Has Prisma models for OpenClaw (OpenClawConfig, OpenClawConversation, OpenClawMessageLog) but these are NOT used by this standalone bot.
- **aleweb** (`C:\Users\zaghdoud\aleweb`): Has a Rainbow S2S worker (`scripts/rainbow-s2s-worker.js`) that served as reference for the S2S pattern (Express, presence via REST, room join).
