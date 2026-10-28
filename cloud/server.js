'use strict';

const express = require('express');
const path = require('node:path');
const sitePaletteRouter = require('./site-palette');

const app = express();
// Render sits behind a trusted proxy; this lets Express use the forwarded client IP
// for rate limiting. Keep this value appropriate for your hosting topology.
app.set('trust proxy', 1);
const ROOT = path.resolve(__dirname, '..');
const PORT = Number(process.env.PORT || 3210);
const HOST = '0.0.0.0';

// Keep request bodies small; the palette endpoint only needs a website URL.
app.use(express.json({ limit: '32kb' }));

// Basic in-memory rate limiter for the public palette endpoint.
// For multiple Render instances, use a shared store such as Redis instead.
const WINDOW_MS = 60 * 1000;
const MAX_REQUESTS_PER_WINDOW = 30;
const requestBuckets = new Map();

function paletteRateLimit(req, res, next) {
  const now = Date.now();
  const key = req.ip || req.socket.remoteAddress || 'unknown';
  let bucket = requestBuckets.get(key);

  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + WINDOW_MS };
    requestBuckets.set(key, bucket);
  }

  bucket.count += 1;
  res.setHeader('RateLimit-Limit', String(MAX_REQUESTS_PER_WINDOW));
  res.setHeader('RateLimit-Remaining', String(Math.max(0, MAX_REQUESTS_PER_WINDOW - bucket.count)));

  if (bucket.count > MAX_REQUESTS_PER_WINDOW) {
    res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
    return res.status(429).json({ ok: false, message: 'Too many requests. Please try again shortly.' });
  }

  // Opportunistically remove expired entries so this map does not grow forever.
  if (requestBuckets.size > 5000) {
    for (const [ip, item] of requestBuckets) {
      if (now >= item.resetAt) requestBuckets.delete(ip);
    }
  }

  next();
}

// Restrict browser access to the configured frontend origin, if provided.
// CORS is not authentication; it does not stop curl or other server-side clients.
const allowedOrigin = process.env.FRONTEND_ORIGIN;
app.use((req, res, next) => {
  const origin = req.get('Origin');

  if (origin && (!allowedOrigin || origin !== allowedOrigin)) {
    return res.status(403).json({ ok: false, message: 'Origin not allowed.' });
  }

  if (origin && allowedOrigin && origin === allowedOrigin) {
    res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
    res.setHeader('Vary', 'Origin');
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use('/api', paletteRateLimit, sitePaletteRouter);

app.get('/', (req, res) => {
  res.sendFile(path.join(ROOT, 'text-to-mailer.html'));
});

app.get('/logo.png', (req, res) => {
  res.sendFile(path.join(ROOT, 'logo.png'));
});

app.get('/health', (req, res) => {
  res.json({ ok: true, service: 'text-to-mailer-cloud' });
});

app.use((req, res) => {
  res.status(404).json({ ok: false, message: 'Route not found.' });
});

app.use((err, req, res, next) => {
  console.error('Unhandled request error:', err.message);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, message: 'Internal server error.' });
});

app.listen(PORT, HOST, () => {
  console.log(`Text-to-Mailer cloud server listening on ${HOST}:${PORT}`);
});
