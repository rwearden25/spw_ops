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
- `server.js` — a minimal Express static server. It serves the directory and falls back to `index.html` for any route. It contains no application logic and rarely needs changes.
- Third-party libraries (SheetJS/`xlsx`, jsPDF, jspdf-autotable) load from CDN `<script>` tags — they are **not** npm dependencies and there is no `node_modules` for the client.

### Data model (all in-memory, session-only)

The app holds a top-level `customers` array, seeded with hardcoded demo data inside `index.html`. Each customer is `{id, name, subtitle, deadline, defaultBase, schedule:[...], excluded:[...]}`. A `schedule` entry (a "site") is built by `mk(...)` and has fields: `status, eta, site, wo, tk, addr, city, zip, closes, base, travel, note`. `activeId` tracks the selected customer; `active()` resolves it.

**There is no backend or persistence.** All edits mutate the in-memory arrays. Exporting the Excel workbook is the only "save" — a reload discards everything. Do not add `localStorage`/server persistence assumptions without checking; the data-note in the UI explicitly tells users this.

### Render model

Mutations follow a re-render-everything pattern, not fine-grained DOM updates. After any change to the data, call `renderAll()`, which runs `renderHeader / renderKpis / renderWeek / renderTable / renderRevenue / renderExcluded`. Each `renderX()` rebuilds its section's `innerHTML` from the current data and **re-attaches event listeners** to the freshly created elements (see the `.status-sel` and `[data-edit]` handlers inside `renderTable`). `calc(c)` is the single source for all derived numbers (counts, revenue by status, totals) — KPIs, the progress bar, and the revenue cards all read from it.

### Status is the core enum

Four statuses drive the whole UI: `invoiced`, `completed`, `today`, `upcoming` — defined in `STATUS_META` and `STATUS_ORDER`. "Done" / completion percentage = `invoiced + completed`. The inline table dropdown and the PDF/Excel exports all map through these. When importing, free-text status values are coerced via `normStatus()`.

### Import / export

- **Import** (`mapImportRow` + `pick`): CSV/xlsx/xls parsed by SheetJS. Columns are matched by **normalized header name** (lowercased, non-alphanumerics stripped) against a list of accepted aliases per field — `pick(o,'site','sitenumber','store',...)`. Values are normalized through `toISO` (handles ISO, US `m/d/y`, and Excel serial dates), `normStatus`, and `toNum`. Rows without a `site` are dropped. Modes: append or replace.
- **Export**: `schedAoA(c)` / `summaryAoA(c)` produce the array-of-arrays that feed Excel (multi-sheet: Summary, Schedule, Excluded), CSV (Schedule only), and the jsPDF table. The import template, `schedAoA`, and `mapImportRow` share the same 12-column shape (Status, ETA, Site, Address, City, Zip, WO, Ticket, Closes, Rate, Travel, Note).

**Adding or renaming a site field is cross-cutting.** A new field generally must be touched in: `mk()` and the seed data, the site modal HTML + `openSiteModal` + the `sSaveBtn` handler, `renderTable`, `mapImportRow` (with header aliases), `schedAoA`, and the blank-template generator (`tmplBtn`). Keep these in sync.

## Important gotchas

- **"Today" is a hardcoded constant**, not the real date: `CONFIG.today = '2026-06-11'`. The "Next Up" highlight, PDF "Generated" stamp, and date parsing defaults all read this — they do **not** use `new Date()`. Update `CONFIG.today` rather than assuming live dates.
- **The login is a client-side demo gate only.** Username/password live in plain text in `CONFIG` (`admin` / `adminpasswd`) inside `index.html`, alongside all customer data. This is not real auth — never treat it as a security boundary, and do not put real customer/pricing data behind it on a public URL.
- IDs: in-session rows use `nid()` (`r1`, `r2`, …); customers added at runtime use `'c'+Date.now()`.
