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

export const config = {
  api: { bodyParser: { sizeLimit: '50mb' } }
};

async function callClaude(system, prompt, maxTokens = 2048) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-5',
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.content?.map(b => b.text || '').join('') || '';
}

function parseQuestions(text) {
  try {
    const clean = text.replace(/```json|```/g, '').trim();
    return JSON.parse(clean);
  } catch(e) {
    const match = text.match(/\[[\s\S]*\]/);
    if (match) {
      try { return JSON.parse(match[0]); } catch(e2) { return []; }
    }
    return [];
  }
}

function validateQuestion(q) {
  return q &&
    typeof q.question === 'string' && q.question.trim().length > 5 &&
    typeof q.a === 'string' && q.a.trim() &&
    typeof q.b === 'string' && q.b.trim() &&
    typeof q.c === 'string' && q.c.trim() &&
    typeof q.d === 'string' && q.d.trim() &&
    q.correct && ['a','b','c','d'].includes(String(q.correct).toLowerCase()) &&
    typeof q.explanation === 'string' && q.explanation.trim().length > 5;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const session = await verifySessionToken(req.body?.sessionToken);
  if (!session) return res.status(401).json({ error: 'Login kraevet' });

  try {
    let { prompt, mode, existingQuestions = [], reformulate = false, questionText = '' } = req.body;
    if (!prompt && !reformulate) throw new Error('Ingen prompt modtaget');

    // Trim prompt til 80.000 tegn
    if (prompt && prompt.length > 80000) prompt = prompt.slice(0, 80000) + '\n\n[Afkortet]';

    // MODE: Omformuler ét enkelt spørgsmål
    if (reformulate && questionText) {
      const system = `Du omformulerer et eksamensspørgsmål til at være tydeligere og mere pædagogisk. 
Svar KUN med et JSON objekt — ingen anden tekst.
Format:
{
  "question": "Det nye spørgsmål?",
  "a": "Svar A",
  "b": "Svar B", 
  "c": "Svar C",
  "d": "Svar D",
  "correct": "b",
  "explanation": "Klar forklaring på hvorfor b er korrekt, og hvad de andre svar mangler"
}
Krav til kvalitet:
- Spørgsmålet skal være præcist og entydigt formuleret
- Alle svarmuligheder skal være plausible (ingen åbenlyst forkerte svar)
- Forklaringen skal hjælpe eleven forstå HVORFOR svaret er rigtigt
- Brug konkrete eksempler i forklaringen hvor muligt`;

      const text = await callClaude(system, `Omformuler dette spørgsmål til at være klarere og mere brugervenligt:\n\n${questionText}`, 1024);
      const clean = text.replace(/```json|```/g, '').trim();
      try {
        const q = JSON.parse(clean);
        if (validateQuestion(q)) return res.status(200).json({ question: q });
      } catch(e) {}
      throw new Error('Kunne ikke omformulere spørgsmålet. Prøv igen.');
    }

    if (mode === 'quiz') {
      const existingContext = existingQuestions.length > 0
        ? `\n\nUNDGÅ disse emner — der er allerede spørgsmål om dem:\n${existingQuestions.map(q => `- ${q.question}`).join('\n')}`
        : '';

      const system = `Du laver multiplechoice quiz spørgsmål til eksamenstræning på dansk.
Svar KUN med et JSON array — ingen anden tekst, ingen forklaring udenfor JSON.

Output format:
[
  {
    "question": "Spørgsmål?",
    "a": "Svar A",
    "b": "Svar B",
    "c": "Svar C",
    "d": "Svar D",
    "correct": "b",
    "explanation": "Forklaring på hvorfor b er korrekt"
  }
]

KVALITETSKRAV — FØLG DISSE NØJE:
1. SPØRGSMÅLET: Skal være klart og præcist. Undgå dobbelttydige formuleringer. Spørg om ét specifikt koncept ad gangen.
2. SVARMULIGHEDER: Alle 4 svar skal være plausible — ingen svar må være åbenlyst forkerte. Lav "lokkemiddel"-svar der ligner det rigtige.
3. KORREKT SVAR: Varier hvilket bogstav (a/b/c/d) der er korrekt — undgå at altid bruge samme bogstav.
4. FORKLARING: Skal forklare HVORFOR svaret er rigtigt OG kort nævne hvorfor de andre svar er forkerte. Brug gerne et konkret eksempel.
5. DÆKNING: Spørgsmålene skal dække forskellige dele af materialet — ikke kun det mest åbenlyse.

Alle 7 felter er obligatoriske i hvert objekt.`;

      const text = await callClaude(
        system,
        `${prompt}${existingContext}\n\nLav præcis 5 spørgsmål på dansk af høj kvalitet. Kun JSON array, ingen tekst udenfor.`,
        4096
      );

      let questions = parseQuestions(text).filter(validateQuestion).slice(0, 5);

      if (questions.length < 3) {
        const retryText = await callClaude(
          system,
          `${prompt}\n\nLav præcis 5 spørgsmål på dansk. Kun JSON array.`,
          4096
        );
        questions = parseQuestions(retryText).filter(validateQuestion).slice(0, 5);
      }

      if (questions.length === 0) {
        throw new Error('Kunne ikke generere gyldige spørgsmål. Prøv igen.');
      }

      return res.status(200).json({ questions });
    }

    // Summary og explain
    const system = mode === 'summary'
      ? 'Du laver eksamensopsummeringer på dansk. Brug markdown: # overskrifter, ## underoverskrifter, **fed** for nøglebegreber, - for punktlister. Vær grundig men præcis.'
      : 'Du er pædagogisk underviser. Forklar grundigt med konkrete eksempler på dansk. Brug markdown: # overskrifter, **fed** for vigtige begreber, - for punktlister, ``` for kodeeksempler.';

    const text = await callClaude(system, prompt, 4096);
    return res.status(200).json({ text });

  } catch (err) {
    console.error('Generate error:', err);
    return res.status(500).json({ error: err.message });
  }
}
