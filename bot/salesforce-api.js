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
 * @param {object} options - { limit, sortBy, sortDir, year, minAmount }
 */
async function getOpenOpportunities(token, instanceUrl, limitOrOptions = 15) {
  let limit = 15, sortBy = "CloseDate", sortDir = "ASC", whereExtra = "";

  if (typeof limitOrOptions === "object" && limitOrOptions !== null) {
    limit = limitOrOptions.limit || 15;
    sortBy = limitOrOptions.sortBy || "CloseDate";
    sortDir = limitOrOptions.sortDir || "ASC";
    if (limitOrOptions.year) {
      whereExtra += ` AND CALENDAR_YEAR(CloseDate) = ${parseInt(limitOrOptions.year, 10)}`;
    }
    if (limitOrOptions.minAmount) {
      whereExtra += ` AND Amount >= ${parseFloat(limitOrOptions.minAmount)}`;
    }
  } else {
    limit = limitOrOptions || 15;
  }

  const validSorts = { CloseDate: "CloseDate", Amount: "Amount", Name: "Name", Probability: "Probability", CreatedDate: "CreatedDate" };
  const sortField = validSorts[sortBy] || "CloseDate";
  const dir = sortDir === "DESC" ? "DESC" : "ASC";

  const soql = `SELECT Id, Name, StageName, Amount, CloseDate, Probability, Account.Name, AccountId, Owner.Name, NextStep
    FROM Opportunity
    WHERE IsClosed = false${whereExtra}
    ORDER BY ${sortField} ${dir} NULLS LAST
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
  // Get recent events/activities
  const eventSoql = `SELECT Id, Subject, StartDateTime, EndDateTime, Description, Who.Name, What.Name
    FROM Event
    ${whereClause.replace("OwnerId = 'me'", "OwnerId != null")}
    ORDER BY StartDateTime DESC
    LIMIT ${maxItems}`;

  const [tasks, events] = await Promise.all([
    sfQuery(token, instanceUrl, taskSoql),
    sfQuery(token, instanceUrl, eventSoql),
  ]);

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

// ── Write Operations ─────────────────────────────────────

/**
 * Update an opportunity's fields.
 * @param {string} oppId - Opportunity ID
 * @param {object} fields - { StageName, CloseDate, Amount, NextStep, Probability, Description }
 */
async function updateOpportunity(token, instanceUrl, oppId, fields) {
  const resp = await sfFetch(token, instanceUrl, `/sobjects/Opportunity/${oppId}`, {
    method: "PATCH",
    body: JSON.stringify(fields),
  });
  if (!resp || resp._error) return resp || { _error: true, message: "No response" };
  return { success: true };
}

/**
 * Create a new task.
 * @param {object} taskData - { Subject, Status, Priority, ActivityDate, WhatId, WhoId, Description, OwnerId }
 */
async function createTask(token, instanceUrl, taskData) {
  const body = { ...taskData };
  if (!body.Status) body.Status = "Not Started";
  const resp = await sfFetch(token, instanceUrl, "/sobjects/Task", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!resp || resp._error) return resp || { _error: true, message: "No response" };
  return { success: true, id: resp.id };
}

/**
 * Log a completed activity (call, email, etc.).
 * @param {object} params - { subject, description, whatId, whoId, type }
 */
async function logActivity(token, instanceUrl, { subject, description, whatId, whoId, type }) {
  const subtypeMap = { Call: "Call", Email: "Email" };
  const body = {
    Subject: subject,
    Description: description,
    WhatId: whatId,
    WhoId: whoId,
    Status: "Completed",
  };
  if (type && subtypeMap[type]) body.TaskSubtype = subtypeMap[type];
  const resp = await sfFetch(token, instanceUrl, "/sobjects/Task", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!resp || resp._error) return resp || { _error: true, message: "No response" };
  return { success: true, id: resp.id };
}

/**
 * Close an opportunity as won or lost.
 */
async function closeOpportunity(token, instanceUrl, oppId, won, amount) {
  const fields = { StageName: won ? "Closed Won" : "Closed Lost" };
  if (amount !== undefined && amount !== null) fields.Amount = amount;
  return updateOpportunity(token, instanceUrl, oppId, fields);
}

// ── Forecast Queries ─────────────────────────────────────

/**
 * Get total closed-won amount and deal count for this fiscal quarter.
 */
async function getClosedWonThisQuarter(token, instanceUrl) {
  const soql = `SELECT SUM(Amount) totalWon, COUNT(Id) dealCount FROM Opportunity WHERE StageName = 'Closed Won' AND CloseDate = THIS_FISCAL_QUARTER`;
  const resp = await sfQuery(token, instanceUrl, soql);
  if (!resp || resp.length === 0) return { totalWon: 0, dealCount: 0 };
  return { totalWon: resp[0].totalWon || 0, dealCount: resp[0].dealCount || 0 };
}

/**
 * Get total closed-won amount and deal count for last fiscal quarter.
 */
async function getClosedWonLastQuarter(token, instanceUrl) {
  const soql = `SELECT SUM(Amount) totalWon, COUNT(Id) dealCount FROM Opportunity WHERE StageName = 'Closed Won' AND CloseDate = LAST_FISCAL_QUARTER`;
  const resp = await sfQuery(token, instanceUrl, soql);
  if (!resp || resp.length === 0) return { totalWon: 0, dealCount: 0 };
  return { totalWon: resp[0].totalWon || 0, dealCount: resp[0].dealCount || 0 };
}

/**
 * Get deals closed (won or lost) this week.
 */
async function getClosedDealsThisWeek(token, instanceUrl) {
  const soql = `SELECT Id, Name, StageName, Amount, CloseDate, Account.Name, Owner.Name FROM Opportunity WHERE (StageName = 'Closed Won' OR StageName = 'Closed Lost') AND CloseDate = THIS_WEEK ORDER BY Amount DESC NULLS LAST LIMIT 20`;
  const resp = await sfQuery(token, instanceUrl, soql);
  if (!resp) return [];
  return resp.map(normalizeOpportunity);
}

// ── Competitor Operations ────────────────────────────────

/**
 * Get competitors for an opportunity.
 * Falls back with { _fallback: true } if OpportunityCompetitor object doesn't exist.
 */
async function getCompetitors(token, instanceUrl, oppId) {
  const soql = `SELECT Id, CompetitorName, Strengths, Weaknesses FROM OpportunityCompetitor WHERE OpportunityId = '${escapeSoql(oppId)}'`;
  const resp = await sfQuery(token, instanceUrl, soql);
  if (resp === null) return { _fallback: true };
  return resp.map(c => ({
    id: c.Id,
    name: c.CompetitorName || "",
    strengths: c.Strengths || "",
    weaknesses: c.Weaknesses || "",
  }));
}

/**
 * Add a competitor to an opportunity.
 */
async function addCompetitor(token, instanceUrl, oppId, name, strengths, weaknesses) {
  const body = {
    OpportunityId: oppId,
    CompetitorName: name,
  };
  if (strengths) body.Strengths = strengths;
  if (weaknesses) body.Weaknesses = weaknesses;
  const resp = await sfFetch(token, instanceUrl, "/sobjects/OpportunityCompetitor", {
    method: "POST",
    body: JSON.stringify(body),
  });
  if (!resp || resp._error) return resp || { _error: true, message: "No response" };
  return { success: true, id: resp.id };
}

/**
 * Search deals by competitor name.
 */
async function searchDealsByCompetitor(token, instanceUrl, competitorName) {
  const soql = `SELECT OpportunityId, Opportunity.Name, Opportunity.Amount, Opportunity.StageName, Opportunity.Account.Name, CompetitorName FROM OpportunityCompetitor WHERE CompetitorName LIKE '%${escapeSoql(competitorName)}%' LIMIT 20`;
  const resp = await sfQuery(token, instanceUrl, soql);
  if (!resp) return [];
  return resp.map(r => ({
    opportunityId: r.OpportunityId || "",
    opportunityName: r.Opportunity?.Name || "",
    amount: r.Opportunity?.Amount || null,
    stage: r.Opportunity?.StageName || "",
    account: r.Opportunity?.Account?.Name || "",
    competitor: r.CompetitorName || "",
  }));
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
  // Write Operations
  updateOpportunity,
  createTask,
  logActivity,
  closeOpportunity,
  // Forecast Queries
  getClosedWonThisQuarter,
  getClosedWonLastQuarter,
  getClosedDealsThisWeek,
  // Competitor Operations
  getCompetitors,
  addCompetitor,
  searchDealsByCompetitor,
};
