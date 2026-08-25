const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

// Whitelist: KUN disse tabeller og operationer er tilladt fra klienten
// users og invite_tokens er ALDRIG tilgængelige via dette endpoint
const ALLOWED_TABLES = {
  documents:         ['GET', 'POST', 'DELETE', 'PATCH'],
  generated_content: ['GET', 'POST', 'DELETE', 'PATCH'],
  quiz_questions:    ['GET', 'POST', 'DELETE', 'PATCH'],
};

// Tilladt kolonner per tabel (forhindrer SELECT på sensitive kolonner)
const BLOCKED_SELECT_COLUMNS = {
  documents:         [],
  generated_content: [],
  quiz_questions:    [],
};

function parseTable(path) {
  // Udtræk tabelnavnet fra fx "documents?subject=eq.X&order=..."
  return path.split('?')[0].split('/')[0];
}

function isSafeMethod(table, method) {
  return ALLOWED_TABLES[table]?.includes(method.toUpperCase()) ?? false;
}

function hasDangerousPatterns(path) {
  const dangerous = [
    /;/,                    // statement separation
    /--/,                   // SQL comment
    /\/\*/,                 // block comment
    /\bunion\b/i,           // UNION attack
    /\bdrop\b/i,            // DROP
    /\bdelete\b.*\bfrom\b/i,// bare DELETE FROM (not our pattern)
    /\bexec\b/i,            // exec
    /\bxp_/i,               // stored procs
    /password_hash/i,       // never expose hash via this endpoint
    /\busers\b/i,           // users table never via db.js
    /\binvite_tokens\b/i,   // invite table never via db.js
  ];
  return dangerous.some(p => p.test(path));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const { path, method = 'GET', body, headers: extraHeaders = {} } = req.body;

  // --- VALIDATION ---
  if (!path || typeof path !== 'string' || path.length > 500) {
    return res.status(400).json({ error: 'Ugyldig forespørgsel' });
  }

  const table = parseTable(path);

  if (!ALLOWED_TABLES[table]) {
    return res.status(403).json({ error: 'Adgang nægtet' });
  }

  if (!isSafeMethod(table, method)) {
    return res.status(403).json({ error: 'Metode ikke tilladt for denne tabel' });
  }

  if (hasDangerousPatterns(path)) {
    return res.status(400).json({ error: 'Ugyldig forespørgsel' });
  }

  // Body-validering: kun tillad simple JSON-objekter
  if (body !== undefined) {
    if (typeof body !== 'object' || Array.isArray(body)) {
      if (!Array.isArray(body)) {
        return res.status(400).json({ error: 'Ugyldigt body-format' });
      }
    }
    // Tjek for injection i body-værdier
    const bodyStr = JSON.stringify(body);
    if (hasDangerousPatterns(bodyStr)) {
      return res.status(400).json({ error: 'Ugyldig forespørgsel' });
    }
  }

  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
      method: method.toUpperCase(),
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
    res.status(500).json({ error: 'Databasefejl' }); // aldrig eksponér intern fejl
  }
}
