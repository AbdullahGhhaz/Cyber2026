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
    let { prompt, mode, n } = req.body;
    if (!prompt) throw new Error('Ingen prompt modtaget');
    if (prompt.length > 80000) prompt = prompt.slice(0, 80000) + '\n\n[Afkortet]';

    let system = '';
    if (mode === 'quiz') {
      system = `Du er en eksamensforbereder. Du skal lave multiplechoice quiz spørgsmål.

KRITISKE REGLER - FØLG 100%:
1. Start DIREKTE med Q1 - ingen indledning
2. HVERT eneste spørgsmål SKAL have en "Svar:" linje
3. Brug ALTID dette eksakte format for ALLE spørgsmål:

Q1: [spørgsmål]
A) [svar]
B) [svar]
C) [svar]
D) [svar]
Svar: A — [forklaring]

Q2: [spørgsmål]
A) [svar]
B) [svar]
C) [svar]
D) [svar]
Svar: C — [forklaring]

INGEN af spørgsmålene må mangle Svar-linjen. Det er et absolut krav.`;
    } else if (mode === 'summary') {
      system = 'Du er en eksamensforbereder. Lav en grundig struktureret opsummering. Brug markdown: # overskrifter, ## underoverskrifter, **fed** for nøglebegreber, - for punktlister.';
    } else {
      system = 'Du er en pædagogisk underviser. Forklar emnet grundigt med eksempler. Brug markdown: # overskrifter, ## underoverskrifter, **fed** for nøglebegreber, - for punktlister, ``` for kode.';
    }

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
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
