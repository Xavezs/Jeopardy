// Sends a room's current state to ONE socket, using the existing per-event
// names so every client hook keeps working unchanged. This replaces three
// hand-copied blocks (joinRoom, joinAsPlayer reconnect, joinAsPlayer fresh
// join) that had already drifted apart. Moving the client to a single
// `stateSync` event later only means changing this one function.
//
// opts.board / opts.players: pass false when the caller already broadcast
// that event to the whole room (so this socket would get it twice).
module.exports = function createSendRoomState({ randomizerFor, sendGrantsTo }) {
  return function sendRoomState(socket, room, { board = true, players = true } = {}) {
    if (board && room?.board) socket.emit('boardUpdate', room.board);
    if (room?.buzzer) socket.emit('buzzerState', room.buzzer);
    if (room?.activeClue !== undefined) socket.emit('activeClueUpdate', room.activeClue);
    if (room?.revealedCats) socket.emit('revealedCatsUpdate', room.revealedCats);
    if (room?.bgm !== undefined) socket.emit('bgmUpdate', room.bgm);
    if (room?.randomizer) socket.emit('randomizerUpdate', randomizerFor(room, socket));
    if (players && room?.players) socket.emit('playersUpdate', room.players);
    if (room) socket.emit('controlChanged', { controlDiscordUserId: room.controlDiscordUserId ?? null });
    if (room?.playerStats) socket.emit('statsUpdate', room.playerStats);
    socket.emit('skillsUsedUpdate', room?.skillsUsed || {});
    sendGrantsTo(socket, room);
  };
};
