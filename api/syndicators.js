// Vercel Serverless Function: /api/syndicators
// Returns list of syndicators from SmartMCA contacts

export default async function handler(req, res) {
  const API_KEY = process.env.SMARTMCA_API_KEY;
  const API_BASE = process.env.SMARTMCA_API_BASE || 'https://api.staging.v3.smartmca.com/api/public/v1';

  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!API_KEY) return res.status(500).json({ error: 'SMARTMCA_API_KEY not configured.' });

  try {
    // Paginate through all contacts
    const syndicators = [];
    let page = 1;
    while (true) {
      const resp = await fetch(`${API_BASE}/contacts?limit=100&page=${page}`, {
        headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      });
      if (!resp.ok) throw new Error(`${resp.status}: ${await resp.text()}`);
      const data = await resp.json();
      const contacts = data.data || [];
      
      // Filter to syndicators only
      for (const c of contacts) {
        if (c.type === 'syndicator') {
          syndicators.push({
            id: c.id,
            name: c.name,
            email: c.email,
            phone: c.phone,
            status: c.status,
            totalInvested: c.details?.totalInvested || 0,
            totalDistributed: c.details?.totalDistributed || 0,
            runningBalance: c.details?.runningBalance || 0,
            entityName: c.details?.entityName || '',
            syndicatorType: c.details?.syndicatorType || '',
          });
        }
      }
      
      const pag = data.meta?.pagination;
      if (!pag || page >= pag.totalPages) break;
      page++;
    }

    // Sort by totalInvested descending
    syndicators.sort((a, b) => b.totalInvested - a.totalInvested);

    res.status(200).json({ syndicators });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch syndicators', details: error.message });
  }
}
