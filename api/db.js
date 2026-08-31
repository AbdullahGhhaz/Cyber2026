async function verifySessionToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [payloadB64, sig] = token.split('.');
  const secret = process.env.SESSION_SECRET || '';
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expectedBuf = await crypto.subtle.sign('HMAC', key, enc.encode(payloadB64));
  const expected = Array.from(new Uint8Array(expectedBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
  if (expected.length !== sig.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return null;
  try {
    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload;
  } catch (e) { return null; }
}

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// Kun disse tabeller/metoder maa tilgaas fra klienten via denne proxy.
// 'users' og 'invite_tokens' haandteres udelukkende via api/login.js,
// som kraever admin-adgangskode for foelsomme handlinger.
const ALLOWED_TABLES = {
    documents: ['GET', 'POST', 'DELETE'],
    generated_content: ['GET', 'POST', 'DELETE'],
    quiz_questions: ['GET', 'POST', 'PATCH', 'DELETE'],
};

function isRequestAllowed(path, method) {
    if (typeof path !== 'string' || !path) return false;
    const table = path.split('?')[0];
    if (!/^[a-zA-Z_]+$/.test(table)) return false;
    const allowedMethods = ALLOWED_TABLES[table];
    if (!allowedMethods) return false;
    return allowedMethods.includes(method);
}

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    const { path, method = 'GET', body, headers: extraHeaders = {}, sessionToken } = req.body;

    const session = await verifySessionToken(sessionToken);
    if (!session) return res.status(401).json({ error: 'Login kraevet' });

    if (!isRequestAllowed(path, method)) {
            return res.status(403).json({ error: 'Ikke tilladt' });
    }

      // Kun 'Prefer' maa overstyres af klienten - resten af headers er faste.
      const safeHeaders = {};
      if (typeof extraHeaders.Prefer === 'string') safeHeaders.Prefer = extraHeaders.Prefer;

        try {
          const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
                  method,
                  headers: {
                            'apikey': SUPABASE_KEY,
                            'Authorization': `Bearer ${SUPABASE_KEY}`,
                            'Content-Type': 'application/json',
                            'Prefer': 'return=representation',
                            ...safeHeaders
                  },
                          body: body ? JSON.stringify(body) : undefined
          });

          const text = await r.text();
          res.status(r.status).json(text ? JSON.parse(text) : []);
    } catch (e) {
          res.status(500).json({ error: e.message });
    }
}
