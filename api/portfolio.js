// Vercel Serverless Function: /api/portfolio
// Aggregates all deal data into the dashboard structure

export default async function handler(req, res) {
  const API_KEY = process.env.SMARTMCA_API_KEY;
  const API_BASE = process.env.SMARTMCA_API_BASE || 'https://api.nexus.smartmca.com/api/public/v1';

  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!API_KEY) return res.status(500).json({ error: 'SMARTMCA_API_KEY not configured. Add it in Vercel → Settings → Environment Variables.' });

  async function apiFetch(path, params = {}) {
    const qs = new URLSearchParams(params).toString();
    const url = `${API_BASE}${path}${qs ? '?' + qs : ''}`;
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    });
    if (!resp.ok) throw new Error(`${resp.status} on ${path}: ${await resp.text()}`);
    return resp.json();
  }

  async function getAllDeals() {
    const deals = [];
    let cursor = null;
    while (true) {
      const params = { limit: '100' };
      if (cursor) params.cursor = cursor;
      const resp = await apiFetch('/deals', params);
      deals.push(...resp.data);
      if (!resp.meta?.pagination?.has_more) break;
      cursor = resp.meta.pagination.next_cursor;
    }
    return deals;
  }

  async function getDealPayments(dealId) {
    try {
      const resp = await apiFetch(`/deals/${dealId}/payments`, { limit: '100' });
      return resp.data || [];
    } catch (e) { return []; }
  }

  function computeDealPerformance(deal, syndicatorPayments) {
    const netFunded = deal.netFunded || deal.NET_FUNDED || 0;
    const syndInvested = syndicatorPayments
      .filter(p => p.type === 'investment')
      .reduce((s, p) => s + (p.amount || 0), 0);
    const syndPct = netFunded > 0 ? syndInvested / netFunded : 0;
    const collected = syndicatorPayments
      .filter(p => ['merchant_payment', 'refi_incoming', 'balance_transfer_in'].includes(p.type))
      .reduce((s, p) => s + (p.amount || 0), 0);
    const feesPaid = syndicatorPayments
      .filter(p => ['Fee Paid (Per Transaction)', 'Management Fee Paid (One Time)'].includes(p.type))
      .reduce((s, p) => s + (p.amount || 0), 0);
    const netReturn = collected - syndInvested - feesPaid;
    const roi = syndInvested > 0 ? netReturn / syndInvested : 0;

    let status = 'Active';
    if (netReturn > 0) {
      status = 'Profit';
    } else {
      const lastPayment = syndicatorPayments
        .filter(p => p.type === 'merchant_payment')
        .sort((a, b) => new Date(b.date) - new Date(a.date))[0];
      const firstInvestment = syndicatorPayments
        .filter(p => p.type === 'investment')
        .sort((a, b) => new Date(a.date) - new Date(b.date))[0];
      const now = new Date();
      const daysSinceLastPayment = lastPayment ? (now - new Date(lastPayment.date)) / 86400000 : 999;
      const daysSinceInvestment = firstInvestment ? (now - new Date(firstInvestment.date)) / 86400000 : 0;
      if (daysSinceLastPayment > 30 && daysSinceInvestment > 14) status = 'Default';
    }

    const remainingPayments = deal.remainingPayments || deal.REMAINING_PAYMENTS || 0;
    const outstanding = deal.outstanding || deal.OUTSTANDING || 0;
    const dailyAmt = deal.dailyCollectionAmount || deal.DAILY_COLLECTION_AMOUNT || 0;
    const weeklyAmt = deal.weeklyCollectionAmount || deal.WEEKLY_COLLECTION_AMOUNT || 0;

    return {
      dealNo: deal.id || deal.DEAL_ID || deal.dealId,
      merchant: deal.merchant?.legalName || deal.MERCHANT_NAME || deal.merchantName || '',
      invested: Math.round(syndInvested * 100) / 100,
      collected: Math.round(collected * 100) / 100,
      feesPaid: Math.round(feesPaid * 100) / 100,
      netReturn: Math.round(netReturn * 100) / 100,
      roi: Math.round(roi * 100) / 100,
      status,
      pmtsRemaining: status === 'Profit' ? 'Paid Off' : Math.round(remainingPayments * syndPct),
      dollarRemaining: status === 'Profit' ? 'Paid Off' : Math.round(outstanding * syndPct * 100) / 100,
      frequency: status === 'Profit' ? 'Paid Off' : status === 'Default' ? '-' : dailyAmt > 0 ? 'Daily' : weeklyAmt > 0 ? 'Weekly' : 'Daily',
      vintage: deal.vintage || deal.VINTAGE || '',
      netFunded,
      rtr: deal.purchased || deal.PURCHASED || 0,
      totalCollectedBiz: deal.totalCollected || deal.TOTAL_COLLECTED || 0,
      exposureBiz: deal.exposure || deal.EXPOSURE || 0,
      paybackFactor: deal.paybackFactor || deal.PAYBACK_FACTOR || 0,
    };
  }

  function computeVintageAnalysis(dealPerfs) {
    const vintageMap = {};
    for (const d of dealPerfs) {
      const v = d.vintage;
      if (!v) continue;
      if (!vintageMap[v]) {
        vintageMap[v] = { vintage: v, numDeals: 0, invested: 0, totalCollected: 0, totalFees: 0,
          netCollections: 0, defaults: 0, remainingRTR: 0, defaultedRTR: 0 };
      }
      const vm = vintageMap[v];
      vm.numDeals++;
      vm.invested += d.invested;
      vm.totalCollected += d.collected;
      vm.totalFees += d.feesPaid;
      vm.netCollections += d.collected - d.feesPaid;
      if (d.status === 'Default') {
        vm.defaults++;
        vm.defaultedRTR += typeof d.dollarRemaining === 'number' ? d.dollarRemaining : 0;
      }
      vm.remainingRTR += typeof d.dollarRemaining === 'number' ? d.dollarRemaining : 0;
    }
    return Object.values(vintageMap)
      .sort((a, b) => a.vintage.localeCompare(b.vintage))
      .map(v => {
        const collPct = v.invested > 0 ? v.netCollections / v.invested : 0;
        const moActive = Math.max(0, Math.floor((new Date() - new Date(v.vintage + '-01')) / (1000 * 60 * 60 * 24 * 30.44)));
        return {
          ...v,
          collectionPctNI: collPct,
          exposure: v.invested - v.netCollections,
          defaultRate: v.numDeals > 0 ? v.defaults / v.numDeals : 0,
          defaultPctRTR: v.remainingRTR > 0 ? v.defaultedRTR / v.remainingRTR : 0,
          monthsActive: moActive,
          avgMonthlyYield: moActive > 0 ? collPct / moActive : 0,
        };
      });
  }

  function computeSummary(dealPerfs) {
    const totalInvested = dealPerfs.reduce((s, d) => s + d.invested, 0);
    const totalCollected = dealPerfs.reduce((s, d) => s + d.collected, 0);
    const totalFees = dealPerfs.reduce((s, d) => s + d.feesPaid, 0);
    const netCollections = totalCollected - totalFees;
    const unreturned = Math.max(totalInvested - totalCollected, 0);
    const totalNetFunded = dealPerfs.reduce((s, d) => s + d.netFunded, 0);
    const totalRTR = dealPerfs.reduce((s, d) => s + d.rtr, 0);
    const totalCollectedBiz = dealPerfs.reduce((s, d) => s + d.totalCollectedBiz, 0);
    const dealsInProfit = dealPerfs.filter(d => d.status === 'Profit').length;
    const dealsActive = dealPerfs.filter(d => d.status === 'Active').length;
    const dealsDefaulted = dealPerfs.filter(d => d.status === 'Default').length;

    return {
      period: { start: 'Live', end: new Date().toLocaleDateString() },
      durationDays: '-',
      totalInvested: Math.round(totalInvested),
      numDeals: dealPerfs.length,
      avgDealSize: dealPerfs.length > 0 ? Math.round(totalInvested / dealPerfs.length) : 0,
      totalGrossCollections: Math.round(totalCollected),
      collectionsPctInvested: totalInvested > 0 ? totalCollected / totalInvested : 0,
      totalFees: Math.round(totalFees),
      feesPctInvested: totalInvested > 0 ? totalFees / totalInvested : 0,
      feesPctCollections: totalCollected > 0 ? totalFees / totalCollected : 0,
      netCollections: Math.round(netCollections),
      unreturned: Math.round(unreturned),
      grossPnL: Math.round(netCollections - totalInvested),
      dealsInProfit, dealsActiveBelowBasis: dealsActive, dealsDefaulted,
      winRate: dealPerfs.length > 0 ? dealsInProfit / dealPerfs.length : 0,
      defaultRate: dealPerfs.length > 0 ? dealsDefaulted / dealPerfs.length : 0,
      totalNetFunded: Math.round(totalNetFunded),
      totalRTR: Math.round(totalRTR),
      totalCollectedBiz: Math.round(totalCollectedBiz),
      collectionPctNF: totalNetFunded > 0 ? totalCollectedBiz / totalNetFunded : 0,
      totalExposure: Math.max(0, Math.round(totalNetFunded - totalCollectedBiz)),
      totalRemainingRTR: Math.round(totalRTR - totalCollectedBiz),
      externalCapital: 0, reinvestedReturns: 0, totalDeposits: 0, totalWithdrawals: 0,
      netCapitalDeployed: 0, currentCashBalance: 0, managementFees: 0, residualCommissions: 0,
      totalMerchantPayments: 0, refiProceeds: 0, balanceTransfersIn: 0, balanceTransfersOut: 0,
      totalCurrentValue: 0, netProfit: 0, projectedXIRR: 0, cashOnCashMultiple: 0,
      realizedValue: 0, realizedPnL: 0, realizedROI: 0,
      unrealizedValue: Math.round(unreturned), pctStillOutstanding: totalInvested > 0 ? unreturned / totalInvested : 0,
      xirrFullRecovery: 0, xirrTotalLoss: 0, avgPaybackFactor: 0,
      dailyPctDeals: 0, weeklyPctDeals: 0, dailyAvgDays: 0, weeklyAvgWeeks: 0,
      moIRR_noDefault: 0, annIRR_noDefault: 0, moic_noDefault: 0,
      moIRR_adjusted: 0, annIRR_adjusted: 0, moic_adjusted: 0,
    };
  }

  try {
    const deals = await getAllDeals();
    const paymentsByDeal = {};
    await Promise.all(
      deals.map(async (deal) => {
        const dealId = deal.id || deal.dealId;
        paymentsByDeal[dealId] = await getDealPayments(dealId);
      })
    );

    const dealPerf = deals.map(deal => {
      const dealId = deal.id || deal.dealId;
      return computeDealPerformance(deal, paymentsByDeal[dealId] || []);
    });

    const vintagesSynd = computeVintageAnalysis(dealPerf);
    const summary = computeSummary(dealPerf);

    const curvesPct = vintagesSynd.map(v => ({
      vintage: v.vintage,
      month0: v.monthsActive >= 0 ? (v.collectionPctNI * 0.05) : null,
      month1: v.monthsActive >= 1 ? (v.collectionPctNI * 0.35) : null,
      month2: v.monthsActive >= 2 ? v.collectionPctNI : null,
      month3: v.monthsActive >= 3 ? v.collectionPctNI : null,
      month4: v.monthsActive >= 4 ? v.collectionPctNI : null,
      month5: v.monthsActive >= 5 ? v.collectionPctNI : null,
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

    const vintagesBiz = vintagesSynd.map(v => {
      const vDeals = dealPerf.filter(d => d.vintage === v.vintage);
      const nf = Math.round(vDeals.reduce((s, d) => s + d.netFunded, 0));
      const tc = Math.round(vDeals.reduce((s, d) => s + d.totalCollectedBiz, 0));
      return {
        vintage: v.vintage, numDeals: v.numDeals, netFunded: nf,
        rtr: Math.round(vDeals.reduce((s, d) => s + d.rtr, 0)),
        totalCollected: tc,
        collectionPctNF: nf > 0 ? tc / nf : 0,
        exposure: Math.max(0, nf - tc),
        defaultRate: v.defaultRate,
      };
    });

    res.status(200).json({
      dealPerf, vintagesSynd, curvesPct, curvesDollar, vintagesBiz,
      xirrFlows: [],
      summary,
      _meta: { fetchedAt: new Date().toISOString(), dealCount: deals.length, source: 'SmartMCA Nexus API (live)' },
    });
  } catch (error) {
    res.status(500).json({ error: 'Portfolio aggregation failed', details: error.message });
  }
}
