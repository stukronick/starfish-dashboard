import { useState, useMemo, useCallback } from "react";
import { BarChart, Bar, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, Legend, AreaChart, Area } from "recharts";
import { usePortfolio } from "./hooks/usePortfolio.js";
import { LOGO } from "./logo.js";


const fmt = (v, type = "currency") => {
  if (v == null || v === "Paid Off" || v === "-") return v || "—";
  if (type === "currency") return v < 0 ? `($${Math.abs(v).toLocaleString("en-US", {minimumFractionDigits: 0, maximumFractionDigits: 0})})` : `$${v.toLocaleString("en-US", {minimumFractionDigits: 0, maximumFractionDigits: 0})}`;
  if (type === "currency2") return v < 0 ? `($${Math.abs(v).toLocaleString("en-US", {minimumFractionDigits: 2, maximumFractionDigits: 2})})` : `$${v.toLocaleString("en-US", {minimumFractionDigits: 2, maximumFractionDigits: 2})}`;
  if (type === "pct") return `${(v * 100).toFixed(1)}%`;
  if (type === "pct0") return `${(v * 100).toFixed(0)}%`;
  if (type === "multiple") return `${v.toFixed(2)}x`;
  if (type === "xirr") return `${(v * 100).toFixed(1)}%`;
  return v;
};

const clr = (v) => v > 0 ? "#166534" : v < 0 ? "#CC0000" : "#084372";

// Syndicators loaded from API

// --- Components ---
const KpiCard = ({ label, value, sub, accent }) => (
  <div style={{ background: "#ffffff", border: "1px solid #DFF0FF", borderRadius: 12, padding: "20px 24px", minWidth: 0, boxShadow: "0 1px 4px rgba(8,67,114,0.06)" }}>
    <div style={{ fontSize: 12, color: "#8892a4", fontWeight: 500, letterSpacing: 0.5, textTransform: "uppercase", marginBottom: 8 }}>{label}</div>
    <div style={{ fontSize: 26, fontWeight: 700, color: accent || "#052B4C", fontFamily: "'Inria Sans', sans-serif" }}>{value}</div>
    {sub && <div style={{ fontSize: 12, color: "#5a7a9a", marginTop: 4 }}>{sub}</div>}
  </div>
);

const Section = ({ title, children, dark }) => (
  <div style={{ marginBottom: 32 }}>
    <div style={{ fontSize: 13, fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", color: "#084372", marginBottom: 16, paddingBottom: 8, borderBottom: "2px solid #0596F2" }}>{title}</div>
    {children}
  </div>
);

const StatusBadge = ({ status, netReturn }) => {
  const c = status === "Profit" ? { bg: "#dcfce7", fg: "#166534", border: "#86efac" }
    : status === "Default" ? { bg: "#fee2e2", fg: "#991b1b", border: "#fca5a5" }
    : { bg: "#FFF7ED", fg: netReturn >= 0 ? "#166534" : "#CC0000", border: "#FFB772" };
  return <span style={{ display: "inline-block", fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 20, background: c.bg, color: c.fg, border: `1px solid ${c.border}` }}>{status}</span>;
};

const COLORS_PIE = ["#FD8E3A", "#166534", "#CC0000"];

// --- Pages ---
function OverviewPage({ DATA }) {
  const s = DATA.summary;
  const [dealSort, setDealSort] = useState("status");
  const [dealFilter, setDealFilter] = useState("All");

  const statusData = [
    { name: "Active", value: s.dealsActiveBelowBasis },
    { name: "Profit", value: s.dealsInProfit },
    { name: "Default", value: s.dealsDefaulted },
  ];

  const vintageChart = DATA.vintagesSynd.map(v => ({
    vintage: v.vintage,
    invested: v.invested,
    netCollections: v.netCollections,
    exposure: Math.max(v.exposure, 0),
  }));

  const filteredDeals = DATA.dealPerf
    .filter(d => dealFilter === "All" || d.status === dealFilter)
    .sort((a, b) => {
      if (dealSort === "status") {
        const o = { "Active": 0, "Profit": 1, "Default": 2 };
        return (o[a.status] || 0) - (o[b.status] || 0);
      }
      if (dealSort === "invested") return b.invested - a.invested;
      if (dealSort === "roi") return (b.roi || 0) - (a.roi || 0);
      return 0;
    });

  const cashFlowChart = DATA.xirrFlows.map(f => ({
    date: f.date.slice(5),
    amount: f.amount,
    cumulative: 0,
    type: f.type,
  }));
  let cum = 0;
  cashFlowChart.forEach(c => { cum += c.amount; c.cumulative = cum; });

  return (
    <div>
      {/* Hero KPIs */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 16, marginBottom: 32 }}>
        <KpiCard label="Total Invested" value={fmt(s.totalInvested)} sub={`${s.numDeals} deals · avg ${fmt(s.avgDealSize)}`} />
        <KpiCard label="Net Profit (Total Value)" value={fmt(s.netProfit)} accent={clr(s.netProfit)} sub={`Cash-on-Cash ${fmt(s.cashOnCashMultiple, "multiple")}`} />
        <KpiCard label="Projected XIRR" value={fmt(s.projectedXIRR, "xirr")} accent="#FD8E3A" />      </div>

      {/* Portfolio Summary */}
      <div style={{ background: "#ffffff", borderRadius: 12, padding: 24, border: "1px solid #DFF0FF", boxShadow: "0 1px 4px rgba(8,67,114,0.06)", marginBottom: 32 }}>
        <Section title="Portfolio Summary">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 0 }}>
            {[
              ["Total Deals", s.numDeals, false],
              ["Total Net Funded", s.totalNetFunded, true],
              ["Total RTR (Purchased)", s.totalRTR, true],
              ["Total Collected", s.totalCollectedBiz, true],
              ["Collection % of Net Funded", s.collectionPctNF, "pct"],
              ["Avg Payback Factor", s.avgPaybackFactor, "factor"],
              ["Total Exposure (Net Funded - Collections)", s.totalExposure, true],
              ["Total Remaining RTR Balance", s.totalRemainingRTR, true],
            ].map(([label, value, isCurrency]) => (
              <div key={label} style={{ display: "flex", justifyContent: "space-between", padding: "8px 14px", borderBottom: "1px solid #EFF8FF", fontSize: 14 }}>
                <span style={{ color: "#5a7a9a" }}>{label}</span>
                <span style={{ fontWeight: 600, color: "#052B4C", fontFamily: "'Inria Sans', sans-serif" }}>
                  {isCurrency === "pct" ? fmt(value, "pct") : isCurrency === "factor" ? `${value}x` : isCurrency ? fmt(value) : value}
                </span>
              </div>
            ))}
          </div>
        </Section>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24, marginBottom: 32 }}>
        {/* Capital Activity */}
        <div style={{ background: "#ffffff", borderRadius: 12, padding: 24, border: "1px solid #DFF0FF", boxShadow: "0 1px 4px rgba(8,67,114,0.06)" }}>
          <Section title="Capital Activity">
            <div style={{ display: "grid", gap: 10, fontSize: 14 }}>
              {[
                ["External Capital Contributed", s.externalCapital],
                ["Reinvested Returns", s.reinvestedReturns],
                ["Total Deposits", s.totalDeposits],
                ["Total Invested in Deals", s.totalInvested],
                ["Total Withdrawals (Payouts)", s.totalWithdrawals != null ? -s.totalWithdrawals : null],
                ["Net Capital Deployed", s.netCapitalDeployed],
              ].map(([l, v]) => (
                <div key={l} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #DFF0FF" }}>
                  <span style={{ color: "#084372" }}>{l}</span>
                  <span style={{ fontWeight: 600, color: clr(v), fontFamily: "'Inria Sans', sans-serif" }}>{fmt(v)}</span>
                </div>
              ))}
            </div>
          </Section>
        </div>

        {/* Fee Analysis + Return Metrics */}
        <div style={{ background: "#ffffff", borderRadius: 12, padding: 24, border: "1px solid #DFF0FF", boxShadow: "0 1px 4px rgba(8,67,114,0.06)" }}>
          <Section title="Return Metrics">
            <div style={{ display: "grid", gap: 10, fontSize: 14 }}>
              {[
                ["Total Gross Collections", s.totalGrossCollections],
                ["Total Fees Paid", s.totalFees != null ? -s.totalFees : null],
                ["Net Collections", s.netCollections],
                ["Unreturned Principal", s.unreturned],
                ["Realized P&L (Cash Only)", s.realizedPnL],
              ].map(([l, v]) => (
                <div key={l} style={{ display: "flex", justifyContent: "space-between", padding: "6px 0", borderBottom: "1px solid #DFF0FF" }}>
                  <span style={{ color: "#084372" }}>{l}</span>
                  <span style={{ fontWeight: 600, color: clr(v), fontFamily: "'Inria Sans', sans-serif" }}>{fmt(v)}</span>
                </div>
              ))}
            </div>
          </Section>
        </div>
      </div>

      {/* Charts Row */}
      <div style={{ display: "grid", gridTemplateColumns: "300px 1fr", gap: 24, marginBottom: 32 }}>
        {/* Deal Status Pie */}
        <div style={{ background: "#ffffff", borderRadius: 12, padding: 24, border: "1px solid #DFF0FF", boxShadow: "0 1px 4px rgba(8,67,114,0.06)" }}>
          <Section title="Deal Status Breakdown">
            <ResponsiveContainer width="100%" height={220}>
              <PieChart>
                <Pie data={statusData} cx="50%" cy="50%" innerRadius={55} outerRadius={85} dataKey="value" stroke="none">
                  {statusData.map((_, i) => <Cell key={i} fill={COLORS_PIE[i]} />)}
                </Pie>
                <Tooltip contentStyle={{ background: "#084372", border: "none", borderRadius: 8, color: "#052B4C", fontSize: 13 }} />
                <Legend formatter={(v) => <span style={{ color: "#084372", fontSize: 12 }}>{v}</span>} />
              </PieChart>
            </ResponsiveContainer>
            <div style={{ display: "flex", justifyContent: "space-around", marginTop: 8, fontSize: 12, color: "#5a7a9a" }}>
              <span>Win Rate: <b style={{ color: "#166534" }}>{fmt(s.winRate, "pct")}</b></span>
              <span>Default: <b style={{ color: "#ef4444" }}>{fmt(s.defaultRate, "pct")}</b></span>
            </div>
          </Section>
        </div>

        {/* Vintage Performance Bar */}
        <div style={{ background: "#ffffff", borderRadius: 12, padding: 24, border: "1px solid #DFF0FF", boxShadow: "0 1px 4px rgba(8,67,114,0.06)" }}>
          <Section title="Syndicator Performance by Vintage">
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={vintageChart} barGap={2}>
                <CartesianGrid strokeDasharray="3 3" stroke="#EFF8FF" />
                <XAxis dataKey="vintage" tick={{ fill: "#5a7a9a", fontSize: 11 }} />
                <YAxis tick={{ fill: "#5a7a9a", fontSize: 11 }} tickFormatter={v => `$${(v/1000).toFixed(0)}k`} />
                <Tooltip contentStyle={{ background: "#084372", border: "none", borderRadius: 8, color: "#052B4C", fontSize: 12 }} formatter={(v) => fmt(v)} />
                <Bar dataKey="invested" fill="#0596F2" radius={[4,4,0,0]} name="Invested" />
                <Bar dataKey="netCollections" fill="#166534" radius={[4,4,0,0]} name="Net Collections" />
                <Legend formatter={(v) => <span style={{ color: "#084372", fontSize: 11 }}>{v}</span>} />
              </BarChart>
            </ResponsiveContainer>
          </Section>
        </div>
      </div>

      {/* Cash Flow Timeline */}
      <div style={{ background: "#ffffff", borderRadius: 12, padding: 24, border: "1px solid #DFF0FF", boxShadow: "0 1px 4px rgba(8,67,114,0.06)", marginBottom: 32 }}>
        <Section title="Capital Flow Timeline (Cumulative)">
          <ResponsiveContainer width="100%" height={220}>
            <AreaChart data={cashFlowChart}>
              <CartesianGrid strokeDasharray="3 3" stroke="#EFF8FF" />
              <XAxis dataKey="date" tick={{ fill: "#5a7a9a", fontSize: 10 }} />
              <YAxis tick={{ fill: "#5a7a9a", fontSize: 11 }} tickFormatter={v => `$${(v/1000).toFixed(0)}k`} />
              <Tooltip contentStyle={{ background: "#084372", border: "none", borderRadius: 8, color: "#052B4C", fontSize: 12 }} formatter={(v) => fmt(v)} />
              <Area type="monotone" dataKey="cumulative" stroke="#FD8E3A" fill="rgba(5,150,242,0.08)" strokeWidth={2} name="Cumulative" />
            </AreaChart>
          </ResponsiveContainer>
        </Section>
      </div>

      {/* Deal Table */}
      <div style={{ background: "#ffffff", borderRadius: 12, padding: 24, border: "1px solid #DFF0FF", boxShadow: "0 1px 4px rgba(8,67,114,0.06)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
          <Section title="Deal-Level Performance" />
          <div style={{ display: "flex", gap: 8 }}>
            {["All", "Active", "Profit", "Default"].map(f => (
              <button key={f} onClick={() => setDealFilter(f)} style={{ fontSize: 11, padding: "5px 12px", borderRadius: 20, border: dealFilter === f ? "1px solid #0596F2" : "1px solid #B7E2FF", background: dealFilter === f ? "#DFF0FF" : "transparent", color: dealFilter === f ? "#0077CF" : "#5a7a9a", cursor: "pointer", fontWeight: 600 }}>{f}</button>
            ))}
          </div>
        </div>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ borderBottom: "2px solid #B7E2FF" }}>
                {["Deal No.", "Merchant", "Status", "Invested", "Collected", "Fees", "Net Return", "ROI", "Freq", "Pmts Left", "$ Remaining"].map(h => (
                  <th key={h} style={{ textAlign: h === "Merchant" ? "left" : "right", padding: "10px 12px", color: "#5a7a9a", fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5, whiteSpace: "nowrap" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filteredDeals.map(d => (
                <tr key={d.dealNo} style={{ borderBottom: "1px solid #DFF0FF" }}>
                  <td style={{ padding: "10px 12px", color: "#084372", fontFamily: "monospace", fontSize: 12, textAlign: "right" }}>{d.dealNo}</td>
                  <td style={{ padding: "10px 12px", color: "#052B4C", maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.merchant}</td>
                  <td style={{ padding: "10px 12px", textAlign: "right" }}><StatusBadge status={d.status} netReturn={d.netReturn} /></td>
                  <td style={{ padding: "10px 12px", textAlign: "right", color: "#052B4C", fontFamily: "'Inria Sans', sans-serif" }}>{fmt(d.invested)}</td>
                  <td style={{ padding: "10px 12px", textAlign: "right", color: "#084372", fontFamily: "'Inria Sans', sans-serif" }}>{fmt(d.collected)}</td>
                  <td style={{ padding: "10px 12px", textAlign: "right", color: "#CC0000", fontFamily: "'Inria Sans', sans-serif" }}>{fmt(d.feesPaid)}</td>
                  <td style={{ padding: "10px 12px", textAlign: "right", color: clr(d.netReturn), fontWeight: 600, fontFamily: "'Inria Sans', sans-serif" }}>{fmt(d.netReturn)}</td>
                  <td style={{ padding: "10px 12px", textAlign: "right", color: clr(d.roi), fontWeight: 600 }}>{fmt(d.roi, "pct")}</td>
                  <td style={{ padding: "10px 12px", textAlign: "right", color: "#5a7a9a", fontSize: 11 }}>{d.frequency}</td>
                  <td style={{ padding: "10px 12px", textAlign: "right", color: "#084372" }}>{d.pmtsRemaining}</td>
                  <td style={{ padding: "10px 12px", textAlign: "right", color: "#084372", fontFamily: "'Inria Sans', sans-serif" }}>{typeof d.dollarRemaining === "number" ? fmt(d.dollarRemaining) : d.dollarRemaining}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function SyndicatorPage({ DATA }) {
  const s = DATA.summary;
  const [dealFilter, setDealFilter] = useState("All");
  const filteredDeals = DATA.dealPerf
    .filter(d => dealFilter === "All" || d.status === dealFilter)
    .sort((a, b) => { const o = { "Active": 0, "Profit": 1, "Default": 2 }; return (o[a.status]||0) - (o[b.status]||0); });

  const hdr = { background: "#084372", color: "#fff", fontWeight: 700, fontSize: 13, padding: "10px 14px", letterSpacing: 0.5 };
  const subHdr = { background: "#DFF0FF", color: "#084372", fontWeight: 700, fontSize: 12, padding: "7px 14px" };
  const lbl = { color: "#5a7a9a", fontSize: 13, padding: "6px 14px", borderBottom: "1px solid #EFF8FF", width: "60%" };
  const val = { color: "#052B4C", fontSize: 13, padding: "6px 14px", borderBottom: "1px solid #EFF8FF", textAlign: "right", fontFamily: "'Inria Sans'", fontWeight: 500 };
  const valB = { color: "#052B4C", fontSize: 13, padding: "6px 14px", borderBottom: "1px solid #EFF8FF", textAlign: "right", fontFamily: "'Inria Sans'", fontWeight: 700 };
  const neg = { color: "#CC0000", fontSize: 13, padding: "6px 14px", borderBottom: "1px solid #EFF8FF", textAlign: "right", fontFamily: "'Inria Sans'", fontWeight: 500 };
  const grn = { color: "#166534", fontSize: 13, padding: "6px 14px", borderBottom: "1px solid #EFF8FF", textAlign: "right", fontFamily: "'Inria Sans'", fontWeight: 700 };
  const tbl = { width: "100%", borderCollapse: "collapse", border: "1px solid #B7E2FF" };
  const st = (overrides) => Object.assign({}, val, overrides);

  const cashFlowChart = DATA.xirrFlows.map(f => ({ date: f.date.slice(5), amount: f.amount, cumulative: 0 }));
  let cum = 0;
  cashFlowChart.forEach(c => { cum += c.amount; c.cumulative = cum; });

  // Download the exact xirrFlows used to derive Projected XIRR as a CSV.
  // Open in Excel and run =XIRR(amount_column, date_column) to verify.
  function downloadXirrFlowsCsv() {
    const flows = DATA.xirrFlows || [];
    if (flows.length === 0) {
      alert("No XIRR flows available to download.");
      return;
    }
    const header = "date,amount,type,description,deal";
    const rows = flows.map(f => {
      // Escape commas/quotes in description and type
      const esc = (v) => {
        const s = String(v == null ? "" : v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      return [esc(f.date), f.amount, esc(f.type || ""), esc(f.description || ""), esc(f.dealNo || "")].join(",");
    });
    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const synd = (s.syndicatorName || "syndicator").replace(/[^A-Za-z0-9_-]/g, "_");
    const today = new Date().toISOString().slice(0, 10);
    a.download = `xirr_flows_${synd}_${today}.csv`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  const vintageColors = ["#0077CF", "#f97316", "#eab308", "#166534", "#78CBFF", "#0596F2", "#FFB772"];

  // Curve data: horizon is dynamic, read from API. New shape: each row keyed
  // by string month numbers ("0", "1", ... "N"). Old shape: month0, month1...
  // Support both for backward compatibility during deploy.
  const monthsHorizon = DATA.curvesMonthsHorizon ?? 5;
  const monthArray = Array.from({ length: monthsHorizon + 1 }, (_, i) => i);
  const readMonth = (row, m) => {
    // Try new key shape first ("0", "1"...), fall back to old ("month0"...)
    return row[String(m)] ?? row[`month${m}`] ?? null;
  };

  const curvesData = useMemo(() => {
    return monthArray.map(m => {
      const row = { month: "Mo " + m };
      DATA.curvesPct.forEach(c => {
        const v = readMonth(c, m);
        if (v != null) row[c.vintage] = v;
      });
      return row;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [DATA.curvesPct, monthsHorizon]);

  return (
    <div style={{ maxWidth: 1000, margin: "0 auto" }}>

      {/* ===== TITLE ===== */}
      <table style={tbl}>
        <tbody>
          <tr><td colSpan={4} style={{ ...hdr, fontSize: 16, letterSpacing: 1 }}>MCA SYNDICATOR RETURNS SUMMARY</td></tr>
          <tr>
            <td style={lbl}>Period</td><td style={val}>{s.period.start}</td><td style={val}>{s.period.end}</td><td style={val}></td>
          </tr>
          <tr>
            <td style={lbl}>Duration (days)</td><td style={valB}>{s.durationDays}</td><td style={val}></td><td style={val}></td>
          </tr>
        </tbody>
      </table>
      <div style={{ height: 20 }} />

      {/* ===== CAPITAL ACTIVITY + INVESTMENT SIDE BY SIDE ===== */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 20 }}>
        <table style={tbl}>
          <tbody>
            <tr><td colSpan={2} style={hdr}>CAPITAL ACTIVITY</td></tr>
            <tr><td style={lbl}>Total Initial Invested</td><td style={valB}>{fmt(s.externalCapital)}</td></tr>
            <tr><td style={lbl}>Total Reinvested Returns</td><td style={val}>{fmt(s.reinvestedReturns)}</td></tr>
            <tr><td style={lbl}>Available Cash</td><td style={grn}>{fmt(s.currentCashBalance)}</td></tr>
            <tr><td style={lbl}>Net External Capital Returned (Round-Trip)</td><td style={val}>{fmt(s.totalWithdrawals)}</td></tr>
          </tbody>
        </table>

        <table style={tbl}>
          <tbody>
            <tr><td colSpan={2} style={hdr}>INVESTMENT & COLLECTIONS</td></tr>
            <tr><td style={lbl}>Total Invested in MCA Deals</td><td style={valB}>{fmt(s.totalInvested)}</td></tr>
            <tr><td style={lbl}>Number of Deals</td><td style={val}>{s.numDeals}</td></tr>
            <tr><td style={lbl}>Average Deal Size</td><td style={val}>{fmt(s.avgDealSize)}</td></tr>
            <tr><td style={lbl}>Total Merchant Payments Received</td><td style={val}>{fmt(s.totalMerchantPayments)}</td></tr>
            <tr>
              <td style={lbl}>
                Total Gross Collections
                <span style={{ fontSize: 11, color: "#666", fontWeight: "normal", marginLeft: 6 }}>
                  (inclusive of Balance Transfers and Refinance Proceeds)
                </span>
              </td>
              <td style={valB}>{fmt(s.totalGrossCollections)}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* ===== FEE ANALYSIS + RETURN METRICS ===== */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 20 }}>
        <table style={tbl}>
          <tbody>
            <tr><td colSpan={2} style={hdr}>FEE ANALYSIS</td></tr>
            <tr>
              <td style={lbl}>
                Total Fees Paid
                <span style={{ fontSize: 11, color: "#666", fontWeight: "normal", marginLeft: 6 }}>
                  (combined upfront + per-payment; detailed split coming in Phase 2)
                </span>
              </td>
              <td style={{ ...valB, color: "#CC0000" }}>{fmt(s.totalFees)}</td>
            </tr>
            <tr><td style={lbl}>Fees as % of Invested</td><td style={val}>{fmt(s.feesPctInvested, "pct")}</td></tr>
            <tr><td style={lbl}>Fees as % of Collections</td><td style={val}>{fmt(s.feesPctCollections, "pct")}</td></tr>
          </tbody>
        </table>

        <table style={tbl}>
          <tbody>
            <tr><td colSpan={2} style={hdr}>RETURN METRICS</td></tr>
            <tr><td style={lbl}>Net Collections After Fees</td><td style={valB}>{fmt(s.netCollections)}</td></tr>
            <tr><td style={lbl}>Net Collections as % of Initial Invested</td><td style={val}>{fmt(s.netCollectionsPctExternal, "pct")}</td></tr>
            <tr><td style={lbl}>Unreturned Principal (Still in Deals)</td><td style={val}>{fmt(s.unreturned)}</td></tr>
            <tr><td style={lbl}>Gross P&L (Collections − Capital − Fees)</td><td style={neg}>{fmt(s.grossPnL)}</td></tr>
          </tbody>
        </table>
      </div>

      {/* ===== TOTAL VALUE CREATED ===== */}
      <table style={{ ...tbl, marginBottom: 20 }}>
        <tbody>
          <tr><td colSpan={2} style={hdr}>TOTAL VALUE CREATED</td></tr>
          <tr><td style={{ ...lbl, paddingLeft: 28 }}>Cash Received (Payouts)</td><td style={val}>{fmt(s.totalWithdrawals)} <span style={{ color: "#5a7a9a", fontSize: 11 }}>= Withdrawals</span></td></tr>
          <tr><td style={{ ...lbl, paddingLeft: 28 }}>+ Current Balance</td><td style={val}>{fmt(s.currentCashBalance)} <span style={{ color: "#5a7a9a", fontSize: 11 }}>= Available Cash</span></td></tr>
          <tr><td style={{ ...lbl, paddingLeft: 28 }}>+ Outstanding Principal in Deals</td><td style={val}>{fmt(s.unrealizedValue)} <span style={{ color: "#5a7a9a", fontSize: 11 }}>= Invested − Collected</span></td></tr>
          <tr><td style={{ ...lbl, fontWeight: 700, color: "#084372" }}>= Total Current Value</td><td style={valB}>{fmt(s.totalCurrentValue)}</td></tr>
          <tr><td style={{ ...lbl, paddingLeft: 28 }}>− External Capital Contributed</td><td style={neg}>{fmt(-s.externalCapital)}</td></tr>
          <tr><td style={{ background: "#052B4C", color: "#fff", fontWeight: 700, fontSize: 14, padding: "12px 14px" }}>NET PROFIT / (LOSS)</td>
              <td style={{ background: "#052B4C", color: "#78CBFF", fontWeight: 700, fontSize: 16, padding: "12px 14px", textAlign: "right", fontFamily: "'Inria Sans'" }}>{fmt(s.netProfit)}</td></tr>
          <tr>
            <td style={lbl}>
              Projected XIRR (Annualized IRR)
              <button
                onClick={downloadXirrFlowsCsv}
                style={{
                  marginLeft: 10, padding: "2px 8px", fontSize: 11,
                  background: "#fff", border: "1px solid #B7E2FF",
                  borderRadius: 3, color: "#084372", cursor: "pointer",
                  fontFamily: "inherit",
                }}
                title="Download the exact cash flows used to compute this XIRR. Open in Excel and run =XIRR() on the amount and date columns to verify."
              >
                Download CSV
              </button>
            </td>
            <td style={grn}>{fmt(s.projectedXIRR, "xirr")}</td>
          </tr>
          <tr><td style={lbl}>Cash-on-Cash Multiple</td><td style={valB}>{fmt(s.cashOnCashMultiple, "multiple")}</td></tr>
        </tbody>
      </table>

      {/* ===== DEAL STATISTICS + REALIZED vs UNREALIZED ===== */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginBottom: 20 }}>
        <table style={tbl}>
          <tbody>
            <tr><td colSpan={2} style={hdr}>DEAL STATISTICS</td></tr>
            <tr><td style={lbl}>Total Unique Deals</td><td style={valB}>{s.numDeals}</td></tr>
            <tr><td style={lbl}>Deals Active (Still Paying)</td><td style={{ ...val, color: "#FD8E3A", fontWeight: 700 }}>{s.dealsActiveBelowBasis}</td></tr>
            <tr><td style={lbl}>Deals in Profit</td><td style={grn}>{s.dealsInProfit}</td></tr>
            <tr><td style={lbl}>Deals Defaulted (No Payment 30+ Days)</td><td style={{ ...val, color: "#CC0000", fontWeight: 700 }}>{s.dealsDefaulted}</td></tr>
            <tr><td style={lbl}>Win Rate</td><td style={grn}>{fmt(s.winRate, "pct")}</td></tr>
            <tr><td style={lbl}>Default Rate</td><td style={{ ...val, color: "#CC0000" }}>{fmt(s.defaultRate, "pct")}</td></tr>
          </tbody>
        </table>

        <table style={tbl}>
          <tbody>
            <tr><td colSpan={2} style={hdr}>REALIZED vs. UNREALIZED</td></tr>
            <tr><td style={lbl}>Realized Value (Cash Only)</td><td style={valB}>{fmt(s.realizedValue)} <span style={{ color: "#5a7a9a", fontSize: 11 }}>Payouts + Balance</span></td></tr>
            <tr><td style={lbl}>Realized P&L</td><td style={grn}>{fmt(s.realizedPnL)} <span style={{ color: "#5a7a9a", fontSize: 11 }}>Cash only − Capital in</span></td></tr>
            <tr><td style={lbl}>Realized ROI</td><td style={val}>{fmt(s.realizedROI, "pct")}</td></tr>
            <tr><td style={lbl}></td><td style={val}></td></tr>
            <tr><td style={lbl}>Unrealized Value (Outstanding Principal)</td><td style={valB}>{fmt(s.unrealizedValue)}</td></tr>
            <tr><td style={lbl}>% of Active RTR Still Unreturned</td><td style={val}>{fmt(s.pctActiveRtrUnreturned, "pct")}</td></tr>
          </tbody>
        </table>
      </div>


      {/* ===== CAPITAL FLOW TIMELINE CHART ===== */}
      <div style={{ background: "#ffffff", border: "1px solid #B7E2FF", marginBottom: 20, overflow: "hidden" }}>
        <div style={{ ...hdr }}>CAPITAL FLOW SUMMARY</div>
        <div style={{ padding: "16px 14px" }}>
          <ResponsiveContainer width="100%" height={240}>
            <AreaChart data={cashFlowChart}>
              <CartesianGrid strokeDasharray="3 3" stroke="#EFF8FF" />
              <XAxis dataKey="date" tick={{ fill: "#5a7a9a", fontSize: 10 }} />
              <YAxis tick={{ fill: "#5a7a9a", fontSize: 10 }} tickFormatter={v => "$" + (v/1000).toFixed(0) + "k"} />
              <Tooltip contentStyle={{ background: "#084372", border: "none", borderRadius: 8, color: "#fff", fontSize: 12 }} formatter={(v) => fmt(v)} />
              <Area type="monotone" dataKey="cumulative" stroke="#0596F2" fill="rgba(5,150,242,0.12)" strokeWidth={2} name="Cumulative Net Flow" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* ===== SYNDICATOR COLLECTION CURVES CHART ===== */}
      <div style={{ background: "#ffffff", border: "1px solid #B7E2FF", marginBottom: 20, overflow: "hidden" }}>
        <div style={{ ...hdr }}>SYNDICATOR COLLECTION CURVES — CUMULATIVE % OF INVESTED (NET OF FEES)</div>
        <div style={{ padding: "16px 14px" }}>
          <ResponsiveContainer width="100%" height={320}>
            <LineChart data={curvesData}>
              <CartesianGrid strokeDasharray="3 3" stroke="#EFF8FF" />
              <XAxis dataKey="month" tick={{ fill: "#5a7a9a", fontSize: 12 }} />
              <YAxis tick={{ fill: "#5a7a9a", fontSize: 11 }} tickFormatter={v => (v*100).toFixed(0) + "%"} domain={[-0.1, 1.2]} />
              <Tooltip contentStyle={{ background: "#084372", border: "none", borderRadius: 8, color: "#fff", fontSize: 12 }} formatter={(v) => (v*100).toFixed(1) + "%"} />
              {DATA.curvesPct.map((c, i) => (
                <Line key={c.vintage} type="monotone" dataKey={c.vintage} stroke={vintageColors[i]} strokeWidth={2} dot={{ r: 4 }} connectNulls={false} />
              ))}
              <Legend formatter={(v) => <span style={{ color: "#084372", fontSize: 11 }}>{v}</span>} />
            </LineChart>
          </ResponsiveContainer>
          <div style={{ textAlign: "center", fontSize: 11, color: "#5a7a9a" }}>100% line = breakeven on invested capital (net of fees)</div>
        </div>
      </div>

      {/* ===== SYNDICATOR VINTAGE ANALYSIS ===== */}
      <table style={{ ...tbl, marginBottom: 20 }}>
        <thead>
          <tr><td colSpan={14} style={hdr}>SYNDICATOR PERFORMANCE BY MONTHLY VINTAGE (NET OF FEES)</td></tr>
          <tr>
            {["Vintage", "# Deals", "Syndicator Invested", "Total Collected", "Total Fees", "Net Collections", "Collection % NI", "Remaining RTR", "Defaulted RTR", "Dflt % RTR", "Exposure", "Default Rate", "Months Active", "Avg Monthly Yield"].map((h, i) => (
              <td key={h} style={{ ...subHdr, textAlign: i === 0 ? "left" : "right", fontSize: 10, padding: "6px 8px", whiteSpace: "nowrap" }}>{h}</td>
            ))}
          </tr>
        </thead>
        <tbody>
          {DATA.vintagesSynd.map(v => (
            <tr key={v.vintage}>
              <td style={{ ...valB, padding: "5px 8px", textAlign: "left", whiteSpace: "nowrap", minWidth: 70 }}>{v.vintage}</td>
              <td style={{ ...val, padding: "5px 8px" }}>{v.numDeals}</td>
              <td style={{ ...val, padding: "5px 8px" }}>{fmt(v.invested)}</td>
              <td style={{ ...val, padding: "5px 8px" }}>{fmt(v.totalCollected)}</td>
              <td style={{ ...val, padding: "5px 8px", color: "#CC0000" }}>{fmt(v.totalFees)}</td>
              <td style={{ ...val, padding: "5px 8px", color: v.netCollections >= 0 ? "#166534" : "#CC0000", fontWeight: 700 }}>{fmt(v.netCollections)}</td>
              <td style={{ ...val, padding: "5px 8px", fontWeight: 700, color: v.collectionPctNI >= 1 ? "#166534" : "#052B4C" }}>{fmt(v.collectionPctNI, "pct")}</td>
              <td style={{ ...val, padding: "5px 8px" }}>{fmt(v.remainingRTR)}</td>
              <td style={{ ...val, padding: "5px 8px", color: v.defaultedRTR > 0 ? "#CC0000" : "#5a7a9a" }}>{fmt(v.defaultedRTR)}</td>
              <td style={{ ...val, padding: "5px 8px", color: v.defaultPctRTR > 0 ? "#CC0000" : "#5a7a9a" }}>{fmt(v.defaultPctRTR, "pct")}</td>
              <td style={{ ...val, padding: "5px 8px", color: v.exposure > 0 ? "#FD8E3A" : "#166534" }}>{fmt(v.exposure)}</td>
              <td style={{ ...val, padding: "5px 8px", color: v.defaultRate > 0 ? "#CC0000" : "#5a7a9a" }}>{fmt(v.defaultRate, "pct")}</td>
              <td style={{ ...val, padding: "5px 8px" }}>{v.monthsActive}</td>
              <td style={{ ...val, padding: "5px 8px", color: v.avgMonthlyYield > 0 ? "#166534" : "#5a7a9a", fontWeight: 700 }}>{fmt(v.avgMonthlyYield, "pct")}</td>
            </tr>
          ))}
          <tr style={{ background: "#DFF0FF" }}>
            <td style={{ ...valB, padding: "6px 8px" }}>TOTAL</td>
            <td style={{ ...valB, padding: "6px 8px" }}>{s.numDeals}</td>
            <td style={{ ...valB, padding: "6px 8px" }}>{fmt(s.totalInvested)}</td>
            <td style={{ ...valB, padding: "6px 8px" }}>{fmt(s.totalGrossCollections)}</td>
            <td style={{ ...valB, padding: "6px 8px", color: "#CC0000" }}>{fmt(s.totalFees)}</td>
            <td style={{ ...valB, padding: "6px 8px" }}>{fmt(s.netCollections)}</td>
            <td colSpan={8} style={{ ...val, padding: "6px 8px" }}></td>
          </tr>
        </tbody>
      </table>

      {/* ===== COLLECTION CURVES ===== */}
      <table style={{ ...tbl, marginBottom: 20 }}>
        <thead>
          <tr><td colSpan={monthArray.length + 1} style={hdr}>SYNDICATOR COLLECTION CURVES — CUMULATIVE % OF INVESTED (NET OF FEES)</td></tr>
          <tr>
            <td style={{ ...subHdr, textAlign: "left", fontSize: 11, padding: "6px 10px" }}>Vintage</td>
            {monthArray.map(m => (
              <td key={m} style={{ ...subHdr, textAlign: "right", fontSize: 11, padding: "6px 10px" }}>Month {m}</td>
            ))}
          </tr>
        </thead>
        <tbody>
          {DATA.curvesPct.map(c => (
            <tr key={c.vintage}>
              <td style={{ ...valB, padding: "5px 10px", textAlign: "left", whiteSpace: "nowrap", minWidth: 70 }}>{c.vintage}</td>
              {monthArray.map(m => {
                const v = readMonth(c, m);
                return <td key={m} style={{ ...val, padding: "5px 10px", color: v == null ? "#B7E2FF" : v >= 1 ? "#166534" : v < 0 ? "#CC0000" : "#052B4C", fontWeight: v != null && v >= 1 ? 700 : 500 }}>{v != null ? fmt(v, "pct") : "N/A"}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {/* ===== COLLECTION CURVES $ ===== */}
      <table style={tbl}>
        <thead>
          <tr><td colSpan={monthArray.length + 1} style={hdr}>SYNDICATOR COLLECTION CURVES — CUMULATIVE $ (NET OF FEES)</td></tr>
          <tr>
            <td style={{ ...subHdr, textAlign: "left", fontSize: 11, padding: "6px 10px" }}>Vintage</td>
            {monthArray.map(m => (
              <td key={m} style={{ ...subHdr, textAlign: "right", fontSize: 11, padding: "6px 10px" }}>Month {m}</td>
            ))}
          </tr>
        </thead>
        <tbody>
          {DATA.curvesDollar.map(c => (
            <tr key={c.vintage}>
              <td style={{ ...valB, padding: "5px 10px", textAlign: "left", whiteSpace: "nowrap", minWidth: 70 }}>{c.vintage}</td>
              {monthArray.map(m => {
                const v = readMonth(c, m);
                return <td key={m} style={{ ...val, padding: "5px 10px", color: v == null ? "#B7E2FF" : v < 0 ? "#CC0000" : "#052B4C" }}>{v != null ? fmt(v) : "N/A"}</td>;
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {/* ===== DEAL-LEVEL PERFORMANCE ===== */}
      <table style={{ ...tbl, marginTop: 20 }}>
        <thead>
          <tr>
            <td colSpan={8} style={hdr}>DEAL-LEVEL PERFORMANCE</td>
            <td colSpan={3} style={{ ...hdr, textAlign: "right" }}>
              {["All", "Active", "Profit", "Default"].map(f => (
                <span key={f} onClick={() => setDealFilter(f)} style={{ cursor: "pointer", marginLeft: 8, padding: "3px 10px", borderRadius: 12, fontSize: 11, background: dealFilter === f ? "rgba(255,255,255,0.2)" : "transparent", color: "#B7E2FF" }}>{f}</span>
              ))}
            </td>
          </tr>
          <tr>
            {["Deal No.", "Merchant", "Invested", "Collected", "Fees Paid", "Net Return", "ROI", "Status", "Pmts Rem.", "$ Remaining", "Freq"].map(h => (
              <td key={h} style={{ ...subHdr, textAlign: h === "Merchant" ? "left" : "right", fontSize: 11, padding: "6px 10px", whiteSpace: "nowrap" }}>{h}</td>
            ))}
          </tr>
        </thead>
        <tbody>
          {filteredDeals.map(d => (
            <tr key={d.dealNo}>
              <td style={{ ...val, textAlign: "left", fontFamily: "monospace", fontSize: 11, color: "#5a7a9a", padding: "5px 10px" }}>{d.dealNo}</td>
              <td style={{ ...val, textAlign: "left", maxWidth: 180, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", padding: "5px 10px", color: "#052B4C" }}>{d.merchant}</td>
              <td style={{ ...val, padding: "5px 10px" }}>{fmt(d.invested)}</td>
              <td style={{ ...val, padding: "5px 10px", color: "#084372" }}>{fmt(d.collected)}</td>
              <td style={{ ...val, padding: "5px 10px", color: "#CC0000" }}>{fmt(d.feesPaid)}</td>
              <td style={{ ...val, padding: "5px 10px", color: d.netReturn >= 0 ? "#166534" : "#CC0000", fontWeight: 700 }}>{fmt(d.netReturn)}</td>
              <td style={{ ...val, padding: "5px 10px", color: d.roi >= 0 ? "#166534" : "#CC0000", fontWeight: 600 }}>{fmt(d.roi, "pct")}</td>
              <td style={{ ...val, padding: "5px 10px", textAlign: "center" }}><StatusBadge status={d.status} netReturn={d.netReturn} /></td>
              <td style={{ ...val, padding: "5px 10px", color: "#084372" }}>{d.pmtsRemaining}</td>
              <td style={{ ...val, padding: "5px 10px", color: "#084372" }}>{typeof d.dollarRemaining === "number" ? fmt(d.dollarRemaining) : d.dollarRemaining}</td>
              <td style={{ ...val, padding: "5px 10px", color: "#5a7a9a", fontSize: 11 }}>{d.frequency}</td>
            </tr>
          ))}
          <tr style={{ background: "#DFF0FF" }}>
            <td style={{ ...valB, textAlign: "left", padding: "8px 10px" }}>TOTAL</td>
            <td style={{ ...valB, textAlign: "left", padding: "8px 10px" }}></td>
            <td style={{ ...valB, padding: "8px 10px" }}>{fmt(s.totalInvested)}</td>
            <td style={{ ...valB, padding: "8px 10px" }}>{fmt(s.totalGrossCollections)}</td>
            <td style={{ ...valB, padding: "8px 10px", color: "#CC0000" }}>{fmt(s.totalFees)}</td>
            <td style={{ ...valB, padding: "8px 10px", color: s.grossPnL >= 0 ? "#166534" : "#CC0000" }}>{fmt(s.grossPnL)}</td>
            <td colSpan={5} style={{ ...val, padding: "8px 10px" }}></td>
          </tr>
        </tbody>
      </table>

    </div>
  );
}

// --- Main App ---
export default function App() {
  const [page, setPage] = useState("overview");
  const { portfolioData, syndicatorData, loading, error, source, refresh, syndicators, selectedSyndicatorId, selectSyndicator } = usePortfolio();
  const DATA = page === "overview" ? portfolioData : syndicatorData;

  if (loading) {
    return (
      <div style={{ minHeight: "100vh", background: "#EFF8FF", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Inria Sans', sans-serif" }}>
        <link href="https://fonts.googleapis.com/css2?family=Inria+Sans:wght@300;400;700&display=swap" rel="stylesheet" />
        <div style={{ textAlign: "center", maxWidth: 420, padding: "0 24px" }}>
          <img src={LOGO} alt="Starfish Advance" style={{ height: 64, width: 64, borderRadius: 12, marginBottom: 16 }} />
          <div style={{ color: "#084372", fontSize: 18, fontWeight: 700 }}>Starfish Advance</div>
          <div style={{ color: "#5a7a9a", fontSize: 14, marginTop: 12, fontWeight: 600 }}>Loading live data from SmartMCA...</div>
          <div style={{ color: "#7a93b3", fontSize: 12, marginTop: 8, lineHeight: 1.5 }}>
            Cold loads can take up to two minutes on the first request of the day.
            Subsequent loads in the next 5 minutes will be instant.
          </div>
          {/* Animated dot indicator (CSS-only) */}
          <div style={{ marginTop: 20, display: "flex", justifyContent: "center", gap: 6 }}>
            {[0, 1, 2].map(i => (
              <span key={i} style={{
                width: 8, height: 8, borderRadius: "50%",
                background: "#0596F2",
                animation: `pulse 1.4s ease-in-out ${i * 0.2}s infinite`,
              }} />
            ))}
          </div>
          <style>{`
            @keyframes pulse {
              0%, 60%, 100% { opacity: 0.3; transform: scale(0.85); }
              30% { opacity: 1; transform: scale(1); }
            }
          `}</style>
        </div>
      </div>
    );
  }

  if (!DATA) {
    return (
      <div style={{ minHeight: "100vh", background: "#EFF8FF", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "'Inria Sans', sans-serif" }}>
        <div style={{ textAlign: "center", maxWidth: 400 }}>
          <div style={{ color: "#CC0000", fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Failed to load data</div>
          <div style={{ color: "#5a7a9a", fontSize: 13 }}>{error}</div>
          <button onClick={refresh} style={{ marginTop: 16, padding: "8px 24px", background: "#084372", color: "#fff", border: "none", borderRadius: 8, cursor: "pointer", fontFamily: "'Inria Sans'" }}>Retry</button>
        </div>
      </div>
    );
  }

  const s = DATA.summary || {};
  const selectedSyndName = syndicators.find(x => x.id === selectedSyndicatorId)?.name || 'Select Syndicator';

  return (
    <div style={{ minHeight: "100vh", background: "#EFF8FF", color: "#052B4C", fontFamily: "'Inria Sans', -apple-system, sans-serif" }}>
      <link href="https://fonts.googleapis.com/css2?family=Inria+Sans:wght@300;400;700&display=swap" rel="stylesheet" />

      {/* Header */}
      <div style={{ background: "linear-gradient(135deg, #084372 0%, #052B4C 100%)", borderBottom: "1px solid rgba(255,255,255,0.06)", padding: "0 32px" }}>
        <div style={{ maxWidth: 1400, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", height: 64 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <img src={LOGO} alt="Starfish Advance" style={{ height: 40, width: 40, borderRadius: 8 }} />
            <div style={{ fontSize: 20, fontWeight: 800, letterSpacing: -0.5 }}>
              <span style={{ color: "#B7E2FF", letterSpacing: 0 }}>Starfish Advance</span>
              <span style={{ color: "#78CBFF", fontWeight: 400, fontSize: 14, marginLeft: 8 }}>Syndicator Analytics</span>
            </div>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <button onClick={() => setPage("overview")} style={{ padding: "8px 20px", borderRadius: 8, border: "none", background: page === "overview" ? "rgba(5,150,242,0.2)" : "transparent", color: page === "overview" ? "#78CBFF" : "#B7E2FF", cursor: "pointer", fontWeight: 600, fontSize: 13, fontFamily: "'Inria Sans'" }}>Portfolio Overview</button>
            <button onClick={() => setPage("syndicator")} style={{ padding: "8px 20px", borderRadius: 8, border: "none", background: page === "syndicator" ? "rgba(5,150,242,0.2)" : "transparent", color: page === "syndicator" ? "#78CBFF" : "#B7E2FF", cursor: "pointer", fontWeight: 600, fontSize: 13, fontFamily: "'Inria Sans'" }}>Syndicator View</button>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {page === "syndicator" && (
              <select value={selectedSyndicatorId || ''} onChange={e => selectSyndicator(e.target.value)} style={{ background: "#084372", color: "#B7E2FF", border: "1px solid #0596F2", borderRadius: 8, padding: "6px 12px", fontSize: 13, fontFamily: "'Inria Sans'", maxWidth: 220 }}>
                {syndicators.map(syn => (
                  <option key={syn.id} value={syn.id}>
                    {syn.name}{syn.totalInvested > 0 ? ` ($${Math.round(syn.totalInvested / 1000)}k)` : ''}
                  </option>
                ))}
              </select>
            )}
            <button onClick={refresh} title="Refresh data" style={{ background: "none", border: "1px solid #0596F2", borderRadius: 8, padding: "6px 10px", cursor: "pointer", color: "#78CBFF", fontSize: 12, fontFamily: "'Inria Sans'" }}>↻</button>
          </div>
        </div>
      </div>

      {/* Subheader */}
      <div style={{ background: "#ffffff", borderBottom: "1px solid #DFF0FF", padding: "12px 32px" }}>
        <div style={{ maxWidth: 1400, margin: "0 auto", display: "flex", gap: 32, fontSize: 12, color: "#5a7a9a", flexWrap: "wrap" }}>
          <span>Syndicator: <b style={{ color: "#084372" }}>{page === "overview" ? `All (${s.aggSyndicatorCount || syndicators.length})` : (s.syndicatorName || selectedSyndName)}</b></span>
          <span>Period: <b style={{ color: "#084372" }}>{s.period?.start || '—'} — {s.period?.end || '—'}</b></span>
          <span>Duration: <b style={{ color: "#084372" }}>{s.durationDays || '—'} days</b></span>
          <span>Deals: <b style={{ color: "#084372" }}>{s.numDeals || 0}</b></span>
          <span>Data: <b style={{ color: source === 'live' ? "#166534" : "#FD8E3A" }}>{source === 'live' ? 'Live API' : 'Sample Data'}</b></span>
          {DATA._meta?.hasSubledger && <span style={{ color: "#166534" }}>Subledger: Connected</span>}
          {error && <span style={{ color: "#CC0000" }}>API: {error}</span>}
        </div>
      </div>

      {/* Banners: warn if data is degraded or fallback */}
      {source === 'fallback' && (
        <div style={{ background: "#FFF4E5", borderBottom: "1px solid #FD8E3A", padding: "10px 32px" }}>
          <div style={{ maxWidth: 1400, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 13, color: "#7C4A00" }}>
            <span>⚠ <b>Showing sample data.</b> The SmartMCA API is unreachable or timed out. Numbers below are not live.</span>
            <button onClick={refresh} style={{ background: "#FD8E3A", color: "#fff", border: "none", borderRadius: 6, padding: "5px 14px", cursor: "pointer", fontFamily: "'Inria Sans'", fontSize: 12, fontWeight: 600 }}>Retry</button>
          </div>
        </div>
      )}
      {source === 'live' && DATA?._meta?.dataIntegrity === 'partial' && (
        <div style={{ background: "#FFF8E1", borderBottom: "1px solid #E8B400", padding: "10px 32px" }}>
          <div style={{ maxWidth: 1400, margin: "0 auto", display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 13, color: "#7A5C00" }}>
            <span>
              ⚠ <b>Some data is incomplete.</b>{' '}
              {DATA._debug?.fetchFailures?.dealCount > 0 && `${DATA._debug.fetchFailures.dealCount} deal(s) couldn't be loaded. `}
              {DATA._debug?.fetchFailures?.paymentCount > 0 && `${DATA._debug.fetchFailures.paymentCount} payment fetch(es) failed. `}
              Numbers shown may under-count.
            </span>
            <button onClick={refresh} style={{ background: "#E8B400", color: "#fff", border: "none", borderRadius: 6, padding: "5px 14px", cursor: "pointer", fontFamily: "'Inria Sans'", fontSize: 12, fontWeight: 600 }}>Refresh</button>
          </div>
        </div>
      )}

      {/* Body */}
      <div style={{ maxWidth: 1400, margin: "0 auto", padding: "32px 32px 64px" }}>
        {page === "overview" ? <OverviewPage DATA={portfolioData || DATA} /> : <SyndicatorPage DATA={syndicatorData || DATA} />}
      </div>

      {/* Footer */}
      <div style={{ borderTop: "1px solid #DFF0FF", padding: "16px 32px", textAlign: "center", fontSize: 11, color: "#5a7a9a" }}>
        Powered by SmartMCA Starfish Advance Public API v1.0 · {source === 'live' ? 'Connected' : 'Demo Mode'}
      </div>
    </div>
  );
}
