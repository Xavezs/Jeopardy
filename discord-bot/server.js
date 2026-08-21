// discord-bot/server.js
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');

const { router: authRouter } = require('./auth');
const boardsRouter = require('./boards');
const mediaRouter = require('./media');

const PORT = process.env.API_PORT || 3001;
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5173';

const app = express();

app.use(
  cors({
    origin: FRONTEND_URL,
    credentials: true,
  })
);
app.use(cookieParser());
app.use(express.json());

// =========================================================================
// IMAGE PROXY ROUTE (Bypasses Discord Activity CSP for external images)
// =========================================================================
app.get('/api/proxy-image', async (req, res) => {
  const imageUrl = req.query.url;
  if (!imageUrl) {
    return res.status(400).send('Missing url query parameter');
  }

  try {
    const response = await fetch(imageUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      },
    });

    if (!response.ok) {
      return res.status(response.status).send('Failed to fetch remote image');
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const arrayBuffer = await response.arrayBuffer();

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
    return res.send(Buffer.from(arrayBuffer));
  } catch (err) {
    console.error('[Proxy Image Error]:', err);
    return res.status(500).send('Internal Server Error while proxying image');
  }
});

// =========================================================================
// YouTube IFrame API proxy — same as bot-server.js, see comments there.
// =========================================================================
let ytApiCache = { body: null, fetchedAt: 0 };
const YT_API_CACHE_MS = 60 * 60 * 1000;

app.get('/api/youtube-iframe-api.js', async (_req, res) => {
  try {
    const now = Date.now();
    if (!ytApiCache.body || now - ytApiCache.fetchedAt > YT_API_CACHE_MS) {
      const resp = await fetch('https://www.youtube.com/iframe_api');
      if (!resp.ok) {
        return res.status(502).send('Failed to fetch YouTube IFrame API');
      }
      const rawText = await resp.text();
      
      // Rewrite any hardcoded widgetapi URL (from s.ytimg.com or www.youtube.com)
      // to go through our same-origin proxy route.
      const widgetApiRegex = /https?:\/\/[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_\-\/.]+\/www-widgetapi\.js/g;
      const modifiedText = rawText.replace(widgetApiRegex, (match) => {
        return `/api/youtube-widgetapi.js?url=${encodeURIComponent(match)}`;
      });

      ytApiCache = { body: modifiedText, fetchedAt: now };
    }
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.send(ytApiCache.body);
  } catch (err) {
    console.error('[YouTube API proxy] error:', err);
    return res.status(500).send('Internal error proxying YouTube IFrame API');
  }
});

app.get('/api/youtube-widgetapi.js', async (req, res) => {
  const url = req.query.url;
  if (!url) {
    return res.status(400).send('Missing url query parameter');
  }

  // Validate the URL to prevent SSRF (allow s.ytimg.com and youtube.com)
  const isAllowedHost = url.startsWith('https://s.ytimg.com/') || 
                       url.startsWith('https://www.youtube.com/') || 
                       url.startsWith('https://youtube.com/');
  if (!isAllowedHost) {
    return res.status(400).send('Invalid url');
  }

  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      return res.status(502).send('Failed to fetch YouTube widgetapi script');
    }
    const body = await resp.text();
    res.setHeader('Content-Type', 'application/javascript; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=86400'); // Cache for 24 hours
    return res.send(body);
  } catch (err) {
    console.error('[YouTube widgetapi proxy] error:', err);
    return res.status(500).send('Internal error proxying YouTube widgetapi');
  }
});

// FIX: was mounted at '/auth', but every frontend caller (discordSdk.js,
// LoginGate.jsx, sessionStore.js's api()) requests '/api/auth/...' —
// e.g. POST /api/auth/token, POST /api/auth/dev-login. The mismatch meant
// those calls 404'd against this server. Mounting here under '/api/auth'
// matches the routes actually defined inside auth.js (/token, /discord,
// /discord/callback, /logout, /me, /dev-login) with what the client
// already calls, with no client-side changes needed.
app.use('/api/auth', authRouter);
app.use('/api/boards', boardsRouter);
app.use('/api/media', mediaRouter);

app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`API server listening on http://localhost:${PORT}`);
});