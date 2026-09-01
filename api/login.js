const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

const PBKDF2_ITERATIONS = 150000;

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.substr(i * 2, 2), 16);
  return bytes;
}

async function pbkdf2(password, salt, iterations) {
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, keyMaterial, 256);
  return new Uint8Array(bits);
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hashBytes = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${bytesToHex(salt)}$${bytesToHex(hashBytes)}`;
}

async function legacyHash(password) {
  const encoder = new TextEncoder();
  const salt = process.env.PASS_SALT || 'cyber2026salt';
  const data = encoder.encode(salt + password);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(hashBuffer));
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function verifyPassword(password, storedHash) {
  if (typeof storedHash === 'string' && storedHash.startsWith('pbkdf2$')) {
    const parts = storedHash.split('$');
    if (parts.length !== 4) return { valid: false };
    const iterations = parseInt(parts[1], 10);
    const salt = hexToBytes(parts[2]);
    const hashBytes = await pbkdf2(password, salt, iterations);
    return { valid: timingSafeEqual(bytesToHex(hashBytes), parts[3]), needsRehash: false };
  }
  const legacy = await legacyHash(password);
  const valid = timingSafeEqual(legacy, storedHash || '');
  return { valid, needsRehash: valid };
}

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
  return { ok: r.ok, data: t ? JSON.parse(t) : [] };
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

function generateToken() {
  const arr = new Uint8Array(32);
  crypto.getRandomValues(arr);
  return Array.from(arr).map(b => b.toString(16).padStart(2, '0')).join('');
}

function verifyAdmin(pw) {
  const adminPass = process.env.ADMIN_PASS;
  if (!adminPass || !pw || pw.length !== adminPass.length) return false;
  let diff = 0;
  for (let i = 0; i < adminPass.length; i++) diff |= pw.charCodeAt(i) ^ adminPass.charCodeAt(i);
  return diff === 0;
}

const MAX_ATTEMPTS = 5;
const LOCK_MINUTES = 15;

async function getAttempts(identifier) {
  const rows = await sbGet(`login_attempts?identifier=eq.${encodeURIComponent(identifier)}&select=attempts,locked_until`);
  return rows.length ? rows[0] : null;
}

function minutesLeft(lockedUntil) {
  return Math.max(1, Math.ceil((new Date(lockedUntil).getTime() - Date.now()) / 60000));
}

async function isLocked(identifier) {
  const row = await getAttempts(identifier);
  if (row && row.locked_until && new Date(row.locked_until) > new Date()) {
    return minutesLeft(row.locked_until);
  }
  return 0;
}

async function recordFailure(identifier) {
  const row = await getAttempts(identifier);
  const attempts = (row?.attempts || 0) + 1;
  const lockedUntil = attempts >= MAX_ATTEMPTS ? new Date(Date.now() + LOCK_MINUTES * 60000).toISOString() : (row?.locked_until || null);
  const payload = { identifier, attempts, locked_until: lockedUntil, updated_at: new Date().toISOString() };
  if (row) await sbPatch(`login_attempts?identifier=eq.${encodeURIComponent(identifier)}`, payload);
  else await sbPost('login_attempts', payload);
}

async function clearAttempts(identifier) {
  await sbPatch(`login_attempts?identifier=eq.${encodeURIComponent(identifier)}`, { attempts: 0, locked_until: null, updated_at: new Date().toISOString() });
}

async function hmacHex(payload) {
  const secret = process.env.SESSION_SECRET || '';
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(payload));
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function createSessionToken(uid, role, tokenVersion) {
  const exp = Date.now() + 14 * 24 * 3600000; // 14 dage
const payloadStr = JSON.stringify({ uid: uid || null, role, tv: tokenVersion || 0, exp });
  const payloadB64 = Buffer.from(payloadStr).toString('base64');
  const sig = await hmacHex(payloadB64);
  return `${payloadB64}.${sig}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();
  const body = req.body || {};
  const { action, username, password } = body;

if (action === 'checkInvite') {
  const { token } = body;
  if (!token || typeof token !== 'string' || token.length > 100) {
    return res.status(200).json({ valid: false, error: 'Ugyldigt token' });
  }
  const rows = await sbGet(`invite_tokens?token=eq.${encodeURIComponent(token)}&select=id,expires_at,used_at`);
  if (!rows.length) return res.status(200).json({ valid: false, error: 'Ukendt invitationslink' });
  if (rows[0].used_at) return res.status(200).json({ valid: false, error: 'Dette link er allerede brugt' });
  if (new Date(rows[0].expires_at) < new Date()) return res.status(200).json({ valid: false, error: 'Linket er udløbet' });
  return res.status(200).json({ valid: true });
}

if (action === 'register') {
  const { newUsername, newPassword, inviteToken } = body;
  if (!inviteToken) return res.status(403).json({ error: 'Invitationslink kræves' });
  const rows = await sbGet(`invite_tokens?token=eq.${encodeURIComponent(inviteToken)}&select=id,expires_at,used_at`);
  if (!rows.length || rows[0].used_at) return res.status(403).json({ error: 'Ugyldigt eller brugt invitationslink' });
  if (new Date(rows[0].expires_at) < new Date()) return res.status(403).json({ error: 'Invitationslinket er udløbet' });
  if (!newUsername || newUsername.length < 2 || newUsername.length > 30) return res.status(400).json({ error: 'Brugernavn skal være 2-30 tegn' });
  if (!newPassword || newPassword.length < 6 || newPassword.length > 26) return res.status(400).json({ error: 'Adgangskode skal være 6-26 tegn' });
  const existing = await sbGet(`users?username=eq.${encodeURIComponent(newUsername)}&select=id`);
  if (existing.length) return res.status(400).json({ error: 'Brugernavnet er allerede i brug' });
  const hash = await hashPassword(newPassword);
  const result = await sbPost('users', { username: newUsername, password_hash: hash, role: 'user' });
  if (!result.ok) return res.status(500).json({ error: 'Kunne ikke oprette bruger' });
  const user = result.data[0];
  await sbPatch(`invite_tokens?id=eq.${rows[0].id}`, { used_by: newUsername, used_at: new Date().toISOString() });
  await sbPatch(`users?id=eq.${user.id}`, { last_login: new Date().toISOString() });
  return res.status(200).json({ role: 'user', displayName: user.username, userId: user.id, sessionToken: await createSessionToken(user.id, 'user', 0) });
}

if (action) {
  const lockedMinutes = await isLocked('admin');
  if (lockedMinutes) return res.status(429).json({ error: `For mange forkerte forsøg — prøv igen om ${lockedMinutes} minut(ter)` });
  if (!verifyAdmin(body.adminPassword)) {
    await recordFailure('admin');
    return res.status(401).json({ error: 'Ikke autoriseret' });
  }
  await clearAttempts('admin');

  if (action === 'list') {
    const users = await sbGet('users?select=id,username,role,active,created_at,last_login&order=created_at.asc');
    return res.status(200).json({ users });
  }
  if (action === 'create') {
    const { newUsername, newPassword, role } = body;
    if (!newUsername || newUsername.length < 2 || newUsername.length > 30) return res.status(400).json({ error: 'Brugernavn skal være 2-30 tegn' });
    if (!newPassword || newPassword.length < 6 || newPassword.length > 26) return res.status(400).json({ error: 'Adgangskode skal være 6-26 tegn' });
    const userRole = role === 'admin' ? 'admin' : 'user';
    const existing = await sbGet(`users?username=eq.${encodeURIComponent(newUsername)}&select=id`);
    if (existing.length) return res.status(400).json({ error: 'Brugernavnet er allerede i brug' });
    const hash = await hashPassword(newPassword);
    const result = await sbPost('users', { username: newUsername, password_hash: hash, role: userRole });
    if (!result.ok) return res.status(500).json({ error: 'Kunne ikke oprette bruger' });
    return res.status(200).json({ success: true });
}
  if (action === 'createInvite') {
    const hours = Math.min(parseInt(body.expiresHours) || 48, 168);
    const token = generateToken();
    const expiresAt = new Date(Date.now() + hours * 3600000).toISOString();
    const result = await sbPost('invite_tokens', { token, expires_at: expiresAt });
    if (!result.ok) return res.status(500).json({ error: 'Kunne ikke generere link' });
    return res.status(200).json({ token, expiresAt });
  }
  if (action === 'listInvites') {
    const invites = await sbGet('invite_tokens?select=id,token,used_by,used_at,expires_at,created_at&order=created_at.desc&limit=20');
    return res.status(200).json({ invites });
  }
  if (action === 'deleteInvite') {
    if (!body.inviteId) return res.status(400).json({ error: 'Mangler invite ID' });
    await sbDelete(`invite_tokens?id=eq.${encodeURIComponent(body.inviteId)}`);
    return res.status(200).json({ success: true });
  }
  if (action === 'toggle') {
    if (!body.userId) return res.status(400).json({ error: 'Mangler bruger ID' });
    await sbPatch(`users?id=eq.${encodeURIComponent(body.userId)}`, { active: body.active === true, token_version: Date.now() });
    return res.status(200).json({ success: true });
  }
  if (action === 'delete') {
    if (!body.userId) return res.status(400).json({ error: 'Mangler bruger ID' });
    await sbDelete(`users?id=eq.${encodeURIComponent(body.userId)}`);
    return res.status(200).json({ success: true });
  }
  if (action === 'changePassword') {
    if (!body.userId || !body.newPassword) return res.status(400).json({ error: 'Mangler data' });
    if (body.newPassword.length < 6 || body.newPassword.length > 26) return res.status(400).json({ error: 'Adgangskode skal være 6-26 tegn' });
    const hash = await hashPassword(body.newPassword);
    await sbPatch(`users?id=eq.${encodeURIComponent(body.userId)}`, { password_hash: hash, token_version: Date.now() });
    return res.status(200).json({ success: true });
  }
  return res.status(400).json({ error: 'Ukendt handling' });
}

const adminPass = process.env.ADMIN_PASS;
  if (!username && password) {
    const lockedMinutes = await isLocked('admin');
    if (lockedMinutes) return res.status(429).json({ error: `For mange forkerte forsøg — prøv igen om ${lockedMinutes} minut(ter)` });
    if (verifyAdmin(password)) {
      await clearAttempts('admin');
      return res.status(200).json({ role: 'admin', displayName: 'Admin', sessionToken: await createSessionToken(null, 'admin', 0) });
    }
    await recordFailure('admin');
    return res.status(401).json({ error: 'Forkert adgangskode' });
  }
  if (username && password) {
    try {
      const identifier = `user:${username.toLowerCase()}`;
      const lockedMinutes = await isLocked(identifier);
      if (lockedMinutes) return res.status(429).json({ error: `For mange forkerte forsøg — prøv igen om ${lockedMinutes} minut(ter)` });
      const users = await sbGet(`users?username=eq.${encodeURIComponent(username)}&select=id,username,role,active,password_hash,token_version`);
      if (!users.length) {
        await recordFailure(identifier);
        return res.status(401).json({ error: 'Forkert brugernavn eller adgangskode' });
      }
      const user = users[0];
      if (!user.active) return res.status(401).json({ error: 'Din konto er deaktiveret — kontakt admin' });
      const { valid, needsRehash } = await verifyPassword(password, user.password_hash);
      if (!valid) {
        await recordFailure(identifier);
        return res.status(401).json({ error: 'Forkert brugernavn eller adgangskode' });
      }
      await clearAttempts(identifier);
      const patchBody = { last_login: new Date().toISOString() };
      if (needsRehash) patchBody.password_hash = await hashPassword(password);
      await sbPatch(`users?id=eq.${user.id}`, patchBody);
      return res.status(200).json({ role: user.role, displayName: user.username, userId: user.id, sessionToken: await createSessionToken(user.id, user.role, user.token_version || 0) });
    } catch(e) {
      return res.status(500).json({ error: 'Serverfejl — prøv igen' });
    }
  }
  return res.status(401).json({ error: 'Forkert adgangskode' });
}
