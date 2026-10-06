// Socket handlers: buzzer. Registered per-connection from handlers/index.js.
module.exports = function registerBuzzerHandlers(socket, ctx) {
  const { gameRooms, io, teamOfPlayer } = ctx;

  function updateBuzzer(rawRoomCode, update) {
    if (typeof rawRoomCode !== 'string') return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode) return;
    const room = gameRooms.get(roomCode) || {};
    room.buzzer = update(room.buzzer || { live: false, queue: [], activeIndex: -1 });
    gameRooms.set(roomCode, room);
    io.to(roomCode).emit('buzzerState', room.buzzer);
  }


  socket.on('armBuzzer', (rawRoomCode) => updateBuzzer(rawRoomCode, (buzzer) => ({ ...buzzer, live: true, queue: [], activeIndex: -1 })));
  socket.on('resetBuzzer', (rawRoomCode) => updateBuzzer(rawRoomCode, () => ({ live: false, queue: [], activeIndex: -1 })));
  socket.on('nextBuzzer', (rawRoomCode) => updateBuzzer(rawRoomCode, (buzzer) => ({ ...buzzer, activeIndex: buzzer.activeIndex + 1 })));
  socket.on('prevBuzzer', (rawRoomCode) => updateBuzzer(rawRoomCode, (buzzer) => ({ ...buzzer, activeIndex: Math.max(-1, buzzer.activeIndex - 1) })));
  
  socket.on('buzz', ({ roomCode: rawRoomCode, player }) => {
    if (!player?.id) return;
    if (typeof rawRoomCode === 'string') {
      const r = gameRooms.get(rawRoomCode.trim().toUpperCase());
      const tid = r ? teamOfPlayer(r, player.id) : null;
      if (tid && r.frozenTeams?.[tid]?.live) {
        socket.emit('errorMsg', 'Your team is frozen for this clue.');
        return;
      }
    }
    updateBuzzer(rawRoomCode, (buzzer) => {
      if (!buzzer.live || buzzer.queue.some((entry) => entry.id === player.id)) return buzzer;
      const queue = [...buzzer.queue, player];
      return { ...buzzer, queue, activeIndex: buzzer.activeIndex === -1 ? 0 : buzzer.activeIndex };
    });
  });
};
