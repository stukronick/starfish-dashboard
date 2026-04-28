// src/api.js — Frontend API client with syndicator support
//
// Notes on timeouts:
//   /api/portfolio can take up to 60s on a cold cache (Vercel function
//   maxDuration is 60s; we pad the browser-side timeout to 90s to make
//   sure the browser doesn't abort before the function finishes).
//   Other endpoints are quick — 15s default.

const BASE = '/api';

// Wrap fetch with an AbortController-based timeout. If the request takes
// longer than `timeoutMs`, abort it and throw a clear error.
async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...options, signal: controller.signal });
    return resp;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Request timed out after ${timeoutMs / 1000}s — the API may be slow or unreachable`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchSyndicators() {
  const resp = await fetchWithTimeout(`${BASE}/syndicators`, {}, 15000);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.json();
  return data.syndicators || [];
}

export async function fetchPortfolio(syndicatorId) {
  const params = syndicatorId ? `?syndicatorId=${syndicatorId}` : '';
  // 90s timeout: server can take up to 60s (maxDuration in vercel.json),
  // plus network overhead + buffer for retries inside the function.
  const resp = await fetchWithTimeout(`${BASE}/portfolio${params}`, {}, 90000);
  if (!resp.ok) {
    const err = await resp.json().catch(() => ({ error: resp.statusText }));
    throw new Error(err.error || `HTTP ${resp.status}`);
  }
  return resp.json();
}

export async function fetchDeals(params = {}) {
  const qs = new URLSearchParams(params).toString();
  const resp = await fetchWithTimeout(`${BASE}/deals${qs ? '?' + qs : ''}`, {}, 15000);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

export async function fetchDealDetail(dealId) {
  const resp = await fetchWithTimeout(`${BASE}/deal-detail?dealId=${dealId}`, {}, 15000);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}
