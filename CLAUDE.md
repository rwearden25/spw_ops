# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install     # install Express (the only dependency)
npm start       # node server.js → serves on http://localhost:3000
```

There is **no build step, no test suite, no linter, and no bundler**. `npm start` is the only script. To work on the app, edit `index.html` and refresh the browser — nothing compiles or transpiles.

Deploy is to Railway (Nixpacks auto-detect, `node server.js` pinned in `railway.json`).

## Architecture

This is a **single-file client-side application**. Essentially all logic, markup, and styling live in `index.html` (~1100 lines). The rest of the repo is deployment scaffolding:

- `index.html` — the entire app: inline `<style>`, HTML for every view/modal, and one inline `<script>`. Vanilla JS, no framework.
- `server.js` — Express static server **plus the Outlook→ACH payments agent** (Microsoft Graph poller) and a small JSON API (`/api/status`, `/api/payments`). The agent is **dormant** unless the `GRAPH_*` env vars are set, so the app still runs as a pure static server without them.
- Third-party libraries (SheetJS/`xlsx`, jsPDF, jspdf-autotable) load from CDN `<script>` tags — they are **not** npm dependencies and there is no `node_modules` for the client.

### Data model

The app holds a top-level `customers` array, seeded with hardcoded demo data inside `index.html`. Each customer is `{id, name, subtitle, deadline, defaultBase, schedule:[...], excluded:[...]}`. A `schedule` entry (a "site") is built by `mk(...)` and has fields: `status, eta, site, wo, tk, addr, city, zip, closes, base, travel, note`. `activeId` tracks the selected customer; `active()` resolves it. There's also `payments[]` (ACH remittances) and `users[]`.

**Persistence is `localStorage`, keyed `STORE_KEY` (`fso_state_v1`), via `loadStore()` / `saveStore()`.** The store holds `{users, prefs, payments, customers, activeId}`. `saveStore()` is called at the end of `renderAll()`, so any customer/schedule/excluded edit survives a reload (this fixed a "renames revert on reload" bug — the seed data only loads when the store is empty). Excel export remains a separate manual snapshot.

> **This `localStorage` persistence is an interim, per-browser stopgap.** The intended durable store is **Postgres** (see the deferred-migration note at the bottom). When that lands, the client should load/save through the API and treat `localStorage` as a cache. Until then, edits don't sync across browsers/devices and clearing site data resets to seed.

### Users & roles

`users: [{username, password, displayName, role}]` with `role` ∈ `admin` | `member`. `currentUser` is set on login (`tryLogin` looks the user up in `users`); `isAdmin()` gates admin-only UI. Admin-only: add/rename/delete customers and the Users panel in the profile modal — gated by `applyRoleVisibility()` (toggles `editCustomerBtn` + every `.admin-only` element) and by `isAdmin()` checks in `renderHeader` (the "＋ Add customer" option). Members can still view, switch customers, filter, open job details, and edit schedule rows. `applyPrefs()` writes the chosen `ACCENTS[...]` preset to the `--accent*` CSS vars and toggles `body.compact`. Both run on login.

### Render model

Mutations follow a re-render-everything pattern, not fine-grained DOM updates. After any change to the data, call `renderAll()`, which runs `renderHeader / renderKpis / renderWeek / renderTable / renderRevenue / renderExcluded`. Each `renderX()` rebuilds its section's `innerHTML` from the current data and **re-attaches event listeners** to the freshly created elements (see the `.status-sel` and `[data-edit]` handlers inside `renderTable`). `calc(c)` is the single source for all derived numbers (counts, revenue by status, totals) — KPIs, the progress bar, and the revenue cards all read from it.

### Status is the core enum

Four statuses drive the whole UI: `invoiced`, `completed`, `today`, `upcoming` — defined in `STATUS_META` and `STATUS_ORDER`. "Done" / completion percentage = `invoiced + completed`. The inline table dropdown and the PDF/Excel exports all map through these. When importing, free-text status values are coerced via `normStatus()`.

### Import / export

- **Import** (`mapImportRow` + `pick`): CSV/xlsx/xls parsed by SheetJS. Columns are matched by **normalized header name** (lowercased, non-alphanumerics stripped) against a list of accepted aliases per field — `pick(o,'site','sitenumber','store',...)`. Values are normalized through `toISO` (handles ISO, US `m/d/y`, and Excel serial dates), `normStatus`, and `toNum`. Rows without a `site` are dropped. Modes: append or replace.
- **Export**: `schedAoA(c)` / `summaryAoA(c)` produce the array-of-arrays that feed Excel (multi-sheet: Summary, Schedule, Excluded), CSV (Schedule only), and the jsPDF table. The import template, `schedAoA`, and `mapImportRow` share the same 12-column shape (Status, ETA, Site, Address, City, Zip, WO, Ticket, Closes, Rate, Travel, Note).

**Adding or renaming a site field is cross-cutting.** A new field generally must be touched in: `mk()` and the seed data, the site modal HTML + `openSiteModal` + the `sSaveBtn` handler, `renderTable`, `mapImportRow` (with header aliases), `schedAoA`, and the blank-template generator (`tmplBtn`). Keep these in sync.

### Payments & the Outlook ACH agent

ACH payments arrive as **CSV attachments** on Outlook emails (e.g. Brinker's `RemittanceAdviceVirtualCard_*.csv`). The CSV is two stacked tables (a payment block headed `Payer,…,PaymentAmount,PaymentReferenceNumber,PaymentDate` then a transaction block with `AmountPaid`), and its dates are **`DD/MM/YYYY`** — handled by `payDate()` (distinct from the schedule importer's US `m/d/y` `toISO`). `parseRemittance(rows)` locates the `Payer` header row and reads the row beneath; `recordPayment()` dedupes (by reference, else payer+amount+date), matches the payer to a customer via `matchCustomer()`, and toasts.

This pipeline has **two feeds**:
1. **Manual / test** (client-side, works today): the Payments section's "Import remittance (.csv)" and "Simulate ACH email" buttons.
2. **The agent** (`server.js`, needs config): a Microsoft Graph poller using **application** permission `Mail.Read` (client-credentials). It polls the inbox, filters by subject/sender (`ACH_SUBJECT`/`ACH_FROM`), downloads the CSV, parses it with a **mirror** of the same parser, and stores to `/api/payments`. The client's `syncFromAgent()` polls `/api/status`; if `agentEnabled`, it pulls `/api/payments` and feeds each through `recordPayment(..., {silentDup:true})`.

Enable the agent with env vars: `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET`, `GRAPH_MAILBOX` (+ optional `ACH_FROM`, `ACH_SUBJECT`, `ACH_REQUIRE_AUTH_RESULTS`, `POLL_INTERVAL_MS`). **The parser exists in two places** (`index.html` and `server.js`) — keep them in sync. Server-side payments persist to `data/payments.json` (gitignored, **ephemeral on Railway** — another reason for the Postgres migration).

**Security model (financial data, hardened from a review):** the agent only ingests mail matching the *exact* `ACH_FROM` allowlist **and** passing DMARC (`senderAuthenticated()`, fail-closed); attachments must be `.csv` + size-capped; dedupe uses a never-fail-open key. `/api/payments` is **default-deny** — denied with 403 unless `API_TOKEN` is set, then requires `Authorization: Bearer <token>` (timing-safe compare); `/api/status` exposes only `{agentEnabled}` to the unauthenticated, and a coarse `lastErrorKind` (never the raw error) to the authenticated. `matchCustomer()` is exact-allowlist only (no substring) to prevent misattribution. These are stopgaps until real per-user auth lands with Postgres.

## Deferred: Postgres migration

The durable datastore is meant to be **Postgres** (Railway plugin → `DATABASE_URL`), replacing both the client `localStorage` store and the server's `data/payments.json`. Scope when picked up: add `pg`, a schema (customers, sites, excluded, payments, users), backend CRUD routes, and refactor the client to read/write via the API instead of in-memory arrays. Blocked on the app being deployed to Railway with a Postgres plugin provisioned.

## Important gotchas

- **"Today" is a hardcoded constant**, not the real date: `CONFIG.today = '2026-06-11'`. The "Next Up" highlight, PDF "Generated" stamp, and date parsing defaults all read this — they do **not** use `new Date()`. Update `CONFIG.today` rather than assuming live dates.
- **The login is a client-side demo gate only.** Seed credentials are plaintext in `SEED_USERS` (`admin`/`adminpasswd`, `viewer`/`viewer`) inside `index.html`, and runtime-added users (with passwords) persist in plaintext to `localStorage`. The role check is purely client-side — anyone can bypass it via dev tools. This is not real auth; never treat it as a security boundary, and don't put real customer/pricing data behind it on a public URL.
- The four KPI tiles and the Next Up cards are interactive: KPI tiles call `KPI_NAV[...]` → `gotoSection()` (open + filter + scroll a `<details>` by id: `#secSchedule`/`#secRevenue`/`#secExcluded`); Next Up cards call `openJobModal()`. If you rename those section ids or KPI `data-kpi` keys, update `KPI_NAV`.
- IDs: in-session rows use `nid()` (`r1`, `r2`, …); customers added at runtime use `'c'+Date.now()`.
