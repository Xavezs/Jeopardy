// Shared authorization helpers for socket handlers

const MAX_ROOM_CODE_LENGTH = 8;

function roomCodeOf(raw) {
  if (typeof raw !== 'string') return null;
  const code = raw.trim().toUpperCase();
  return code && code.length <= MAX_ROOM_CODE_LENGTH ? code : null;
}

const isHostOf = (socket, roomCode) => !!socket.isHost && socket.gameRoomCode === roomCode;
const isMemberOf = (socket, roomCode) => !!roomCode && socket.gameRoomCode === roomCode;

function identityOf(socket, claimedId) {
  if (socket.userId) return String(socket.userId);
  if (process.env.ALLOW_UNVERIFIED_SOCKETS === '1' && typeof claimedId === 'string' && claimedId) return claimedId;
  return null;
}

const clip = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);

function safeAvatarUrl(v) {
  if (typeof v !== 'string' || v.length > 300) return null;
  return /^(https:\/\/[a-z0-9.-]*discord(app)?\.(com|net)\/|\/\.proxy\/)/i.test(v) ? v : null;
}

module.exports = { MAX_ROOM_CODE_LENGTH, roomCodeOf, isHostOf, isMemberOf, identityOf, clip, safeAvatarUrl };
