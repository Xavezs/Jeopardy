// Socket handlers: scoring. Registered per-connection from handlers/index.js.
module.exports = function registerScoringHandlers(socket, ctx) {
  const { MAX_ROOM_CODE_LENGTH, OPEN_CONTROL, emitControlState, gameRooms, io } = ctx;


  // Player-submitted Daily Double wager. Same trust model as selectClue:
  // never take the client's word for whose turn it is, re-check against
  // room.controlDiscordUserId. Unlike selectClue, OPEN_CONTROL does NOT
  // bypass this — a wager belongs to one specific player, so "anyone can
  // pick" mode has no valid wagerer and must fall back to the host's
  // manual entry (see ClueModal.jsx). Deliberately does not clamp `amount`
  // against 2x the clue's value — the server has no notion of "which
  // clue/value is currently open" beyond the host's own local clueEditor
  // state, and the host's UI already applies that clamp identically for
  // both this path and its manual fallback (see ClueModal's maxWager).
  socket.on('submitWager', ({ roomCode: rawRoomCode, amount, discordUserId }) => {
    if (typeof rawRoomCode !== 'string') return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode || roomCode.length > MAX_ROOM_CODE_LENGTH) return;

    const room = gameRooms.get(roomCode);
    if (!room) return;

    const isRegisteredPlayer =
      !!discordUserId && room.players?.some((p) => p.discordUserId === discordUserId);
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

  // Final Jeopardy wager — ALL players submit in PARALLEL (unlike Daily
  // Double's single control-holder wager above), so this does NOT gate on
  // room.controlDiscordUserId at all — just checks the sender is a
  // registered player in this room. The host resolves discordUserId ->
  // team (via useTeams' resolveTeamForDiscordUser) and clamps the amount
  // against that team's current score before writing it into
  // round.wagers — this handler is only the relay, same division of
  // responsibility selectClue/submitWager already use.
  socket.on('submitFinalWager', ({ roomCode: rawRoomCode, amount, discordUserId }) => {
    if (typeof rawRoomCode !== 'string') return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode || roomCode.length > MAX_ROOM_CODE_LENGTH) return;

    const room = gameRooms.get(roomCode);
    if (!room) return;

    const isRegisteredPlayer =
      !!discordUserId && room.players?.some((p) => p.discordUserId === discordUserId);
    if (!isRegisteredPlayer) {
      socket.emit('errorMsg', 'Not registered in this room.');
      return;
    }

    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount < 0) return;

    io.to(roomCode).emit('finalWagerSubmitted', { discordUserId, amount: parsedAmount });
  });

  // Final Jeopardy answer — same parallel-submission trust model as the
  // wager above: any registered player may submit, no control-holder
  // gate, no "is it your turn" check.
  socket.on('submitFinalAnswer', ({ roomCode: rawRoomCode, answer, discordUserId }) => {
    if (typeof rawRoomCode !== 'string') return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode || roomCode.length > MAX_ROOM_CODE_LENGTH) return;

    const room = gameRooms.get(roomCode);
    if (!room) return;

    const isRegisteredPlayer =
      !!discordUserId && room.players?.some((p) => p.discordUserId === discordUserId);
    if (!isRegisteredPlayer) {
      socket.emit('errorMsg', 'Not registered in this room.');
      return;
    }

    if (typeof answer !== 'string') return;

    io.to(roomCode).emit('finalAnswerSubmitted', { discordUserId, answer: answer.slice(0, 500) });
  });

  // Host (or whatever judges the answer) reports the outcome. Control only
  // moves on a correct answer, to whoever answered it — everything else
  // (wrong / nobody answered) leaves controlDiscordUserId exactly as-is, so
  // the same player keeps the board until someone actually gets one right.
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

    // Track per-player correct/wrong counts for end-game stats, keyed by
    // discordUserId — same convention as team/control state, since
    // socket.id changes on every reconnect. judgeAnswer doesn't carry the
    // clue's point value, so this is a count of attempts, not a point
    // total; if a points-based stat is ever needed, the client will need
    // to start sending `value` alongside discordUserId/correct.
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
