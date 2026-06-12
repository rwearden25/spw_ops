/* =====================================================================
   POSTGRES DATA LAYER  (db.js)
   ---------------------------------------------------------------------
   Durable store for SPW-OPS — the intended replacement for the client
   localStorage stopgap and the agent's data/payments.json.

   DORMANT until DATABASE_URL is set: with no DATABASE_URL we never even
   require('pg'), so the app runs fine as before. When it IS set, init()
   creates the schema if needed and seeds the initial users.

   Railway: prefer the service's PRIVATE DATABASE_URL (internal network,
   no SSL needed). For an external/public connection set PGSSLMODE=require —
   TLS is then VERIFIED against the system CA (provide PGSSLROOTCERT to pin
   Railway's CA file). PGSSL_INSECURE=true disables verification and is a
   last resort only (allows MITM — avoid).

   STATUS: payments are wired through this layer by server.js today. The
   customers/sites/excluded/users functions below are ready for the next
   phase (server-side session auth + refactoring the client to read/write
   via the API instead of localStorage).
   ===================================================================== */
let pool = null;

if (process.env.DATABASE_URL) {
  try {
    const { Pool } = require('pg');
    // Default: no SSL (Railway's private network). When SSL is requested, keep
    // certificate verification ON; only disable it via an explicit, named opt-in.
    let ssl = false;
    if (process.env.PGSSLMODE === 'require' || process.env.PGSSLMODE === 'verify-full') {
      ssl = {};                                                   // verify against system CA
      if (process.env.PGSSLROOTCERT) ssl.ca = require('fs').readFileSync(process.env.PGSSLROOTCERT, 'utf8');
      if (process.env.PGSSL_INSECURE === 'true') ssl.rejectUnauthorized = false;   // last resort only (MITM risk)
    }
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl,
      max: 5,
      idleTimeoutMillis: 30000,
    });
    pool.on('error', e => console.error('[db] pool error:', e.message));
  } catch (e) {
    console.error('[db] pg unavailable — running without a database:', e.message);
  }
}

const enabled = () => !!pool;
const q = (text, params) => pool.query(text, params);

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  username text PRIMARY KEY,
  password text NOT NULL,          -- TODO(auth phase): store a bcrypt/argon2 hash, not plaintext
  display_name text,
  role text NOT NULL DEFAULT 'member'
);
CREATE TABLE IF NOT EXISTS customers (
  id text PRIMARY KEY,
  name text NOT NULL,
  subtitle text,
  deadline text,
  default_base numeric DEFAULT 350,
  payer_aliases jsonb NOT NULL DEFAULT '[]'::jsonb,
  pos int DEFAULT 0
);
CREATE TABLE IF NOT EXISTS sites (
  id text PRIMARY KEY,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  status text, eta text, site text, wo text, tk text, addr text, city text, zip text,
  closes text, base numeric DEFAULT 0, travel numeric DEFAULT 0, note text,
  pos int DEFAULT 0
);
CREATE TABLE IF NOT EXISTS excluded (
  id bigserial PRIMARY KEY,
  customer_id text NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  city text, site text, addr text
);
CREATE TABLE IF NOT EXISTS payments (
  id text PRIMARY KEY,
  ref text NOT NULL DEFAULT '',
  payer text, customer_id text,
  amount numeric, currency text, date_iso text, received_at text,
  source text, message_id text, subject text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS payments_ref_uniq ON payments(ref) WHERE ref <> '';
CREATE INDEX IF NOT EXISTS sites_customer_idx ON sites(customer_id);
CREATE INDEX IF NOT EXISTS excluded_customer_idx ON excluded(customer_id);
`;

async function init(seedUsers) {
  if (!enabled()) return false;
  await q(SCHEMA);
  for (const u of (seedUsers || [])) {
    await q(
      `INSERT INTO users (username, password, display_name, role)
       VALUES ($1,$2,$3,$4) ON CONFLICT (username) DO NOTHING`,
      [u.username, u.password, u.displayName || u.username, u.role || 'member']
    );
  }
  console.log('[db] Postgres connected — schema ready.');
  return true;
}

/* ---- payments (wired into server.js now) ---- */
async function listPayments() {
  const { rows } = await q(
    `SELECT id, ref, payer, customer_id AS "customerId", amount, currency,
            date_iso AS "dateISO", received_at AS "receivedAt", source, message_id AS "messageId", subject
       FROM payments ORDER BY created_at DESC LIMIT 5000`
  );
  return rows.map(r => ({ ...r, amount: r.amount == null ? 0 : Number(r.amount) }));
}
async function addPayment(p) {
  // true if inserted, false if a row with the same non-empty ref already existed
  const { rowCount } = await q(
    `INSERT INTO payments (id, ref, payer, customer_id, amount, currency, date_iso, received_at, source, message_id, subject)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (ref) WHERE ref <> '' DO NOTHING`,
    [p.id, p.ref || '', p.payer, p.customerId || null, p.amount, p.currency, p.dateISO, p.receivedAt, p.source, p.messageId || null, p.subject || null]
  );
  return rowCount > 0;
}
async function paymentRefExists(ref) {
  if (!ref) return false;
  const { rowCount } = await q(`SELECT 1 FROM payments WHERE ref=$1 LIMIT 1`, [ref]);
  return rowCount > 0;
}
async function paymentExistsByMessage(messageId) {
  if (!messageId) return false;
  const { rowCount } = await q(`SELECT 1 FROM payments WHERE message_id=$1 LIMIT 1`, [messageId]);
  return rowCount > 0;
}
async function paymentsCount() {
  const { rows } = await q(`SELECT count(*)::int AS n FROM payments`);
  return rows[0].n;
}

/* ---- customers / sites / excluded (ready for the next phase) ---- */
async function getCustomers() {
  const { rows: cs } = await q(`SELECT * FROM customers ORDER BY pos, name`);
  const { rows: ss } = await q(`SELECT * FROM sites ORDER BY pos`);
  const { rows: xs } = await q(`SELECT * FROM excluded ORDER BY id`);
  return cs.map(c => ({
    id: c.id, name: c.name, subtitle: c.subtitle || '', deadline: c.deadline || '',
    defaultBase: c.default_base == null ? 350 : Number(c.default_base),
    payerAliases: c.payer_aliases || [],
    schedule: ss.filter(s => s.customer_id === c.id).map(s => ({
      id: s.id, status: s.status, eta: s.eta, site: s.site, wo: s.wo, tk: s.tk,
      addr: s.addr, city: s.city, zip: s.zip, closes: s.closes,
      base: Number(s.base) || 0, travel: Number(s.travel) || 0, note: s.note || '',
    })),
    excluded: xs.filter(x => x.customer_id === c.id).map(x => ({ id: x.id, city: x.city, site: x.site, addr: x.addr })),
  }));
}
async function upsertCustomer(c) {
  await q(
    `INSERT INTO customers (id, name, subtitle, deadline, default_base, payer_aliases)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (id) DO UPDATE SET name=EXCLUDED.name, subtitle=EXCLUDED.subtitle,
       deadline=EXCLUDED.deadline, default_base=EXCLUDED.default_base, payer_aliases=EXCLUDED.payer_aliases`,
    [c.id, c.name, c.subtitle || '', c.deadline || '', c.defaultBase || 350, JSON.stringify(c.payerAliases || [])]
  );
}
async function deleteCustomer(id) { await q(`DELETE FROM customers WHERE id=$1`, [id]); }
async function upsertSite(customerId, s) {
  await q(
    `INSERT INTO sites (id, customer_id, status, eta, site, wo, tk, addr, city, zip, closes, base, travel, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (id) DO UPDATE SET status=EXCLUDED.status, eta=EXCLUDED.eta, site=EXCLUDED.site,
       wo=EXCLUDED.wo, tk=EXCLUDED.tk, addr=EXCLUDED.addr, city=EXCLUDED.city, zip=EXCLUDED.zip,
       closes=EXCLUDED.closes, base=EXCLUDED.base, travel=EXCLUDED.travel, note=EXCLUDED.note`,
    [s.id, customerId, s.status, s.eta, s.site, s.wo, s.tk, s.addr, s.city, s.zip, s.closes, s.base || 0, s.travel || 0, s.note || '']
  );
}
async function deleteSite(id) { await q(`DELETE FROM sites WHERE id=$1`, [id]); }
async function addExcluded(customerId, x) {
  const { rows } = await q(
    `INSERT INTO excluded (customer_id, city, site, addr) VALUES ($1,$2,$3,$4) RETURNING id`,
    [customerId, x.city, x.site, x.addr || '']
  );
  return rows[0].id;
}
async function removeExcluded(id) { await q(`DELETE FROM excluded WHERE id=$1`, [id]); }

/* ---- users ---- */
async function listUsers() {
  const { rows } = await q(`SELECT username, password, display_name AS "displayName", role FROM users ORDER BY username`);
  return rows;
}
async function upsertUser(u) {
  await q(
    `INSERT INTO users (username, password, display_name, role) VALUES ($1,$2,$3,$4)
     ON CONFLICT (username) DO UPDATE SET password=EXCLUDED.password, display_name=EXCLUDED.display_name, role=EXCLUDED.role`,
    [u.username, u.password, u.displayName || u.username, u.role || 'member']
  );
}
async function deleteUser(username) { await q(`DELETE FROM users WHERE username=$1`, [username]); }

module.exports = {
  enabled, init,
  listPayments, addPayment, paymentRefExists, paymentExistsByMessage, paymentsCount,
  getCustomers, upsertCustomer, deleteCustomer, upsertSite, deleteSite, addExcluded, removeExcluded,
  listUsers, upsertUser, deleteUser,
};
