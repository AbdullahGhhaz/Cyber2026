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

  try {
    let { prompt, mode, existingQuestions = [] } = req.body;
    if (!prompt) throw new Error('Ingen prompt modtaget');

    // FIX: Trim prompt til 80.000 tegn (var allerede der, beholdt)
    if (prompt.length > 80000) prompt = prompt.slice(0, 80000) + '\n\n[Afkortet]';

    if (mode === 'quiz') {
      const existingContext = existingQuestions.length > 0
        ? `\n\nUNDGÅ disse emner - der er allerede spørgsmål om dem:\n${existingQuestions.map(q => `- ${q.question}`).join('\n')}`
        : '';

      const system = `Du laver multiplechoice quiz spørgsmål til eksamenstræning. Svar KUN med et JSON array - ingen anden tekst, ingen forklaring udenfor JSON.
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
Alle 7 felter er obligatoriske i hvert objekt. Lav spørgsmål der dækker forskellige dele af materialet.`;

      // FIX: Ét enkelt kald i stedet for to — hurtigere og billigere
      const text = await callClaude(
        system,
        `${prompt}${existingContext}\n\nLav præcis 5 spørgsmål på dansk. Kun JSON array, ingen tekst udenfor.`,
        1500
      );

      let questions = parseQuestions(text).filter(validateQuestion).slice(0, 5);

      // Retry kun hvis vi fik færre end 3 gyldige spørgsmål
      if (questions.length < 3) {
        console.log(`Retry: kun ${questions.length} gyldige spørgsmål i første kald`);
        const retryText = await callClaude(
          system,
          `${prompt}\n\nLav præcis 5 spørgsmål på dansk. Kun JSON array.`,
          1500
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

    const text = await callClaude(system, prompt, 2048);
    return res.status(200).json({ text });

  } catch (err) {
    console.error('Generate error:', err);
    return res.status(500).json({ error: err.message });
  }
}
