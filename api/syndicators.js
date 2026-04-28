// Vercel Serverless Function: /api/syndicators
// Returns list of syndicators from SmartMCA contacts.
//
// Response shape: { syndicators: [...] } sorted by totalInvested desc.

// ============================================================================
// SIMPLE IN-MEMORY CACHE (5 minutes)
//   Same pattern as portfolio.js but lighter — only one upstream path
//   (/contacts) is involved, so no need for a full key/value map.
// ============================================================================
const CACHE_TTL_MS = 5 * 60 * 1000;
let cached = null; // { value, expiresAt }

export default async function handler(req, res) {
  const API_KEY = process.env.SMARTMCA_API_KEY;
  const API_BASE = process.env.SMARTMCA_API_BASE || 'https://api.staging.v3.smartmca.com/api/public/v1';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'private, max-age=300');

  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!API_KEY) return res.status(500).json({ error: 'SMARTMCA_API_KEY not configured.' });

  const bypass = req.query.nocache === '1' || req.query.nocache === 'true';
  const now = Date.now();

  if (!bypass && cached && cached.expiresAt > now) {
    return res.status(200).json({ syndicators: cached.value, cached: true });
  }

  try {
    const syndicators = [];
    let page = 1;

    while (true) {
      const resp = await fetch(`${API_BASE}/contacts?limit=100&page=${page}`, {
        headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
      });
      if (!resp.ok) throw new Error(`${resp.status}: ${await resp.text()}`);

      const raw = await resp.json();

      // Handle both { data: [...] } and { data: { data: [...] } } response shapes
      let contacts = [];
      let pagination = null;
      if (Array.isArray(raw.data)) {
        contacts = raw.data;
        pagination = raw.meta?.pagination;
      } else if (raw.data && Array.isArray(raw.data.data)) {
        contacts = raw.data.data;
        pagination = raw.data.meta?.pagination || raw.meta?.pagination;
      } else if (Array.isArray(raw)) {
        contacts = raw;
      }

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

      if (!pagination || page >= (pagination.totalPages || 1)) break;
      page++;
    }

    syndicators.sort((a, b) => b.totalInvested - a.totalInvested);

    cached = { value: syndicators, expiresAt: now + CACHE_TTL_MS };
    res.status(200).json({ syndicators, cached: false });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch syndicators', details: error.message });
  }
}
