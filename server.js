/**
 * ADA PHONE BACKEND
 * ------------------------------------------------------------
 * Answers a real phone call via Twilio, listens to the caller,
 * sends what they say to Gemini, speaks the reply back, and
 * loops until the call ends.
 *
 * Flow:
 *  1. Twilio receives a call on your rented number
 *  2. Twilio POSTs to /voice on this server
 *  3. This server replies with TwiML: greet + listen (Gather)
 *  4. Twilio transcribes speech itself and POSTs the text to /handle-speech
 *  5. This server sends that text + conversation history to Gemini
 *  6. Server replies with TwiML: speak Gemini's answer + listen again
 *  7. Repeat until caller hangs up or goes silent too long
 * ------------------------------------------------------------
 */

const express = require('express');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-2.5-flash';

// In-memory conversation store, keyed by Twilio's CallSid.
// Fine for a single-hotel demo. For real multi-tenant use, swap this
// for a real database (Postgres/Supabase) so history survives restarts
// and multiple hotels don't share memory.
const conversations = new Map();

const HOTEL_NAME = process.env.HOTEL_NAME || 'Palm Court Hotel';
const SYSTEM_PROMPT = `You are Ada, the AI phone receptionist for ${HOTEL_NAME}. You are warm, professional, and efficient. Keep every reply short — 1-3 sentences, since this is a spoken phone call, not text chat. Help callers with room availability, pricing, reservations, and general questions about the hotel. If you don't know something specific (like real-time room inventory), politely say you'll have a team member confirm and follow up. Never make up exact prices or availability if you're not certain — offer to have staff call back with details instead.`;

async function askGemini(history) {
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
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
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

// Twilio hits this first when a call comes in.
app.post('/voice', (req, res) => {
  const callSid = req.body.CallSid;
  conversations.set(callSid, []);

  const greeting = `Thank you for calling ${HOTEL_NAME}. This is Ada, how can I help you today?`;

  res.type('text/xml').send(twiml(`
    <Gather input="speech" action="/handle-speech" method="POST" speechTimeout="auto" language="en-US">
      <Say voice="Polly.Joanna">${escapeXml(greeting)}</Say>
    </Gather>
    <Say voice="Polly.Joanna">I didn't catch that. Please call back, thank you.</Say>
  `));
});

// Twilio posts the transcribed caller speech here after each turn.
app.post('/handle-speech', async (req, res) => {
  const callSid = req.body.CallSid;
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

  history.push({ role: 'assistant', content: reply });
  conversations.set(callSid, history);

  const lower = callerText.toLowerCase();
  const wantsToEnd = /\b(bye|goodbye|that'?s all|nothing else|hang up)\b/.test(lower);

  if (wantsToEnd) {
    conversations.delete(callSid);
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

// Twilio calls this if a call ends abnormally / times out — cleans memory.
app.post('/status', (req, res) => {
  const callSid = req.body.CallSid;
  if (req.body.CallStatus === 'completed') {
    conversations.delete(callSid);
  }
  res.sendStatus(200);
});

app.get('/', (req, res) => {
  res.send('Ada phone backend is running.');
});

app.listen(PORT, () => {
  console.log(`Ada phone backend listening on port ${PORT}`);
});
