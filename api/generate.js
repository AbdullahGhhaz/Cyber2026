export const config = {
  api: { bodyParser: { sizeLimit: '50mb' } }
};

async function callClaude(system, prompt, model = 'claude-sonnet-4-20250514', maxTokens = 4096) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.content?.map(b => b.text || '').join('') || '';
}

function hasAllAnswers(text, n) {
  const blocks = text.split(/\n(?=Q\d+:)/).filter(b => b.trim());
  if (blocks.length < n) return false;
  return blocks.every(b => /Svar:\s*[A-D]/.test(b));
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    let { prompt, mode, n = 5 } = req.body;
    if (!prompt) throw new Error('Ingen prompt modtaget');
    if (prompt.length > 80000) prompt = prompt.slice(0, 80000) + '\n\n[Afkortet]';

    if (mode === 'quiz') {
      // Lav spørgsmål i to omgange: første halvdel, anden halvdel
      const half1 = Math.ceil(n / 2);
      const half2 = n - half1;

      const quizSystem = `Du laver multiplechoice quiz spørgsmål. Følg dette format PRÆCIST for HVERT spørgsmål - ingen undtagelser:

Q1: [spørgsmål]
A) [svar]
B) [svar]
C) [svar]
D) [svar]
Svar: B — [forklaring på hvorfor B er korrekt]

REGLER:
- Start direkte med Q1
- Hvert spørgsmål HAR en Svar-linje
- Ingen ekstra tekst`;

      const [text1, text2] = await Promise.all([
        callClaude(quizSystem, `${prompt}\n\nLav præcis ${half1} spørgsmål (Q1 til Q${half1}).`),
        callClaude(quizSystem, `${prompt}\n\nLav præcis ${half2} spørgsmål (Q${half1+1} til Q${n}).`)
      ]);

      // Flet de to halvdele sammen
      let combined = text1.trim() + '\n\n' + text2.trim();

      // Renummerér spørgsmål så de er sammenhængende
      let qNum = 0;
      combined = combined.replace(/^Q\d+:/gm, () => `Q${++qNum}:`);

      return res.status(200).json({ text: combined });
    }

    // Summary og explain
    const system = mode === 'summary'
      ? 'Du laver eksamensopsummeringer. Brug markdown: # overskrifter, ## underoverskrifter, **fed** for nøglebegreber, - for punktlister.'
      : 'Du er pædagogisk underviser. Forklar grundigt med eksempler. Brug markdown: # overskrifter, ## underoverskrifter, **fed**, - for punktlister, ``` for kode.';

    const text = await callClaude(system, prompt);
    return res.status(200).json({ text });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
