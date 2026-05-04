// parseStatement.js
//
// Pure parser for the SmartMCA syndicator statement endpoint.
// Endpoint: GET /api/public/v1/syndicators/{id}/statement?format=json&limit=10000
//
// Replaces /accounting/reports/subledger/syndicator/{id} (deposits/withdrawals/
// investments aggregates) AND the per-deal /deals/{id}/payments fetches
// (per-deal collection breakdown) with a single canonical source.
//
// Entry types observed in LMJS staging data (Apr 2026 snapshot, n=1814):
//   paymentShareAllocated  834  — Merchant collection share (deal-attributed)
//   syndicationFee         872  — Per-payment fees (residual OR management)
//   feeDeduction            35  — One-time upfront fees at investment time
//   investment              37  — New investment in a deal
//   deposit                 20  — External capital OR reinvestment
//   withdrawal              11  — Payouts
//   reversal                 5  — Corrections (e.g. fee reversed for balance transfer)
//
// Description-based sub-classification (these are stable per SmartMCA's docs):
//   syndicationFee + "Residual Commission..."  → residual commission
//   syndicationFee + "MANAGEMENT FEE..."       → management fee
//   deposit + description contains "reinvest"  → reinvestment (not external capital)
//   deposit + anything else                    → external capital
//
// Sign conventions in the API:
//   creditAmount > 0 = money in (cash IN to syndicator's available pool)
//   debitAmount  > 0 = money out (cash OUT of syndicator's available pool)
//
// Canonical balance identity (verified on LMJS):
//   availableCash = totalDeposited - totalWithdrawn - totalInvestedLedger
//                 - commissionsObligated + cashCollectedGross - managementFees
//
// Where SmartMCA's `managementFees` field is ALL-IN fees (upfront + residual +
// per-payment management). We split them client-side via description matching
// so the dashboard can show them separately.

// ---- Helpers ----

function n(v) {
  // Some fields come back as strings ("100000"), others as numbers (100000).
  // Coerce safely; non-numeric → 0.
  const x = typeof v === 'string' ? parseFloat(v) : v;
  return Number.isFinite(x) ? x : 0;
}

function r2(v) {
  return Math.round(v * 100) / 100;
}

// Description matchers. The API's descriptions are stable strings prefixed
// by category; we match case-insensitively for safety.
//
// Reinvestment classification: a deposit-type entry counts as reinvestment if
// its description mentions "reinvest" (catches "reinvestment", "Re-investment"
// with a hyphen, "syndicator reinvestment", etc.) OR mentions "payout" (some
// SmartMCA descriptions read like "2025 Syndicator Payout + Re-investment"
// or paired payout/redeposit conventions). Matches the legacy parseSubledger
// behavior so external/reinvestment splits agree across both code paths.
const RX = {
  // Catches: reinvest, reinvestment, Re-investment (with hyphen). Allows an
  // optional non-letter character between "re" and "invest".
  reinvestment:        /re[-\s]?invest/i,
  payout:              /payout/i,
  // Fee refunds — credit-side entries that reverse a previously-paid upfront
  // fee. NOT external capital and NOT reinvestment.
  feeRefund:           /refund/i,
  residualCommission:  /^Residual Commission/i,
  managementFeePayment:/^MANAGEMENT FEE/i,
  balanceTransferIn:   /balance_transfer_in/i,
  balanceTransferOut:  /balance_transfer_out/i,
  refiIncoming:        /refi_incoming/i,
};

// Classify a single statement entry into one of our internal categories.
// Returns { category, signedAmount, dealId, date } or null if the entry is
// some unrecognised future type (we'd rather skip than misclassify).
function classifyEntry(entry) {
  const credit = n(entry.creditAmount);
  const debit  = n(entry.debitAmount);
  const amt    = credit - debit;            // signed: + = in, - = out
  const dealId = entry.dealId || null;
  const date   = entry.entryDate;
  const type   = entry.entryType;
  const desc   = entry.description || '';

  switch (type) {
    case 'deposit':
      // Distinguish three sub-categories of deposit credits:
      //   1. Fee refund — refund of a previously-charged upfront fee. NOT
      //      capital; tracked separately so display totals don't double-count.
      //   2. Reinvestment — payout that's immediately re-deposited. Doesn't
      //      represent new outside capital; doesn't create an XIRR flow.
      //   3. External deposit — actual new capital from the syndicator's
      //      pocket. Counts as both totalDeposited AND a NEGATIVE XIRR flow.
      //
      // Order matters: a description like "Upfront Fee REFUND" might happen to
      // also contain other words; match REFUND first since it's the most
      // specific. Then reinvest/payout, then everything else is external.
      if (RX.feeRefund.test(desc)) {
        return { category: 'feeRefund', signedAmount: amt, dealId, date, type, desc };
      }
      if (RX.reinvestment.test(desc) || RX.payout.test(desc)) {
        return { category: 'reinvestment', signedAmount: amt, dealId, date, type, desc };
      }
      return { category: 'externalDeposit', signedAmount: amt, dealId, date, type, desc };

    case 'withdrawal':
      return { category: 'withdrawal', signedAmount: amt, dealId, date, type, desc };

    case 'investment':
      // Money OUT of cash pool, INTO a specific deal. dealId always present.
      return { category: 'investment', signedAmount: amt, dealId, date, type, desc };

    case 'paymentShareAllocated':
      // The syndicator's share of a merchant payment for a specific deal.
      // Almost always credit (+amount), but occasionally negative for
      // balance_transfer_out adjustments.
      return { category: 'collection', signedAmount: amt, dealId, date, type, desc };

    case 'syndicationFee':
      // Per-payment fees. Always debits (negative signedAmount).
      // Distinguish residual commission vs management fee by description.
      if (RX.managementFeePayment.test(desc)) {
        return { category: 'managementFee', signedAmount: amt, dealId, date, type, desc };
      }
      // Default to residual commission for any other syndicationFee variant
      // (covers "Residual Commission: percentage fee (5%)" and the bare
      // "Residual Commission" we saw on the balance_transfer_in entry).
      return { category: 'residualCommission', signedAmount: amt, dealId, date, type, desc };

    case 'feeDeduction':
      // One-time upfront fee at investment time. dealId present.
      return { category: 'upfrontFee', signedAmount: amt, dealId, date, type, desc };

    case 'reversal':
      // Corrections — e.g. a residual commission reversed when a deal does a
      // balance transfer instead of getting a real merchant payment. Treat as
      // its own category so we can subtract it from gross fees if we want
      // an "effective fees paid" view.
      return { category: 'reversal', signedAmount: amt, dealId, date, type, desc };

    default:
      // Unknown type — log via the return value, don't crash.
      return { category: 'unknown', signedAmount: amt, dealId, date, type, desc };
  }
}

// ---- Main parser ----

/**
 * Parse a SmartMCA statement response into structured aggregates.
 *
 * @param {object} statementResponse - The raw response from the statement
 *   endpoint, shape: { data: { entries: [...], summary: {...} } }
 * @returns {object} structured parse result, see fields below.
 */
export function parseStatement(statementResponse) {
  // Tolerate a few response shapes — the API has used both wrapped and bare
  // versions in different probes during development. Always end up with a
  // flat entries array and a (possibly null) summary block.
  const root = statementResponse?.data ?? statementResponse ?? {};
  const entries = Array.isArray(root.entries)
    ? root.entries
    : Array.isArray(root.data?.entries)
      ? root.data.entries
      : Array.isArray(root)
        ? root
        : [];
  const summary = root.summary || root.data?.summary || null;

  // Aggregate accumulators — one running total per category.
  let externalCapital   = 0;   // sum of positive "deposit" entries (excl. reinvest, refund)
  let reinvestments     = 0;   // sum of positive "deposit" entries marked reinvest/payout
  let feeRefunds        = 0;   // sum of positive "deposit" entries marked refund
  let totalDeposited    = 0;   // externalCapital + reinvestments + feeRefunds (matches API)
  let totalWithdrawn    = 0;   // sum of withdrawal debits (positive number)
  let totalInvested     = 0;   // sum of investment debits (positive number)
  let cashCollectedNet  = 0;   // signed sum of paymentShareAllocated (handles bt_out)
  let cashCollectedCr   = 0;   // gross (credits only) — for matching SmartMCA's
                               //   `cashCollectedGross` field exactly
  let upfrontFees       = 0;   // sum of feeDeduction debits (positive number)
  let residualComms     = 0;   // residual commission debits (positive number)
  let managementFees    = 0;   // management fee debits (positive number)
  let reversalsCredit   = 0;   // reversal credits (positive)
  let reversalsDebit    = 0;   // reversal debits (positive — rare)
  let unknownCount      = 0;   // entries we couldn't classify

  // Per-deal breakdowns for the perf table. Maps dealId → number/object.
  const collectionsByDeal = new Map(); // dealId → net collections (signed sum)
  const collectionsByDealGross = new Map(); // dealId → gross collections (credit only)
  const feesByDeal = new Map();        // dealId → { residual, management, upfront }
  const investmentsByDeal = new Map(); // dealId → total invested
  const investmentsByDate = new Map(); // dateStr → total invested on that date

  // Cash-flow series for XIRR. Each entry: { date, amount, category, dealId }.
  // Sign convention: NEGATIVE = cash out from syndicator's perspective
  // (deposits = -, fees = -, investments = -). POSITIVE = cash in (collections,
  // withdrawals to user).
  //
  // Wait — that's backwards from how XIRR usually models it. From the
  // syndicator's perspective:
  //   - Putting money in (deposit / reinvestment / fee) = NEGATIVE flow
  //   - Getting money back (collection / withdrawal) = POSITIVE flow
  //
  // But XIRR typically wants: deposits (capital out from investor's pocket)
  // are NEGATIVE; returns to investor are POSITIVE. Same convention. Good.
  //
  // We do NOT include "investment in a deal" as a flow because that's an
  // internal reallocation (cash → deal exposure); the deal's collections
  // are the real return.
  const cashFlowsForXIRR = [];

  for (const e of entries) {
    const c = classifyEntry(e);
    if (!c) continue;
    const amt = c.signedAmount; // signed: + in, - out
    const abs = Math.abs(amt);

    switch (c.category) {
      case 'externalDeposit':
        externalCapital += amt;       // amt > 0
        totalDeposited  += amt;
        cashFlowsForXIRR.push({ date: c.date, amount: -amt, category: c.category, dealId: c.dealId });
        break;
      case 'reinvestment':
        reinvestments  += amt;        // amt > 0
        totalDeposited += amt;
        // Reinvestments are NOT XIRR flows — they're internal money cycling
        // back in (was already counted as a positive collection earlier).
        // Skipping here matches the existing XIRR engine's logic.
        break;
      case 'feeRefund':
        feeRefunds     += amt;        // amt > 0
        totalDeposited += amt;        // still counts toward total deposits (API treats it that way)
        // Fee refunds are NOT XIRR flows — they're a reversal of a previously
        // paid fee. The original fee was a negative flow; the refund netting
        // it out doesn't represent a return on capital.
        break;
      case 'withdrawal':
        totalWithdrawn += abs;        // amt < 0, store as positive total
        cashFlowsForXIRR.push({ date: c.date, amount: abs, category: c.category, dealId: null });
        break;
      case 'investment': {
        totalInvested += abs;         // amt < 0
        const cur = investmentsByDeal.get(c.dealId) || 0;
        investmentsByDeal.set(c.dealId, cur + abs);
        // Track per-date for the cash-flow chart adapter.
        const dKey = (c.date || '').slice(0, 10);
        if (dKey) {
          investmentsByDate.set(dKey, (investmentsByDate.get(dKey) || 0) + abs);
        }
        // Not a true XIRR flow — see comment above. Investment is balance
        // sheet reallocation. The matching collections will be the inflows.
        break;
      }
      case 'collection': {
        cashCollectedNet += amt;      // signed; balance_transfer_out is negative
        if (amt > 0) cashCollectedCr += amt;
        if (c.dealId) {
          collectionsByDeal.set(c.dealId, (collectionsByDeal.get(c.dealId) || 0) + amt);
          if (amt > 0) {
            collectionsByDealGross.set(c.dealId, (collectionsByDealGross.get(c.dealId) || 0) + amt);
          }
        }
        // Per-deal collection IS an XIRR inflow (gross, before fees).
        // Fees on this collection are their own flow events.
        if (amt > 0) {
          cashFlowsForXIRR.push({ date: c.date, amount: amt, category: c.category, dealId: c.dealId });
        }
        break;
      }
      case 'residualCommission':
        residualComms += abs;
        if (c.dealId) {
          const f = feesByDeal.get(c.dealId) || { residual: 0, management: 0, upfront: 0 };
          f.residual += abs;
          feesByDeal.set(c.dealId, f);
        }
        cashFlowsForXIRR.push({ date: c.date, amount: -abs, category: c.category, dealId: c.dealId });
        break;
      case 'managementFee':
        managementFees += abs;
        if (c.dealId) {
          const f = feesByDeal.get(c.dealId) || { residual: 0, management: 0, upfront: 0 };
          f.management += abs;
          feesByDeal.set(c.dealId, f);
        }
        cashFlowsForXIRR.push({ date: c.date, amount: -abs, category: c.category, dealId: c.dealId });
        break;
      case 'upfrontFee':
        upfrontFees += abs;
        if (c.dealId) {
          const f = feesByDeal.get(c.dealId) || { residual: 0, management: 0, upfront: 0 };
          f.upfront += abs;
          feesByDeal.set(c.dealId, f);
        }
        cashFlowsForXIRR.push({ date: c.date, amount: -abs, category: c.category, dealId: c.dealId });
        break;
      case 'reversal':
        if (amt > 0) reversalsCredit += amt; else reversalsDebit += abs;
        // Reversals happen when SmartMCA backs out a previously-charged fee
        // (e.g. balance transfer treats fee differently). We DON'T add them
        // to fee totals here — instead exposed as separate field so caller
        // can decide how to net.
        cashFlowsForXIRR.push({ date: c.date, amount: amt, category: c.category, dealId: c.dealId });
        break;
      case 'unknown':
      default:
        unknownCount++;
        break;
    }
  }

  // Compose totals to match SmartMCA's canonical fields exactly.
  const totalFeesPaid = r2(upfrontFees + residualComms + managementFees);
  // IMPORTANT: SmartMCA's `cashCollectedGross` field is NET of balance-transfer-out
  // adjustments — i.e., credits MINUS debits on paymentShareAllocated entries.
  // The name is misleading; verified empirically against LMJS:
  //   credits:  $296,862.41
  //   debits:   $  1,837.46  (balance_transfer_out reductions)
  //   "gross":  $295,024.95  (net of debits)
  // We expose both the API-compatible value (cashCollectedGross) AND the
  // pure credit-side sum (cashCollectedCreditsOnly) for callers that want
  // it. The canonical balance identity uses `cashCollectedGross`.
  const cashCollectedGross = r2(cashCollectedNet);
  const cashCollectedCreditsOnly = r2(cashCollectedCr);
  // Reversals: SmartMCA reduces the fee total by the reversal credits
  // (a reversal credit indicates a previously-charged fee was refunded).
  // For "managementFees as it appears in summary":
  //   managementFees(summary) = totalFeesPaid - reversalsCredit
  // We expose both net and gross so callers can pick the right one.
  const totalFeesNetOfReversals = r2(totalFeesPaid - reversalsCredit);

  // Compute closing balance from the components, using the SmartMCA identity:
  //   availableCash = totalDeposited - totalWithdrawn - totalInvestedLedger
  //                 - commissionsObligated + cashCollectedGross - managementFees
  // We have:
  //   totalDeposited      = externalCapital + reinvestments
  //   totalInvestedLedger = totalInvested
  //   managementFees(here) = totalFeesNetOfReversals (matches summary)
  //   commissionsObligated = 0 (always 0 in observed data)
  // Reproducing the formula:
  const computedAvailableCash = r2(
    totalDeposited
    - totalWithdrawn
    - totalInvested
    + cashCollectedGross
    - totalFeesNetOfReversals
  );

  // The summary block, when present, is authoritative. Use it for display
  // and the computed value as a self-check (regression detection).
  const apiClosingBalance = summary ? n(summary.closingBalance) : null;
  const reconciliationDelta = apiClosingBalance != null
    ? r2(apiClosingBalance - computedAvailableCash)
    : null;

  return {
    // ---- Canonical totals ----
    closingBalance: apiClosingBalance != null ? r2(apiClosingBalance) : computedAvailableCash,
    computedAvailableCash,
    apiClosingBalance,
    reconciliationDelta,           // should be ~0; alarm if drifts
    transactionCount: entries.length,

    // ---- Capital flow aggregates ----
    externalCapital:    r2(externalCapital),
    reinvestments:      r2(reinvestments),
    feeRefunds:         r2(feeRefunds),
    totalDeposited:     r2(totalDeposited),
    totalWithdrawn:     r2(totalWithdrawn),
    totalInvestedLedger:r2(totalInvested),

    // ---- Collections ----
    cashCollectedGross,                       // matches SmartMCA's field (NET of bt_out)
    cashCollectedNet:   r2(cashCollectedNet), // same value; alias for clarity
    cashCollectedCreditsOnly,                 // pure credit side, ignoring bt_out

    // ---- Fees (split out) ----
    upfrontFees:        r2(upfrontFees),
    residualCommissions:r2(residualComms),
    managementFees:     r2(managementFees),
    totalFeesPaid,                            // gross, before reversals
    totalFeesNetOfReversals,                  // matches /summary's managementFees field

    // ---- Reversals ----
    reversalsCredit:    r2(reversalsCredit),
    reversalsDebit:     r2(reversalsDebit),

    // ---- Per-deal breakdowns ----
    collectionsByDeal,           // Map<dealId, signed net collections>
    collectionsByDealGross,      // Map<dealId, gross collections>
    feesByDeal,                  // Map<dealId, {residual, management, upfront}>
    investmentsByDeal,           // Map<dealId, total invested>
    investmentsByDate,           // Map<dateStr, total invested on date>  [adapter use]

    // ---- Cash-flow series for XIRR ----
    // Sign: negative = capital out (deposits, fees), positive = returns in
    // (collections, withdrawals). Sorted by date ascending.
    cashFlowsForXIRR: cashFlowsForXIRR.sort((a, b) => {
      const ad = new Date(a.date).getTime();
      const bd = new Date(b.date).getTime();
      return ad - bd;
    }),

    // ---- Diagnostic ----
    unknownEntryCount: unknownCount,
  };
}

// ---- Convenience: validate result against SmartMCA's summary block ----
// Returns { ok, deltas } describing any mismatches with the summary fields.
// Useful as a regression check during deployment.
export function reconcileWithSummary(parsed, summaryBlock) {
  if (!summaryBlock) return { ok: false, reason: 'no_summary_block', deltas: {} };
  const deltas = {
    closingBalance:    r2(n(summaryBlock.closingBalance) - parsed.closingBalance),
    transactionCount:  (summaryBlock.transactionCount || 0) - parsed.transactionCount,
    totalCredits:      r2(n(summaryBlock.totalCredits) - (parsed.totalDeposited + parsed.cashCollectedCreditsOnly + parsed.reversalsCredit)),
  };
  // Allow a small floating-point tolerance.
  const ok = Object.values(deltas).every(d => Math.abs(d) < 0.01);
  return { ok, deltas };
}

// ---- Adapter: produce the legacy parseSubledger shape from parsed statement ----
//
// During Phase 2 Step 3 we drop the /accounting/reports/subledger fetch and
// derive its outputs from the statement parser. Downstream code (combineFinancials,
// buildFlows, buildSummary, _debug.subledger) consumes the legacy shape, so this
// adapter keeps that contract while changing the source.
//
// Field-by-field mapping:
//   externalCapital, reinvestedReturns, feeRefunds, totalDeposits → directly from parsed
//   totalWithdrawals, totalInvestmentsLedger                       → directly from parsed
//   mgmtFeesLedger, residualCommissionsLedger                      → see note below
//   externalDeposits[], withdrawalEntries[], feeEntries[]          → derived from cashFlowsForXIRR
//   flowsByDate, dailyFlows                                        → aggregated from cashFlowsForXIRR
//   earliestDepositDate                                            → min(date) over external deposits
//   entryCount, totalEntryCount                                    → parsed.transactionCount
//
// On the fee fields: legacy parseSubledger combined ALL per-payment fees into
// `residualCommissionsLedger` (with an explicit "misnomer" comment). For Step 3
// we preserve that behavior — keep the combined value in `residualCommissionsLedger`
// for downstream compat. Step 5 (UI fee breakdown) will plumb the proper split.
export function statementToSubledgerShape(parsed) {
  if (!parsed) {
    return {
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

  // Per-entry arrays for buildFlows.
  // Pull dates from the cashFlowsForXIRR series — it already has them
  // categorised and sorted. We just need to filter by category.
  const externalDeposits  = [];
  const withdrawalEntries = [];
  const feeEntries        = [];

  // flowsByDate: cleaner XIRR-style aggregation (negative = cash in, positive = out).
  // Legacy semantics from parseSubledger:
  //   deposits:   flowsByDate[d] -= credit  (negative)
  //   withdrawals:flowsByDate[d] += debit   (positive)
  // Investments are NOT in flowsByDate (they're balance-sheet only, not cash flows).
  // We replicate this exactly.
  const flowsByDate = {};
  // dailyFlows: cash-flow chart format. Three counters per date.
  const dailyFlows  = {};

  let earliestDepositDate = null;

  // Walk the cashFlowsForXIRR series. Each entry has {date, amount, category, dealId}.
  // amount sign: negative = capital out (deposit/fee from syndicator), positive = in.
  // We need to map back to the legacy (positive) totals + sign-conventional flows.
  for (const f of parsed.cashFlowsForXIRR) {
    const d = (f.date || '').slice(0, 10);
    const absAmt = Math.abs(f.amount);

    if (!dailyFlows[d]) dailyFlows[d] = { deposits: 0, withdrawals: 0, investments: 0 };

    switch (f.category) {
      case 'externalDeposit':
        // f.amount is NEGATIVE (cash from syndicator's pocket → out)
        externalDeposits.push({ date: d, amount: r2(absAmt) });
        if (!earliestDepositDate || d < earliestDepositDate) earliestDepositDate = d;
        flowsByDate[d] = (flowsByDate[d] || 0) - absAmt;  // negative = in
        dailyFlows[d].deposits += absAmt;
        break;

      case 'withdrawal':
        // f.amount is POSITIVE (cash returned to syndicator)
        withdrawalEntries.push({ date: d, amount: r2(absAmt) });
        flowsByDate[d] = (flowsByDate[d] || 0) + absAmt;  // positive = out (back to user)
        dailyFlows[d].withdrawals += absAmt;
        break;

      case 'residualCommission':
      case 'managementFee':
      case 'upfrontFee':
        // Fees: per-entry detail for XIRR. Type label matches legacy convention.
        feeEntries.push({
          date: d,
          amount: r2(absAmt),
          type: f.category === 'upfrontFee' ? 'Management Fee Paid (One Time)' : 'Per-Transaction Fee',
        });
        // Fees do NOT go into flowsByDate (legacy didn't include them) but
        // they DO go into the XIRR engine via the dedicated feeEntries array.
        break;

      // collection, reversal, reinvestment categories also appear in
      // cashFlowsForXIRR — they shouldn't affect the legacy shape's daily
      // aggregates. (Reinvestments are excluded by parseStatement; collections
      // & reversals are handled by other code paths.)
      default:
        break;
    }
  }

  // Investments aren't in cashFlowsForXIRR (they're not cash flows).
  // The legacy parser populated dailyFlows[d].investments for the cash-flow
  // chart, so we replicate that from investmentsByDate. Per-date detail is
  // accurate (parsed entry-by-entry).
  if (parsed.investmentsByDate && typeof parsed.investmentsByDate.forEach === 'function') {
    parsed.investmentsByDate.forEach((amt, d) => {
      if (!dailyFlows[d]) dailyFlows[d] = { deposits: 0, withdrawals: 0, investments: 0 };
      dailyFlows[d].investments += amt;
    });
  }

  return {
    externalCapital:        parsed.externalCapital,
    reinvestedReturns:      parsed.reinvestments,
    feeRefunds:             parsed.feeRefunds,
    totalDeposits:          parsed.totalDeposited,
    totalWithdrawals:       parsed.totalWithdrawn,
    totalInvestmentsLedger: parsed.totalInvestedLedger,
    // Fee fields — preserve legacy combined-residual semantics for Step 3 compat.
    // The "residualCommissionsLedger" name is a known misnomer: it's the SUM of
    // ALL per-payment fees (residual commissions + per-payment management fees).
    // Step 5 will replace this with a proper split when the UI is updated.
    mgmtFeesLedger:            r2(parsed.upfrontFees),
    residualCommissionsLedger: r2(parsed.residualCommissions + parsed.managementFees),
    mgmtFeeCount:              0, // we don't track counts in parseStatement; leave 0 (cosmetic only)
    residualCount:             0,
    hasLedgerFees:             (parsed.totalFeesPaid || 0) > 0,
    earliestDepositDate,
    flowsByDate,
    dailyFlows,
    externalDeposits,
    withdrawalEntries,
    feeEntries,
    entryCount:               parsed.transactionCount,
    totalEntryCount:          parsed.transactionCount,
  };
}
