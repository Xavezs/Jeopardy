const crypto = require('node:crypto');

const TICKET_TTL_SECONDS = 60;
const GUEST_PREFIX = 'guest_';
const PLATFORMS = new Set(['web', 'activity']);

// Guest ids are minted only by the server (auth.js POST /guest). Discord ids are numeric snowflakes, so they can never collide.
const isGuestId = (id) => typeof id === 'string' && id.startsWith(GUEST_PREFIX);

// Stable, server-derived display name for a guest. Never taken from the client.
function guestNameFor(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return 'Guest-' + String(h % 10000).padStart(4, '0');
}

function ticketKey(secret) {
  return crypto.createHmac('sha256', String(secret)).update('socket-ticket').digest('hex');
}

// `platform` ('web' | 'activity') is copied from the signed session so the socket knows where the user came from.
function signTicket(jwt, secret, userId, platform) {
  const claims = { id: String(userId), purpose: 'socket' };
  if (PLATFORMS.has(platform)) claims.src = platform;
  return jwt.sign(claims, ticketKey(secret), { expiresIn: TICKET_TTL_SECONDS });
}

function verifyTicketClaims(jwt, secret, ticket) {
  try {
    const p = jwt.verify(ticket, ticketKey(secret), { algorithms: ['HS256'] });
    if (!(p && p.purpose === 'socket' && p.id)) return null;
    return { id: String(p.id), platform: PLATFORMS.has(p.src) ? p.src : null };
  } catch {
    return null;
  }
}

function verifyTicket(jwt, secret, ticket) {
  return verifyTicketClaims(jwt, secret, ticket)?.id ?? null;
}

function parseCookies(header) {
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try { out[k] = decodeURIComponent(part.slice(i + 1).trim()); } catch { out[k] = part.slice(i + 1).trim(); }
  }
  return out;
}

function createHostAuth({ db, jwt, secret, cookieName, allowUnverified = false, allowEditorHost = false, log = console }) {
  // Returns { id, platform } for a verified identity, or null. Order: ticket, connect-time identity, session cookie.
  function identityFor(socket, ticket) {
    if (typeof ticket === 'string' && ticket) {
      const claims = verifyTicketClaims(jwt, secret, ticket);
      if (claims) return claims;
    }
    if (socket.userId) return { id: String(socket.userId), platform: socket.platform || null }; // verified at connect time
    const token = parseCookies(socket.handshake?.headers?.cookie)[cookieName];
    if (token) {
      try {
        const p = jwt.verify(token, secret, { algorithms: ['HS256'] });
        if (p?.id) return { id: String(p.id), platform: PLATFORMS.has(p.src) ? p.src : null };
      } catch { /* invalid or expired cookie */ }
    }
    return null;
  }

  function userIdFor(socket, ticket) {
    return identityFor(socket, ticket)?.id ?? null;
  }

  function canHost(socket, roomCode, ticket) {
    if (allowUnverified) return { ok: true, reason: 'ALLOW_UNVERIFIED_HOST is on' };

    const userId = userIdFor(socket, ticket);
    if (!userId) return { ok: false, reason: 'not logged in (no valid ticket or cookie)' };
    if (isGuestId(userId)) return { ok: false, reason: 'guests cannot host', userId };

    let board;
    try {
      board = db.prepare('SELECT id, owner_id FROM boards WHERE UPPER(room_code) = ?').get(String(roomCode).toUpperCase());
    } catch (err) {
      log.error('[hostAuth] board lookup failed:', err.message);
      return { ok: false, reason: 'board lookup failed' };
    }
    if (!board) return { ok: false, reason: 'room code does not belong to any board' };
    if (board.owner_id === userId) return { ok: true, userId };

    if (allowEditorHost) {
      try {
        const m = db.prepare('SELECT role FROM board_members WHERE board_id = ? AND user_id = ?').get(board.id, userId);
        if (m && m.role === 'editor') return { ok: true, userId };
      } catch (err) {
        log.error('[hostAuth] member lookup failed:', err.message);
      }
    }
    return { ok: false, reason: 'not an owner or editor of this board', userId };
  }

  return { canHost, userIdFor, identityFor };
}

module.exports = { createHostAuth, signTicket, verifyTicket, verifyTicketClaims, parseCookies, isGuestId, guestNameFor, GUEST_PREFIX, TICKET_TTL_SECONDS };
