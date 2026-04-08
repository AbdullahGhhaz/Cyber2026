export const config = {
  api: { bodyParser: { sizeLimit: '20mb' } }
};

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    let { prompt, mode } = req.body;
    if (!prompt) throw new Error('Ingen prompt modtaget');
    if (prompt.length > 60000) prompt = prompt.slice(0, 60000) + '\n\n[Afkortet]';

    // System prompt der tvinger korrekt output format
    let system = '';
    if (mode === 'quiz') {
      system = 'Du er en eksamensforbereder. Du svarer KUN med quiz spørgsmål i det præcise format der beskrives. Ingen introduktion, ingen forklaring, ingen ekstra tekst. Start direkte med Q1.';
    } else if (mode === 'summary') {
      system = 'Du er en eksamensforbereder. Du svarer med en velstruktureret opsummering. Brug markdown: # for overskrifter, ## for underoverskrifter, **fed** for nøglebegreber, - for punktlister.';
    } else {
      system = 'Du er en pædagogisk underviser. Du forklarer emner grundigt med eksempler. Brug markdown: # for overskrifter, ## for underoverskrifter, **fed** for nøglebegreber, - for punktlister.';
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        system: system,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);
    const text = data.content?.map(b => b.text || '').join('') || 'Ingen respons.';
    return res.status(200).json({ text });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
