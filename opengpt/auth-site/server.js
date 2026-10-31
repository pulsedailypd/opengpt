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
  AI_VISION_MODEL = '',
  PORT = 3000,
} = process.env;

if (!FIREBASE_PROJECT_ID || !AI_API_KEY) {
  console.error('Missing FIREBASE_PROJECT_ID or AI_API_KEY. Copy .env.example to .env and fill it in.');
  process.exit(1);
}
console.log(`AI config -> base: ${AI_BASE_URL} | model: ${AI_MODEL} | vision: ${AI_VISION_MODEL || 'not set'} | key starts with: ${AI_API_KEY.slice(0, 4)}`);

// Verifying ID tokens only needs the project id (Google's public keys are fetched automatically).
admin.initializeApp({ projectId: FIREBASE_PROJECT_ID });

const SYSTEM_PROMPT =
  'You are OpenGPT, a helpful, concise and friendly AI assistant. Use Markdown for formatting and code blocks for code.';

const app = express();
app.use(express.json({ limit: '14mb' })); // images arrive as resized base64
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

// --- Message validation ---
const MAX_IMAGES = 3;
const MAX_IMAGE_CHARS = 2_500_000;
const IMAGE_RE = /^data:image\/(jpeg|png|webp|gif);base64,/;

function cleanMessage(m) {
  if (!m || (m.role !== 'user' && m.role !== 'assistant')) return null;
  if (typeof m.content === 'string') {
    return m.content.trim() ? { role: m.role, content: m.content.slice(0, 20000) } : null;
  }
  if (m.role === 'user' && Array.isArray(m.content)) {
    const parts = [];
    let images = 0;
    for (const p of m.content) {
      if (p && p.type === 'text' && typeof p.text === 'string') {
        parts.push({ type: 'text', text: p.text.slice(0, 20000) });
      } else if (
        p && p.type === 'image_url' && p.image_url && typeof p.image_url.url === 'string' &&
        IMAGE_RE.test(p.image_url.url) && p.image_url.url.length < MAX_IMAGE_CHARS && images < MAX_IMAGES
      ) {
        parts.push({ type: 'image_url', image_url: { url: p.image_url.url } });
        images++;
      }
    }
    return parts.length ? { role: 'user', content: parts } : null;
  }
  return null;
}

app.post('/api/chat', requireAuth, rateLimit, async (req, res) => {
  const { messages, instructions } = req.body || {};
  if (!Array.isArray(messages) || messages.length === 0 || messages.length > 100) {
    return res.status(400).json({ error: 'Invalid messages.' });
  }
  const clean = messages.map(cleanMessage).filter(Boolean);
  if (!clean.length) return res.status(400).json({ error: 'Empty conversation.' });

  const hasImages = clean.some((m) => Array.isArray(m.content));
  if (hasImages && !AI_VISION_MODEL) {
    return res.status(400).json({
      error: 'Image upload is not set up yet. The server owner must set AI_VISION_MODEL to a model that accepts images.',
    });
  }

  const extra = typeof instructions === 'string' ? instructions.trim().slice(0, 1500) : '';
  const system = extra
    ? `${SYSTEM_PROMPT}\n\nThe user set these custom instructions. Follow them when they do not conflict with safety:\n${extra}`
    : SYSTEM_PROMPT;

  const ctrl = new AbortController();
  res.on('close', () => ctrl.abort());

  try {
    const upstream = await fetch(`${AI_BASE_URL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_API_KEY}` },
      body: JSON.stringify({
        model: hasImages ? AI_VISION_MODEL : AI_MODEL,
        stream: true,
        messages: [{ role: 'system', content: system }, ...clean],
      }),
      signal: ctrl.signal,
    });

    if (!upstream.ok) {
      const detail = await upstream.text();
      console.error('Upstream error', upstream.status, detail.slice(0, 500));
      let reason = '';
      try { reason = JSON.parse(detail).error?.message || ''; } catch { /* not JSON */ }
      return res.status(502).json({
        error: `AI provider error ${upstream.status}: ${reason || 'check your API key, model name and quota.'}`,
      });
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
