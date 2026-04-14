// Vercel Serverless Function: /api/portfolio
// Maps actual SmartMCA staging API fields to dashboard structure

export default async function handler(req, res) {
  const API_KEY = process.env.SMARTMCA_API_KEY;
  const API_BASE = process.env.SMARTMCA_API_BASE || 'https://api.staging.v3.smartmca.com/api/public/v1';

  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!API_KEY) return res.status(500).json({ error: 'SMARTMCA_API_KEY not configured.' });

  async function apiFetch(path, params = {}) {
    const qs = new URLSearchParams(params).toString();
    const url = `${API_BASE}${path}${qs ? '?' + qs : ''}`;
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    });
    if (!resp.ok) throw new Error(`${resp.status} on ${path}: ${await resp.text()}`);
    return resp.json();
  }

  // Page-based pagination (meta.pagination.page, totalPages)
  async function getAllDeals() {
    const deals = [];
    let page = 1;
    while (true) {
      const resp = await apiFetch('/deals', { limit: '100', page: String(page) });
      if (resp.data) deals.push(...resp.data);
      const pag = resp.meta?.pagination;
      if (!pag || page >= pag.totalPages) break;
      page++;
    }
    return deals;
  }

  // All numeric fields from SmartMCA come as strings
  function num(v) {
    if (v == null || v === '') return 0;
    const n = parseFloat(v);
    return isNaN(n) ? 0 : n;
  }

  function toVintage(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function round2(v) { return Math.round(v * 100) / 100; }

  // ============================================================
  // MAP EACH DEAL — uses actual SmartMCA field names
  // ============================================================
  function mapDeal(d) {
    const fundedAmount = num(d.fundedAmount);
    const netFunded = num(d.netFunded);
    const purchaseAmount = num(d.purchaseAmount);   // = RTR
    const totalCollected = num(d.totalCollected);
    const outstandingBalance = num(d.outstandingBalance);
    const currentExposure = num(d.currentExposure);
    const pnl = num(d.pAndL);
    const bankFees = num(d.bankFees);
    const otherFees = num(d.otherFees);
    const paybackFactor = num(d.paybackFactor);
    const vintage = toVintage(d.fundedDate);

    // Status: API gives "active", "closed", "defaulted"
    let status;
    if (d.status === 'defaulted') {
      status = 'Default';
    } else if (d.status === 'closed') {
      status = 'Profit';  // closed deals have been paid off
    } else {
      status = 'Active';  // active — may be above or below basis
    }

    const totalFees = bankFees + otherFees;
    const netReturn = pnl;  // pAndL already accounts for fees
    const roi = netFunded > 0 ? netReturn / netFunded : 0;

    return {
      dealNo: d.dealId || '',
      merchant: d.merchantName || d.merchant?.legalName || '',
      merchantState: d.merchantState || d.merchant?.businessState || '',
      invested: round2(fundedAmount),
      collected: round2(totalCollected),
      feesPaid: round2(totalFees),
      netReturn: round2(netReturn),
      roi: round2(roi),
      status,
      pmtsRemaining: status === 'Profit' ? 'Paid Off' : status === 'Default' ? 0 : (d.paymentCount || '—'),
      dollarRemaining: status === 'Profit' ? 'Paid Off' : round2(outstandingBalance),
      frequency: status === 'Profit' ? 'Paid Off' : status === 'Default' ? '-' : 'Daily',
      vintage,
      // Business-level fields
      netFunded: round2(netFunded),
      rtr: round2(purchaseAmount),
      totalCollectedBiz: round2(totalCollected),
      exposureBiz: round2(currentExposure),
      paybackFactor,
      // Extra info
      brokerName: d.brokerName || '',
      isoName: d.iso?.isoName || '',
      score: d.scoreData?.score || 0,
      grade: d.scoreData?.grade || '',
      subStatus: d.subStatus || '',
      dealType: d.dealType || '',
      fundedDate: d.fundedDate || '',
    };
  }

  // ============================================================
  // VINTAGE ANALYSIS
  // ============================================================
  function computeVintages(perfs) {
    const map = {};
    for (const d of perfs) {
      const v = d.vintage;
      if (!v) continue;
      if (!map[v]) {
        map[v] = { vintage: v, numDeals: 0, invested: 0, totalCollected: 0, totalFees: 0,
          netCollections: 0, defaults: 0, remainingRTR: 0, defaultedRTR: 0,
          netFunded: 0, rtr: 0, totalCollectedBiz: 0 };
      }
      const m = map[v];
      m.numDeals++;
      m.invested += d.invested;
      m.totalCollected += d.collected;
      m.totalFees += d.feesPaid;
      m.netCollections += d.collected - d.feesPaid;
      m.netFunded += d.netFunded;
      m.rtr += d.rtr;
      m.totalCollectedBiz += d.totalCollectedBiz;
      const remaining = typeof d.dollarRemaining === 'number' ? d.dollarRemaining : 0;
      m.remainingRTR += remaining;
      if (d.status === 'Default') {
        m.defaults++;
        m.defaultedRTR += remaining;
      }
    }

    return Object.values(map)
      .sort((a, b) => a.vintage.localeCompare(b.vintage))
      .map(v => {
        const collPct = v.invested > 0 ? v.netCollections / v.invested : 0;
        const mo = Math.max(0, Math.floor((new Date() - new Date(v.vintage + '-01')) / (1000 * 60 * 60 * 24 * 30.44)));
        return {
          vintage: v.vintage, numDeals: v.numDeals,
          invested: round2(v.invested), totalCollected: round2(v.totalCollected),
          totalFees: round2(v.totalFees), netCollections: round2(v.netCollections),
          collectionPctNI: round2(collPct),
          remainingRTR: round2(v.remainingRTR), defaultedRTR: round2(v.defaultedRTR),
          defaultPctRTR: v.remainingRTR > 0 ? round2(v.defaultedRTR / v.remainingRTR) : 0,
          exposure: round2(v.invested - v.netCollections),
          defaultRate: v.numDeals > 0 ? round2(v.defaults / v.numDeals) : 0,
          monthsActive: mo,
          avgMonthlyYield: mo > 0 ? round2(collPct / mo) : 0,
          // Business level
          netFunded: round2(v.netFunded), rtr: round2(v.rtr),
          totalCollectedBiz: round2(v.totalCollectedBiz),
          collectionPctNF: v.netFunded > 0 ? round2(v.totalCollectedBiz / v.netFunded) : 0,
          exposureBiz: round2(Math.max(0, v.netFunded - v.totalCollectedBiz)),
        };
      });
  }

  // ============================================================
  // SUMMARY
  // ============================================================
  function computeSummary(perfs, vintages) {
    const sum = (arr, fn) => arr.reduce((s, d) => s + fn(d), 0);
    const totalInvested = sum(perfs, d => d.invested);
    const totalCollected = sum(perfs, d => d.collected);
    const totalFees = sum(perfs, d => d.feesPaid);
    const netCollections = totalCollected - totalFees;
    const grossPnL = sum(perfs, d => d.netReturn);
    const totalNetFunded = sum(perfs, d => d.netFunded);
    const totalRTR = sum(perfs, d => d.rtr);
    const totalCollectedBiz = sum(perfs, d => d.totalCollectedBiz);
    const unreturned = Math.max(0, totalInvested - totalCollected);
    const profit = perfs.filter(d => d.status === 'Profit').length;
    const active = perfs.filter(d => d.status === 'Active').length;
    const defaulted = perfs.filter(d => d.status === 'Default').length;

    const dates = perfs.map(d => d.vintage).filter(Boolean).sort();

    return {
      period: { start: dates[0] || 'Live', end: new Date().toLocaleDateString() },
      durationDays: '-',
      totalInvested: Math.round(totalInvested),
      numDeals: perfs.length,
      avgDealSize: perfs.length > 0 ? Math.round(totalInvested / perfs.length) : 0,
      totalGrossCollections: Math.round(totalCollected),
      collectionsPctInvested: totalInvested > 0 ? round2(totalCollected / totalInvested) : 0,
      totalFees: Math.round(totalFees),
      feesPctInvested: totalInvested > 0 ? round2(totalFees / totalInvested) : 0,
      feesPctCollections: totalCollected > 0 ? round2(totalFees / totalCollected) : 0,
      netCollections: Math.round(netCollections),
      unreturned: Math.round(unreturned),
      grossPnL: Math.round(grossPnL),
      dealsInProfit: profit,
      dealsActiveBelowBasis: active,
      dealsDefaulted: defaulted,
      winRate: perfs.length > 0 ? round2(profit / perfs.length) : 0,
      defaultRate: perfs.length > 0 ? round2(defaulted / perfs.length) : 0,
      totalNetFunded: Math.round(totalNetFunded),
      totalRTR: Math.round(totalRTR),
      totalCollectedBiz: Math.round(totalCollectedBiz),
      collectionPctNF: totalNetFunded > 0 ? round2(totalCollectedBiz / totalNetFunded) : 0,
      avgPaybackFactor: perfs.length > 0 ? round2(sum(perfs, d => d.paybackFactor) / perfs.length) : 0,
      totalExposure: Math.max(0, Math.round(totalNetFunded - totalCollectedBiz)),
      totalRemainingRTR: Math.round(totalRTR - totalCollectedBiz),
      totalMerchantPayments: Math.round(totalCollected),
      netProfit: Math.round(grossPnL),
      unrealizedValue: Math.round(unreturned),
      pctStillOutstanding: totalInvested > 0 ? round2(unreturned / totalInvested) : 0,
      // Syndicator ledger fields (not available from deals API)
      externalCapital: 0, reinvestedReturns: 0, totalDeposits: 0,
      totalWithdrawals: 0, netCapitalDeployed: 0, currentCashBalance: 0,
      managementFees: 0, residualCommissions: 0,
      refiProceeds: 0, balanceTransfersIn: 0, balanceTransfersOut: 0,
      totalCurrentValue: 0, projectedXIRR: 0, cashOnCashMultiple: 0,
      realizedValue: 0, realizedPnL: 0, realizedROI: 0,
      xirrFullRecovery: 0, xirrTotalLoss: 0,
      dailyPctDeals: 0, weeklyPctDeals: 0,
      dailyAvgDays: 0, weeklyAvgWeeks: 0,
      moIRR_noDefault: 0, annIRR_noDefault: 0, moic_noDefault: 0,
      moIRR_adjusted: 0, annIRR_adjusted: 0, moic_adjusted: 0,
    };
  }

  // ============================================================
  // MAIN
  // ============================================================
  try {
    const deals = await getAllDeals();
    const dealPerf = deals.map(mapDeal);
    const vintagesSynd = computeVintages(dealPerf);
    const summary = computeSummary(dealPerf, vintagesSynd);

    // Collection curves (approximated from vintage data)
    const curvesPct = vintagesSynd.map(v => ({
      vintage: v.vintage,
      month0: v.monthsActive >= 0 ? round2(v.collectionPctNI * 0.05) : null,
      month1: v.monthsActive >= 1 ? round2(v.collectionPctNI * 0.35) : null,
      month2: v.monthsActive >= 2 ? round2(v.collectionPctNI * 0.7) : null,
      month3: v.monthsActive >= 3 ? round2(v.collectionPctNI * 0.85) : null,
      month4: v.monthsActive >= 4 ? round2(v.collectionPctNI * 0.95) : null,
      month5: v.monthsActive >= 5 ? round2(v.collectionPctNI) : null,
    }));
    const curvesDollar = curvesPct.map((c, i) => ({
      vintage: c.vintage,
      month0: c.month0 != null ? Math.round(c.month0 * vintagesSynd[i].invested) : null,
      month1: c.month1 != null ? Math.round(c.month1 * vintagesSynd[i].invested) : null,
      month2: c.month2 != null ? Math.round(c.month2 * vintagesSynd[i].invested) : null,
      month3: c.month3 != null ? Math.round(c.month3 * vintagesSynd[i].invested) : null,
      month4: c.month4 != null ? Math.round(c.month4 * vintagesSynd[i].invested) : null,
      month5: c.month5 != null ? Math.round(c.month5 * vintagesSynd[i].invested) : null,
    }));

    // Business-level vintages
    const vintagesBiz = vintagesSynd.map(v => ({
      vintage: v.vintage, numDeals: v.numDeals,
      netFunded: Math.round(v.netFunded), rtr: Math.round(v.rtr),
      totalCollected: Math.round(v.totalCollectedBiz),
      collectionPctNF: v.collectionPctNF,
      exposure: Math.round(v.exposureBiz),
      defaultRate: v.defaultRate,
    }));

    res.status(200).json({
      dealPerf, vintagesSynd, curvesPct, curvesDollar, vintagesBiz,
      xirrFlows: [],
      summary,
      _meta: {
        fetchedAt: new Date().toISOString(),
        dealCount: deals.length,
        source: 'SmartMCA Nexus API (live)',
        apiBase: API_BASE,
      },
    });
  } catch (error) {
    res.status(500).json({ error: 'Portfolio aggregation failed', details: error.message });
  }
}
