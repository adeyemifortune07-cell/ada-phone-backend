
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-2.5-flash';

const conversations = new Map();
const callStartTimes = new Map();
const callHistory = [];
const managerMessages = [];

const HOTEL_NAME = process.env.HOTEL_NAME || 'Palm Court Hotel';
const SYSTEM_PROMPT = `You are Ada, the AI phone receptionist for ${HOTEL_NAME}. You are warm, professional, and efficient. Keep every reply short — 1-3 sentences, since this is a spoken phone call, not text chat. Help callers with room availability, pricing, reservations, and general questions about the hotel. If you don't know something specific (like real-time room inventory), politely say you'll have a team member confirm and follow up. Never make up exact prices or availability if you're not certain — offer to have staff call back with details instead.

MESSAGE PROTOCOL — for anything you can't personally resolve (complaints, group bookings, event space, or anything genuinely outside a normal reservation or FAQ):
- If it sounds urgent or upsetting (a real complaint, a safety issue), don't make them repeat themselves for detail — acknowledge it immediately, get their name efficiently, and log it fast rather than drawing it out.
- Once you have their name and the reason, on a new line output exactly:
###MESSAGE{"from":"<name>","reason":"<short, specific summary — not a vague restatement>"}###
- This tag is machine-only: never speak it aloud, never mention that you're "logging" anything — the caller should just hear a natural conversation.`;

async function askGemini(history, systemPrompt) {
  const contents = history.map(turn => ({
    role: turn.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: turn.content }],
  }));

  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt || SYSTEM_PROMPT }] },
        contents,
        generationConfig: { temperature: 0.7, maxOutputTokens: 200 },
      }),
    }
  );

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error('Gemini error', res.status, errText);
    return "I'm sorry, I'm having trouble understanding right now. Let me have someone from our team call you back shortly.";
  }

  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts;
  const text = parts ? parts.map(p => p.text || '').join('').trim() : '';
  return text || "Could you say that again, please?";
}

function twiml(inner) {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${inner}</Response>`;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

app.post('/voice', (req, res) => {
  const callSid = req.body.CallSid;
  conversations.set(callSid, []);
  callStartTimes.set(callSid, Date.now());

  const greeting = `Thank you for calling ${HOTEL_NAME}. This is Ada, how can I help you today?`;

  res.type('text/xml').send(twiml(`
    <Gather input="speech" action="/handle-speech" method="POST" speechTimeout="auto" language="en-US">
      <Say voice="Polly.Joanna">${escapeXml(greeting)}</Say>
    </Gather>
    <Say voice="Polly.Joanna">I didn't catch that. Please call back, thank you.</Say>
  `));
});

function finishCall(callSid, from, outcome) {
  const startedAt = callStartTimes.get(callSid);
  const durationSeconds = startedAt ? Math.round((Date.now() - startedAt) / 1000) : null;
  const history = conversations.get(callSid) || [];
  callHistory.push({
    id: callSid,
    from: from || 'unknown',
    at: new Date().toISOString(),
    durationSeconds,
    turns: history.length,
    outcome,
  });
  conversations.delete(callSid);
  callStartTimes.delete(callSid);
}

function extractManagerMessage(reply, from) {
  const match = reply.match(/###MESSAGE(\{[\s\S]*?\})###/);
  if (!match) return reply;
  try {
    const parsed = JSON.parse(match[1]);
    managerMessages.push({
      id: 'msg' + Date.now() + Math.round(Math.random() * 1000),
      from: parsed.from || 'unknown',
      phone: from || 'unknown',
      reason: parsed.reason || '',
      at: new Date().toISOString(),
      handled: false,
    });
  } catch (e) {
    console.warn('Message parse error:', e);
  }
  return reply.replace(match[0], '').trim();
}

app.post('/handle-speech', async (req, res) => {
  const callSid = req.body.CallSid;
  const from = req.body.From;
  const callerText = req.body.SpeechResult || '';

  const history = conversations.get(callSid) || [];

  if (!callerText.trim()) {
    res.type('text/xml').send(twiml(`
      <Gather input="speech" action="/handle-speech" method="POST" speechTimeout="auto" language="en-US">
        <Say voice="Polly.Joanna">Sorry, I didn't catch that. Could you repeat it?</Say>
      </Gather>
      <Say voice="Polly.Joanna">Thanks for calling, goodbye.</Say>
    `));
    return;
  }

  history.push({ role: 'user', content: callerText });

  let reply;
  try {
    reply = await askGemini(history);
  } catch (err) {
    console.error('askGemini failed', err);
    reply = "I'm sorry, I'm having a technical issue. Let me have our team call you back shortly.";
  }

  reply = extractManagerMessage(reply, from);

  history.push({ role: 'assistant', content: reply });
  conversations.set(callSid, history);

  const lower = callerText.toLowerCase();
  const wantsToEnd = /\b(bye|goodbye|that'?s all|nothing else|hang up)\b/.test(lower);

  if (wantsToEnd) {
    finishCall(callSid, from, 'completed');
    res.type('text/xml').send(twiml(`<Say voice="Polly.Joanna">${escapeXml(reply)}</Say><Hangup/>`));
    return;
  }

  res.type('text/xml').send(twiml(`
    <Gather input="speech" action="/handle-speech" method="POST" speechTimeout="auto" language="en-US">
      <Say voice="Polly.Joanna">${escapeXml(reply)}</Say>
    </Gather>
    <Say voice="Polly.Joanna">Thanks for calling, goodbye.</Say>
  `));
});

app.post('/status', (req, res) => {
  const callSid = req.body.CallSid;
  if (req.body.CallStatus === 'completed' && conversations.has(callSid)) {
    finishCall(callSid, req.body.From, 'dropped');
  }
  res.sendStatus(200);
});

app.get('/', (req, res) => {
  res.send('Ada phone backend is running.');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', hasGeminiKey: Boolean(GEMINI_API_KEY) });
});

app.get('/api/calls', (req, res) => {
  res.json({ calls: callHistory.slice().reverse().slice(0, 50) });
});

app.get('/api/messages', (req, res) => {
  res.json({ messages: managerMessages.slice().reverse() });
});

app.post('/api/coach', async (req, res) => {
  try {
    if (!GEMINI_API_KEY) {
      return res.status(500).json({ error: 'Server is missing GEMINI_API_KEY.' });
    }
    const { systemPrompt, messages = [] } = req.body;
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: 'messages array is required.' });
    }
    const reply = await askGemini(messages, systemPrompt);
    res.json({ reply });
  } catch (err) {
    console.error('coach proxy error', err);
    res.status(500).json({ error: 'AI is temporarily unavailable.' });
  }
});

app.listen(PORT, () => {
  console.log(`Ada phone backend listening on port ${PORT}`);
});
