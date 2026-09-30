// api/perf.js — Performance tracking middleware og dashboard
// Gemmer målinger i Supabase og serverer et dashboard på /_perf/

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const ADMIN_PASS = process.env.ADMIN_PASS;

// Ratings baseret på svartid
function rateMs(ms) {
  if (ms < 1000) return { score: 90, label: 'God', color: '#10b981', bar: 'bg-green' };
  if (ms < 3000) return { score: 65, label: 'Mangler', color: '#f59e0b', bar: 'bg-yellow' };
  if (ms < 8000) return { score: 35, label: 'Dårlig', color: '#ef4444', bar: 'bg-red' };
  return { score: 10, label: 'Kritisk', color: '#7c3aed', bar: 'bg-purple' };
}

// Kendte fixes per route
const FIXES = {
  '/api/generate': {
    summary: 'AI-generering er langsom',
    cause: 'Vercel Hobby-plan har 60s timeout. Store prompts tager lang tid.',
    fix: 'Brug streaming (sendt første byte hurtigt) og hold promptCap under 24k tegn.',
    how: 'Tjek at streaming er aktivt i generate.js og at maxDuration=300 er sat.'
  },
  '/api/login': {
    summary: 'Login er langsomt',
    cause: 'SHA-256 hashing + Supabase kald tager tid.',
    fix: 'Tjek Supabase region — EU-Central er tættest på DK.',
    how: 'Supabase Dashboard → Project Settings → Region'
  },
  '/api/db': {
    summary: 'Database-kald er langsomt',
    cause: 'For store SELECT forespørgsler eller manglende index.',
    fix: 'Tilføj index på hyppigt brugte kolonner (subject, filename).',
    how: 'Supabase → SQL Editor → CREATE INDEX idx_docs_subject ON documents(subject);'
  }
};

function getFix(route) {
  for (const [key, fix] of Object.entries(FIXES)) {
    if (route.includes(key)) return fix;
  }
  return {
    summary: 'Generel ydelse',
    cause: 'Ukendt årsag — kan være netværk, Supabase eller AI-kald.',
    fix: 'Tjek Vercel function logs for detaljer.',
    how: 'Vercel Dashboard → Deployments → Functions → Logs'
  };
}

async function saveMetric(route, ms, status) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/perf_metrics`, {
      method: 'POST',
      headers: {
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        route,
        duration_ms: ms,
        status_code: status,
        recorded_at: new Date().toISOString()
      })
    });
  } catch(e) {
    // Ignorer fejl i tracking — må ikke påvirke appen
  }
}

async function getMetrics() {
  try {
    const r = await fetch(
      `${SUPABASE_URL}/rest/v1/perf_metrics?select=route,duration_ms,status_code,recorded_at&order=recorded_at.desc&limit=500`,
      { headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` } }
    );
    return await r.json();
  } catch(e) { return []; }
}

function buildDashboard(metrics) {
  // Aggreger per route
  const routes = {};
  for (const m of metrics) {
    if (!routes[m.route]) routes[m.route] = { calls: 0, total: 0, errors: 0, worst: 0, best: Infinity };
    routes[m.route].calls++;
    routes[m.route].total += m.duration_ms;
    if (m.status_code >= 400) routes[m.route].errors++;
    if (m.duration_ms > routes[m.route].worst) routes[m.route].worst = m.duration_ms;
    if (m.duration_ms < routes[m.route].best) routes[m.route].best = m.duration_ms;
  }

  // Sorter efter gennemsnitstid (langsomst øverst)
  const sorted = Object.entries(routes)
    .map(([route, d]) => ({
      route,
      avg: Math.round(d.total / d.calls),
      calls: d.calls,
      errors: d.errors,
      worst: d.worst,
      best: d.best === Infinity ? 0 : d.best,
      ...rateMs(Math.round(d.total / d.calls))
    }))
    .sort((a, b) => a.score - b.score);

  const rows = sorted.map(r => {
    const fix = getFix(r.route);
    const errorPct = r.calls > 0 ? Math.round(r.errors / r.calls * 100) : 0;
    return `
    <div class="route-card" style="border-left:4px solid ${r.color}">
      <div class="route-header">
        <div>
          <span class="route-name">${r.route}</span>
          <span class="badge" style="background:${r.color}20;color:${r.color};border:1px solid ${r.color}40">${r.label}</span>
        </div>
        <div class="score" style="color:${r.color}">${r.score}</div>
      </div>
      <div class="route-stats">
        <span>⌀ ${r.avg}ms</span>
        <span>🔼 ${r.worst}ms</span>
        <span>🔽 ${r.best}ms</span>
        <span>📊 ${r.calls} kald</span>
        ${r.errors > 0 ? `<span style="color:#ef4444">❌ ${errorPct}% fejl</span>` : '<span style="color:#10b981">✓ Ingen fejl</span>'}
      </div>
      ${r.score < 75 ? `
      <div class="fix-box">
        <div class="fix-title">⚡ ${fix.summary}</div>
        <div class="fix-cause"><strong>Årsag:</strong> ${fix.cause}</div>
        <div class="fix-action"><strong>Fix:</strong> ${fix.fix}</div>
        <div class="fix-how"><strong>Sådan:</strong> ${fix.how}</div>
      </div>` : ''}
    </div>`;
  }).join('');

  const totalCalls = metrics.length;
  const avgAll = metrics.length ? Math.round(metrics.reduce((s, m) => s + m.duration_ms, 0) / metrics.length) : 0;
  const errorCount = metrics.filter(m => m.status_code >= 400).length;
  const overallScore = sorted.length ? Math.round(sorted.reduce((s, r) => s + r.score, 0) / sorted.length) : 100;
  const overallColor = overallScore >= 75 ? '#10b981' : overallScore >= 50 ? '#f59e0b' : '#ef4444';

  return `<!DOCTYPE html>
<html lang="da">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Cyber2026 — Performance</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f172a;color:#e2e8f0;min-height:100vh;}
header{background:#1e293b;border-bottom:1px solid #334155;padding:16px 24px;display:flex;align-items:center;justify-content:space-between;}
.logo{font-weight:700;font-size:1.1rem;color:#60a5fa;}
.logo span{color:#94a3b8;font-weight:400;font-size:.85rem;margin-left:8px;}
.overall{display:flex;align-items:center;gap:8px;}
.overall-score{font-size:2rem;font-weight:700;color:${overallColor};}
.overall-label{font-size:.75rem;color:#94a3b8;}
main{max-width:800px;margin:0 auto;padding:24px 16px;}
.stats-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:24px;}
.stat-card{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:16px;text-align:center;}
.stat-num{font-size:1.6rem;font-weight:700;color:#60a5fa;}
.stat-label{font-size:.72rem;color:#94a3b8;margin-top:4px;}
.section-title{font-size:.7rem;font-weight:600;letter-spacing:.1em;color:#64748b;text-transform:uppercase;margin-bottom:12px;}
.route-card{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:16px;margin-bottom:12px;}
.route-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px;}
.route-name{font-family:monospace;font-size:.85rem;color:#e2e8f0;margin-right:8px;}
.badge{font-size:.65rem;font-weight:600;padding:2px 8px;border-radius:20px;}
.score{font-size:1.5rem;font-weight:700;}
.route-stats{display:flex;flex-wrap:wrap;gap:12px;font-size:.75rem;color:#94a3b8;margin-bottom:8px;}
.fix-box{background:#0f172a;border:1px solid #334155;border-radius:8px;padding:12px;margin-top:10px;}
.fix-title{font-weight:600;color:#f59e0b;margin-bottom:6px;font-size:.82rem;}
.fix-cause,.fix-action,.fix-how{font-size:.78rem;color:#94a3b8;margin-top:4px;line-height:1.5;}
.fix-cause strong,.fix-action strong,.fix-how strong{color:#cbd5e1;}
.empty{text-align:center;padding:60px;color:#64748b;}
.refresh{background:#3b82f6;color:#fff;border:none;padding:8px 16px;border-radius:8px;cursor:pointer;font-size:.8rem;font-weight:600;}
.refresh:hover{background:#2563eb;}
footer{text-align:center;padding:24px;font-size:.72rem;color:#475569;}
</style>
</head>
<body>
<header>
  <div>
    <div class="logo">⚡ Cyber2026 <span>Performance Dashboard</span></div>
    <div style="font-size:.72rem;color:#64748b;margin-top:2px;">Sidst opdateret: ${new Date().toLocaleString('da-DK')}</div>
  </div>
  <div class="overall">
    <div>
      <div class="overall-score">${overallScore}</div>
      <div class="overall-label">Samlet score</div>
    </div>
    <button class="refresh" onclick="location.reload()">↻ Opdater</button>
  </div>
</header>
<main>
  <div class="stats-grid">
    <div class="stat-card"><div class="stat-num">${totalCalls}</div><div class="stat-label">Totale kald (seneste 500)</div></div>
    <div class="stat-card"><div class="stat-num">${avgAll}ms</div><div class="stat-label">Gennemsnitlig svartid</div></div>
    <div class="stat-card"><div class="stat-num" style="color:${errorCount > 0 ? '#ef4444' : '#10b981'}">${errorCount}</div><div class="stat-label">Fejl (4xx/5xx)</div></div>
  </div>
  <div class="section-title">Routes — langsomst øverst</div>
  ${rows || '<div class="empty">📊 Ingen data endnu — brug appen lidt og genindlæs</div>'}
</main>
<footer>Cyber2026 Performance · Kun synligt for admin · <a href="/" style="color:#60a5fa">← Tilbage til appen</a></footer>
</body>
</html>`;
}

export default async function handler(req, res) {
  // Tjek admin adgang
  const adminPass = req.headers['x-admin-pass'] || req.query.pass;
  if (!adminPass || adminPass !== ADMIN_PASS) {
    // Vis login-form
    return res.status(401).send(`<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>Performance</title>
<style>body{background:#0f172a;color:#e2e8f0;display:flex;align-items:center;justify-content:center;min-height:100vh;font-family:sans-serif;}
.box{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:32px;width:300px;text-align:center;}
h2{margin-bottom:16px;color:#60a5fa;}
input{width:100%;background:#0f172a;border:1px solid #334155;color:#e2e8f0;padding:10px;border-radius:8px;margin-bottom:12px;font-size:.9rem;}
button{width:100%;background:#3b82f6;color:#fff;border:none;padding:10px;border-radius:8px;cursor:pointer;font-weight:600;}
</style></head>
<body><div class="box">
<h2>⚡ Performance</h2>
<form method="GET">
<input type="password" name="pass" placeholder="Admin adgangskode" autofocus>
<button type="submit">Vis dashboard</button>
</form>
</div></body></html>`);
  }

  // POST: gem en måling
  if (req.method === 'POST') {
    const { route, duration_ms, status_code } = req.body || {};
    if (route && duration_ms) {
      await saveMetric(route, duration_ms, status_code || 200);
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'Manglende felter' });
  }

  // GET: vis dashboard
  const metrics = await getMetrics();
  const html = buildDashboard(metrics);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
}
