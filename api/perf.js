const ADMIN_PASS = process.env.ADMIN_PASS;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

export const config = { maxDuration: 30 };

function getSessionToken() {
  return Buffer.from(ADMIN_PASS + '-perf').toString('base64').slice(0, 24);
}

function isLoggedIn(req) {
  const cookies = req.headers.cookie || '';
  const match = cookies.match(/perf_auth=([^;]+)/);
  if (match && match[1] === getSessionToken()) return true;
  // Tjek også Authorization header som fallback
  const auth = req.headers['authorization'] || '';
  return auth === `Bearer ${getSessionToken()}`;
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

async function getMetrics() {
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/perf_metrics?select=route,duration_ms,status_code,recorded_at&order=recorded_at.desc&limit=500`, {
      headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
    });
    return await r.json();
  } catch(e) { return []; }
}

function rate(ms) {
  if (ms < 1000) return { score: 90, label: 'God', color: '#10b981' };
  if (ms < 3000) return { score: 65, label: 'Mangler', color: '#f59e0b' };
  if (ms < 8000) return { score: 35, label: 'Dårlig', color: '#ef4444' };
  return { score: 10, label: 'Kritisk', color: '#7c3aed' };
}

const FIXES = {
  '/api/generate': { cause: 'Store prompts + Vercel Hobby timeout', fix: 'Streaming er aktivt — tjek promptCap holdes under 24k tegn per fil.' },
  '/api/login': { cause: 'SHA-256 hashing + Supabase kald', fix: 'Normalt. Brug Supabase EU-Central region for hurtigste svar.' },
  '/api/db': { cause: 'Stor SELECT forespørgsel', fix: 'Tilføj index: CREATE INDEX ON documents(subject);' },
};

function getFix(route) {
  for (const [k, v] of Object.entries(FIXES)) {
    if (route.includes(k)) return v;
  }
  return { cause: 'Ukendt — tjek Vercel function logs', fix: 'Vercel Dashboard → Deployments → Functions → Logs' };
}

function dashboard(metrics) {
  const byRoute = {};
  for (const m of metrics) {
    if (!byRoute[m.route]) byRoute[m.route] = [];
    byRoute[m.route].push(m);
  }
  const rows = Object.entries(byRoute)
    .map(([route, arr]) => {
      const avg = Math.round(arr.reduce((s, m) => s + m.duration_ms, 0) / arr.length);
      const worst = Math.max(...arr.map(m => m.duration_ms));
      const errors = arr.filter(m => m.status_code >= 400).length;
      const r = rate(avg);
      const fix = getFix(route);
      return { route, avg, worst, calls: arr.length, errors, ...r };
    })
    .sort((a, b) => a.score - b.score);

  const total = metrics.length;
  const avgAll = total ? Math.round(metrics.reduce((s, m) => s + m.duration_ms, 0) / total) : 0;
  const errTotal = metrics.filter(m => m.status_code >= 400).length;
  const overall = rows.length ? Math.round(rows.reduce((s, r) => s + r.score, 0) / rows.length) : 100;
  const oc = overall >= 75 ? '#10b981' : overall >= 50 ? '#f59e0b' : '#ef4444';

  const routeCards = rows.map(r => {
    const fix = getFix(r.route);
    return `<div style="background:#1e293b;border:1px solid #334155;border-left:4px solid ${r.color};border-radius:10px;padding:16px;margin-bottom:12px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">
        <div>
          <code style="color:#e2e8f0;font-size:.85rem;">${r.route}</code>
          <span style="margin-left:8px;font-size:.65rem;font-weight:600;padding:2px 8px;border-radius:20px;background:${r.color}20;color:${r.color};border:1px solid ${r.color}40">${r.label}</span>
        </div>
        <div style="font-size:1.8rem;font-weight:700;color:${r.color}">${r.score}</div>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:12px;font-size:.75rem;color:#94a3b8;margin-bottom:${r.score < 75 ? '10px' : '0'};">
        <span>⌀ ${r.avg}ms</span><span>🔼 ${r.worst}ms</span><span>📊 ${r.calls} kald</span>
        <span style="color:${r.errors > 0 ? '#ef4444' : '#10b981'}">${r.errors > 0 ? '❌ ' + r.errors + ' fejl' : '✓ Ingen fejl'}</span>
      </div>
      ${r.score < 75 ? `<div style="background:#0f172a;border:1px solid #334155;border-radius:8px;padding:10px;font-size:.78rem;">
        <div style="color:#f59e0b;font-weight:600;margin-bottom:4px;">⚡ Fix</div>
        <div style="color:#94a3b8;"><strong style="color:#cbd5e1;">Årsag:</strong> ${fix.cause}</div>
        <div style="color:#94a3b8;margin-top:4px;"><strong style="color:#cbd5e1;">Løsning:</strong> ${fix.fix}</div>
      </div>` : ''}
    </div>`;
  }).join('');

  return `<!DOCTYPE html><html lang="da"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cyber2026 Performance</title>
<style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:-apple-system,sans-serif;background:#0f172a;color:#e2e8f0;}</style>
</head><body>
<div style="background:#1e293b;border-bottom:1px solid #334155;padding:16px 24px;display:flex;justify-content:space-between;align-items:center;">
  <div><div style="font-weight:700;color:#60a5fa;font-size:1.1rem;">⚡ Cyber2026 Performance</div>
  <div style="font-size:.72rem;color:#64748b;margin-top:2px;">${new Date().toLocaleString('da-DK')}</div></div>
  <div style="display:flex;align-items:center;gap:12px;">
    <div style="text-align:center"><div style="font-size:2rem;font-weight:700;color:${oc}">${overall}</div><div style="font-size:.7rem;color:#64748b;">samlet score</div></div>
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
      <div style="font-size:1.6rem;font-weight:700;color:${errTotal > 0 ? '#ef4444' : '#10b981'}">${errTotal}</div><div style="font-size:.72rem;color:#94a3b8;margin-top:4px;">Fejl (4xx/5xx)</div></div>
  </div>
  <div style="font-size:.7rem;font-weight:600;letter-spacing:.1em;color:#64748b;text-transform:uppercase;margin-bottom:12px;">Routes — langsomst øverst</div>
  ${routeCards || '<div style="text-align:center;padding:60px;color:#64748b;">📊 Ingen data endnu — brug appen lidt og genindlæs</div>'}
</div></body></html>`;
}

const LOGIN_PAGE = `<!DOCTYPE html><html lang="da"><head><meta charset="UTF-8"><title>Performance</title>
<style>*{box-sizing:border-box;}body{background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;margin:0;}
.box{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:32px;width:300px;text-align:center;}
h2{margin-bottom:8px;color:#60a5fa;}p{font-size:.8rem;color:#64748b;margin-bottom:20px;}
input{width:100%;background:#0f172a;border:1px solid #334155;color:#e2e8f0;padding:10px;border-radius:8px;margin-bottom:12px;font-size:.9rem;outline:none;}
button{width:100%;background:#3b82f6;color:#fff;border:none;padding:10px;border-radius:8px;cursor:pointer;font-weight:600;}
.err{color:#ef4444;font-size:.8rem;margin-bottom:8px;display:none;}
</style></head>
<body><div class="box"><h2>⚡ Performance</h2><p>Kun for admin</p>
<div class="err" id="err">Forkert adgangskode</div>
<input type="password" id="pw" placeholder="Admin adgangskode" autofocus autocomplete="current-password">
<button onclick="doLogin()">Log ind</button>
<script>
document.getElementById('pw').addEventListener('keydown',function(e){if(e.key==='Enter')doLogin();});
async function doLogin(){
  const pw=document.getElementById('pw').value;
  if(!pw)return;
  const r=await fetch('/api/perf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pass:pw})});
  if(r.ok){const d=await r.json();if(d.ok){document.cookie='perf_auth='+d.token+';path=/api/perf;max-age=3600';location.reload();}else{document.getElementById('err').style.display='block';document.getElementById('pw').value='';}}
  else{document.getElementById('err').style.display='block';document.getElementById('pw').value='';}
}
</script>
</div></body></html>`;

export default async function handler(req, res) {
  // POST: enten login eller gem måling
  if (req.method === 'POST') {
    const body = req.body || {};

    // Login formular
    if ('pass' in body) {
      if (body.pass === ADMIN_PASS) {
        return res.status(200).json({ ok: true, token: getSessionToken() });
      }
      return res.status(401).json({ ok: false, error: 'Forkert adgangskode' });
    }

    // Gem måling (fra appen)
    if (!isLoggedIn(req) && req.headers['x-internal'] !== process.env.SUPABASE_KEY?.slice(0, 10)) {
      return res.status(401).json({ error: 'Ikke autoriseret' });
    }
    const { route, duration_ms, status_code } = body;
    if (route && duration_ms) {
      await saveMetric(route, duration_ms, status_code || 200);
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'Manglende felter' });
  }

  // GET: vis dashboard eller login
  if (!isLoggedIn(req)) {
    return res.status(200).send(LOGIN_PAGE);
  }

  const metrics = await getMetrics();
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(dashboard(metrics));
}
