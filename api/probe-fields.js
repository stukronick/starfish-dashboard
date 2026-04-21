// Temporary: /api/probe-fields
// Dumps raw subledger entries to see ALL available fields

export default async function handler(req, res) {
  const API_KEY = process.env.SMARTMCA_API_KEY;
  const API_BASE = process.env.SMARTMCA_API_BASE || 'https://api.staging.v3.smartmca.com/api/public/v1';

  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!API_KEY) return res.status(500).json({ error: 'No API key' });

  const syndicatorId = req.query.syndicatorId || 'cmnxpok7m00s601njoqavtfg1';
  const targetDate = req.query.date || '2026-04-07'; // busy date with many entries

  try {
    const r = await fetch(`${API_BASE}/accounting/reports/subledger/syndicator/${syndicatorId}?limit=10000`, {
      headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    });
    const data = await r.json();
    const entries = data.data?.entries || data.data?.data || (Array.isArray(data.data) ? data.data : []);

    // Filter to target date
    const dateEntries = entries.filter(e => (e.date || '').startsWith(targetDate));

    // Get ALL unique field names across all entries
    const allFields = new Set();
    entries.forEach(e => {
      const walk = (obj, prefix) => {
        if (!obj || typeof obj !== 'object') return;
        for (const [k, v] of Object.entries(obj)) {
          const path = prefix ? `${prefix}.${k}` : k;
          allFields.add(path);
          if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, path);
        }
      };
      walk(e, '');
    });

    // Get unique accounts
    const accounts = [...new Set(entries.map(e => e.account))];

    // Get entries from ALL accounts for the target date (not just Syndicator Distributions Payable)
    const allAccountEntries = dateEntries;

    res.status(200).json({
      targetDate,
      totalEntries: entries.length,
      entriesOnDate: dateEntries.length,
      allFieldNames: [...allFields].sort(),
      uniqueAccounts: accounts,
      // First 30 raw entries for this date — every field visible
      rawEntries: allAccountEntries.slice(0, 30),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
