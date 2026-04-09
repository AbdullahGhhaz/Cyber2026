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
    if (match) { try { return JSON.parse(match[0]); } catch(e2) { return []; } }
    return [];
  }
}

function validateQuestion(q) {
  return q && q.question && q.a && q.b && q.c && q.d &&
    q.correct && ['a','b','c','d'].includes(String(q.correct).toLowerCase()) &&
    q.explanation;
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
      const existingContext = existingQuestions.length > 0
        ? `\n\nUNDGÅ disse emner - der er allerede spørgsmål om dem:\n${existingQuestions.map(q => `- ${q.question}`).join('\n')}`
        : '';

      const system = `Du laver multiplechoice quiz spørgsmål. Svar KUN med et JSON array - ingen anden tekst.

Output format:
[
  {
    "question": "Spørgsmål?",
    "a": "Svar A",
    "b": "Svar B",
    "c": "Svar C",
    "d": "Svar D",
    "correct": "b",
    "explanation": "Forklaring"
  }
]

Alle 7 felter er obligatoriske i hvert objekt.`;

      // Kald 1: 3 spørgsmål
      const text1 = await callClaude(system, `${prompt}${existingContext}\n\nLav præcis 3 spørgsmål på dansk. Kun JSON.`);
      const q1 = parseQuestions(text1).filter(validateQuestion);

      // Kald 2: 2 spørgsmål — undgå emner fra kald 1
      const avoid = q1.map(q => `- ${q.question}`).join('\n');
      const avoidCtx = avoid ? `\n\nUNDGÅ også:\n${avoid}` : '';
      const text2 = await callClaude(system, `${prompt}${existingContext}${avoidCtx}\n\nLav præcis 2 spørgsmål på dansk. Kun JSON.`);
      const q2 = parseQuestions(text2).filter(validateQuestion);

      let questions = [...q1, ...q2].slice(0, 5);

      // Retry hvis for få
      if (questions.length < 3) {
        const text3 = await callClaude(system, `${prompt}\n\nLav præcis 5 spørgsmål på dansk. Kun JSON.`);
        questions = parseQuestions(text3).filter(validateQuestion).slice(0, 5);
      }

      return res.status(200).json({ questions });
    }

    const system = mode === 'summary'
      ? 'Du laver eksamensopsummeringer. Brug markdown: # overskrifter, ## underoverskrifter, **fed** for nøglebegreber, - for punktlister.'
      : 'Du er pædagogisk underviser. Forklar grundigt med eksempler. Brug markdown: # overskrifter, **fed**, - for punktlister, ``` for kode.';

    const text = await callClaude(system, prompt);
    return res.status(200).json({ text });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
