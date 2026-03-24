export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();

  try {
    const { prompt, images } = req.body;

    // Build Gemini parts: images first, then text
    const parts = [];

    if (images && images.length > 0) {
      for (const img of images) {
        parts.push({ inlineData: { mimeType: img.mediaType, data: img.b64 } });
      }
    }
    parts.push({ text: prompt });

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: { maxOutputTokens: 2048, temperature: 0.7 }
        })
      }
    );

    const data = await response.json();
    if (data.error) throw new Error(data.error.message);

    const text = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Ingen respons.';
    return res.status(200).json({ text });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
