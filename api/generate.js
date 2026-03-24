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
    let { prompt, images } = req.body;

    // Begræns tekst til 15.000 tegn
    if (prompt && prompt.length > 15000) {
      prompt = prompt.slice(0, 15000) + '\n\n[Tekst afkortet]';
    }

    // Begræns til max 5 billeder
    if (images && images.length > 5) {
      images = images.slice(0, 5);
    }

    // Byg content array
    const content = [];

    // Tilføj billeder — kun jpeg og png virker med Anthropic
    if (images && images.length > 0) {
      for (const img of images) {
        // Normaliser media type — Anthropic accepterer kun jpeg og png
        let mediaType = img.mediaType || 'image/jpeg';
        if (!['image/jpeg', 'image/png', 'image/gif', 'image/webp'].includes(mediaType)) {
          mediaType = 'image/jpeg';
        }
        // Sørg for at b64 data er ren (ingen data URL prefix)
        let b64 = img.b64 || '';
        if (b64.includes(',')) b64 = b64.split(',')[1];
        if (!b64 || b64.length < 100) continue; // Spring over tomme/ugyldige billeder

        content.push({
          type: 'image',
          source: { type: 'base64', media_type: mediaType, data: b64 }
        });
      }
    }

    content.push({ type: 'text', text: prompt });

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
        messages: [{ role: 'user', content }]
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
