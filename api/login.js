const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' }
  });
  const t = await r.text();
  return t ? JSON.parse(t) : [];
}

async function sbPost(path, body) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'POST',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json', 'Prefer': 'return=representation' },
    body: JSON.stringify(body)
  });
  const t = await r.text();
  return { ok: r.ok, data: t ? JSON.parse(t) : [] };
}

async function sbPatch(path, body) {
  await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function hashPassword(password) {
  const encoder = new TextEncoder();
  const salt = process.env.PASS_SALT || 'cyber2026salt';
  const data = encoder.encode(salt + password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { username, password, action } = req.body;

  // --- SELV-REGISTRERING (ingen admin nødvendig) ---
  if (action === 'register') {
    const { newUsername, newPassword } = req.body;
    if (!newUsername || !newPassword) return res.status(400).json({ error: 'Brugernavn og adgangskode kræves' });
    if (newUsername.length < 2) return res.status(400).json({ error: 'Brugernavn skal være mindst 2 tegn' });
    if (newPassword.length < 4) return res.status(400).json({ error: 'Adgangskode skal være mindst 4 tegn' });

    // Tjek om brugernavn er ledigt
    const existing = await sbGet(`users?username=eq.${encodeURIComponent(newUsername)}&select=id`);
    if (existing.length > 0) return res.status(400).json({ error: 'Brugernavnet er allerede i brug — vælg et andet' });

    const hash = await hashPassword(newPassword);
    const result = await sbPost('users', { username: newUsername, password_hash: hash, role: 'user' });
    if (!result.ok) return res.status(400).json({ error: 'Kunne ikke oprette bruger — prøv igen' });

    const user = result.data[0];
    // Log ind med det samme efter registrering
    await sbPatch(`users?id=eq.${user.id}`, { last_login: new Date().toISOString() });
    return res.status(200).json({ success: true, role: 'user', displayName: user.username, userId: user.id });
  }

  // --- ADMIN ACTIONS ---
  if (action) {
    const adminPass = process.env.ADMIN_PASS;
    const { adminPassword } = req.body;
    if (adminPassword !== adminPass) return res.status(401).json({ error: 'Ikke autoriseret' });

    if (action === 'list') {
      const users = await sbGet('users?select=id,username,role,active,created_at,last_login&order=created_at.asc');
      return res.status(200).json({ users });
    }

    if (action === 'create') {
      const { newUsername, newPassword, role } = req.body;
      if (!newUsername || !newPassword) return res.status(400).json({ error: 'Brugernavn og adgangskode kræves' });
      const existing = await sbGet(`users?username=eq.${encodeURIComponent(newUsername)}&select=id`);
      if (existing.length > 0) return res.status(400).json({ error: 'Brugernavnet er allerede i brug' });
      const hash = await hashPassword(newPassword);
      const result = await sbPost('users', { username: newUsername, password_hash: hash, role: role || 'user' });
      if (!result.ok) return res.status(400).json({ error: 'Kunne ikke oprette bruger' });
      return res.status(200).json({ success: true, user: result.data[0] });
    }

    if (action === 'toggle') {
      const { userId, active } = req.body;
      await sbPatch(`users?id=eq.${userId}`, { active });
      return res.status(200).json({ success: true });
    }

    if (action === 'delete') {
      const { userId } = req.body;
      await fetch(`${SUPABASE_URL}/rest/v1/users?id=eq.${userId}`, {
        method: 'DELETE',
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      });
      return res.status(200).json({ success: true });
    }

    if (action === 'changePassword') {
      const { userId, newPassword } = req.body;
      if (!newPassword || newPassword.length < 4) return res.status(400).json({ error: 'Adgangskode skal være mindst 4 tegn' });
      const hash = await hashPassword(newPassword);
      await sbPatch(`users?id=eq.${userId}`, { password_hash: hash });
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Ukendt handling' });
  }

  // --- NORMAL LOGIN ---
  const adminPass = process.env.ADMIN_PASS;
  if (!username && password === adminPass) {
    return res.status(200).json({ role: 'admin', displayName: 'Admin' });
  }
  if (username) {
    const users = await sbGet(`users?username=eq.${encodeURIComponent(username)}&select=id,username,role,active,password_hash`);
    if (!users.length) return res.status(401).json({ error: 'Forkert brugernavn eller adgangskode' });
    const user = users[0];
    if (!user.active) return res.status(401).json({ error: 'Din konto er deaktiveret — kontakt admin' });
    const hash = await hashPassword(password);
    if (hash !== user.password_hash) return res.status(401).json({ error: 'Forkert brugernavn eller adgangskode' });
    await sbPatch(`users?id=eq.${user.id}`, { last_login: new Date().toISOString() });
    return res.status(200).json({ role: user.role, displayName: user.username, userId: user.id });
  }

  return res.status(401).json({ error: 'Forkert adgangskode' });
}
