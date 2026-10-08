// Socket handlers: scoring
const { identityOf, isMemberOf } = require('./guards');

module.exports = function registerScoringHandlers(socket, ctx) {
  const { MAX_ROOM_CODE_LENGTH, OPEN_CONTROL, currentRound, emitControlState, gameRooms, hostLocks, io, teamOfPlayer } = ctx;

  function sendFinalSubmissionToHost(roomCode, event, payload) {
    const hostLock = hostLocks.get(roomCode);
    const hostSocket = hostLock && io.sockets?.sockets?.get(hostLock.socketId);
    if (!hostSocket?.isHost || hostSocket.gameRoomCode !== roomCode) return;
    io.to(hostLock.socketId).emit(event, payload);
  }

  function finalSubmissionBlocked(room, discordUserId, phases, field, closedMessage) {
    const rd = currentRound(room);
    if (!rd || rd.type !== 'final' || !phases.includes(rd.phase)) return closedMessage;
    const teamId = teamOfPlayer(room, discordUserId);
    if (teamId && rd[field] && rd[field][teamId] != null) return 'Your team has already locked this in.';
    return null;
  }


  // Player-submitted Daily Double wager
  socket.on('submitWager', ({ roomCode: rawRoomCode, amount, discordUserId: claimedId }) => {
    if (typeof rawRoomCode !== 'string') return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode || roomCode.length > MAX_ROOM_CODE_LENGTH) return;

    const room = gameRooms.get(roomCode);
    if (!room) return;

    const discordUserId = identityOf(socket, claimedId);
    const isRegisteredPlayer =
      !!discordUserId && isMemberOf(socket, roomCode) && room.players?.some((p) => p.discordUserId === discordUserId);
    if (
      !room.controlDiscordUserId ||
      room.controlDiscordUserId === OPEN_CONTROL ||
      !isRegisteredPlayer ||
      discordUserId !== room.controlDiscordUserId
    ) {
      socket.emit('errorMsg', 'Not your wager to submit.');
      return;
    }

    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount < 0) return;

    io.to(roomCode).emit('wagerSubmitted', { discordUserId, amount: parsedAmount });
  });

  // Final Jeopardy wager
  socket.on('submitFinalWager', ({ roomCode: rawRoomCode, amount, discordUserId: claimedId }) => {
    if (typeof rawRoomCode !== 'string') return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode || roomCode.length > MAX_ROOM_CODE_LENGTH) return;

    const room = gameRooms.get(roomCode);
    if (!room) return;

    const discordUserId = identityOf(socket, claimedId);
    const isRegisteredPlayer =
      !!discordUserId && isMemberOf(socket, roomCode) && room.players?.some((p) => p.discordUserId === discordUserId);
    if (!isRegisteredPlayer) {
      socket.emit('errorMsg', 'Not registered in this room.');
      return;
    }

    const blockedWager = finalSubmissionBlocked(room, discordUserId, ['wager'], 'wagers', 'Wagers are not open right now.');
    if (blockedWager) {
      socket.emit('errorMsg', blockedWager);
      return;
    }

    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount < 0) return;

    sendFinalSubmissionToHost(roomCode, 'finalWagerSubmitted', { discordUserId, amount: parsedAmount });
  });

  // Final Jeopardy answer
  socket.on('submitFinalAnswer', ({ roomCode: rawRoomCode, answer, discordUserId: claimedId }) => {
    if (typeof rawRoomCode !== 'string') return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode || roomCode.length > MAX_ROOM_CODE_LENGTH) return;

    const room = gameRooms.get(roomCode);
    if (!room) return;

    const discordUserId = identityOf(socket, claimedId);
    const isRegisteredPlayer =
      !!discordUserId && isMemberOf(socket, roomCode) && room.players?.some((p) => p.discordUserId === discordUserId);
    if (!isRegisteredPlayer) {
      socket.emit('errorMsg', 'Not registered in this room.');
      return;
    }

    if (typeof answer !== 'string') return;

    const blockedAnswer = finalSubmissionBlocked(room, discordUserId, ['clue', 'answer'], 'answers', 'Answers are not open right now.');
    if (blockedAnswer) {
      socket.emit('errorMsg', blockedAnswer);
      return;
    }

    sendFinalSubmissionToHost(roomCode, 'finalAnswerSubmitted', { discordUserId, answer: answer.slice(0, 500) });
  });

  socket.on('judgeAnswer', ({ roomCode: rawRoomCode, discordUserId, correct }) => {
    if (typeof rawRoomCode !== 'string') return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode || roomCode.length > MAX_ROOM_CODE_LENGTH) return;

    if (!socket.isHost || socket.gameRoomCode !== roomCode) {
      socket.emit('errorMsg', 'Only the host can judge answers.');
      return;
    }

    const room = gameRooms.get(roomCode);
    if (!room) return;

    if (discordUserId) {
      room.playerStats = room.playerStats || {};
      const stats = room.playerStats[discordUserId] || { correct: 0, wrong: 0 };
      if (correct) stats.correct += 1;
      else stats.wrong += 1;
      room.playerStats[discordUserId] = stats;
      gameRooms.set(roomCode, room);
      io.to(roomCode).emit('statsUpdate', room.playerStats);
    }

    if (correct && discordUserId) {
      room.controlDiscordUserId = discordUserId;
      gameRooms.set(roomCode, room);
      emitControlState(roomCode, room);
    }
  });
};
