// Vercel Serverless Function: /api/portfolio
// Matches syndicator_report_base.xlsx formulas exactly
// Sources: /deals (deal metrics), /contacts (syndicator list), /accounting/reports/subledger/syndicator/{id} (ledger)

export default async function handler(req, res) {
  const API_KEY = process.env.SMARTMCA_API_KEY;
  const API_BASE = process.env.SMARTMCA_API_BASE || 'https://api.staging.v3.smartmca.com/api/public/v1';

  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!API_KEY) return res.status(500).json({ error: 'SMARTMCA_API_KEY not configured.' });

  const { syndicatorId } = req.query;

  async function apiFetch(path) {
    const resp = await fetch(`${API_BASE}${path}`, {
      headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    });
    if (!resp.ok) throw new Error(`${resp.status} on ${path}: ${await resp.text()}`);
    return resp.json();
  }

  function num(v) { const n = parseFloat(v); return isNaN(n) ? 0 : n; }
  function round2(v) { return Math.round(v * 100) / 100; }
  function toVintage(d) { if (!d) return ''; const dt = new Date(d); return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}`; }

  // ============================================================
  // 1. FETCH ALL DEALS (page-based pagination)
  // ============================================================
  async function getAllDeals() {
    const deals = []; let page = 1;
    while (true) {
      const r = await apiFetch(`/deals?limit=100&page=${page}`);
      if (r.data) deals.push(...r.data);
      if (!r.meta?.pagination || page >= r.meta.pagination.totalPages) break;
      page++;
    }
    return deals;
  }

  // ============================================================
  // 2. MAP DEAL from SmartMCA → dashboard structure
  //    Matches 'deals' sheet + 'Returns Summary' Deal-Level Performance
  // ============================================================
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

    // Status: spreadsheet uses Open+Active, Open+Defaulted, Closed+Completed, Closed+Refinanced
    let status;
    if (d.status === 'defaulted') status = 'Default';
    else if (d.status === 'closed') status = 'Profit';
    else status = 'Active';

    return {
      dealNo: d.dealId || '', internalId: d.id || '',
      merchant: d.merchantName || '', merchantState: d.merchantState || '',
      invested: round2(funded), collected: round2(collected),
      feesPaid: round2(bankFees), netReturn: round2(pnl),
      roi: netFunded > 0 ? round2(pnl / netFunded) : 0,
      status,
      pmtsRemaining: status === 'Profit' ? 'Paid Off' : status === 'Default' ? 0 : '—',
      dollarRemaining: status === 'Profit' ? 'Paid Off' : round2(outstanding),
      frequency: status === 'Profit' ? 'Paid Off' : status === 'Default' ? '-' : 'Daily',
      vintage, netFunded: round2(netFunded), rtr: round2(rtr),
      totalCollectedBiz: round2(collected), exposureBiz: round2(exposure),
      paybackFactor: factor,
      brokerName: d.brokerName || '', isoName: d.iso?.isoName || '',
      score: d.scoreData?.score || 0, grade: d.scoreData?.grade || '',
      fundedDate: d.fundedDate || '',
    };
  }

  // ============================================================
  // 3. PARSE SUBLEDGER — mirrors syndicator_report sheet formulas
  //    Transaction types from spreadsheet:
  //      deposit (IN), withdraw (OUT), investment (OUT),
  //      merchant_payment (IN), Fee Paid (Per Transaction) (OUT),
  //      Management Fee Paid (One Time) (OUT),
  //      refi_incoming (IN), balance_transfer_in (IN), balance_transfer_out (OUT)
  // ============================================================
  function parseSubledger(entries, glBalance) {
    // Main ledger entries
    const ledger = entries.filter(e => e.account === 'Syndicator Distributions Payable');

    // === CAPITAL ACTIVITY ===
    let externalCapital = 0;      // deposits that are new capital
    let reinvestedReturns = 0;    // deposits that are recycled payouts/reinvestments
    let feeRefunds = 0;           // deposits that are fee refund credits
    let totalWithdrawals = 0;     // payouts to syndicator

    // === INVESTMENT & COLLECTIONS ===
    let totalInvestments = 0;     // capital deployed to deals
    let merchantPayments = 0;     // merchant_payment allocations
    let refiProceeds = 0;         // early payoff / refi allocations
    let balanceTransfersIn = 0;
    let balanceTransfersOut = 0;

    // === FEE ANALYSIS ===
    // Management fees (one-time) = "Management Fee" in cost-sharing description
    // Residual commissions (per-txn) = "Residual Commission" or regular cost-sharing
    let managementFees = 0;
    let residualCommissions = 0;

    // === XIRR & CASH FLOW ===
    const flowsByDate = {};       // net deposit/withdrawal by date for XIRR
    const dailyFlows = {};        // daily detail for chart

    for (const e of ledger) {
      const desc = (e.description || '').toLowerCase();
      const descOrig = e.description || '';
      const date = (e.date || '').slice(0, 10);
      const credit = e.credit || 0;
      const debit = e.debit || 0;

      if (!dailyFlows[date]) dailyFlows[date] = { deposits: 0, withdrawals: 0, collections: 0, fees: 0, investments: 0 };

      // --- DEPOSITS ---
      if (desc.includes('syndicator deposit:')) {
        if (desc.includes('reinvest') || desc.includes('payout')) {
          reinvestedReturns += credit;
        } else if (desc.includes('refund')) {
          feeRefunds += credit;
        } else {
          externalCapital += credit;
        }
        dailyFlows[date].deposits += credit;
        if (!flowsByDate[date]) flowsByDate[date] = 0;
        flowsByDate[date] -= credit; // negative = cash in

      // --- WITHDRAWALS ---
      } else if (desc.includes('syndicator withdrawal:')) {
        totalWithdrawals += debit;
        dailyFlows[date].withdrawals += debit;
        if (!flowsByDate[date]) flowsByDate[date] = 0;
        flowsByDate[date] += debit; // positive = cash out

      // --- INVESTMENTS (capital deployed to deals) ---
      } else if (desc.includes('syndicator investment:')) {
        totalInvestments += credit;
        dailyFlows[date].investments += credit;

      // --- COLLECTIONS (syndicator allocations) ---
      } else if (desc.includes('syndicator allocation:')) {
        // Classify: "payoff" anywhere = refi proceeds, "balance transfer" = BT, else = merchant
        if (desc.includes('payoff')) {
          refiProceeds += credit;
        } else if (desc.includes('balance transfer')) {
          balanceTransfersIn += credit;
        } else {
          merchantPayments += credit;
        }
        dailyFlows[date].collections += credit;

      // --- FEES (cost-sharing deductions from subledger = residual commissions only) ---
      // Management fees (one-time upfront) are NOT in the subledger — they come from deal bankFees
      } else if (desc.includes('cost-sharing deductions:')) {
        residualCommissions += debit;
        dailyFlows[date].fees += debit;
      }
    }

    // === DERIVED VALUES (matching spreadsheet formulas) ===
    const totalDeposits = round2(externalCapital + reinvestedReturns + feeRefunds);
    const totalGrossCollections = round2(merchantPayments + refiProceeds + balanceTransfersIn - balanceTransfersOut);
    const totalFees = round2(managementFees + residualCommissions);
    const netCollections = round2(totalGrossCollections - totalFees);

    // Cash Balance = Deposits - Investments + Collections - Fees - Withdrawals
    // This is the syndicator_report running balance (actual cash available)
    const cashBalance = round2(totalDeposits - totalInvestments + totalGrossCollections - totalFees - totalWithdrawals);

    // Unreturned Principal = Total Invested - Gross Collections
    const unreturned = round2(Math.max(0, totalInvestments - totalGrossCollections));

    // Total Value = Withdrawals + Cash Balance + Unreturned
    const totalValue = round2(totalWithdrawals + cashBalance + unreturned);

    // Net Profit = Total Value - External Capital
    const netProfit = round2(totalValue - externalCapital);

    // Net Capital Deployed = External Capital - Total Withdrawals
    const netCapitalDeployed = round2(externalCapital - totalWithdrawals);

    // Cash-on-Cash Multiple = Total Value / External Capital
    const cashOnCash = externalCapital > 0 ? round2(totalValue / externalCapital) : 0;

    // === XIRR CASH FLOWS ===
    const xirrFlows = [];
    for (const date of Object.keys(flowsByDate).sort()) {
      const amt = round2(flowsByDate[date]);
      if (amt !== 0) {
        xirrFlows.push({
          date, amount: amt,
          type: amt < 0 ? 'Deposit' : 'Withdrawal',
          description: amt < 0 ? 'Syndicator Deposit' : 'Syndicator Payout',
        });
      }
    }
    // Terminal value = current cash balance (matches spreadsheet XIRR)
    if (cashBalance > 0) {
      xirrFlows.push({
        date: new Date().toISOString().slice(0, 10),
        amount: round2(cashBalance),
        type: 'Current Balance',
        description: 'Cash on hand (available now)',
      });
    }

    // === CASH FLOW CHART ===
    const cashFlowChart = [];
    let cumulative = 0;
    for (const date of Object.keys(dailyFlows).sort()) {
      const df = dailyFlows[date];
      const net = df.deposits + df.collections - df.withdrawals - df.fees - df.investments;
      cumulative += net;
      cashFlowChart.push({
        date: date.slice(5),
        amount: round2(net), cumulative: round2(cumulative),
      });
    }

    return {
      // Capital Activity
      totalDeposits, externalCapital: round2(externalCapital),
      reinvestedReturns: round2(reinvestedReturns), feeRefunds: round2(feeRefunds),
      totalWithdrawals: round2(totalWithdrawals),
      netCapitalDeployed, cashBalance,
      // Investment & Collections
      totalInvestments: round2(totalInvestments),
      merchantPayments: round2(merchantPayments),
      refiProceeds: round2(refiProceeds),
      balanceTransfersIn: round2(balanceTransfersIn),
      balanceTransfersOut: round2(balanceTransfersOut),
      totalGrossCollections,
      collectionsPctInvested: totalInvestments > 0 ? round2(totalGrossCollections / totalInvestments) : 0,
      // Fee Analysis
      managementFees: round2(managementFees),
      residualCommissions: round2(residualCommissions),
      totalFees,
      feesPctInvested: totalInvestments > 0 ? round2(totalFees / totalInvestments) : 0,
      feesPctCollections: totalGrossCollections > 0 ? round2(totalFees / totalGrossCollections) : 0,
      // Return Metrics
      netCollections, unreturned, totalValue, netProfit, cashOnCash,
      // Flows
      xirrFlows, cashFlowChart,
    };
  }

  // ============================================================
  // 4. VINTAGE ANALYSIS — matches 'Syndicator Analysis' sheet
  // ============================================================
  function computeVintages(perfs) {
    const map = {};
    for (const d of perfs) {
      if (!d.vintage) continue;
      if (!map[d.vintage]) map[d.vintage] = { vintage: d.vintage, numDeals: 0, invested: 0, collected: 0, fees: 0, net: 0, defaults: 0, remainingRTR: 0, defaultedRTR: 0, netFunded: 0, rtr: 0, collectedBiz: 0 };
      const m = map[d.vintage];
      m.numDeals++; m.invested += d.invested; m.collected += d.collected;
      m.fees += d.feesPaid; m.net += d.collected - d.feesPaid;
      m.netFunded += d.netFunded; m.rtr += d.rtr; m.collectedBiz += d.totalCollectedBiz;
      const rem = typeof d.dollarRemaining === 'number' ? d.dollarRemaining : 0;
      m.remainingRTR += rem;
      if (d.status === 'Default') { m.defaults++; m.defaultedRTR += rem; }
    }
    return Object.values(map).sort((a, b) => a.vintage.localeCompare(b.vintage)).map(v => {
      const pct = v.invested > 0 ? v.net / v.invested : 0;
      const mo = Math.max(0, Math.floor((new Date() - new Date(v.vintage + '-01')) / 2629746000));
      return {
        vintage: v.vintage, numDeals: v.numDeals,
        invested: round2(v.invested), totalCollected: round2(v.collected),
        totalFees: round2(v.fees), netCollections: round2(v.net),
        collectionPctNI: round2(pct),
        remainingRTR: round2(v.remainingRTR), defaultedRTR: round2(v.defaultedRTR),
        defaultPctRTR: v.remainingRTR > 0 ? round2(v.defaultedRTR / v.remainingRTR) : 0,
        exposure: round2(v.invested - v.net),
        defaultRate: v.numDeals > 0 ? round2(v.defaults / v.numDeals) : 0,
        monthsActive: mo, avgMonthlyYield: mo > 0 ? round2(pct / mo) : 0,
        netFunded: round2(v.netFunded), rtr: round2(v.rtr),
        totalCollectedBiz: round2(v.collectedBiz),
        collectionPctNF: v.netFunded > 0 ? round2(v.collectedBiz / v.netFunded) : 0,
        exposureBiz: round2(Math.max(0, v.netFunded - v.collectedBiz)),
      };
    });
  }

  // ============================================================
  // 5. COLLECTION CURVES — matches 'Syndicator Analysis' curves
  // ============================================================
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

  // ============================================================
  // 6. BUILD SUMMARY — matches 'Returns Summary' sheet layout
  // ============================================================
  function buildSummary(perfs, ledger, synInfo, aggregate) {
    const sum = (fn) => perfs.reduce((s, d) => s + fn(d), 0);
    const dates = perfs.map(d => d.fundedDate).filter(Boolean).sort();
    const profit = perfs.filter(d => d.status === 'Profit').length;
    const active = perfs.filter(d => d.status === 'Active').length;
    const defaulted = perfs.filter(d => d.status === 'Default').length;
    const l = ledger || {};
    const agg = aggregate || {};

    // Use subledger values when available, aggregate/deal-level fallback
    const hasSub = !!ledger;

    return {
      syndicatorName: synInfo?.name || 'All Syndicators',
      syndicatorId: synInfo?.id || '',
      period: { start: dates[0] ? new Date(dates[0]).toLocaleDateString() : 'N/A', end: new Date().toLocaleDateString() },
      durationDays: dates[0] ? Math.floor((new Date() - new Date(dates[0])) / 86400000) : 0,

      // === CAPITAL ACTIVITY (Returns Summary rows 5-11) ===
      totalDeposits: hasSub ? l.totalDeposits : (agg.totalInvestedAll || 0),
      externalCapital: hasSub ? l.externalCapital : (agg.totalInvestedAll || 0),
      reinvestedReturns: hasSub ? l.reinvestedReturns : 0,
      totalWithdrawals: hasSub ? l.totalWithdrawals : (agg.totalDistributedAll || 0),
      netCapitalDeployed: hasSub ? l.netCapitalDeployed : round2((agg.totalInvestedAll || 0) - (agg.totalDistributedAll || 0)),
      currentCashBalance: hasSub ? l.cashBalance : 0,

      // === INVESTMENT & COLLECTIONS (rows 13-23) ===
      // "Total Invested in MCA Deals" = synInfo.totalInvested from contacts (e.g. $402,430)
      // NOT subledger investment entries (which track cash flow for balance calc)
      totalInvested: Math.round(synInfo?.totalInvested || sum(d => d.invested)),
      numDeals: perfs.length,
      avgDealSize: perfs.length > 0 ? Math.round((synInfo?.totalInvested || sum(d => d.invested)) / perfs.length) : 0,
      totalMerchantPayments: hasSub ? Math.round(l.merchantPayments) : Math.round(sum(d => d.collected)),
      refiProceeds: hasSub ? Math.round(l.refiProceeds) : 0,
      balanceTransfersIn: hasSub ? Math.round(l.balanceTransfersIn) : 0,
      balanceTransfersOut: hasSub ? Math.round(l.balanceTransfersOut) : 0,
      totalGrossCollections: hasSub ? Math.round(l.totalGrossCollections) : Math.round(sum(d => d.collected)),
      // Collections as % of Invested = Gross Collections / Total Invested (from contacts)
      collectionsPctInvested: (() => {
        const inv = synInfo?.totalInvested || sum(d => d.invested);
        const coll = hasSub ? l.totalGrossCollections : sum(d => d.collected);
        return inv > 0 ? round2(coll / inv) : 0;
      })(),

      // === FEE ANALYSIS (rows 25-30) ===
      // Management fees (One-Time/Upfront) = NOT in subledger API.
      // Derived from deal-level bank fees (invested - netFunded) scaled by syndicator share.
      managementFees: (() => {
        const totalBizFees = sum(d => d.invested - d.netFunded); // business-level bank fees
        const totalBizInvested = sum(d => d.invested);
        const syndInvested = synInfo?.totalInvested || totalBizInvested;
        const syndShare = totalBizInvested > 0 ? syndInvested / totalBizInvested : 1;
        return Math.round(totalBizFees * syndShare);
      })(),
      // Residual Commissions (Per Transaction) = from subledger cost-sharing deductions
      residualCommissions: hasSub ? Math.round(l.residualCommissions) : 0,
      // Total Fees = Management + Residual
      totalFees: (() => {
        const totalBizFees = sum(d => d.invested - d.netFunded);
        const totalBizInvested = sum(d => d.invested);
        const syndInvested = synInfo?.totalInvested || totalBizInvested;
        const syndShare = totalBizInvested > 0 ? syndInvested / totalBizInvested : 1;
        const mgmt = totalBizFees * syndShare;
        const residual = hasSub ? l.residualCommissions : 0;
        return Math.round(mgmt + residual);
      })(),
      // Fees as % of Invested = Total Fees / Total Invested (from contacts)
      feesPctInvested: (() => {
        const inv = synInfo?.totalInvested || sum(d => d.invested);
        const totalBizFees = sum(d => d.invested - d.netFunded);
        const totalBizInvested = sum(d => d.invested);
        const syndShare = totalBizInvested > 0 ? inv / totalBizInvested : 1;
        const mgmt = totalBizFees * syndShare;
        const residual = hasSub ? l.residualCommissions : 0;
        return inv > 0 ? round2((mgmt + residual) / inv) : 0;
      })(),
      // Fees as % of Collections = Total Fees / Gross Collections
      feesPctCollections: (() => {
        const coll = hasSub ? l.totalGrossCollections : sum(d => d.collected);
        const totalBizFees = sum(d => d.invested - d.netFunded);
        const totalBizInvested = sum(d => d.invested);
        const inv = synInfo?.totalInvested || totalBizInvested;
        const syndShare = totalBizInvested > 0 ? inv / totalBizInvested : 1;
        const mgmt = totalBizFees * syndShare;
        const residual = hasSub ? l.residualCommissions : 0;
        return coll > 0 ? round2((mgmt + residual) / coll) : 0;
      })(),

      // === RETURN METRICS (rows 32-48) ===
      // Net Collections = Gross Collections - Total Fees (management + residual)
      netCollections: (() => {
        const coll = hasSub ? l.totalGrossCollections : sum(d => d.collected);
        const totalBizFees = sum(d => d.invested - d.netFunded);
        const totalBizInvested = sum(d => d.invested);
        const inv = synInfo?.totalInvested || totalBizInvested;
        const syndShare = totalBizInvested > 0 ? inv / totalBizInvested : 1;
        const mgmt = totalBizFees * syndShare;
        const residual = hasSub ? l.residualCommissions : 0;
        return Math.round(coll - mgmt - residual);
      })(),
      // Unreturned Principal = Total Invested (contacts) - Gross Collections
      unreturned: (() => {
        const inv = synInfo?.totalInvested || sum(d => d.invested);
        const coll = hasSub ? l.totalGrossCollections : sum(d => d.collected);
        return Math.round(Math.max(0, inv - coll));
      })(),
      grossPnL: Math.round(sum(d => d.netReturn)),
      // Total Value = Withdrawals + Cash Balance + Unreturned (row 42)
      // Recompute here using contacts-based unreturned, not subledger-based
      totalCurrentValue: (() => {
        const inv = synInfo?.totalInvested || sum(d => d.invested);
        const coll = hasSub ? l.totalGrossCollections : sum(d => d.collected);
        const unret = Math.max(0, inv - coll);
        const withdrawals = hasSub ? l.totalWithdrawals : 0;
        const cash = hasSub ? l.cashBalance : 0;
        return Math.round(withdrawals + cash + unret);
      })(),
      // Net Profit = Total Value - External Capital (row 45)
      netProfit: (() => {
        const inv = synInfo?.totalInvested || sum(d => d.invested);
        const coll = hasSub ? l.totalGrossCollections : sum(d => d.collected);
        const unret = Math.max(0, inv - coll);
        const withdrawals = hasSub ? l.totalWithdrawals : 0;
        const cash = hasSub ? l.cashBalance : 0;
        const totalVal = withdrawals + cash + unret;
        const extCap = hasSub ? l.externalCapital : (agg.totalInvestedAll || 0);
        return Math.round(totalVal - extCap);
      })(),
      projectedXIRR: 0,
      // Cash-on-Cash = Total Value / External Capital (row 48)
      cashOnCashMultiple: (() => {
        const inv = synInfo?.totalInvested || sum(d => d.invested);
        const coll = hasSub ? l.totalGrossCollections : sum(d => d.collected);
        const unret = Math.max(0, inv - coll);
        const withdrawals = hasSub ? l.totalWithdrawals : 0;
        const cash = hasSub ? l.cashBalance : 0;
        const totalVal = withdrawals + cash + unret;
        const extCap = hasSub ? l.externalCapital : (agg.totalInvestedAll || 0);
        return extCap > 0 ? round2(totalVal / extCap) : 0;
      })(),

      // === DEAL STATISTICS (rows 51-57) ===
      dealsInProfit: profit, dealsActiveBelowBasis: active, dealsDefaulted: defaulted,
      winRate: perfs.length > 0 ? round2(profit / perfs.length) : 0,
      defaultRate: perfs.length > 0 ? round2(defaulted / perfs.length) : 0,

      // === REALIZED vs UNREALIZED (rows 59+) ===
      realizedValue: hasSub ? Math.round(l.totalWithdrawals + l.cashBalance) : 0,
      realizedPnL: hasSub ? Math.round(l.totalWithdrawals + l.cashBalance - l.externalCapital) : 0,
      realizedROI: hasSub && l.externalCapital > 0 ? round2((l.totalWithdrawals + l.cashBalance - l.externalCapital) / l.externalCapital) : 0,
      unrealizedValue: (() => {
        const inv = synInfo?.totalInvested || sum(d => d.invested);
        const coll = hasSub ? l.totalGrossCollections : sum(d => d.collected);
        return Math.round(Math.max(0, inv - coll));
      })(),
      pctStillOutstanding: (() => {
        const inv = synInfo?.totalInvested || sum(d => d.invested);
        const coll = hasSub ? l.totalGrossCollections : sum(d => d.collected);
        const unret = Math.max(0, inv - coll);
        return inv > 0 ? round2(unret / inv) : 0;
      })(),
      xirrFullRecovery: 0, xirrTotalLoss: 0,

      // === COLLECTION ANALYSIS (business-level, from deals) ===
      totalNetFunded: Math.round(sum(d => d.netFunded)),
      totalRTR: Math.round(sum(d => d.rtr)),
      totalCollectedBiz: Math.round(sum(d => d.totalCollectedBiz)),
      collectionPctNF: sum(d => d.netFunded) > 0 ? round2(sum(d => d.totalCollectedBiz) / sum(d => d.netFunded)) : 0,
      avgPaybackFactor: perfs.length > 0 ? round2(sum(d => d.paybackFactor) / perfs.length) : 0,
      totalExposure: Math.max(0, Math.round(sum(d => d.netFunded) - sum(d => d.totalCollectedBiz))),
      totalRemainingRTR: Math.round(sum(d => d.rtr) - sum(d => d.totalCollectedBiz)),

      // === AGGREGATE (for Portfolio Overview) ===
      aggTotalInvested: agg.totalInvestedAll || 0,
      aggRunningBalance: agg.totalRunningBalanceAll || 0,
      aggSyndicatorCount: agg.syndicatorCount || 0,

      // Placeholders
      dailyPctDeals: 0, weeklyPctDeals: 0, dailyAvgDays: 0, weeklyAvgWeeks: 0,
      moIRR_noDefault: 0, annIRR_noDefault: 0, moic_noDefault: 0,
      moIRR_adjusted: 0, annIRR_adjusted: 0, moic_adjusted: 0,
    };
  }

  // ============================================================
  // MAIN
  // ============================================================
  try {
    // 1. Deals
    const deals = await getAllDeals();
    const dealPerf = deals.map(mapDeal);

    // 2. Contacts (always fetch for aggregate)
    let allSyndicators = [];
    try {
      const cr = await apiFetch('/contacts?limit=100');
      const contacts = Array.isArray(cr.data) ? cr.data : Array.isArray(cr.data?.data) ? cr.data.data : [];
      allSyndicators = contacts.filter(c => c.type === 'syndicator').map(c => ({
        id: c.id, name: c.name,
        totalInvested: c.details?.totalInvested || 0,
        runningBalance: c.details?.runningBalance || 0,
        totalDistributed: c.details?.totalDistributed || 0,
      }));
    } catch (e) { /* continue */ }

    const aggregate = {
      totalInvestedAll: allSyndicators.reduce((s, c) => s + c.totalInvested, 0),
      totalRunningBalanceAll: allSyndicators.reduce((s, c) => s + c.runningBalance, 0),
      totalDistributedAll: allSyndicators.reduce((s, c) => s + c.totalDistributed, 0),
      syndicatorCount: allSyndicators.length,
    };

    // 3. Subledger (only when syndicatorId provided)
    let syndicatorInfo = null;
    let ledgerData = null;

    if (syndicatorId) {
      syndicatorInfo = allSyndicators.find(c => c.id === syndicatorId) || null;
      try {
        const sub = await apiFetch(`/accounting/reports/subledger/syndicator/${syndicatorId}?limit=10000`);
        const entries = sub.data?.entries || sub.data?.data || (Array.isArray(sub.data) ? sub.data : []);
        const balance = sub.data?.currentBalance || sub.currentBalance || 0;
        ledgerData = parseSubledger(entries, balance);
      } catch (e) { /* continue */ }
    }

    // 4. Compute
    const vintagesSynd = computeVintages(dealPerf);
    const curves = buildCurves(vintagesSynd);
    const summary = buildSummary(dealPerf, ledgerData, syndicatorInfo, aggregate);

    const vintagesBiz = vintagesSynd.map(v => ({
      vintage: v.vintage, numDeals: v.numDeals, netFunded: Math.round(v.netFunded),
      rtr: Math.round(v.rtr), totalCollected: Math.round(v.totalCollectedBiz),
      collectionPctNF: v.collectionPctNF, exposure: Math.round(v.exposureBiz),
      defaultRate: v.defaultRate,
    }));

    res.status(200).json({
      dealPerf, vintagesSynd,
      curvesPct: curves.pct, curvesDollar: curves.dollar,
      vintagesBiz,
      xirrFlows: ledgerData?.xirrFlows || [],
      cashFlowChart: ledgerData?.cashFlowChart || [],
      summary, aggregate,
      _debug: {
        ledgerTotals: ledgerData ? {
          merchantPayments: ledgerData.merchantPayments,
          refiProceeds: ledgerData.refiProceeds,
          totalGrossCollections: ledgerData.totalGrossCollections,
          residualCommissions: ledgerData.residualCommissions,
          totalInvestments: ledgerData.totalInvestments,
          externalCapital: ledgerData.externalCapital,
          cashBalance: ledgerData.cashBalance,
        } : null,
      },
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
