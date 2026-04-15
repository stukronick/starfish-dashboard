// Vercel Serverless Function: /api/portfolio
// Combines /deals + /accounting/reports/subledger/syndicator/{id} + /contacts
// Accepts ?syndicatorId= to scope to a specific syndicator

export default async function handler(req, res) {
  const API_KEY = process.env.SMARTMCA_API_KEY;
  const API_BASE = process.env.SMARTMCA_API_BASE || 'https://api.staging.v3.smartmca.com/api/public/v1';

  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!API_KEY) return res.status(500).json({ error: 'SMARTMCA_API_KEY not configured.' });

  const { syndicatorId } = req.query;

  async function apiFetch(path) {
    const url = `${API_BASE}${path}`;
    const resp = await fetch(url, {
      headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    });
    if (!resp.ok) throw new Error(`${resp.status} on ${path}: ${await resp.text()}`);
    return resp.json();
  }

  async function getAllDeals() {
    const deals = [];
    let page = 1;
    while (true) {
      const resp = await apiFetch(`/deals?limit=100&page=${page}`);
      if (resp.data) deals.push(...resp.data);
      const pag = resp.meta?.pagination;
      if (!pag || page >= pag.totalPages) break;
      page++;
    }
    return deals;
  }

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

  function mapDeal(d) {
    const fundedAmount = num(d.fundedAmount);
    const netFunded = num(d.netFunded);
    const purchaseAmount = num(d.purchaseAmount);
    const totalCollected = num(d.totalCollected);
    const outstandingBalance = num(d.outstandingBalance);
    const currentExposure = num(d.currentExposure);
    const pnl = num(d.pAndL);
    const bankFees = num(d.bankFees) + num(d.otherFees);
    const paybackFactor = num(d.paybackFactor);
    const vintage = toVintage(d.fundedDate);

    let status;
    if (d.status === 'defaulted') status = 'Default';
    else if (d.status === 'closed') status = 'Profit';
    else status = 'Active';

    return {
      dealNo: d.dealId || '',
      internalId: d.id || '',
      merchant: d.merchantName || d.merchant?.legalName || '',
      merchantState: d.merchantState || '',
      invested: round2(fundedAmount),
      collected: round2(totalCollected),
      feesPaid: round2(bankFees),
      netReturn: round2(pnl),
      roi: netFunded > 0 ? round2(pnl / netFunded) : 0,
      status,
      pmtsRemaining: status === 'Profit' ? 'Paid Off' : status === 'Default' ? 0 : '—',
      dollarRemaining: status === 'Profit' ? 'Paid Off' : round2(outstandingBalance),
      frequency: status === 'Profit' ? 'Paid Off' : status === 'Default' ? '-' : 'Daily',
      vintage,
      netFunded: round2(netFunded),
      rtr: round2(purchaseAmount),
      totalCollectedBiz: round2(totalCollected),
      exposureBiz: round2(currentExposure),
      paybackFactor,
      brokerName: d.brokerName || '',
      isoName: d.iso?.isoName || '',
      score: d.scoreData?.score || 0,
      grade: d.scoreData?.grade || '',
      fundedDate: d.fundedDate || '',
    };
  }

  function parseSubledger(entries, currentBalance) {
    const ledger = entries.filter(e => e.account === 'Syndicator Distributions Payable');

    let externalDeposits = 0;
    let reinvestedReturns = 0;
    let feeRefunds = 0;
    let totalWithdrawals = 0;
    let totalInvestments = 0;
    let totalAllocations = 0;
    let totalCostSharing = 0;
    let totalEarlyPayoff = 0;
    let merchantPayments = 0;
    let refiProceeds = 0;

    const dailyFlows = {};
    const flowsByDate = {};

    for (const e of ledger) {
      const desc = (e.description || '').toLowerCase();
      const date = (e.date || '').slice(0, 10);
      const credit = e.credit || 0;
      const debit = e.debit || 0;

      if (!dailyFlows[date]) dailyFlows[date] = { deposits: 0, withdrawals: 0, allocations: 0, fees: 0 };

      if (desc.includes('syndicator deposit:')) {
        // Classify deposit type
        if (desc.includes('reinvest') || desc.includes('payout')) {
          reinvestedReturns += credit;
        } else if (desc.includes('refund')) {
          // Fee refunds — not new capital, track separately
          feeRefunds += credit;
        } else {
          externalDeposits += credit;
        }
        dailyFlows[date].deposits += credit;
        if (!flowsByDate[date]) flowsByDate[date] = 0;
        flowsByDate[date] -= credit;
      } else if (desc.includes('syndicator withdrawal:')) {
        totalWithdrawals += debit;
        dailyFlows[date].withdrawals += debit;
        if (!flowsByDate[date]) flowsByDate[date] = 0;
        flowsByDate[date] += debit;
      } else if (desc.includes('syndicator investment:')) {
        totalInvestments += credit;
      } else if (desc.includes('syndicator allocation:')) {
        totalAllocations += credit;
        if (desc.includes('early payoff') || desc.includes('early partial payoff')) {
          totalEarlyPayoff += credit;
          refiProceeds += credit;
        } else {
          merchantPayments += credit;
        }
        dailyFlows[date].allocations += credit;
      } else if (desc.includes('cost-sharing deductions:')) {
        totalCostSharing += debit;
        dailyFlows[date].fees += debit;
      }
    }

    const totalDeposits = externalDeposits + reinvestedReturns + feeRefunds;

    // XIRR flows
    const xirrFlows = [];
    const sortedDates = Object.keys(flowsByDate).sort();
    for (const date of sortedDates) {
      const amt = round2(flowsByDate[date]);
      if (amt !== 0) {
        xirrFlows.push({
          date, amount: amt,
          type: amt < 0 ? 'Deposit' : 'Withdrawal',
          description: amt < 0 ? 'Syndicator Deposit' : 'Syndicator Payout',
        });
      }
    }
    if (currentBalance > 0) {
      xirrFlows.push({
        date: new Date().toISOString().slice(0, 10),
        amount: round2(currentBalance),
        type: 'Current Balance',
        description: 'Cash on hand (available now)',
      });
    }

    // Cash flow chart
    const cashFlowChart = [];
    let cumulative = 0;
    for (const date of Object.keys(dailyFlows).sort()) {
      const df = dailyFlows[date];
      cumulative += df.deposits + df.allocations - df.withdrawals - df.fees;
      cashFlowChart.push({
        date: date.slice(5),
        deposits: round2(df.deposits), withdrawals: round2(df.withdrawals),
        allocations: round2(df.allocations), fees: round2(df.fees),
        cumulative: round2(cumulative),
      });
    }

    return {
      totalDeposits: round2(totalDeposits),
      externalDeposits: round2(externalDeposits),
      reinvestedReturns: round2(reinvestedReturns),
      feeRefunds: round2(feeRefunds),
      totalWithdrawals: round2(totalWithdrawals),
      totalInvestments: round2(totalInvestments),
      totalAllocations: round2(totalAllocations),
      merchantPayments: round2(merchantPayments),
      refiProceeds: round2(refiProceeds),
      totalCostSharing: round2(totalCostSharing),
      totalEarlyPayoff: round2(totalEarlyPayoff),
      netCollections: round2(totalAllocations - totalCostSharing),
      currentCashBalance: round2(currentBalance || 0),
      xirrFlows,
      cashFlowChart,
    };
  }

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
      m.numDeals++; m.invested += d.invested; m.totalCollected += d.collected;
      m.totalFees += d.feesPaid; m.netCollections += d.collected - d.feesPaid;
      m.netFunded += d.netFunded; m.rtr += d.rtr; m.totalCollectedBiz += d.totalCollectedBiz;
      const remaining = typeof d.dollarRemaining === 'number' ? d.dollarRemaining : 0;
      m.remainingRTR += remaining;
      if (d.status === 'Default') { m.defaults++; m.defaultedRTR += remaining; }
    }
    return Object.values(map).sort((a, b) => a.vintage.localeCompare(b.vintage)).map(v => {
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
        monthsActive: mo, avgMonthlyYield: mo > 0 ? round2(collPct / mo) : 0,
        netFunded: round2(v.netFunded), rtr: round2(v.rtr),
        totalCollectedBiz: round2(v.totalCollectedBiz),
        collectionPctNF: v.netFunded > 0 ? round2(v.totalCollectedBiz / v.netFunded) : 0,
        exposureBiz: round2(Math.max(0, v.netFunded - v.totalCollectedBiz)),
      };
    });
  }

  function computeSummary(perfs, vintages, ld, synInfo, aggregate) {
    const sum = (arr, fn) => arr.reduce((s, d) => s + fn(d), 0);
    const totalInvested = synInfo?.totalInvested || sum(perfs, d => d.invested);
    const totalCollected = sum(perfs, d => d.collected);
    const totalFees = sum(perfs, d => d.feesPaid);
    const grossPnL = sum(perfs, d => d.netReturn);
    const totalNetFunded = sum(perfs, d => d.netFunded);
    const totalRTR = sum(perfs, d => d.rtr);
    const totalCollectedBiz = sum(perfs, d => d.totalCollectedBiz);
    const unreturned = Math.max(0, totalInvested - totalCollected);
    const profit = perfs.filter(d => d.status === 'Profit').length;
    const active = perfs.filter(d => d.status === 'Active').length;
    const defaulted = perfs.filter(d => d.status === 'Default').length;
    const dates = perfs.map(d => d.fundedDate).filter(Boolean).sort();
    const l = ld || {};
    const agg = aggregate || {};

    const managementFees = Math.round(sum(perfs, d => d.feesPaid));
    const residualCommissions = Math.round(l.totalCostSharing || 0);
    const allFees = managementFees + residualCommissions;

    // Cash Available = External Deposits + Fee Refunds + Net Collections - Capital Deployed
    const cashAvailable = l.externalDeposits
      ? round2((l.externalDeposits || 0) + (l.feeRefunds || 0) + (l.totalAllocations || 0) - (l.totalCostSharing || 0) - (l.totalInvestments || 0))
      : 0;

    return {
      syndicatorName: synInfo?.name || 'All Syndicators',
      syndicatorId: synInfo?.id || '',
      period: { start: dates[0] ? new Date(dates[0]).toLocaleDateString() : 'N/A', end: new Date().toLocaleDateString() },
      durationDays: dates[0] ? Math.floor((new Date() - new Date(dates[0])) / 86400000) : 0,

      // Capital Activity — from subledger if available, otherwise from contacts aggregate
      totalDeposits: l.totalDeposits || agg.totalInvestedAll || 0,
      externalCapital: l.externalDeposits || agg.totalInvestedAll || 0,
      reinvestedReturns: l.reinvestedReturns || 0,
      totalWithdrawals: l.totalWithdrawals || agg.totalDistributedAll || 0,
      netCapitalDeployed: l.externalDeposits
        ? round2((l.externalDeposits || 0) - (l.totalWithdrawals || 0))
        : round2((agg.totalInvestedAll || 0) - (agg.totalDistributedAll || 0)),
      currentCashBalance: cashAvailable || round2((agg.totalRunningBalanceAll || 0) - (agg.totalInvestedAll || 0)),

      // Aggregate for Portfolio Overview (all syndicators combined)
      aggTotalInvested: agg.totalInvestedAll || 0,
      aggRunningBalance: agg.totalRunningBalanceAll || 0,
      aggSyndicatorCount: agg.syndicatorCount || 0,

      // Deal metrics
      totalInvested: Math.round(totalInvested), numDeals: perfs.length,
      avgDealSize: perfs.length > 0 ? Math.round(totalInvested / perfs.length) : 0,

      // Collections — from subledger allocations
      totalGrossCollections: Math.round(l.totalAllocations || totalCollected),
      collectionsPctInvested: totalInvested > 0 ? round2((l.totalAllocations || totalCollected) / totalInvested) : 0,
      totalMerchantPayments: Math.round(l.merchantPayments || totalCollected),
      refiProceeds: Math.round(l.refiProceeds || 0),
      balanceTransfersIn: 0, balanceTransfersOut: 0,

      // Fees — management (upfront from deals) + residual (per-txn from subledger)
      managementFees: managementFees,
      residualCommissions: residualCommissions,
      totalFees: allFees,
      feesPctInvested: totalInvested > 0 ? round2(allFees / totalInvested) : 0,
      feesPctCollections: (l.totalAllocations || totalCollected) > 0 ? round2(allFees / (l.totalAllocations || totalCollected)) : 0,

      // Net
      netCollections: Math.round((l.totalAllocations || totalCollected) - allFees),
      unreturned: Math.round(unreturned), grossPnL: Math.round(grossPnL),

      // Value
      totalCurrentValue: Math.round(cashAvailable + unreturned),
      netProfit: Math.round(cashAvailable + unreturned - (l.externalDeposits || totalInvested)),
      projectedXIRR: 0,
      cashOnCashMultiple: (l.externalDeposits || totalInvested) > 0
        ? round2((cashAvailable + unreturned + (l.totalWithdrawals || 0)) / (l.externalDeposits || totalInvested))
        : 0,

      // Deal counts
      dealsInProfit: profit, dealsActiveBelowBasis: active, dealsDefaulted: defaulted,
      winRate: perfs.length > 0 ? round2(profit / perfs.length) : 0,
      defaultRate: perfs.length > 0 ? round2(defaulted / perfs.length) : 0,

      // Realized/Unrealized
      realizedValue: 0, realizedPnL: 0, realizedROI: 0,
      unrealizedValue: Math.round(unreturned),
      pctStillOutstanding: totalInvested > 0 ? round2(unreturned / totalInvested) : 0,
      xirrFullRecovery: 0, xirrTotalLoss: 0,

      // Business-level
      totalNetFunded: Math.round(totalNetFunded), totalRTR: Math.round(totalRTR),
      totalCollectedBiz: Math.round(totalCollectedBiz),
      collectionPctNF: totalNetFunded > 0 ? round2(totalCollectedBiz / totalNetFunded) : 0,
      avgPaybackFactor: perfs.length > 0 ? round2(sum(perfs, d => d.paybackFactor) / perfs.length) : 0,
      totalExposure: Math.max(0, Math.round(totalNetFunded - totalCollectedBiz)),
      totalRemainingRTR: Math.round(totalRTR - totalCollectedBiz),
      dailyPctDeals: 0, weeklyPctDeals: 0, dailyAvgDays: 0, weeklyAvgWeeks: 0,
      moIRR_noDefault: 0, annIRR_noDefault: 0, moic_noDefault: 0,
      moIRR_adjusted: 0, annIRR_adjusted: 0, moic_adjusted: 0,
    };
  }

  try {
    const deals = await getAllDeals();
    const dealPerf = deals.map(mapDeal);

    // ALWAYS fetch contacts for aggregate Portfolio Overview data
    let allSyndicators = [];
    try {
      const contactsResp = await apiFetch('/contacts?limit=100');
      const contacts = Array.isArray(contactsResp.data) ? contactsResp.data
        : Array.isArray(contactsResp.data?.data) ? contactsResp.data.data : [];
      allSyndicators = contacts.filter(c => c.type === 'syndicator').map(c => ({
        id: c.id, name: c.name,
        totalInvested: c.details?.totalInvested || 0,
        runningBalance: c.details?.runningBalance || 0,
        totalDistributed: c.details?.totalDistributed || 0,
      }));
    } catch (e) { /* continue */ }

    // Aggregate across ALL syndicators for Portfolio Overview
    const aggregate = {
      totalInvestedAll: allSyndicators.reduce((s, c) => s + c.totalInvested, 0),
      totalRunningBalanceAll: allSyndicators.reduce((s, c) => s + c.runningBalance, 0),
      totalDistributedAll: allSyndicators.reduce((s, c) => s + c.totalDistributed, 0),
      syndicatorCount: allSyndicators.length,
    };

    // Fetch syndicator-specific data if syndicatorId provided
    let syndicatorInfo = null;
    let ledgerData = null;

    if (syndicatorId) {
      syndicatorInfo = allSyndicators.find(c => c.id === syndicatorId) || null;

      try {
        const sub = await apiFetch(`/accounting/reports/subledger/syndicator/${syndicatorId}?limit=10000`);
        const subEntries = sub.data?.entries || sub.data?.data || (Array.isArray(sub.data) ? sub.data : []);
        const subBalance = sub.data?.currentBalance || sub.currentBalance || 0;
        ledgerData = parseSubledger(subEntries, subBalance);
      } catch (e) { /* continue */ }
    }

    const vintagesSynd = computeVintages(dealPerf);
    const summary = computeSummary(dealPerf, vintagesSynd, ledgerData, syndicatorInfo, aggregate);

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
    const vintagesBiz = vintagesSynd.map(v => ({
      vintage: v.vintage, numDeals: v.numDeals, netFunded: Math.round(v.netFunded),
      rtr: Math.round(v.rtr), totalCollected: Math.round(v.totalCollectedBiz),
      collectionPctNF: v.collectionPctNF, exposure: Math.round(v.exposureBiz), defaultRate: v.defaultRate,
    }));

    res.status(200).json({
      dealPerf, vintagesSynd, curvesPct, curvesDollar, vintagesBiz,
      xirrFlows: ledgerData?.xirrFlows || [],
      cashFlowChart: ledgerData?.cashFlowChart || [],
      summary,
      aggregate,
      _meta: {
        fetchedAt: new Date().toISOString(), dealCount: deals.length,
        syndicatorId: syndicatorId || null, syndicatorName: syndicatorInfo?.name || null,
        hasSubledger: !!ledgerData, source: 'SmartMCA Nexus API (live)',
      },
    });
  } catch (error) {
    res.status(500).json({ error: 'Portfolio aggregation failed', details: error.message });
  }
}
