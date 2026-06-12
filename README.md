# Field Service Operations

A single-file operations dashboard for managing multi-site service cycles. Multi-customer, fully editable in the browser, with two-way Excel/CSV interchange and PDF reporting.

## Features

- **Multi-customer** — switch programs from the header dropdown; add, edit, or delete customers in-app
- **Live KPIs** — site counts, completion bar, invoiced/outstanding/pipeline revenue, all recalculated on every edit
- **Inline editing** — status is a dropdown on every row; full row editing (dates, rates, fees, flags) via modal
- **Import** — CSV / .xlsx / .xls, header-matched columns, append or replace modes, downloadable blank template
- **Export** — Excel workbook (Summary, Schedule, Excluded sheets), CSV, formatted PDF report, print view
- **Filters** — status, city, travel-fee, and free-text search across site #, WO #, ticket #, address, zip

## Stack

- `index.html` — the entire application (vanilla JS, no build step)
- `server.js` — Express static server + the optional Outlook→ACH payments agent (Microsoft Graph) + `/api/*`
- Client libraries via CDN: SheetJS (xlsx), jsPDF + autotable

## Outlook ACH payments agent (optional)

The **Payments** section records ACH remittances (amount, date, customer) parsed from the bank's remittance `.csv`. You can import one by hand or let the agent pull them from Outlook automatically.

To enable the agent, register an app in your Microsoft 365 tenant (Entra ID → App registrations) with **application** permission `Mail.Read` (admin-consented), create a client secret, then set these env vars (Railway → service → Variables, or local `node --env-file=.env server.js`):

| Variable | Required | Purpose |
| --- | --- | --- |
| `GRAPH_TENANT_ID` | yes | Directory (tenant) ID |
| `GRAPH_CLIENT_ID` | yes | Application (client) ID |
| `GRAPH_CLIENT_SECRET` | yes | client secret value |
| `GRAPH_MAILBOX` | yes | mailbox to watch (e.g. `ops@…`) |
| `API_TOKEN` | to expose data | shared secret required to read `/api/payments`; without it the API is denied (403) |
| `ACH_FROM` | strongly recommended | **exact** sender allowlist, comma-separated (e.g. `vendor.hotline@brinker.com`) |
| `ACH_SUBJECT` | no | subject substring to match (default `Remit Advice`) |
| `ACH_REQUIRE_AUTH_RESULTS` | no | set `false` to skip DMARC verification (default on — recommended) |
| `POLL_INTERVAL_MS` | no | poll cadence (default `300000`, min `60000`) |

Without the `GRAPH_*` vars the agent stays off and the app runs as a plain static server.

**Security posture:** the agent only ingests mail that matches the exact `ACH_FROM` allowlist *and* passes DMARC (anti-spoofing); attachments are constrained to `.csv` and size-capped. `/api/payments` is **denied unless `API_TOKEN` is set** and the caller presents it (`Authorization: Bearer <token>`); `/api/status` reveals only whether the agent is on. Payer→customer matching is exact-allowlist only (no fuzzy substring) to avoid misattribution.

> **Still required before live financial data:** real per-user auth (the login is a client-side gate, so the API leans on a shared secret), and a **Postgres** datastore — server-side payments currently persist to `data/payments.json`, which is **ephemeral on Railway**.

## Database (Postgres)

Durable storage lives in `db.js` and is **off until `DATABASE_URL` is set** (the app runs fine without it on `localStorage` + the agent's JSON file). On Railway, add a **Postgres** plugin and it injects `DATABASE_URL`; the server then creates its schema (`users`, `customers`, `sites`, `excluded`, `payments`) on boot and persists **payments** there. Use the private `DATABASE_URL` (no SSL); for an external URL set `PGSSLMODE=require` (TLS stays verified). Migrating customers/schedule reads & writes is the next phase (needs server-side auth — see the security notice). See `.env.example`.

## Run locally

```bash
npm install
npm start
# http://localhost:3000

# with a local Postgres + agent config:
# node --env-file=.env server.js
```

## Deploy to Railway

1. Push this repo to GitHub
2. In Railway: **New Project → Deploy from GitHub repo** → select this repo
3. Railway auto-detects Node via Nixpacks and runs `node server.js` (pinned in `railway.json`)
4. Add a domain under **Settings → Networking → Generate Domain**

Or with the Railway CLI from the repo root:

```bash
railway init
railway up
```

## Demo credentials

| Username | Password      | Role   | Can do                                                    |
| -------- | ------------- | ------ | --------------------------------------------------------- |
| `admin`  | `adminpasswd` | Admin  | Everything, incl. add/rename/delete customers + manage users |
| `viewer` | `viewer`      | Member | View, switch customers, filter, open jobs, edit schedule rows |

Each user gets a **Profile & settings** panel (display name, accent color, density, default customer); admins also manage users there. Profiles and preferences persist in the browser's `localStorage`; customer/schedule data stays session-only (export to save it).

## ⚠️ Security notice

The login is a **client-side demo gate only**. Credentials and all data live in plain text in `index.html`, which is visible to anyone in a public repo or via browser dev tools. Do not put real customer data, work order numbers, or pricing behind it on a public URL. Before production use, replace the gate with real authentication (e.g. Supabase Auth) and move data to a backend.

Data entered in the browser is session-only — exporting the Excel workbook is the save mechanism.

## License

MIT
