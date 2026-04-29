// Vercel Serverless Function: /api/portfolio
//
// DATA ARCHITECTURE (post-discovery, Apr 2026):
//   The dashboard reads from three SmartMCA endpoints:
//
//   1. /deals + /deals/{id}        — Each deal's `syndications` array
//                                    contains LMJS's exact slice (fundedAmount,
//                                    cashCollected, cashExposure). Sum across
//                                    deals for total invested / collected.
//                                    No proportional approximation.
//
//   2. /deals/{id}/payments        — Per-deal payment records typed as
//                                    merchantPayment, refinancePayoff,
//                                    balanceTransferIn/Out, fee. Scaled by the
//                                    syndicator's investmentPercentage on
//                                    each deal to get their share.
//
//   3. /accounting/reports/subledger/syndicator/{id}
//                                    — Cash flows: deposits, withdrawals,
//                                    investments. The fee entries the
//                                    spreadsheet shows (Management Fee Paid
//                                    One Time, Fee Paid Per Transaction)
//                                    are NOT exposed in any current API
//                                    endpoint. Derived from per-syndicator
//                                    rate config until that changes.
//
// Spreadsheet formulas this matches (syndicator_report_base.xlsx):
//     Cash Balance         = Deposits - Investments + Collections - Fees - Withdrawals
//     Unreturned Principal = Total Invested - Gross Collections
//     Total Value          = Withdrawals + Cash Balance + Unreturned
//     Net Profit           = Total Value - External Capital
//     Cash-on-Cash         = Total Value / External Capital
//
// Fee categorization (two line items, by transaction type):
//     Management Fees (One-Time)    = syndInvested × managementFeeRate (config)
//     Fee Paid (Per Transaction)    = totalGrossCollections × residualCommissionRate (config)
//   Per-syndicator rates live in SYNDICATOR_FEE_CONFIG below. When the API
//   eventually exposes ledger-observed fees, the code prefers those.
//
// Sources:
//     GET /deals?limit=100&page=N           (paginated list of all deals)
//     GET /deals/{internalId}               (full deal record with syndications array)
//     GET /deals/{internalId}/payments      (per-deal collection events)
//     GET /contacts?limit=100               (response: { data: { data: [...] } } or { data: [...] })
//     GET /accounting/reports/subledger/syndicator/{id}?limit=10000  (cash flows)

// ============================================================================
// IN-MEMORY CACHE (module-scoped, persists across warm invocations)
//   Vercel serverless functions retain module state between invocations on the
//   same warm instance. We use a Map keyed by upstream URL path, with a 5-min
//   TTL. Cold starts and concurrent instances each get their own cache — that
//   is OK at this scale.
//
//   Retry semantics:
//     - Network errors (fetch threw) and 5xx responses → retry up to 3x with
//       exponential backoff (100ms, 300ms, 900ms before each retry).
//     - 4xx responses (auth, not-found, bad-request) → fail immediately.
//       These are deterministic errors that won't resolve by retrying.
//     - 429 (rate limit) → retry with LONG backoff (30s+) since the rate
// ============================================================================
// CACHE: TWO-TIER (in-memory + Vercel KV)
//
//   Tier 1 — in-memory (Map): sub-ms reads, lives only for this function
//   instance's warm period (~5-15 min idle, killed on deploy/scaling).
//
//   Tier 2 — Vercel KV: ~5-15ms reads, persists across instances and deploys.
//   Survives function restarts; survives the SmartMCA rate-limit window.
//   This tier is what makes cold loads fast — a fresh function instance
//   inherits the cache from previous runs.
//
//   Lookup order: memory → KV → upstream. Upstream populates both tiers.
//
//   TTL by path (chosen so users see numbers no more than ~30min stale,
//   while minimizing upstream load):
//     /deals/{id} for closed/defaulted deals       → 24h (data is frozen)
//     /deals/{id}/payments for closed/defaulted    → 24h
//     /deals/{id} for active deals                 → 30min
//     /deals/{id}/payments for active deals        → 30min
//     /deals?... (list)                            → 30min
//     /contacts?...                                → 1h
//     /accounting/reports/subledger/...            → 5min (cash flows live)
//     unknown                                      → 30min default
//
//   Status-based TTL upgrade: when we first fetch a deal, we don't yet know
//   if it's closed. We cache with the conservative (active) TTL. After the
//   deal record arrives, getAllDeals upgrades closed-deal entries to 24h
//   via a second KV write.
//
//   KV is wired through @vercel/kv. If env vars aren't set (local dev
//   without KV configured, or KV unreachable), all KV operations no-op
//   silently and we fall back to the in-memory tier alone.
//
//   Bypass: append ?nocache=1 to skip both tiers and force a fresh fetch.
// ============================================================================

// Optional KV import — wrapped so the module loads even if @vercel/kv isn't
// installed or env vars aren't configured.
let kvClient = null;
let kvAvailable = false;
async function initKv() {
  if (kvClient !== null) return; // already attempted
  try {
    if (!process.env.KV_REST_API_URL || !process.env.KV_REST_API_TOKEN) {
      kvClient = false;
      return;
    }
    const mod = await import('@vercel/kv');
    kvClient = mod.kv;
    kvAvailable = true;
  } catch (err) {
    // Package not installed or import failed — fall through to in-memory only
    kvClient = false;
    kvAvailable = false;
  }
}

const TTL = {
  ACTIVE_DEAL: 30 * 60,           // 30 min in seconds (KV uses seconds)
  CLOSED_DEAL: 24 * 60 * 60,      // 24 hours
  DEAL_LIST: 30 * 60,             // 30 min
  CONTACTS: 60 * 60,              // 1 hour
  SUBLEDGER: 5 * 60,              // 5 min
  DEFAULT: 30 * 60,               // 30 min
};

// Pick TTL (in seconds) based on path. For deal-specific paths we don't
// yet know status — getAllDeals will upgrade closed ones via setKv after.
function pickTtlSeconds(path) {
  if (path.startsWith('/deals?')) return TTL.DEAL_LIST;
  if (/^\/deals\/[^/]+\/payments/.test(path)) return TTL.ACTIVE_DEAL; // upgraded later
  if (/^\/deals\/[^/?]+$/.test(path)) return TTL.ACTIVE_DEAL;          // upgraded later
  if (path.startsWith('/contacts?')) return TTL.CONTACTS;
  if (path.includes('/accounting/reports/subledger/')) return TTL.SUBLEDGER;
  return TTL.DEFAULT;
}

// In-memory tier (unchanged from before)
const cache = new Map(); // path -> { value, expiresAt (ms epoch), fetchedAt (ms epoch) }
let cacheStats = {
  hits: 0, misses: 0, bypasses: 0, retries: 0, fails: 0,
  rateLimitWaits: 0, rateLimitWaitMs: 0,
  kvHits: 0, kvMisses: 0, kvWrites: 0, kvErrors: 0,
};

async function getKv(path) {
  await initKv();
  if (!kvAvailable) return null;
  try {
    const value = await kvClient.get(path);
    if (value !== null && value !== undefined) {
      cacheStats.kvHits++;
      return value;
    }
    cacheStats.kvMisses++;
    return null;
  } catch (err) {
    cacheStats.kvErrors++;
    return null;
  }
}

async function setKv(path, value, ttlSeconds) {
  await initKv();
  if (!kvAvailable) return;
  try {
    await kvClient.set(path, value, { ex: ttlSeconds });
    cacheStats.kvWrites++;
  } catch (err) {
    cacheStats.kvErrors++;
  }
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [200, 800, 2000]; // baseline backoff for 5xx/network errors
const RATE_LIMIT_BACKOFF_MS = 31000; // wait full minute window when 429 hit (server slate clean)

// Sliding-window rate limiter (50 requests per 60 seconds).
// Holds timestamps of the last N upstream fetches. Before each new fetch,
// if N timestamps are within the last 60s, wait until the oldest expires.
const RATE_LIMIT_MAX = 50;
const RATE_LIMIT_WINDOW_MS = 60 * 1000;
const requestTimestamps = []; // sorted: oldest first

async function acquireRateLimitToken() {
  while (true) {
    const now = Date.now();
    // Prune timestamps older than the window
    while (requestTimestamps.length > 0 && requestTimestamps[0] <= now - RATE_LIMIT_WINDOW_MS) {
      requestTimestamps.shift();
    }
    if (requestTimestamps.length < RATE_LIMIT_MAX) {
      requestTimestamps.push(now);
      return;
    }
    // Bucket full. Sleep until the oldest token ages out, then re-check.
    const waitMs = requestTimestamps[0] + RATE_LIMIT_WINDOW_MS - now + 50; // +50ms safety
    cacheStats.rateLimitWaits++;
    cacheStats.rateLimitWaitMs += waitMs;
    await sleep(waitMs);
    // Loop and re-check (in case multiple workers were waiting on the same slot)
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function cachedApiFetch(path, apiKey, apiBase, { bypass = false } = {}) {
  const now = Date.now();

  if (!bypass) {
    // Tier 1: in-memory
    const entry = cache.get(path);
    if (entry && entry.expiresAt > now) {
      cacheStats.hits++;
      return { data: entry.value, cached: true, tier: 'memory', ageSec: Math.floor((now - entry.fetchedAt) / 1000) };
    }

    // Tier 2: Vercel KV
    const kvHit = await getKv(path);
    if (kvHit !== null) {
      // Repopulate in-memory tier so subsequent calls in this request are fast.
      // Use a short in-memory expiry (1 min) — KV is the source of truth for
      // cross-instance correctness, and we don't know exactly how much time
      // the KV entry has left, so we re-validate via KV after that minute.
      const inMemTtl = 60 * 1000;
      cache.set(path, { value: kvHit, fetchedAt: now, expiresAt: now + inMemTtl });
      return { data: kvHit, cached: true, tier: 'kv', ageSec: 0 };
    }
  } else {
    cacheStats.bypasses++;
  }

  // Tier 3: upstream API. Retry loop with rate limiting and exponential backoff.
  let lastError = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    if (attempt > 0) {
      cacheStats.retries++;
      const isRateLimited = lastError && lastError.status === 429;
      const backoff = isRateLimited ? RATE_LIMIT_BACKOFF_MS : BACKOFF_MS[attempt - 1];
      await sleep(backoff);
    }
    await acquireRateLimitToken();
    try {
      const resp = await fetch(`${apiBase}${path}`, {
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      });
      if (resp.ok) {
        const value = await resp.json();
        const ttlSeconds = pickTtlSeconds(path);
        const fetchTime = Date.now();
        // Write to in-memory tier first (sync)
        cache.set(path, { value, fetchedAt: fetchTime, expiresAt: fetchTime + ttlSeconds * 1000 });
        // Await the KV write so the entry is durably persisted before this
        // request returns. This adds ~5-15ms per cache miss but eliminates
        // race conditions with subsequent code paths (e.g. the closed-deal
        // TTL upgrade in getAllDeals) that need the write to be settled.
        // setKv internally swallows errors so it never throws.
        await setKv(path, value, ttlSeconds);
        cacheStats.misses++;

        // In-memory tier eviction (KV handles its own expiry)
        if (cache.size > 200) {
          const oldestKey = [...cache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)[0][0];
          cache.delete(oldestKey);
        }
        return { data: value, cached: false, tier: 'upstream', ageSec: 0 };
      }

      const errBody = await resp.text();
      lastError = new Error(`${resp.status} on ${path}: ${errBody}`);
      lastError.status = resp.status;

      if (!RETRYABLE_STATUS.has(resp.status)) {
        break;
      }
    } catch (err) {
      lastError = err;
    }
  }

  cacheStats.fails++;
  throw lastError || new Error(`fetch failed after ${MAX_ATTEMPTS} attempts: ${path}`);
}

// Upgrade a cached deal's TTL to 24h once we know it's closed/defaulted.
// Called from getAllDeals after deal detail is in hand.
async function upgradeDealTtlIfClosed(internalId, dealRecord) {
  if (!dealRecord) return;
  const status = dealRecord.status;
  if (status !== 'closed' && status !== 'defaulted') return;

  const dealPath = `/deals/${internalId}`;
  const paymentsPath = `/deals/${internalId}/payments?limit=200`;

  // Re-write the deal detail with longer TTL. We pass the value we already
  // have rather than re-fetching.
  await setKv(dealPath, { data: dealRecord }, TTL.CLOSED_DEAL).catch(() => {});

  // Payments TTL upgrade: only if we have it in memory or KV
  const paymentsInMem = cache.get(paymentsPath);
  if (paymentsInMem) {
    await setKv(paymentsPath, paymentsInMem.value, TTL.CLOSED_DEAL).catch(() => {});
  }
}

// ============================================================================
// BOUNDED-CONCURRENCY MAP
//   Like Promise.all(items.map(fn)) but caps the number of in-flight calls.
//   Critical for our fan-out architecture: 37 deal-detail + 37 payment fetches
//   blasted in parallel overwhelms both the upstream API and our serverless
//   function instance. Concurrency=6 keeps the pipeline saturated without
//   triggering connection-pool exhaustion or rate limits.
//
//   Failures are isolated to the individual item — one fetch failing doesn't
//   abort the rest. Returns { value, error } pairs so the caller can decide
//   how to handle partial results.
// ============================================================================
async function pMap(items, fn, concurrency = 6) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= items.length) return;
      try {
        results[i] = { value: await fn(items[i], i), error: null };
      } catch (err) {
        results[i] = { value: null, error: err };
      }
    }
  }

  // Spawn `concurrency` workers; each pulls from the shared queue until empty
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

// ============================================================================
// PER-SYNDICATOR FEE CONFIG
//   Fee rates are not exposed by any current API endpoint. Until they are,
//   define them here. Add new syndicators as their rates become known.
//   _default is used when a syndicator has no explicit entry.
// ============================================================================
const SYNDICATOR_FEE_CONFIG = {
  // LMJS — rates back-computed from spreadsheet totals (2026-04-27 snapshot):
  //   $37,569.30 mgmt fees / $424,365 funded → 8.8531%
  //   $16,152.71 residuals / $313,436.70 collections → 5.1534%
  // These are TEMPORARY values until LMJS confirms their actual contractual
  // rates with SmartMCA. The 8.85% is unusual (not a round number); likely
  // either (a) a different denominator than total funded is used in the
  // spreadsheet, or (b) the rate is applied selectively (excluding some
  // deal types). Worth resolving before treating these as canonical.
  'cmo8qi0pj00vy01masnzahelz': {
    name: 'LMJS',
    managementFeeRate: 0.088531,
    residualCommissionRate: 0.051534,
  },
  _default: {
    managementFeeRate: 0.12,
    residualCommissionRate: 0.05,
  },
};

function getFeeConfig(syndicatorId) {
  return SYNDICATOR_FEE_CONFIG[syndicatorId] || SYNDICATOR_FEE_CONFIG._default;
}

export default async function handler(req, res) {
  const API_KEY = process.env.SMARTMCA_API_KEY;
  const API_BASE = process.env.SMARTMCA_API_BASE || 'https://api.staging.v3.smartmca.com/api/public/v1';

  res.setHeader('Access-Control-Allow-Origin', '*');
  // Browser-side cache for 5 minutes (private = don't cache on shared proxies).
  // This means a single user clicking around won't even hit our function;
  // the browser will serve from its own cache for repeated identical requests.
  res.setHeader('Cache-Control', 'private, max-age=300');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!API_KEY) return res.status(500).json({ error: 'SMARTMCA_API_KEY not configured.' });

  const { syndicatorId, nocache } = req.query;
  const bypass = nocache === '1' || nocache === 'true';

  // Per-request fetch tracker: which paths were hit, were they cached, ages,
  // and which tier served them (memory / kv / upstream).
  const fetchTrace = [];
  async function apiFetch(path) {
    const result = await cachedApiFetch(path, API_KEY, API_BASE, { bypass });
    fetchTrace.push({
      path,
      cached: result.cached,
      tier: result.tier || 'upstream',
      ageSec: result.ageSec,
    });
    return result.data;
  }

  function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
  function round2(v) { return Math.round(v * 100) / 100; }
  function toVintage(d) {
    if (!d) return '';
    const dt = new Date(d);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
  }

  // Per-request failure tracker: deals that couldn't be hydrated, and any
  // payment fetches that failed. Surfaced in _debug so degradation is visible.
  const fetchFailures = { deals: [], payments: [] };

  // ==========================================================================
  // 1. FETCH ALL DEALS
  //    The /deals?limit=100&page=N list endpoint returns a "shell" deal
  //    record without the syndications array. The full deal record (returned
  //    by /deals/{id}) DOES include syndications. We need that array to
  //    compute per-syndicator funded/collected exactly, so we batch-fetch
  //    detail for every deal.
  //
  //    Concurrency-bounded via pMap (default 6) to avoid overwhelming the
  //    upstream API on cold-cache requests. Each individual fetch retries up
  //    to 3 times with backoff (in cachedApiFetch). Failures fall back to
  //    the shell record AND get logged in fetchFailures.deals so the caller
  //    can see which deals contributed degraded data.
  // ==========================================================================
  async function getAllDeals() {
    // Step 1: get the shell list (paginated)
    const shells = [];
    let page = 1;
    while (true) {
      const r = await apiFetch(`/deals?limit=100&page=${page}`);
      if (r.data) shells.push(...r.data);
      if (!r.meta?.pagination || page >= r.meta.pagination.totalPages) break;
      page++;
    }

    // Step 2: hydrate each deal with the full record (which includes syndications)
    // Concurrency=3: with the 50/min rate limit, cranking workers higher just
    // means more of them parked waiting on the rate-limit token bucket. 3 is
    // enough to keep the bucket draining steadily.
    const results = await pMap(shells, async (shell) => {
      const full = await apiFetch(`/deals/${shell.id}`);
      return full.data || full;
    }, 3);

    // Stitch results: use full record where available, shell where not.
    const stitched = results.map((res, i) => {
      if (res.error) {
        fetchFailures.deals.push({
          dealId: shells[i].dealId,
          internalId: shells[i].id,
          error: res.error.message,
        });
        return shells[i]; // fall back to shell (no syndications)
      }
      return res.value;
    });

    // After we know each deal's status, upgrade closed/defaulted deals in
    // KV to a 24h TTL. We await this (rather than fire-and-forget) because
    // racing with the initial setKv from cachedApiFetch is non-deterministic
    // — last-writer-wins, and we need the upgrade to win. Cost is small:
    // at most a handful of KV set calls, run in parallel.
    try {
      await Promise.all(stitched.map(deal => upgradeDealTtlIfClosed(deal.id, deal)));
    } catch { /* best-effort optimization, swallow errors */ }

    return stitched;
  }

  // Find a specific syndicator's slice of a deal. Returns null if the
  // syndicator doesn't participate in this deal.
  function extractSyndicationFor(deal, syndicatorId) {
    if (!deal.syndications || !syndicatorId) return null;
    return deal.syndications.find(s => s.syndicatorId === syndicatorId) || null;
  }

  // ==========================================================================
  // 2. MAP DEAL  (SmartMCA shape -> dashboard shape)
  //    When syndication is provided, output reflects that syndicator's slice
  //    of the deal (their funded amount, collected amount, exposure). When
  //    null, output is business-level (full deal numbers).
  // ==========================================================================
  function mapDeal(d, syndication) {
    const bizFunded = num(d.fundedAmount);
    const bizNetFunded = num(d.netFunded);
    const bizRtr = num(d.purchaseAmount);
    const bizCollected = num(d.totalCollected);
    const bizOutstanding = num(d.outstandingBalance);
    const bizExposure = num(d.currentExposure);
    const bizPnl = num(d.pAndL);
    const bankFees = num(d.bankFees) + num(d.otherFees);
    const factor = num(d.paybackFactor);
    const vintage = toVintage(d.fundedDate);

    // Per-syndicator slice (if applicable)
    const syndFunded = syndication ? num(syndication.fundedAmount) : 0;
    const syndCollected = syndication ? num(syndication.cashCollected) : 0;
    const syndExposure = syndication ? num(syndication.cashExposure) : 0;
    const syndPct = syndication ? num(syndication.investmentPercentage) / 100 : 0;
    // P&L for the syndicator: their share of biz-level P&L using their pct
    const syndPnl = syndication ? round2(bizPnl * syndPct) : 0;
    // Outstanding scaled by the syndicator's percentage
    const syndOutstanding = syndication ? round2(bizOutstanding * syndPct) : 0;

    let status;
    if (d.status === 'defaulted') status = 'Default';
    else if (d.status === 'closed') status = 'Profit';
    else status = 'Active';

    // Choose which numbers to surface based on whether we have a syndication.
    // Frontend deal-table fields (invested, collected, netReturn) reflect the
    // syndicator's slice when one is selected.
    const invested = syndication ? round2(syndFunded) : round2(bizFunded);
    const collected = syndication ? round2(syndCollected) : round2(bizCollected);
    const netReturn = syndication ? syndPnl : round2(bizPnl);
    const dollarRemaining = status === 'Profit' ? 'Paid Off'
      : syndication ? syndOutstanding : round2(bizOutstanding);

    return {
      dealNo: d.dealId || '',
      internalId: d.id || '',
      merchant: d.merchantName || '',
      merchantState: d.merchantState || '',
      // Per-syndicator OR biz-level (depending on context)
      invested,
      collected,
      feesPaid: round2(bankFees),
      netReturn,
      roi: invested > 0 ? round2(netReturn / invested) : 0,
      status,
      pmtsRemaining: status === 'Profit' ? 'Paid Off' : status === 'Default' ? 0 : '—',
      dollarRemaining,
      frequency: status === 'Profit' ? 'Paid Off' : status === 'Default' ? '-' : 'Daily',
      vintage,
      // Always-business-level fields (used in cross-deal aggregations)
      netFunded: round2(bizNetFunded),
      rtr: round2(bizRtr),
      totalCollectedBiz: round2(bizCollected),
      exposureBiz: round2(bizExposure),
      paybackFactor: factor,
      brokerName: d.brokerName || '',
      isoName: d.iso?.isoName || '',
      score: d.scoreData?.score || 0,
      grade: d.scoreData?.grade || '',
      fundedDate: d.fundedDate || '',
      // Per-syndicator metadata (helpful for debug + future per-deal views)
      syndPct: syndication ? round2(syndPct) : 0,
      syndFunded: round2(syndFunded),
      syndCollected: round2(syndCollected),
      syndExposure: round2(syndExposure),
    };
  }

  // ==========================================================================
  // 3. PARSE SUBLEDGER  (only what is still present: deposits, withdrawals,
  //                      investments). Collections + fees come from deals.
  // ==========================================================================
  function parseSubledger(entries) {
    // Cash-flow side: filter to the syndicator-liability account. This is the
    // account that carries deposits/withdrawals/investments today.
    const ledger = entries.filter(e => e.account === 'Syndicator Distributions Payable');

    let externalCapital = 0;       // new capital deposits
    let reinvestedReturns = 0;     // recycled payouts / reinvestments
    let feeRefunds = 0;            // fee refund credits
    let totalWithdrawals = 0;      // payouts to syndicator
    let totalInvestmentsLedger = 0; // capital deployed to deals (cash-flow truth)
    let earliestDepositDate = null; // for period.start

    const flowsByDate = {}; // for XIRR
    const dailyFlows = {};  // for cash flow chart

    // NEW: keep per-entry external deposits AND withdrawals so XIRR can use
    // them with their actual dates. Previously we aggregated everything
    // into flowsByDate which mixed external-capital deposits and
    // reinvestment deposits together.
    const externalDeposits = []; // [{ date, amount }] — only EXTERNAL capital
    const withdrawalEntries = []; // [{ date, amount }] — actual paybacks to syndicator

    for (const e of ledger) {
      const desc = (e.description || '').toLowerCase();
      const date = (e.date || '').slice(0, 10);
      const credit = e.credit || 0;
      const debit = e.debit || 0;

      if (!dailyFlows[date]) {
        dailyFlows[date] = { deposits: 0, withdrawals: 0, investments: 0 };
      }

      if (desc.includes('syndicator deposit:')) {
        if (desc.includes('reinvest') || desc.includes('payout')) {
          reinvestedReturns += credit;
        } else if (desc.includes('refund')) {
          feeRefunds += credit;
        } else {
          // EXTERNAL capital deposit — track date+amount for IRR
          externalCapital += credit;
          externalDeposits.push({ date, amount: round2(credit) });
          if (!earliestDepositDate || date < earliestDepositDate) {
            earliestDepositDate = date;
          }
        }
        dailyFlows[date].deposits += credit;
        flowsByDate[date] = (flowsByDate[date] || 0) - credit; // negative = cash in

      } else if (desc.includes('syndicator withdrawal:')) {
        totalWithdrawals += debit;
        withdrawalEntries.push({ date, amount: round2(debit) });
        dailyFlows[date].withdrawals += debit;
        flowsByDate[date] = (flowsByDate[date] || 0) + debit;  // positive = cash out

      } else if (desc.includes('syndicator investment:')) {
        totalInvestmentsLedger += credit;
        dailyFlows[date].investments += credit;
      }
    }

    // Fee side: scan ALL entries (any account) for fee-bearing rows. Today's
    // staging API returns 0 of these; the spreadsheet's syndicator_report has
    // them tagged by Transaction Type. We sum each type into its own line:
    //
    // Two line items, named after the API's transaction types:
    //   - "Management Fees (One-Time)"   = SUM(txType = 'Management Fee Paid (One Time)')
    //   - "Fee Paid (Per Transaction)"   = SUM(txType = 'Fee Paid (Per Transaction)')
    //
    // Spreadsheet ground truth (2026-04-27 LMJS dataset):
    //   Management Fees (One-Time)   = $37,569.30  (36 rows)
    //   Fee Paid (Per Transaction)   = $16,152.71  (919 rows of mixed descriptions —
    //                                              residual commissions, per-collection
    //                                              mgmt fees, misc adjustments — all
    //                                              summed together by transaction type)
    //
    // The JSON field name 'residualCommissionsLedger' is preserved for backward
    // compatibility with the frontend contract, but the value it holds is the
    // total of ALL per-transaction fees, not just residual commissions.
    let mgmtFeesLedger = 0;
    let residualCommissionsLedger = 0; // misnomer: actually all 'Fee Paid (Per Transaction)' rows
    let mgmtFeeCount = 0;
    let residualCount = 0; // misnomer: actually all per-transaction fee row count

    // NEW: capture per-entry fee data with dates so XIRR can include them as
    // negative flows (LMJS pays fees → reduces their economic return).
    // Empty on staging today (SmartMCA returns 0 fee entries) but ready for
    // when the upstream subledger is rebuilt.
    const feeEntries = []; // [{ date, amount, type }]

    for (const e of entries) {
      const desc = (e.description || '');
      const txType = e.transactionType || e.type || '';
      const date = (e.date || '').slice(0, 10);
      const amt = (e.debit || 0) + (e.credit || 0); // fees are usually debits, but be tolerant

      // One-time management fee — tagged by transaction type. The fallback
      // pattern 'upfront sales commission' covers the case where the API
      // returns no transactionType field but uses this description label.
      if (txType === 'Management Fee Paid (One Time)' ||
          /upfront\s+sales\s+commission/i.test(desc)) {
        mgmtFeesLedger += amt;
        mgmtFeeCount++;
        if (date && amt > 0) feeEntries.push({ date, amount: round2(amt), type: 'Management Fee' });
        continue;
      }

      // Per-transaction fees — summed regardless of description (residual
      // commissions, per-collection mgmt fees, and misc adjustments all land
      // here, matching the spreadsheet's by-transaction-type summing).
      if (txType === 'Fee Paid (Per Transaction)') {
        residualCommissionsLedger += amt;
        residualCount++;
        if (date && amt > 0) feeEntries.push({ date, amount: round2(amt), type: 'Per-Transaction Fee' });
      }
    }

    // Avoid double-counting: if fee entries are present in the subledger, the
    // accountSide=='Syndicator Distributions Payable' filter above may have
    // already counted them as investments/withdrawals. We don't have evidence
    // either way from staging (where entries are zero). Flag both sides so the
    // caller can choose which to trust via _debug.
    return {
      externalCapital: round2(externalCapital),
      reinvestedReturns: round2(reinvestedReturns),
      feeRefunds: round2(feeRefunds),
      totalDeposits: round2(externalCapital + reinvestedReturns + feeRefunds),
      totalWithdrawals: round2(totalWithdrawals),
      totalInvestmentsLedger: round2(totalInvestmentsLedger),
      // Fee-side data (present when subledger is fully rebuilt; zero today)
      mgmtFeesLedger: round2(mgmtFeesLedger),
      residualCommissionsLedger: round2(residualCommissionsLedger),
      mgmtFeeCount,
      residualCount,
      hasLedgerFees: mgmtFeeCount > 0 || residualCount > 0,
      earliestDepositDate,
      flowsByDate,
      dailyFlows,
      // NEW: per-entry detail used by buildFlows to construct the cleaner
      // single-XIRR series. externalDeposits and withdrawalEntries replace
      // the previous flowsByDate aggregation for IRR purposes (flowsByDate
      // is kept for the cash flow chart, which still wants daily aggregation).
      externalDeposits,
      withdrawalEntries,
      feeEntries,
      entryCount: ledger.length,
      totalEntryCount: entries.length,
    };
  }

  // ==========================================================================
  // 4. AGGREGATE SYNDICATOR METRICS FROM PER-DEAL SYNDICATION DATA
  //    The API's deal records contain a `syndications` array with each
  //    syndicator's exact slice (fundedAmount, cashCollected, cashExposure,
  //    investmentPercentage). We sum these directly — no proportional
  //    approximation.
  //
  //    For collection breakdown (merchantPayment / refinancePayoff /
  //    balanceTransferIn / balanceTransferOut) we fetch /deals/{id}/payments
  //    per deal and scale by the syndicator's percentage on that deal.
  //
  //    Fees are still derived (12% mgmt, 5% residual by default) because
  //    the API's syndication.managementFeeAmount and commissionPercentage
  //    fields are zero/null across all observed deals. Per-syndicator rates
  //    in SYNDICATOR_FEE_CONFIG will produce an exact spreadsheet match
  //    when configured correctly.
  // ==========================================================================
  async function aggregateSyndicatorMetrics(deals, syndicatorId, feeConfig, sub, fetchPayments) {
    if (!syndicatorId) return null;

    let syndInvested = 0;       // sum of LMJS's per-deal fundedAmount
    let syndCollected = 0;      // sum of LMJS's per-deal cashCollected
    let syndExposure = 0;       // sum of LMJS's per-deal cashExposure
    let dealsParticipated = 0;  // count of deals where LMJS participates
    const perDealShares = [];   // per-deal {dealId, pct} for collection breakdown

    for (const deal of deals) {
      const synd = extractSyndicationFor(deal, syndicatorId);
      // Skip if no syndication record OR zero-stake (sometimes syndicators
      // are listed in the array with fundedAmount=0; not real participation).
      // Treating these as participating would inflate counts and pollute
      // vintages/curves with empty rows.
      if (!synd) continue;
      if (num(synd.fundedAmount) <= 0) continue;

      dealsParticipated++;
      syndInvested += num(synd.fundedAmount);
      syndCollected += num(synd.cashCollected);
      syndExposure += num(synd.cashExposure);
      perDealShares.push({
        dealInternalId: deal.id,
        dealNo: deal.dealId,
        sharePct: num(synd.investmentPercentage) / 100,
      });
    }

    syndInvested = round2(syndInvested);
    syndCollected = round2(syndCollected);
    syndExposure = round2(syndExposure);

    // Collection breakdown by type, aggregated from /deals/{id}/payments.
    // Each payment is scaled by the syndicator's investmentPercentage on
    // that deal. Skip if fetchPayments not provided (e.g., test fixtures).
    let merchantPayments = 0;
    let refiProceeds = 0;
    let balanceTransfersIn = 0;
    let balanceTransfersOut = 0;
    let paymentRecordCount = 0;

    if (fetchPayments) {
      // Bounded-concurrency per-deal payment fetches. Each retries up to 3x
      // in cachedApiFetch; failures here mean even retries didn't recover.
      // Concurrency=3 (matching the deal-detail fan-out) for the same rate-
      // limit reason — more workers don't help when a global throttle is
      // pacing actual upstream requests.
      const paymentResults = await pMap(perDealShares, async ({ dealInternalId }) => {
        const r = await fetchPayments(dealInternalId);
        return r.data || [];
      }, 3);

      for (let i = 0; i < paymentResults.length; i++) {
        const res = paymentResults[i];
        const { dealInternalId, dealNo, sharePct } = perDealShares[i];

        if (res.error) {
          fetchFailures.payments.push({
            dealId: dealNo,
            internalId: dealInternalId,
            error: res.error.message,
          });
          continue; // skip this deal's payments — already logged
        }

        const payments = res.value;
        // Stash payments on the perDealShares entry so the curve builder
        // can re-read them later. Each entry now carries its raw payments.
        perDealShares[i].payments = payments;

        for (const p of payments) {
          if (p.status !== 'cleared') continue; // ignore pending/failed
          const amt = num(p.amount) * sharePct;
          paymentRecordCount++;

          switch (p.type) {
            case 'merchantPayment':
              merchantPayments += amt;
              break;
            case 'refinancePayoff':
              // refinancePayoff direction='out' is a payoff disbursement;
              // direction='in' is incoming refi proceeds. Sum incoming only.
              if (p.direction === 'in') refiProceeds += amt;
              break;
            case 'balanceTransferIn':
              balanceTransfersIn += amt;
              break;
            case 'balanceTransferOut':
              balanceTransfersOut += amt;
              break;
            // 'fee' entries are bank/processor fees (bd_fee, bank_fee,
            // default_fee, other_fee) — NOT the spreadsheet's mgmt/residual.
            // Ignored here; deal-level bank fees are surfaced via mapDeal.
          }
        }
      }
    }

    merchantPayments = round2(merchantPayments);
    refiProceeds = round2(refiProceeds);
    balanceTransfersIn = round2(balanceTransfersIn);
    balanceTransfersOut = round2(balanceTransfersOut);

    // Total Gross Collections — prefer the syndications.cashCollected sum
    // (system of record) over the sum of payment-type breakdowns. They
    // should agree but can drift due to pending/uncleared payments or
    // unallocated balance transfers.
    const totalGrossCollections = syndCollected;

    // Fees: prefer ledger entries (currently empty), else derive
    let managementFees, residualCommissions, feeSource;
    if (sub && sub.hasLedgerFees) {
      managementFees = sub.mgmtFeesLedger;
      residualCommissions = sub.residualCommissionsLedger;
      feeSource = 'ledger';
    } else {
      managementFees = round2(syndInvested * feeConfig.managementFeeRate);
      residualCommissions = round2(totalGrossCollections * feeConfig.residualCommissionRate);
      feeSource = 'derived';
    }
    const totalFees = round2(managementFees + residualCommissions);

    return {
      // From syndications array (exact, no approximation)
      dealsParticipated,
      syndInvested,
      syndCollected,
      syndExposure,
      // From payments endpoint (scaled by investmentPercentage)
      merchantPayments,
      refiProceeds,
      balanceTransfersIn,
      balanceTransfersOut,
      paymentRecordCount,
      // Aggregate
      totalGrossCollections,
      managementFees,
      residualCommissions,
      totalFees,
      feeSource,
      // Raw per-deal data (used by buildCollectionCurves to bucket payments
      // by months-since-funding for each vintage). Each entry contains:
      //   { dealInternalId, dealNo, sharePct, payments: [...] }
      perDealShares,
    };
  }

  // ==========================================================================
  // 5. COMBINE FINANCIALS  (apply spreadsheet formulas exactly)
  // ==========================================================================
  function combineFinancials(sub, derived, synInfo) {
    // Total Invested: prefer the syndications-derived sum (exact, summed
    // from per-deal LMJS shares). Falls back to the contact's totalInvested
    // (system of record) and finally to the subledger.
    const totalInvestments = (derived && derived.syndInvested != null)
      ? round2(derived.syndInvested)
      : synInfo?.totalInvested != null
        ? round2(synInfo.totalInvested)
        : sub.totalInvestmentsLedger;

    // Cash Balance = Deposits - Investments + Collections - Fees - Withdrawals
    const cashBalance = round2(
      sub.totalDeposits
      - totalInvestments
      + derived.totalGrossCollections
      - derived.totalFees
      - sub.totalWithdrawals
    );

    // Unreturned Principal = Total Invested - Gross Collections (floored at 0)
    const unreturned = round2(Math.max(0, totalInvestments - derived.totalGrossCollections));

    // Total Value = Withdrawals + Cash Balance + Unreturned
    const totalValue = round2(sub.totalWithdrawals + cashBalance + unreturned);

    // Net Profit = Total Value - External Capital
    const netProfit = round2(totalValue - sub.externalCapital);

    // Net Capital Deployed = External Capital - Total Withdrawals
    const netCapitalDeployed = round2(sub.externalCapital - sub.totalWithdrawals);

    // Cash-on-Cash Multiple = Total Value / External Capital
    const cashOnCash = sub.externalCapital > 0
      ? round2(totalValue / sub.externalCapital)
      : 0;

    // Net Collections = Gross Collections - Total Fees
    const netCollections = round2(derived.totalGrossCollections - derived.totalFees);

    return {
      totalInvestments,
      cashBalance,
      unreturned,
      totalValue,
      netProfit,
      netCapitalDeployed,
      cashOnCash,
      netCollections,
    };
  }

  // ==========================================================================
  // 6. BUILD XIRR + CASH FLOW CHART  (uses subledger + derived cash balance)
  //
  //   XIRR (Extended Internal Rate of Return) is the annualized rate of return
  //   on a series of cash flows occurring at irregular dates. It's the rate r
  //   that makes NPV = 0:
  //     0 = Σ (cf_i / (1 + r)^(daysSinceFirst_i / 365))
  //
  //   No closed form — solved iteratively via the secant method (more robust
  //   than Newton-Raphson for XIRR specifically, since the derivative can be
  //   tricky near zero).
  //
  //   Sign convention: deposits NEGATIVE (cash out), withdrawals POSITIVE
  //   (cash in). A series with all-positive or all-negative flows has no
  //   solution — XIRR returns null in those cases.
  //
  //   Three scenarios computed:
  //     - xirrFullRecovery: actual flows + outstanding principal as positive
  //       flow today (assumes outstanding eventually returns at full value)
  //     - xirrTotalLoss: actual flows only (assumes outstanding written off)
  //     - projectedXIRR: same as full recovery (the optimistic midpoint).
  //       Total loss provides the pessimistic floor.
  //
  //   Returns null if iteration doesn't converge or result is unreasonable.
  //   Frontend should render null as "—" or "N/A".
  // ==========================================================================
  function computeXirr(flows) {
    if (!flows || flows.length < 2) return null;

    // Normalize: each entry must have {date, amount}; date as YYYY-MM-DD or Date.
    const points = flows
      .map(f => ({
        date: f.date instanceof Date ? f.date : new Date(f.date),
        amount: typeof f.amount === 'number' ? f.amount : parseFloat(f.amount),
      }))
      .filter(p => !isNaN(p.date.getTime()) && !isNaN(p.amount) && p.amount !== 0)
      .sort((a, b) => a.date - b.date);

    if (points.length < 2) return null;

    // Need both positive and negative flows (otherwise no rate makes NPV = 0)
    const hasPositive = points.some(p => p.amount > 0);
    const hasNegative = points.some(p => p.amount < 0);
    if (!hasPositive || !hasNegative) return null;

    const t0 = points[0].date.getTime();
    const dayMs = 86400 * 1000;

    // NPV at rate r. Domain: r > -1 (otherwise division by zero or imaginary).
    function npv(r) {
      if (r <= -1) return Infinity;
      let sum = 0;
      for (const p of points) {
        const t = (p.date.getTime() - t0) / dayMs / 365;
        sum += p.amount / Math.pow(1 + r, t);
      }
      return sum;
    }

    // Strategy: scan a wide range of rates to find a sign change in NPV, then
    // bisect to refine. This is slower than Newton/secant but vastly more
    // robust for the wild range of XIRRs we see in MCA portfolios (anywhere
    // from -90% on bad cohorts to +200% on hot ones). With ~100 NPV calls
    // total it's still microseconds.
    //
    // Scan from -95% to +500% in 50 steps; that's wide enough for almost
    // any realistic XIRR. If we find a sign change between rates a and b,
    // bisect to TOLERANCE.
    const TOLERANCE = 1e-6;
    const MAX_BISECT = 60; // 60 iterations of bisection ≈ 1e-18 precision
    const SCAN_LO = -0.95;
    const SCAN_HI = 5.0;
    const SCAN_STEPS = 50;

    let prevR = SCAN_LO;
    let prevNpv = npv(prevR);
    for (let i = 1; i <= SCAN_STEPS; i++) {
      const r = SCAN_LO + ((SCAN_HI - SCAN_LO) * i) / SCAN_STEPS;
      const f = npv(r);
      if (!isFinite(f)) {
        prevR = r;
        prevNpv = f;
        continue;
      }
      // Found bracket [prevR, r] where NPV changes sign?
      if (isFinite(prevNpv) && Math.sign(prevNpv) !== Math.sign(f) && prevNpv !== 0) {
        // Bisect within [prevR, r]
        let lo = prevR, hi = r;
        let fLo = prevNpv, fHi = f;
        for (let j = 0; j < MAX_BISECT; j++) {
          const mid = (lo + hi) / 2;
          const fMid = npv(mid);
          if (Math.abs(fMid) < TOLERANCE || (hi - lo) < TOLERANCE) {
            // Converged. Sanity-check the result is in a reasonable range.
            if (mid < -0.99 || mid > 10) return null;
            return mid;
          }
          if (Math.sign(fMid) === Math.sign(fLo)) {
            lo = mid;
            fLo = fMid;
          } else {
            hi = mid;
            fHi = fMid;
          }
        }
        // Bisection didn't quite hit tolerance but we have a tight bracket.
        const result = (lo + hi) / 2;
        if (result < -0.99 || result > 10) return null;
        return result;
      }
      prevR = r;
      prevNpv = f;
    }

    // No sign change found in the scanned range — XIRR may not exist or
    // is outside our search domain. Return null rather than guessing.
    return null;
  }

  // ============================================================================
  // PROJECTED CASH FLOW ENGINE
  // ============================================================================
  // Generates synthetic future payment streams for each active deal, scaled to
  // the syndicator's stake and adjusted for scenario assumptions. Combined
  // with historical deposits/withdrawals, this feeds the Projected XIRR.
  //
  // Mirrors the spreadsheet's "Projected Cash Flows" tab approach but derives
  // the inputs (payment_amount, frequency, payments_remaining) from observed
  // data rather than reading them from explicit deal-record fields. The
  // SmartMCA API does not expose `dailyCollectionAmount` / `weeklyCollectionAmount`
  // / `remainingPayments` directly, so we derive them from history.
  //
  // Default scenario mirrors the spreadsheet's base case:
  //   commission     = 5%   (per-payment residual to the funder, deducted from each projected positive)
  //   haircut        = 0%   (additional reduction for slow-pay/short-pay risk)
  //   recoveryRate   = 0%   (defaulted deals contribute nothing in the baseline)
  //   recoveryMonths = 6    (when recoveryRate > 0, recovery arrives this many months after last payment)
  //   addlDefaultRate= 0%   (currently unused; reserved for vintage-level active-default modeling)

  const DEFAULT_SCENARIO = Object.freeze({
    commission: 0.05,
    haircut: 0.00,
    recoveryRate: 0.00,
    recoveryMonths: 6,
    addlDefaultRate: 0.00,
  });

  // Heuristic frequency classification. Spec calls for explicit
  // DAILY_COLLECTION_AMOUNT / WEEKLY_COLLECTION_AMOUNT fields; SmartMCA API
  // doesn't have these. Derive from the payment cadence we've observed:
  //   < 4 days/payment → Daily
  //   ≥ 4 days/payment → Weekly
  // Edge cases (no payments yet, or one payment) → default to Daily, the
  // dominant frequency in the LMJS portfolio.
  function classifyFrequency(deal) {
    const baseVars = deal?.computedVariables?.baseVariables || {};
    const txCount = num(baseVars.txPaymentCount);
    const daysSinceFunded = num(baseVars.daysSinceFunded);
    if (txCount < 2 || daysSinceFunded < 1) return 'daily';
    const cadence = daysSinceFunded / txCount;
    return cadence < 4 ? 'daily' : 'weekly';
  }

  // Per-payment dollar amount, derived from history. = totalCollected / txPaymentCount.
  // Returns 0 if either input is missing/zero (caller should skip projection
  // for the deal in that case).
  function derivePaymentAmount(deal) {
    const baseVars = deal?.computedVariables?.baseVariables || {};
    const txCount = num(baseVars.txPaymentCount);
    const totalCollected = num(baseVars.totalCollected || deal.totalCollected);
    if (txCount <= 0 || totalCollected <= 0) return 0;
    return totalCollected / txCount;
  }

  // Returns the most reliable "last payment date" we have on the deal, as a
  // Date object. Prefers computedVariables.baseVariables.txLastPaymentDate
  // (populated even when top-level lastPaymentDate is null).
  function getLastPaymentDate(deal) {
    const tx = deal?.computedVariables?.baseVariables?.txLastPaymentDate;
    if (tx) return new Date(tx);
    if (deal?.lastPaymentDate) return new Date(deal.lastPaymentDate);
    return null;
  }

  // Increment a date by one business day (Mon-Fri). Skips Sat/Sun. This isn't
  // a full holiday calendar but matches the "skip" bankHolidayHandling we see
  // on the SmartMCA funder record, close enough for projection purposes.
  function addBusinessDay(date) {
    const d = new Date(date);
    d.setDate(d.getDate() + 1);
    while (d.getDay() === 0 || d.getDay() === 6) {
      d.setDate(d.getDate() + 1);
    }
    return d;
  }

  // Generate the per-deal projected payment stream for an ACTIVE deal,
  // scaled to the syndicator's slice and adjusted for commission + haircut.
  //
  // Returns array of {date, amount, type, description, dealNo}. Empty array
  // if the deal is not eligible for projection (closed, refinanced, defaulted,
  // or zero outstanding).
  function generateProjectedPayments(deal, sharePct, scenario) {
    if (!deal) return [];
    if (deal.status !== 'active') return [];

    const outstanding = num(deal.outstandingBalance);
    if (outstanding <= 0) return [];

    const paymentAmount = derivePaymentAmount(deal);
    if (paymentAmount <= 0) return [];

    // Syndicator's share of each merchant payment
    const sharePerPayment = paymentAmount * sharePct;
    if (sharePerPayment <= 0) return [];

    // Net of scenario adjustments (commission + haircut)
    const netPerPayment = sharePerPayment * (1 - scenario.commission) * (1 - scenario.haircut);
    if (netPerPayment <= 0) return [];

    // Walk forward from last observed payment date (or today if missing)
    const last = getLastPaymentDate(deal) || new Date();
    const frequency = classifyFrequency(deal);

    // How many payments to project? = remaining_outstanding / paymentAmount.
    // Ceil to make sure we cover the full balance; the last payment may be
    // partial (residual). Cap at a sane upper bound so a tiny paymentAmount
    // doesn't produce 100k flows.
    const fullPayments = Math.floor(outstanding / paymentAmount);
    const residualGross = outstanding - fullPayments * paymentAmount;
    const totalPayments = fullPayments + (residualGross > 0.01 ? 1 : 0);

    const MAX_PROJECTED_PER_DEAL = 500;
    const numPayments = Math.min(totalPayments, MAX_PROJECTED_PER_DEAL);

    const flows = [];
    let cursor = new Date(last);
    for (let i = 0; i < numPayments; i++) {
      // Advance to next payment date
      if (frequency === 'daily') {
        cursor = addBusinessDay(cursor);
      } else {
        cursor = new Date(cursor);
        cursor.setDate(cursor.getDate() + 7);
      }

      // Last payment may be a partial residual
      const isLast = (i === numPayments - 1) && residualGross > 0.01;
      const grossThisPayment = isLast ? residualGross : paymentAmount;
      const netThisPayment = grossThisPayment * sharePct
                             * (1 - scenario.commission)
                             * (1 - scenario.haircut);

      flows.push({
        date: cursor.toISOString().slice(0, 10),
        amount: round2(netThisPayment),
        type: 'Projected Payment',
        description: `Projected ${frequency} payment (${deal.dealId})`,
        dealNo: deal.dealId,
      });
    }

    return flows;
  }

  // Generate a single projected default-recovery flow for a DEFAULTED deal.
  // Returns null if the deal isn't eligible (not defaulted, zero outstanding,
  // or recoveryRate is 0).
  function generateDefaultRecovery(deal, sharePct, scenario) {
    if (!deal || deal.status !== 'defaulted') return null;
    if (scenario.recoveryRate <= 0) return null;

    const outstanding = num(deal.outstandingBalance);
    if (outstanding <= 0) return null;

    const recoveryAmount = outstanding * sharePct * scenario.recoveryRate;
    if (recoveryAmount <= 0) return null;

    // Recovery date = last payment date + recoveryMonths × 30 days. If we
    // have no last payment date (defaulted before paying anything?), use
    // funded date + recoveryMonths.
    const anchor = getLastPaymentDate(deal) || (deal.fundedDate ? new Date(deal.fundedDate) : new Date());
    const recoveryDate = new Date(anchor);
    recoveryDate.setDate(recoveryDate.getDate() + scenario.recoveryMonths * 30);

    return {
      date: recoveryDate.toISOString().slice(0, 10),
      amount: round2(recoveryAmount),
      type: 'Projected Recovery',
      description: `Projected default recovery (${deal.dealId})`,
      dealNo: deal.dealId,
    };
  }

  // Orchestrator: walk all deals, generate projected flows for the syndicator's
  // slice, return flat sorted array. `deals` is the full deal list (with
  // computedVariables, etc.); `syndicatorId` filters to only those deals where
  // this syndicator participates.
  function buildProjectedFlows(deals, syndicatorId, scenario = DEFAULT_SCENARIO) {
    if (!deals || !syndicatorId) return [];
    const out = [];
    for (const deal of deals) {
      const synd = extractSyndicationFor(deal, syndicatorId);
      if (!synd) continue;
      const sharePct = num(synd.investmentPercentage) / 100;
      if (sharePct <= 0) continue;

      const projected = generateProjectedPayments(deal, sharePct, scenario);
      out.push(...projected);

      const recovery = generateDefaultRecovery(deal, sharePct, scenario);
      if (recovery) out.push(recovery);
    }
    out.sort((a, b) => a.date.localeCompare(b.date));
    return out;
  }

  function buildFlows(sub, fin, derived, deals, syndicatorId, scenario) {
    const effectiveScenario = scenario || DEFAULT_SCENARIO;

    // ========================================================================
    // BUILD THE XIRR SERIES
    // ========================================================================
    // Three categories of flow, all on actual dates (no terminal lumps,
    // no aggregation tricks):
    //
    //   1. NEGATIVE — external capital deposits the syndicator made
    //      Source: sub.externalDeposits (deposits flagged as new capital, not
    //      reinvestments of prior payouts). Reinvestments are intentionally
    //      excluded — they are internal capital recycling, not new investments.
    //      LMJS today: 3 entries totaling $235k.
    //
    //   2. POSITIVE — actual withdrawals (paybacks the syndicator received)
    //      Source: sub.withdrawalEntries. These are gross paybacks (per the
    //      ledger account being debited). Fees that were assessed are tracked
    //      separately (#3) so they're not double-subtracted.
    //
    //   3. NEGATIVE — fees the syndicator paid
    //      Source: sub.feeEntries (Management Fee Paid (One Time) +
    //      Fee Paid (Per Transaction)). Currently $0 from staging API
    //      (SmartMCA has not populated fee entries yet); will populate
    //      automatically once upstream is rebuilt.
    //
    //   4. POSITIVE — projected future per-deal payments (commission-net)
    //      Source: buildProjectedFlows(). Per active deal, projects forward
    //      payment schedule from txLastPaymentDate using observed cadence,
    //      scaled to syndicator share, net of 5% per-payment commission.
    //
    // We do NOT add cash-on-hand as a terminal flow — idle cash isn't return.
    // We do NOT add a lump-sum recovery — projected per-deal payments
    // produce the recovery of outstanding implicitly, on the dates payments
    // would actually arrive.

    const xirrFlows = [];

    // 1. External capital deposits (negative)
    for (const d of sub.externalDeposits) {
      xirrFlows.push({
        date: d.date,
        amount: -d.amount,
        type: 'External Capital',
        description: 'Syndicator external capital deposit',
      });
    }

    // 2. Actual withdrawals (positive)
    for (const w of sub.withdrawalEntries) {
      xirrFlows.push({
        date: w.date,
        amount: w.amount,
        type: 'Withdrawal',
        description: 'Syndicator payout',
      });
    }

    // 3. Fees paid (negative). Empty on staging today; populated when the
    // upstream subledger has fee entries.
    for (const f of sub.feeEntries) {
      xirrFlows.push({
        date: f.date,
        amount: -f.amount,
        type: f.type,
        description: f.type,
      });
    }

    // 4. Projected future payments (positive)
    const projectedFlows = buildProjectedFlows(deals, syndicatorId, effectiveScenario);
    for (const p of projectedFlows) {
      xirrFlows.push(p);
    }

    // Sort everything by date
    xirrFlows.sort((a, b) => a.date.localeCompare(b.date));

    // Compute the single XIRR
    const projectedXIRR = computeXirr(xirrFlows);

    // Cash Flow Chart — note: collection/fee events are not visible per-day
    // until the upstream subledger is rebuilt. Chart shows deposits,
    // withdrawals, and investments only.
    const cashFlowChart = [];
    let cumulative = 0;
    for (const date of Object.keys(sub.dailyFlows).sort()) {
      const df = sub.dailyFlows[date];
      const net = df.deposits - df.withdrawals - df.investments;
      cumulative += net;
      cashFlowChart.push({
        date: date.slice(5),
        amount: round2(net),
        cumulative: round2(cumulative),
      });
    }

    return {
      xirrFlows,
      cashFlowChart,
      projectedXIRR,
      // Removed: xirrTotalLoss and xirrFullRecovery. The single Projected XIRR
      // captures the full picture (external in + actual paybacks - fees +
      // projected forward). Frontend should display only projectedXIRR.
      xirrTotalLoss: null,
      xirrFullRecovery: null,
      // _debug surfacing — lets the dashboard show what shape the projection
      // actually has (number of synthetic flows generated, sum of their
      // amounts, date range covered).
      projectedFlowsMeta: {
        count: projectedFlows.length,
        totalAmount: round2(projectedFlows.reduce((s, f) => s + f.amount, 0)),
        firstDate: projectedFlows.length > 0 ? projectedFlows[0].date : null,
        lastDate: projectedFlows.length > 0 ? projectedFlows[projectedFlows.length - 1].date : null,
        scenario: effectiveScenario,
      },
      // Composition of the XIRR series, for verification:
      xirrComposition: {
        externalDepositCount: sub.externalDeposits.length,
        externalDepositTotal: round2(sub.externalDeposits.reduce((s, d) => s + d.amount, 0)),
        withdrawalCount: sub.withdrawalEntries.length,
        withdrawalTotal: round2(sub.withdrawalEntries.reduce((s, w) => s + w.amount, 0)),
        feeCount: sub.feeEntries.length,
        feeTotal: round2(sub.feeEntries.reduce((s, f) => s + f.amount, 0)),
        projectedCount: projectedFlows.length,
        projectedTotal: round2(projectedFlows.reduce((s, f) => s + f.amount, 0)),
        netExpected: round2(
          -sub.externalDeposits.reduce((s, d) => s + d.amount, 0)
          + sub.withdrawalEntries.reduce((s, w) => s + w.amount, 0)
          - sub.feeEntries.reduce((s, f) => s + f.amount, 0)
          + projectedFlows.reduce((s, f) => s + f.amount, 0)
        ),
      },
    };
  }

  // ==========================================================================
  // 7. VINTAGE ANALYSIS  (deal-level, unchanged)
  // ==========================================================================
  function computeVintages(perfs) {
    const map = {};
    for (const d of perfs) {
      if (!d.vintage) continue;
      if (!map[d.vintage]) {
        map[d.vintage] = {
          vintage: d.vintage, numDeals: 0, invested: 0, collected: 0,
          fees: 0, net: 0, defaults: 0, remainingRTR: 0, defaultedRTR: 0,
          netFunded: 0, rtr: 0, collectedBiz: 0,
        };
      }
      const m = map[d.vintage];
      m.numDeals++;
      m.invested += d.invested;
      m.collected += d.collected;
      m.fees += d.feesPaid;
      m.net += d.collected - d.feesPaid;
      m.netFunded += d.netFunded;
      m.rtr += d.rtr;
      m.collectedBiz += d.totalCollectedBiz;
      const rem = typeof d.dollarRemaining === 'number' ? d.dollarRemaining : 0;
      m.remainingRTR += rem;
      if (d.status === 'Default') {
        m.defaults++;
        m.defaultedRTR += rem;
      }
    }
    return Object.values(map).sort((a, b) => a.vintage.localeCompare(b.vintage)).map(v => {
      const pct = v.invested > 0 ? v.net / v.invested : 0;
      const mo = Math.max(0, Math.floor((new Date() - new Date(v.vintage + '-01')) / 2629746000));
      return {
        vintage: v.vintage,
        numDeals: v.numDeals,
        invested: round2(v.invested),
        totalCollected: round2(v.collected),
        totalFees: round2(v.fees),
        netCollections: round2(v.net),
        collectionPctNI: round2(pct),
        remainingRTR: round2(v.remainingRTR),
        defaultedRTR: round2(v.defaultedRTR),
        defaultPctRTR: v.remainingRTR > 0 ? round2(v.defaultedRTR / v.remainingRTR) : 0,
        exposure: round2(v.invested - v.net),
        defaultRate: v.numDeals > 0 ? round2(v.defaults / v.numDeals) : 0,
        monthsActive: mo,
        avgMonthlyYield: mo > 0 ? round2(pct / mo) : 0,
        netFunded: round2(v.netFunded),
        rtr: round2(v.rtr),
        totalCollectedBiz: round2(v.collectedBiz),
        collectionPctNF: v.netFunded > 0 ? round2(v.collectedBiz / v.netFunded) : 0,
        exposureBiz: round2(Math.max(0, v.netFunded - v.collectedBiz)),
      };
    });
  }

  // ==========================================================================
  // 8. COLLECTION CURVES  (real cohort analysis from payment events)
  //
  //    For each vintage cohort (e.g. '2026-02'), compute cumulative net
  //    collections at month 0, 1, 2, ... N from funding date. "Month X" =
  //    days [X*30, (X+1)*30) since the deal's fundedDate. This is the
  //    standard convention for syndication cohort analysis (NOT calendar
  //    months — a Feb 28 deal and a Feb 1 deal don't reach "1 month old"
  //    on the same date).
  //
  //    Inputs:
  //      vintages       - output of computeVintages, gives per-vintage invested
  //                       and net collected totals for the denominator
  //      deals          - full deal records (we need fundedDate per deal)
  //      perDealData    - array of { dealInternalId, sharePct, payments }
  //                       For syndicator scope: sharePct is LMJS's pct.
  //                       For business scope: sharePct = 1 (full deal).
  //      today          - reference date (so we know horizon)
  //
  //    Output:
  //      { pct: [...], dollar: [...] }
  //      Each entry: { vintage, monthsHorizon, "0": ..., "1": ..., ..., "N": ... }
  //      Month columns beyond a vintage's age are null. Horizon N is dynamic
  //      based on oldest vintage in the data.
  //
  //    Net collections = cleared collection-type payments (merchant, refi,
  //    balance-transfer in/out) minus per-period fees. Fees are derived as
  //    constant rate × collection in each period (since per-period fee
  //    timing isn't in the API). The CUMULATIVE total at month N converges
  //    to the same final number as the vintage row's netCollections.
  // ==========================================================================
  function buildCollectionCurves(vintages, deals, perDealData, feeConfig, today = new Date()) {
    if (!vintages || vintages.length === 0) {
      return { pct: [], dollar: [], monthsHorizon: 0 };
    }

    // Index deals by internalId for fast lookup of fundedDate
    const dealById = new Map(deals.map(d => [d.id, d]));

    // Determine global horizon: the oldest vintage's age in 30-day buckets.
    // Use the start-of-month for the vintage as the cohort funding "anchor"
    // for horizon-counting purposes; individual deal funding dates within
    // the vintage are used for actual bucketing.
    let maxMonths = 0;
    for (const v of vintages) {
      const vintageStart = new Date(v.vintage + '-01');
      const ageMonths = Math.floor((today - vintageStart) / (30 * 86400 * 1000));
      if (ageMonths > maxMonths) maxMonths = ageMonths;
    }
    const monthsHorizon = Math.max(0, Math.min(maxMonths, 24)); // hard cap at 24mo for sanity

    // For each vintage, walk every deal in that vintage's cohort and bucket
    // payments by months-since-this-deal's-fundedDate.
    const vintageMap = new Map(vintages.map(v => [v.vintage, {
      vintage: v.vintage,
      invested: v.invested,
      collectionsByMonth: new Array(monthsHorizon + 1).fill(0),
      // Track which deals contribute to this vintage so we know each deal's
      // age (some deals in the cohort may not yet have data for late months)
      maxDealMonths: 0,
    }]));

    const COLLECTION_TYPES = new Set(['merchantPayment', 'refinancePayoff', 'balanceTransferIn']);
    const NEGATIVE_TYPES = new Set(['balanceTransferOut']);

    for (const dealData of perDealData) {
      const deal = dealById.get(dealData.dealInternalId);
      if (!deal) continue;
      const fundedDate = deal.fundedDate ? new Date(deal.fundedDate) : null;
      if (!fundedDate || isNaN(fundedDate)) continue;

      const vintageKey = `${fundedDate.getFullYear()}-${String(fundedDate.getMonth() + 1).padStart(2, '0')}`;
      const vint = vintageMap.get(vintageKey);
      if (!vint) continue;

      // Track the latest month bucket this deal can fill (its current age)
      const dealAgeMonths = Math.floor((today - fundedDate) / (30 * 86400 * 1000));
      if (dealAgeMonths > vint.maxDealMonths) vint.maxDealMonths = dealAgeMonths;

      const sharePct = dealData.sharePct;
      for (const p of dealData.payments || []) {
        if (p.status !== 'cleared') continue;

        let signedAmt;
        if (COLLECTION_TYPES.has(p.type)) {
          // refinancePayoff direction='out' is a payoff disbursement, not a collection
          if (p.type === 'refinancePayoff' && p.direction !== 'in') continue;
          signedAmt = num(p.amount) * sharePct;
        } else if (NEGATIVE_TYPES.has(p.type)) {
          signedAmt = -num(p.amount) * sharePct;
        } else {
          continue;
        }

        const pDate = new Date(p.transactionDate);
        if (isNaN(pDate)) continue;
        const bucket = Math.floor((pDate - fundedDate) / (30 * 86400 * 1000));
        if (bucket < 0 || bucket > monthsHorizon) continue;
        vint.collectionsByMonth[bucket] += signedAmt;
      }
    }

    // Build the output: cumulative across months, with `null` for buckets
    // beyond the vintage's max-deal age.
    const pct = [];
    const dollar = [];
    for (const v of vintages) {
      const vint = vintageMap.get(v.vintage);
      if (!vint) {
        // Vintage exists but no payment data for any of its deals — fill with nulls
        const row = { vintage: v.vintage, monthsHorizon };
        const dollarRow = { vintage: v.vintage, monthsHorizon };
        for (let m = 0; m <= monthsHorizon; m++) {
          row[String(m)] = null;
          dollarRow[String(m)] = null;
        }
        pct.push(row);
        dollar.push(dollarRow);
        continue;
      }

      const feeRate = (feeConfig?.managementFeeRate || 0) + 0; // mgmt fee is one-time on funding
      // For per-period netting, we apply ONLY the residual rate per collection
      // (the management fee is a one-time charge, already accounted in totals).
      const residualRate = feeConfig?.residualCommissionRate || 0;

      const row = { vintage: v.vintage, monthsHorizon };
      const dollarRow = { vintage: v.vintage, monthsHorizon };
      let cumulative = 0;
      // Apply the one-time management fee at month 0 as a deduction
      const upfrontFee = vint.invested * (feeConfig?.managementFeeRate || 0);
      cumulative -= upfrontFee;

      for (let m = 0; m <= monthsHorizon; m++) {
        if (m > vint.maxDealMonths) {
          row[String(m)] = null;
          dollarRow[String(m)] = null;
          continue;
        }
        const grossThisMonth = vint.collectionsByMonth[m];
        const residualThisMonth = grossThisMonth * residualRate;
        const netThisMonth = grossThisMonth - residualThisMonth;
        cumulative += netThisMonth;

        if (vint.invested > 0) {
          row[String(m)] = round2(cumulative / vint.invested);
        } else {
          row[String(m)] = null;
        }
        dollarRow[String(m)] = Math.round(cumulative);
      }
      pct.push(row);
      dollar.push(dollarRow);
    }

    return { pct, dollar, monthsHorizon };
  }

  // ==========================================================================
  // 9. BUILD SUMMARY  (matches 'Returns Summary' sheet layout)
  //    Uses sub + derived + fin. Field names preserved for the frontend.
  // ==========================================================================
  function buildSummary(perfs, sub, derived, fin, synInfo, aggregate, flows) {
    const sumDeal = (fn) => perfs.reduce((s, d) => s + fn(d), 0);
    const dates = perfs.map(d => d.fundedDate).filter(Boolean).sort();
    const profitCount = perfs.filter(d => d.status === 'Profit').length;
    const activeCount = perfs.filter(d => d.status === 'Active').length;
    const defaultCount = perfs.filter(d => d.status === 'Default').length;
    const agg = aggregate || {};

    const hasSyndicator = !!synInfo;
    // When no syndicator is selected, fall back to portfolio-wide aggregates.
    const totalInvested = hasSyndicator ? fin.totalInvestments : (agg.totalInvestedAll || 0);
    const totalGrossCollections = hasSyndicator ? derived.totalGrossCollections : 0;
    const totalFees = hasSyndicator ? derived.totalFees : 0;

    const collectionsPctInvested = totalInvested > 0
      ? round2(totalGrossCollections / totalInvested)
      : 0;
    // Collections as % of *initial* (external) capital — answers "what
    // fraction of my original out-of-pocket money have I gotten back?"
    // This is the more economically meaningful ratio for a syndicator who
    // reinvests aggressively, since totalInvested grows with reinvestments.
    const collectionsPctExternal = (hasSyndicator && sub.externalCapital > 0)
      ? round2(totalGrossCollections / sub.externalCapital)
      : 0;
    // Net Collections as % of Initial Invested — same as above but uses
    // net-of-fees collections. Today fees from the API are $0 so this equals
    // collectionsPctExternal; once SmartMCA populates fee entries this will
    // diverge downward.
    const netCollectionsPctExternal = (hasSyndicator && sub.externalCapital > 0)
      ? round2(fin.netCollections / sub.externalCapital)
      : 0;

    // Active-deal scope: deals that are still actively collecting (status='Active').
    // Excludes Profit deals (paid off) AND Default deals (no longer expected to
    // recover). Both numerator and denominator below use this same scope so the
    // ratio is internally consistent — defaulted deals' RTR is not "expected
    // money" and their unreturned principal is effectively a write-off, not
    // pending recovery.
    //
    // For each Active deal, LMJS's slice:
    //   syndRtr        = deal.rtr × syndPct          (their share of the deal's RTR)
    //   syndCollected  = approximated as syndRtr × (1 - dollarRemaining/(rtr*syndPct))
    //                    — but since we already have syndOutstanding directly,
    //                      LMJS's already-collected on that deal = syndRtr - dollarRemaining
    //   syndUnreturned = max(0, syndInvested - syndCollected)
    //                    where syndInvested = deal.invested (LMJS's funded amount)
    //
    // Simpler equivalent: LMJS's unreturned for an active deal is bounded by
    // their invested ÷ collected on that deal. We use d.invested and d.collected
    // directly from mapDeal for the active subset.
    let activeRtrShare = 0;
    let activeUnreturned = 0;
    if (hasSyndicator) {
      for (const d of perfs) {
        if (d.status !== 'Active') continue; // exclude Profit and Default
        activeRtrShare += d.rtr * d.syndPct;
        // d.invested and d.collected are LMJS's slice (mapDeal sets them when
        // syndication is provided). Floor at 0 to avoid negatives from deals
        // that have collected more than invested but aren't yet flagged Profit.
        activeUnreturned += Math.max(0, d.invested - d.collected);
      }
    }
    // Unreturned principal as a % of Active RTR — answers "of the money I'm
    // still expecting from active deals, what fraction is just principal
    // recovery vs. profit?" Both sides scoped to Active deals only (excludes
    // paid-off and defaulted deals). Higher = closer to break-even.
    const pctActiveRtrUnreturned = (hasSyndicator && activeRtrShare > 0)
      ? round2(activeUnreturned / activeRtrShare)
      : 0;
    const feesPctInvested = totalInvested > 0
      ? round2(totalFees / totalInvested)
      : 0;
    const feesPctCollections = totalGrossCollections > 0
      ? round2(totalFees / totalGrossCollections)
      : 0;

    return {
      syndicatorName: synInfo?.name || 'All Syndicators',
      syndicatorId: synInfo?.id || '',
      period: {
        // BUG #4 FIX: prefer earliest deposit date over earliest deal date
        // when subledger is available (matches spreadsheet's 8/22/2025 vs
        // earliest-deal-funded 10/14/2025 derivation).
        start: (hasSyndicator && sub?.earliestDepositDate)
          ? new Date(sub.earliestDepositDate + 'T00:00:00').toLocaleDateString()
          : dates[0] ? new Date(dates[0]).toLocaleDateString() : 'N/A',
        end: new Date().toLocaleDateString(),
      },
      durationDays: (hasSyndicator && sub?.earliestDepositDate)
        ? Math.floor((new Date() - new Date(sub.earliestDepositDate + 'T00:00:00')) / 86400000)
        : dates[0] ? Math.floor((new Date() - new Date(dates[0])) / 86400000) : 0,

      // Capital Activity (rows 5-11)
      totalDeposits: hasSyndicator ? sub.totalDeposits : (agg.totalInvestedAll || 0),
      externalCapital: hasSyndicator ? sub.externalCapital : (agg.totalInvestedAll || 0),
      reinvestedReturns: hasSyndicator ? sub.reinvestedReturns : 0,
      totalWithdrawals: hasSyndicator ? sub.totalWithdrawals : (agg.totalDistributedAll || 0),
      netCapitalDeployed: hasSyndicator
        ? fin.netCapitalDeployed
        : round2((agg.totalInvestedAll || 0) - (agg.totalDistributedAll || 0)),
      currentCashBalance: hasSyndicator ? fin.cashBalance : 0,

      // Investment & Collections (rows 13-23)
      totalInvested: Math.round(totalInvested),
      numDeals: perfs.length,
      avgDealSize: perfs.length > 0 ? Math.round(totalInvested / perfs.length) : 0,
      totalMerchantPayments: hasSyndicator ? Math.round(derived.merchantPayments) : 0,
      refiProceeds: hasSyndicator ? Math.round(derived.refiProceeds) : 0,
      balanceTransfersIn: hasSyndicator ? Math.round(derived.balanceTransfersIn) : 0,
      balanceTransfersOut: hasSyndicator ? Math.round(derived.balanceTransfersOut) : 0,
      totalGrossCollections: Math.round(totalGrossCollections),
      collectionsPctInvested,
      collectionsPctExternal,
      netCollectionsPctExternal,
      activeRtrShare: Math.round(activeRtrShare),
      activeUnreturned: Math.round(activeUnreturned),
      pctActiveRtrUnreturned,
      // Fee Analysis (rows 25-30)
      managementFees: hasSyndicator ? Math.round(derived.managementFees) : 0,
      residualCommissions: hasSyndicator ? Math.round(derived.residualCommissions) : 0,
      totalFees: Math.round(totalFees),
      feesPctInvested,
      feesPctCollections,

      // Return Metrics (rows 32-48)
      netCollections: hasSyndicator ? Math.round(fin.netCollections) : 0,
      unreturned: hasSyndicator ? Math.round(fin.unreturned) : 0,
      // BUG #1 FIX: Gross P&L = Collections - External Capital - Fees (Returns
      // Summary B36). Old code summed each deal's pAndL field which is the
      // BUSINESS-level (full-deal) P&L, not the syndicator's share — and is
      // structurally wrong for a hybrid model anyway. Spreadsheet for LMJS:
      //   $313,437 - $235,000 - $53,722 = $24,715
      grossPnL: hasSyndicator
        ? Math.round(totalGrossCollections - sub.externalCapital - totalFees)
        : Math.round(sumDeal(d => d.netReturn)),
      totalCurrentValue: hasSyndicator ? Math.round(fin.totalValue) : 0,
      netProfit: hasSyndicator ? Math.round(fin.netProfit) : 0,
      projectedXIRR: hasSyndicator && flows?.projectedXIRR != null
        ? round2(flows.projectedXIRR) : 0,
      cashOnCashMultiple: hasSyndicator ? fin.cashOnCash : 0,

      // Deal Statistics (rows 51-57)
      dealsInProfit: profitCount,
      dealsActiveBelowBasis: activeCount,
      dealsDefaulted: defaultCount,
      winRate: perfs.length > 0 ? round2(profitCount / perfs.length) : 0,
      defaultRate: perfs.length > 0 ? round2(defaultCount / perfs.length) : 0,

      // Realized vs Unrealized (rows 59+)
      realizedValue: hasSyndicator ? Math.round(sub.totalWithdrawals + fin.cashBalance) : 0,
      realizedPnL: hasSyndicator
        ? Math.round(sub.totalWithdrawals + fin.cashBalance - sub.externalCapital)
        : 0,
      realizedROI: hasSyndicator && sub.externalCapital > 0
        ? round2((sub.totalWithdrawals + fin.cashBalance - sub.externalCapital) / sub.externalCapital)
        : 0,
      unrealizedValue: hasSyndicator ? Math.round(fin.unreturned) : 0,
      pctStillOutstanding: hasSyndicator && totalInvested > 0
        ? round2(fin.unreturned / totalInvested)
        : 0,
      xirrFullRecovery: hasSyndicator && flows?.xirrFullRecovery != null
        ? round2(flows.xirrFullRecovery) : 0,
      xirrTotalLoss: hasSyndicator && flows?.xirrTotalLoss != null
        ? round2(flows.xirrTotalLoss) : 0,

      // Collection Analysis (business-level, from deals)
      totalNetFunded: Math.round(sumDeal(d => d.netFunded)),
      totalRTR: Math.round(sumDeal(d => d.rtr)),
      totalCollectedBiz: Math.round(sumDeal(d => d.totalCollectedBiz)),
      collectionPctNF: sumDeal(d => d.netFunded) > 0
        ? round2(sumDeal(d => d.totalCollectedBiz) / sumDeal(d => d.netFunded))
        : 0,
      avgPaybackFactor: perfs.length > 0
        ? round2(sumDeal(d => d.paybackFactor) / perfs.length)
        : 0,
      totalExposure: Math.max(0, Math.round(sumDeal(d => d.netFunded) - sumDeal(d => d.totalCollectedBiz))),
      totalRemainingRTR: Math.round(sumDeal(d => d.rtr) - sumDeal(d => d.totalCollectedBiz)),

      // Aggregate (Portfolio Overview)
      aggTotalInvested: agg.totalInvestedAll || 0,
      aggRunningBalance: agg.totalRunningBalanceAll || 0,
      aggSyndicatorCount: agg.syndicatorCount || 0,

      // Placeholders preserved from prior contract
      dailyPctDeals: 0, weeklyPctDeals: 0, dailyAvgDays: 0, weeklyAvgWeeks: 0,
      moIRR_noDefault: 0, annIRR_noDefault: 0, moic_noDefault: 0,
      moIRR_adjusted: 0, annIRR_adjusted: 0, moic_adjusted: 0,
    };
  }

  // ==========================================================================
  // MAIN
  // ==========================================================================
  try {
    // 1. Deals — fetch full records (including syndications array per deal)
    const deals = await getAllDeals();

    // 2. Contacts (always fetch for aggregate)
    let allSyndicators = [];
    try {
      const cr = await apiFetch('/contacts?limit=100');
      const contacts = Array.isArray(cr.data)
        ? cr.data
        : Array.isArray(cr.data?.data) ? cr.data.data : [];
      allSyndicators = contacts.filter(c => c.type === 'syndicator').map(c => ({
        id: c.id,
        name: c.name,
        totalInvested: c.details?.totalInvested || 0,
        runningBalance: c.details?.runningBalance || 0,
        totalDistributed: c.details?.totalDistributed || 0,
      }));
    } catch (e) { /* continue with empty list */ }

    const aggregate = {
      totalInvestedAll: allSyndicators.reduce((s, c) => s + c.totalInvested, 0),
      totalRunningBalanceAll: allSyndicators.reduce((s, c) => s + c.runningBalance, 0),
      totalDistributedAll: allSyndicators.reduce((s, c) => s + c.totalDistributed, 0),
      syndicatorCount: allSyndicators.length,
    };

    // 3. Per-syndicator data (only when syndicatorId provided)
    let synInfo = null;
    let sub = null;       // subledger-derived: deposits, withdrawals, investments, flows
    let derived = null;   // syndications-derived: per-deal slice + collection breakdown
    let fin = null;       // combined: cashBalance, unreturned, totalValue, netProfit, etc.
    let feeConfig = null;
    let flows = {
      xirrFlows: [],
      cashFlowChart: [],
      projectedXIRR: null,
      xirrFullRecovery: null,
      xirrTotalLoss: null,
    };

    if (syndicatorId) {
      synInfo = allSyndicators.find(c => c.id === syndicatorId) || null;
      feeConfig = getFeeConfig(syndicatorId);

      try {
        const subResp = await apiFetch(
          `/accounting/reports/subledger/syndicator/${syndicatorId}?limit=10000`
        );
        const entries = subResp.data?.entries
          || subResp.data?.data
          || (Array.isArray(subResp.data) ? subResp.data : []);
        sub = parseSubledger(entries);
      } catch (e) {
        // Fail open: subledger unavailable -> zero-out cash-flow side, keep deal side.
        sub = {
          externalCapital: 0, reinvestedReturns: 0, feeRefunds: 0,
          totalDeposits: 0, totalWithdrawals: 0, totalInvestmentsLedger: 0,
          mgmtFeesLedger: 0, residualCommissionsLedger: 0,
          mgmtFeeCount: 0, residualCount: 0, hasLedgerFees: false,
          earliestDepositDate: null,
          flowsByDate: {}, dailyFlows: {},
          externalDeposits: [], withdrawalEntries: [], feeEntries: [],
          entryCount: 0, totalEntryCount: 0,
        };
      }

      // Aggregate per-deal syndication data + per-deal payment breakdown.
      // The fetchPayments callback wraps apiFetch so the cache layer
      // dedupes repeat requests across the page-fan-out.
      const fetchPayments = (dealInternalId) =>
        apiFetch(`/deals/${dealInternalId}/payments?limit=200`);

      derived = await aggregateSyndicatorMetrics(deals, syndicatorId, feeConfig, sub, fetchPayments);
      fin = combineFinancials(sub, derived, synInfo);
      flows = buildFlows(sub, fin, derived, deals, syndicatorId);
    }

    // 4. Build the deal-perf table. When a syndicator is selected, each row
    // shows that syndicator's slice. Deals where the syndicator doesn't
    // participate (no syndication record, or fundedAmount=0) are filtered
    // OUT entirely — they shouldn't appear in deal tables, vintage rollups,
    // or collection curves for that syndicator's view.
    // When no syndicator is selected (Portfolio Overview), all deals are
    // included with business-level numbers.
    const dealPerf = deals
      .map(d => {
        const synd = syndicatorId ? extractSyndicationFor(d, syndicatorId) : null;
        return mapDeal(d, synd);
      })
      .filter(d => {
        // Portfolio view: keep all deals
        if (!syndicatorId) return true;
        // Syndicator view: drop deals with zero participation
        return d.syndPct > 0 && d.invested > 0;
      });

    // 5. Compute vintages
    const vintagesSynd = computeVintages(dealPerf);

    // 6. Build collection curves (REAL — from payment events).
    //    Two scopes:
    //      Syndicator view: use derived.perDealShares (already collected
    //        per-deal payments scaled by the syndicator's pct).
    //      Portfolio view: fetch payments for ALL deals (sharePct = 1.0)
    //        since no syndicator is selected. Adds ~37 API calls on cold
    //        cache; cached after that.
    let curves = { pct: [], dollar: [], monthsHorizon: 0 };
    if (syndicatorId && derived?.perDealShares) {
      // Syndicator scope: payment data already gathered with sharePct applied
      curves = buildCollectionCurves(
        vintagesSynd,
        deals,
        derived.perDealShares,
        feeConfig,
        new Date()
      );
    } else if (!syndicatorId) {
      // Portfolio scope: fetch payments for every deal at sharePct = 1.0
      const allDealShares = await pMap(deals, async (deal) => {
        try {
          const r = await apiFetch(`/deals/${deal.id}/payments?limit=200`);
          return {
            dealInternalId: deal.id,
            dealNo: deal.dealId,
            sharePct: 1.0,
            payments: r.data || [],
          };
        } catch (e) {
          fetchFailures.payments.push({
            dealId: deal.dealId,
            internalId: deal.id,
            error: e.message,
          });
          return {
            dealInternalId: deal.id,
            dealNo: deal.dealId,
            sharePct: 1.0,
            payments: [],
          };
        }
      }, 3);
      // pMap returns {value, error} — unwrap
      const flat = allDealShares.map(r => r.value || { dealInternalId: null, sharePct: 1.0, payments: [] });
      // For portfolio view, fees are not derived per-syndicator. Use _default rates.
      const portfolioFeeConfig = SYNDICATOR_FEE_CONFIG._default;
      curves = buildCollectionCurves(
        vintagesSynd,
        deals,
        flat,
        portfolioFeeConfig,
        new Date()
      );
    }

    const summary = buildSummary(dealPerf, sub, derived, fin, synInfo, aggregate, flows);

    const vintagesBiz = vintagesSynd.map(v => ({
      vintage: v.vintage,
      numDeals: v.numDeals,
      netFunded: Math.round(v.netFunded),
      rtr: Math.round(v.rtr),
      totalCollected: Math.round(v.totalCollectedBiz),
      collectionPctNF: v.collectionPctNF,
      exposure: Math.round(v.exposureBiz),
      defaultRate: v.defaultRate,
    }));

    res.status(200).json({
      dealPerf,
      vintagesSynd,
      curvesPct: curves.pct,
      curvesDollar: curves.dollar,
      curvesMonthsHorizon: curves.monthsHorizon,
      vintagesBiz,
      xirrFlows: flows.xirrFlows,
      cashFlowChart: flows.cashFlowChart,
      summary,
      aggregate,
      _debug: {
        subledger: sub ? {
          entryCount: sub.entryCount,
          totalEntryCount: sub.totalEntryCount,
          externalCapital: sub.externalCapital,
          totalDeposits: sub.totalDeposits,
          totalWithdrawals: sub.totalWithdrawals,
          totalInvestmentsLedger: sub.totalInvestmentsLedger,
          earliestDepositDate: sub.earliestDepositDate,
          // Fee-side: zero on staging today; populated when subledger is rebuilt
          mgmtFeesLedger: sub.mgmtFeesLedger,
          residualCommissionsLedger: sub.residualCommissionsLedger,
          mgmtFeeCount: sub.mgmtFeeCount,
          residualCount: sub.residualCount,
          hasLedgerFees: sub.hasLedgerFees,
        } : null,
        projectedFlows: flows.projectedFlowsMeta || null,
        xirrComposition: flows.xirrComposition || null,
        derived: derived ? {
          dealsParticipated: derived.dealsParticipated,
          syndInvested: derived.syndInvested,
          syndCollected: derived.syndCollected,
          syndExposure: derived.syndExposure,
          // Collection breakdown by source type
          merchantPayments: derived.merchantPayments,
          refiProceeds: derived.refiProceeds,
          balanceTransfersIn: derived.balanceTransfersIn,
          balanceTransfersOut: derived.balanceTransfersOut,
          paymentRecordCount: derived.paymentRecordCount,
          totalGrossCollections: derived.totalGrossCollections,
          managementFees: derived.managementFees,
          residualCommissions: derived.residualCommissions,
          totalFees: derived.totalFees,
          feeSource: derived.feeSource, // 'ledger' or 'derived'
        } : null,
        financials: fin,
        feeConfig: feeConfig ? {
          managementFeeRate: feeConfig.managementFeeRate,
          residualCommissionRate: feeConfig.residualCommissionRate,
          source: SYNDICATOR_FEE_CONFIG[syndicatorId] ? 'explicit' : 'default',
        } : null,
        cache: {
          // TTLs (in seconds) by path category
          ttls: TTL,
          // Whether KV (persistent tier) is connected
          kvAvailable: kvAvailable,
          // Per-request: which upstream paths we hit and whether each was cached
          fetches: fetchTrace,
          hitsThisRequest: fetchTrace.filter(f => f.cached).length,
          missesThisRequest: fetchTrace.filter(f => !f.cached).length,
          // Lifetime stats since this serverless instance warmed up.
          // Includes new KV stats: kvHits, kvMisses, kvWrites, kvErrors.
          lifetimeStats: { ...cacheStats },
          bypassed: bypass,
        },
        // Per-request fetch failures: deals or payment endpoints whose retries
        // were all exhausted. Populated => some fields will under-count.
        // Empty arrays => all upstream fetches succeeded.
        fetchFailures: {
          dealCount: fetchFailures.deals.length,
          paymentCount: fetchFailures.payments.length,
          deals: fetchFailures.deals,
          payments: fetchFailures.payments,
        },
      },
      _meta: {
        fetchedAt: new Date().toISOString(),
        dealCount: deals.length,
        syndicatorId: syndicatorId || null,
        syndicatorName: synInfo?.name || null,
        hasSubledger: !!sub,
        source: 'SmartMCA Nexus API (live: syndications + payments + subledger cash flows)',
        cacheStatus: fetchTrace.every(f => f.cached) ? 'all-cached'
          : fetchTrace.some(f => f.cached) ? 'partial-cache'
          : 'fresh',
        // 'complete' = all per-deal fetches succeeded; 'partial' = at least one
        // deal-detail or payment fetch failed all retries (numbers may under-count).
        // The fetchFailures block in _debug shows which deals.
        dataIntegrity: (fetchFailures.deals.length === 0 && fetchFailures.payments.length === 0)
          ? 'complete'
          : 'partial',
        notes: syndicatorId
          ? 'Investment, collections, and exposure are read from each deal\'s syndications array (exact). Collection breakdown by type comes from /deals/{id}/payments scaled by investmentPercentage. Cash flows (deposits/withdrawals) come from the syndicator subledger. Mgmt fees and residual commissions are derived from per-syndicator rate config (managementFeeAmount and commissionPercentage in the API are zero/null across observed deals).'
          : null,
      },
    });
  } catch (error) {
    res.status(500).json({ error: 'Portfolio aggregation failed', details: error.message });
  }
}
