// Decides who may become HOST of a live room.
//
// The host owns scores and board state, so the role must not be self-declared.
// A socket may only become host if it proves a logged-in identity AND that
// identity owns (or is an editor of) the board whose invite code is the room
// code. Identity comes from a short-lived "socket ticket" the host client
// fetches over HTTP (where the login cookie already works, including inside
// Discord's iframe) and sends with joinRoom. The login cookie on the socket
// handshake is accepted as a fallback.
//
// Tickets are signed with a key DERIVED from the session secret, so a ticket
// can never be replayed as a login cookie and a login cookie can never be
// passed off as a ticket.

const crypto = require('node:crypto');

const TICKET_TTL_SECONDS = 60;

function ticketKey(secret) {
  return crypto.createHmac('sha256', String(secret)).update('socket-ticket').digest('hex');
}

function signTicket(jwt, secret, userId) {
  return jwt.sign({ id: String(userId), purpose: 'socket' }, ticketKey(secret), { expiresIn: TICKET_TTL_SECONDS });
}

function verifyTicket(jwt, secret, ticket) {
  try {
    const p = jwt.verify(ticket, ticketKey(secret));
    return p && p.purpose === 'socket' && p.id ? String(p.id) : null;
  } catch {
    return null;
  }
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

function createHostAuth({ db, jwt, secret, cookieName, allowUnverified = false, log = console }) {
  function userIdFor(socket, ticket) {
    if (typeof ticket === 'string' && ticket) {
      const id = verifyTicket(jwt, secret, ticket);
      if (id) return id;
    }
    const token = parseCookies(socket.handshake?.headers?.cookie)[cookieName];
    if (token) {
      try {
        const p = jwt.verify(token, secret);
        if (p?.id) return String(p.id);
      } catch { /* invalid or expired cookie */ }
    }
    return null;
  }

  // -> { ok: boolean, reason?: string, userId?: string }
  function canHost(socket, roomCode, ticket) {
    if (allowUnverified) return { ok: true, reason: 'ALLOW_UNVERIFIED_HOST is on' };

    const userId = userIdFor(socket, ticket);
    if (!userId) return { ok: false, reason: 'not logged in (no valid ticket or cookie)' };

    let board;
    try {
      board = db.prepare('SELECT id, owner_id FROM boards WHERE UPPER(room_code) = ?').get(String(roomCode).toUpperCase());
    } catch (err) {
      log.error('[hostAuth] board lookup failed:', err.message);
      return { ok: false, reason: 'board lookup failed' };
    }
    if (!board) return { ok: false, reason: 'room code does not belong to any board' };
    if (board.owner_id === userId) return { ok: true, userId };

    try {
      const m = db.prepare('SELECT role FROM board_members WHERE board_id = ? AND user_id = ?').get(board.id, userId);
      if (m && m.role === 'editor') return { ok: true, userId };
    } catch (err) {
      log.error('[hostAuth] member lookup failed:', err.message);
    }
    return { ok: false, reason: 'not an owner or editor of this board', userId };
  }

  return { canHost, userIdFor };
}

module.exports = { createHostAuth, signTicket, verifyTicket, parseCookies, TICKET_TTL_SECONDS };
