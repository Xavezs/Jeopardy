// Socket handlers: sync. Registered per-connection from handlers/index.js.
module.exports = function registerSyncHandlers(socket, ctx) {
  const { gameRooms, io, randomizerFor } = ctx;


  // Background music "now playing" state — same treatment as activeClue:
  // not part of persisted board data, live "for the show" only. Carries
  // enough for a late-joining player to compute the correct playback
  // position (positionSeconds + elapsed time since updatedAt), but
  // deliberately no volume — each client's volume is local-only, never
  // synced. See useBgmSync.js (host) and usePlayerSync.js (player).
  socket.on('bgmUpdate', ({ roomCode: rawRoomCode, bgm }) => {
    if (typeof rawRoomCode !== 'string' || !bgm) return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode) return;

    const room = gameRooms.get(roomCode) || {};
    room.bgm = bgm;
    gameRooms.set(roomCode, room);
    socket.to(roomCode).emit('bgmUpdate', room.bgm);
  });

  // Team randomizer — same treatment as activeClue/revealedCats: resent to
  // late-joining sockets (see the joinRoom/joinAsPlayer resends above),
  // unlike the transient roundBanner. "Host is on the randomizer screen
  // with this order locked in" should survive a player's refresh mid-spin,
  // not just be missed like a one-off animation would be.
  socket.on('randomizerUpdate', ({ roomCode: rawRoomCode, randomizer }) => {
    if (typeof rawRoomCode !== 'string') return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode) return;

    const room = gameRooms.get(roomCode) || {};
    room.randomizer = randomizer || null;
    gameRooms.set(roomCode, room);
    const playerSockets = (room.players || []).filter((p) => p.socketId);
    for (const p of playerSockets) {
      io.to(p.socketId).emit('randomizerUpdate', randomizerFor(room, { id: p.socketId, isHost: false }));
    }
    socket.to(roomCode).except(playerSockets.map((p) => p.socketId)).emit('randomizerUpdate', room.randomizer);
  });
};
