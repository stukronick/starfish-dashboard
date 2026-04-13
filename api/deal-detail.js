// Vercel Serverless Function: /api/deal-detail
// Fetches a single deal with its payments and collection schedule

const API_KEY = process.env.SMARTMCA_API_KEY;
const API_BASE = process.env.SMARTMCA_API_BASE || 'https://api.nexus.smartmca.com/api/public/v1';

async function apiFetch(path) {
  const resp = await fetch(`${API_BASE}${path}`, {
    headers: { 'Authorization': `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
  });
  if (!resp.ok) throw new Error(`${resp.status} on ${path}`);
  return resp.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  if (!API_KEY) return res.status(500).json({ error: 'SMARTMCA_API_KEY not configured' });

  const { dealId } = req.query;
  if (!dealId) return res.status(400).json({ error: 'dealId query param required' });

  try {
    const [deal, payments] = await Promise.all([
      apiFetch(`/deals/${dealId}`),
      apiFetch(`/deals/${dealId}/payments?limit=100`),
    ]);

    // Optionally fetch collection schedule (may not be available for all deals)
    let schedule = null;
    try {
      schedule = await apiFetch(`/deals/${dealId}/collection-schedule`);
    } catch (e) { /* collection schedule not available */ }

    res.status(200).json({
      deal: deal.data,
      payments: payments.data,
      collectionSchedule: schedule?.data || null,
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch deal detail', details: error.message });
  }
}
