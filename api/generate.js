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
      model: 'claude-sonnet-4-20250514',
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: prompt }]
    })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.content?.map(b => b.text || '').join('') || '';
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    let { prompt, mode, existingQuestions = [] } = req.body;
    if (!prompt) throw new Error('Ingen prompt modtaget');
    if (prompt.length > 80000) prompt = prompt.slice(0, 80000) + '\n\n[Afkortet]';

    if (mode === 'quiz') {
      // Byg kontekst fra eksisterende spørgsmål så AI undgår dubletter
      const existingContext = existingQuestions.length > 0
        ? `\n\nUNDGÅ disse emner da der allerede er spørgsmål om dem:\n${existingQuestions.map(q => `- ${q.question}`).join('\n')}`
        : '';

      const system = `Du laver præcis 5 multiplechoice quiz spørgsmål. Svar KUN med JSON array - ingen anden tekst.

Format:
[
  {
    "question": "Spørgsmålet her?",
    "a": "Første svarmulighed",
    "b": "Anden svarmulighed", 
    "c": "Tredje svarmulighed",
    "d": "Fjerde svarmulighed",
    "correct": "b",
    "explanation": "Forklaring på hvorfor b er korrekt"
  }
]

REGLER:
- Præcis 5 spørgsmål
- "correct" er altid et af: a, b, c eller d (lille bogstav)
- Alle felter skal udfyldes
- Kun JSON - ingen tekst før eller efter`;

      const text = await callClaude(system, `${prompt}${existingContext}\n\nLav 5 nye spørgsmål på dansk.`);

      // Parse JSON
      let questions = [];
      try {
        const clean = text.replace(/```json|```/g, '').trim();
        questions = JSON.parse(clean);
      } catch(e) {
        // Prøv at finde JSON array i teksten
        const match = text.match(/\[[\s\S]*\]/);
        if (match) questions = JSON.parse(match[0]);
        else throw new Error('Kunne ikke parse quiz spørgsmål');
      }

      // Validér alle spørgsmål
      questions = questions.filter(q =>
        q.question && q.a && q.b && q.c && q.d &&
        q.correct && ['a','b','c','d'].includes(q.correct.toLowerCase()) &&
        q.explanation
      );

      return res.status(200).json({ questions });
    }

    // Summary og explain
    const system = mode === 'summary'
      ? 'Du laver eksamensopsummeringer. Brug markdown: # overskrifter, ## underoverskrifter, **fed** for nøglebegreber, - for punktlister.'
      : 'Du er pædagogisk underviser. Forklar grundigt med eksempler. Brug markdown: # overskrifter, **fed**, - for punktlister, ``` for kode.';

    const text = await callClaude(system, prompt);
    return res.status(200).json({ text });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
