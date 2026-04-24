// Temporary: /api/probe-fields
export default async function handler(req, res) {
  const API_KEY = process.env.SMARTMCA_API_KEY;
  const API_BASE = process.env.SMARTMCA_API_BASE || 'https://api.staging.v3.smartmca.com/api/public/v1';
  res.setHeader('Access-Control-Allow-Origin', '*');

  const syndicatorId = req.query.syndicatorId || 'cmo8qi0pj00vy01masnzahelz';

  try {
    const r = await fetch(`${API_BASE}/accounting/reports/subledger/syndicator/${syndicatorId}?limit=10000`, {
      headers: { 'Authorization': `Bearer ${API_KEY}` },
    });
    const data = await r.json();
    const entries = data.data?.entries || [];

    // Group by description prefix (first 60 chars, normalized)
    const patterns = {};
    for (const e of entries) {
      const desc = (e.description || '').substring(0, 80);
      const key = desc.replace(/\$[\d,.]+/g, '{$}').replace(/\d{4}-\d{2}-\d{2}/g, '{DATE}');
      if (!patterns[key]) patterns[key] = { count: 0, credit: 0, debit: 0, account: e.account, sample: e.description?.substring(0, 120) };
      patterns[key].count++;
      patterns[key].credit += e.credit || 0;
      patterns[key].debit += e.debit || 0;
    }

    // Unique accounts
    const accounts = [...new Set(entries.map(e => e.account))];

    // All field names from first entry
    const fields = entries[0] ? Object.keys(entries[0]) : [];

    res.status(200).json({
      totalEntries: entries.length,
      currentBalance: data.data?.currentBalance,
      uniqueAccounts: accounts,
      entryFields: fields,
      firstEntry: entries[0] || null,
      lastEntry: entries[entries.length - 1] || null,
      descriptionPatterns: patterns,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}
