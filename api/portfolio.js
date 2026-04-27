// Vercel Serverless Function: /api/portfolio
//
// HYBRID DATA MODEL (post-staging-rebuild, Apr 2026):
//   The accounting/reports/subledger endpoint currently only emits deposit,
//   withdrawal, and investment entries (~136 entries vs. the prior ~1,334).
//   Collections (Syndicator Allocations), residual commissions (Cost-Sharing
//   Deductions), refi payoffs, and balance transfers are MISSING.
//
//   Until the upstream subledger is rebuilt, we use:
//     - Subledger        -> deposits, withdrawals, investments (cash truth)
//     - Deal-level data  -> collections, mgmt fees, residual commissions
//                           (scaled by syndicator share + per-syndicator rates)
//
// Spreadsheet formulas this matches (syndicator_report_base.xlsx):
//     Cash Balance         = Deposits - Investments + Collections - Fees - Withdrawals
//     Unreturned Principal = Total Invested - Gross Collections
//     Total Value          = Withdrawals + Cash Balance + Unreturned
//     Net Profit           = Total Value - External Capital
//     Cash-on-Cash         = Total Value / External Capital
//     Mgmt Fees            = funded amount * managementFeeRate (12% for LMJS)
//     Residual Commissions = each collection * residualCommissionRate (5% for LMJS)
//
// Sources:
//     GET /deals?limit=100&page=N
//     GET /contacts?limit=100        (response: { data: { data: [...] } } or { data: [...] })
//     GET /accounting/reports/subledger/syndicator/{id}?limit=10000

// ============================================================================
// IN-MEMORY CACHE (module-scoped, persists across warm invocations)
//   Vercel serverless functions retain module state between invocations on the
//   same warm instance. We use a Map keyed by upstream URL path, with a 5-min
//   TTL. Cold starts and concurrent instances each get their own cache — that
//   is OK at this scale.
//
//   Why cache the upstream responses (not the final JSON)? So response-shape
//   changes during a refactor don't get served from a stale cache. The
//   derivation pipeline (parse, derive, combine, summarize) is fast — ~ms.
//
//   Bypass: append ?nocache=1 to any request to force a fresh fetch.
// ============================================================================
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
const cache = new Map(); // path -> { value, expiresAt }
let cacheStats = { hits: 0, misses: 0, bypasses: 0 };

async function cachedApiFetch(path, apiKey, apiBase, { bypass = false } = {}) {
  const now = Date.now();

  if (!bypass) {
    const entry = cache.get(path);
    if (entry && entry.expiresAt > now) {
      cacheStats.hits++;
      return { data: entry.value, cached: true, ageSec: Math.floor((now - entry.fetchedAt) / 1000) };
    }
  } else {
    cacheStats.bypasses++;
  }

  const resp = await fetch(`${apiBase}${path}`, {
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  });
  if (!resp.ok) throw new Error(`${resp.status} on ${path}: ${await resp.text()}`);
  const value = await resp.json();

  cache.set(path, { value, fetchedAt: now, expiresAt: now + CACHE_TTL_MS });
  cacheStats.misses++;

  // Opportunistic eviction: if cache grows past 50 entries, drop the oldest.
  // 50 is well above what one syndicator generates (~3 paths) but caps memory
  // usage if a misconfigured client cycles through syndicator IDs.
  if (cache.size > 50) {
    const oldestKey = [...cache.entries()].sort((a, b) => a[1].fetchedAt - b[1].fetchedAt)[0][0];
    cache.delete(oldestKey);
  }

  return { data: value, cached: false, ageSec: 0 };
}

// ============================================================================
// PER-SYNDICATOR FEE CONFIG
//   Fee rates are not exposed by any current API endpoint. Until they are,
//   define them here. Add new syndicators as their rates become known.
//   _default is used when a syndicator has no explicit entry.
// ============================================================================
const SYNDICATOR_FEE_CONFIG = {
  // LMJS
  'cmo8qi0pj00vy01masnzahelz': {
    name: 'LMJS',
    managementFeeRate: 0.12,      // 12% of funded amount, charged once at deal funding
    residualCommissionRate: 0.05, // 5% of each collection
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

  // Per-request fetch tracker: which paths were hit, were they cached, ages.
  const fetchTrace = [];
  async function apiFetch(path) {
    const result = await cachedApiFetch(path, API_KEY, API_BASE, { bypass });
    fetchTrace.push({ path, cached: result.cached, ageSec: result.ageSec });
    return result.data;
  }

  function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
  function round2(v) { return Math.round(v * 100) / 100; }
  function toVintage(d) {
    if (!d) return '';
    const dt = new Date(d);
    return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}`;
  }

  // ==========================================================================
  // 1. FETCH ALL DEALS (page-based pagination)
  // ==========================================================================
  async function getAllDeals() {
    const deals = [];
    let page = 1;
    while (true) {
      const r = await apiFetch(`/deals?limit=100&page=${page}`);
      if (r.data) deals.push(...r.data);
      if (!r.meta?.pagination || page >= r.meta.pagination.totalPages) break;
      page++;
    }
    return deals;
  }

  // ==========================================================================
  // 2. MAP DEAL  (SmartMCA shape -> dashboard shape, business-level numbers)
  // ==========================================================================
  function mapDeal(d) {
    const funded = num(d.fundedAmount);
    const netFunded = num(d.netFunded);
    const rtr = num(d.purchaseAmount);
    const collected = num(d.totalCollected);
    const outstanding = num(d.outstandingBalance);
    const exposure = num(d.currentExposure);
    const pnl = num(d.pAndL);
    const bankFees = num(d.bankFees) + num(d.otherFees);
    const factor = num(d.paybackFactor);
    const vintage = toVintage(d.fundedDate);

    let status;
    if (d.status === 'defaulted') status = 'Default';
    else if (d.status === 'closed') status = 'Profit';
    else status = 'Active';

    return {
      dealNo: d.dealId || '',
      internalId: d.id || '',
      merchant: d.merchantName || '',
      merchantState: d.merchantState || '',
      invested: round2(funded),
      collected: round2(collected),
      feesPaid: round2(bankFees),
      netReturn: round2(pnl),
      roi: netFunded > 0 ? round2(pnl / netFunded) : 0,
      status,
      pmtsRemaining: status === 'Profit' ? 'Paid Off' : status === 'Default' ? 0 : '—',
      dollarRemaining: status === 'Profit' ? 'Paid Off' : round2(outstanding),
      frequency: status === 'Profit' ? 'Paid Off' : status === 'Default' ? '-' : 'Daily',
      vintage,
      netFunded: round2(netFunded),
      rtr: round2(rtr),
      totalCollectedBiz: round2(collected),
      exposureBiz: round2(exposure),
      paybackFactor: factor,
      brokerName: d.brokerName || '',
      isoName: d.iso?.isoName || '',
      score: d.scoreData?.score || 0,
      grade: d.scoreData?.grade || '',
      fundedDate: d.fundedDate || '',
    };
  }

  // ==========================================================================
  // 3. PARSE SUBLEDGER  (only what is still present: deposits, withdrawals,
  //                      investments). Collections + fees come from deals.
  // ==========================================================================
  function parseSubledger(entries) {
    const ledger = entries.filter(e => e.account === 'Syndicator Distributions Payable');

    let externalCapital = 0;       // new capital deposits
    let reinvestedReturns = 0;     // recycled payouts / reinvestments
    let feeRefunds = 0;            // fee refund credits
    let totalWithdrawals = 0;      // payouts to syndicator
    let totalInvestmentsLedger = 0; // capital deployed to deals (cash-flow truth)

    const flowsByDate = {}; // for XIRR
    const dailyFlows = {};  // for cash flow chart

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
          externalCapital += credit;
        }
        dailyFlows[date].deposits += credit;
        flowsByDate[date] = (flowsByDate[date] || 0) - credit; // negative = cash in

      } else if (desc.includes('syndicator withdrawal:')) {
        totalWithdrawals += debit;
        dailyFlows[date].withdrawals += debit;
        flowsByDate[date] = (flowsByDate[date] || 0) + debit;  // positive = cash out

      } else if (desc.includes('syndicator investment:')) {
        totalInvestmentsLedger += credit;
        dailyFlows[date].investments += credit;
      }
    }

    return {
      externalCapital: round2(externalCapital),
      reinvestedReturns: round2(reinvestedReturns),
      feeRefunds: round2(feeRefunds),
      totalDeposits: round2(externalCapital + reinvestedReturns + feeRefunds),
      totalWithdrawals: round2(totalWithdrawals),
      totalInvestmentsLedger: round2(totalInvestmentsLedger),
      flowsByDate,
      dailyFlows,
      entryCount: ledger.length,
    };
  }

  // ==========================================================================
  // 4. DERIVE SYNDICATOR-LEVEL METRICS FROM DEAL DATA
  //    Without per-deal syndicator participation in the API, we approximate
  //    the syndicator's share of each deal proportionally:
  //        syndShare = synInfo.totalInvested / sum(deal.invested)
  //    Then:
  //        syndCollected_total = syndShare * sum(deal.collected)
  //        mgmtFees            = syndInvested * managementFeeRate
  //        residualCommissions = syndCollected_total * residualCommissionRate
  // ==========================================================================
  function deriveSyndicatorMetrics(perfs, synInfo, feeConfig) {
    const bizInvestedTotal = perfs.reduce((s, d) => s + d.invested, 0);
    const bizCollectedTotal = perfs.reduce((s, d) => s + d.collected, 0);

    const syndInvested = synInfo?.totalInvested || 0;
    const syndShare = bizInvestedTotal > 0 ? syndInvested / bizInvestedTotal : 0;

    // Syndicator's share of business-level collections
    const totalGrossCollections = round2(syndShare * bizCollectedTotal);

    // Fees per spreadsheet formulas
    const managementFees = round2(syndInvested * feeConfig.managementFeeRate);
    const residualCommissions = round2(totalGrossCollections * feeConfig.residualCommissionRate);
    const totalFees = round2(managementFees + residualCommissions);

    return {
      syndShare,
      syndInvested: round2(syndInvested),
      bizInvestedTotal: round2(bizInvestedTotal),
      bizCollectedTotal: round2(bizCollectedTotal),
      totalGrossCollections,
      // The hybrid model can't reliably split collections by source (merchant
      // vs refi vs balance-transfer) without subledger detail. Attribute all
      // derived collections to merchantPayments and zero out the others until
      // the upstream subledger is rebuilt.
      merchantPayments: totalGrossCollections,
      refiProceeds: 0,
      balanceTransfersIn: 0,
      balanceTransfersOut: 0,
      managementFees,
      residualCommissions,
      totalFees,
    };
  }

  // ==========================================================================
  // 5. COMBINE FINANCIALS  (apply spreadsheet formulas exactly)
  // ==========================================================================
  function combineFinancials(sub, derived, synInfo) {
    // Total Invested: prefer the contact's totalInvested (system of record);
    // fall back to subledger investment-entry total.
    const totalInvestments = synInfo?.totalInvested != null
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
  // ==========================================================================
  function buildFlows(sub, fin) {
    const xirrFlows = [];
    for (const date of Object.keys(sub.flowsByDate).sort()) {
      const amt = round2(sub.flowsByDate[date]);
      if (amt === 0) continue;
      xirrFlows.push({
        date,
        amount: amt,
        type: amt < 0 ? 'Deposit' : 'Withdrawal',
        description: amt < 0 ? 'Syndicator Deposit' : 'Syndicator Payout',
      });
    }
    if (fin.cashBalance > 0) {
      xirrFlows.push({
        date: new Date().toISOString().slice(0, 10),
        amount: round2(fin.cashBalance),
        type: 'Current Balance',
        description: 'Cash on hand (available now)',
      });
    }

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

    return { xirrFlows, cashFlowChart };
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
  // 8. COLLECTION CURVES  (unchanged)
  // ==========================================================================
  function buildCurves(vintages) {
    const pct = vintages.map(v => ({
      vintage: v.vintage,
      month0: v.monthsActive >= 0 ? round2(v.collectionPctNI * 0.05) : null,
      month1: v.monthsActive >= 1 ? round2(v.collectionPctNI * 0.35) : null,
      month2: v.monthsActive >= 2 ? round2(v.collectionPctNI * 0.7) : null,
      month3: v.monthsActive >= 3 ? round2(v.collectionPctNI * 0.85) : null,
      month4: v.monthsActive >= 4 ? round2(v.collectionPctNI * 0.95) : null,
      month5: v.monthsActive >= 5 ? round2(v.collectionPctNI) : null,
    }));
    const dollar = pct.map((c, i) => ({
      vintage: c.vintage,
      month0: c.month0 != null ? Math.round(c.month0 * vintages[i].invested) : null,
      month1: c.month1 != null ? Math.round(c.month1 * vintages[i].invested) : null,
      month2: c.month2 != null ? Math.round(c.month2 * vintages[i].invested) : null,
      month3: c.month3 != null ? Math.round(c.month3 * vintages[i].invested) : null,
      month4: c.month4 != null ? Math.round(c.month4 * vintages[i].invested) : null,
      month5: c.month5 != null ? Math.round(c.month5 * vintages[i].invested) : null,
    }));
    return { pct, dollar };
  }

  // ==========================================================================
  // 9. BUILD SUMMARY  (matches 'Returns Summary' sheet layout)
  //    Uses sub + derived + fin. Field names preserved for the frontend.
  // ==========================================================================
  function buildSummary(perfs, sub, derived, fin, synInfo, aggregate) {
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
        start: dates[0] ? new Date(dates[0]).toLocaleDateString() : 'N/A',
        end: new Date().toLocaleDateString(),
      },
      durationDays: dates[0] ? Math.floor((new Date() - new Date(dates[0])) / 86400000) : 0,

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

      // Fee Analysis (rows 25-30)
      managementFees: hasSyndicator ? Math.round(derived.managementFees) : 0,
      residualCommissions: hasSyndicator ? Math.round(derived.residualCommissions) : 0,
      totalFees: Math.round(totalFees),
      feesPctInvested,
      feesPctCollections,

      // Return Metrics (rows 32-48)
      netCollections: hasSyndicator ? Math.round(fin.netCollections) : 0,
      unreturned: hasSyndicator ? Math.round(fin.unreturned) : 0,
      grossPnL: Math.round(sumDeal(d => d.netReturn)),
      totalCurrentValue: hasSyndicator ? Math.round(fin.totalValue) : 0,
      netProfit: hasSyndicator ? Math.round(fin.netProfit) : 0,
      projectedXIRR: 0,
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
      xirrFullRecovery: 0,
      xirrTotalLoss: 0,

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
    // 1. Deals
    const deals = await getAllDeals();
    const dealPerf = deals.map(mapDeal);

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
    let derived = null;   // deal-derived: collections, mgmt fees, residual commissions
    let fin = null;       // combined: cashBalance, unreturned, totalValue, netProfit, etc.
    let feeConfig = null;
    let flows = { xirrFlows: [], cashFlowChart: [] };

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
          flowsByDate: {}, dailyFlows: {}, entryCount: 0,
        };
      }

      derived = deriveSyndicatorMetrics(dealPerf, synInfo, feeConfig);
      fin = combineFinancials(sub, derived, synInfo);
      flows = buildFlows(sub, fin);
    }

    // 4. Compute vintages + curves (deal-level, syndicator-agnostic)
    const vintagesSynd = computeVintages(dealPerf);
    const curves = buildCurves(vintagesSynd);
    const summary = buildSummary(dealPerf, sub, derived, fin, synInfo, aggregate);

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
      vintagesBiz,
      xirrFlows: flows.xirrFlows,
      cashFlowChart: flows.cashFlowChart,
      summary,
      aggregate,
      _debug: {
        subledger: sub ? {
          entryCount: sub.entryCount,
          externalCapital: sub.externalCapital,
          totalDeposits: sub.totalDeposits,
          totalWithdrawals: sub.totalWithdrawals,
          totalInvestmentsLedger: sub.totalInvestmentsLedger,
        } : null,
        derived: derived ? {
          syndShare: derived.syndShare,
          syndInvested: derived.syndInvested,
          bizInvestedTotal: derived.bizInvestedTotal,
          bizCollectedTotal: derived.bizCollectedTotal,
          totalGrossCollections: derived.totalGrossCollections,
          managementFees: derived.managementFees,
          residualCommissions: derived.residualCommissions,
          totalFees: derived.totalFees,
        } : null,
        financials: fin,
        feeConfig: feeConfig ? {
          managementFeeRate: feeConfig.managementFeeRate,
          residualCommissionRate: feeConfig.residualCommissionRate,
          source: SYNDICATOR_FEE_CONFIG[syndicatorId] ? 'explicit' : 'default',
        } : null,
        cache: {
          ttlSec: CACHE_TTL_MS / 1000,
          // Per-request: which upstream paths we hit and whether each was cached
          fetches: fetchTrace,
          hitsThisRequest: fetchTrace.filter(f => f.cached).length,
          missesThisRequest: fetchTrace.filter(f => !f.cached).length,
          // Lifetime stats since this serverless instance warmed up
          lifetimeStats: { ...cacheStats },
          bypassed: bypass,
        },
      },
      _meta: {
        fetchedAt: new Date().toISOString(),
        dealCount: deals.length,
        syndicatorId: syndicatorId || null,
        syndicatorName: synInfo?.name || null,
        hasSubledger: !!sub,
        source: 'SmartMCA Nexus API (live, hybrid: subledger + deal-derived)',
        cacheStatus: fetchTrace.every(f => f.cached) ? 'all-cached'
          : fetchTrace.some(f => f.cached) ? 'partial-cache'
          : 'fresh',
        notes: syndicatorId
          ? 'Collections, mgmt fees, and residual commissions are derived from deal-level data and per-syndicator fee rates. Subledger currently lacks Syndicator Allocation and Cost-Sharing entries (staging rebuild, Apr 2026).'
          : null,
      },
    });
  } catch (error) {
    res.status(500).json({ error: 'Portfolio aggregation failed', details: error.message });
  }
}
