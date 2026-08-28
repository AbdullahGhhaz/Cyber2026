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

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    const { path, method = 'GET', body, headers: extraHeaders = {}, sessionToken } = req.body;

    const session = await verifySessionToken(sessionToken);
    if (!session) return res.status(401).json({ error: 'Login kraevet' });

        try {
          const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
                  method,
                  headers: {
                            'apikey': SUPABASE_KEY,
                            'Authorization': `Bearer ${SUPABASE_KEY}`,
                            'Content-Type': 'application/json',
                            'Prefer': 'return=representation',
                            ...extraHeaders
                  },
                          body: body ? JSON.stringify(body) : undefined
          });

          const text = await r.text();
          res.status(r.status).json(text ? JSON.parse(text) : []);
    } catch (e) {
          res.status(500).json({ error: e.message });
    }
}
