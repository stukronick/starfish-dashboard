# Starfish Advance — Syndicator Analytics Dashboard

Production-ready MCA syndicator reporting dashboard powered by the SmartMCA Nexus API.

## Architecture

```
Browser (React + Recharts)
    ↓ /api/portfolio
Vercel Serverless Functions (Node.js)
    ↓ Bearer smca_live_***
SmartMCA Nexus API
```

**Security**: The SmartMCA API key lives only on the server (Vercel environment variables). The browser never sees it.

**Fallback**: If the API is unreachable, the dashboard displays sample data so stakeholders can still see the layout.

---

## Quick Start (Local Development)

```bash
# 1. Clone and install
git clone <your-repo>
cd starfish-dashboard
npm install

# 2. Create environment file
cp .env.example .env
# Edit .env and add your SmartMCA API key

# 3. Run the dev server
npm run dev
```

The app runs at `http://localhost:5173`. API calls proxy to Vercel Functions automatically.

> **Note**: Without a valid API key, the dashboard loads with sample/demo data.

---

## Deploy to Vercel

### Step 1: Push to GitHub
```bash
git init
git add .
git commit -m "Starfish Advance Syndicator Dashboard"
git remote add origin https://github.com/YOUR_ORG/starfish-dashboard.git
git push -u origin main
```

### Step 2: Connect to Vercel
1. Go to [vercel.com](https://vercel.com) and sign in
2. Click **"Add New Project"**
3. Import your GitHub repository
4. Vercel auto-detects Vite — no config needed

### Step 3: Add Environment Variables
In Vercel Dashboard → Your Project → **Settings** → **Environment Variables**:

| Name | Value | Environment |
|------|-------|-------------|
| `SMARTMCA_API_KEY` | `smca_live_your_key_here` | Production |
| `SMARTMCA_API_BASE` | `https://api.nexus.smartmca.com/api/public/v1` | Production |

### Step 4: Deploy
Click **Deploy**. Your dashboard is live at `https://your-project.vercel.app`

---

## SmartMCA API Key Setup

1. Log into SmartMCA platform
2. Go to **Settings → API Access → Request Access**
3. Create an API key with these scopes:
   - `deals:read` — List and view deals
   - `payments:read` — View payment history
   - `contacts:read` — List syndicators
   - `accounting:read` — View GL entries
   - `collections:read` — View collection schedules
4. Set entity binding to **Syndicator** (for syndicator-scoped view) or **Funder Admin** (for full portfolio)
5. Copy the key (shown once!) and add it to Vercel environment variables

---

## API Endpoints (Serverless Functions)

| Path | Description |
|------|-------------|
| `GET /api/portfolio` | Full dashboard data (deals, vintages, curves, summary) |
| `GET /api/deals?status=funded,servicing` | Raw deal list from SmartMCA |
| `GET /api/deal-detail?dealId=deal_xxx` | Single deal with payments |

All endpoints proxy to SmartMCA with the server-side API key.

---

## Project Structure

```
starfish-dashboard/
├── api/                          # Vercel Serverless Functions
│   ├── portfolio.js              # Main aggregation endpoint
│   ├── deals.js                  # Deal list proxy
│   └── deal-detail.js            # Deal detail proxy
├── src/
│   ├── App.jsx                   # Main dashboard (both pages)
│   ├── main.jsx                  # React entry point
│   ├── api.js                    # Frontend API client
│   ├── logo.js                   # Starfish Advance logo (base64)
│   ├── fallback-data.js          # Demo data (used when API unavailable)
│   └── hooks/
│       └── usePortfolio.js       # Data loading hook with fallback
├── index.html                    # HTML entry
├── package.json
├── vite.config.js
├── vercel.json                   # Vercel deployment config
├── .env.example                  # Environment variable template
└── README.md
```

---

## Calculation Engine

The `/api/portfolio.js` serverless function implements all formulas from the API Specification tab:

- **Deal Status**: Profit / Active / Default (30-day rule with 14-day grace period)
- **Syndicator Ownership %**: `syndicator_invested / deal.NET_FUNDED`
- **Vintage Analysis**: Monthly vintage grouping with collection %, exposure, default rate
- **Collection Curves**: Cumulative % and $ by month-on-book
- **Returns**: Net collections, unreturned principal, gross P&L

### Fields requiring ledger access
Some summary fields (external capital, deposits, withdrawals, cash balance, XIRR) require the `syndicator_report` ledger which is available through the full SmartMCA platform export. These fields show as 0 when using API-only data and should be populated when the syndicator ledger endpoint becomes available.

---

## Custom Domain

In Vercel Dashboard → **Settings** → **Domains**:
1. Add your domain (e.g., `analytics.starfishadvance.com`)
2. Update DNS per Vercel instructions
3. SSL is automatic

---

## Tech Stack

- **Frontend**: React 18 + Recharts + Vite
- **Backend**: Vercel Serverless Functions (Node.js)
- **API**: SmartMCA Nexus Public API v1.0
- **Styling**: Starfish Advance brand (Inria Sans, Ocean Blue/Peach palette)
- **Hosting**: Vercel (edge network, auto-scaling)
