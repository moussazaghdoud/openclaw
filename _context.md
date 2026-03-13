# OpenClaw Project — Context

## Overview

OpenClaw is a standalone project (NOT part of ConnectPlus) that provides an AI chatbot on Rainbow (ALE's UCaaS platform) powered by Claude Opus via the OpenClaw AI gateway.

**Flow:** Rainbow user sends IM → Rainbow bot receives it → bot calls OpenClaw gateway API → OpenClaw forwards to Claude Opus → AI response → bot sends reply back to Rainbow user.

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

## File Structure

```
openclaw/
├── Dockerfile              # OpenClaw gateway Docker image
├── openclaw.json           # Gateway config (auth token, controlUi, chatCompletions)
├── _context.md             # This file
└── bot/
    ├── Dockerfile          # Bot Docker image (node:22-slim)
    ├── bot.js              # Main bot code
    ├── pii.js              # PII/PPI anonymization module (secure mode)
    ├── package.json        # Dependencies: dotenv, express, rainbow-node-sdk, redis, mammoth, jszip, pdf-parse
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
- **`create_file`** — User wants a file created (e.g. "create a report", "generate a CSV")
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

### Admin Dashboard & API
- **`GET /`** — HTML dashboard with status, stats, bubble list, recent messages, and Pause/Resume/Restart buttons
- **`GET /api/status`** — JSON status endpoint (programmatic access)
- **`GET /api/intercepted`** — Debug: recent raw S2S message callbacks
- **`GET /api/last-download`** — Debug: last file download result
- **`GET /api/file-info/:id`** — Debug: inspect hosted file metadata (filename, mime, size, isBuffer)
- **`GET /api/file-test/:fileId`** — Debug: test Rainbow file download with a given fileId
- **`POST /admin/pause`** — Pause message processing
- **`POST /admin/resume`** — Resume message processing
- **`POST /admin/restart`** — Full SDK restart (cleanup + fresh start)

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

## Railway Deployment

- **GitHub repo:** `moussazaghdoud/openclaw` (branch: `master`)
- **Project:** openclaw on Railway
- Both services auto-deploy on push to `master`
- Each service has its own root directory, Dockerfile, env vars, and public domain
- **Redis:** Railway Redis service connected to bot service via `REDIS_URL`

## Related Projects

- **ConnectPlus** (`C:\Users\zaghdoud\connectplus`): Separate Next.js project with telephony S2S worker. Has Prisma models for OpenClaw (OpenClawConfig, OpenClawConversation, OpenClawMessageLog) but these are NOT used by this standalone bot.
- **aleweb** (`C:\Users\zaghdoud\aleweb`): Has a Rainbow S2S worker (`scripts/rainbow-s2s-worker.js`) that served as reference for the S2S pattern (Express, presence via REST, room join).
