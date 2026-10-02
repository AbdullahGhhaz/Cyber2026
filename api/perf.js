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

  return `<div style="font-family:-apple-system,sans-serif;">
    <div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:20px;">
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px;text-align:center;">
        <div style="font-size:1.5rem;font-weight:700;color:var(--accent2);">${total}</div>
        <div style="font-size:.7rem;color:var(--text2);margin-top:3px;">Totale kald</div></div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px;text-align:center;">
        <div style="font-size:1.5rem;font-weight:700;color:var(--accent2);">${avgAll}ms</div>
        <div style="font-size:.7rem;color:var(--text2);margin-top:3px;">Gns. svartid</div></div>
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:14px;text-align:center;">
        <div style="font-size:1.5rem;font-weight:700;color:${errTotal > 0 ? 'var(--danger)' : 'var(--success)'};">${errTotal}</div>
        <div style="font-size:.7rem;color:var(--text2);margin-top:3px;">Fejl</div></div>
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">
      <div style="font-size:.7rem;font-weight:600;letter-spacing:.1em;color:var(--muted);text-transform:uppercase;">Routes — langsomst øverst</div>
      <div style="font-size:.75rem;color:var(--text2);">Samlet score: <strong style="color:${oc}">${overall}</strong></div>
    </div>
    ${rows || '<div class="empty-docs">Ingen data endnu — brug appen lidt og klik Opdater</div>'}
    <button onclick="loadPerfData()" style="margin-top:12px;width:100%;background:var(--accent);border:none;color:#fff;padding:8px;border-radius:8px;cursor:pointer;font-size:.8rem;font-weight:600;">↻ Opdater</button>
  </div>`;
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

  // GET: tjek admin session
  const sessionToken = req.headers['x-session-token'] || '';
  if (sessionToken !== ADMIN_PASS) {
    return res.status(401).json({ error: 'Ikke autoriseret' });
  }

  // Returner kun indhold-delen (til panel i appen)
  const metrics = await getMetrics();
  const html = buildDashboard(metrics);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.send(html);
}
