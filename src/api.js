// src/api.js — Frontend API client
// All calls go to /api/* which Vercel routes to serverless functions
// The API key never touches the browser

const BASE = '/api';

export async function fetchPortfolio() {
  const resp = await fetch(`${BASE}/portfolio`);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function fetchDeals(params = {}) {
  const qs = new URLSearchParams(params).toString();
  const resp = await fetch(`${BASE}/deals${qs ? '?' + qs : ''}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

export async function fetchDealDetail(dealId) {
  const resp = await fetch(`${BASE}/deal-detail?dealId=${dealId}`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}
