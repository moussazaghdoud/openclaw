/**
 * Salesforce REST API Connector — CRM Operations
 *
 * All methods require a valid access token + instanceUrl (from salesforce-auth.js).
 * Uses Node 22 built-in fetch — no extra dependencies.
 *
 * Salesforce REST API: {instanceUrl}/services/data/v59.0/...
 */

const LOG = "[Salesforce-API]";
const API_VERSION = "v59.0";

// ── Account Operations ──────────────────────────────────

/**
 * Get account by ID.
 */
async function getAccount(token, instanceUrl, accountId) {
  const resp = await sfFetch(token, instanceUrl, `/sobjects/Account/${accountId}`);
  if (!resp || resp._error) return resp;
  return normalizeAccount(resp);
}

/**
 * Search accounts by name.
 */
async function searchAccounts(token, instanceUrl, query, limit = 10) {
  const soql = `SELECT Id, Name, Industry, Type, Phone, Website, BillingCity, BillingCountry, OwnerId, Owner.Name, AnnualRevenue, NumberOfEmployees, Description
    FROM Account
    WHERE Name LIKE '%${escapeSoql(query)}%'
    ORDER BY Name
    LIMIT ${limit}`;
  const resp = await sfQuery(token, instanceUrl, soql);
  if (!resp) return [];
  return resp.map(normalizeAccount);
}

/**
 * Get recent accounts (last modified).
 */
async function getRecentAccounts(token, instanceUrl, limit = 10) {
  const soql = `SELECT Id, Name, Industry, Type, Phone, Website, BillingCity, BillingCountry, OwnerId, Owner.Name, AnnualRevenue
    FROM Account
    ORDER BY LastModifiedDate DESC
    LIMIT ${limit}`;
  const resp = await sfQuery(token, instanceUrl, soql);
  if (!resp) return [];
  return resp.map(normalizeAccount);
}

// ── Contact Operations ──────────────────────────────────

/**
 * Get contact by ID.
 */
async function getContact(token, instanceUrl, contactId) {
  const resp = await sfFetch(token, instanceUrl, `/sobjects/Contact/${contactId}`);
  if (!resp || resp._error) return resp;
  return normalizeContact(resp);
}

/**
 * Search contacts by name or email.
 */
async function searchContacts(token, instanceUrl, query, limit = 10) {
  const escaped = escapeSoql(query);
  const soql = `SELECT Id, FirstName, LastName, Name, Email, Phone, MobilePhone, Title, Department, Account.Name, AccountId, MailingCity, MailingCountry
    FROM Contact
    WHERE Name LIKE '%${escaped}%' OR Email LIKE '%${escaped}%'
    ORDER BY Name
    LIMIT ${limit}`;
  const resp = await sfQuery(token, instanceUrl, soql);
  if (!resp) return [];
  return resp.map(normalizeContact);
}

/**
 * Get contacts for an account.
 */
async function getContactsByAccount(token, instanceUrl, accountId, limit = 20) {
  const soql = `SELECT Id, FirstName, LastName, Name, Email, Phone, Title, Department
    FROM Contact
    WHERE AccountId = '${escapeSoql(accountId)}'
    ORDER BY Name
    LIMIT ${limit}`;
  const resp = await sfQuery(token, instanceUrl, soql);
  if (!resp) return [];
  return resp.map(normalizeContact);
}

// ── Opportunity Operations ──────────────────────────────

/**
 * Get opportunities for an account.
 */
async function getOpportunities(token, instanceUrl, accountId, limit = 10) {
  let whereClause = accountId
    ? `WHERE AccountId = '${escapeSoql(accountId)}'`
    : "WHERE IsClosed = false";
  const soql = `SELECT Id, Name, StageName, Amount, CloseDate, Probability, Type, LeadSource, Account.Name, AccountId, OwnerId, Owner.Name, Description, NextStep
    FROM Opportunity
    ${whereClause}
    ORDER BY CloseDate ASC
    LIMIT ${limit}`;
  const resp = await sfQuery(token, instanceUrl, soql);
  if (!resp) return [];
  return resp.map(normalizeOpportunity);
}

/**
 * Get open opportunities (pipeline).
 */
async function getOpenOpportunities(token, instanceUrl, limit = 15) {
  const soql = `SELECT Id, Name, StageName, Amount, CloseDate, Probability, Account.Name, AccountId, Owner.Name, NextStep
    FROM Opportunity
    WHERE IsClosed = false
    ORDER BY CloseDate ASC
    LIMIT ${limit}`;
  const resp = await sfQuery(token, instanceUrl, soql);
  if (!resp) return [];
  return resp.map(normalizeOpportunity);
}

/**
 * Get opportunity by ID (with full details).
 */
async function getOpportunityDetails(token, instanceUrl, oppId) {
  const resp = await sfFetch(token, instanceUrl, `/sobjects/Opportunity/${oppId}`);
  if (!resp || resp._error) return resp;
  return normalizeOpportunity(resp);
}

// ── Activity / Recent Updates ───────────────────────────

/**
 * Get recent tasks related to an account or contact.
 */
async function getRecentActivity(token, instanceUrl, { accountId, contactId, limit } = {}) {
  const maxItems = limit || 10;
  let whereClause = "";
  if (accountId) whereClause = `WHERE AccountId = '${escapeSoql(accountId)}'`;
  else if (contactId) whereClause = `WHERE WhoId = '${escapeSoql(contactId)}'`;
  else whereClause = "WHERE OwnerId = 'me'"; // fallback to user's own tasks

  // Get recent tasks
  const taskSoql = `SELECT Id, Subject, Status, Priority, ActivityDate, Description, Who.Name, What.Name
    FROM Task
    ${whereClause}
    ORDER BY ActivityDate DESC NULLS LAST
    LIMIT ${maxItems}`;
  const tasks = await sfQuery(token, instanceUrl, taskSoql);

  // Get recent events/activities
  const eventSoql = `SELECT Id, Subject, StartDateTime, EndDateTime, Description, Who.Name, What.Name
    FROM Event
    ${whereClause.replace("OwnerId = 'me'", "OwnerId != null")}
    ORDER BY StartDateTime DESC
    LIMIT ${maxItems}`;
  const events = await sfQuery(token, instanceUrl, eventSoql);

  return {
    tasks: (tasks || []).map(t => ({
      id: t.Id,
      subject: t.Subject,
      status: t.Status,
      priority: t.Priority,
      date: t.ActivityDate,
      description: (t.Description || "").substring(0, 500),
      relatedTo: t.What?.Name || "",
      contact: t.Who?.Name || "",
    })),
    events: (events || []).map(e => ({
      id: e.Id,
      subject: e.Subject,
      start: e.StartDateTime,
      end: e.EndDateTime,
      description: (e.Description || "").substring(0, 500),
      relatedTo: e.What?.Name || "",
      contact: e.Who?.Name || "",
    })),
  };
}

// ── Search (SOSL) ───────────────────────────────────────

/**
 * Global search across Salesforce objects.
 */
async function globalSearch(token, instanceUrl, searchTerm) {
  // Escape SOSL special characters: ? & | ! { } [ ] ( ) ^ ~ * : \ ' "
  const safeTerm = searchTerm.replace(/[?&|!{}[\]()^~*:\\'"-]/g, " ").replace(/\s+/g, " ").trim();
  const encoded = encodeURIComponent(`FIND {${safeTerm}} IN ALL FIELDS RETURNING Account(Id,Name,Industry,Phone), Contact(Id,Name,Email,Phone,Account.Name), Opportunity(Id,Name,StageName,Amount,CloseDate,Account.Name) LIMIT 10`);
  const resp = await sfFetch(token, instanceUrl, `/search/?q=${encoded}`);
  if (!resp || resp._error) return resp;

  const results = { accounts: [], contacts: [], opportunities: [] };
  if (resp.searchRecords) {
    for (const r of resp.searchRecords) {
      if (r.attributes?.type === "Account") results.accounts.push(normalizeAccount(r));
      else if (r.attributes?.type === "Contact") results.contacts.push(normalizeContact(r));
      else if (r.attributes?.type === "Opportunity") results.opportunities.push(normalizeOpportunity(r));
    }
  }
  return results;
}

// ── Internal Helpers ─────────────────────────────────────

async function sfFetch(token, instanceUrl, path, options = {}) {
  const url = `${instanceUrl}/services/data/${API_VERSION}${path}`;
  try {
    const resp = await fetch(url, {
      method: options.method || "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        ...options.headers,
      },
      body: options.body,
      signal: AbortSignal.timeout(15000),
    });

    if (resp.status === 204 || resp.status === 202) return {};
    if (!resp.ok) {
      const errText = await resp.text().catch(() => "");
      console.error(`${LOG} SF API ${resp.status} on ${path.substring(0, 80)}: ${errText.substring(0, 200)}`);
      return { _error: true, status: resp.status, message: errText.substring(0, 200) };
    }

    return await resp.json();
  } catch (err) {
    console.error(`${LOG} SF API error on ${path.substring(0, 80)}:`, err.message);
    return null;
  }
}

async function sfQuery(token, instanceUrl, soql) {
  const resp = await sfFetch(token, instanceUrl, `/query/?q=${encodeURIComponent(soql)}`);
  if (!resp || resp._error) return null;
  return resp.records || [];
}

function normalizeAccount(a) {
  return {
    id: a.Id,
    name: a.Name || "",
    industry: a.Industry || "",
    type: a.Type || "",
    phone: a.Phone || "",
    website: a.Website || "",
    city: a.BillingCity || "",
    country: a.BillingCountry || "",
    owner: a.Owner?.Name || "",
    revenue: a.AnnualRevenue || null,
    employees: a.NumberOfEmployees || null,
    description: (a.Description || "").substring(0, 1000),
  };
}

function normalizeContact(c) {
  return {
    id: c.Id,
    firstName: c.FirstName || "",
    lastName: c.LastName || "",
    name: c.Name || `${c.FirstName || ""} ${c.LastName || ""}`.trim(),
    email: c.Email || "",
    phone: c.Phone || "",
    mobile: c.MobilePhone || "",
    title: c.Title || "",
    department: c.Department || "",
    account: c.Account?.Name || "",
    accountId: c.AccountId || "",
    city: c.MailingCity || "",
    country: c.MailingCountry || "",
  };
}

function normalizeOpportunity(o) {
  return {
    id: o.Id,
    name: o.Name || "",
    stage: o.StageName || "",
    amount: o.Amount || null,
    closeDate: o.CloseDate || "",
    probability: o.Probability || null,
    type: o.Type || "",
    account: o.Account?.Name || "",
    accountId: o.AccountId || "",
    owner: o.Owner?.Name || "",
    nextStep: o.NextStep || "",
    description: (o.Description || "").substring(0, 1000),
  };
}

function escapeSoql(str) {
  return str.replace(/'/g, "\\'").replace(/\\/g, "\\\\");
}

module.exports = {
  // Accounts
  getAccount,
  searchAccounts,
  getRecentAccounts,
  // Contacts
  getContact,
  searchContacts,
  getContactsByAccount,
  // Opportunities
  getOpportunities,
  getOpenOpportunities,
  getOpportunityDetails,
  // Activity
  getRecentActivity,
  // Search
  globalSearch,
};
