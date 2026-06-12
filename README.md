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
- `server.js` — minimal Express static server
- Client libraries via CDN: SheetJS (xlsx), jsPDF + autotable

## Run locally

```bash
npm install
npm start
# http://localhost:3000
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
