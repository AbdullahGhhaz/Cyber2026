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

// Sonnet til de aabne/kvalitetskraevende opgaver (quiz, opsummering, forklaring).
// Haiku (ca. 1/3 af prisen) til de smaa, mekaniske opgaver (omformulering af ét
// spoergsmaal, én kodeoevelse) hvor Sonnet-kvalitet ikke er noedvendig.
const MODEL_SONNET = 'claude-sonnet-4-5';
const MODEL_HAIKU = 'claude-haiku-4-5';

async function callClaude(system, content, maxTokens = 2048, model = MODEL_SONNET) {
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
      messages: [{ role: 'user', content }]
    })
  });
  const data = await response.json();
  if (data.error) throw new Error(data.error.message);
  return data.content?.map(b => b.text || '').join('') || '';
}

// Bygger to content-blokke: det genbrugte undervisningsmateriale (markeret til
// prompt-caching, saa gentagne kald for samme fag/fil genbruger det for ca. 1/10
// af normal input-pris i stedet for at betale fuld pris hver gang) efterfulgt af
// den variable instruktion, som aendrer sig fra kald til kald.
function cachedContent(material, instruction) {
  const blocks = [];
  if (material) blocks.push({ type: 'text', text: material, cache_control: { type: 'ephemeral' } });
  blocks.push({ type: 'text', text: instruction });
  return blocks;
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

function validateCodeExercise(ex) {
  return ex &&
    typeof ex.task === 'string' && ex.task.trim().length > 5 &&
    typeof ex.language === 'string' && ex.language.trim() &&
    typeof ex.hint === 'string' &&
    typeof ex.solution === 'string' && ex.solution.trim().length > 0 &&
    typeof ex.explanation === 'string';
}

// Blander svarmulighederne programmatisk, saa den korrekte placering (a/b/c/d)
// er reelt tilfaeldig uanset hvad AI'en outputter. Bruger et index-baseret
// Fisher-Yates shuffle, saa det haandterer eventuelle ens svartekster korrekt.
function shuffleAnswerPosition(q) {
  const letters = ['a', 'b', 'c', 'd'];
  const values = letters.map(l => q[l]);
  const correctIndex = letters.indexOf(String(q.correct).toLowerCase());

  const order = [0, 1, 2, 3];
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }

  const shuffled = { ...q };
  let newCorrectIndex = correctIndex;
  order.forEach((originalIndex, newIndex) => {
    shuffled[letters[newIndex]] = values[originalIndex];
    if (originalIndex === correctIndex) newCorrectIndex = newIndex;
  });
  shuffled.correct = letters[newCorrectIndex];

  return shuffled;
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
    let { prompt, mode, existingQuestions = [], reformulate = false, questionText = '', topic = '', subject = '' } = req.body;
    if (!prompt && !reformulate) throw new Error('Ingen prompt modtaget');

    // Trim prompt til 40.000 tegn
    if (prompt && prompt.length > 40000) prompt = prompt.slice(0, 40000) + '\n\n[Afkortet]';

    // MODE: Omformuler ét enkelt spørgsmål — lille, mekanisk opgave -> Haiku
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

      const text = await callClaude(system, `Omformuler dette spørgsmål til at være klarere og mere brugervenligt:\n\n${questionText}`, 1024, MODEL_HAIKU);
      const clean = text.replace(/```json|```/g, '').trim();
      try {
        const q = JSON.parse(clean);
        if (validateQuestion(q)) return res.status(200).json({ question: shuffleAnswerPosition(q) });
      } catch(e) {}
      throw new Error('Kunne ikke omformulere spørgsmålet. Prøv igen.');
    }

    if (mode === 'quiz') {
      // Kun de seneste 40 spørgsmåls-titler sendes med for at undgå gentagelser —
      // uden loft ville denne liste vokse ubegrænset og fylde mere og mere i hvert
      // eneste "Tilføj 5 flere"-kald efterhånden som spørgsmålsbanken vokser.
      const recentQuestions = existingQuestions.slice(-40);
      const existingContext = recentQuestions.length > 0
        ? `\n\nUNDGÅ disse emner — der er allerede spørgsmål om dem:\n${recentQuestions.map(q => `- ${q.question}`).join('\n')}`
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
        cachedContent(prompt, `${existingContext}\n\nLav præcis 5 spørgsmål på dansk af høj kvalitet. Kun JSON array, ingen tekst udenfor.`),
        4096
      );

      let questions = parseQuestions(text).filter(validateQuestion).slice(0, 5).map(shuffleAnswerPosition);

      if (questions.length === 0) {
        throw new Error('Kunne ikke generere gyldige spørgsmål. Prøv igen.');
      }

      return res.status(200).json({ questions });
    }

    // MODE: Kodeøvelse — dedikeret "kun JSON"-systemprompt (tidligere genbrugte
    // denne funktion 'explain'-tilstanden, hvis systemprompt beder om markdown og
    // dermed modarbejdede kravet om rent JSON-svar — det gav lejlighedsvise
    // parse-fejl). Lille, mekanisk opgave -> Haiku.
    if (mode === 'code-exercise') {
      const system = `Du laver praktiske kodeøvelser til eksamenstræning på dansk.
Svar KUN med et JSON objekt — ingen anden tekst, ingen markdown, ingen forklaring udenfor JSON.
Format:
{
  "task": "Opgavebeskrivelse (2-4 sætninger, konkret)",
  "language": "bash/powershell/python/js/andet",
  "hint": "Hjælpsomt hint uden at afsløre svaret",
  "solution": "Korrekt model-løsning (kun kode)",
  "explanation": "Kort forklaring af løsningen"
}
Krav: Opgaven løses på 5-15 linjer, praktisk og baseret på materialet.`;

      const subjectLabel = typeof subject === 'string' && subject.trim() ? subject.trim() : 'faget';
      const instruction = `\n\n---\nLav EN praktisk kodeopgave for faget "${subjectLabel}" baseret på materialet ovenfor. Kun JSON, ingen tekst udenfor.`;

      const text = await callClaude(system, cachedContent(prompt, instruction), 1536, MODEL_HAIKU);
      const clean = text.replace(/```json|```/g, '').trim();
      try {
        const ex = JSON.parse(clean);
        if (validateCodeExercise(ex)) return res.status(200).json({ exercise: ex });
      } catch (e) {}
      throw new Error('Kunne ikke generere kodeøvelse. Prøv igen.');
    }

    // MODE: Fag-overblik — allerede en selvstændig, komplet prompt bygget af
    // klienten (opsummerer flere gemte opsummeringer, som ændrer sig fra gang
    // til gang), så den sendes uændret igennem uden cache eller tilføjet instruktion.
    if (mode === 'fag-summary') {
      const system = 'Du laver eksamensopsummeringer på dansk. Brug markdown: # overskrifter, ## underoverskrifter, **fed** for nøglebegreber, - for punktlister. Vær grundig men præcis.';
      const text = await callClaude(system, prompt, 4096);
      return res.status(200).json({ text });
    }

    // Summary og explain — prompt er her kun selve undervisningsmaterialet;
    // instruktionen bygges her på serveren og holdes i sin egen (ucachede) blok,
    // så materiale-blokken kan genbruges fra prompt-cachen på tværs af kald.
    const system = mode === 'summary'
      ? 'Du laver eksamensopsummeringer på dansk. Brug markdown: # overskrifter, ## underoverskrifter, **fed** for nøglebegreber, - for punktlister. Vær grundig men præcis.'
      : 'Du er pædagogisk underviser. Forklar grundigt med konkrete eksempler på dansk. Brug markdown: # overskrifter, **fed** for vigtige begreber, - for punktlister, ``` for kodeeksempler.';

    const instruction = mode === 'summary'
      ? '\n\n---\nOPGAVE: Lav en grundig struktureret eksamensopsummering på dansk.'
      : `\n\n---\nOPGAVE: Forklar følgende emne grundigt på dansk: "${topic || 'de vigtigste begreber i emnet'}". Brug eksempler.`;

    const text = await callClaude(system, cachedContent(prompt, instruction), 4096);
    return res.status(200).json({ text });

  } catch (err) {
    console.error('Generate error:', err);
    return res.status(500).json({ error: err.message });
  }
}
