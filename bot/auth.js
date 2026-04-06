/**
 * Microsoft 365 OAuth2 Manager
 *
 * Handles OAuth2 authorization code flow with Microsoft Entra ID.
 * Stores encrypted tokens in Redis, auto-refreshes expired access tokens.
 *
 * Uses Node 22 built-in crypto and fetch — no extra dependencies.
 */

const crypto = require("crypto");
const LOG = "[M365-Auth]";

// ── Configuration ────────────────────────────────────────

const M365_CLIENT_ID = process.env.M365_CLIENT_ID || "";
const M365_CLIENT_SECRET = process.env.M365_CLIENT_SECRET || "";
const M365_TENANT_ID = process.env.M365_TENANT_ID || "common";
const M365_REDIRECT_URI = process.env.M365_REDIRECT_URI || "";
const ENCRYPTION_KEY_HEX = process.env.M365_TOKEN_ENCRYPTION_KEY || "";

const SCOPES = "openid profile email offline_access Mail.Read Calendars.Read User.Read";
const AUTH_BASE = `https://login.microsoftonline.com/${M365_TENANT_ID}/oauth2/v2.0`;
const TOKEN_TTL = 90 * 24 * 3600; // 90 days (refresh tokens last longer, but we'll refresh)

let redisClient = null;
let encryptionKey = null;

// ── Init ─────────────────────────────────────────────────

function init(redis) {
  redisClient = redis;
  if (ENCRYPTION_KEY_HEX && ENCRYPTION_KEY_HEX.length >= 64) {
    encryptionKey = Buffer.from(ENCRYPTION_KEY_HEX, "hex");
    console.log(`${LOG} Token encryption key loaded (${encryptionKey.length} bytes)`);
  } else {
    console.warn(`${LOG} M365_TOKEN_ENCRYPTION_KEY not set or too short — tokens will NOT be encrypted!`);
    encryptionKey = null;
  }
}

function isConfigured() {
  return !!(M365_CLIENT_ID && M365_CLIENT_SECRET && M365_REDIRECT_URI);
}

// ── Encryption ───────────────────────────────────────────

function encrypt(text) {
  if (!encryptionKey) return text; // fallback: store plaintext
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey, iv);
  let encrypted = cipher.update(text, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");
  return `${iv.toString("hex")}:${tag}:${encrypted}`;
}

function decrypt(data) {
  if (!encryptionKey) return data; // fallback: stored plaintext
  const parts = data.split(":");
  if (parts.length !== 3) return data; // not encrypted
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
 * Generate Microsoft login URL for a user.
 * Stores state in Redis (10-min TTL) to prevent CSRF.
 */
async function getAuthUrl(rainbowUserId, conversationContext) {
  const state = crypto.randomBytes(16).toString("hex");

  // Store state → userId mapping (10 min TTL)
  if (redisClient) {
    await redisClient.set(`oauth:state:${state}`, JSON.stringify({
      rainbowUserId,
      conversationContext, // { conversationId, isBubble, bubbleJid }
      createdAt: Date.now(),
    }), { EX: 600 });
  }

  const params = new URLSearchParams({
    client_id: M365_CLIENT_ID,
    response_type: "code",
    redirect_uri: M365_REDIRECT_URI,
    scope: SCOPES,
    state,
    response_mode: "query",
    prompt: "consent", // always show consent screen
  });

  return `${AUTH_BASE}/authorize?${params.toString()}`;
}

/**
 * Handle OAuth callback — exchange code for tokens.
 * Returns { success, rainbowUserId, email, error }
 */
async function handleCallback(code, state) {
  if (!redisClient) return { success: false, error: "Redis not available" };

  // Validate state
  const stateData = await redisClient.get(`oauth:state:${state}`);
  if (!stateData) return { success: false, error: "Invalid or expired state" };
  await redisClient.del(`oauth:state:${state}`);

  const { rainbowUserId, conversationContext } = JSON.parse(stateData);

  // Exchange code for tokens
  try {
    const tokenResp = await fetch(`${AUTH_BASE}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: M365_CLIENT_ID,
        client_secret: M365_CLIENT_SECRET,
        code,
        redirect_uri: M365_REDIRECT_URI,
        grant_type: "authorization_code",
        scope: SCOPES,
      }),
    });

    if (!tokenResp.ok) {
      const errBody = await tokenResp.text();
      console.error(`${LOG} Token exchange failed (${tokenResp.status}):`, errBody.substring(0, 300));
      return { success: false, error: "Token exchange failed" };
    }

    const tokens = await tokenResp.json();

    // Get user profile to know which email was linked
    let email = "unknown";
    try {
      const profileResp = await fetch("https://graph.microsoft.com/v1.0/me", {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (profileResp.ok) {
        const profile = await profileResp.json();
        email = profile.mail || profile.userPrincipalName || "unknown";
      }
    } catch (e) {
      console.warn(`${LOG} Could not fetch user profile:`, e.message);
    }

    // Store encrypted tokens
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
  await redisClient.set(`oauth:${rainbowUserId}`, encrypted, { EX: TOKEN_TTL });
}

async function getStoredTokens(rainbowUserId) {
  if (!redisClient) return null;
  const raw = await redisClient.get(`oauth:${rainbowUserId}`);
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
    const resp = await fetch(`${AUTH_BASE}/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: M365_CLIENT_ID,
        client_secret: M365_CLIENT_SECRET,
        refresh_token: stored.refreshToken,
        grant_type: "refresh_token",
        scope: SCOPES,
      }),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      console.error(`${LOG} Token refresh failed (${resp.status}):`, errText.substring(0, 200));
      // Refresh token may be revoked — force re-auth
      await unlinkAccount(rainbowUserId);
      return null;
    }

    const newTokens = await resp.json();
    const updated = {
      accessToken: newTokens.access_token,
      refreshToken: newTokens.refresh_token || stored.refreshToken, // keep old if not returned
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
 * Check if a user has linked their Microsoft account.
 */
async function isLinked(rainbowUserId) {
  if (!redisClient) return false;
  const exists = await redisClient.exists(`oauth:${rainbowUserId}`);
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
 * Remove Microsoft account link and delete all tokens.
 */
async function unlinkAccount(rainbowUserId) {
  if (redisClient) {
    await redisClient.del(`oauth:${rainbowUserId}`);
  }
  console.log(`${LOG} Account unlinked: ${rainbowUserId}`);
}

// ── Express Routes ───────────────────────────────────────

/**
 * Register OAuth routes on the Express app.
 * Call this once during initialization.
 */
function registerRoutes(app, onLinkComplete) {
  // Start OAuth flow — user clicks this link from Rainbow
  app.get("/auth/microsoft/start", async (req, res) => {
    const uid = req.query.uid;
    if (!uid) return res.status(400).send("Missing uid parameter");

    if (!isConfigured()) {
      return res.status(503).send("Microsoft 365 integration is not configured.");
    }

    try {
      const authUrl = await getAuthUrl(uid, { fromQuery: true });
      res.redirect(authUrl);
    } catch (err) {
      console.error(`${LOG} Auth start error:`, err.message);
      res.status(500).send("Failed to start authentication.");
    }
  });

  // OAuth callback — Microsoft redirects here after user login
  app.get("/auth/microsoft/callback", async (req, res) => {
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
      // Notify the bot so it can send a confirmation to the user in Rainbow
      if (onLinkComplete) onLinkComplete(result);

      res.send(`
        <html><body style="font-family:sans-serif;text-align:center;padding:60px">
          <h2>Outlook Connected!</h2>
          <p>Your Microsoft account (${result.email}) is now linked.</p>
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

  console.log(`${LOG} OAuth routes registered (/auth/microsoft/start, /auth/microsoft/callback)`);
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
