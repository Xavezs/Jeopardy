module.exports = function createSendRoomState({ randomizerFor, sendGrantsTo, boardFor }) {
  return function sendRoomState(socket, room, { board = true, players = true } = {}) {
    if (board && room?.board) socket.emit('boardUpdate', boardFor ? boardFor(room, socket) : room.board);
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
