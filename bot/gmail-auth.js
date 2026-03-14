/**
 * Google Gmail OAuth2 Manager
 *
 * Handles OAuth2 authorization code flow with Google.
 * Stores encrypted tokens in Redis, auto-refreshes expired access tokens.
 *
 * Uses Node 22 built-in crypto and fetch — no extra dependencies.
 */

const crypto = require("crypto");
const LOG = "[Gmail-Auth]";

// ── Configuration ────────────────────────────────────────

const GMAIL_CLIENT_ID = process.env.GMAIL_CLIENT_ID || "";
const GMAIL_CLIENT_SECRET = process.env.GMAIL_CLIENT_SECRET || "";
const GMAIL_REDIRECT_URI = process.env.GMAIL_REDIRECT_URI || "";
const ENCRYPTION_KEY_HEX = process.env.M365_TOKEN_ENCRYPTION_KEY || ""; // reuse same encryption key

const SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
  "https://www.googleapis.com/auth/gmail.labels",
  "https://www.googleapis.com/auth/userinfo.email",
  "https://www.googleapis.com/auth/userinfo.profile",
  "https://www.googleapis.com/auth/calendar.readonly",
  "https://www.googleapis.com/auth/calendar.events",
].join(" ");

const AUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const TOKEN_TTL = 90 * 24 * 3600; // 90 days

let redisClient = null;
let encryptionKey = null;

// ── Init ─────────────────────────────────────────────────

function init(redis) {
  redisClient = redis;
  if (ENCRYPTION_KEY_HEX && ENCRYPTION_KEY_HEX.length >= 64) {
    encryptionKey = Buffer.from(ENCRYPTION_KEY_HEX, "hex");
    console.log(`${LOG} Token encryption key loaded (${encryptionKey.length} bytes)`);
  } else {
    console.warn(`${LOG} Encryption key not set — tokens will NOT be encrypted!`);
    encryptionKey = null;
  }
}

function isConfigured() {
  return !!(GMAIL_CLIENT_ID && GMAIL_CLIENT_SECRET && GMAIL_REDIRECT_URI);
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

// ── OAuth2 Flow ──────────────────────────────────────────

/**
 * Generate Google login URL for a user.
 * Stores state in Redis (10-min TTL) to prevent CSRF.
 */
async function getAuthUrl(rainbowUserId, conversationContext) {
  const state = crypto.randomBytes(16).toString("hex");

  if (redisClient) {
    await redisClient.set(`gmail:state:${state}`, JSON.stringify({
      rainbowUserId,
      conversationContext,
      createdAt: Date.now(),
    }), { EX: 600 });
  }

  const params = new URLSearchParams({
    client_id: GMAIL_CLIENT_ID,
    response_type: "code",
    redirect_uri: GMAIL_REDIRECT_URI,
    scope: SCOPES,
    state,
    access_type: "offline",
    prompt: "consent",
  });

  return `${AUTH_BASE}?${params.toString()}`;
}

/**
 * Handle OAuth callback — exchange code for tokens.
 * Returns { success, rainbowUserId, email, error }
 */
async function handleCallback(code, state) {
  if (!redisClient) return { success: false, error: "Redis not available" };

  const stateData = await redisClient.get(`gmail:state:${state}`);
  if (!stateData) return { success: false, error: "Invalid or expired state" };
  await redisClient.del(`gmail:state:${state}`);

  const { rainbowUserId, conversationContext } = JSON.parse(stateData);

  try {
    const tokenResp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GMAIL_CLIENT_ID,
        client_secret: GMAIL_CLIENT_SECRET,
        code,
        redirect_uri: GMAIL_REDIRECT_URI,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenResp.ok) {
      const errBody = await tokenResp.text();
      console.error(`${LOG} Token exchange failed (${tokenResp.status}):`, errBody.substring(0, 300));
      return { success: false, error: "Token exchange failed" };
    }

    const tokens = await tokenResp.json();

    // Get user profile
    let email = "unknown";
    try {
      const profileResp = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (profileResp.ok) {
        const profile = await profileResp.json();
        email = profile.email || "unknown";
      }
    } catch (e) {
      console.warn(`${LOG} Could not fetch user profile:`, e.message);
    }

    await storeTokens(rainbowUserId, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + (tokens.expires_in * 1000),
      scope: tokens.scope,
      email,
    });

    console.log(`${LOG} Account linked: ${rainbowUserId} → ${email}`);
    return { success: true, rainbowUserId, email, conversationContext };
  } catch (err) {
    console.error(`${LOG} OAuth callback error:`, err.message);
    return { success: false, error: err.message };
  }
}

// ── Token Storage ────────────────────────────────────────

async function storeTokens(rainbowUserId, tokenData) {
  if (!redisClient) return;
  const encrypted = encrypt(JSON.stringify(tokenData));
  await redisClient.set(`gmail:${rainbowUserId}`, encrypted, { EX: TOKEN_TTL });
}

async function getStoredTokens(rainbowUserId) {
  if (!redisClient) return null;
  const raw = await redisClient.get(`gmail:${rainbowUserId}`);
  if (!raw) return null;
  try {
    return JSON.parse(decrypt(raw));
  } catch (e) {
    console.error(`${LOG} Failed to decrypt tokens for ${rainbowUserId}:`, e.message);
    return null;
  }
}

/**
 * Get a valid access token for a user (auto-refreshes if expired).
 * Returns { token, email } or null if not linked.
 */
async function getValidToken(rainbowUserId) {
  const stored = await getStoredTokens(rainbowUserId);
  if (!stored) return null;

  // Token still valid (with 5-min buffer)
  if (Date.now() < stored.expiresAt - 300000) {
    return { token: stored.accessToken, email: stored.email };
  }

  // Need to refresh
  if (!stored.refreshToken) {
    console.warn(`${LOG} No refresh token for ${rainbowUserId} — re-auth needed`);
    await unlinkAccount(rainbowUserId);
    return null;
  }

  console.log(`${LOG} Refreshing access token for ${rainbowUserId}`);
  try {
    const resp = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: GMAIL_CLIENT_ID,
        client_secret: GMAIL_CLIENT_SECRET,
        refresh_token: stored.refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`${LOG} Token refresh failed (${resp.status}):`, errText.substring(0, 200));
      await unlinkAccount(rainbowUserId);
      return null;
    }

    const newTokens = await resp.json();
    const updated = {
      accessToken: newTokens.access_token,
      refreshToken: newTokens.refresh_token || stored.refreshToken,
      expiresAt: Date.now() + (newTokens.expires_in * 1000),
      scope: newTokens.scope || stored.scope,
      email: stored.email,
    };
    await storeTokens(rainbowUserId, updated);
    console.log(`${LOG} Token refreshed for ${rainbowUserId}`);
    return { token: updated.accessToken, email: updated.email };
  } catch (err) {
    console.error(`${LOG} Token refresh error:`, err.message);
    return null;
  }
}

/**
 * Check if a user has linked their Gmail account.
 */
async function isLinked(rainbowUserId) {
  if (!redisClient) return false;
  const exists = await redisClient.exists(`gmail:${rainbowUserId}`);
  return exists === 1;
}

/**
 * Get linked email address for a user.
 */
async function getLinkedEmail(rainbowUserId) {
  const stored = await getStoredTokens(rainbowUserId);
  return stored?.email || null;
}

/**
 * Remove Gmail account link and delete all tokens.
 */
async function unlinkAccount(rainbowUserId) {
  if (redisClient) {
    await redisClient.del(`gmail:${rainbowUserId}`);
  }
  console.log(`${LOG} Account unlinked: ${rainbowUserId}`);
}

// ── Express Routes ───────────────────────────────────────

function registerRoutes(app, onLinkComplete) {
  app.get("/auth/gmail/start", async (req, res) => {
    const uid = req.query.uid;
    if (!uid) return res.status(400).send("Missing uid parameter");

    if (!isConfigured()) {
      return res.status(503).send("Gmail integration is not configured.");
    }

    try {
      const authUrl = await getAuthUrl(uid, { fromQuery: true });
      res.redirect(authUrl);
    } catch (err) {
      console.error(`${LOG} Auth start error:`, err.message);
      res.status(500).send("Failed to start authentication.");
    }
  });

  app.get("/auth/gmail/callback", async (req, res) => {
    const { code, state, error, error_description } = req.query;

    if (error) {
      console.error(`${LOG} OAuth error: ${error} — ${error_description}`);
      return res.status(400).send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:60px">
          <h2>Authentication Failed</h2>
          <p>${error_description || error}</p>
          <p>You can close this window and try again in Rainbow.</p>
        </body></html>
      `);
    }

    if (!code || !state) {
      return res.status(400).send("Missing code or state parameter.");
    }

    const result = await handleCallback(code, state);

    if (result.success) {
      if (onLinkComplete) onLinkComplete(result);

      res.send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:60px">
          <h2>Gmail Connected!</h2>
          <p>Your Google account (${result.email}) is now linked.</p>
          <p>You can close this window and return to Rainbow.</p>
        </body></html>
      `);
    } else {
      res.status(400).send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:60px">
          <h2>Connection Failed</h2>
          <p>${result.error}</p>
          <p>You can close this window and try again in Rainbow.</p>
        </body></html>
      `);
    }
  });

  console.log(`${LOG} OAuth routes registered (/auth/gmail/start, /auth/gmail/callback)`);
}

module.exports = {
  init,
  isConfigured,
  registerRoutes,
  getAuthUrl,
  handleCallback,
  getValidToken,
  isLinked,
  getLinkedEmail,
  unlinkAccount,
};
