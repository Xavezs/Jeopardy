// Socket handlers: board. Registered per-connection from handlers/index.js.
module.exports = function registerBoardHandlers(socket, ctx) {
  const { mediaRouter, MAX_BOARD_PAYLOAD_BYTES, MAX_ROOM_CODE_LENGTH, OPEN_CONTROL, emitControlState, findClueMediaUrls, gameRooms, io, mergeLivePlayerMemberships, publicFrozen } = ctx;


  socket.on('activeClueUpdate', ({ roomCode: rawRoomCode, activeClue }) => {
    if (typeof rawRoomCode !== 'string') return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode || roomCode.length > MAX_ROOM_CODE_LENGTH) return;

    const room = gameRooms.get(roomCode) || {};
    const prevClue = room.activeClue;
    // Only counts as "picking a new clue" when catId/value actually
    // changes — activeClueUpdate also fires on every revealed/timer/
    // playback field change within the SAME clue, and re-prewarming on
    // those would just be wasted cache lookups (harmless, since
    // getDriveFile is cached, but pointless).
    const isNewClue =
      activeClue && (!prevClue || prevClue.catId !== activeClue.catId || prevClue.value !== activeClue.value);
    room.activeClue = activeClue || null;

    // Freeze lifecycle: a freeze cast between clues starts biting when the next
    // clue opens, and every freeze ends when the clue it covered closes.
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
    socket.to(roomCode).emit('activeClueUpdate', room.activeClue);

    // Host's own clue pick — selectClue (below) only covers player picks,
    // so this is the prewarm trigger for the far more common "host clicks
    // the board" path. Fires alongside the relay above rather than
    // blocking it.
    if (isNewClue) {
      const mediaUrls = findClueMediaUrls(room.board?.data, activeClue.catId, activeClue.value);
      mediaUrls.forEach((url) => mediaRouter.prewarmDriveMedia(url));
    }
  });

  // Player-initiated clue pick. Only the current control holder may open a
  // clue — validated server-side against their stable discordUserId, not
  // trusted from the client (client-side disabling alone can be bypassed by
  // emitting the event directly). If nobody holds control yet (start of a
  // round, or host hasn't assigned anyone), NO player may pick — that's a
  // deliberate flip from "unrestricted until assigned": leaving it open by
  // default let every player pick immediately on join, before the host had
  // a chance to hand control to anyone. The host still always has a free
  // pick (that path never goes through this handler at all — see
  // JeopardyBoard.jsx's inline board click), and can open the board up to a
  // specific player via the "Board control" dropdown (hostSetControl).
  //
  // Deliberately does NOT set room.activeClue itself. The host's local
  // clueEditor state (JeopardyBoard.jsx) is the single source of truth for
  // the actual clue session — reveal state, timer, media playback — all of
  // that only exists on the host's screen. Setting activeClue directly here
  // would show the clue to players while the host's own modal never opens,
  // leaving nobody able to run reveal/judge for it. Instead this just
  // relays "someone picked this cell" to the host, who opens their own
  // ClueModal in response (see JeopardyBoard.jsx's useControlSync
  // onClueSelected), which THEN publishes activeClue as normal.
  socket.on('selectClue', ({ roomCode: rawRoomCode, catId, value, discordUserId }) => {
    if (typeof rawRoomCode !== 'string' || !catId || value == null) return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode || roomCode.length > MAX_ROOM_CODE_LENGTH) return;

    const room = gameRooms.get(roomCode);
    if (!room) return;

    const isOpen = room.controlDiscordUserId === OPEN_CONTROL;
    if (!isOpen) {
      // useControlSync keeps its own socket connection, separate from
      // whichever socket actually ran joinAsPlayer — so socket.id can't be
      // used to find "me" in room.players here anymore. Trust the
      // discordUserId the client sends instead (same as judgeAnswer /
      // hostSetControl already do), but still require it to belong to a
      // player actually registered in this room, so an arbitrary/spoofed
      // id can't claim someone else's turn.
      const isRegisteredPlayer =
        !!discordUserId && room.players?.some((p) => p.discordUserId === discordUserId);
      if (!room.controlDiscordUserId || !isRegisteredPlayer || discordUserId !== room.controlDiscordUserId) {
        socket.emit('errorMsg', 'Not your turn to pick a clue.');
        return;
      }
    }

    io.to(roomCode).emit('clueSelected', { catId, value });

    // Fire-and-forget: start fetching this clue's Drive attachment(s) now,
    // in parallel with the clueSelected broadcast above, instead of
    // waiting for the host's ClueModal to open and every player's
    // <video>/<audio> tag to request it independently. See
    // prewarmDriveMedia's own comment in media.js for the full reasoning.
    const mediaUrls = findClueMediaUrls(room.board?.data, catId, value);
    mediaUrls.forEach((url) => mediaRouter.prewarmDriveMedia(url));
  });

  // Host override — manual assign, used as the fallback when the current
  // control holder disconnects and doesn't come back within the grace
  // window (see the 'disconnect' handler below), whenever the host wants
  // to hand the board to someone else, or to open it up to everyone by
  // passing OPEN_CONTROL (falls straight through — this handler doesn't
  // care what the string is, it just stores it).
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

  // Live "for the show" state, same treatment as activeClue — which
  // category headers have been reveal-clicked by the host. Not part of
  // persisted board data (see useBoardGrid.js), so it gets its own tiny
  // relay rather than going through boardUpdate.
  socket.on('revealedCatsUpdate', ({ roomCode: rawRoomCode, revealedCats }) => {
    if (typeof rawRoomCode !== 'string' || !Array.isArray(revealedCats)) return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode) return;

    const room = gameRooms.get(roomCode) || {};
    room.revealedCats = revealedCats;
    gameRooms.set(roomCode, room);
    socket.to(roomCode).emit('revealedCatsUpdate', room.revealedCats);
  });

  // "DOUBLE JEOPARDY!"-style round-switch banner — same treatment as
  // revealedCats/activeClue: live "for the show" state, not part of
  // persisted board data (see useBoardGrid.js's roundBanner), so it gets
  // its own tiny relay rather than going through boardUpdate. Deliberately
  // NOT re-sent to late-joining sockets (unlike revealedCats/activeClue
  // above) since the banner is a ~1s transient pop-up — a player joining
  // mid-animation just misses it, same as missing any other in-progress
  // one-off effect; the round itself is already reflected in boardData.
  socket.on('roundBannerUpdate', ({ roomCode: rawRoomCode, roundBanner }) => {
    if (typeof rawRoomCode !== 'string') return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode) return;

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

    // socket.to(...) ensures the host doesn't receive its own echo back
    socket.to(roomCode).emit('boardUpdate', room.board);
    emitControlState(roomCode, room);
  });
};
