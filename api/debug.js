// Temporary debug endpoint - DELETE AFTER FIXING
// Visit: https://starfish-dashboard.vercel.app/api/debug

export default async function handler(req, res) {
  const key = process.env.SMARTMCA_API_KEY || '';
  const base = process.env.SMARTMCA_API_BASE || 'https://api.nexus.smartmca.com/api/public/v1';
  
  // Show key prefix only (safe - first 16 chars)
  const keyPreview = key ? key.substring(0, 16) + '...' + ` (length: ${key.length})` : 'NOT SET';
  
  // Check for common issues
  const issues = [];
  if (!key) issues.push('Key is empty');
  if (key.startsWith('"') || key.startsWith("'")) issues.push('Key has quotes around it');
  if (key.startsWith(' ') || key.endsWith(' ')) issues.push('Key has leading/trailing spaces');
  if (key.includes('\n') || key.includes('\r')) issues.push('Key contains newline characters');
  if (!key.startsWith('smca_live_') && !key.startsWith('smca_test_')) issues.push('Key does not start with smca_live_ or smca_test_');
  
  // Try the actual API call
  let apiResult = null;
  try {
    const resp = await fetch(`${base}/health`, {
      headers: { 'Authorization': `Bearer ${key}` },
    });
    apiResult = { status: resp.status, body: await resp.text() };
  } catch (e) {
    apiResult = { error: e.message };
  }

  res.status(200).json({
    keyPreview,
    base,
    issues: issues.length ? issues : ['None detected'],
    apiHealthCheck: apiResult,
    envVarNames: Object.keys(process.env).filter(k => k.includes('SMART') || k.includes('API')),
  });
}
