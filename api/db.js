const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();

    const { path, method = 'GET', body, headers: extraHeaders = {} } = req.body;

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
