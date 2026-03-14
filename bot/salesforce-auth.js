/**
 * Salesforce OAuth2 Manager
 *
 * Handles OAuth2 authorization code flow with Salesforce.
 * Stores encrypted tokens in Redis, auto-refreshes expired access tokens.
 *
 * Uses Node 22 built-in crypto and fetch — no extra dependencies.
 */

const crypto = require("crypto");
const LOG = "[Salesforce-Auth]";

// ── Configuration ────────────────────────────────────────

const SF_CLIENT_ID = process.env.SALESFORCE_CLIENT_ID || "";
const SF_CLIENT_SECRET = process.env.SALESFORCE_CLIENT_SECRET || "";
const SF_REDIRECT_URI = process.env.SALESFORCE_REDIRECT_URI || "";
const SF_LOGIN_URL = process.env.SALESFORCE_LOGIN_URL || "https://login.salesforce.com";
const ENCRYPTION_KEY_HEX = process.env.M365_TOKEN_ENCRYPTION_KEY || ""; // reuse same key

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
  return !!(SF_CLIENT_ID && SF_CLIENT_SECRET && SF_REDIRECT_URI);
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
 * Generate Salesforce login URL for a user.
 */
async function getAuthUrl(rainbowUserId, conversationContext) {
  const state = crypto.randomBytes(16).toString("hex");

  if (redisClient) {
    await redisClient.set(`sf:state:${state}`, JSON.stringify({
      rainbowUserId,
      conversationContext,
      createdAt: Date.now(),
    }), { EX: 600 });
  }

  const params = new URLSearchParams({
    response_type: "code",
    client_id: SF_CLIENT_ID,
    redirect_uri: SF_REDIRECT_URI,
    state,
    prompt: "consent",
  });

  return `${SF_LOGIN_URL}/services/oauth2/authorize?${params.toString()}`;
}

/**
 * Handle OAuth callback — exchange code for tokens.
 */
async function handleCallback(code, state) {
  if (!redisClient) return { success: false, error: "Redis not available" };

  const stateData = await redisClient.get(`sf:state:${state}`);
  if (!stateData) return { success: false, error: "Invalid or expired state" };
  await redisClient.del(`sf:state:${state}`);

  const { rainbowUserId, conversationContext } = JSON.parse(stateData);

  try {
    const tokenResp = await fetch(`${SF_LOGIN_URL}/services/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: SF_CLIENT_ID,
        client_secret: SF_CLIENT_SECRET,
        code,
        redirect_uri: SF_REDIRECT_URI,
      }),
    });

    if (!tokenResp.ok) {
      const errBody = await tokenResp.text();
      console.error(`${LOG} Token exchange failed (${tokenResp.status}):`, errBody.substring(0, 300));
      return { success: false, error: "Token exchange failed" };
    }

    const tokens = await tokenResp.json();

    // Salesforce returns instance_url + access_token + refresh_token + id (user info URL)
    let email = "unknown";
    let userName = "unknown";
    try {
      const idResp = await fetch(tokens.id, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });
      if (idResp.ok) {
        const profile = await idResp.json();
        email = profile.email || "unknown";
        userName = profile.display_name || profile.username || "unknown";
      }
    } catch (e) {
      console.warn(`${LOG} Could not fetch user profile:`, e.message);
    }

    await storeTokens(rainbowUserId, {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      instanceUrl: tokens.instance_url,
      issuedAt: parseInt(tokens.issued_at, 10) || Date.now(),
      email,
      userName,
    });

    console.log(`${LOG} Account linked: ${rainbowUserId} → ${email} (${tokens.instance_url})`);
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
  await redisClient.set(`sf:${rainbowUserId}`, encrypted, { EX: TOKEN_TTL });
}

async function getStoredTokens(rainbowUserId) {
  if (!redisClient) return null;
  const raw = await redisClient.get(`sf:${rainbowUserId}`);
  if (!raw) return null;
  try {
    return JSON.parse(decrypt(raw));
  } catch (e) {
    console.error(`${LOG} Failed to decrypt tokens for ${rainbowUserId}:`, e.message);
    return null;
  }
}

/**
 * Get a valid access token for a user (auto-refreshes if needed).
 * Returns { token, instanceUrl, email } or null if not linked.
 *
 * Salesforce access tokens don't have explicit expiry — they fail with 401.
 * We refresh proactively every 90 minutes.
 */
async function getValidToken(rainbowUserId) {
  const stored = await getStoredTokens(rainbowUserId);
  if (!stored) return null;

  // Salesforce tokens typically last ~2 hours; refresh if older than 90 min
  const age = Date.now() - (stored.issuedAt || 0);
  if (age < 90 * 60 * 1000) {
    return { token: stored.accessToken, instanceUrl: stored.instanceUrl, email: stored.email };
  }

  // Refresh
  if (!stored.refreshToken) {
    console.warn(`${LOG} No refresh token for ${rainbowUserId} — re-auth needed`);
    await unlinkAccount(rainbowUserId);
    return null;
  }

  console.log(`${LOG} Refreshing access token for ${rainbowUserId}`);
  try {
    const resp = await fetch(`${SF_LOGIN_URL}/services/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: SF_CLIENT_ID,
        client_secret: SF_CLIENT_SECRET,
        refresh_token: stored.refreshToken,
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
      refreshToken: stored.refreshToken, // refresh token doesn't change on refresh
      instanceUrl: newTokens.instance_url || stored.instanceUrl,
      issuedAt: parseInt(newTokens.issued_at, 10) || Date.now(),
      email: stored.email,
      userName: stored.userName,
    };
    await storeTokens(rainbowUserId, updated);
    console.log(`${LOG} Token refreshed for ${rainbowUserId}`);
    return { token: updated.accessToken, instanceUrl: updated.instanceUrl, email: updated.email };
  } catch (err) {
    console.error(`${LOG} Token refresh error:`, err.message);
    return null;
  }
}

async function isLinked(rainbowUserId) {
  if (!redisClient) return false;
  const exists = await redisClient.exists(`sf:${rainbowUserId}`);
  return exists === 1;
}

async function getLinkedEmail(rainbowUserId) {
  const stored = await getStoredTokens(rainbowUserId);
  return stored?.email || null;
}

async function unlinkAccount(rainbowUserId) {
  if (redisClient) {
    await redisClient.del(`sf:${rainbowUserId}`);
  }
  console.log(`${LOG} Account unlinked: ${rainbowUserId}`);
}

// ── Express Routes ───────────────────────────────────────

function registerRoutes(app, onLinkComplete) {
  app.get("/auth/salesforce/start", async (req, res) => {
    const uid = req.query.uid;
    if (!uid) return res.status(400).send("Missing uid parameter");

    if (!isConfigured()) {
      return res.status(503).send("Salesforce integration is not configured.");
    }

    try {
      const authUrl = await getAuthUrl(uid, { fromQuery: true });
      res.redirect(authUrl);
    } catch (err) {
      console.error(`${LOG} Auth start error:`, err.message);
      res.status(500).send("Failed to start authentication.");
    }
  });

  app.get("/auth/salesforce/callback", async (req, res) => {
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
          <h2>Salesforce Connected!</h2>
          <p>Your Salesforce account (${result.email}) is now linked.</p>
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

  console.log(`${LOG} OAuth routes registered (/auth/salesforce/start, /auth/salesforce/callback)`);
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
