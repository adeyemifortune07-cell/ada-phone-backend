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

function extractManagerMessage(reply, from, businessId = 'default') {
  const match = reply.match(/###MESSAGE(\{[\s\S]*?\})###/);
  if (!match) return reply;
  try {
    const parsed = JSON.parse(match[1]);
    managerMessages.push({
      id: 'msg' + Date.now() + Math.round(Math.random() * 1000),
      businessId: businessId,
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
  console.log('STATUS CALLBACK:', req.body);
  const callSid = req.body.CallSid;
  if (req.body.CallStatus === 'completed' && conversations.has(callSid)) {
    finishCall(callSid, req.body.From, 'dropped');
  }
  res.sendStatus(200);
});

// ---------- Vapi dashboard synchronization helpers ----------
function slugifyBusiness(value) {
  return String(value || 'default').trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'default';
}
function vapiBusinessSlug(req) {
  // Prefer explicit Vapi metadata, then Render configuration. Do not silently
  // bind a newly connected number to the old Palm Court/default placeholder.
  const call = req.body?.call || {};
  const metadata = {
    ...(req.body?.metadata || {}),
    ...(call.metadata || {}),
    ...(req.body?.assistant?.metadata || {}),
  };
  const configured = req.query.biz || metadata.businessSlug || metadata.business_slug
    || process.env.VAPI_BUSINESS_SLUG;
  if (!configured) {
    console.warn('Vapi business slug is not configured; using BUSINESS_NAME fallback:', BUSINESS_NAME);
  }
  return slugifyBusiness(configured || BUSINESS_NAME);
}
async function saveVapiCall(callId, from, businessId, turns) {
  const id = callId || 'vapi-' + Date.now();
  const existing = callHistory.find(c => c.id === id);
  if (existing) {
    existing.turns = Math.max(existing.turns || 0, turns || 0);
    existing.at = new Date().toISOString();
  } else {
    callHistory.push({ id, businessId, from: from || 'unknown', at: new Date().toISOString(), durationSeconds: null, turns: turns || 0, outcome: 'inquiry', source: 'vapi' });
  }
  await kvSet('live:calls', JSON.stringify(callHistory));
}
function findConfiguredRoom(rooms, name) {
  if (!name) return null;
  const n = String(name).toLowerCase().trim();
  return rooms.find(r => String(r.name || '').toLowerCase() === n)
    || rooms.find(r => n.includes(String(r.name || '').toLowerCase()))
    || rooms.find(r => String(r.name || '').toLowerCase().includes(n)) || null;
}
async function saveVapiBooking(parsed, businessId) {
  if (!parsed || !parsed.roomName) return false;
  const key = `bookings:${businessId}`;
  let bookings = [];
  let rooms = [];
  try { bookings = JSON.parse((await kvGet(key)) || '[]'); } catch (e) {}
  try { rooms = JSON.parse((await kvGet(`rooms:${businessId}`)) || '[]'); } catch (e) {}
  const room = findConfiguredRoom(rooms, parsed.roomName);
  const booking = {
    id: 'vapi-bk-' + Date.now(),
    roomId: room ? room.id : String(parsed.roomName).toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    roomName: room ? room.name : parsed.roomName,
    guest: parsed.guest || '', phone: parsed.phone || '',
    checkin: parsed.checkin || '', nights: parsed.nights || 1,
    status: 'confirmed', createdAt: new Date().toISOString(), source: 'vapi'
  };
  bookings.push(booking);
  await kvSet(key, JSON.stringify(bookings));
  return true;
}
function extractVapiBooking(reply) {
  const match = String(reply || '').match(/###BOOKING(\{[\s\S]*?\})###/);
  if (!match) return { reply, booking: null };
  try { return { reply: reply.replace(match[0], '').trim(), booking: JSON.parse(match[1]) }; }
  catch (e) { console.warn('Vapi booking parse error:', e.message); return { reply: reply.replace(match[0], '').trim(), booking: null }; }
}

// ---------- Vapi custom LLM webhook ----------
// Vapi sends an OpenAI-style { messages: [...] } payload here for every
// turn of the call, and expects an OpenAI-style chat completion back.
// This reuses Ada's real brain (askGemini + SYSTEM_PROMPT + message logging)
// instead of Vapi's built-in generic assistant.
app.post('/vapi-webhook/chat/completions', async (req, res) => {
  const businessId = vapiBusinessSlug(req);
  const call = req.body.call || {};
  const callId = call.id || req.body.callId || req.body.call_id || `vapi-${Date.now()}`;
  const from = call.customer?.number || call.from || req.body.from || 'vapi-call';
  try {
    const messages = Array.isArray(req.body.messages) ? req.body.messages : [];
    const history = messages.filter(m => m.role !== 'system').map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content || ''
    }));
    await saveVapiCall(callId, from, businessId, history.length);
    let systemPrompt = messages.find(m => m.role === 'system')?.content || SYSTEM_PROMPT;
    systemPrompt += `\n\nBOOKING RULE: Only after the caller clearly confirms a booking, output exactly one machine tag on a new line at the end: ###BOOKING{"roomName":"<service or room>","guest":"<name>","phone":"<phone>","checkin":"<date/time>","nights":1}###. Never output this tag before confirmation. For complaints or unresolved requests, use ###MESSAGE{"from":"<name>","reason":"<summary>"}###.`;
    
