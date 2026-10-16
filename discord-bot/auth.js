const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('node:crypto');
const { signTicket, isGuestId, guestNameFor, GUEST_PREFIX } = require('./hostAuth');

// 1. Initialize Express Router
const router = express.Router();

// 2. Load Environment Variables
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || process.env.CLIENT_SECRET;
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI;
const SESSION_SECRET = process.env.SESSION_SECRET || ephemeralSecret();
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5180';
// FRONTEND_URL may hold several comma-separated origins (CORS allowlist); redirect to the first.
const FRONTEND_REDIRECT = FRONTEND_URL.split(',')[0].trim();

function ephemeralSecret() {
  console.warn('[auth] SESSION_SECRET is not set - using a random per-boot secret. Set SESSION_SECRET in .env (32+ random chars).');
  return require('node:crypto').randomBytes(48).toString('hex');
}
if (process.env.SESSION_SECRET && process.env.SESSION_SECRET.length < 16) {
  console.warn('[auth] SESSION_SECRET is shorter than 16 characters - use a long random value.');
}

const COOKIE_NAME = 'jeopardy_session';
const OAUTH_STATE_COOKIE = 'jeopardy_oauth_state';
const SCOPES = 'identify';

// Web guests: low-privilege identities minted by the server. Set ALLOW_GUESTS=0 to disable.
const GUESTS_ENABLED = process.env.ALLOW_GUESTS !== '0';
const GUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const GUEST_RATE = { windowMs: 60 * 60 * 1000, max: 10 }; // new guest sessions per IP per window
// Set WEB_COOKIE_CROSS_SITE=1 only if the web frontend and this API are on different sites (e.g. Vercel frontend calling the API directly
// via VITE_API_URL). Same-origin setups (Vite proxy / tunnel) should leave it off so cookies stay SameSite=Lax.
const CROSS_SITE_WEB = process.env.WEB_COOKIE_CROSS_SITE === '1';

const guestHits = new Map();
setInterval(() => {
  const now = Date.now();
  for (const [ip, h] of guestHits) if (h.resetAt <= now) guestHits.delete(ip);
}, 10 * 60 * 1000).unref();
function guestRateLimited(ip) {
  const now = Date.now();
  let h = guestHits.get(ip);
  if (!h || h.resetAt <= now) { h = { count: 0, resetAt: now + GUEST_RATE.windowMs }; guestHits.set(ip, h); }
  h.count += 1;
  return h.count > GUEST_RATE.max;
}

// Shape sent to the client. `platform` comes from the signed session; `guest` from the server-minted id prefix.
function publicUser(p) {
  return {
    id: p.id,
    username: p.username,
    avatarUrl: p.avatarUrl || null,
    platform: p.src === 'web' ? 'web' : 'activity',
    guest: isGuestId(p.id),
  };
}

function buildAvatarUrl(discordUser) {
  if (discordUser.avatar) {
    const ext = discordUser.avatar.startsWith('a_') ? 'gif' : 'png';
    return `https://cdn.discordapp.com/avatars/${discordUser.id}/${discordUser.avatar}.${ext}`;
  }
  const discriminator = Number(discordUser.discriminator || 0);
  const defaultIndex =
    discriminator > 0 ? discriminator % 5 : Number((BigInt(discordUser.id) >> 22n) % 6n);
  return `https://cdn.discordapp.com/embed/avatars/${defaultIndex}.png`;
}

function cookieOptions(req) {
  const isDiscordActivity = req.get('x-discord-activity') === '1';
  const crossSite = isDiscordActivity || CROSS_SITE_WEB;
  return {
    httpOnly: true,
    sameSite: crossSite ? 'none' : 'lax',
    secure: crossSite,
    partitioned: crossSite,
    maxAge: 30 * 24 * 60 * 60 * 1000,
  };
}

// 1. DISCORD ACTIVITY OAUTH (SDK Token Exchange)
router.post('/token', async (req, res) => {
  const { code } = req.body;
  if (!code) return res.status(400).json({ error: 'Missing authorization code' });

  try {
    const tokenResponse = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code: code,
      }),
    });

    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok) {
      console.error('Discord token exchange raw response:', tokenResponse.status, tokenData); // TEMP DEBUG
      throw new Error(tokenData.error_description || 'Token exchange failed');
    }

    // Fetch authenticated user profile
    const userResponse = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    const userData = await userResponse.json();
    if (!userResponse.ok) {
      console.error('Discord /users/@me failed:', userResponse.status, userData); // TEMP DEBUG
      throw new Error(userData.message || 'Failed to fetch Discord user profile');
    }

    const user = {
      id: userData.id,
      username: userData.global_name || userData.username,
      avatarUrl: buildAvatarUrl(userData),
    };

    // CRITICAL FIX: Sign JWT & Attach Cookie
    const token = jwt.sign({ ...user, src: 'activity' }, SESSION_SECRET, { expiresIn: '30d' });
    res.cookie(COOKIE_NAME, token, cookieOptions(req));

    return res.json({ user, access_token: tokenData.access_token });
  } catch (err) {
    console.error('Activity auth error:', err);
    return res.status(500).json({ error: err.message });
  }
});

// 2. STANDARD WEB BROWSER OAUTH2 FLOW

router.get('/discord', (req, res) => {
  // `state` ties the callback to this browser (blocks login CSRF)
  const state = crypto.randomBytes(16).toString('hex');
  res.cookie(OAUTH_STATE_COOKIE, state, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 10 * 60 * 1000 });
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    redirect_uri: DISCORD_REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES,
    state,
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`);
});

router.get('/discord/callback', async (req, res) => {
  const { code, state } = req.query;
  const expectedState = req.cookies?.[OAUTH_STATE_COOKIE];
  res.clearCookie(OAUTH_STATE_COOKIE);
  if (!code) return res.status(400).send('Missing code');
  if (
    typeof state !== 'string' || typeof expectedState !== 'string' ||
    state.length !== expectedState.length ||
    !crypto.timingSafeEqual(Buffer.from(state), Buffer.from(expectedState))
  ) {
    return res.status(400).send('Invalid login state. Please start the login again.');
  }

  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        grant_type: 'authorization_code',
        code,
        redirect_uri: DISCORD_REDIRECT_URI,
      }),
    });

    if (!tokenRes.ok) {
      console.error('Token exchange failed:', await tokenRes.text());
      return res.status(502).send('Discord token exchange failed');
    }

    const { access_token } = await tokenRes.json();

    const userRes = await fetch('https://discord.com/api/users/@me', {
      headers: { Authorization: `Bearer ${access_token}` },
    });
    const discordUser = await userRes.json();
    if (!userRes.ok) {
      console.error('Discord /users/@me failed:', userRes.status, discordUser); // TEMP DEBUG
      return res.status(502).send('Failed to fetch Discord user profile');
    }

    const sessionUser = {
      id: discordUser.id,
      username: discordUser.username,
      avatarUrl: buildAvatarUrl(discordUser),
    };

    const token = jwt.sign({ ...sessionUser, src: 'web' }, SESSION_SECRET, { expiresIn: '30d' });
    res.cookie(COOKIE_NAME, token, cookieOptions(req));

    res.redirect(FRONTEND_REDIRECT);
  } catch (err) {
    console.error('Discord auth error:', err);
    res.status(500).send('Login failed');
  }
});

// Log out: Clear cookie
router.post('/logout', (req, res) => {
  res.clearCookie(COOKIE_NAME, cookieOptions(req));
  res.json({ ok: true });
});

// 3. MIDDLEWARE & USER STATE

function requireAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (!token) return res.status(401).json({ error: 'Not logged in' });
  try {
    req.user = jwt.verify(token, SESSION_SECRET, { algorithms: ['HS256'] });
    next();
  } catch {
    res.clearCookie(COOKIE_NAME, cookieOptions(req));
    res.status(401).json({ error: 'Session expired' });
  }
}

function optionalAuth(req, res, next) {
  const token = req.cookies?.[COOKIE_NAME];
  if (token) {
    try {
      req.user = jwt.verify(token, SESSION_SECRET, { algorithms: ['HS256'] });
    } catch {
      res.clearCookie(COOKIE_NAME, cookieOptions(req));
    }
  }
  next();
}

// Like requireAuth, but rejects guests (boards, uploads, shop).
function requireAccount(req, res, next) {
  requireAuth(req, res, () => {
    if (isGuestId(req.user.id)) return res.status(403).json({ error: 'Guests cannot do this. Log in with Discord.' });
    next();
  });
}

// WEB GUEST SESSION: server-minted identity for browser players. Not available inside the Discord Activity.
router.post('/guest', (req, res) => {
  if (!GUESTS_ENABLED) return res.status(404).json({ error: 'Not found' });
  if (req.get('x-discord-activity') === '1') return res.status(403).json({ error: 'Guests are web-only' });

  // Reuse a valid existing session instead of minting a new one (stops farming guest ids by refreshing)
  const existing = req.cookies?.[COOKIE_NAME];
  if (existing) {
    try {
      return res.json({ user: publicUser(jwt.verify(existing, SESSION_SECRET, { algorithms: ['HS256'] })) });
    } catch { /* expired or invalid: fall through and mint a fresh guest */ }
  }

  if (guestRateLimited(req.ip)) return res.status(429).json({ error: 'Too many guest sessions from this network. Try again later.' });

  const id = GUEST_PREFIX + crypto.randomBytes(12).toString('hex');
  const user = { id, username: guestNameFor(id), avatarUrl: null };
  const token = jwt.sign({ ...user, src: 'web' }, SESSION_SECRET, { expiresIn: Math.floor(GUEST_TTL_MS / 1000) });
  res.cookie(COOKIE_NAME, token, { ...cookieOptions(req), maxAge: GUEST_TTL_MS });
  return res.json({ user: publicUser({ ...user, src: 'web' }) });
});

router.get('/socket-ticket', requireAuth, (req, res) => {
  res.json({ ticket: signTicket(jwt, SESSION_SECRET, req.user.id, req.user.src) });
});

router.get('/me', optionalAuth, (req, res) => {
  res.json({ user: req.user ? publicUser(req.user) : null });
});
router.post('/dev-login', (req, res) => {
  if (process.env.ENABLE_DEV_LOGIN !== '1') return res.status(404).json({ error: 'Not found' });
  const mockUser = {
    id: "mock_user_123",
    username: "LocalDevUser",
    avatarUrl: "https://cdn.discordapp.com/embed/avatars/0.png",
  };

  const token = jwt.sign({ ...mockUser, src: 'web' }, SESSION_SECRET, { expiresIn: '30d' });
  res.cookie(COOKIE_NAME, token, cookieOptions(req));
  return res.json({ user: mockUser });
});
module.exports = { router, requireAuth, requireAccount, optionalAuth, COOKIE_NAME, SESSION_SECRET };