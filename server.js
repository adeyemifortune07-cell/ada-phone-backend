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
const cors = require('cors');
const { Pool } = require('pg');

const app = express();
app.use(cors());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const PORT = process.env.PORT || 3000;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = 'gemini-4.0-flash';

// ---------- Real persistence (Supabase/Postgres) ----------
// Set DATABASE_URL in Render's env vars (from Supabase: Project Settings ->
// Database -> Connection string -> URI). Without it, the app still runs but
// falls back to in-memory only (resets on restart) — fine for quick testing,
// not for production.
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

async function ensureTable() {
  if (!pool) { console.warn('No DATABASE_URL set — running with in-memory storage only (data resets on restart).'); return; }
  await pool.query(`CREATE TABLE IF NOT EXISTS kv_store (
    key TEXT PRIMARY KEY,
    value TEXT,
    updated_at TIMESTAMPTZ DEFAULT now()
  )`);
  console.log('Connected to Postgres, kv_store ready.');
}
ensureTable().catch(e => console.error('DB init error:', e.message));

async function kvGet(key) {
  if (!pool) return null;
  const { rows } = await pool.query('SELECT value FROM kv_store WHERE key = $1', [key]);
  return rows[0] ? rows[0].value : null;
}
async function kvSet(key, value) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO kv_store (key, value, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = now()`,
    [key, value]
  );
}

const conversations = new Map();
const callStartTimes = new Map();
let callHistory = [];
let managerMessages = [];

// Load any previously-persisted live call/message history on boot
(async () => {
  try {
    const c = await kvGet('live:calls');
    if (c) callHistory = JSON.parse(c);
    const m = await kvGet('live:messages');
    if (m) managerMessages = JSON.parse(m);
  } catch (e) { console.error('Could not load persisted call data:', e.message); }
})();

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

// Twilio hits this first when a call comes in.
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
  kvSet('live:calls', JSON.stringify(callHistory)).catch(e => console.error('persist calls failed:', e.message));
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
    kvSet('live:messages', JSON.stringify(managerMessages)).catch(e => console.error('persist messages failed:', e.message));
  } catch (e) {
    console.warn('Message parse error:', e);
  }
  return reply.replace(match[0], '').trim();
}

// Twilio posts the transcribed caller speech here after each turn.
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

// Twilio calls this if a call ends abnormally / times out — cleans memory.
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
  res.json({ status: 'ok', hasGeminiKey: Boolean(GEMINI_API_KEY), hasDatabase: Boolean(pool) });
});

// ---------- Dashboard-facing API ----------
// Real call/message data for the browser dashboard (ai-receptionist-improved.html)

app.get('/api/calls', (req, res) => {
  res.json({ calls: callHistory.slice().reverse().slice(0, 50) });
});

app.get('/api/messages', (req, res) => {
  res.json({ messages: managerMessages.slice().reverse() });
});

// Generic storage for dashboard data (rooms, bookings, guest notes, business
// profile). The frontend keeps a localStorage copy for instant loading, but
// this is the real source of truth so data survives clearing browser data,
// switching devices, or the backend restarting.
app.get('/api/storage/:key', async (req, res) => {
  try {
    const value = await kvGet(req.params.key);
    res.json({ key: req.params.key, value });
  } catch (err) {
    console.error('storage read error', err);
    res.status(500).json({ error: 'Storage read failed.' });
  }
});

app.put('/api/storage/:key', async (req, res) => {
  try {
    const { value } = req.body;
    if (typeof value !== 'string') return res.status(400).json({ error: 'value must be a string.' });
    await kvSet(req.params.key, value);
    res.json({ ok: true });
  } catch (err) {
    console.error('storage write error', err);
    res.status(500).json({ error: 'Storage write failed.' });
  }
});

// Generic Gemini proxy for the browser dashboard's demo/test call feature.
// Keeps the Gemini key server-side even for browser testing — the dashboard
// sends its own systemPrompt (built from whatever rooms/pricing config the
// user has set locally) plus the running conversation.
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
