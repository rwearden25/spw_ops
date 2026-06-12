const express = require('express');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('./db');

// Seed accounts created in Postgres on first run (mirrors the client SEED_USERS).
// TODO(auth phase): hash these and move login server-side.
const SEED_USERS = [
  { username: 'admin',  password: 'adminpasswd', displayName: 'Admin',  role: 'admin'  },
  { username: 'viewer', password: 'viewer',      displayName: 'Viewer', role: 'member' },
];

const app = express();
const PORT = process.env.PORT || 3000;

/* =====================================================================
   OUTLOOK → ACH PAYMENTS AGENT  (Microsoft Graph)
   ---------------------------------------------------------------------
   Polls a mailbox for ACH remittance emails, downloads the CSV
   attachment, parses it, and records the payment. Dormant until all of
   these env vars are set (so the app runs fine without them):

     GRAPH_TENANT_ID       Directory (tenant) ID
     GRAPH_CLIENT_ID       Application (client) ID
     GRAPH_CLIENT_SECRET   client secret value
     GRAPH_MAILBOX         mailbox to watch (e.g. ops@standardpowerwashing.com)

   Optional:
     ACH_FROM              sender filter, e.g. vendor.hotline@brinker.com (substring)
     ACH_SUBJECT           subject substring to match (default "Remit Advice")
     POLL_INTERVAL_MS      poll cadence (default 300000 = 5 min, min 60000)

   Requires Microsoft Graph APPLICATION permission Mail.Read (admin-consented).
   We never mark mail read (read-only), so dedupe is by message id + payment ref.
   Local dev: `node --env-file=.env server.js`. On Railway, set the vars in the
   service's Variables tab.
   ===================================================================== */
const AGENT = {
  tenant:       process.env.GRAPH_TENANT_ID,
  clientId:     process.env.GRAPH_CLIENT_ID,
  clientSecret: process.env.GRAPH_CLIENT_SECRET,
  mailbox:      process.env.GRAPH_MAILBOX,
  // ACH_FROM is a comma-separated allowlist of EXACT sender addresses (normalized, lowercased)
  fromList: (process.env.ACH_FROM || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean),
  subject:  (process.env.ACH_SUBJECT || 'Remit Advice'),
  intervalMs: Math.max(60000, parseInt(process.env.POLL_INTERVAL_MS || '300000', 10) || 300000),
  requireAuthResults: process.env.ACH_REQUIRE_AUTH_RESULTS !== 'false', // require DMARC=pass on the email (default on)
  maxAttachB64: 4 * 1024 * 1024,                                        // cap attachment (~3 MB) before decoding
};
const agentEnabled = !!(AGENT.tenant && AGENT.clientId && AGENT.clientSecret && AGENT.mailbox);

const DATA_FILE = path.join(__dirname, 'data', 'payments.json');
let payments = [];                 // {id, ref, payer, amount, currency, dateISO, receivedAt, source, messageId, subject}
const seenMessages = new Set();
let lastPoll = null, lastErrorKind = null;   // coarse category only ('auth'|'network'|'parse'|'error'); verbose stays in logs

function loadPayments() {
  try {
    payments = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    payments.forEach(p => p.messageId && seenMessages.add(p.messageId));
  } catch (e) { payments = []; }
}
function savePayments() {
  try {
    fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
    fs.writeFileSync(DATA_FILE, JSON.stringify(payments, null, 2));
  } catch (e) { console.error('[agent] payments save failed:', e.message); }
}
loadPayments();

/* ---- remittance parsing (mirrors the client-side parser in index.html) ---- */
function toNum(v) { const n = parseFloat(String(v == null ? '' : v).replace(/[$,\s]/g, '')); return isNaN(n) ? 0 : n; }
function payDate(v) {
  const s = String(v == null ? '' : v).trim();
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);          // remittance CSVs are DD/MM/YYYY
  if (m) { const y = m[3].length === 2 ? '20' + m[3] : m[3]; return `${y}-${String(m[2]).padStart(2, '0')}-${String(m[1]).padStart(2, '0')}`; }
  const d = new Date(s); return isNaN(d) ? '' : d.toISOString().slice(0, 10);
}
function csvToRows(text) {
  const rows = []; let row = [], cur = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ',') { row.push(cur); cur = ''; }
    else if (ch === '\n') { row.push(cur); rows.push(row); row = []; cur = ''; }
    else if (ch === '\r') { /* skip */ }
    else cur += ch;
  }
  if (cur !== '' || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
function parseRemittance(rows) {
  const norm = x => String(x == null ? '' : x).trim().toLowerCase();
  const hi = rows.findIndex(r => Array.isArray(r) && r.some(c => norm(c) === 'payer'));
  if (hi < 0 || !rows[hi + 1]) return null;
  const head = rows[hi].map(norm), data = rows[hi + 1];
  const get = name => { const i = head.indexOf(name); return i < 0 ? '' : data[i]; };
  const payer = String(get('payer') || '').trim();
  if (!payer) return null;
  let amount = toNum(get('paymentamount'));
  if (!amount) { // fall back to the transaction block's AmountPaid
    const ti = rows.findIndex(r => Array.isArray(r) && r.some(c => norm(c) === 'amountpaid'));
    if (ti >= 0 && rows[ti + 1]) { const th = rows[ti].map(norm); amount = toNum(rows[ti + 1][th.indexOf('amountpaid')]); }
  }
  return { payer, amount, currency: String(get('paymentcurrency') || 'USD').trim(), ref: String(get('paymentreferencenumber') || '').trim(), dateISO: payDate(get('paymentdate')) };
}

/* ---- Microsoft Graph (client-credentials, zero-dependency via global fetch) ---- */
let token = null, tokenExp = 0;
async function getToken() {
  if (token && Date.now() < tokenExp - 60000) return token;
  const body = new URLSearchParams({ client_id: AGENT.clientId, client_secret: AGENT.clientSecret, grant_type: 'client_credentials', scope: 'https://graph.microsoft.com/.default' });
  const r = await fetch(`https://login.microsoftonline.com/${AGENT.tenant}/oauth2/v2.0/token`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!r.ok) throw new Error('token ' + r.status + ' ' + await r.text());
  const j = await r.json(); token = j.access_token; tokenExp = Date.now() + (j.expires_in || 3600) * 1000; return token;
}
async function graph(pathOrUrl) {
  const t = await getToken();
  const url = pathOrUrl.startsWith('http') ? pathOrUrl : `https://graph.microsoft.com/v1.0${pathOrUrl}`;
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + t } });
  if (!r.ok) throw new Error('graph ' + r.status + ' ' + await r.text());
  return r.json();
}
function dedupeKey(p, messageId) {
  // stable key: prefer the payment reference, else hash identifying fields (never fail open)
  return p.ref || crypto.createHash('sha256').update(`${String(p.payer || '').toLowerCase()}|${p.amount}|${p.dateISO}|${messageId || ''}`).digest('hex');
}
async function senderAuthenticated(mb, id) {
  // anti-spoofing: require DMARC=pass (and SPF or DKIM pass) from Authentication-Results. Fail closed.
  if (!AGENT.requireAuthResults) return true;
  try {
    const m = await graph(`/users/${mb}/messages/${id}?$select=internetMessageHeaders`);
    const blob = (m.internetMessageHeaders || [])
      .filter(h => /^authentication-results$/i.test(h.name || ''))
      .map(h => String(h.value || '').toLowerCase()).join(' ; ');
    return /dmarc=pass/.test(blob) && /(dkim=pass|spf=pass)/.test(blob);
  } catch (e) { return false; }
}
async function pollMailbox() {
  if (!agentEnabled) return;
  try {
    const mb = encodeURIComponent(AGENT.mailbox);
    const q = `/users/${mb}/mailFolders/inbox/messages?$top=25&$orderby=receivedDateTime desc&$select=id,subject,from,receivedDateTime,hasAttachments`;
    const data = await graph(q);
    let dirty = false;
    for (const msg of (data.value || [])) {
      if (seenMessages.has(msg.id) || !msg.hasAttachments) continue;
      const subj = msg.subject || '';
      const fromAddr = ((msg.from && msg.from.emailAddress && msg.from.emailAddress.address) || '').toLowerCase().trim();
      // trust boundary: EXACT sender allowlist, then subject match, then verified email auth
      if (AGENT.fromList.length && !AGENT.fromList.includes(fromAddr)) continue;
      if (AGENT.subject && !subj.toLowerCase().includes(AGENT.subject.toLowerCase())) continue;
      seenMessages.add(msg.id);                       // mark processed so we don't re-fetch
      if (!(await senderAuthenticated(mb, msg.id))) { console.warn('[agent] rejected (email auth failed) from', fromAddr); continue; }
      const att = await graph(`/users/${mb}/messages/${msg.id}/attachments`);
      const file = (att.value || []).find(a => /\.csv$/i.test(a.name || '') && /csv/i.test(a.contentType || 'text/csv'));
      if (!file || !file.contentBytes) continue;
      if (String(file.contentBytes).length > AGENT.maxAttachB64) { console.warn('[agent] attachment too large — skipped'); continue; }
      const p = parseRemittance(csvToRows(Buffer.from(file.contentBytes, 'base64').toString('utf8')));
      if (!p || !p.payer) continue;                   // reject CSVs with no payer
      const rec = {
        id: 'pay' + Date.now() + Math.floor(Math.random() * 1000),
        ref: p.ref, payer: p.payer, customerId: null, amount: p.amount, currency: p.currency, dateISO: p.dateISO,
        receivedAt: (msg.receivedDateTime || '').slice(0, 10) || p.dateISO,
        source: 'outlook', messageId: msg.id, subject: subj,
      };
      let inserted;
      if (db.enabled()) {
        inserted = !(await db.paymentExistsByMessage(msg.id)) && await db.addPayment(rec);
      } else {
        const key = dedupeKey(p, msg.id);
        if (payments.some(x => dedupeKey(x, x.messageId) === key)) inserted = false;
        else { payments.unshift(rec); if (payments.length > 5000) payments.length = 5000; dirty = true; inserted = true; }
      }
      if (inserted) console.log(`[agent] recorded ACH ${p.ref || '(no ref)'} — ${p.payer} ${p.amount}`);
    }
    if (dirty) savePayments();
    lastPoll = new Date().toISOString(); lastErrorKind = null;
  } catch (e) {
    lastErrorKind = /token|40[13]|unauthor/i.test(e.message) ? 'auth' : /graph|fetch|network|ENOTFOUND|ETIMEDOUT/i.test(e.message) ? 'network' : 'error';
    console.error('[agent] poll failed:', e.message);
  }
}

/* ---- API auth (mounted before the SPA fallback) ----
   There are no server-side user sessions yet (the app login is a client-side
   gate), so payment data is protected with a shared secret. SECURE BY DEFAULT:
   /api/payments is denied unless API_TOKEN is set AND the caller presents it as
   `Authorization: Bearer <token>` (or `x-api-key`). Unauthenticated callers of
   /api/status learn only whether the agent is on — never the mailbox or errors.
   Per-user auth (and dropping the shared secret) comes with the Postgres/auth
   phase; the browser's syncFromAgent() sends the token when one is configured. */
const API_TOKEN = process.env.API_TOKEN || '';
function bearer(req){ const a = req.get('authorization') || ''; return a.startsWith('Bearer ') ? a.slice(7) : (req.get('x-api-key') || ''); }
function safeEq(a, b){ const A = Buffer.from(String(a)), B = Buffer.from(String(b)); return A.length === B.length && crypto.timingSafeEqual(A, B); }
function authed(req){ return !!API_TOKEN && safeEq(bearer(req), API_TOKEN); }
function requireApiAuth(req, res, next){
  if(!API_TOKEN) return res.status(403).json({ error: 'payments API disabled — set API_TOKEN to expose it' });
  if(authed(req)) return next();
  return res.status(401).json({ error: 'unauthorized' });
}

app.use(express.json());
app.get('/api/status', async (req, res) => {
  const out = { agentEnabled };                       // non-sensitive; safe for anyone
  if(authed(req)){
    let count = payments.length;
    try { if(db.enabled()) count = await db.paymentsCount(); } catch(e){ /* keep fallback */ }
    Object.assign(out, { mailbox: AGENT.mailbox, intervalMs: AGENT.intervalMs, lastPoll, lastErrorKind, count, db: db.enabled() });
  }
  res.json(out);
});
app.get('/api/payments', requireApiAuth, async (_req, res) => {
  try { res.json(db.enabled() ? await db.listPayments() : payments); }
  catch(e){ console.error('[api] payments read failed:', e.message); res.status(500).json({ error: 'server error' }); }
});

app.use(express.static(__dirname, { extensions: ['html'] }));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));

(async () => {
  if (db.enabled()) {
    try { await db.init(SEED_USERS); } catch (e) { console.error('[db] init failed — continuing without DB:', e.message); }
  } else {
    console.log('[db] no DATABASE_URL — client uses localStorage, agent uses data/payments.json. Set DATABASE_URL to enable Postgres.');
  }
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`SPW-OPS running on port ${PORT}`);
    if (agentEnabled) {
      console.log(`[agent] Outlook ACH monitor ON — mailbox ${AGENT.mailbox}, every ${Math.round(AGENT.intervalMs / 1000)}s`);
      if (!AGENT.fromList.length) console.warn('[agent] WARNING: ACH_FROM unset — no sender allowlist. Set it to the exact remittance sender(s) to avoid processing spoofed/unintended mail.');
      if (!AGENT.requireAuthResults) console.warn('[agent] WARNING: ACH_REQUIRE_AUTH_RESULTS=false — DMARC verification disabled.');
      if (!API_TOKEN) console.warn('[agent] WARNING: API_TOKEN unset — /api/payments is locked (403). Set API_TOKEN to expose payment data to authorized callers.');
      pollMailbox();
      setInterval(pollMailbox, AGENT.intervalMs);
    } else {
      console.log('[agent] Outlook ACH monitor OFF — set GRAPH_TENANT_ID, GRAPH_CLIENT_ID, GRAPH_CLIENT_SECRET, GRAPH_MAILBOX to enable.');
    }
  });
})();
