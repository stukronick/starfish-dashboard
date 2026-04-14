// src/api.js — Frontend API client with syndicator support

const BASE = '/api';

export async function fetchSyndicators() {
  const resp = await fetch(`${BASE}/syndicators`);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  return data.syndicators || [];
}

export async function fetchPortfolio(syndicatorId) {
  const params = syndicatorId ? `?syndicatorId=${syndicatorId}` : '';
  const resp = await fetch(`${BASE}/portfolio${params}`);
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
