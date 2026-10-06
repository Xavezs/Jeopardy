const express = require('express'); //[cite: 2]
const jwt = require('jsonwebtoken');
const { signTicket } = require('./hostAuth'); //[cite: 2]

// 1. Initialize Express Router
const router = express.Router(); //[cite: 2]

// 2. Load Environment Variables (with fallbacks for both naming conventions)
const CLIENT_ID = process.env.DISCORD_CLIENT_ID || process.env.CLIENT_ID; //[cite: 2]
const CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET || process.env.CLIENT_SECRET; //[cite: 2]
const DISCORD_REDIRECT_URI = process.env.DISCORD_REDIRECT_URI; //[cite: 2]
const SESSION_SECRET = process.env.SESSION_SECRET || 'default_fallback_secret'; //[cite: 2]
const FRONTEND_URL = process.env.FRONTEND_URL || 'http://localhost:5180'; //[cite: 2]

const COOKIE_NAME = 'jeopardy_session'; //[cite: 2]
const SCOPES = 'identify'; //[cite: 2]

// Builds a per-user avatar URL from a Discord user object. Handles animated
// avatars (hash prefixed "a_" needs .gif, not .png — a .png request against
// an animated hash 404s) and, when there's no custom avatar, computes
// Discord's actual per-user default avatar instead of hardcoding everyone
// to embed/avatars/0.png (which made every avatar-less user look identical,
// like nothing had loaded). Modern (migrated) accounts have
// discriminator "0" and use (id >> 22) % 6; legacy accounts still on a
// 4-digit discriminator use discriminator % 5.
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

// A localhost page cannot store a Secure cookie. Discord Activities, on the
// other hand, are embedded cross-site and require a Secure, partitioned cookie.
function cookieOptions(req) {
  const isDiscordActivity = req.get('x-discord-activity') === '1';
  return {
    httpOnly: true,
    sameSite: isDiscordActivity ? 'none' : 'lax',
    secure: isDiscordActivity,
    partitioned: isDiscordActivity,
    maxAge: 30 * 24 * 60 * 60 * 1000,
  };
}

// =======================================================
// 1. DISCORD ACTIVITY OAUTH (SDK Token Exchange)
// =======================================================
// Used by @discord/embedded-app-sdk inside the Discord iframe
router.post('/token', async (req, res) => { //[cite: 2]
  const { code } = req.body; //[cite: 2]
  if (!code) return res.status(400).json({ error: 'Missing authorization code' }); //[cite: 2]

  try {
    // TEMP DEBUG — remove once invalid_request is resolved. Logs presence
    // (not the actual secret value) so we can see which of these three is
    // arriving empty/undefined without printing anything sensitive.
    console.log('TEMP DEBUG /token exchange inputs:', {
      hasClientId: Boolean(CLIENT_ID),
      hasClientSecret: Boolean(CLIENT_SECRET),
      codeLength: code ? code.length : 0,
    });

    // Exchange code for access token with Discord OAuth2
    const tokenResponse = await fetch('https://discord.com/api/v10/oauth2/token', { //[cite: 2]
      method: 'POST', //[cite: 2]
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, //[cite: 2]
      body: new URLSearchParams({ //[cite: 2]
        client_id: CLIENT_ID, //[cite: 2]
        client_secret: CLIENT_SECRET, //[cite: 2]
        grant_type: 'authorization_code', //[cite: 2]
        code: code, //[cite: 2]
      }),
    });

    const tokenData = await tokenResponse.json();
    if (!tokenResponse.ok) {
      console.error('Discord token exchange raw response:', tokenResponse.status, tokenData); // TEMP DEBUG
      throw new Error(tokenData.error_description || 'Token exchange failed');
    }

    // Fetch authenticated user profile
    const userResponse = await fetch('https://discord.com/api/v10/users/@me', { //[cite: 2]
      headers: { Authorization: `Bearer ${tokenData.access_token}` }, //[cite: 2]
    });

    const userData = await userResponse.json(); //[cite: 2]
    if (!userResponse.ok) {
      // Without this check, a failed/rate-limited/unauthorized call here
      // (userData becomes something like { message: "401: Unauthorized" })
      // silently fell through into building a `user` object with
      // id/username = undefined — which then made the player's avatar (and
      // even their whole entry) vanish for everyone, not just them, since
      // this is what gets broadcast to the room via joinAsPlayer.
      console.error('Discord /users/@me failed:', userResponse.status, userData); // TEMP DEBUG
      throw new Error(userData.message || 'Failed to fetch Discord user profile');
    }

    const user = { //[cite: 2]
      id: userData.id, //[cite: 2]
      username: userData.global_name || userData.username, //[cite: 2]
      avatarUrl: buildAvatarUrl(userData),
    };

    // --- CRITICAL FIX: Sign JWT & Attach Cookie ---
    const token = jwt.sign(user, SESSION_SECRET, { expiresIn: '30d' }); //[cite: 2]
    res.cookie(COOKIE_NAME, token, cookieOptions(req)); //[cite: 2]

    return res.json({ user, access_token: tokenData.access_token }); //[cite: 2]
  } catch (err) {
    console.error('Activity auth error:', err); //[cite: 2]
    return res.status(500).json({ error: err.message }); //[cite: 2]
  }
});

// =======================================================
// 2. STANDARD WEB BROWSER OAUTH2 FLOW
// =======================================================

// Step 1: Redirect user to Discord for browser login
router.get('/discord', (req, res) => { //[cite: 2]
  const params = new URLSearchParams({ //[cite: 2]
    client_id: CLIENT_ID, //[cite: 2]
    redirect_uri: DISCORD_REDIRECT_URI, //[cite: 2]
    response_type: 'code', //[cite: 2]
    scope: SCOPES, //[cite: 2]
  });
  res.redirect(`https://discord.com/api/oauth2/authorize?${params}`); //[cite: 2]
});

// Step 2: Discord redirects back here with authorization code
router.get('/discord/callback', async (req, res) => { //[cite: 2]
  const { code } = req.query; //[cite: 2]
  if (!code) return res.status(400).send('Missing code'); //[cite: 2]

  try {
    const tokenRes = await fetch('https://discord.com/api/oauth2/token', { //[cite: 2]
      method: 'POST', //[cite: 2]
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, //[cite: 2]
      body: new URLSearchParams({ //[cite: 2]
        client_id: CLIENT_ID, //[cite: 2]
        client_secret: CLIENT_SECRET, //[cite: 2]
        grant_type: 'authorization_code', //[cite: 2]
        code, //[cite: 2]
        redirect_uri: DISCORD_REDIRECT_URI, //[cite: 2]
      }),
    });

    if (!tokenRes.ok) { //[cite: 2]
      console.error('Token exchange failed:', await tokenRes.text()); //[cite: 2]
      return res.status(502).send('Discord token exchange failed'); //[cite: 2]
    }

    const { access_token } = await tokenRes.json(); //[cite: 2]

    const userRes = await fetch('https://discord.com/api/users/@me', { //[cite: 2]
      headers: { Authorization: `Bearer ${access_token}` }, //[cite: 2]
    });
    const discordUser = await userRes.json(); //[cite: 2]
    if (!userRes.ok) {
      console.error('Discord /users/@me failed:', userRes.status, discordUser); // TEMP DEBUG
      return res.status(502).send('Failed to fetch Discord user profile');
    }

    const sessionUser = { //[cite: 2]
      id: discordUser.id, //[cite: 2]
      username: discordUser.username, //[cite: 2]
      avatarUrl: buildAvatarUrl(discordUser),
    };

    const token = jwt.sign(sessionUser, SESSION_SECRET, { expiresIn: '30d' }); //[cite: 2]
    res.cookie(COOKIE_NAME, token, cookieOptions(req)); // Updated to support iframe embedding[cite: 2]

    res.redirect(FRONTEND_URL); //[cite: 2]
  } catch (err) {
    console.error('Discord auth error:', err); //[cite: 2]
    res.status(500).send('Login failed'); //[cite: 2]
  }
});

// Log out: Clear cookie
router.post('/logout', (req, res) => { //[cite: 2]
  res.clearCookie(COOKIE_NAME, cookieOptions(req)); //[cite: 2]
  res.json({ ok: true }); //[cite: 2]
});

// =======================================================
// 3. MIDDLEWARE & USER STATE
// =======================================================

function requireAuth(req, res, next) { //[cite: 2]
  const token = req.cookies?.[COOKIE_NAME]; //[cite: 2]
  if (!token) return res.status(401).json({ error: 'Not logged in' }); //[cite: 2]
  try {
    req.user = jwt.verify(token, SESSION_SECRET); //[cite: 2]
    next(); //[cite: 2]
  } catch {
    res.clearCookie(COOKIE_NAME, cookieOptions(req)); //[cite: 2]
    res.status(401).json({ error: 'Session expired' }); //[cite: 2]
  }
}

function optionalAuth(req, res, next) { //[cite: 2]
  const token = req.cookies?.[COOKIE_NAME]; //[cite: 2]
  if (token) {
    try {
      req.user = jwt.verify(token, SESSION_SECRET); //[cite: 2]
    } catch {
      res.clearCookie(COOKIE_NAME, cookieOptions(req)); //[cite: 2]
    }
  }
  next(); //[cite: 2]
}

// Short-lived proof of identity for the socket connection. The host client
// sends it with joinRoom so the server can verify who is claiming to host.
router.get('/socket-ticket', requireAuth, (req, res) => {
  res.json({ ticket: signTicket(jwt, SESSION_SECRET, req.user.id) });
});

router.get('/me', optionalAuth, (req, res) => { //[cite: 2]
  res.json({ user: req.user || null }); //[cite: 2]
});
router.post('/dev-login', (req, res) => {
  const mockUser = {
    id: "mock_user_123",
    username: "LocalDevUser",
    avatarUrl: "https://cdn.discordapp.com/embed/avatars/0.png",
  };

  const token = jwt.sign(mockUser, SESSION_SECRET, { expiresIn: '30d' });
  res.cookie(COOKIE_NAME, token, cookieOptions(req));
  return res.json({ user: mockUser });
});
module.exports = { router, requireAuth, optionalAuth, COOKIE_NAME, SESSION_SECRET }; //[cite: 2]