// Socket handlers: sync
const { isHostOf } = require('./guards');

module.exports = function registerSyncHandlers(socket, ctx) {
  const { gameRooms, io, randomizerFor } = ctx;


  // Background music "now playing" state
  socket.on('bgmUpdate', ({ roomCode: rawRoomCode, bgm }) => {
    if (typeof rawRoomCode !== 'string' || !bgm) return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode || !isHostOf(socket, roomCode)) return;

    const room = gameRooms.get(roomCode) || {};
    room.bgm = bgm;
    gameRooms.set(roomCode, room);
    socket.to(roomCode).emit('bgmUpdate', room.bgm);
  });

  // Team randomizer
  socket.on('randomizerUpdate', ({ roomCode: rawRoomCode, randomizer }) => {
    if (typeof rawRoomCode !== 'string') return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode || !isHostOf(socket, roomCode)) return;

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
