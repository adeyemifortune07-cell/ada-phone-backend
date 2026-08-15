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
const GEMINI_MODEL = 'gemini-3.5-flash-lite'; // FIX: gemini-2.5-flash-lite was shut down by Google on July 9, 2026 (ahead of its announced date) — this is the current stable, cost-efficient successor

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
  // FIX: per-business access codes — was previously one single shared
  // DASHBOARD_ACCESS_CODE for the whole backend, which breaks the moment
  // more than one unrelated business shares this deployment (everyone would
  // need the same password, so Business A could see Business B's data).
  // Each business now gets its own row and its own private code.
  await pool.query(`CREATE TABLE IF NOT EXISTS businesses (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    slug TEXT UNIQUE NOT NULL,
    business_name TEXT DEFAULT 'My Business',
    business_type TEXT,
    access_code TEXT,
    created_at TIMESTAMPTZ DEFAULT now()
  )`);
  // Every existing deployment already has one real business answering real
  // Twilio calls (configured via the BUSINESS_NAME/BUSINESS_TYPE env vars).
  // Give it a stable 'default' row so real-call logging has somewhere to
  // attach to, and so this matches the dashboard's own default slug.
  await pool.query(
    `INSERT INTO businesses (slug, business_name, business_type)
     VALUES ('default', $1, $2)
     ON CONFLICT (slug) DO NOTHING`,
    [BUSINESS_NAME, process.env.BUSINESS_TYPE || null]
  );
  console.log('Connected to Postgres, kv_store and businesses ready.');
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

// ---------- Per-business lookup + access control ----------
async function resolveBusiness(slug) {
  if (!pool || !slug) return null;
  const { rows } = await pool.query('SELECT * FROM businesses WHERE slug = $1', [slug]);
  return rows[0] || null;
}
// Opt-in security, same as before: a business with no access_code set yet
// stays open (so nothing breaks before you've configured one), but once
// set, only requests carrying the matching header get through.
function checkAccess(business, req, res) {
  if (!business) { res.status(404).json({ error: 'Business not found' }); return false; }
  if (business.access_code) {
    const provided = req.get('X-Access-Code') || '';
    if (provided !== business.access_code) {
      res.status(401).json({ error: 'Missing or incorrect access code' });
      return false;
    }
  }
  return true;
}
// Middleware for routes that take ?biz=slug
async function withBusiness(req, res, next) {
  try {
    const slug = req.query.biz || 'default';
    const business = await resolveBusiness(slug);
    if (!checkAccess(business, req, res)) return;
    req.business = business;
    next();
  } catch (err) {
    console.error('resolve business error', err);
    res.status(500).json({ error: 'Could not resolve business' });
  }
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

// FIX: this used to always assume "hotel" — now it detects the business
// category from BUSINESS_TYPE (or falls back to guessing from the name) so
// Ada talks about services/appointments instead of rooms/nights for
// anything that isn't actually a hotel.
const BUSINESS_NAME = process.env.BUSINESS_NAME || process.env.HOTEL_NAME || 'the business';
function detectBizCategory(raw) {
  const s = (raw || '').toLowerCase();
  if (/\b(hotel|lodging|inn|resort|guest ?house|b&b|bed and breakfast)\b/.test(s)) return 'hotel';
  if (/\b(apartment|apartments|flat|flats|vacation rental|short ?let|airbnb|serviced apartment)\b/.test(s)) return 'apartment';
  if (/\b(car rental|car hire|vehicle rental|auto rental|rent-?a-?car)\b/.test(s)) return 'car_rental';
  if (/\b(clinic|medical|dental|dentist|doctor|hospital|physio|therapy|therapist)\b/.test(s)) return 'clinic';
  if (/\b(salon|spa|barber|nail|hair|beauty|massage)\b/.test(s)) return 'salon';
  if (/\b(restaurant|cafe|caf[eé]|bistro|diner|eatery)\b/.test(s)) return 'restaurant';
  return 'general';
}
const BIZ_CATEGORY_CONFIG = {
  hotel:      { flow:'period',      unitWord:'room' },
  apartment:  { flow:'period',      unitWord:'apartment' },
  car_rental: { flow:'period',      unitWord:'vehicle' },
  clinic:     { flow:'appointment', unitWord:'service' },
  salon:      { flow:'appointment', unitWord:'service' },
  restaurant: { flow:'appointment', unitWord:'table' },
  general:    { flow:'appointment', unitWord:'service' }
};
const BUSINESS_CATEGORY = detectBizCategory(process.env.BUSINESS_TYPE || BUSINESS_NAME);
const bizCfg = BIZ_CATEGORY_CONFIG[BUSINESS_CATEGORY] || BIZ_CATEGORY_CONFIG.general;
const isPeriodFlow = bizCfg.flow === 'period';
const unitWord = bizCfg.unitWord;

const SYSTEM_PROMPT = `You are Ada, the AI phone receptionist for ${BUSINESS_NAME}. You are warm, professional, and efficient. Keep every reply short — 1-3 sentences, since this is a spoken phone call, not text chat. Help callers with ${isPeriodFlow ? unitWord + ' availability, pricing, and bookings' : unitWord + ' info, pricing, and appointment booking'}, and general questions about the business. If you don't know something specific (like real-time availability), politely say you'll have a team member confirm and follow up. Never make up exact prices or availability if you're not certain — offer to have staff call back with details instead.

MESSAGE PROTOCOL — for anything you can't personally resolve (complaints, ${isPeriodFlow ? 'extended bookings, special requests' : 'special requests'}, or anything genuinely outside a normal ${isPeriodFlow ? 'booking' : 'appointment'} or FAQ):
- If it sounds urgent or upsetting (a real complaint, a safety issue), don't make them repeat themselves for detail — acknowledge it immediately, get their name efficiently, and log it fast rather than drawing it out.
- Once you have their name and the reason, on a new line output exactly:
###MESSAGE{"from":"<name>","reason":"<short, specific summary — not a vague restatement>"}###
- This tag is machine-only: never speak it aloud, never mention that you're "logging" anything — the caller should just hear a natural conversation.`;

async function callGeminiOnce(history, systemPrompt) {
  const contents = history.map(turn => ({
    role: turn.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: turn.content }],
  }));

  const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), 10000);

let res;
try {
  res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt || SYSTEM_PROMPT }] },
        contents,
        generationConfig: { temperature: 0.7, maxOutputTokens: 200 },
      }),
      signal: controller.signal,
    }
  );
} finally {
  clearTimeout(timeoutId);
}

  if (!res.ok) {
    const err = new Error(`Gemini HTTP ${res.status}`);
    err.status = res.status;
    err.body = await res.text().catch(() => '');
    throw err;
  }

  const data = await res.json();
  const parts = data?.candidates?.[0]?.content?.parts;
  const text = parts ? parts.map(p => p.text || '').join('').trim() : '';
  return text || "Could you say that again, please?";
}

async function askGemini(history, systemPrompt) {
  // FIX: retry once on transient errors (429 rate limit, 503 overloaded) with
  // a short backoff before giving up — helps ride out brief blips instead of
  // immediately showing the caller a "having trouble" message.
  try {
    return await callGeminiOnce(history, systemPrompt);
  } catch (err) {
    if (err.status === 429 || err.status === 503) {
      console.warn(`Gemini ${err.status}, retrying once in 1.5s...`);
      await new Promise(r => setTimeout(r, 1500));
      try {
        return await callGeminiOnce(history, systemPrompt);
      } catch (err2) {
        console.error('Gemini error (after retry)', err2.status, err2.body);
        return "I'm sorry, I'm having trouble understanding right now. Let me have someone from our team call you back shortly.";
      }
    }
    console.error('Gemini error', err.status, err.body);
    return "I'm sorry, I'm having trouble understanding right now. Let me have someone from our team call you back shortly.";
  }
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

  const greeting = `Thank you for calling ${BUSINESS_NAME}. This is Ada, how can I help you today?`;

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
    businessId: 'default', // FIX: tags real Twilio calls so per-business filtering works — every deployment currently answers for one real business ('default'), same slug the dashboard falls back to
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
      businessId: 'default', // FIX: see note in finishCall above
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

// ---------- Vapi custom LLM webhook ----------
// Vapi sends an OpenAI-style { messages: [...] } payload here for every
// turn of the call, and expects an OpenAI-style chat completion back.
// This reuses Ada's real brain (askGemini + SYSTEM_PROMPT + message logging)
// instead of Vapi's built-in generic assistant.
app.post('/vapi-webhook/chat/completions', async (req, res) => {
  console.log("===== VAPI REQUEST BODY =====");
console.log(JSON.stringify(req.body, null, 2));
console.log("============================");
  console.log('VAPI WEBHOOK HIT', new Date().toISOString());try{
    const messages = req.body.messages || [];

    // Convert Vapi/OpenAI-style messages into Ada's internal history format,
    // skipping the system message (we use our own SYSTEM_PROMPT instead).
    const history = messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content || '',
      }));

    let reply;
try {reply = await askGemini(history, SYSTEM_PROMPT);
     console.log('RAW GEMINI REPLY:', JSON.stringify(reply));
  
} catch (err) {
  console.error('askGemini failed:', err.message, err.stack);
  reply = "Sorry, I'm having trouble right now. Please try again in a moment.";
}

    // Reuse existing manager-message logging (no real "from" phone number
    // available here the way Twilio provides one, so we mark it as a Vapi call).
    reply = extractManagerMessage(reply, 'vapi-call');

console.log('AFTER EXTRACT:', JSON.stringify(reply));
console.log('VAPI WEBHOOK RESPONDING', reply?.slice(0, 100));

res.setHeader('Content-Type', 'text/event-stream');
res.setHeader('Cache-Control', 'no-cache');
res.setHeader('Connection', 'keep-alive');

const chunk = {
  id: 'chatcmpl-' + Date.now(),
  object: 'chat.completion.chunk',
  created: Math.floor(Date.now() / 1000),
  model: 'ada-gemini',
  choices: [
    {
      index: 0,
      delta: {
        role: 'assistant',
        content: reply,
      },
      finish_reason: null,
    },
  ],
};

res.write(`data: ${JSON.stringify(chunk)}\n\n`);

const done = {
  id: chunk.id,
  object: 'chat.completion.chunk',
  created: chunk.created,
  model: chunk.model,
  choices: [
    {
      index: 0,
      delta: {},
      finish_reason: 'stop',
    },
  ],
};

res.write(`data: ${JSON.stringify(done)}\n\n`);
res.write('data: [DONE]\n\n');
res.end();
  } catch (err) {
    console.error('vapi-webhook error', err);
    res.status(500).json({
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: "I'm sorry, I'm having trouble right now. Let me have our team call you back." },
          finish_reason: 'stop',
        },
      ],
    });
  }
});app.get('/', (req, res) => {
  res.send('Ada phone backend is running.');
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', hasGeminiKey: Boolean(GEMINI_API_KEY), hasDatabase: Boolean(pool) });
});

// ---------- Businesses ----------
// GET /api/businesses/:slug — fetch a business's profile (used on app load)
app.get('/api/businesses/:slug', async (req, res) => {
  try {
    const business = await resolveBusiness(req.params.slug);
    if (!business) return res.status(404).json({ error: 'Business not found' });
    if (!checkAccess(business, req, res)) return;
    res.json(business);
  } catch (err) {
    console.error('fetch business error', err);
    res.status(500).json({ error: 'Could not fetch business' });
  }
});

// POST /api/businesses — create a new business (onboarding a new client).
// Each one gets its own slug and, optionally, its own access code.
app.post('/api/businesses', async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'No database connected.' });
    const { slug, business_name, business_type, access_code } = req.body;
    if (!slug || !slug.trim()) return res.status(400).json({ error: 'slug is required' });
    const { rows } = await pool.query(
      `INSERT INTO businesses (slug, business_name, business_type, access_code)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (slug) DO NOTHING
       RETURNING *`,
      [slug.trim(), business_name || 'My Business', business_type || null, access_code || null]
    );
    if (rows[0]) return res.status(201).json(rows[0]);
    // already existed — just return it
    const existing = await resolveBusiness(slug.trim());
    res.json(existing);
  } catch (err) {
    console.error('create business error', err);
    res.status(500).json({ error: 'Could not create business' });
  }
});

// PUT /api/businesses/:slug — update profile fields, or set/change the access code
app.put('/api/businesses/:slug', async (req, res) => {
  try {
    if (!pool) return res.status(500).json({ error: 'No database connected.' });
    const business = await resolveBusiness(req.params.slug);
    if (!checkAccess(business, req, res)) return;
    const { business_name, business_type, access_code } = req.body;
    const update = {};
    if (business_name !== undefined) update.business_name = business_name;
    if (business_type !== undefined) update.business_type = business_type;
    if (access_code !== undefined) update.access_code = access_code || null;
    const setClauses = Object.keys(update).map((k, i) => `${k} = $${i + 2}`).join(', ');
    if (!setClauses) return res.json(business);
    const { rows } = await pool.query(
      `UPDATE businesses SET ${setClauses} WHERE slug = $1 RETURNING *`,
      [req.params.slug, ...Object.values(update)]
    );
    res.json(rows[0]);
  } catch (err) {
    console.error('update business error', err);
    res.status(500).json({ error: 'Could not update business' });
  }
});

// ---------- Dashboard-facing API ----------
// FIX: each route now resolves the business from ?biz=slug and checks that
// SPECIFIC business's access_code — replaces the old single shared
// DASHBOARD_ACCESS_CODE, which would have forced every business sharing
// this backend to use the same password (meaning any of them could see any
// other's data). Real Twilio calls still log under the 'default' business
// until real per-number multi-tenant call routing is built.

app.get('/api/calls', withBusiness, (req, res) => {
  const filtered = callHistory.filter(c => (c.businessId || 'default') === (req.business ? req.business.slug : 'default'));
  res.json({ calls: filtered.slice().reverse().slice(0, 50) });
});

app.get('/api/messages', withBusiness, (req, res) => {
  const filtered = managerMessages.filter(m => (m.businessId || 'default') === (req.business ? req.business.slug : 'default'));
  res.json({ messages: filtered.slice().reverse() });
});

// Generic storage for dashboard data (rooms, bookings, guest notes, business
// profile). The frontend keeps a localStorage copy for instant loading, but
// this is the real source of truth so data survives clearing browser data,
// switching devices, or the backend restarting.
app.get('/api/storage/:key', withBusiness, async (req, res) => {
  try {
    const value = await kvGet(req.params.key);
    res.json({ key: req.params.key, value });
  } catch (err) {
    console.error('storage read error', err);
    res.status(500).json({ error: 'Storage read failed.' });
  }
});

app.put('/api/storage/:key', withBusiness, async (req, res) => {
  try {
    const { value } = req.body;
    if (typeof value !== 'string') return res.status(400).json({ error: 'value must be a string.' });
    await kvSet(req.params.key, value);
    res.json({ ok:true });
  } catch (err) {
    console.error('storage write error', err);
    res.status(500).json({ error: 'Storage write failed.' });
  }
});

app.listen(PORT, () => {
  console.log(`Ada phone backend listening on port ${PORT}`);
});
