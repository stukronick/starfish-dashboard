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

// Phase 2 Step 3: Statement parser is now the PRIMARY source for syndicator
// cash-flow data. We dropped the /accounting/reports/subledger/ fetch and
// derive the legacy sub-shape from the statement via statementToSubledgerShape.
// Loaded dynamically so the module continues to load if the file is missing
// on a partial deploy. Once Phase 2 stabilises, this can become a static import.
let _parseStatement = null;
async function loadParseStatement() {
  if (_parseStatement !== null) return _parseStatement;
  try {
    const mod = await import('./parseStatement.js');
    _parseStatement = {
      parse:     mod.parseStatement,
      reconcile: mod.reconcileWithSummary,
      toSub:     mod.statementToSubledgerShape,
    };
  } catch (err) {
    _parseStatement = false;
  }
  return _parseStatement;
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
  // Statement endpoint matches subledger semantics: per-syndicator transaction
  // log that changes whenever new payments/distributions land, so 5min TTL.
  if (/^\/syndicators\/[^/]+\/statement/.test(path)) return TTL.SUBLEDGER;
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

// Upgrade a cached deal's TTL to 24h once we know it's permanently terminated.
// Called from getAllDeals after deal detail is in hand. closed = paid off via
// collections, defaulted = write-off, refinanced = paid off via refi proceeds.
// All three are terminal states with no further updates expected.
async function upgradeDealTtlIfClosed(internalId, dealRecord) {
  if (!dealRecord) return;
  const status = dealRecord.status;
  if (status !== 'closed' && status !== 'defaulted' && status !== 'refinanced') return;

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
// ============================================================================
// FEE CONFIG — historical fee rates per syndicator
//
// As of Apr 2026: SmartMCA's public API does not expose individual fee
// transactions (Management Fee Paid One-Time, Fee Paid Per Transaction).
// We probed `/accounting/entries` exhaustively and only found these source
// types: merchantPayment, syndicationInvestment, syndicatorDeposit,
// syndicatorWithdrawal, dealFunding. No fee source types exist in the public
// API, even though the SmartMCA UI's CSV download for syndicators clearly
// lists fee rows.
//
// The contacts endpoint returns `defaultManagementFeeEnabled` and confirms
// LMJS is configured with 0% management fee at the SmartMCA level. The fees
// shown in the spreadsheet must come from a different agreement/source not
// surfaced via the public API.
//
// Therefore: we set rates to 0 across the board. The dashboard reflects what
// the API actually says rather than fabricating numbers from back-computed
// rates. SmartMCA support has been queried for the canonical fee endpoint;
// once they expose it, replace this with API-driven fees.
// ============================================================================
const SYNDICATOR_FEE_CONFIG = {
  _default: {
    managementFeeRate: 0,
    residualCommissionRate: 0,
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
    // 'closed' = paid off via normal collections to RTR. 'refinanced' = paid
    // off via refi proceeds (merchant got new financing that paid out the
    // remaining balance). Both are economically equivalent: capital recovered,
    // no further collections expected. Group both as 'Profit' for display.
    else if (d.status === 'closed' || d.status === 'refinanced') status = 'Profit';
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
  async function aggregateSyndicatorMetrics(
    deals, syndicatorId, feeConfig, sub,
    fetchPayments,
    perDealCollectionsFromStatement = null  // Phase 2 Step 3: Map<dealId, payments[]>
  ) {
    if (!syndicatorId) return null;

    let syndInvested = 0;       // sum of LMJS's per-deal fundedAmount
    let syndCollected = 0;      // sum of LMJS's per-deal cashCollected
    let syndExposure = 0;       // sum of LMJS's per-deal cashExposure
    let dealsParticipated = 0;  // count of deals where LMJS participates
    const perDealShares = [];   // per-deal {dealId, pct} for collection breakdown

    // Status-bucketed accumulators. Used downstream to split "Outstanding
    // Principal in Deals" into the genuinely-active component (asset still
    // being collected) vs the defaulted-but-not-yet-recovered component
    // (write-off; treating it as a current asset overstates Net Profit).
    // Closed deals (status === 'Profit'/'closed') don't need a bucket because
    // their unreturned is mathematically 0 (they're paid off).
    let syndInvestedActive = 0,    syndCollectedActive = 0;
    let syndInvestedDefaulted = 0, syndCollectedDefaulted = 0;
    let syndInvestedClosed = 0,    syndCollectedClosed = 0;

    for (const deal of deals) {
      const synd = extractSyndicationFor(deal, syndicatorId);
      // Skip if no syndication record OR zero-stake (sometimes syndicators
      // are listed in the array with fundedAmount=0; not real participation).
      // Treating these as participating would inflate counts and pollute
      // vintages/curves with empty rows.
      if (!synd) continue;
      if (num(synd.fundedAmount) <= 0) continue;

      dealsParticipated++;
      const dealInvested  = num(synd.fundedAmount);
      const dealCollected = num(synd.cashCollected);
      syndInvested += dealInvested;
      syndCollected += dealCollected;
      syndExposure += num(synd.cashExposure);

      // Bucket by status. Note: deal.status uses the raw API values
      // ('defaulted' | 'closed' | 'refinanced' | other → active). The Closed
      // bucket includes both 'closed' (paid off via collections) and
      // 'refinanced' (paid off via refi proceeds) — both are economically
      // "asset recovered, no further collections expected" and produce $0
      // unreturned. This mirrors mapDeal's status grouping.
      if (deal.status === 'defaulted') {
        syndInvestedDefaulted  += dealInvested;
        syndCollectedDefaulted += dealCollected;
      } else if (deal.status === 'closed' || deal.status === 'refinanced') {
        syndInvestedClosed  += dealInvested;
        syndCollectedClosed += dealCollected;
      } else {
        syndInvestedActive  += dealInvested;
        syndCollectedActive += dealCollected;
      }

      perDealShares.push({
        dealInternalId: deal.id,
        dealNo: deal.dealId,
        sharePct: num(synd.investmentPercentage) / 100,
      });
    }

    syndInvested = round2(syndInvested);
    syndCollected = round2(syndCollected);
    syndExposure = round2(syndExposure);
    syndInvestedActive    = round2(syndInvestedActive);
    syndCollectedActive   = round2(syndCollectedActive);
    syndInvestedDefaulted = round2(syndInvestedDefaulted);
    syndCollectedDefaulted= round2(syndCollectedDefaulted);
    syndInvestedClosed    = round2(syndInvestedClosed);
    syndCollectedClosed   = round2(syndCollectedClosed);

    // Collection breakdown by type, aggregated from /deals/{id}/payments.
    // Each payment is scaled by the syndicator's investmentPercentage on
    // that deal. Skip if fetchPayments not provided (e.g., test fixtures).
    let merchantPayments = 0;
    let refiProceeds = 0;
    let balanceTransfersIn = 0;
    let balanceTransfersOut = 0;
    let paymentRecordCount = 0;

    if (perDealCollectionsFromStatement) {
      // Phase 2 Step 3: collections already provided by parseStatement.
      // Synthesized payments are LMJS-share-applied, so we set sharePct=1.0
      // on the perDealShares so downstream multiplication is a no-op.
      // This replaces N per-deal /deals/{id}/payments fetches with one
      // already-fetched data slice.
      for (let i = 0; i < perDealShares.length; i++) {
        const { dealInternalId } = perDealShares[i];
        const payments = perDealCollectionsFromStatement.get(dealInternalId) || [];
        perDealShares[i].payments = payments;
        // Override sharePct to 1.0 so buildHistoricalPaymentFlows et al.
        // don't double-apply the percentage. The statement entries are
        // already share-applied.
        perDealShares[i].sharePct = 1.0;

        for (const p of payments) {
          paymentRecordCount++;
          // All synthesized entries are merchantPayment type with positive
          // direction. Statement endpoint doesn't distinguish refi/balance-
          // transfer types; everything appears as paymentShareAllocated.
          // We bucket them all into merchantPayments for the breakdown
          // (downstream code only sums collections, doesn't act on the
          // distinction). Refi/balance-transfer breakouts are dropped from
          // the dashboard for now — matches what the statement endpoint
          // exposes. If needed in future, can reconstruct from
          // paymentShareAllocated descriptions like "refi_incoming" or
          // "balance_transfer_in/out".
          merchantPayments += p.amount;
        }
      }
    } else if (fetchPayments) {
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
      // Status-bucketed splits — used to separate genuinely-outstanding
      // principal (active deals, still being collected) from defaulted
      // unrecovered principal (write-off, gone). Closed deals are tracked
      // for completeness but mathematically contribute nothing to "unreturned"
      // (they're paid off). See combineFinancials for usage.
      syndInvestedActive,
      syndCollectedActive,
      syndInvestedDefaulted,
      syndCollectedDefaulted,
      syndInvestedClosed,
      syndCollectedClosed,
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

    // ========================================================================
    // FEES — prefer canonical value from /syndicators/export when available.
    // synInfo.managementFees is ALL-IN fees (upfront feeDeduction entries +
    // per-payment syndicationFee entries combined). We can't yet split into
    // "Management Fee (One-Time)" vs "Fee Paid (Per Transaction)" without
    // parsing the full statement (Phase 2 task). For now, attribute the
    // entire amount to the managementFees bucket and zero out residuals;
    // the dashboard collapses these into a single "Total Fees Paid" row.
    // ========================================================================
    let managementFees, residualCommissions, totalFees, feeSource;
    if (synInfo && synInfo.managementFees != null) {
      totalFees = round2(synInfo.managementFees);
      managementFees = totalFees;
      residualCommissions = 0;
      feeSource = 'smartmca_breakdown';
    } else {
      // Fallback: use whatever derived produced (currently $0 with zeroed
      // SYNDICATOR_FEE_CONFIG rates, until statement parsing lands).
      managementFees = round2((derived && derived.managementFees) || 0);
      residualCommissions = round2((derived && derived.residualCommissions) || 0);
      totalFees = round2(managementFees + residualCommissions);
      feeSource = (derived && derived.feeSource) || 'derived';
    }

    // ========================================================================
    // CASH BALANCE — uses SmartMCA's `availableCash` from /syndicators/export.
    // This is the canonical balance that matches the in-app party page
    // exactly. Computed server-side as:
    //   availableCash = totalDeposited - totalWithdrawn - totalInvestedLedger
    //                 - commissionsObligated + cashCollectedGross - managementFees
    //
    // Falls back to the derived formula only if synInfo.availableCash is
    // missing (e.g., /syndicators/export call failed for this request).
    // ========================================================================
    const cashBalance = (synInfo && synInfo.availableCash != null)
      ? round2(synInfo.availableCash)
      : round2(
          sub.totalDeposits
          - totalInvestments
          + derived.totalGrossCollections
          - totalFees
          - sub.totalWithdrawals
        );
    const cashBalanceSource = (synInfo && synInfo.availableCash != null)
      ? 'smartmca_available_cash'
      : 'derived';

    // Unreturned Principal — split by deal status to be honest about what's
    // actually a recoverable asset.
    //
    //   unreturnedActive    = principal still in deals that are paying. This
    //                         IS a real asset; collections are still arriving.
    //   unreturnedDefaulted = principal in deals that defaulted and aren't
    //                         being collected. This is effectively a write-off
    //                         — including it in Total Value would overstate
    //                         net profit by the amount unlikely to be recovered.
    //
    // Per-bucket flooring at 0 matches the existing single-line behavior
    // (a deal that collected more than invested doesn't generate negative
    // unreturned — it's already accounted for as profit elsewhere).
    //
    // Falls back to the legacy combined formula when bucketed data isn't
    // available (e.g., portfolio view, or derived built without status info).
    let unreturnedActive, unreturnedDefaulted, unreturned;
    if (derived && derived.syndInvestedActive != null) {
      unreturnedActive    = round2(Math.max(0, derived.syndInvestedActive    - derived.syndCollectedActive));
      unreturnedDefaulted = round2(Math.max(0, derived.syndInvestedDefaulted - derived.syndCollectedDefaulted));
      // Keep `unreturned` as the sum so callers that don't care about the
      // split see the same total they did before. Total Value below uses
      // only `unreturnedActive`.
      unreturned = round2(unreturnedActive + unreturnedDefaulted);
    } else {
      // Legacy fallback: single-bucket calc.
      unreturnedActive    = round2(Math.max(0, totalInvestments - derived.totalGrossCollections));
      unreturnedDefaulted = 0;
      unreturned = unreturnedActive;
    }

    // Total Value = Withdrawals + Cash Balance + Unreturned (ACTIVE only).
    // Defaulted unrecovered principal is a write-off, not a current asset.
    const totalValue = round2(sub.totalWithdrawals + cashBalance + unreturnedActive);

    // Net Profit = Total Value - External Capital
    const netProfit = round2(totalValue - sub.externalCapital);

    // Net Capital Deployed = External Capital - Total Withdrawals
    const netCapitalDeployed = round2(sub.externalCapital - sub.totalWithdrawals);

    // Cash-on-Cash Multiple = Total Value / External Capital
    const cashOnCash = sub.externalCapital > 0
      ? round2(totalValue / sub.externalCapital)
      : 0;

    // Net Collections = Gross Collections - Total Fees (uses canonical fees)
    const netCollections = round2(derived.totalGrossCollections - totalFees);

    return {
      totalInvestments,
      cashBalance,
      cashBalanceSource,
      managementFees,
      residualCommissions,
      totalFees,
      feeSource,
      unreturned,
      unreturnedActive,
      unreturnedDefaulted,
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
  // ============================================================================
  // SLIM XIRR SERIES FOR CLIENT-SIDE RECOMPUTATION
  // ============================================================================
  // The dashboard exposes a "Projection Confidence" slider (Optimistic /
  // Realistic / Conservative) that scales projected forward flows by
  // (1 - haircut). To keep that responsive, we send the flow series to the
  // client and re-run XIRR there. To keep payload small, we:
  //
  //   1. Aggregate historical flows by date — slider can't change them, so
  //      we only need ONE entry per date with the net signed amount.
  //   2. Send projected flows individually (each gets re-haircut as the
  //      slider moves).
  //
  // For LMJS this compresses ~2,400 individual flow events down to ~200
  // historical-by-date bins + ~670 projected entries ≈ 30KB payload.
  function buildXirrSeriesForClient(xirrFlows) {
    if (!xirrFlows || xirrFlows.length === 0) {
      return { historicalByDate: [], projected: [] };
    }
    // Projected flows are tagged with type starting with 'Projected' (Projected
    // Payment from generateProjectedPayments, Projected Recovery from
    // generateDefaultRecovery).
    const isProjected = (f) =>
      typeof f.type === 'string' && f.type.startsWith('Projected');

    // Aggregate historical flows by date for compactness.
    const histByDate = new Map();
    const projected = [];
    for (const f of xirrFlows) {
      if (isProjected(f)) {
        projected.push({ date: f.date, amount: round2(f.amount) });
      } else {
        const d = f.date.length > 10 ? f.date.slice(0, 10) : f.date;
        histByDate.set(d, round2((histByDate.get(d) || 0) + f.amount));
      }
    }

    const historicalByDate = Array.from(histByDate.entries())
      .map(([date, amount]) => ({ date, amount }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return { historicalByDate, projected };
  }

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

  // ============================================================================
  // HISTORICAL MERCHANT-PAYMENT-LEVEL FLOWS (replaces subledger withdrawals)
  // ============================================================================
  // For each per-deal payment record (merchant_payment, refi_incoming,
  // balance_transfer_in/out), emit a flow scaled to the syndicator's stake
  // in the deal. Positive flows are net of the per-payment commission so they
  // reflect what the syndicator actually keeps.
  //
  // Data source: derived.perDealShares[i].payments (already fetched in
  // aggregateSyndicatorMetrics; cached in the same hop).
  //
  // Date field: p.transactionDate (matches the curve builder; verified
  // against staging data).
  //
  // Scenario commission rate: same as projected side for internal consistency
  // (the spreadsheet's 5% baseline). The empirical residual rate for LMJS is
  // 5.15%; close enough to 5% that the difference is < 1pp on annual XIRR.
  // ============================================================================
  // HISTORICAL MERCHANT-PAYMENT-LEVEL FLOWS (replaces subledger withdrawals)
  // ============================================================================
  // Step 4 update: when a parsed statement is provided, emit GROSS positive
  // collection flows + REAL per-payment fees (residualCommission and per-
  // payment managementFee) as separate negative flows on their actual dates.
  // This replaces the rate-based netting approach (`× (1 - commission)`) with
  // exact fee accounting from the SmartMCA statement.
  //
  // The two paths produce:
  //
  //   Legacy (no parsedStatement):
  //     For each cleared payment: ONE flow at `payment × share × (1-comm)`,
  //     positive (collection) or negative (balance_transfer_out).
  //
  //   Statement-aware (with parsedStatement):
  //     For each `paymentShareAllocated` entry: ONE positive flow (already
  //       LMJS-share-applied, gross — no commission haircut).
  //     For each `residualCommission` entry: ONE negative flow on its real date.
  //     For each `managementFee` entry (per-payment): ONE negative flow.
  //     Reversals and balance transfers handled via signed amounts in parsed.
  //
  // Mathematically equivalent on a per-day basis (XIRR sums same-date flows
  // before discounting). More accurate when a fee posts on a different date
  // than its corresponding collection (rare but does happen).
  //
  // Data source:
  //   Statement-aware: parsedStatement.cashFlowsForXIRR (already sorted, signed,
  //                    syndicator-share-applied — direct passthrough with
  //                    category filtering).
  //   Legacy: derived.perDealShares[i].payments (raw deal payment records).
  function buildHistoricalPaymentFlows(perDealShares, scenario, parsedStatement) {
    // ---- Statement-aware path ----
    if (parsedStatement && Array.isArray(parsedStatement.cashFlowsForXIRR)) {
      const out = [];
      for (const f of parsedStatement.cashFlowsForXIRR) {
        // Categories we emit:
        //   collection           — positive, gross (no haircut)
        //   residualCommission   — negative, real fee event
        //   managementFee        — negative, per-payment management fee
        // Excluded:
        //   externalDeposit/withdrawal/reversal — already handled elsewhere
        //                                          or excluded from XIRR
        //   upfrontFee — handled via buildHistoricalManagementFees on funded date
        if (f.category !== 'collection'
            && f.category !== 'residualCommission'
            && f.category !== 'managementFee') {
          continue;
        }
        out.push({
          date: f.date.slice(0, 10),
          amount: f.amount,                       // already signed correctly
          type: f.category === 'collection' ? 'Historical Collection (Gross)'
              : f.category === 'residualCommission' ? 'Residual Commission (Real)'
              : 'Management Fee Per-Payment (Real)',
          description: f.category === 'collection'
            ? `Collection share allocated`
            : `${f.category} on payment`,
          dealNo: f.dealId || null,
        });
      }
      return out;
    }

    // ---- Legacy path: rate-based netting from raw per-deal payments ----
    if (!perDealShares || !Array.isArray(perDealShares)) return [];
    const COLLECTION_TYPES = new Set(['merchantPayment', 'refinancePayoff', 'balanceTransferIn']);
    const NEGATIVE_TYPES = new Set(['balanceTransferOut']);
    const commission = scenario?.commission ?? DEFAULT_SCENARIO.commission;

    const out = [];
    for (const dealData of perDealShares) {
      const sharePct = dealData.sharePct;
      if (!sharePct || sharePct <= 0) continue;
      const payments = dealData.payments || [];
      for (const p of payments) {
        if (p.status !== 'cleared') continue;

        let signedGross;
        if (COLLECTION_TYPES.has(p.type)) {
          // refinancePayoff direction='out' is a payoff disbursement, not a collection
          if (p.type === 'refinancePayoff' && p.direction !== 'in') continue;
          signedGross = num(p.amount) * sharePct;
        } else if (NEGATIVE_TYPES.has(p.type)) {
          signedGross = -num(p.amount) * sharePct;
        } else {
          continue;
        }
        if (signedGross === 0) continue;

        const date = p.transactionDate ? p.transactionDate.slice(0, 10) : null;
        if (!date) continue;

        // Apply per-payment commission ONLY to positive flows (the
        // syndicator pays a fee on each receipt). Negative flows
        // (balance transfer out) are already a debit; no fee applied.
        const netAmount = signedGross > 0
          ? signedGross * (1 - commission)
          : signedGross;

        out.push({
          date,
          amount: round2(netAmount),
          type: 'Historical Payment',
          description: `${p.type} (${dealData.dealNo}) net of ${(commission * 100).toFixed(1)}% commission`,
          dealNo: dealData.dealNo,
        });
      }
    }
    return out;
  }

  // ============================================================================
  // HISTORICAL MANAGEMENT FEES (one-time per deal, on funded date)
  // ============================================================================
  // Step 4 update: if a parsed statement is provided, use REAL per-deal
  // upfront fees from `parsed.feesByDeal[dealId].upfront`. Each deal's actual
  // upfront fee (which varies $1,470 - $25,500 across LMJS deals) is emitted
  // as a negative XIRR flow on the deal's fundedDate. This replaces the
  // rate-based approximation `syndFunded × managementFeeRate` which produces
  // the right total but wrong per-deal breakdown.
  //
  // Falls back to the rate-based calc if parsedStatement is null (statement
  // endpoint unavailable, fallback path triggered).
  //
  // Note: per-deal residual commissions and per-payment management fees are
  // NOT emitted here — those land on actual collection dates via
  // buildHistoricalPaymentFlows when parsedStatement is provided.
  function buildHistoricalManagementFees(deals, syndicatorId, feeConfig, parsedStatement) {
    if (!deals || !syndicatorId) return [];

    // ---- Statement-aware path: real upfront fees per deal ----
    if (parsedStatement && parsedStatement.feesByDeal) {
      const out = [];
      // Build a dealInternalId → fundedDate map so we don't iterate deals
      // unnecessarily for syndicators that didn't participate everywhere.
      const dealById = new Map();
      for (const d of deals) dealById.set(d.id, d);

      for (const [dealId, fees] of parsedStatement.feesByDeal.entries()) {
        const upfront = fees.upfront || 0;
        if (upfront <= 0) continue;
        const deal = dealById.get(dealId);
        // Date: prefer the deal's fundedDate; fall back to first collection
        // date for this deal if fundedDate missing (shouldn't happen but
        // defensive).
        const fundedDate = deal?.fundedDate ? deal.fundedDate.slice(0, 10) : null;
        if (!fundedDate) continue;
        out.push({
          date: fundedDate,
          amount: -round2(upfront),
          type: 'Upfront Fee (Real)',
          description: `Upfront fee paid (${deal?.dealId || dealId})`,
          dealNo: deal?.dealId || dealId,
        });
      }
      return out;
    }

    // ---- Fallback: rate-based approximation (legacy path) ----
    if (!feeConfig) return [];
    const rate = feeConfig.managementFeeRate || 0;
    if (rate <= 0) return [];

    const out = [];
    for (const deal of deals) {
      const synd = extractSyndicationFor(deal, syndicatorId);
      if (!synd) continue;
      const syndFunded = num(synd.fundedAmount);
      if (syndFunded <= 0) continue;
      const fundedDate = deal.fundedDate ? deal.fundedDate.slice(0, 10) : null;
      if (!fundedDate) continue;

      const fee = round2(syndFunded * rate);
      if (fee <= 0) continue;

      out.push({
        date: fundedDate,
        amount: -fee,
        type: 'Management Fee (One-Time)',
        description: `${(rate * 100).toFixed(2)}% mgmt fee on $${syndFunded.toFixed(0)} (${deal.dealId})`,
        dealNo: deal.dealId,
      });
    }
    return out;
  }

  function buildFlows(sub, fin, derived, deals, syndicatorId, scenario, feeConfig, parsedStatement) {
    // Step 4: when a parsed statement is available, compute the observed
    // effective commission rate (residual + per-payment management fees as
    // a fraction of gross collections) and override the scenario's commission
    // for projected forward flows. This makes projections use the actual rate
    // this syndicator has been paying, rather than the 5% default.
    //
    // For LMJS empirically: ($10,741 + $4,491) / $295,025 = 5.16%, very close
    // to the default 5% but more accurate. For other syndicators the rate
    // could differ — using observed data eliminates the guess.
    let effectiveScenario = scenario || DEFAULT_SCENARIO;
    if (parsedStatement && parsedStatement.cashCollectedGross > 0) {
      const observedFees = (parsedStatement.residualCommissions || 0)
                         + (parsedStatement.managementFees || 0);
      const observedRate = observedFees / parsedStatement.cashCollectedGross;
      // Sanity bounds: keep within [0%, 25%] to guard against degenerate
      // data (a syndicator with very few payments might produce noise).
      if (observedRate >= 0 && observedRate <= 0.25) {
        effectiveScenario = { ...effectiveScenario, commission: observedRate };
      }
    }

    // ========================================================================
    // BUILD THE XIRR SERIES
    // ========================================================================
    // Four categories of flow, all on actual dates (no terminal lumps,
    // no aggregation tricks):
    //
    //   1. NEGATIVE — external capital deposits the syndicator made
    //      Source: sub.externalDeposits (deposits flagged as new capital, not
    //      reinvestments of prior payouts). Reinvestments are intentionally
    //      excluded — they are internal capital recycling, not new investments.
    //      LMJS today: 5 entries totaling $235k.
    //
    //   2. NEGATIVE — upfront fees per deal, on funded date
    //      Source: buildHistoricalManagementFees(). When parsedStatement is
    //      provided: real per-deal upfront fees from parsed.feesByDeal[deal].upfront.
    //      Otherwise falls back to syndFunded × managementFeeRate approximation.
    //
    //   3. POSITIVE — historical merchant payments (gross, with separate fee debits)
    //      Source: buildHistoricalPaymentFlows(). When parsedStatement is provided:
    //      gross collection flows + separate negative residualCommission and
    //      managementFee flows on real dates. Otherwise uses rate-netted approach.
    //
    //   4. POSITIVE — projected future per-deal payments (commission-net)
    //      Source: buildProjectedFlows(). Per active deal, projects forward
    //      payment schedule from txLastPaymentDate using observed cadence,
    //      scaled to syndicator share, net of effectiveScenario.commission
    //      (uses observed historical rate when parsedStatement is available).

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

    // 2. Historical upfront fees (negative, one per deal on funded date)
    //    Uses real per-deal amounts when parsedStatement present.
    const mgmtFeeFlows = buildHistoricalManagementFees(deals, syndicatorId, feeConfig, parsedStatement);
    for (const f of mgmtFeeFlows) {
      xirrFlows.push(f);
    }

    // 3. Historical collections + per-payment fees (gross+fees split when
    //    parsedStatement present; rate-netted otherwise)
    const paymentFlows = buildHistoricalPaymentFlows(derived?.perDealShares, effectiveScenario, parsedStatement);
    for (const p of paymentFlows) {
      xirrFlows.push(p);
    }

    // 4. Projected future payments (positive, net of observed commission rate)
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
        // Step 4: report whether the commission rate came from observed data
        // (statement-derived) vs the DEFAULT_SCENARIO baseline.
        commissionRateSource: parsedStatement && parsedStatement.cashCollectedGross > 0
          ? 'observed_from_statement'
          : 'default_5pct',
      },
      // Composition of the XIRR series, for verification.
      // Note: mgmtFee* fields refer to upfront fees emitted on funded date.
      // Per-payment fees (residualCommission and per-payment managementFee)
      // are now bundled into historicalPayment* when statement is parsed,
      // since they're emitted on collection-date events alongside collections.
      xirrComposition: {
        externalDepositCount: sub.externalDeposits.length,
        externalDepositTotal: round2(sub.externalDeposits.reduce((s, d) => s + d.amount, 0)),
        mgmtFeeCount: mgmtFeeFlows.length,
        mgmtFeeTotal: round2(mgmtFeeFlows.reduce((s, f) => s - f.amount, 0)),  // store as positive
        historicalPaymentCount: paymentFlows.length,
        historicalPaymentTotal: round2(paymentFlows.reduce((s, p) => s + p.amount, 0)),
        projectedCount: projectedFlows.length,
        projectedTotal: round2(projectedFlows.reduce((s, f) => s + f.amount, 0)),
        netExpected: round2(
          -sub.externalDeposits.reduce((s, d) => s + d.amount, 0)
          + mgmtFeeFlows.reduce((s, f) => s + f.amount, 0)        // negative values, so this is a subtraction
          + paymentFlows.reduce((s, p) => s + p.amount, 0)
          + projectedFlows.reduce((s, f) => s + f.amount, 0)
        ),
        // Step 4: signals which historical-fee mechanism is in use.
        feeSource: parsedStatement ? 'statement_real_dates' : 'rate_based_approximation',
      },
    };
  }

  // ==========================================================================
  // 6b. PORTFOLIO-WIDE FLOWS  (Phase 2 detour)
  //
  // Portfolio Overview tab needs a projected XIRR that aggregates across all
  // syndicators. We can't average per-syndicator XIRRs (mathematically
  // meaningless for time-weighted returns), so we compose ONE flow series
  // across all syndicators and run XIRR on it.
  //
  // Inputs:
  //   - perSyndicatorParsed: Map<syndicatorId, parsedStatement> from the
  //     fan-out done at the top of the request handler. Each entry already
  //     has cashFlowsForXIRR with real dates and real amounts.
  //   - deals: full deals list, used for projected forward flows on actives.
  //
  // Composition (per syndicator, then concat):
  //   1. Historical flows from parsed.cashFlowsForXIRR, FILTERED to:
  //        - externalDeposit  (negative)
  //        - collection       (positive, gross)
  //        - residualCommission/managementFee/upfrontFee  (negative, real fees)
  //      Excluded:
  //        - withdrawal       (cashout to user, not a return-on-investment event)
  //        - reinvestment     (already excluded by parseStatement itself)
  //        - reversal         (small noise; net effect tiny)
  //
  //   2. Projected forward flows from buildProjectedFlows(deals, syndicatorId)
  //      using DEFAULT_SCENARIO (5% commission, 0% recovery on defaulted →
  //      defaulted deals get $0 from today onward, active deals project to
  //      full RTR with cadence inferred from history).
  //
  // The result is more accurate than the per-syndicator XIRR computed today
  // because it uses real fee dates instead of the rate-based approximation.
  // ==========================================================================
  function buildPortfolioFlows(perSyndicatorParsed, deals, scenario = DEFAULT_SCENARIO) {
    if (!perSyndicatorParsed || perSyndicatorParsed.size === 0) {
      return { xirrFlows: [], projectedXIRR: null, composition: null };
    }

    const xirrFlows = [];
    let externalDepositCount = 0;
    let externalDepositTotal = 0;  // positive (we'll negate when pushing)
    let collectionCount = 0;
    let collectionTotal = 0;
    let feeCount = 0;
    let feeTotal = 0;              // positive (we'll negate when pushing)
    let projectedCount = 0;
    let projectedTotal = 0;

    // Categories we keep from each parsed statement's cashFlowsForXIRR.
    // Withdrawals are excluded (cashout to user, not a return event).
    const KEEP = new Set([
      'externalDeposit',     // already negative-signed in parsed series
      'collection',          // positive
      'residualCommission',  // negative
      'managementFee',       // negative
      'upfrontFee',          // negative
    ]);

    for (const [syndicatorId, parsed] of perSyndicatorParsed.entries()) {
      // 1. Historical flows from this syndicator's statement
      for (const f of parsed.cashFlowsForXIRR) {
        if (!KEEP.has(f.category)) continue;
        xirrFlows.push({
          date: f.date.slice(0, 10),
          amount: f.amount,                   // already signed
          type: f.category,
          description: `${syndicatorId.slice(-6)} ${f.category}`,
          dealNo: f.dealId || null,
          syndicatorId,
        });
        if (f.category === 'externalDeposit') {
          externalDepositCount++;
          externalDepositTotal += -f.amount;  // amount is negative; track positive total
        } else if (f.category === 'collection') {
          collectionCount++;
          collectionTotal += f.amount;
        } else {
          feeCount++;
          feeTotal += -f.amount;              // amount is negative; track positive total
        }
      }

      // 2. Projected forward flows from active deals where this syndicator participates
      const projectedFlows = buildProjectedFlows(deals, syndicatorId, scenario);
      for (const p of projectedFlows) {
        xirrFlows.push({ ...p, syndicatorId });
        projectedCount++;
        projectedTotal += p.amount;
      }
    }

    xirrFlows.sort((a, b) => a.date.localeCompare(b.date));

    const projectedXIRR = computeXirr(xirrFlows);

    return {
      xirrFlows,
      projectedXIRR,
      composition: {
        externalDepositCount,
        externalDepositTotal: round2(externalDepositTotal),
        collectionCount,
        collectionTotal: round2(collectionTotal),
        feeCount,
        feeTotal: round2(feeTotal),
        projectedCount,
        projectedTotal: round2(projectedTotal),
        netExpected: round2(
          -externalDepositTotal + collectionTotal - feeTotal + projectedTotal
        ),
        syndicatorsContributing: perSyndicatorParsed.size,
        scenario,
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
  function buildSummary(perfs, sub, derived, fin, synInfo, aggregate, flows, portfolioFlows) {
    const sumDeal = (fn) => perfs.reduce((s, d) => s + fn(d), 0);
    const dates = perfs.map(d => d.fundedDate).filter(Boolean).sort();
    const profitCount = perfs.filter(d => d.status === 'Profit').length;
    const activeCount = perfs.filter(d => d.status === 'Active').length;
    const defaultCount = perfs.filter(d => d.status === 'Default').length;
    const agg = aggregate || {};

    const hasSyndicator = !!synInfo;
    // When no syndicator is selected, fall back to portfolio-wide aggregates.
    const totalInvested = hasSyndicator ? fin.totalInvestments : (agg.totalInvestedAll || 0);
    // Portfolio detour: portfolio-wide gross collections + fees now come from
    // /syndicators/export's availableCashBreakdown, summed across syndicators.
    // Previously these were hard-zeroed because we only had per-syndicator
    // detail; the new aggregate fields make the org-wide rollup meaningful.
    const totalGrossCollections = hasSyndicator
      ? derived.totalGrossCollections
      : (agg.totalCashCollectedAll || 0);
    const totalFees = hasSyndicator
      ? fin.totalFees
      : (agg.totalFeesAll || 0);

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
      // Per-syndicator: pulled from parsed statement (sub.*).
      // Portfolio view: pulled from /syndicators/export aggregates and the
      // per-syndicator statement fan-out (when available).
      //
      // externalCapital and reinvestedReturns now have real portfolio-wide
      // values via the statement fan-out. If the fan-out failed or is
      // unavailable, agg.externalCapitalAll will be null and the UI shows "—".
      totalDeposits: hasSyndicator ? sub.totalDeposits : (agg.totalDepositedAll || 0),
      externalCapital: hasSyndicator
        ? sub.externalCapital
        : (agg.externalCapitalAll != null ? round2(agg.externalCapitalAll) : null),
      reinvestedReturns: hasSyndicator
        ? sub.reinvestedReturns
        : (agg.reinvestmentsAll != null ? round2(agg.reinvestmentsAll) : null),
      totalWithdrawals: hasSyndicator ? sub.totalWithdrawals : (agg.totalWithdrawnAll || 0),
      // Net Capital Deployed = (capital still invested in deals AND not yet
      // withdrawn). For portfolio view, use externalCapitalAll if we have it
      // (matches the per-syndicator definition: external in − withdrawn out).
      // Falls back to invested-side calc if statement fan-out unavailable.
      netCapitalDeployed: hasSyndicator
        ? fin.netCapitalDeployed
        : (agg.externalCapitalAll != null
            ? round2((agg.externalCapitalAll || 0) - (agg.totalWithdrawnAll || 0))
            : round2((agg.totalInvestedAll || 0) - (agg.totalWithdrawnAll || 0))),
      // Available Cash for portfolio view is sum of per-syndicator available cash.
      currentCashBalance: hasSyndicator ? fin.cashBalance : (agg.totalAvailableCashAll || 0),
      cashBalanceSource: hasSyndicator ? (fin.cashBalanceSource || 'derived') : 'aggregate',

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
      // Fee Analysis (rows 25-30) — sourced from fin (canonical from
      // /syndicators/export breakdown when available, derived as fallback).
      managementFees: hasSyndicator ? Math.round(fin.managementFees) : 0,
      residualCommissions: hasSyndicator ? Math.round(fin.residualCommissions) : 0,
      totalFees: Math.round(totalFees),
      feeSource: hasSyndicator ? fin.feeSource : null,
      feesPctInvested,
      feesPctCollections,

      // Return Metrics (rows 32-48)
      // Per-syndicator: from fin (statement parse + canonical breakdown).
      // Portfolio view: computed from /syndicators/export aggregates plus
      // statement-fan-out totals where available.
      //
      // Key denominator change: where the formula needs "capital in," we use
      // externalCapitalAll (sum of real external deposits across syndicators)
      // when the fan-out succeeded, NOT totalDepositedAll (which double-counts
      // reinvestments). Falls back to null/0 when fan-out unavailable.
      netCollections: hasSyndicator
        ? Math.round(fin.netCollections)
        : Math.round((agg.totalCashCollectedAll || 0) - (agg.totalFeesAll || 0)),
      unreturned: hasSyndicator
        ? Math.round(fin.unreturned)
        : Math.round(agg.totalUnreturnedAll || 0),
      grossPnL: hasSyndicator
        ? Math.round(totalGrossCollections - sub.externalCapital - totalFees)
        : (agg.externalCapitalAll != null
            ? Math.round(
                (agg.totalCashCollectedAll || 0)
                - (agg.externalCapitalAll || 0)
                - (agg.totalFeesAll || 0)
              )
            : null),
      // Total Current Value = withdrawals + cash balance + unreturned-ACTIVE.
      // Defaulted unrecovered principal is a write-off, not a current asset.
      // Per-syndicator: fin.totalValue is computed in combineFinancials using
      // unreturnedActive only. Portfolio: same logic via aggregate buckets.
      totalCurrentValue: hasSyndicator
        ? Math.round(fin.totalValue)
        : Math.round(
            (agg.totalWithdrawnAll || 0)
            + (agg.totalAvailableCashAll || 0)
            + (agg.unreturnedActiveAll || 0)
          ),
      // Net Profit = Total Value - External Capital. Portfolio uses
      // externalCapitalAll from the statement fan-out (sum of real external
      // deposits, NOT totalDeposited which double-counts reinvestments).
      // Total Value uses unreturnedActiveAll, NOT totalUnreturnedAll, so
      // defaulted write-offs don't inflate Net Profit.
      netProfit: hasSyndicator
        ? Math.round(fin.netProfit)
        : (agg.externalCapitalAll != null
            ? Math.round(
                (agg.totalWithdrawnAll || 0)
                + (agg.totalAvailableCashAll || 0)
                + (agg.unreturnedActiveAll || 0)
                - (agg.externalCapitalAll || 0)
              )
            : null),
      // Projected XIRR for portfolio view comes from buildPortfolioFlows —
      // composes ALL syndicator flow series (real deposits + collections +
      // fees + projected forward from active deals; defaulted deals get $0).
      projectedXIRR: hasSyndicator
        ? (flows?.projectedXIRR != null ? round2(flows.projectedXIRR) : null)
        : (portfolioFlows?.projectedXIRR != null
            ? round2(portfolioFlows.projectedXIRR)
            : null),
      // Cash-on-Cash Multiple = Total Value / External Capital. Same
      // denominator change as netProfit; same active-only Total Value.
      cashOnCashMultiple: hasSyndicator
        ? fin.cashOnCash
        : (agg.externalCapitalAll != null && agg.externalCapitalAll > 0
            ? round2(
                ((agg.totalWithdrawnAll || 0)
                + (agg.totalAvailableCashAll || 0)
                + (agg.unreturnedActiveAll || 0))
                / agg.externalCapitalAll
              )
            : null),

      // Deal Statistics (rows 51-57)
      dealsInProfit: profitCount,
      dealsActiveBelowBasis: activeCount,
      dealsDefaulted: defaultCount,
      winRate: perfs.length > 0 ? round2(profitCount / perfs.length) : 0,
      defaultRate: perfs.length > 0 ? round2(defaultCount / perfs.length) : 0,

      // Realized vs Unrealized (rows 59+)
      // Realized Value = Withdrawals + Available Cash (the "cashed out" portion).
      realizedValue: hasSyndicator
        ? Math.round(sub.totalWithdrawals + fin.cashBalance)
        : Math.round((agg.totalWithdrawnAll || 0) + (agg.totalAvailableCashAll || 0)),
      // Realized P&L = Realized Value - External Capital. Portfolio uses the
      // real externalCapitalAll from the statement fan-out (NOT totalDeposited
      // which would double-count reinvestments).
      realizedPnL: hasSyndicator
        ? Math.round(sub.totalWithdrawals + fin.cashBalance - sub.externalCapital)
        : (agg.externalCapitalAll != null
            ? Math.round(
                (agg.totalWithdrawnAll || 0)
                + (agg.totalAvailableCashAll || 0)
                - (agg.externalCapitalAll || 0)
              )
            : null),
      realizedROI: hasSyndicator && sub.externalCapital > 0
        ? round2((sub.totalWithdrawals + fin.cashBalance - sub.externalCapital) / sub.externalCapital)
        : (!hasSyndicator && agg.externalCapitalAll != null && agg.externalCapitalAll > 0
            ? round2(
                ((agg.totalWithdrawnAll || 0)
                + (agg.totalAvailableCashAll || 0)
                - (agg.externalCapitalAll || 0))
                / agg.externalCapitalAll
              )
            : 0),
      unrealizedValue: hasSyndicator
        ? Math.round(fin.unreturned)
        : Math.round(agg.totalUnreturnedAll || 0),
      // Split: outstanding-active (genuine asset, still being collected) vs
      // outstanding-defaulted (write-off; not currently producing collections).
      // Per-syndicator: from fin (combineFinancials buckets via derived).
      // Portfolio: from aggregate buckets, computed by walking every (deal,
      // syndication) pair in the deals fan-out.
      unrealizedValueActive: hasSyndicator
        ? (fin.unreturnedActive != null ? Math.round(fin.unreturnedActive) : null)
        : Math.round(agg.unreturnedActiveAll || 0),
      unrealizedValueDefaulted: hasSyndicator
        ? (fin.unreturnedDefaulted != null ? Math.round(fin.unreturnedDefaulted) : null)
        : Math.round(agg.unreturnedDefaultedAll || 0),
      pctStillOutstanding: hasSyndicator && totalInvested > 0
        ? round2(fin.unreturned / totalInvested)
        : (!hasSyndicator && (agg.totalInvestedAll || 0) > 0
            ? round2((agg.totalUnreturnedAll || 0) / (agg.totalInvestedAll || 1))
            : 0),
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

    // 2. Syndicators (always fetch for aggregate). Uses /syndicators/export
    //    rather than the legacy /contacts endpoint because export returns the
    //    canonical `availableCash` + `availableCashBreakdown` that match the
    //    SmartMCA UI's "Available Cash" figure exactly. Per SmartMCA support:
    //    the legacy /contacts `details.runningBalance` reflects only
    //    waterfall-posted distributions and is wrong for any syndicator with
    //    deposits, withdrawals, or fee netting.
    //
    //    Canonical formula (all fields returned by the API):
    //      availableCash = totalDeposited - totalWithdrawn - totalInvestedLedger
    //                    - commissionsObligated + cashCollectedGross - managementFees
    //
    //    Note: `managementFees` here is ALL-IN fees (upfront feeDeductions +
    //    per-payment syndicationFee entries). The per-payment vs upfront
    //    split requires statement parsing (Phase 2).
    let allSyndicators = [];
    try {
      const cr = await apiFetch('/syndicators/export?format=json');
      const list = Array.isArray(cr.data)
        ? cr.data
        : Array.isArray(cr.data?.data) ? cr.data.data : [];
      allSyndicators = list.map(c => {
        const bd = c.availableCashBreakdown || {};
        return {
          id: c.id,
          name: c.name,
          type: c.type,
          // Canonical financials (top-level fields). Note totalInvested is
          // returned as a string by the API; coerce to number.
          totalInvested: parseFloat(c.totalInvested) || 0,
          availableCash: c.availableCash != null ? c.availableCash : 0,
          // Canonical breakdown components — these compose availableCash.
          totalDeposited: bd.totalDeposited || 0,
          totalWithdrawn: bd.totalWithdrawn || 0,
          totalInvestedLedger: bd.totalInvestedLedger || 0,
          cashCollectedGross: bd.cashCollectedGross || 0,
          managementFees: bd.managementFees || 0,            // ALL-IN fees
          commissionsObligated: bd.commissionsObligated || 0,
          // Other useful fields
          dealsFunded: c.dealsFunded || 0,
          activeDeals: c.activeDeals || 0,
          totalCashCollected: c.totalCashCollected || 0,    // gross, includes balance transfers
          // Legacy fields kept ONLY for fallback / backwards compat. Do not
          // use these for display: they're known to be wrong for many
          // syndicators. Always prefer availableCash and the breakdown.
          runningBalance: parseFloat(c.runningBalance) || 0,
          totalDistributed: parseFloat(c.totalDistributed) || 0,
        };
      });
    } catch (e) { /* continue with empty list */ }

    // ============================================================================
    // PORTFOLIO-LEVEL STATEMENT PARSE (Phase 2 detour)
    //
    // For the Portfolio Overview tab — when no specific syndicator is selected
    // — we fan out and parse every syndicator's full statement. This unlocks:
    //
    //   1. Real `externalCapital` aggregation. /syndicators/export only gives
    //      `totalDeposited` (which combines external + reinvest + refunds);
    //      separating them requires the full statement entries' descriptions.
    //
    //   2. Real portfolio-wide Projected XIRR. We need each syndicator's full
    //      cash-flow series (with real dates and real fees) to compose a
    //      single combined timeline that XIRR can run on.
    //
    // Cost: 9 syndicator statements at ~1s each = ~3s with concurrency=3 on
    // cold cache. Cached at SUBLEDGER TTL (5min) like other syndicator data,
    // so subsequent loads are instant. Filter to syndicators with >0 deposits
    // to skip empty contacts that wouldn't contribute anything anyway.
    //
    // Skipped if `loadParseStatement()` returns false (parser module missing
    // — defensive; shouldn't happen in production).
    // ============================================================================
    let perSyndicatorParsed = null;        // Map<syndicatorId, parsedStatement>
    let portfolioStatementDiagnostics = null;
    if (allSyndicators.length > 0) {
      try {
        const ps = await loadParseStatement();
        if (ps) {
          // Only fetch for syndicators with non-zero activity. Saves ~half the
          // calls in practice (some test syndicators have $0 deposits).
          const candidates = allSyndicators.filter(
            c => c.totalDeposited > 0 || c.cashCollectedGross > 0 || c.totalInvested > 0
          );
          // Bounded concurrency = 3 (matches the deal-fan-out's pacing for
          // the same rate-limit reason).
          const stmtUrl = (id) =>
            `/syndicators/${id}/statement?start_date=2020-01-01&end_date=2030-12-31&format=json&limit=10000`;
          const results = await pMap(candidates, async (syn) => {
            const r = await apiFetch(stmtUrl(syn.id));
            return { syndicatorId: syn.id, name: syn.name, response: r };
          }, 3);
          perSyndicatorParsed = new Map();
          let parseFailures = 0;
          for (const res of results) {
            if (res.error) {
              parseFailures++;
              continue;
            }
            try {
              const parsed = ps.parse(res.value.response);
              perSyndicatorParsed.set(res.value.syndicatorId, parsed);
            } catch (e) {
              parseFailures++;
            }
          }
          portfolioStatementDiagnostics = {
            ok: true,
            syndicatorsParsed: perSyndicatorParsed.size,
            syndicatorsAttempted: candidates.length,
            parseFailures,
          };
        } else {
          portfolioStatementDiagnostics = { ok: false, reason: 'parser_module_unavailable' };
        }
      } catch (e) {
        portfolioStatementDiagnostics = {
          ok: false,
          reason: 'fanout_threw',
          error: String(e?.message || e),
        };
      }
    }
    // ============================================================================
    // END PORTFOLIO STATEMENT FAN-OUT
    // ============================================================================

    // ============================================================================
    // PORTFOLIO-WIDE OUTSTANDING PRINCIPAL, BUCKETED BY DEAL STATUS
    //
    // For Total Value Created at portfolio level, we want to count ONLY active-
    // deal outstanding principal (genuine asset, still being collected) and
    // exclude defaulted-deal unrecovered principal (write-off, gone). Same
    // logic the per-syndicator path uses, applied to every (deal, syndication)
    // pair in the data.
    //
    // Why this works without per-syndicator statement parsing: each deal
    // record carries its full syndications array with each participant's
    // fundedAmount and cashCollected. So we can compute portfolio totals
    // directly from the deals fan-out.
    //
    // Math identity (sanity check): the sum of bucketed unreturned should
    // equal totalUnreturnedAll (same per-syndicator floor applied at the
    // syndication level rather than at the syndicator-aggregate level).
    // ============================================================================
    let unreturnedActiveAll = 0;
    let unreturnedDefaultedAll = 0;
    let unreturnedClosedAll = 0;
    for (const d of deals) {
      if (!Array.isArray(d.syndications)) continue;
      for (const s of d.syndications) {
        const invested  = parseFloat(s.fundedAmount) || 0;
        const collected = parseFloat(s.cashCollected) || 0;
        if (invested <= 0) continue;
        const unret = Math.max(0, invested - collected);
        if (unret <= 0) continue;
        if (d.status === 'defaulted') unreturnedDefaultedAll += unret;
        // Both 'closed' (paid off via collections) and 'refinanced' (paid off
        // via refi proceeds) → asset recovered, no further collections.
        else if (d.status === 'closed' || d.status === 'refinanced') unreturnedClosedAll += unret;
        else unreturnedActiveAll += unret;
      }
    }
    unreturnedActiveAll    = round2(unreturnedActiveAll);
    unreturnedDefaultedAll = round2(unreturnedDefaultedAll);
    unreturnedClosedAll    = round2(unreturnedClosedAll);

    const aggregate = {
      totalInvestedAll: allSyndicators.reduce((s, c) => s + c.totalInvested, 0),
      totalAvailableCashAll: allSyndicators.reduce((s, c) => s + c.availableCash, 0),
      totalDepositedAll: allSyndicators.reduce((s, c) => s + c.totalDeposited, 0),
      totalWithdrawnAll: allSyndicators.reduce((s, c) => s + c.totalWithdrawn, 0),
      // Phase 2 detour: portfolio-wide return-side aggregates from
      // /syndicators/export's availableCashBreakdown. These let the Portfolio
      // Overview tab fill in Total Gross Collections, Total Fees Paid, Net
      // Collections, Unreturned Principal, and derived metrics that previously
      // showed $0 when no syndicator was selected.
      totalCashCollectedAll: allSyndicators.reduce((s, c) => s + c.cashCollectedGross, 0),
      // managementFees field from API is misnamed: actually ALL-IN fees
      // (upfront feeDeductions + per-payment syndicationFees, net of reversals).
      totalFeesAll: allSyndicators.reduce((s, c) => s + c.managementFees, 0),
      // Per-syndicator unreturned (floored at 0), then summed. Flooring per-
      // syndicator (rather than on aggregate sums) gives the same total that
      // would appear if you visited each syndicator page individually.
      totalUnreturnedAll: allSyndicators.reduce(
        (s, c) => s + Math.max(0, c.totalInvestedLedger - c.cashCollectedGross), 0
      ),
      // Status-bucketed split — same calc, but separating active deals
      // (genuine outstanding asset) from defaulted (write-off, excluded
      // from Total Value Created at portfolio level). Computed by walking
      // every (deal, syndication) pair above. Closed deals included for
      // completeness but typically ~$0 (paid off → unreturned = 0).
      unreturnedActiveAll,
      unreturnedDefaultedAll,
      unreturnedClosedAll,
      // ----- From per-syndicator statement fan-out (when available) -----
      // External capital is the cleanest "money in from outside" denominator
      // for portfolio-wide ROI/profit metrics. Requires statement parsing
      // (the export endpoint doesn't separate external from reinvest/refund).
      // Falls back to null when the fan-out wasn't done or failed → the UI
      // will show "—" instead of an unreliable number.
      externalCapitalAll: perSyndicatorParsed
        ? Array.from(perSyndicatorParsed.values()).reduce((s, p) => s + (p.externalCapital || 0), 0)
        : null,
      reinvestmentsAll: perSyndicatorParsed
        ? Array.from(perSyndicatorParsed.values()).reduce((s, p) => s + (p.reinvestments || 0), 0)
        : null,
      feeRefundsAll: perSyndicatorParsed
        ? Array.from(perSyndicatorParsed.values()).reduce((s, p) => s + (p.feeRefunds || 0), 0)
        : null,
      // Legacy aliases for backwards compatibility with downstream code that
      // expects these names. Both now point at canonical values:
      //   totalRunningBalanceAll → availableCash sum (was details.runningBalance)
      //   totalDistributedAll    → withdrawn sum (was details.totalDistributed = always 0)
      totalRunningBalanceAll: allSyndicators.reduce((s, c) => s + c.availableCash, 0),
      totalDistributedAll: allSyndicators.reduce((s, c) => s + c.totalWithdrawn, 0),
      syndicatorCount: allSyndicators.length,
    };

    // 3. Per-syndicator data (only when syndicatorId provided)
    let synInfo = null;
    let sub = null;       // subledger-derived: deposits, withdrawals, investments, flows
    let derived = null;   // syndications-derived: per-deal slice + collection breakdown
    let fin = null;       // combined: cashBalance, unreturned, totalValue, netProfit, etc.
    let feeConfig = null;
    // Phase 2 Step 2: parallel statement parse (diagnostics-only — not yet
    // wired into combineFinancials or anywhere else that affects display).
    let parsedStatement = null;
    let parsedStatementDiagnostics = null;
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

      // ============================================================
      // PHASE 2 STEP 3: Statement endpoint is now the PRIMARY source.
      //
      // Single fetch replaces:
      //   - /accounting/reports/subledger/syndicator/{id} (legacy)
      //   - /deals/{id}/payments × N (per-deal payment fetches)
      //
      // Statement returns one row per LMJS transaction with full date/amount/
      // category/dealId detail. We:
      //   1. Parse it into structured aggregates (parseStatement)
      //   2. Adapt to legacy `sub` shape (statementToSubledgerShape)
      //   3. Synthesize per-deal payment lists from parsed.cashFlowsForXIRR
      //      so buildHistoricalPaymentFlows / buildCollectionCurves keep
      //      working with no changes
      //
      // Fallback: if the statement endpoint fails (unlikely but possible),
      // fall back to the legacy subledger fetch. The dashboard still loads
      // with degraded data.
      //
      // Date range: hardcoded broad window (2020 → 2030) to ensure full
      // history. Statement endpoint accepts limit=10000 → one round-trip
      // (~1s for LMJS at 1814 entries). Cached at SUBLEDGER TTL (5 min).
      // ============================================================
      const statementUrl = `/syndicators/${syndicatorId}/statement?start_date=2020-01-01&end_date=2030-12-31&format=json&limit=10000`;
      let stmtResp = null;
      try {
        stmtResp = await apiFetch(statementUrl);
      } catch (e) {
        // Statement fetch failed — capture and fall through to legacy path.
        parsedStatementDiagnostics = {
          ok: false,
          reason: 'statement_fetch_failed',
          error: String(e?.message || e),
        };
      }

      if (stmtResp) {
        try {
          const ps = await loadParseStatement();
          if (!ps) throw new Error('parseStatement module unavailable');
          const parsed = ps.parse(stmtResp);
          const summaryBlock = stmtResp?.data?.summary || null;
          const reconcile = ps.reconcile(parsed, summaryBlock);
          parsedStatement = parsed;
          parsedStatementDiagnostics = {
            ok: true,
            transactionCount: parsed.transactionCount,
            reconcile,
            unknownEntryCount: parsed.unknownEntryCount,
            primarySource: 'statement',
          };
          // Derive legacy `sub` shape from the parsed statement.
          sub = ps.toSub(parsed);
        } catch (e) {
          // Parser threw — capture diagnostic and force legacy fallback.
          parsedStatementDiagnostics = {
            ok: false,
            reason: 'parse_threw',
            error: String(e?.message || e),
          };
          stmtResp = null; // trigger legacy fallback below
        }
      }

      // Legacy fallback: if statement path failed, fetch subledger directly.
      // This keeps the dashboard alive even if the new endpoint has hiccups.
      if (!sub) {
        try {
          const subResp = await apiFetch(
            `/accounting/reports/subledger/syndicator/${syndicatorId}?limit=10000`
          );
          const entries = subResp.data?.entries
            || subResp.data?.data
            || (Array.isArray(subResp.data) ? subResp.data : []);
          sub = parseSubledger(entries);
          if (parsedStatementDiagnostics) {
            parsedStatementDiagnostics.fallback = 'subledger_legacy';
          }
        } catch (e) {
          // Both paths failed: zero-out cash-flow side, keep deal side functional.
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
          if (parsedStatementDiagnostics) {
            parsedStatementDiagnostics.fallback = 'failed_both';
          }
        }
      }
      // ============================================================
      // END PHASE 2 STEP 3 fetch+parse
      // ============================================================

      // Aggregate per-deal syndication data + per-deal collection breakdown.
      //
      // Step 3 change: when we have parsed statement data, synthesize per-deal
      // payment lists from parsed.cashFlowsForXIRR (filtered to category ===
      // 'collection'). This replaces N per-deal /deals/{id}/payments fetches
      // with one slice of already-fetched data.
      //
      // The synthesized payments are LMJS-share-applied (since statement
      // entries are already per-syndicator), so sharePct is set to 1.0
      // downstream — buildHistoricalPaymentFlows then multiplies by 1.0 = no-op.
      //
      // Fallback: if parsedStatement is unavailable, still use the per-deal
      // payment fetches (legacy path) so the dashboard works.
      let fetchPaymentsCallback = null;
      let perDealCollectionsFromStatement = null;
      if (parsedStatement) {
        // Group cashFlowsForXIRR collections by dealId → list of {date, amount}.
        // Each entry already represents LMJS's share, sharePct-applied.
        perDealCollectionsFromStatement = new Map();
        for (const f of parsedStatement.cashFlowsForXIRR) {
          if (f.category !== 'collection' || !f.dealId) continue;
          if (!perDealCollectionsFromStatement.has(f.dealId)) {
            perDealCollectionsFromStatement.set(f.dealId, []);
          }
          // Synthesize a payment-shaped object so buildHistoricalPaymentFlows
          // and buildCollectionCurves accept it without modification. amount is
          // POSITIVE (cashFlowsForXIRR signs collections as positive). status
          // is 'cleared' since the statement endpoint only returns posted entries.
          perDealCollectionsFromStatement.get(f.dealId).push({
            type: 'merchantPayment',  // we lose refi/balance-transfer distinction
                                       // (statement uses 'paymentShareAllocated' uniformly);
                                       // OK because downstream just sums collections.
            status: 'cleared',
            transactionDate: f.date,
            amount: f.amount,          // already syndicator-share applied
            direction: 'in',
          });
        }
      } else {
        // Legacy fallback: hit the per-deal payments endpoint.
        fetchPaymentsCallback = (dealInternalId) =>
          apiFetch(`/deals/${dealInternalId}/payments?limit=200`);
      }

      derived = await aggregateSyndicatorMetrics(
        deals, syndicatorId, feeConfig, sub,
        fetchPaymentsCallback,
        perDealCollectionsFromStatement
      );
      fin = combineFinancials(sub, derived, synInfo);
      flows = buildFlows(sub, fin, derived, deals, syndicatorId, undefined, feeConfig, parsedStatement);
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

    // Compute portfolio-wide flows when no syndicator is selected. Uses the
    // per-syndicator parsed statements gathered up top, plus deal projections
    // for each syndicator's active deals. Result feeds the Portfolio Overview
    // tab's Projected XIRR widget.
    let portfolioFlows = null;
    if (!syndicatorId && perSyndicatorParsed && perSyndicatorParsed.size > 0) {
      portfolioFlows = buildPortfolioFlows(perSyndicatorParsed, deals);
    }

    const summary = buildSummary(dealPerf, sub, derived, fin, synInfo, aggregate, flows, portfolioFlows);

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
      // Compact XIRR series for client-side recompute when the user adjusts
      // the Projection Confidence slider. When a syndicator is selected this
      // is the per-syndicator series; otherwise it's the portfolio-wide one
      // (composed from all syndicators' parsed statements + projections).
      xirrSeriesForRecompute: syndicatorId
        ? buildXirrSeriesForClient(flows.xirrFlows)
        : (portfolioFlows ? buildXirrSeriesForClient(portfolioFlows.xirrFlows) : null),
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
        // Phase 2 Step 3: statement parser is the PRIMARY data source.
        //   - `parsedStatementDiagnostics.ok: true`        → parser ran successfully, sub
        //                                                    is derived from parsed statement
        //   - `parsedStatementDiagnostics.fallback: ...`   → statement path failed,
        //                                                    legacy subledger path used
        //   - `parsedStatementDiagnostics.reconcile.ok`    → totals match SmartMCA's
        //                                                    /summary block (regression check)
        statement: parsedStatementDiagnostics,
        // Portfolio statement fan-out (fires when no syndicator selected).
        // Reports how many syndicators were parsed and any failures so we can
        // debug if Portfolio Overview shows "—" for externalCapital.
        portfolioStatement: portfolioStatementDiagnostics,
        // Portfolio-wide projected XIRR composition (when no syndicator selected).
        portfolioFlows: portfolioFlows ? portfolioFlows.composition : null,
        // Diagnostic: distribution of `deal.status` raw API values across
        // the deals fetch. Used to verify our defaulted-deal bucketing logic
        // catches everything it should (currently checks for the literal
        // string 'defaulted'). If any unexpected statuses appear here that
        // semantically mean "write-off" but aren't 'defaulted', we'd want to
        // expand the bucketing logic.
        dealStatusBreakdown: (() => {
          const counts = {};
          let totalUnret = 0;
          for (const d of deals) {
            const st = d.status || '(null)';
            if (!counts[st]) counts[st] = { count: 0, totalFunded: 0, totalCollected: 0, unreturned: 0 };
            counts[st].count++;
            // Sum funded/collected across ALL syndications for this deal
            // (not just the requested syndicator) so we see deal-level totals.
            if (Array.isArray(d.syndications)) {
              for (const s of d.syndications) {
                const f = parseFloat(s.fundedAmount) || 0;
                const c = parseFloat(s.cashCollected) || 0;
                counts[st].totalFunded    += f;
                counts[st].totalCollected += c;
                counts[st].unreturned     += Math.max(0, f - c);
                totalUnret += Math.max(0, f - c);
              }
            }
          }
          // Round for display
          for (const st of Object.keys(counts)) {
            counts[st].totalFunded    = Math.round(counts[st].totalFunded);
            counts[st].totalCollected = Math.round(counts[st].totalCollected);
            counts[st].unreturned     = Math.round(counts[st].unreturned);
          }
          return {
            byStatus: counts,
            totalDeals: deals.length,
            totalUnreturnedAcrossSyndicators: Math.round(totalUnret),
          };
        })(),
        // Selected parsed values (only when parser ran successfully) so
        // we can spot-check totals from the live response without needing
        // to add a separate endpoint.
        statementParsed: parsedStatement ? {
          closingBalance:           parsedStatement.closingBalance,
          computedAvailableCash:    parsedStatement.computedAvailableCash,
          reconciliationDelta:      parsedStatement.reconciliationDelta,
          transactionCount:         parsedStatement.transactionCount,
          externalCapital:          parsedStatement.externalCapital,
          reinvestments:            parsedStatement.reinvestments,
          feeRefunds:               parsedStatement.feeRefunds,
          totalDeposited:           parsedStatement.totalDeposited,
          totalWithdrawn:           parsedStatement.totalWithdrawn,
          totalInvestedLedger:      parsedStatement.totalInvestedLedger,
          cashCollectedGross:       parsedStatement.cashCollectedGross,
          cashCollectedCreditsOnly: parsedStatement.cashCollectedCreditsOnly,
          upfrontFees:              parsedStatement.upfrontFees,
          residualCommissions:      parsedStatement.residualCommissions,
          managementFees:           parsedStatement.managementFees,
          totalFeesPaid:            parsedStatement.totalFeesPaid,
          totalFeesNetOfReversals:  parsedStatement.totalFeesNetOfReversals,
          reversalsCredit:          parsedStatement.reversalsCredit,
          reversalsDebit:           parsedStatement.reversalsDebit,
          // Per-deal counts only (full Maps would bloat response)
          dealsWithCollections:     parsedStatement.collectionsByDeal.size,
          dealsWithFees:            parsedStatement.feesByDeal.size,
          dealsWithInvestments:     parsedStatement.investmentsByDeal.size,
          // Flow series count, not the full series
          xirrFlowCount:            parsedStatement.cashFlowsForXIRR.length,
        } : null,
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
