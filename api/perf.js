const ADMIN_PASS = process.env.ADMIN_PASS;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

export const config = { maxDuration: 30 };

// Brug samme session-token som login.js genererer
async function verifyAdminSession(req) {
  const auth = req.headers['x-session-token'] || '';
  if (!auth) return false;
  // Tjek at token matcher admin-session
  return auth === ADMIN_PASS;
}

async function getMetrics() {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/perf_metrics?select=route,duration_ms,status_code,recorded_at&order=recorded_at.desc&limit=500`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    return await r.json();
  } catch(e) { return []; }
}

async function saveMetric(route, ms, status) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/perf_metrics`, {
      method: 'POST',
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
      body: JSON.stringify({ route, duration_ms: ms, status_code: status })
    });
  } catch(e) {}
}

function rate(ms) {
  if (ms < 1000) return { score: 90, label: 'God', color: '#10b981' };
  if (ms < 3000) return { score: 65, label: 'Mangler', color: '#f59e0b' };
  if (ms < 8000) return { score: 35, label: 'Dårlig', color: '#ef4444' };
  return { score: 10, label: 'Kritisk', color: '#7c3aed' };
}

const FIXES = {
  '/api/generate': { cause: 'Store prompts + Vercel Hobby timeout', fix: 'Streaming er aktivt. Hold promptCap under 24k tegn per fil.' },
  '/api/login':    { cause: 'SHA-256 hashing + Supabase kald', fix: 'Normalt — Supabase EU-Central er tættest på DK.' },
  '/api/db':       { cause: 'Stor SELECT forespørgsel', fix: 'Tilføj index: CREATE INDEX ON documents(subject);' },
};

function getFix(route) {
  for (const [k, v] of Object.entries(FIXES)) if (route.includes(k)) return v;
  return { cause: 'Ukendt', fix: 'Tjek Vercel Dashboard → Functions → Logs' };
}

function buildDashboard(metrics) {
  const byRoute = {};
  for (const m of metrics) {
    if (!byRoute[m.route]) byRoute[m.route] = [];
    byRoute[m.route].push(m);
  }
  const rows = Object.entries(byRoute).map(([route, arr]) => {
    const avg = Math.round(arr.reduce((s,m) => s + m.duration_ms, 0) / arr.length);
    const worst = Math.max(...arr.map(m => m.duration_ms));
    const errors = arr.filter(m => m.status_code >= 400).length;
    const r = rate(avg);
    const fix = getFix(route);
    return `<div style="background:#1e293b;border:1px solid #334155;border-left:4px solid ${r.color};border-radius:10px;padding:16px;margin-bottom:12px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <div><code style="color:#e2e8f0;font-size:.85rem;">${route}</code>
          <span style="margin-left:8px;font-size:.65rem;font-weight:600;padding:2px 8px;border-radius:20px;background:${r.color}20;color:${r.color};border:1px solid ${r.color}40">${r.label}</span>
        </div>
        <div style="font-size:1.8rem;font-weight:700;color:${r.color}">${r.score}</div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:12px;font-size:.75rem;color:#94a3b8;margin-bottom:${r.score < 75 ? '10px' : '0'};">
        <span>⌀ ${avg}ms</span><span>🔼 ${worst}ms</span><span>📊 ${arr.length} kald</span>
        <span style="color:${errors > 0 ? '#ef4444' : '#10b981'}">${errors > 0 ? '❌ ' + errors + ' fejl' : '✓ Ingen fejl'}</span>
      </div>
      ${r.score < 75 ? `<div style="background:#0f172a;border:1px solid #334155;border-radius:8px;padding:10px;font-size:.78rem;">
        <div style="color:#f59e0b;font-weight:600;margin-bottom:4px;">⚡ Fix</div>
        <div style="color:#94a3b8;"><strong style="color:#cbd5e1;">Årsag:</strong> ${fix.cause}</div>
        <div style="color:#94a3b8;margin-top:4px;"><strong style="color:#cbd5e1;">Løsning:</strong> ${fix.fix}</div>
      </div>` : ''}
    </div>`;
  }).join('');

  const total = metrics.length;
  const avgAll = total ? Math.round(metrics.reduce((s,m) => s + m.duration_ms, 0) / total) : 0;
  const errTotal = metrics.filter(m => m.status_code >= 400).length;
  const overall = rows.length ? Math.round(Object.values(byRoute).map(arr => {
    const avg = Math.round(arr.reduce((s,m) => s + m.duration_ms, 0) / arr.length);
    return rate(avg).score;
  }).reduce((s,v) => s + v, 0) / Object.keys(byRoute).length) : 100;
  const oc = overall >= 75 ? '#10b981' : overall >= 50 ? '#f59e0b' : '#ef4444';

  return `<!DOCTYPE html><html lang="da"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cyber2026 Performance</title>
<style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;}</style>
</head><body>
<div style="background:#1e293b;border-bottom:1px solid #334155;padding:16px 24px;display:flex;justify-content:space-between;align-items:center;">
  <div><div style="font-weight:700;color:#60a5fa;font-size:1.1rem;">⚡ Cyber2026 Performance</div>
  <div style="font-size:.72rem;color:#64748b;margin-top:2px;">${new Date().toLocaleString('da-DK')}</div></div>
  <div style="display:flex;align-items:center;gap:12px;">
    <div style="text-align:center"><div style="font-size:2rem;font-weight:700;color:${oc}">${overall}</div>
    <div style="font-size:.7rem;color:#64748b;">samlet score</div></div>
    <button onclick="location.reload()" style="background:#3b82f6;color:#fff;border:none;padding:8px 14px;border-radius:8px;cursor:pointer;font-size:.8rem;font-weight:600;">↻ Opdater</button>
    <a href="/" style="color:#64748b;font-size:.8rem;text-decoration:none;">← App</a>
  </div>
</div>
<div style="max-width:800px;margin:0 auto;padding:24px 16px;">
  <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:24px;">
    <div style="background:#1e293b;border:1px solid #334155;border-radius:10px;padding:16px;text-align:center;">
      <div style="font-size:1.6rem;font-weight:700;color:#60a5fa;">${total}</div><div style="font-size:.72rem;color:#94a3b8;margin-top:4px;">Totale kald</div></div>
    <div style="background:#1e293b;border:1px solid #334155;border-radius:10px;padding:16px;text-align:center;">
      <div style="font-size:1.6rem;font-weight:700;color:#60a5fa;">${avgAll}ms</div><div style="font-size:.72rem;color:#94a3b8;margin-top:4px;">Gns. svartid</div></div>
    <div style="background:#1e293b;border:1px solid #334155;border-radius:10px;padding:16px;text-align:center;">
      <div style="font-size:1.6rem;font-weight:700;color:${errTotal > 0 ? '#ef4444' : '#10b981'}">${errTotal}</div>
      <div style="font-size:.72rem;color:#94a3b8;margin-top:4px;">Fejl (4xx/5xx)</div></div>
  </div>
  <div style="font-size:.7rem;font-weight:600;letter-spacing:.1em;color:#64748b;text-transform:uppercase;margin-bottom:12px;">Routes — langsomst øverst</div>
  ${rows || '<div style="text-align:center;padding:60px;color:#64748b;">📊 Ingen data endnu — brug appen lidt og genindlæs</div>'}
</div></body></html>`;
}

export default async function handler(req, res) {
  // POST: gem måling (kaldt internt fra generate.js / login.js)
  if (req.method === 'POST') {
    const body = req.body || {};
    // Tjek at kaldet kommer fra appen selv (admin session)
    const sessionToken = req.headers['x-session-token'] || '';
    if (sessionToken !== ADMIN_PASS && !body.internal) {
      return res.status(401).json({ error: 'Ikke autoriseret' });
    }
    const { route, duration_ms, status_code } = body;
    if (route && duration_ms) {
      await saveMetric(route, duration_ms, status_code || 200);
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'Manglende felter' });
  }

  // GET: tjek admin session fra appen (sendt som header)
  const sessionToken = req.headers['x-session-token'] || req.query.token || '';
  if (sessionToken !== ADMIN_PASS) {
    // Vis redirect-side der henter token fra sessionStorage
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    return res.send(`<!DOCTYPE html><html><head><meta charset="UTF-8"><title>Performance</title>
<style>body{background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;}
.box{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:32px;width:300px;text-align:center;}
h2{color:#60a5fa;margin-bottom:12px;}p{color:#64748b;font-size:.85rem;margin-bottom:16px;}
a{color:#3b82f6;text-decoration:none;font-weight:600;}
</style></head>
<body><div class="box"><h2>⚡ Performance</h2>
<p>Du skal være logget ind som admin i appen for at se dette.</p>
<a href="/">← Gå til appen og log ind</a>
</div>
<script>
// Hvis admin allerede er logget ind i appen, videresend automatisk
const role = sessionStorage.getItem('authRole');
const pass = sessionStorage.getItem('adminPass');
if (role === 'admin' && pass) {
  window.location.href = '/api/perf?token=' + encodeURIComponent(pass);
}
</script>
</body></html>`);
  }

  // Vis dashboard
  const metrics = await getMetrics();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(buildDashboard(metrics));
}
