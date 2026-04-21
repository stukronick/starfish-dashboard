// Temporary: /api/probe-fields
export default async function handler(req, res) {
  const API_KEY = process.env.SMARTMCA_API_KEY;
  const API_BASE = process.env.SMARTMCA_API_BASE || 'https://api.staging.v3.smartmca.com/api/public/v1';

  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!API_KEY) return res.status(500).json({ error: 'No API key', hasKey: false });

  const syndicatorId = req.query.syndicatorId || 'cmnxpok7m00s601njoqavtfg1';
  const targetDate = req.query.date || '2026-04-07';

  try {
    const url = `${API_BASE}/accounting/reports/subledger/syndicator/${syndicatorId}?limit=10000`;
    const r = await fetch(url, {
      headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    });

    const raw = await r.json();

    // Show the raw response shape
    const topKeys = Object.keys(raw);
    const dataKeys = raw.data ? Object.keys(raw.data) : [];
    
    // Try every possible path to entries
    let entries = [];
    let entriesPath = 'none found';
    
    if (raw.data?.entries && Array.isArray(raw.data.entries)) {
      entries = raw.data.entries;
      entriesPath = 'data.entries';
    } else if (Array.isArray(raw.data?.data)) {
      entries = raw.data.data;
      entriesPath = 'data.data';
    } else if (Array.isArray(raw.data)) {
      entries = raw.data;
      entriesPath = 'data';
    }

    // Filter to target date
    const dateEntries = entries.filter(e => (e.date || '').startsWith(targetDate));

    // Get ALL unique field names
    const allFields = new Set();
    for (const e of entries.slice(0, 100)) {
      const walk = (obj, prefix) => {
        if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return;
        for (const [k, v] of Object.entries(obj)) {
          const path = prefix ? `${prefix}.${k}` : k;
          allFields.add(path);
          if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, path);
        }
      };
      walk(e, '');
    }

    // Unique accounts
    const accounts = [...new Set(entries.map(e => e.account).filter(Boolean))];

    res.status(200).json({
      httpStatus: r.status,
      url,
      responseTopKeys: topKeys,
      responseDataKeys: dataKeys,
      entriesPath,
      totalEntries: entries.length,
      currentBalance: raw.data?.currentBalance || raw.currentBalance || null,
      targetDate,
      entriesOnDate: dateEntries.length,
      allFieldNames: [...allFields].sort(),
      uniqueAccounts: accounts,
      firstEntry: entries[0] || null,
      rawEntriesOnDate: dateEntries.slice(0, 20),
    });
  } catch (e) {
    res.status(500).json({ error: e.message, stack: e.stack?.substring(0, 300) });
  }
}
