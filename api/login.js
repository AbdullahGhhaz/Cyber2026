const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// ── Simple in-memory rate limiter (pr. Vercel-instans) ─────
const loginAttempts = new Map();
const RATE_WINDOW_MS = 15 * 60 * 1000; // 15 minutter
const MAX_ATTEMPTS   = 10;

function getRateKey(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
}

function isRateLimited(key) {
  const now = Date.now();
  const entry = loginAttempts.get(key) || { count: 0, first: now };
  if (now - entry.first > RATE_WINDOW_MS) {
    loginAttempts.set(key, { count: 1, first: now });
    return false;
  }
  if (entry.count >= MAX_ATTEMPTS) return true;
  loginAttempts.set(key, { count: entry.count + 1, first: entry.first });
  return false;
}

// ── Input validering ───────────────────────────────────────
const USERNAME_RE = /^[a-zA-Z0-9æøåÆØÅ_\-\.]{2,30}$/;
const DANGEROUS_RE = /[<>"'`;\\]|--|\/\*|\bunion\b|\bdrop\b|\bexec\b/i;

function validateUsername(u) {
  if (!u || typeof u !== 'string') return 'Brugernavn mangler';
  if (!USERNAME_RE.test(u)) return 'Brugernavn må kun indeholde bogstaver, tal, _ - og . (2-30 tegn)';
  if (DANGEROUS_RE.test(u)) return 'Ugyldigt brugernavn';
  return null;
}

function validatePassword(p) {
  if (!p || typeof p !== 'string') return 'Adgangskode mangler';
  if (p.length < 6) return 'Adgangskode skal være mindst 6 tegn';
  if (p.length > 26) return 'Adgangskode må maks være 26 tegn';
  if (DANGEROUS_RE.test(p)) return 'Ugyldige tegn i adgangskode';
  return null;
}

// ── Supabase helpers ───────────────────────────────────────
async function sbGet(path) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
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
  return { ok: r.ok, status: r.status, data: t ? JSON.parse(t) : [] };
}

async function sbPatch(path, body) {
  await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'PATCH',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function sbDelete(path) {
  await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method: 'DELETE',
    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
  });
}

async function hashPassword(password) {
  const encoder = new TextEncoder();
  const salt = process.env.PASS_SALT || 'cyber2026salt';
  const data = encoder.encode(salt + password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

function generateToken() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Verificer admin-adgangskode ────────────────────────────
function verifyAdmin(adminPassword) {
  const adminPass = process.env.ADMIN_PASS;
  if (!adminPass || !adminPassword) return false;
  // Konstant-tid sammenligning for at forhindre timing-angreb
  if (adminPassword.length !== adminPass.length) return false;
  let diff = 0;
  for (let i = 0; i < adminPass.length; i++) {
    diff |= adminPassword.charCodeAt(i) ^ adminPass.charCodeAt(i);
  }
  return diff === 0;
}

// ── HANDLER ────────────────────────────────────────────────
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // Sanitér body — kun objekter tilladt
  const body = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return res.status(400).json({ error: 'Ugyldig forespørgsel' });
  }

  const { action } = body;

  // ── TJEK INVITE-TOKEN (offentligt endpoint) ─────────────
  if (action === 'checkInvite') {
    const { token } = body;
    if (!token || typeof token !== 'string' || token.length > 100) {
      return res.status(400).json({ valid: false, error: 'Ugyldigt token' });
    }
    const tokens = await sbGet(`invite_tokens?token=eq.${encodeURIComponent(token)}&select=id,expires_at,used_at`);
    if (!tokens.length) return res.status(200).json({ valid: false, error: 'Ukendt invitationslink' });
    const inv = tokens[0];
    if (inv.used_at) return res.status(200).json({ valid: false, error: 'Dette link er allerede brugt' });
    if (new Date(inv.expires_at) < new Date()) return res.status(200).json({ valid: false, error: 'Invitationslinket er udløbet' });
    return res.status(200).json({ valid: true });
  }

  // ── REGISTRERING via invite-token ───────────────────────
  if (action === 'register') {
    const rateKey = getRateKey(req);
    if (isRateLimited(rateKey)) return res.status(429).json({ error: 'For mange forsøg — prøv igen om 15 minutter' });

    const { newUsername, newPassword, inviteToken } = body;

    // Valider invite-token
    if (!inviteToken || typeof inviteToken !== 'string') {
      return res.status(403).json({ error: 'Invitationslink kræves for at oprette konto' });
    }
    const tokens = await sbGet(`invite_tokens?token=eq.${encodeURIComponent(inviteToken)}&select=id,expires_at,used_at`);
    if (!tokens.length) return res.status(403).json({ error: 'Ugyldigt invitationslink' });
    const inv = tokens[0];
    if (inv.used_at) return res.status(403).json({ error: 'Dette link er allerede brugt' });
    if (new Date(inv.expires_at) < new Date()) return res.status(403).json({ error: 'Invitationslinket er udløbet' });

    // Valider input
    const uErr = validateUsername(newUsername);
    if (uErr) return res.status(400).json({ error: uErr });
    const pErr = validatePassword(newPassword);
    if (pErr) return res.status(400).json({ error: pErr });

    // Tjek unikt brugernavn
    const existing = await sbGet(`users?username=eq.${encodeURIComponent(newUsername)}&select=id`);
    if (existing.length > 0) return res.status(400).json({ error: 'Brugernavnet er allerede i brug — vælg et andet' });

    const hash = await hashPassword(newPassword);
    const result = await sbPost('users', { username: newUsername, password_hash: hash, role: 'user' });
    if (!result.ok) return res.status(400).json({ error: 'Kunne ikke oprette bruger — prøv igen' });

    const user = result.data[0];

    // Markér token som brugt
    await sbPatch(`invite_tokens?id=eq.${inv.id}`, {
      used_by: newUsername,
      used_at: new Date().toISOString()
    });

    await sbPatch(`users?id=eq.${user.id}`, { last_login: new Date().toISOString() });
    return res.status(200).json({ success: true, role: 'user', displayName: user.username, userId: user.id });
  }

  // ── ADMIN ACTIONS ────────────────────────────────────────
  if (action) {
    const { adminPassword } = body;
    if (!verifyAdmin(adminPassword)) {
      return res.status(401).json({ error: 'Ikke autoriseret' });
    }

    if (action === 'list') {
      const users = await sbGet('users?select=id,username,role,active,created_at,last_login&order=created_at.asc');
      return res.status(200).json({ users });
    }

    if (action === 'create') {
      const { newUsername, newPassword, role } = body;
      const uErr = validateUsername(newUsername);
      if (uErr) return res.status(400).json({ error: uErr });
      const pErr = validatePassword(newPassword);
      if (pErr) return res.status(400).json({ error: pErr });
      if (!['user','admin'].includes(role)) return res.status(400).json({ error: 'Ugyldig rolle' });
      const existing = await sbGet(`users?username=eq.${encodeURIComponent(newUsername)}&select=id`);
      if (existing.length > 0) return res.status(400).json({ error: 'Brugernavnet er allerede i brug' });
      const hash = await hashPassword(newPassword);
      const result = await sbPost('users', { username: newUsername, password_hash: hash, role });
      if (!result.ok) return res.status(400).json({ error: 'Kunne ikke oprette bruger' });
      return res.status(200).json({ success: true, user: result.data[0] });
    }

    if (action === 'toggle') {
      const { userId } = body;
      if (!userId || typeof userId !== 'string') return res.status(400).json({ error: 'Ugyldigt bruger-ID' });
      await sbPatch(`users?id=eq.${encodeURIComponent(userId)}`, { active: body.active === true });
      return res.status(200).json({ success: true });
    }

    if (action === 'delete') {
      const { userId } = body;
      if (!userId || typeof userId !== 'string') return res.status(400).json({ error: 'Ugyldigt bruger-ID' });
      await sbDelete(`users?id=eq.${encodeURIComponent(userId)}`);
      return res.status(200).json({ success: true });
    }

    if (action === 'changePassword') {
      const { userId, newPassword } = body;
      if (!userId || typeof userId !== 'string') return res.status(400).json({ error: 'Ugyldigt bruger-ID' });
      const pErr = validatePassword(newPassword);
      if (pErr) return res.status(400).json({ error: pErr });
      const hash = await hashPassword(newPassword);
      await sbPatch(`users?id=eq.${encodeURIComponent(userId)}`, { password_hash: hash });
      return res.status(200).json({ success: true });
    }

    // Generer invite-link
    if (action === 'createInvite') {
      const { expiresHours = 48 } = body;
      const token = generateToken();
      const expiresAt = new Date(Date.now() + Math.min(expiresHours, 168) * 60 * 60 * 1000).toISOString();
      const result = await sbPost('invite_tokens', { token, expires_at: expiresAt });
      if (!result.ok) return res.status(500).json({ error: 'Kunne ikke generere link' });
      return res.status(200).json({ success: true, token, expiresAt });
    }

    // Hent alle invite-links
    if (action === 'listInvites') {
      const invites = await sbGet('invite_tokens?select=id,token,used_by,used_at,expires_at,created_at&order=created_at.desc&limit=20');
      return res.status(200).json({ invites });
    }

    // Slet invite-link
    if (action === 'deleteInvite') {
      const { inviteId } = body;
      if (!inviteId || typeof inviteId !== 'string') return res.status(400).json({ error: 'Ugyldigt invite-ID' });
      await sbDelete(`invite_tokens?id=eq.${encodeURIComponent(inviteId)}`);
      return res.status(200).json({ success: true });
    }

    return res.status(400).json({ error: 'Ukendt handling' });
  }

  // ── NORMAL LOGIN ─────────────────────────────────────────
  const rateKey = getRateKey(req);
  if (isRateLimited(rateKey)) {
    return res.status(429).json({ error: 'For mange loginforsøg — prøv igen om 15 minutter' });
  }

  const { username, password } = body;
  const adminPass = process.env.ADMIN_PASS;

  // Admin login
  if (!username && password) {
    if (verifyAdmin(password)) {
      return res.status(200).json({ role: 'admin', displayName: 'Admin' });
    }
    return res.status(401).json({ error: 'Forkert adgangskode' });
  }

  // Bruger-login
  if (username) {
    const uErr = validateUsername(username);
    if (uErr) return res.status(401).json({ error: 'Forkert brugernavn eller adgangskode' });

    const users = await sbGet(`users?username=eq.${encodeURIComponent(username)}&select=id,username,role,active,password_hash`);
    if (!users.length) {
      // Konstant-tid svar for at forhindre user enumeration
      await hashPassword('dummy_constant_time');
      return res.status(401).json({ error: 'Forkert brugernavn eller adgangskode' });
    }
    const user = users[0];
    if (!user.active) return res.status(401).json({ error: 'Din konto er deaktiveret — kontakt admin' });

    const hash = await hashPassword(password || '');
    if (hash !== user.password_hash) return res.status(401).json({ error: 'Forkert brugernavn eller adgangskode' });

    await sbPatch(`users?id=eq.${user.id}`, { last_login: new Date().toISOString() });
    return res.status(200).json({ role: user.role, displayName: user.username, userId: user.id });
  }

  return res.status(401).json({ error: 'Forkert adgangskode' });
}
