// Temporary debug endpoint: /api/probe-fees
// Check if contacts API exposes syndicator fee configuration

export default async function handler(req, res) {
  const API_KEY = process.env.SMARTMCA_API_KEY;
  const API_BASE = process.env.SMARTMCA_API_BASE || 'https://api.staging.v3.smartmca.com/api/public/v1';

  res.setHeader('Access-Control-Allow-Origin', '*');
  if (!API_KEY) return res.status(500).json({ error: 'No API key' });

  const results = {};

  // 1. Try individual contact endpoint
  try {
    const r = await fetch(`${API_BASE}/contacts/cmnxpok7m00s601njoqavtfg1`, {
      headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    });
    results.contactDetail = { status: r.status, body: r.ok ? await r.json() : await r.text() };
  } catch (e) { results.contactDetail = { error: e.message }; }

  // 2. Get LMJS from contacts list - dump ALL fields
  try {
    const r = await fetch(`${API_BASE}/contacts?limit=100`, {
      headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
    });
    const data = await r.json();
    const contacts = Array.isArray(data.data) ? data.data : data.data?.data || [];
    const lmjs = contacts.find(c => c.id === 'cmnxpok7m00s601njoqavtfg1');
    results.lmjsFullObject = lmjs || 'not found';
    // Check all field names across all contacts
    const allFields = new Set();
    for (const c of contacts) {
      const walk = (obj, prefix) => {
        if (!obj || typeof obj !== 'object') return;
        for (const [k, v] of Object.entries(obj)) {
          const path = prefix ? `${prefix}.${k}` : k;
          allFields.add(path);
          if (v && typeof v === 'object' && !Array.isArray(v)) walk(v, path);
          if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'object') walk(v[0], `${path}[]`);
        }
      };
      walk(c, '');
    }
    results.allContactFields = [...allFields].sort();
  } catch (e) { results.contactsList = { error: e.message }; }

  // 3. Try syndicator-specific endpoints that might have fee config
  const probeEndpoints = [
    '/syndicators',
    '/contacts/cmnxpok7m00s601njoqavtfg1/promotes',
    '/contacts/cmnxpok7m00s601njoqavtfg1/fees',
    '/contacts/cmnxpok7m00s601njoqavtfg1/settings',
    '/syndicator-settings',
    '/promotes',
  ];

  results.endpointProbes = {};
  for (const ep of probeEndpoints) {
    try {
      const r = await fetch(`${API_BASE}${ep}`, {
        headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      });
      const body = r.ok ? await r.json() : await r.text();
      results.endpointProbes[ep] = { status: r.status, body: typeof body === 'string' ? body.substring(0, 200) : body };
    } catch (e) { results.endpointProbes[ep] = { error: e.message }; }
  }

  res.status(200).json(results);
}
