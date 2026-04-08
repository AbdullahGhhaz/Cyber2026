export const config = {
  api: { bodyParser: { sizeLimit: '50mb' } }
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

    // Hvis prompt er for lang, lav en smart sammenfatning af materialet
    const MAX_CHARS = 80000;
    if (prompt.length > MAX_CHARS) {
      prompt = prompt.slice(0, MAX_CHARS) + '\n\n[Materiale afkortet — fokuser på det vigtigste fra det læste]';
    }

    let system = '';
    if (mode === 'quiz') {
      system = 'Du er en eksamensforbereder. Du svarer KUN med quiz spørgsmål i det præcise format der beskrives. Ingen introduktion, ingen forklaring, ingen ekstra tekst overhovedet. Start direkte med Q1. Følg formatet 100% nøjagtigt.';
    } else if (mode === 'summary') {
      system = 'Du er en eksamensforbereder. Lav en velstruktureret og fyldestgørende opsummering af ALT det vigtigste fra materialet. Brug markdown formatering: # for hovedoverskrifter, ## for underoverskrifter, **fed** for nøglebegreber, - for punktlister. Vær grundig men præcis.';
    } else {
      system = 'Du er en pædagogisk underviser. Forklar emnet grundigt og klart med konkrete eksempler. Brug markdown: # for overskrifter, ## for underoverskrifter, **fed** for nøglebegreber, - for punktlister, ``` for kodeeksempler. Vær pædagogisk og tydelig.';
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
        max_tokens: 4096,
        system,
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
