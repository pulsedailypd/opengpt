require('dotenv').config();
const express = require('express');
const path = require('path');
const { Readable } = require('stream');
const admin = require('firebase-admin');

const {
  FIREBASE_PROJECT_ID,
  AI_API_KEY,
  AI_BASE_URL = 'https://api.openai.com/v1',
  AI_MODEL = 'gpt-4o-mini',
  PORT = 3000,
} = process.env;

if (!FIREBASE_PROJECT_ID || !AI_API_KEY) {
  console.error('Missing FIREBASE_PROJECT_ID or AI_API_KEY. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

// Verifying ID tokens only needs the project id (Google's public keys are fetched automatically).
admin.initializeApp({ projectId: FIREBASE_PROJECT_ID });

const SYSTEM_PROMPT =
  'You are OpenGPT, a helpful, concise and friendly AI assistant. Use Markdown for formatting and code blocks for code.';

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// --- Auth middleware: every API call must carry a valid Firebase ID token ---
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Please log in to continue.' });
  try {
    req.user = await admin.auth().verifyIdToken(token);
    next();
  } catch {
    res.status(401).json({ error: 'Your session expired. Please log in again.' });
  }
}

// --- Tiny per-user rate limit (30 requests / minute). Swap for a real limiter in production. ---
const hits = new Map();
function rateLimit(req, res, next) {
  const now = Date.now();
  const list = (hits.get(req.user.uid) || []).filter((t) => now - t < 60_000);
  if (list.length >= 30) return res.status(429).json({ error: 'Too many messages. Wait a moment and try again.' });
  list.push(now);
  hits.set(req.user.uid, list);
  next();
}

app.post('/api/chat', requireAuth, rateLimit, async (req, res) => {
  const { messages } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 100) {
    return res.status(400).json({ error: 'Invalid messages.' });
  }
  const clean = messages
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, 20000) }));
  if (!clean.length) return res.status(400).json({ error: 'Empty conversation.' });

  const ctrl = new AbortController();
  res.on('close', () => ctrl.abort());

  try {
    const upstream = await fetch(`${AI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_API_KEY}` },
      body: JSON.stringify({
        model: AI_MODEL,
        stream: true,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...clean],
      }),
      signal: ctrl.signal,
    });

    if (!upstream.ok) {
      const detail = await upstream.text();
      console.error('Upstream error', upstream.status, detail.slice(0, 500));
      return res.status(502).json({ error: `The AI service returned an error (${upstream.status}). Check your API key and model name.` });
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    Readable.fromWeb(upstream.body).pipe(res);
  } catch (err) {
    if (err.name === 'AbortError') return;
    console.error(err);
    if (!res.headersSent) res.status(502).json({ error: 'Could not reach the AI service.' });
    else res.end();
  }
});

app.listen(PORT, () => console.log(`OpenGPT running at http://localhost:${PORT}`));
