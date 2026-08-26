const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

async function hashPassword(password) {
  const encoder = new TextEncoder();
  const salt = process.env.PASS_SALT || 'cyber2026salt';
  const data = encoder.encode(salt + password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
  const t = await r.text();
  return t ? JSON.parse(t) : [];
}

async function sbPatch(path, body) {
  await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { username, password } = req.body || {};
  const adminPass = process.env.ADMIN_PASS;

  // Admin login: intet brugernavn, kun adgangskode
  if (!username && password === adminPass) {
    return res.status(200).json({ role: 'admin', displayName: 'Admin' });
  }

  // Bruger login: brugernavn + adgangskode
  if (username && password) {
    try {
      const users = await sbGet(`users?username=eq.${encodeURIComponent(username)}&select=id,username,role,active,password_hash`);
      if (!users.length) return res.status(401).json({ error: 'Forkert brugernavn eller adgangskode' });
      const user = users[0];
      if (!user.active) return res.status(401).json({ error: 'Din konto er deaktiveret — kontakt admin' });
      const hash = await hashPassword(password);
      if (hash !== user.password_hash) return res.status(401).json({ error: 'Forkert brugernavn eller adgangskode' });
      await sbPatch(`users?id=eq.${user.id}`, { last_login: new Date().toISOString() });
      return res.status(200).json({ role: user.role, displayName: user.username, userId: user.id });
    } catch(e) {
      return res.status(500).json({ error: 'Serverfejl — prøv igen' });
    }
  }

  return res.status(401).json({ error: 'Forkert adgangskode' });
}
