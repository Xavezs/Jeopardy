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
    const p = jwt.verify(ticket, ticketKey(secret), { algorithms: ['HS256'] });
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

function createHostAuth({ db, jwt, secret, cookieName, allowUnverified = false, allowEditorHost = false, log = console }) {
  function userIdFor(socket, ticket) {
    if (typeof ticket === 'string' && ticket) {
      const id = verifyTicket(jwt, secret, ticket);
      if (id) return id;
    }
    if (socket.userId) return String(socket.userId); // verified at connect time
    const token = parseCookies(socket.handshake?.headers?.cookie)[cookieName];
    if (token) {
      try {
        const p = jwt.verify(token, secret, { algorithms: ['HS256'] });
        if (p?.id) return String(p.id);
      } catch { /* invalid or expired cookie */ }
    }
    return null;
  }

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

  return { canHost, userIdFor };
}

module.exports = { createHostAuth, signTicket, verifyTicket, parseCookies, TICKET_TTL_SECONDS };
