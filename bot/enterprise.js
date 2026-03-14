/**
 * Enterprise Deployment Layer — User Registry & Tenant Management
 *
 * Manages user provisioning, magic-link invitations, Microsoft SSO activation,
 * auto-linking of Outlook/Calendar/Salesforce/Rainbow, and access control.
 *
 * All data stored in Redis (no additional database required).
 */

const crypto = require("crypto");
const LOG = "[Enterprise]";

let redisClient = null;
let m365AuthModule = null;
let sfAuthModule = null;
let encryptionKey = null;

const ENCRYPTION_KEY_HEX = process.env.M365_TOKEN_ENCRYPTION_KEY || "";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
const INVITE_EXPIRY_HOURS = 48;
const SESSION_EXPIRY_HOURS = 24;

// ── Init ─────────────────────────────────────────────────

function init(redis, deps = {}) {
  redisClient = redis;
  m365AuthModule = deps.m365Auth || null;
  sfAuthModule = deps.sfAuth || null;

  if (ENCRYPTION_KEY_HEX && ENCRYPTION_KEY_HEX.length >= 64) {
    encryptionKey = Buffer.from(ENCRYPTION_KEY_HEX, "hex");
  }
  console.log(`${LOG} Initialized (admin: ${ADMIN_USERNAME})`);
}

// ── Encryption ───────────────────────────────────────────

function encrypt(text) {
  if (!encryptionKey) return text;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${tag}:${encrypted}`;
}

function decrypt(data) {
  if (!encryptionKey) return data;
  const parts = data.split(":");
  if (parts.length !== 3) return data;
  const [ivHex, tagHex, encrypted] = parts;
  const iv = Buffer.from(ivHex, "hex");
  const tag = Buffer.from(tagHex, "hex");
  const decipher = crypto.createDecipheriv("aes-256-gcm", encryptionKey, iv);
  decipher.setAuthTag(tag);
  let decrypted = decipher.update(encrypted, "hex", "utf8");
  decrypted += decipher.final("utf8");
  return decrypted;
}

// ── JWT ──────────────────────────────────────────────────

function createJwt(payload, expiresInHours = SESSION_EXPIRY_HOURS) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({
    ...payload,
    iat: now,
    exp: now + expiresInHours * 3600,
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", JWT_SECRET)
    .update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

function verifyJwt(token) {
  try {
    const [header, body, signature] = token.split(".");
    const expectedSig = crypto.createHmac("sha256", JWT_SECRET)
      .update(`${header}.${body}`).digest("base64url");
    if (signature !== expectedSig) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── Admin Auth ───────────────────────────────────────────

function adminLogin(username, password) {
  if (!ADMIN_PASSWORD) return null; // Enterprise not configured
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    return createJwt({ role: "admin", username });
  }
  return null;
}

function verifyAdmin(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const payload = verifyJwt(auth.substring(7));
  if (!payload || payload.role !== "admin") return null;
  return payload;
}

// ── User Management ─────────────────────────────────────

async function createUser({ firstName, lastName, email }) {
  if (!redisClient) return null;

  const normalizedEmail = email.toLowerCase().trim();

  // Check if user already exists
  const existingId = await redisClient.get(`user:email:${normalizedEmail}`);
  if (existingId) {
    const existing = await getUser(existingId);
    return { user: existing, isNew: false };
  }

  const id = crypto.randomUUID();
  const user = {
    id,
    firstName: firstName.trim(),
    lastName: lastName.trim(),
    email: normalizedEmail,
    status: "PENDING",
    createdAt: new Date().toISOString(),
    activatedAt: null,
    microsoftId: null,
    salesforceId: null,
    rainbowId: null,
    rainbowJid: null,
    preferences: {},
  };

  await redisClient.set(`user:${id}`, JSON.stringify(user));
  await redisClient.set(`user:email:${normalizedEmail}`, id);
  await redisClient.sAdd("tenant:users", id);

  await auditLog("user_created", { userId: id, email: normalizedEmail });
  console.log(`${LOG} User created: ${normalizedEmail} (${id})`);

  return { user, isNew: true };
}

async function getUser(userId) {
  if (!redisClient) return null;
  const raw = await redisClient.get(`user:${userId}`);
  if (!raw) return null;
  return JSON.parse(raw);
}

async function getUserByEmail(email) {
  if (!redisClient) return null;
  const userId = await redisClient.get(`user:email:${email.toLowerCase().trim()}`);
  if (!userId) return null;
  return getUser(userId);
}

async function getUserByRainbowJid(jid) {
  if (!redisClient) return null;
  const userId = await redisClient.get(`user:rainbow:${jid}`);
  if (!userId) return null;
  return getUser(userId);
}

async function updateUser(userId, updates) {
  if (!redisClient) return null;
  const user = await getUser(userId);
  if (!user) return null;

  Object.assign(user, updates);
  await redisClient.set(`user:${userId}`, JSON.stringify(user));

  // Update indexes if JID changed
  if (updates.rainbowJid) {
    await redisClient.set(`user:rainbow:${updates.rainbowJid}`, userId);
  }

  return user;
}

async function setUserStatus(userId, status) {
  return updateUser(userId, { status });
}

async function deleteUser(userId) {
  if (!redisClient) return false;
  const user = await getUser(userId);
  if (!user) return false;

  await redisClient.del(`user:${userId}`);
  await redisClient.del(`user:email:${user.email}`);
  if (user.rainbowJid) await redisClient.del(`user:rainbow:${user.rainbowJid}`);
  await redisClient.sRem("tenant:users", userId);

  await auditLog("user_deleted", { userId, email: user.email });
  return true;
}

async function listUsers() {
  if (!redisClient) return [];
  const userIds = await redisClient.sMembers("tenant:users");
  const users = [];
  for (const id of userIds) {
    const user = await getUser(id);
    if (user) users.push(user);
  }
  return users.sort((a, b) => (a.lastName || "").localeCompare(b.lastName || ""));
}

async function importUsersFromCsv(csvText) {
  const lines = csvText.split("\n").map(l => l.trim()).filter(l => l && !l.startsWith("#"));
  if (lines.length === 0) return { created: 0, skipped: 0, errors: [] };

  // Detect if first line is header
  const firstLine = lines[0].toLowerCase();
  const hasHeader = firstLine.includes("email") || firstLine.includes("first") || firstLine.includes("last");
  const dataLines = hasHeader ? lines.slice(1) : lines;

  let created = 0, skipped = 0;
  const errors = [];

  for (const line of dataLines) {
    const parts = line.split(",").map(p => p.trim().replace(/^"|"$/g, ""));
    if (parts.length < 3) {
      errors.push(`Invalid line: ${line.substring(0, 50)}`);
      continue;
    }

    const [firstName, lastName, email] = parts;
    if (!email || !email.includes("@")) {
      errors.push(`Invalid email: ${email}`);
      continue;
    }

    try {
      const result = await createUser({ firstName, lastName, email });
      if (result.isNew) created++;
      else skipped++;
    } catch (e) {
      errors.push(`Error for ${email}: ${e.message}`);
    }
  }

  await auditLog("bulk_import", { created, skipped, errors: errors.length });
  return { created, skipped, errors };
}

// ── Invite / Magic Link ─────────────────────────────────

async function createInvite(userId) {
  if (!redisClient) return null;
  const user = await getUser(userId);
  if (!user) return null;

  const token = crypto.randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

  const invite = {
    userId,
    email: user.email,
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + INVITE_EXPIRY_HOURS * 3600000).toISOString(),
    used: false,
  };

  await redisClient.set(`invite:${tokenHash}`, JSON.stringify(invite), {
    EX: INVITE_EXPIRY_HOURS * 3600,
  });

  await auditLog("invite_created", { userId, email: user.email });
  return token; // Return unhashed token for the URL
}

async function validateInvite(token) {
  if (!redisClient) return null;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const raw = await redisClient.get(`invite:${tokenHash}`);
  if (!raw) return null;

  const invite = JSON.parse(raw);
  if (invite.used) return null;
  if (new Date(invite.expiresAt) < new Date()) return null;

  return invite;
}

async function markInviteUsed(token) {
  if (!redisClient) return;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const raw = await redisClient.get(`invite:${tokenHash}`);
  if (!raw) return;

  const invite = JSON.parse(raw);
  invite.used = true;
  await redisClient.set(`invite:${tokenHash}`, JSON.stringify(invite), { EX: 3600 }); // Keep 1h for audit
}

// ── SSO Activation Flow ─────────────────────────────────

/**
 * Generate Microsoft SSO URL for user activation.
 * Uses the existing M365 OAuth flow with additional state.
 */
async function getActivationSsoUrl(inviteToken, baseUrl) {
  const invite = await validateInvite(inviteToken);
  if (!invite) return null;

  // Store activation state
  const state = crypto.randomBytes(16).toString("hex");
  await redisClient.set(`activate:state:${state}`, JSON.stringify({
    inviteToken,
    userId: invite.userId,
    email: invite.email,
  }), { EX: 600 });

  const M365_CLIENT_ID = process.env.M365_CLIENT_ID || "";
  const M365_TENANT_ID = process.env.M365_TENANT_ID || "common";
  const redirectUri = `${baseUrl}/api/activate/callback`;

  const scopes = "openid profile email offline_access Mail.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Sites.Read.All Files.Read.All";

  const params = new URLSearchParams({
    client_id: M365_CLIENT_ID,
    response_type: "code",
    redirect_uri: redirectUri,
    scope: scopes,
    state,
    response_mode: "query",
    prompt: "consent",
    login_hint: invite.email, // Pre-fill email
  });

  return `https://login.microsoftonline.com/${M365_TENANT_ID}/oauth2/v2.0/authorize?${params.toString()}`;
}

/**
 * Handle SSO callback after user authenticates.
 * Links Microsoft identity, auto-links Salesforce, looks up Rainbow user.
 */
async function handleActivationCallback(code, state, baseUrl) {
  if (!redisClient) return { success: false, error: "Redis not available" };

  // Validate state
  const stateData = await redisClient.get(`activate:state:${state}`);
  if (!stateData) return { success: false, error: "Invalid or expired state" };
  await redisClient.del(`activate:state:${state}`);

  const { inviteToken, userId, email } = JSON.parse(stateData);

  // Exchange code for tokens (reuse auth.js pattern)
  const M365_CLIENT_ID = process.env.M365_CLIENT_ID || "";
  const M365_CLIENT_SECRET = process.env.M365_CLIENT_SECRET || "";
  const M365_TENANT_ID = process.env.M365_TENANT_ID || "common";
  const redirectUri = `${baseUrl}/api/activate/callback`;

  try {
    const tokenResp = await fetch(`https://login.microsoftonline.com/${M365_TENANT_ID}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: M365_CLIENT_ID,
        client_secret: M365_CLIENT_SECRET,
        code,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
        scope: "openid profile email offline_access Mail.Read Mail.ReadWrite Mail.Send Calendars.ReadWrite Sites.Read.All Files.Read.All",
      }),
    });

    if (!tokenResp.ok) {
      const errBody = await tokenResp.text();
      console.error(`${LOG} Activation token exchange failed:`, errBody.substring(0, 300));
      return { success: false, error: "Authentication failed" };
    }

    const tokens = await tokenResp.json();

    // Get Microsoft profile
    let msProfile = {};
    try {
      const profileResp = await fetch("https://graph.microsoft.com/v1.0/me", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (profileResp.ok) msProfile = await profileResp.json();
    } catch (e) {
      console.warn(`${LOG} Could not fetch MS profile:`, e.message);
    }

    const msEmail = msProfile.mail || msProfile.userPrincipalName || email;
    const microsoftId = msProfile.id || null;

    // Store M365 tokens (same format as auth.js)
    if (m365AuthModule) {
      // Store tokens in the existing auth.js format so email/calendar handlers work
      const user = await getUser(userId);
      if (user && user.rainbowJid) {
        const tokenData = {
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: Date.now() + (tokens.expires_in * 1000),
          scope: tokens.scope,
          email: msEmail,
        };
        const encrypted = encrypt(JSON.stringify(tokenData));
        await redisClient.set(`oauth:${user.rainbowJid}`, encrypted, { EX: 90 * 24 * 3600 });
      }
    }

    // Auto-link Salesforce (search by email)
    let salesforceId = null;
    if (sfAuthModule && sfAuthModule.isConfigured()) {
      try {
        // Use tenant-level Salesforce token to search for contact
        const tenantConfig = await getTenantConfig();
        if (tenantConfig && tenantConfig.sfAdminToken) {
          const sfResp = await fetch(`${tenantConfig.sfInstanceUrl}/services/data/v59.0/query/?q=${encodeURIComponent(`SELECT Id FROM Contact WHERE Email = '${msEmail}'`)}`, {
            headers: { Authorization: `Bearer ${tenantConfig.sfAdminToken}` },
          });
          if (sfResp.ok) {
            const sfData = await sfResp.json();
            if (sfData.records && sfData.records.length > 0) {
              salesforceId = sfData.records[0].Id;
              console.log(`${LOG} Salesforce contact found for ${msEmail}: ${salesforceId}`);
            }
          }
        }
      } catch (e) {
        console.warn(`${LOG} Salesforce auto-link failed:`, e.message);
      }
    }

    // Update user profile
    await updateUser(userId, {
      status: "ACTIVE",
      activatedAt: new Date().toISOString(),
      microsoftId,
      salesforceId,
      microsoftEmail: msEmail,
    });

    // Mark invite as used
    await markInviteUsed(inviteToken);

    await auditLog("user_activated", { userId, email: msEmail, microsoftId, salesforceId });
    console.log(`${LOG} User activated: ${msEmail} (${userId})`);

    return { success: true, userId, email: msEmail };
  } catch (err) {
    console.error(`${LOG} Activation error:`, err.message);
    return { success: false, error: err.message };
  }
}

// ── Rainbow User Lookup ─────────────────────────────────

/**
 * Link a Rainbow JID to a user by matching email.
 * Called when bot receives a message from an unknown JID.
 */
async function linkRainbowUser(jid, rainbowEmail) {
  if (!redisClient) return null;

  // Try to find user by email
  const user = await getUserByEmail(rainbowEmail);
  if (!user) return null;

  await updateUser(user.id, { rainbowJid: jid, rainbowId: jid });
  console.log(`${LOG} Rainbow linked: ${rainbowEmail} → ${jid}`);
  return user;
}

// ── Access Control ──────────────────────────────────────

/**
 * Check if a Rainbow JID is authorized to use the bot.
 * Returns the user object if authorized, null if not.
 *
 * If enterprise mode is not configured (no ADMIN_PASSWORD), allows all users.
 */
async function checkAccess(jid) {
  // If enterprise mode is not configured, allow everyone (backward compatible)
  if (!ADMIN_PASSWORD || !redisClient) return { allowed: true, user: null };

  const user = await getUserByRainbowJid(jid);
  if (!user) return { allowed: false, user: null };
  if (user.status !== "ACTIVE") return { allowed: false, user };

  return { allowed: true, user };
}

/**
 * Check if enterprise access control is enabled.
 */
function isEnterpriseMode() {
  return !!(ADMIN_PASSWORD && redisClient);
}

// ── Tenant Config ───────────────────────────────────────

async function getTenantConfig() {
  if (!redisClient) return null;
  const raw = await redisClient.get("tenant:config");
  if (!raw) return null;
  try {
    return JSON.parse(decrypt(raw));
  } catch {
    return JSON.parse(raw);
  }
}

async function setTenantConfig(config) {
  if (!redisClient) return;
  await redisClient.set("tenant:config", encrypt(JSON.stringify(config)));
  await auditLog("tenant_config_updated", {});
}

// ── Analytics ───────────────────────────────────────────

async function getStats() {
  if (!redisClient) return {};

  const userIds = await redisClient.sMembers("tenant:users");
  const users = [];
  for (const id of userIds) {
    const user = await getUser(id);
    if (user) users.push(user);
  }

  const total = users.length;
  const active = users.filter(u => u.status === "ACTIVE").length;
  const pending = users.filter(u => u.status === "PENDING").length;
  const inactive = users.filter(u => u.status === "INACTIVE").length;
  const activationRate = total > 0 ? Math.round((active / total) * 100) : 0;

  // Recent activations (last 7 days)
  const weekAgo = new Date(Date.now() - 7 * 24 * 3600000).toISOString();
  const recentActivations = users.filter(u => u.activatedAt && u.activatedAt > weekAgo).length;

  return {
    total,
    active,
    pending,
    inactive,
    activationRate,
    recentActivations,
  };
}

// ── Audit Log ───────────────────────────────────────────

async function auditLog(action, details) {
  if (!redisClient) return;
  const entry = {
    action,
    details,
    timestamp: new Date().toISOString(),
  };
  await redisClient.lPush("audit:log", JSON.stringify(entry));
  await redisClient.lTrim("audit:log", 0, 999); // Keep last 1000 entries
}

async function getAuditLog(limit = 50) {
  if (!redisClient) return [];
  const entries = await redisClient.lRange("audit:log", 0, limit - 1);
  return entries.map(e => JSON.parse(e));
}

// ── Express Routes ──────────────────────────────────────

function registerRoutes(app, deps = {}) {
  const baseUrl = process.env.RAINBOW_HOST_CALLBACK || `http://localhost:${process.env.PORT || 3000}`;

  // Rate limiting (simple in-memory)
  const rateLimiter = new Map();
  const rateLimit = (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress;
    const now = Date.now();
    const window = rateLimiter.get(ip) || { count: 0, resetAt: now + 60000 };
    if (now > window.resetAt) { window.count = 0; window.resetAt = now + 60000; }
    window.count++;
    rateLimiter.set(ip, window);
    if (window.count > 100) return res.status(429).json({ error: "Rate limit exceeded" });
    next();
  };

  // Admin auth middleware
  const requireAdmin = (req, res, next) => {
    const admin = verifyAdmin(req);
    if (!admin) return res.status(401).json({ error: "Unauthorized" });
    req.admin = admin;
    next();
  };

  // ── Admin Auth ──
  app.post("/api/admin/login", rateLimit, (req, res) => {
    const { username, password } = req.body || {};
    const token = adminLogin(username, password);
    if (!token) return res.status(401).json({ error: "Invalid credentials" });
    res.json({ token });
  });

  // ── User Management ──
  app.get("/api/admin/users", requireAdmin, async (req, res) => {
    const users = await listUsers();
    res.json({ users });
  });

  app.post("/api/admin/users", requireAdmin, async (req, res) => {
    const { firstName, lastName, email } = req.body || {};
    if (!firstName || !lastName || !email) {
      return res.status(400).json({ error: "firstName, lastName, and email are required" });
    }
    const result = await createUser({ firstName, lastName, email });
    res.json(result);
  });

  app.post("/api/admin/users/import", requireAdmin, async (req, res) => {
    const { csv } = req.body || {};
    if (!csv) return res.status(400).json({ error: "csv field is required" });
    const result = await importUsersFromCsv(csv);
    res.json(result);
  });

  app.post("/api/admin/users/:id/invite", requireAdmin, async (req, res) => {
    const token = await createInvite(req.params.id);
    if (!token) return res.status(404).json({ error: "User not found" });
    const activateUrl = `${baseUrl}/api/activate?token=${token}`;

    // Optionally send email (if M365 admin token available)
    const user = await getUser(req.params.id);
    let emailSent = false;
    if (user && deps.sendInviteEmail) {
      emailSent = await deps.sendInviteEmail(user, activateUrl);
    }

    res.json({ inviteUrl: activateUrl, emailSent });
  });

  app.patch("/api/admin/users/:id", requireAdmin, async (req, res) => {
    const { status } = req.body || {};
    if (status && ["ACTIVE", "INACTIVE", "PENDING"].includes(status)) {
      const user = await setUserStatus(req.params.id, status);
      if (!user) return res.status(404).json({ error: "User not found" });
      await auditLog("user_status_changed", { userId: req.params.id, status });
      return res.json({ user });
    }
    const user = await updateUser(req.params.id, req.body);
    if (!user) return res.status(404).json({ error: "User not found" });
    res.json({ user });
  });

  app.delete("/api/admin/users/:id", requireAdmin, async (req, res) => {
    const deleted = await deleteUser(req.params.id);
    if (!deleted) return res.status(404).json({ error: "User not found" });
    res.json({ success: true });
  });

  // ── Stats ──
  app.get("/api/admin/stats", requireAdmin, async (req, res) => {
    const stats = await getStats();
    res.json(stats);
  });

  // ── Audit Log ──
  app.get("/api/admin/audit", requireAdmin, async (req, res) => {
    const limit = parseInt(req.query.limit || "50", 10);
    const entries = await getAuditLog(limit);
    res.json({ entries });
  });

  // ── Tenant Config ──
  app.get("/api/admin/tenant", requireAdmin, async (req, res) => {
    const config = await getTenantConfig();
    res.json({ config: config || {} });
  });

  app.put("/api/admin/tenant", requireAdmin, async (req, res) => {
    await setTenantConfig(req.body);
    res.json({ success: true });
  });

  // ── Magic Link Activation ──
  app.get("/api/activate", async (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).send(activationPage("Invalid Link", "No activation token provided."));

    const invite = await validateInvite(token);
    if (!invite) return res.status(400).send(activationPage("Link Expired", "This activation link has expired or was already used. Please contact your administrator."));

    // Start Microsoft SSO
    const ssoUrl = await getActivationSsoUrl(token, baseUrl);
    if (!ssoUrl) return res.status(500).send(activationPage("Error", "Could not start authentication. Please try again."));

    res.redirect(ssoUrl);
  });

  app.get("/api/activate/callback", async (req, res) => {
    const { code, state, error, error_description } = req.query;

    if (error) {
      return res.status(400).send(activationPage("Authentication Failed", error_description || error));
    }

    if (!code || !state) {
      return res.status(400).send(activationPage("Error", "Missing authentication data."));
    }

    const result = await handleActivationCallback(code, state, baseUrl);

    if (result.success) {
      res.send(activationPage("You're All Set!", `
        <p>Your AI assistant is now active.</p>
        <p>Account: <strong>${result.email}</strong></p>
        <p>Open <strong>Rainbow</strong> and start chatting with the bot!</p>
        <p style="margin-top:30px;color:#666">You can close this window.</p>
      `, true));
    } else {
      res.status(400).send(activationPage("Activation Failed", result.error));
    }
  });

  // ── Admin Portal (Static HTML) ──
  app.get("/admin", (req, res) => {
    res.send(adminPortalHtml(baseUrl));
  });

  console.log(`${LOG} Routes registered (/api/admin/*, /api/activate, /admin)`);
}

// ── HTML Templates ──────────────────────────────────────

function activationPage(title, body, isSuccess = false) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title}</title>
<style>
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; display:flex; justify-content:center; align-items:center; min-height:100vh; margin:0; background:#f5f5f5; }
  .card { background:white; border-radius:12px; padding:40px 50px; max-width:500px; text-align:center; box-shadow:0 2px 20px rgba(0,0,0,0.1); }
  h2 { color:${isSuccess ? "#22c55e" : "#ef4444"}; margin-bottom:20px; }
  p { color:#555; line-height:1.6; }
</style></head>
<body><div class="card"><h2>${title}</h2>${typeof body === "string" && body.startsWith("<") ? body : `<p>${body}</p>`}</div></body></html>`;
}

function adminPortalHtml(baseUrl) {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AI Assistant — Admin Portal</title>
<style>
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; background:#f0f2f5; color:#333; }
  .header { background:#1a1a2e; color:white; padding:20px 30px; display:flex; justify-content:space-between; align-items:center; }
  .header h1 { font-size:20px; font-weight:600; }
  .container { max-width:1200px; margin:20px auto; padding:0 20px; }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:16px; margin-bottom:24px; }
  .stat-card { background:white; border-radius:8px; padding:20px; box-shadow:0 1px 3px rgba(0,0,0,0.1); }
  .stat-card .value { font-size:32px; font-weight:700; color:#1a1a2e; }
  .stat-card .label { font-size:14px; color:#666; margin-top:4px; }
  .card { background:white; border-radius:8px; padding:24px; box-shadow:0 1px 3px rgba(0,0,0,0.1); margin-bottom:20px; }
  .card h3 { margin-bottom:16px; font-size:16px; }
  table { width:100%; border-collapse:collapse; }
  th,td { text-align:left; padding:10px 12px; border-bottom:1px solid #eee; font-size:14px; }
  th { font-weight:600; color:#666; font-size:12px; text-transform:uppercase; }
  .badge { display:inline-block; padding:2px 10px; border-radius:12px; font-size:12px; font-weight:600; }
  .badge.active { background:#dcfce7; color:#166534; }
  .badge.pending { background:#fef3c7; color:#92400e; }
  .badge.inactive { background:#fee2e2; color:#991b1b; }
  input,button { padding:8px 16px; border-radius:6px; font-size:14px; border:1px solid #ddd; }
  button { background:#1a1a2e; color:white; border:none; cursor:pointer; font-weight:500; }
  button:hover { background:#2a2a4e; }
  button.secondary { background:#f3f4f6; color:#333; border:1px solid #ddd; }
  button.danger { background:#ef4444; }
  .form-row { display:flex; gap:10px; margin-bottom:12px; flex-wrap:wrap; }
  .form-row input { flex:1; min-width:150px; }
  #loginForm { max-width:400px; margin:100px auto; }
  .hidden { display:none; }
  .actions { display:flex; gap:8px; }
  #notification { position:fixed; top:20px; right:20px; padding:12px 24px; border-radius:8px; color:white; font-weight:500; z-index:1000; display:none; }
</style></head>
<body>
<div id="notification"></div>
<div id="loginSection">
  <div id="loginForm" class="card">
    <h3>Admin Login</h3>
    <div class="form-row"><input type="text" id="loginUser" placeholder="Username"></div>
    <div class="form-row"><input type="password" id="loginPass" placeholder="Password"></div>
    <button onclick="login()">Sign In</button>
  </div>
</div>

<div id="mainSection" class="hidden">
  <div class="header">
    <h1>AI Assistant — Admin Portal</h1>
    <button class="secondary" onclick="logout()">Logout</button>
  </div>
  <div class="container">
    <div class="stats" id="statsGrid"></div>

    <div class="card">
      <h3>Add User</h3>
      <div class="form-row">
        <input type="text" id="addFirst" placeholder="First name">
        <input type="text" id="addLast" placeholder="Last name">
        <input type="email" id="addEmail" placeholder="Work email">
        <button onclick="addUser()">Add & Invite</button>
      </div>
    </div>

    <div class="card">
      <h3>Bulk Import</h3>
      <div class="form-row">
        <input type="file" id="csvFile" accept=".csv">
        <button onclick="importCsv()">Import CSV</button>
      </div>
      <p style="font-size:12px;color:#888;margin-top:8px">CSV format: firstName, lastName, email (one per line)</p>
    </div>

    <div class="card">
      <h3>Users</h3>
      <table>
        <thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Activated</th><th>Services</th><th>Actions</th></tr></thead>
        <tbody id="usersTable"></tbody>
      </table>
    </div>
  </div>
</div>

<script>
let token = localStorage.getItem('admin_token');
const API = '';

function notify(msg, isError) {
  const el = document.getElementById('notification');
  el.textContent = msg;
  el.style.background = isError ? '#ef4444' : '#22c55e';
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 3000);
}

async function api(path, opts = {}) {
  const resp = await fetch(API + path, {
    ...opts,
    headers: { 'Content-Type':'application/json', 'Authorization':'Bearer '+token, ...(opts.headers||{}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (resp.status === 401) { logout(); return null; }
  return resp.json();
}

async function login() {
  const username = document.getElementById('loginUser').value;
  const password = document.getElementById('loginPass').value;
  const resp = await fetch(API+'/api/admin/login', {
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({username,password})
  });
  const data = await resp.json();
  if (data.token) { token = data.token; localStorage.setItem('admin_token',token); showMain(); }
  else notify('Invalid credentials', true);
}

function logout() { token=null; localStorage.removeItem('admin_token'); location.reload(); }

async function showMain() {
  document.getElementById('loginSection').classList.add('hidden');
  document.getElementById('mainSection').classList.remove('hidden');
  await Promise.all([loadStats(), loadUsers()]);
}

async function loadStats() {
  const data = await api('/api/admin/stats');
  if (!data) return;
  document.getElementById('statsGrid').innerHTML = [
    {v:data.total,l:'Total Users'}, {v:data.active,l:'Active'}, {v:data.pending,l:'Pending'},
    {v:data.activationRate+'%',l:'Activation Rate'}, {v:data.recentActivations,l:'This Week'}
  ].map(s => '<div class="stat-card"><div class="value">'+s.v+'</div><div class="label">'+s.l+'</div></div>').join('');
}

async function loadUsers() {
  const data = await api('/api/admin/users');
  if (!data) return;
  const tbody = document.getElementById('usersTable');
  tbody.innerHTML = data.users.map(u => {
    const services = [u.microsoftId?'M365':'', u.salesforceId?'SF':'', u.rainbowJid?'Rainbow':''].filter(Boolean).join(', ') || '-';
    const badge = '<span class="badge '+u.status.toLowerCase()+'">'+u.status+'</span>';
    return '<tr><td>'+u.firstName+' '+u.lastName+'</td><td>'+u.email+'</td><td>'+badge+'</td><td>'+(u.activatedAt?new Date(u.activatedAt).toLocaleDateString():'-')+'</td><td>'+services+'</td><td class="actions"><button class="secondary" onclick="invite(\\''+u.id+'\\')">Invite</button>'+(u.status==='ACTIVE'?'<button class="secondary" onclick="deactivate(\\''+u.id+'\\')">Deactivate</button>':'')+'</td></tr>';
  }).join('');
}

async function addUser() {
  const firstName = document.getElementById('addFirst').value;
  const lastName = document.getElementById('addLast').value;
  const email = document.getElementById('addEmail').value;
  if (!firstName||!lastName||!email) return notify('All fields required',true);
  const result = await api('/api/admin/users', {method:'POST', body:{firstName,lastName,email}});
  if (result && result.user) {
    notify(result.isNew ? 'User created' : 'User already exists');
    await invite(result.user.id);
    document.getElementById('addFirst').value='';
    document.getElementById('addLast').value='';
    document.getElementById('addEmail').value='';
    await loadUsers(); await loadStats();
  }
}

async function invite(userId) {
  const result = await api('/api/admin/users/'+userId+'/invite', {method:'POST'});
  if (result && result.inviteUrl) {
    notify('Invite created'+(result.emailSent?' & email sent':''));
    await navigator.clipboard.writeText(result.inviteUrl).catch(()=>{});
  }
}

async function deactivate(userId) {
  if (!confirm('Deactivate this user?')) return;
  await api('/api/admin/users/'+userId, {method:'PATCH', body:{status:'INACTIVE'}});
  notify('User deactivated'); await loadUsers(); await loadStats();
}

async function importCsv() {
  const file = document.getElementById('csvFile').files[0];
  if (!file) return notify('Select a CSV file',true);
  const text = await file.text();
  const result = await api('/api/admin/users/import', {method:'POST', body:{csv:text}});
  if (result) {
    notify('Imported: '+result.created+' created, '+result.skipped+' skipped');
    await loadUsers(); await loadStats();
  }
}

if (token) showMain();
</script>
</body></html>`;
}

module.exports = {
  init,
  registerRoutes,
  // User management
  createUser,
  getUser,
  getUserByEmail,
  getUserByRainbowJid,
  updateUser,
  setUserStatus,
  deleteUser,
  listUsers,
  importUsersFromCsv,
  // Invites
  createInvite,
  validateInvite,
  // Activation
  getActivationSsoUrl,
  handleActivationCallback,
  // Rainbow
  linkRainbowUser,
  // Access control
  checkAccess,
  isEnterpriseMode,
  // Tenant
  getTenantConfig,
  setTenantConfig,
  // Analytics
  getStats,
  getAuditLog,
  // Auth
  adminLogin,
  verifyAdmin,
};
