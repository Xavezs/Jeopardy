// Socket handlers: buzzer
const { roomCodeOf, isHostOf, isMemberOf, identityOf } = require('./guards');

const MAX_QUEUE = 100;
const DEFAULT_FREEZE_BUZZ_DELAY_MS = 5000;

module.exports = function registerBuzzerHandlers(socket, ctx) {
  const { gameRooms, io, teamOfPlayer } = ctx;
  const freezeBuzzDelayMs = ctx.FREEZE_BUZZ_DELAY_MS || DEFAULT_FREEZE_BUZZ_DELAY_MS;

  function clearPendingBuzzes(room) {
    for (const pending of room.pendingBuzzes?.values() || []) {
      clearTimeout(pending.timer);
      io.to(pending.socketId).emit('buzzDelayCancelled');
    }
    room.pendingBuzzes?.clear();
  }

  // Buzzer CONTROLS are host-only
  function hostUpdateBuzzer(rawRoomCode, update, invalidatePending = false) {
    const roomCode = roomCodeOf(rawRoomCode);
    if (!roomCode) return;
    if (!isHostOf(socket, roomCode)) {
      socket.emit('errorMsg', 'Only the host can control the buzzer.');
      return;
    }
    const room = gameRooms.get(roomCode) || {};
    if (invalidatePending) {
      clearPendingBuzzes(room);
      room.buzzerGeneration = (room.buzzerGeneration || 0) + 1;
    }
    room.buzzer = update(room.buzzer || { live: false, queue: [], activeIndex: -1 });
    gameRooms.set(roomCode, room);
    io.to(roomCode).emit('buzzerState', room.buzzer);
  }

  socket.on('armBuzzer', (r) => hostUpdateBuzzer(r, (buzzer) => ({ ...buzzer, live: true, queue: [], activeIndex: -1 }), true));
  socket.on('resetBuzzer', (r) => hostUpdateBuzzer(r, () => ({ live: false, queue: [], activeIndex: -1 }), true));
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
    const entry = { id: uid, username: me.discordUsername || uid, avatarUrl: me.discordAvatarUrl || null };

    room.buzzer = room.buzzer || { live: false, queue: [], activeIndex: -1 };
    const b = room.buzzer;
    if (!b.live || b.queue.length >= MAX_QUEUE || b.queue.some((e) => e.id === uid)) return;
    const pendingBuzzes = room.pendingBuzzes || (room.pendingBuzzes = new Map());
    const existingPending = pendingBuzzes.get(uid);
    if (existingPending) {
      if (existingPending.socketId === socket.id) return;
      clearTimeout(existingPending.timer);
      pendingBuzzes.delete(uid);
    }

    if (tid && room.frozenTeams?.[tid]?.live) {
      const clue = room.activeClue;
      const clueKey = clue ? `${clue.catId}|${clue.value}` : null;
      const generation = room.buzzerGeneration || 0;
      const pending = { socketId: socket.id, timer: null };
      pending.timer = setTimeout(() => {
        if (pendingBuzzes.get(uid) !== pending) return;
        pendingBuzzes.delete(uid);
        const currentRoom = gameRooms.get(roomCode);
        const currentPlayer = currentRoom?.players?.find((p) => p.discordUserId === uid && p.socketId === socket.id);
        const currentBuzzer = currentRoom?.buzzer;
        const currentClue = currentRoom?.activeClue;
        const sameClue = clueKey === (currentClue ? `${currentClue.catId}|${currentClue.value}` : null);
        if (!currentPlayer || currentPlayer.connected === false || !currentBuzzer?.live || (currentRoom.buzzerGeneration || 0) !== generation || !sameClue) {
          io.to(socket.id).emit('buzzDelayCancelled');
          return;
        }
        if (currentBuzzer.queue.length >= MAX_QUEUE || currentBuzzer.queue.some((e) => e.id === uid)) return;
        const queue = [...currentBuzzer.queue, entry];
        currentRoom.buzzer = {
          ...currentBuzzer,
          queue,
          activeIndex: currentBuzzer.activeIndex === -1 ? 0 : currentBuzzer.activeIndex,
        };
        gameRooms.set(roomCode, currentRoom);
        io.to(roomCode).emit('buzzerState', currentRoom.buzzer);
      }, freezeBuzzDelayMs);
      pendingBuzzes.set(uid, pending);
      socket.emit('buzzDelayed', { delayMs: freezeBuzzDelayMs });
      return;
    }

    const queue = [...b.queue, entry];
    room.buzzer = { ...b, queue, activeIndex: b.activeIndex === -1 ? 0 : b.activeIndex };
    gameRooms.set(roomCode, room);
    io.to(roomCode).emit('buzzerState', room.buzzer);
  });
};
