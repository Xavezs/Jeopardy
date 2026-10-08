// Socket handlers: board
const { identityOf, isHostOf, isMemberOf } = require('./guards');

module.exports = function registerBoardHandlers(socket, ctx) {
  const { broadcastBoard, mediaRouter, MAX_BOARD_PAYLOAD_BYTES, MAX_ROOM_CODE_LENGTH, OPEN_CONTROL, emitControlState, findClueMediaUrls, gameRooms, io, mergeLivePlayerMemberships, publicFrozen } = ctx;


  socket.on('activeClueUpdate', ({ roomCode: rawRoomCode, activeClue }) => {
    if (typeof rawRoomCode !== 'string') return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode || roomCode.length > MAX_ROOM_CODE_LENGTH) return;
    if (!isHostOf(socket, roomCode)) return;
    if (activeClue != null && (typeof activeClue !== 'object' || Array.isArray(activeClue))) return;

    const room = gameRooms.get(roomCode) || {};
    const prevClue = room.activeClue;
    const isNewClue =
      activeClue && (!prevClue || prevClue.catId !== activeClue.catId || prevClue.value !== activeClue.value);
    room.activeClue = activeClue || null;

    if (room.frozenTeams && Object.keys(room.frozenTeams).length) {
      let changed = false;
      if (isNewClue) {
        for (const f of Object.values(room.frozenTeams)) if (!f.live) { f.live = true; changed = true; }
      } else if (!activeClue) {
        for (const [teamId, f] of Object.entries(room.frozenTeams)) {
          if (f.live) { delete room.frozenTeams[teamId]; changed = true; }
        }
      }
      if (changed) io.to(roomCode).emit('frozenTeamsUpdate', publicFrozen(room));
    }

    gameRooms.set(roomCode, room);

    const nextClue = room.activeClue;
    const answerVisibilityChanged =
      !!prevClue?.revealed !== !!nextClue?.revealed ||
      prevClue?.catId !== nextClue?.catId ||
      prevClue?.value !== nextClue?.value;
    if (answerVisibilityChanged && room.board) broadcastBoard(roomCode, room, { exceptSocketId: socket.id });

    socket.to(roomCode).emit('activeClueUpdate', room.activeClue);

    // Host's own clue pick
    if (isNewClue) {
      const mediaUrls = findClueMediaUrls(room.board?.data, activeClue.catId, activeClue.value);
      mediaUrls.forEach((url) => mediaRouter.prewarmDriveMedia(url));
    }
  });

  // Player-initiated clue pick
  socket.on('selectClue', ({ roomCode: rawRoomCode, catId, value, discordUserId: claimedId }) => {
    if (typeof rawRoomCode !== 'string' || !catId || value == null) return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode || roomCode.length > MAX_ROOM_CODE_LENGTH) return;

    const room = gameRooms.get(roomCode);
    if (!room) return;

    const discordUserId = identityOf(socket, claimedId);
    const registered =
      !!discordUserId && isMemberOf(socket, roomCode) && room.players?.some((p) => p.discordUserId === discordUserId);
    if (!registered) {
      socket.emit('errorMsg', 'Not registered in this room.');
      return;
    }

    const isOpen = room.controlDiscordUserId === OPEN_CONTROL;
    if (!isOpen) {
      const isRegisteredPlayer =
        !!discordUserId && room.players?.some((p) => p.discordUserId === discordUserId);
      if (!room.controlDiscordUserId || !isRegisteredPlayer || discordUserId !== room.controlDiscordUserId) {
        socket.emit('errorMsg', 'Not your turn to pick a clue.');
        return;
      }
    }

    io.to(roomCode).emit('clueSelected', { catId, value });

    const mediaUrls = findClueMediaUrls(room.board?.data, catId, value);
    mediaUrls.forEach((url) => mediaRouter.prewarmDriveMedia(url));
  });

  // Host override
  socket.on('hostSetControl', ({ roomCode: rawRoomCode, discordUserId }) => {
    if (typeof rawRoomCode !== 'string') return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode || roomCode.length > MAX_ROOM_CODE_LENGTH) return;

    if (!socket.isHost || socket.gameRoomCode !== roomCode) {
      socket.emit('errorMsg', 'Only the host can change board control.');
      return;
    }

    const room = gameRooms.get(roomCode);
    if (!room) return;

    room.controlDiscordUserId = discordUserId || null;
    gameRooms.set(roomCode, room);
    emitControlState(roomCode, room);
  });

  socket.on('revealedCatsUpdate', ({ roomCode: rawRoomCode, revealedCats }) => {
    if (typeof rawRoomCode !== 'string' || !Array.isArray(revealedCats)) return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode || !isHostOf(socket, roomCode)) return;

    const room = gameRooms.get(roomCode) || {};
    room.revealedCats = revealedCats;
    gameRooms.set(roomCode, room);
    socket.to(roomCode).emit('revealedCatsUpdate', room.revealedCats);
  });

  socket.on('roundBannerUpdate', ({ roomCode: rawRoomCode, roundBanner }) => {
    if (typeof rawRoomCode !== 'string') return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode || !isHostOf(socket, roomCode)) return;

    const room = gameRooms.get(roomCode) || {};
    room.roundBanner = roundBanner || null;
    gameRooms.set(roomCode, room);
    socket.to(roomCode).emit('roundBannerUpdate', room.roundBanner);
  });

  socket.on('boardUpdate', ({ roomCode: rawRoomCode, data, updatedAt }) => {
    if (typeof rawRoomCode !== 'string' || !data) return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode) return;
    if (!socket.isHost || socket.gameRoomCode !== roomCode) {
      socket.emit('errorMsg', 'Only the host can update the board.');
      return;
    }

    let payloadBytes;
    try {
      payloadBytes = Buffer.byteLength(JSON.stringify(data), 'utf8');
    } catch {
      socket.emit('errorMsg', 'Invalid board data.');
      return;
    }
    if (payloadBytes > MAX_BOARD_PAYLOAD_BYTES || typeof data !== 'object' || Array.isArray(data)) {
      socket.emit('errorMsg', 'Board data is invalid or too large.');
      return;
    }

    const room = gameRooms.get(roomCode) || {};
    mergeLivePlayerMemberships(data, room.players);
    if (Object.prototype.hasOwnProperty.call(data, 'controlDiscordUserId')) {
      room.controlDiscordUserId = data.controlDiscordUserId || null;
    }
    room.board = { data, updatedAt: updatedAt || Date.now() };
    gameRooms.set(roomCode, room);

    broadcastBoard(roomCode, room, { exceptSocketId: socket.id });
    emitControlState(roomCode, room);
  });
};
