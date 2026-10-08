// Socket handlers: buzzer
const { roomCodeOf, isHostOf, isMemberOf, identityOf } = require('./guards');

const MAX_QUEUE = 100;

module.exports = function registerBuzzerHandlers(socket, ctx) {
  const { gameRooms, io, teamOfPlayer } = ctx;

  // Buzzer CONTROLS are host-only
  function hostUpdateBuzzer(rawRoomCode, update) {
    const roomCode = roomCodeOf(rawRoomCode);
    if (!roomCode) return;
    if (!isHostOf(socket, roomCode)) {
      socket.emit('errorMsg', 'Only the host can control the buzzer.');
      return;
    }
    const room = gameRooms.get(roomCode) || {};
    room.buzzer = update(room.buzzer || { live: false, queue: [], activeIndex: -1 });
    gameRooms.set(roomCode, room);
    io.to(roomCode).emit('buzzerState', room.buzzer);
  }

  socket.on('armBuzzer', (r) => hostUpdateBuzzer(r, (buzzer) => ({ ...buzzer, live: true, queue: [], activeIndex: -1 })));
  socket.on('resetBuzzer', (r) => hostUpdateBuzzer(r, () => ({ live: false, queue: [], activeIndex: -1 })));
  socket.on('nextBuzzer', (r) => hostUpdateBuzzer(r, (buzzer) => ({ ...buzzer, activeIndex: buzzer.activeIndex + 1 })));
  socket.on('prevBuzzer', (r) => hostUpdateBuzzer(r, (buzzer) => ({ ...buzzer, activeIndex: Math.max(-1, buzzer.activeIndex - 1) })));

  socket.on('buzz', (payload) => {
    const roomCode = roomCodeOf(payload?.roomCode);
    if (!roomCode || !isMemberOf(socket, roomCode)) return;
    const room = gameRooms.get(roomCode);
    const uid = identityOf(socket, payload?.player?.id);
    const me = uid && room?.players?.find((p) => p.discordUserId === uid);
    if (!me) return;

    const tid = teamOfPlayer(room, uid);
    if (tid && room.frozenTeams?.[tid]?.live) {
      socket.emit('errorMsg', 'Your team is frozen for this clue.');
      return;
    }
    const entry = { id: uid, username: me.discordUsername || uid, avatarUrl: me.discordAvatarUrl || null };

    room.buzzer = room.buzzer || { live: false, queue: [], activeIndex: -1 };
    const b = room.buzzer;
    if (!b.live || b.queue.length >= MAX_QUEUE || b.queue.some((e) => e.id === uid)) return;
    const queue = [...b.queue, entry];
    room.buzzer = { ...b, queue, activeIndex: b.activeIndex === -1 ? 0 : b.activeIndex };
    gameRooms.set(roomCode, room);
    io.to(roomCode).emit('buzzerState', room.buzzer);
  });
};
