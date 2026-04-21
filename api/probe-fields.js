// Temporary: /api/probe-fields — check all endpoints
export default async function handler(req, res) {
  const API_KEY = process.env.SMARTMCA_API_KEY;
  const API_BASE = process.env.SMARTMCA_API_BASE || 'https://api.staging.v3.smartmca.com/api/public/v1';

  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!API_KEY) return res.status(500).json({ error: 'No API key' });

  const results = {};

  // 1. Test deals
  try {
    const r = await fetch(`${API_BASE}/deals?limit=5`, {
      headers: { 'Authorization': `Bearer ${API_KEY}` },
    });
    const d = await r.json();
    results.deals = { status: r.status, count: d.data?.length || 0, firstDeal: d.data?.[0]?.dealId || null };
  } catch (e) { results.deals = { error: e.message }; }

  // 2. Test contacts
  try {
    const r = await fetch(`${API_BASE}/contacts?limit=5`, {
      headers: { 'Authorization': `Bearer ${API_KEY}` },
    });
    const d = await r.json();
    const contacts = Array.isArray(d.data) ? d.data : d.data?.data || [];
    results.contacts = { status: r.status, count: contacts.length, firstName: contacts[0]?.name || null };
  } catch (e) { results.contacts = { error: e.message }; }

  // 3. Test subledger for LMJS
  try {
    const r = await fetch(`${API_BASE}/accounting/reports/subledger/syndicator/cmnxpok7m00s601njoqavtfg1?limit=10000`, {
      headers: { 'Authorization': `Bearer ${API_KEY}` },
    });
    const d = await r.json();
    const entries = d.data?.entries || [];
    results.subledgerLMJS = {
      status: r.status,
      entryCount: entries.length,
      currentBalance: d.data?.currentBalance,
      syndicatorId: d.data?.syndicatorId,
      dataKeys: d.data ? Object.keys(d.data) : [],
    };
  } catch (e) { results.subledgerLMJS = { error: e.message }; }

  // 4. Test subledger for Jacob (different syndicator)
  try {
    const r = await fetch(`${API_BASE}/accounting/reports/subledger/syndicator/cmnxpok7000s201njywghbe6t?limit=100`, {
      headers: { 'Authorization': `Bearer ${API_KEY}` },
    });
    const d = await r.json();
    const entries = d.data?.entries || [];
    results.subledgerJacob = {
      status: r.status,
      entryCount: entries.length,
      currentBalance: d.data?.currentBalance,
    };
  } catch (e) { results.subledgerJacob = { error: e.message }; }

  // 5. Check API key info (first 8 chars only for safety)
  results.apiKeyPrefix = API_KEY.substring(0, 12) + '...';

  res.status(200).json(results);
}
