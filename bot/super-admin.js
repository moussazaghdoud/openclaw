/**
 * Super-Admin Portal — Multi-Tenant Management
 *
 * Manages all tenants: creation, configuration, credentials, status.
 * Self-contained HTML portal with inline CSS+JS (same pattern as enterprise.js).
 *
 * All data stored in Redis via the tenant.js module.
 */

const crypto = require("crypto");
const LOG = "[SuperAdmin]";

let redisClient = null;
let tenantModule = null;

const SUPER_ADMIN_USERNAME = process.env.SUPER_ADMIN_USERNAME || "superadmin";
const SUPER_ADMIN_PASSWORD = process.env.SUPER_ADMIN_PASSWORD || "";
const SUPER_ADMIN_JWT_SECRET = process.env.SUPER_ADMIN_JWT_SECRET || crypto.randomBytes(32).toString("hex");
const SESSION_EXPIRY_HOURS = 8;

// ── JWT ──────────────────────────────────────────────────

function createJwt(payload, expiresInHours = SESSION_EXPIRY_HOURS) {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(JSON.stringify({
    ...payload,
    iat: now,
    exp: now + expiresInHours * 3600,
  })).toString("base64url");
  const signature = crypto.createHmac("sha256", SUPER_ADMIN_JWT_SECRET)
    .update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${signature}`;
}

function verifyJwt(token) {
  try {
    const [header, body, signature] = token.split(".");
    const expectedSig = crypto.createHmac("sha256", SUPER_ADMIN_JWT_SECRET)
      .update(`${header}.${body}`).digest("base64url");
    if (signature !== expectedSig) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString());
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

// ── Auth ─────────────────────────────────────────────────

function superAdminLogin(username, password) {
  if (!SUPER_ADMIN_PASSWORD) return null;
  if (username === SUPER_ADMIN_USERNAME && password === SUPER_ADMIN_PASSWORD) {
    return createJwt({ role: "superadmin", username });
  }
  return null;
}

function verifySuperAdmin(req) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const payload = verifyJwt(auth.substring(7));
  if (!payload || payload.role !== "superadmin") return null;
  return payload;
}

// ── Tenant Helpers (Redis-backed) ────────────────────────

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

async function getAllTenants() {
  if (tenantModule && typeof tenantModule.listTenants === "function") {
    return tenantModule.listTenants();
  }
  // Fallback: direct Redis
  if (!redisClient) return [];
  const ids = await redisClient.sMembers("tenants:all");
  const tenants = [];
  for (const id of ids) {
    const raw = await redisClient.get(`tenant:${id}`);
    if (raw) tenants.push(JSON.parse(raw));
  }
  return tenants.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || ""));
}

async function getTenant(id) {
  if (tenantModule && typeof tenantModule.getTenant === "function") {
    return tenantModule.getTenant(id);
  }
  if (!redisClient) return null;
  const raw = await redisClient.get(`tenant:${id}`);
  return raw ? JSON.parse(raw) : null;
}

async function saveTenant(tenant) {
  if (tenantModule && typeof tenantModule.saveTenant === "function") {
    return tenantModule.saveTenant(tenant);
  }
  if (!redisClient) return;
  await redisClient.set(`tenant:${tenant.id}`, JSON.stringify(tenant));
  await redisClient.sAdd("tenants:all", tenant.id);
}

async function deleteTenantData(id) {
  if (tenantModule && typeof tenantModule.deleteTenant === "function") {
    return tenantModule.deleteTenant(id);
  }
  if (!redisClient) return false;
  await redisClient.del(`tenant:${id}`);
  await redisClient.del(`tenant:${id}:credentials`);
  await redisClient.sRem("tenants:all", id);
  return true;
}

async function getTenantCredentials(tenantId) {
  if (tenantModule && typeof tenantModule.getTenantCredentials === "function") {
    return tenantModule.getTenantCredentials(tenantId);
  }
  if (!redisClient) return {};
  const raw = await redisClient.get(`tenant:${tenantId}:credentials`);
  return raw ? JSON.parse(raw) : {};
}

async function saveTenantCredentials(tenantId, credentials) {
  if (tenantModule && typeof tenantModule.saveTenantCredentials === "function") {
    return tenantModule.saveTenantCredentials(tenantId, credentials);
  }
  if (!redisClient) return;
  await redisClient.set(`tenant:${tenantId}:credentials`, JSON.stringify(credentials));
}

async function getTenantUserCount(tenantId) {
  if (tenantModule && typeof tenantModule.getTenantUserCount === "function") {
    return tenantModule.getTenantUserCount(tenantId);
  }
  if (!redisClient) return 0;
  const count = await redisClient.sCard(`tenant:${tenantId}:users`);
  return count || 0;
}

// ── Init ─────────────────────────────────────────────────

function init(app, deps = {}) {
  redisClient = deps.redis || null;
  tenantModule = deps.tenant || null;

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

  // Super-admin auth middleware
  const requireSuperAdmin = (req, res, next) => {
    const admin = verifySuperAdmin(req);
    if (!admin) return res.status(401).json({ error: "Unauthorized" });
    req.superAdmin = admin;
    next();
  };

  // ── Auth Routes ──

  app.post("/super-admin/api/login", rateLimit, (req, res) => {
    const { username, password } = req.body || {};
    const token = superAdminLogin(username, password);
    if (!token) return res.status(401).json({ error: "Invalid credentials" });
    res.json({ token });
  });

  // ── Dashboard ──

  app.get("/super-admin/api/dashboard", requireSuperAdmin, async (req, res) => {
    try {
      const tenants = await getAllTenants();
      let totalUsers = 0;
      for (const t of tenants) {
        totalUsers += await getTenantUserCount(t.id);
      }
      res.json({
        totalTenants: tenants.length,
        activeTenants: tenants.filter(t => t.status === "ACTIVE").length,
        suspendedTenants: tenants.filter(t => t.status === "SUSPENDED").length,
        provisioningTenants: tenants.filter(t => t.status === "PROVISIONING").length,
        totalUsers,
      });
    } catch (err) {
      console.error(`${LOG} Dashboard error:`, err.message);
      res.status(500).json({ error: "Failed to load dashboard" });
    }
  });

  // ── Tenant CRUD ──

  app.get("/super-admin/api/tenants", requireSuperAdmin, async (req, res) => {
    try {
      const tenants = await getAllTenants();
      const result = [];
      for (const t of tenants) {
        result.push({ ...t, userCount: await getTenantUserCount(t.id) });
      }
      res.json({ tenants: result });
    } catch (err) {
      console.error(`${LOG} List tenants error:`, err.message);
      res.status(500).json({ error: "Failed to list tenants" });
    }
  });

  app.post("/super-admin/api/tenants", requireSuperAdmin, async (req, res) => {
    try {
      const { name, slug, adminEmail, adminName, emailDomains } = req.body || {};
      if (!name || !adminEmail) {
        return res.status(400).json({ error: "name and adminEmail are required" });
      }

      const id = crypto.randomUUID();
      const tenant = {
        id,
        name: name.trim(),
        slug: (slug || slugify(name)).toLowerCase().trim(),
        adminEmail: adminEmail.toLowerCase().trim(),
        adminName: (adminName || "").trim(),
        emailDomains: Array.isArray(emailDomains) ? emailDomains.map(d => d.toLowerCase().trim()) : [],
        status: "PROVISIONING",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      await saveTenant(tenant);
      console.log(`${LOG} Tenant created: ${tenant.name} (${id})`);
      res.json({ tenant });
    } catch (err) {
      console.error(`${LOG} Create tenant error:`, err.message);
      res.status(500).json({ error: "Failed to create tenant" });
    }
  });

  app.get("/super-admin/api/tenants/:id", requireSuperAdmin, async (req, res) => {
    try {
      const tenant = await getTenant(req.params.id);
      if (!tenant) return res.status(404).json({ error: "Tenant not found" });
      const credentials = await getTenantCredentials(req.params.id);
      const userCount = await getTenantUserCount(req.params.id);
      // Mask secrets in credentials
      const maskedCreds = {};
      for (const [provider, creds] of Object.entries(credentials)) {
        maskedCreds[provider] = {};
        for (const [key, val] of Object.entries(creds)) {
          maskedCreds[provider][key] = key.toLowerCase().includes("secret") || key.toLowerCase().includes("password")
            ? (val ? "********" : "")
            : val;
        }
      }
      res.json({ tenant: { ...tenant, userCount }, credentials: maskedCreds });
    } catch (err) {
      console.error(`${LOG} Get tenant error:`, err.message);
      res.status(500).json({ error: "Failed to get tenant" });
    }
  });

  app.put("/super-admin/api/tenants/:id", requireSuperAdmin, async (req, res) => {
    try {
      const tenant = await getTenant(req.params.id);
      if (!tenant) return res.status(404).json({ error: "Tenant not found" });

      const { name, slug, adminEmail, adminName, emailDomains } = req.body || {};
      if (name !== undefined) tenant.name = name.trim();
      if (slug !== undefined) tenant.slug = slug.toLowerCase().trim();
      if (adminEmail !== undefined) tenant.adminEmail = adminEmail.toLowerCase().trim();
      if (adminName !== undefined) tenant.adminName = (adminName || "").trim();
      if (emailDomains !== undefined) tenant.emailDomains = Array.isArray(emailDomains) ? emailDomains.map(d => d.toLowerCase().trim()) : [];
      tenant.updatedAt = new Date().toISOString();

      await saveTenant(tenant);
      console.log(`${LOG} Tenant updated: ${tenant.name} (${tenant.id})`);
      res.json({ tenant });
    } catch (err) {
      console.error(`${LOG} Update tenant error:`, err.message);
      res.status(500).json({ error: "Failed to update tenant" });
    }
  });

  app.delete("/super-admin/api/tenants/:id", requireSuperAdmin, async (req, res) => {
    try {
      const tenant = await getTenant(req.params.id);
      if (!tenant) return res.status(404).json({ error: "Tenant not found" });

      await deleteTenantData(req.params.id);
      console.log(`${LOG} Tenant deleted: ${tenant.name} (${req.params.id})`);
      res.json({ success: true });
    } catch (err) {
      console.error(`${LOG} Delete tenant error:`, err.message);
      res.status(500).json({ error: "Failed to delete tenant" });
    }
  });

  app.patch("/super-admin/api/tenants/:id/status", requireSuperAdmin, async (req, res) => {
    try {
      const tenant = await getTenant(req.params.id);
      if (!tenant) return res.status(404).json({ error: "Tenant not found" });

      const { status } = req.body || {};
      if (!["ACTIVE", "SUSPENDED"].includes(status)) {
        return res.status(400).json({ error: "status must be ACTIVE or SUSPENDED" });
      }

      tenant.status = status;
      tenant.updatedAt = new Date().toISOString();
      await saveTenant(tenant);
      console.log(`${LOG} Tenant status changed: ${tenant.name} → ${status}`);
      res.json({ tenant });
    } catch (err) {
      console.error(`${LOG} Status change error:`, err.message);
      res.status(500).json({ error: "Failed to update status" });
    }
  });

  // ── Credentials ──

  app.put("/super-admin/api/tenants/:id/credentials/:provider", requireSuperAdmin, async (req, res) => {
    try {
      const tenant = await getTenant(req.params.id);
      if (!tenant) return res.status(404).json({ error: "Tenant not found" });

      const provider = req.params.provider.toLowerCase();
      const validProviders = ["salesforce", "m365", "gmail"];
      if (!validProviders.includes(provider)) {
        return res.status(400).json({ error: `Invalid provider. Must be one of: ${validProviders.join(", ")}` });
      }

      const credentials = await getTenantCredentials(req.params.id);
      credentials[provider] = { ...req.body, updatedAt: new Date().toISOString() };
      await saveTenantCredentials(req.params.id, credentials);

      console.log(`${LOG} Credentials set for tenant ${tenant.name}: ${provider}`);
      res.json({ success: true, provider });
    } catch (err) {
      console.error(`${LOG} Set credentials error:`, err.message);
      res.status(500).json({ error: "Failed to set credentials" });
    }
  });

  app.delete("/super-admin/api/tenants/:id/credentials/:provider", requireSuperAdmin, async (req, res) => {
    try {
      const tenant = await getTenant(req.params.id);
      if (!tenant) return res.status(404).json({ error: "Tenant not found" });

      const provider = req.params.provider.toLowerCase();
      const credentials = await getTenantCredentials(req.params.id);
      delete credentials[provider];
      await saveTenantCredentials(req.params.id, credentials);

      console.log(`${LOG} Credentials removed for tenant ${tenant.name}: ${provider}`);
      res.json({ success: true, provider });
    } catch (err) {
      console.error(`${LOG} Remove credentials error:`, err.message);
      res.status(500).json({ error: "Failed to remove credentials" });
    }
  });

  // ── HTML Portal ──

  app.get("/super-admin", (req, res) => {
    res.send(superAdminPortalHtml());
  });

  console.log(`${LOG} Initialized (admin: ${SUPER_ADMIN_USERNAME}, routes: /super-admin/*)`);
}

// ── HTML Portal ──────────────────────────────────────────

function superAdminPortalHtml() {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenClaw — Super Admin</title>
<style>
  * { box-sizing:border-box; margin:0; padding:0; }
  body { font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif; background:#f0f2f5; color:#333; min-height:100vh; }

  /* Header */
  .header { background:#0f172a; color:white; padding:0 24px; display:flex; justify-content:space-between; align-items:center; height:56px; position:sticky; top:0; z-index:100; }
  .header h1 { font-size:18px; font-weight:600; letter-spacing:-0.3px; }
  .header h1 span { color:#3b82f6; }
  .header-right { display:flex; align-items:center; gap:12px; }
  .header-user { font-size:13px; color:#94a3b8; }
  .btn-logout { background:transparent; border:1px solid #334155; color:#94a3b8; padding:6px 14px; border-radius:6px; font-size:13px; cursor:pointer; }
  .btn-logout:hover { border-color:#64748b; color:white; }

  /* Layout */
  .container { max-width:1280px; margin:0 auto; padding:24px; }

  /* Stats */
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:16px; margin-bottom:24px; }
  .stat-card { background:white; border-radius:10px; padding:20px 24px; box-shadow:0 1px 3px rgba(0,0,0,0.08); }
  .stat-card .value { font-size:36px; font-weight:700; color:#0f172a; line-height:1.1; }
  .stat-card .label { font-size:13px; color:#64748b; margin-top:6px; }
  .stat-card.active .value { color:#16a34a; }
  .stat-card.suspended .value { color:#dc2626; }
  .stat-card.provisioning .value { color:#d97706; }

  /* Cards */
  .card { background:white; border-radius:10px; padding:24px; box-shadow:0 1px 3px rgba(0,0,0,0.08); margin-bottom:20px; }
  .card-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; }
  .card-header h3 { font-size:16px; font-weight:600; color:#0f172a; }

  /* Table */
  table { width:100%; border-collapse:collapse; }
  th, td { text-align:left; padding:10px 14px; font-size:13px; border-bottom:1px solid #f1f5f9; }
  th { font-weight:600; color:#64748b; font-size:11px; text-transform:uppercase; letter-spacing:0.5px; background:#f8fafc; }
  tr:hover td { background:#f8fafc; }

  /* Badges */
  .badge { display:inline-block; padding:3px 10px; border-radius:20px; font-size:11px; font-weight:600; letter-spacing:0.3px; }
  .badge-active { background:#dcfce7; color:#166534; }
  .badge-suspended { background:#fee2e2; color:#991b1b; }
  .badge-provisioning { background:#fef3c7; color:#92400e; }

  /* Buttons */
  .btn { padding:7px 16px; border-radius:6px; font-size:13px; font-weight:500; border:none; cursor:pointer; transition:all 0.15s; }
  .btn-primary { background:#3b82f6; color:white; }
  .btn-primary:hover { background:#2563eb; }
  .btn-secondary { background:#f1f5f9; color:#334155; border:1px solid #e2e8f0; }
  .btn-secondary:hover { background:#e2e8f0; }
  .btn-danger { background:#fee2e2; color:#dc2626; border:1px solid #fecaca; }
  .btn-danger:hover { background:#fecaca; }
  .btn-success { background:#dcfce7; color:#16a34a; border:1px solid #bbf7d0; }
  .btn-success:hover { background:#bbf7d0; }
  .btn-sm { padding:5px 12px; font-size:12px; }
  .btn-group { display:flex; gap:6px; }

  /* Forms */
  .form-group { margin-bottom:14px; }
  .form-group label { display:block; font-size:12px; font-weight:600; color:#64748b; margin-bottom:5px; text-transform:uppercase; letter-spacing:0.3px; }
  .form-group input, .form-group textarea { width:100%; padding:9px 12px; border:1px solid #e2e8f0; border-radius:6px; font-size:14px; font-family:inherit; transition:border-color 0.15s; }
  .form-group input:focus, .form-group textarea:focus { outline:none; border-color:#3b82f6; box-shadow:0 0 0 3px rgba(59,130,246,0.1); }
  .form-row { display:grid; grid-template-columns:1fr 1fr; gap:14px; }

  /* Modal */
  .modal-overlay { position:fixed; top:0; left:0; right:0; bottom:0; background:rgba(0,0,0,0.5); display:flex; justify-content:center; align-items:flex-start; padding-top:60px; z-index:200; }
  .modal { background:white; border-radius:12px; width:100%; max-width:600px; max-height:85vh; overflow-y:auto; box-shadow:0 20px 60px rgba(0,0,0,0.3); }
  .modal-header { padding:20px 24px; border-bottom:1px solid #f1f5f9; display:flex; justify-content:space-between; align-items:center; }
  .modal-header h3 { font-size:16px; font-weight:600; }
  .modal-close { background:none; border:none; font-size:20px; cursor:pointer; color:#94a3b8; padding:4px; }
  .modal-close:hover { color:#334155; }
  .modal-body { padding:24px; }
  .modal-footer { padding:16px 24px; border-top:1px solid #f1f5f9; display:flex; justify-content:flex-end; gap:10px; }

  /* Login */
  .login-wrapper { display:flex; justify-content:center; align-items:center; min-height:100vh; background:linear-gradient(135deg,#0f172a 0%,#1e293b 100%); }
  .login-card { background:white; border-radius:12px; padding:40px; width:100%; max-width:400px; box-shadow:0 20px 60px rgba(0,0,0,0.3); }
  .login-card h2 { font-size:22px; font-weight:700; color:#0f172a; margin-bottom:6px; }
  .login-card p { font-size:13px; color:#64748b; margin-bottom:24px; }
  .login-card .form-group input { padding:11px 14px; }
  .login-error { color:#dc2626; font-size:13px; margin-bottom:12px; display:none; }

  /* Detail view */
  .detail-section { margin-bottom:24px; }
  .detail-section h4 { font-size:14px; font-weight:600; color:#0f172a; margin-bottom:12px; padding-bottom:8px; border-bottom:1px solid #f1f5f9; }
  .detail-grid { display:grid; grid-template-columns:140px 1fr; gap:8px 16px; font-size:13px; }
  .detail-label { color:#64748b; font-weight:500; }
  .detail-value { color:#0f172a; }

  /* Credential cards */
  .cred-card { border:1px solid #e2e8f0; border-radius:8px; padding:16px; margin-bottom:12px; }
  .cred-card-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:12px; }
  .cred-card-header h5 { font-size:14px; font-weight:600; }
  .cred-status { font-size:11px; font-weight:600; }
  .cred-status.configured { color:#16a34a; }
  .cred-status.not-configured { color:#94a3b8; }

  /* Tabs */
  .tabs { display:flex; border-bottom:2px solid #f1f5f9; margin-bottom:20px; }
  .tab { padding:10px 20px; font-size:13px; font-weight:500; color:#64748b; cursor:pointer; border-bottom:2px solid transparent; margin-bottom:-2px; transition:all 0.15s; }
  .tab:hover { color:#334155; }
  .tab.active { color:#3b82f6; border-bottom-color:#3b82f6; }

  /* Notification */
  .notification { position:fixed; top:20px; right:20px; padding:12px 24px; border-radius:8px; color:white; font-weight:500; font-size:14px; z-index:1000; display:none; box-shadow:0 4px 12px rgba(0,0,0,0.15); }

  .hidden { display:none !important; }
  .text-muted { color:#94a3b8; }
</style></head>
<body>

<div class="notification" id="notification"></div>

<!-- Login Screen -->
<div id="loginScreen" class="login-wrapper">
  <div class="login-card">
    <h2>Super Admin</h2>
    <p>OpenClaw Multi-Tenant Management</p>
    <div class="login-error" id="loginError">Invalid credentials</div>
    <div class="form-group">
      <label>Username</label>
      <input type="text" id="loginUser" placeholder="Enter username" autocomplete="username">
    </div>
    <div class="form-group">
      <label>Password</label>
      <input type="password" id="loginPass" placeholder="Enter password" autocomplete="current-password">
    </div>
    <button class="btn btn-primary" style="width:100%;padding:11px;font-size:15px;margin-top:8px" onclick="doLogin()">Sign In</button>
  </div>
</div>

<!-- Main App -->
<div id="mainApp" class="hidden">
  <div class="header">
    <h1><span>OpenClaw</span> Super Admin</h1>
    <div class="header-right">
      <span class="header-user" id="headerUser"></span>
      <button class="btn-logout" onclick="doLogout()">Sign Out</button>
    </div>
  </div>
  <div class="container">
    <!-- Dashboard Stats -->
    <div class="stats" id="statsGrid"></div>

    <!-- Views -->
    <div id="viewList"></div>
    <div id="viewDetail" class="hidden"></div>
  </div>
</div>

<!-- Create Tenant Modal -->
<div id="createModal" class="modal-overlay hidden" onclick="if(event.target===this)closeCreateModal()">
  <div class="modal">
    <div class="modal-header">
      <h3 id="modalTitle">Create Tenant</h3>
      <button class="modal-close" onclick="closeCreateModal()">&times;</button>
    </div>
    <div class="modal-body">
      <input type="hidden" id="editTenantId">
      <div class="form-row">
        <div class="form-group">
          <label>Organization Name *</label>
          <input type="text" id="tenantName" placeholder="Acme Corp">
        </div>
        <div class="form-group">
          <label>Slug</label>
          <input type="text" id="tenantSlug" placeholder="acme-corp (auto-generated)">
        </div>
      </div>
      <div class="form-row">
        <div class="form-group">
          <label>Admin Email *</label>
          <input type="email" id="tenantAdminEmail" placeholder="admin@acme.com">
        </div>
        <div class="form-group">
          <label>Admin Name</label>
          <input type="text" id="tenantAdminName" placeholder="John Doe">
        </div>
      </div>
      <div class="form-group">
        <label>Email Domains (comma-separated)</label>
        <input type="text" id="tenantEmailDomains" placeholder="acme.com, acme.co.uk">
      </div>
    </div>
    <div class="modal-footer">
      <button class="btn btn-secondary" onclick="closeCreateModal()">Cancel</button>
      <button class="btn btn-primary" id="modalSaveBtn" onclick="saveTenant()">Create Tenant</button>
    </div>
  </div>
</div>

<script>
const API_BASE = '/super-admin/api';
let token = localStorage.getItem('sa_token');
let currentView = 'list';

// ── Helpers ──

function notify(msg, isError) {
  const el = document.getElementById('notification');
  el.textContent = msg;
  el.style.background = isError ? '#dc2626' : '#16a34a';
  el.style.display = 'block';
  setTimeout(() => el.style.display = 'none', 3500);
}

async function api(path, opts = {}) {
  try {
    const resp = await fetch(API_BASE + path, {
      ...opts,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
        ...(opts.headers || {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (resp.status === 401) { doLogout(); return null; }
    const data = await resp.json();
    if (!resp.ok) { notify(data.error || 'Request failed', true); return null; }
    return data;
  } catch (err) {
    notify('Network error: ' + err.message, true);
    return null;
  }
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}

function fmtDate(iso) {
  if (!iso) return '-';
  return new Date(iso).toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' });
}

function statusBadge(status) {
  const cls = { ACTIVE:'badge-active', SUSPENDED:'badge-suspended', PROVISIONING:'badge-provisioning' };
  return '<span class="badge ' + (cls[status] || 'badge-provisioning') + '">' + esc(status) + '</span>';
}

// ── Auth ──

async function doLogin() {
  const username = document.getElementById('loginUser').value.trim();
  const password = document.getElementById('loginPass').value;
  if (!username || !password) { document.getElementById('loginError').style.display = 'block'; return; }

  try {
    const resp = await fetch(API_BASE + '/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await resp.json();
    if (data.token) {
      token = data.token;
      localStorage.setItem('sa_token', token);
      showApp();
    } else {
      document.getElementById('loginError').style.display = 'block';
    }
  } catch (err) {
    document.getElementById('loginError').textContent = 'Connection error';
    document.getElementById('loginError').style.display = 'block';
  }
}

function doLogout() {
  token = null;
  localStorage.removeItem('sa_token');
  location.reload();
}

document.getElementById('loginPass').addEventListener('keydown', function(e) {
  if (e.key === 'Enter') doLogin();
});

// ── App Init ──

async function showApp() {
  document.getElementById('loginScreen').classList.add('hidden');
  document.getElementById('mainApp').classList.remove('hidden');
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/')));
    document.getElementById('headerUser').textContent = payload.username || 'admin';
  } catch {}
  await loadDashboard();
  showListView();
}

// ── Dashboard ──

async function loadDashboard() {
  const data = await api('/dashboard');
  if (!data) return;
  document.getElementById('statsGrid').innerHTML = [
    { v: data.totalTenants, l: 'Total Tenants', c: '' },
    { v: data.activeTenants, l: 'Active', c: 'active' },
    { v: data.suspendedTenants, l: 'Suspended', c: 'suspended' },
    { v: data.provisioningTenants || 0, l: 'Provisioning', c: 'provisioning' },
    { v: data.totalUsers, l: 'Total Users', c: '' },
  ].map(s => '<div class="stat-card ' + s.c + '"><div class="value">' + s.v + '</div><div class="label">' + s.l + '</div></div>').join('');
}

// ── List View ──

async function showListView() {
  currentView = 'list';
  document.getElementById('viewDetail').classList.add('hidden');
  document.getElementById('viewList').classList.remove('hidden');
  await loadTenantList();
}

async function loadTenantList() {
  const data = await api('/tenants');
  if (!data) return;

  document.getElementById('viewList').innerHTML = '<div class="card">' +
    '<div class="card-header"><h3>Tenants</h3>' +
    '<button class="btn btn-primary" onclick="openCreateModal()">+ New Tenant</button></div>' +
    '<table><thead><tr>' +
    '<th>Name</th><th>Slug</th><th>Status</th><th>Email Domains</th><th>Users</th><th>Created</th><th>Actions</th>' +
    '</tr></thead><tbody>' +
    (data.tenants.length === 0
      ? '<tr><td colspan="7" style="text-align:center;padding:40px;color:#94a3b8">No tenants yet. Create your first tenant to get started.</td></tr>'
      : data.tenants.map(t =>
        '<tr>' +
        '<td><strong>' + esc(t.name) + '</strong></td>' +
        '<td class="text-muted">' + esc(t.slug) + '</td>' +
        '<td>' + statusBadge(t.status) + '</td>' +
        '<td>' + (t.emailDomains && t.emailDomains.length ? t.emailDomains.map(d => esc(d)).join(', ') : '<span class="text-muted">-</span>') + '</td>' +
        '<td>' + (t.userCount || 0) + '</td>' +
        '<td class="text-muted">' + fmtDate(t.createdAt) + '</td>' +
        '<td><div class="btn-group">' +
          '<button class="btn btn-secondary btn-sm" onclick="showDetail(\'' + t.id + '\')">View</button>' +
          '<button class="btn btn-secondary btn-sm" onclick="openEditModal(\'' + t.id + '\')">Edit</button>' +
          (t.status === 'ACTIVE'
            ? '<button class="btn btn-danger btn-sm" onclick="toggleStatus(\'' + t.id + '\',\'SUSPENDED\')">Suspend</button>'
            : '<button class="btn btn-success btn-sm" onclick="toggleStatus(\'' + t.id + '\',\'ACTIVE\')">Activate</button>') +
          '<button class="btn btn-danger btn-sm" onclick="deleteTenant(\'' + t.id + '\',\'' + esc(t.name).replace(/'/g,"\\\\'") + '\')">Delete</button>' +
        '</div></td>' +
        '</tr>'
      ).join('')) +
    '</tbody></table></div>';
}

// ── Detail View ──

async function showDetail(id) {
  const data = await api('/tenants/' + id);
  if (!data) return;

  currentView = 'detail';
  document.getElementById('viewList').classList.add('hidden');
  document.getElementById('viewDetail').classList.remove('hidden');

  const t = data.tenant;
  const creds = data.credentials || {};

  const providers = [
    {
      key: 'salesforce', name: 'Salesforce',
      fields: [
        { id: 'clientId', label: 'Client ID', type: 'text' },
        { id: 'clientSecret', label: 'Client Secret', type: 'password' },
        { id: 'loginUrl', label: 'Login URL', type: 'text', placeholder: 'https://login.salesforce.com' },
      ]
    },
    {
      key: 'm365', name: 'Microsoft 365',
      fields: [
        { id: 'clientId', label: 'Client ID', type: 'text' },
        { id: 'clientSecret', label: 'Client Secret', type: 'password' },
        { id: 'tenantId', label: 'Tenant ID', type: 'text', placeholder: 'common' },
        { id: 'redirectUri', label: 'Redirect URI', type: 'text' },
      ]
    },
    {
      key: 'gmail', name: 'Gmail / Google Workspace',
      fields: [
        { id: 'clientId', label: 'Client ID', type: 'text' },
        { id: 'clientSecret', label: 'Client Secret', type: 'password' },
        { id: 'redirectUri', label: 'Redirect URI', type: 'text' },
      ]
    },
  ];

  let credHtml = providers.map(p => {
    const pc = creds[p.key] || {};
    const isConfigured = pc.clientId && pc.clientId !== '';
    return '<div class="cred-card">' +
      '<div class="cred-card-header"><h5>' + p.name + '</h5>' +
      '<span class="cred-status ' + (isConfigured ? 'configured' : 'not-configured') + '">' +
        (isConfigured ? 'Configured' : 'Not Configured') + '</span></div>' +
      p.fields.map(f =>
        '<div class="form-group">' +
        '<label>' + f.label + '</label>' +
        '<input type="' + (f.type || 'text') + '" id="cred_' + p.key + '_' + f.id + '" ' +
          'value="' + esc(pc[f.id] || '') + '" ' +
          'placeholder="' + (f.placeholder || '') + '">' +
        '</div>'
      ).join('') +
      '<div class="btn-group">' +
        '<button class="btn btn-primary btn-sm" onclick="saveCredentials(\'' + t.id + '\',\'' + p.key + '\',' + JSON.stringify(p.fields.map(f => f.id)).replace(/"/g, '&quot;') + ')">Save</button>' +
        (isConfigured ? '<button class="btn btn-danger btn-sm" onclick="removeCredentials(\'' + t.id + '\',\'' + p.key + '\')">Remove</button>' : '') +
      '</div>' +
    '</div>';
  }).join('');

  document.getElementById('viewDetail').innerHTML =
    '<div style="margin-bottom:16px">' +
      '<button class="btn btn-secondary" onclick="showListView()">&larr; Back to Tenants</button>' +
    '</div>' +
    '<div class="card">' +
      '<div class="card-header"><h3>' + esc(t.name) + ' ' + statusBadge(t.status) + '</h3>' +
        '<div class="btn-group">' +
          '<button class="btn btn-secondary btn-sm" onclick="openEditModal(\'' + t.id + '\')">Edit</button>' +
          (t.status === 'ACTIVE'
            ? '<button class="btn btn-danger btn-sm" onclick="toggleStatus(\'' + t.id + '\',\'SUSPENDED\')">Suspend</button>'
            : '<button class="btn btn-success btn-sm" onclick="toggleStatus(\'' + t.id + '\',\'ACTIVE\')">Activate</button>') +
        '</div>' +
      '</div>' +
      '<div class="detail-section">' +
        '<h4>Organization Details</h4>' +
        '<div class="detail-grid">' +
          '<span class="detail-label">Tenant ID</span><span class="detail-value" style="font-family:monospace;font-size:12px">' + esc(t.id) + '</span>' +
          '<span class="detail-label">Slug</span><span class="detail-value">' + esc(t.slug) + '</span>' +
          '<span class="detail-label">Admin Email</span><span class="detail-value">' + esc(t.adminEmail) + '</span>' +
          '<span class="detail-label">Admin Name</span><span class="detail-value">' + esc(t.adminName || '-') + '</span>' +
          '<span class="detail-label">Email Domains</span><span class="detail-value">' + (t.emailDomains && t.emailDomains.length ? t.emailDomains.join(', ') : '-') + '</span>' +
          '<span class="detail-label">Users</span><span class="detail-value">' + (t.userCount || 0) + '</span>' +
          '<span class="detail-label">Created</span><span class="detail-value">' + fmtDate(t.createdAt) + '</span>' +
          '<span class="detail-label">Last Updated</span><span class="detail-value">' + fmtDate(t.updatedAt) + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="detail-section">' +
        '<h4>Service Credentials</h4>' +
        credHtml +
      '</div>' +
    '</div>';
}

// ── Credentials ──

async function saveCredentials(tenantId, provider, fieldIds) {
  const body = {};
  fieldIds.forEach(fid => {
    const el = document.getElementById('cred_' + provider + '_' + fid);
    if (el) {
      const val = el.value.trim();
      // Do not overwrite masked secrets with the mask itself
      if (val && val !== '********') body[fid] = val;
    }
  });
  if (!body.clientId) { notify('Client ID is required', true); return; }

  const result = await api('/tenants/' + tenantId + '/credentials/' + provider, { method: 'PUT', body });
  if (result) {
    notify(provider.toUpperCase() + ' credentials saved');
    showDetail(tenantId);
  }
}

async function removeCredentials(tenantId, provider) {
  if (!confirm('Remove ' + provider + ' credentials for this tenant?')) return;
  const result = await api('/tenants/' + tenantId + '/credentials/' + provider, { method: 'DELETE' });
  if (result) {
    notify(provider.toUpperCase() + ' credentials removed');
    showDetail(tenantId);
  }
}

// ── Create / Edit Modal ──

function openCreateModal() {
  document.getElementById('modalTitle').textContent = 'Create Tenant';
  document.getElementById('modalSaveBtn').textContent = 'Create Tenant';
  document.getElementById('editTenantId').value = '';
  document.getElementById('tenantName').value = '';
  document.getElementById('tenantSlug').value = '';
  document.getElementById('tenantAdminEmail').value = '';
  document.getElementById('tenantAdminName').value = '';
  document.getElementById('tenantEmailDomains').value = '';
  document.getElementById('createModal').classList.remove('hidden');
}

async function openEditModal(id) {
  const data = await api('/tenants/' + id);
  if (!data) return;
  const t = data.tenant;
  document.getElementById('modalTitle').textContent = 'Edit Tenant';
  document.getElementById('modalSaveBtn').textContent = 'Save Changes';
  document.getElementById('editTenantId').value = t.id;
  document.getElementById('tenantName').value = t.name;
  document.getElementById('tenantSlug').value = t.slug;
  document.getElementById('tenantAdminEmail').value = t.adminEmail;
  document.getElementById('tenantAdminName').value = t.adminName || '';
  document.getElementById('tenantEmailDomains').value = (t.emailDomains || []).join(', ');
  document.getElementById('createModal').classList.remove('hidden');
}

function closeCreateModal() {
  document.getElementById('createModal').classList.add('hidden');
}

async function saveTenant() {
  const editId = document.getElementById('editTenantId').value;
  const name = document.getElementById('tenantName').value.trim();
  const slug = document.getElementById('tenantSlug').value.trim();
  const adminEmail = document.getElementById('tenantAdminEmail').value.trim();
  const adminName = document.getElementById('tenantAdminName').value.trim();
  const domainsRaw = document.getElementById('tenantEmailDomains').value.trim();
  const emailDomains = domainsRaw ? domainsRaw.split(',').map(d => d.trim()).filter(Boolean) : [];

  if (!name) { notify('Organization name is required', true); return; }
  if (!adminEmail) { notify('Admin email is required', true); return; }

  const body = { name, slug: slug || undefined, adminEmail, adminName, emailDomains };

  let result;
  if (editId) {
    result = await api('/tenants/' + editId, { method: 'PUT', body });
  } else {
    result = await api('/tenants', { method: 'POST', body });
  }

  if (result) {
    closeCreateModal();
    notify(editId ? 'Tenant updated' : 'Tenant created');
    await loadDashboard();
    if (currentView === 'detail' && editId) {
      showDetail(editId);
    } else {
      await loadTenantList();
    }
  }
}

// ── Status Toggle ──

async function toggleStatus(id, newStatus) {
  const action = newStatus === 'SUSPENDED' ? 'suspend' : 'activate';
  if (!confirm('Are you sure you want to ' + action + ' this tenant?')) return;

  const result = await api('/tenants/' + id + '/status', { method: 'PATCH', body: { status: newStatus } });
  if (result) {
    notify('Tenant ' + action + 'd');
    await loadDashboard();
    if (currentView === 'detail') {
      showDetail(id);
    } else {
      await loadTenantList();
    }
  }
}

// ── Delete ──

async function deleteTenant(id, name) {
  if (!confirm('Permanently delete tenant "' + name + '"? This cannot be undone.')) return;
  if (!confirm('Are you absolutely sure? All data for this tenant will be lost.')) return;

  const result = await api('/tenants/' + id, { method: 'DELETE' });
  if (result) {
    notify('Tenant deleted');
    await loadDashboard();
    if (currentView === 'detail') {
      showListView();
    } else {
      await loadTenantList();
    }
  }
}

// ── Boot ──

if (token) {
  showApp();
}
</script>
</body></html>`;
}

module.exports = {
  init,
  superAdminLogin,
  verifySuperAdmin,
};
