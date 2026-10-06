// Socket handlers: room. Registered per-connection from handlers/index.js.
module.exports = function registerRoomHandlers(socket, ctx) {
  const { DISCONNECT_GRACE_MS, MAX_ROOM_CODE_LENGTH, MAX_TEAM_NAME_LENGTH, buildVoiceMemberList, detachFromTeamIfAbandoned, gameRooms, hostAuth, invalidatedRoomCodes, io, roomPersistence, sendRoomState, watchersByChannel } = ctx;


  socket.on('joinRoom', (payload) => {
    const rawRoomCode = typeof payload === 'string' ? payload : payload?.roomCode;
    if (typeof rawRoomCode !== 'string') return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode || roomCode.length > MAX_ROOM_CODE_LENGTH) return;
    if (invalidatedRoomCodes.has(roomCode)) {
      socket.emit('errorMsg', 'This room code has been replaced.');
      return;
    }

    // Only ever PROMOTE to host here. Other hooks re-emit joinRoom with a plain
    // room-code string, which must not wipe the host flag set by the host join.
    // The host role is verified, not self-declared: the socket must prove a
    // logged-in identity that owns/edits the board behind this room code.
    // A refused host still joins the room, just as an ordinary viewer.
    if (payload && typeof payload === 'object' && payload.role === 'host' && !socket.isHost) {
      const verdict = hostAuth.canHost(socket, roomCode, payload.ticket);
      if (verdict.ok) {
        socket.isHost = true;
      } else {
        console.warn(`[hostAuth] host refused for room ${roomCode}: ${verdict.reason}`);
        socket.emit('errorMsg', 'You are not allowed to host this room.');
      }
    }
    socket.join(roomCode);
    socket.gameRoomCode = roomCode;

    sendRoomState(socket, gameRooms.get(roomCode));

    // A host that was away when a skill landed still owes those score deltas
    // (the host owns scores). The client applies each id at most once.
    if (socket.isHost) {
      const pending = gameRooms.get(roomCode)?.pendingSkillDeltas;
      if (pending?.length) socket.emit('skillDeltasPending', pending);
    }
  });

  socket.on('rotateRoomCode', ({ oldRoomCode, newRoomCode }, ack) => {
    const reject = (message) => {
      if (typeof ack === 'function') ack({ ok: false, error: message });
    };
    if (!socket.isHost || typeof oldRoomCode !== 'string' || typeof newRoomCode !== 'string') {
      reject('Only the host can change the room code.');
      return;
    }
    const oldCode = oldRoomCode.trim().toUpperCase();
    const newCode = newRoomCode.trim().toUpperCase();
    if (!oldCode || !newCode || socket.gameRoomCode !== oldCode || gameRooms.has(newCode)) {
      reject('The live room is no longer available.');
      return;
    }

    const room = gameRooms.get(oldCode);
    if (!room) {
      reject('The live room is no longer available.');
      return;
    }
    invalidatedRoomCodes.add(oldCode);
    roomPersistence.forget(oldCode);
    gameRooms.set(newCode, room);
    gameRooms.delete(oldCode);
    socket.leave(oldCode);
    socket.join(newCode);
    socket.gameRoomCode = newCode;
    io.to(oldCode).emit('roomCodeChanged', { roomCode: newCode });
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('watchVoiceChannel', (rawChannelId) => {
    if (typeof rawChannelId !== 'string' || !rawChannelId) return;
    const channelId = rawChannelId.trim();
    if (!channelId) return;

    // Stop watching whatever channel this socket was previously watching.
    if (socket.watchedVoiceChannelId && socket.watchedVoiceChannelId !== channelId) {
      const prevWatchers = watchersByChannel.get(socket.watchedVoiceChannelId);
      prevWatchers?.delete(socket.id);
      if (prevWatchers && prevWatchers.size === 0) watchersByChannel.delete(socket.watchedVoiceChannelId);
    }

    socket.watchedVoiceChannelId = channelId;
    if (!watchersByChannel.has(channelId)) watchersByChannel.set(channelId, new Set());
    watchersByChannel.get(channelId).add(socket.id);

    socket.emit('voiceState', buildVoiceMemberList(channelId));
  });

  socket.on('joinAsPlayer', ({ roomCode: rawRoomCode, teamName, discordUser }) => {
    if (typeof rawRoomCode !== 'string' || typeof teamName !== 'string') return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    const trimmedName = teamName.trim();
    if (!roomCode || roomCode.length > MAX_ROOM_CODE_LENGTH || !trimmedName || trimmedName.length > MAX_TEAM_NAME_LENGTH) return;
    if (invalidatedRoomCodes.has(roomCode)) {
      socket.emit('errorMsg', 'This room code has been replaced.');
      return;
    }

    socket.join(roomCode);
    socket.gameRoomCode = roomCode;

    const room = gameRooms.get(roomCode) || {};
    room.board = room.board || { data: { teams: [] }, updatedAt: Date.now() };
    room.board.data = room.board.data || { teams: [] };
    room.board.data.teams = room.board.data.teams || [];
    room.players = room.players || [];
    room.pendingRemovals = room.pendingRemovals || new Map();

    // If this Discord user already has a roster entry in this room, this
    // is almost certainly a reconnect (tab refresh, brief network drop)
    // rather than a fresh join. Reuse their existing entry: cancel any
    // pending grace-period removal, point it at the new socket, and keep
    // them on whatever team they were already assigned to. This is what
    // stops a reconnect from spawning a duplicate/blank team and wiping
    // their score — we deliberately skip the find-or-create-by-name logic
    // below entirely in this case.
    const existing = discordUser?.id
      ? room.players.find((p) => p.discordUserId === discordUser.id)
      : null;

    if (existing) {
      const pending = room.pendingRemovals.get(discordUser.id);
      if (pending) clearTimeout(pending);
      room.pendingRemovals.delete(discordUser.id);

      existing.socketId = socket.id;
      existing.connected = true;
      existing.discordUsername = discordUser.username || existing.discordUsername;
      existing.discordAvatarUrl = discordUser.avatarUrl || existing.discordAvatarUrl;

      gameRooms.set(roomCode, room);

      const team = room.board.data.teams.find((t) => t.id === existing.teamId);
      socket.emit('joinedTeam', { teamId: existing.teamId, teamName: team?.name || trimmedName });
      io.to(roomCode).emit('playersUpdate', room.players);

      // Reconnect path was previously missing this — the fresh-join branch
      // below sends boardUpdate, but a returning player (tab refresh, brief
      // drop) landed here instead and never got the board at all, since
      // usePlayerSync's boardData starts at null on every fresh mount and
      // nothing else would resend it until the host's next edit. Without
      // this, a mid-game refresh could leave a player staring at a blank
      // board indefinitely.
      sendRoomState(socket, room, { players: false }); // playersUpdate already broadcast above
      return;
    }

    // Find-or-create the team by name (case-insensitive), same convention
    // client-side code already uses ("t_" + random id, discordUserIds array).
    let team = room.board.data.teams.find(
      (t) => t.name && t.name.trim().toLowerCase() === trimmedName.toLowerCase()
    );
    if (!team) {
      team = { id: 't_' + Math.random().toString(36).slice(2, 9), name: trimmedName, score: 0, discordUserIds: [] };
      room.board.data.teams.push(team);
    }
    if (!Array.isArray(team.discordUserIds)) team.discordUserIds = [];
    if (discordUser?.id && !team.discordUserIds.includes(discordUser.id)) {
      team.discordUserIds.push(discordUser.id);
    }

    // Track this socket's player roster entry so we can clean up on disconnect
    // and so host-side views can eventually show "who's connected".
    room.players = room.players.filter((p) => p.socketId !== socket.id);
    room.players.push({
      socketId: socket.id,
      discordUserId: discordUser?.id || null,
      discordUsername: discordUser?.username || null,
      discordAvatarUrl: discordUser?.avatarUrl || null,
      teamId: team.id,
      role: 'player',
      connected: true,
    });

    room.board.updatedAt = Date.now();
    gameRooms.set(roomCode, room);

    // Confirm to the joining socket which team it landed on, then sync
    // everyone in the room (including this socket) on the new board state.
    socket.emit('joinedTeam', { teamId: team.id, teamName: team.name });
    io.to(roomCode).emit('boardUpdate', room.board);
    io.to(roomCode).emit('playersUpdate', room.players);

    sendRoomState(socket, room, { board: false, players: false }); // both already broadcast above
  });

  // Deliberate "Leave" click, as opposed to a disconnect (tab close,
  // network drop, backgrounding). This is intentional, so it skips the
  // grace period entirely and removes the player immediately — no
  // waiting to see if they come back, because they've told us they're not.
  socket.on('leaveGame', (rawRoomCode, ack) => {
    const roomCode = typeof rawRoomCode === 'string' ? rawRoomCode.trim().toUpperCase() : socket.gameRoomCode;
    if (!roomCode) { if (typeof ack === 'function') ack({ ok: false }); return; }
    const room = gameRooms.get(roomCode);
    if (!room?.players) { if (typeof ack === 'function') ack({ ok: false }); return; }

    const leaving = room.players.find((p) => p.socketId === socket.id);
    if (!leaving) { if (typeof ack === 'function') ack({ ok: false }); return; }

    // Cancel any pending grace-period timer for this player — otherwise it
    // would still fire later and try to clean up an already-cleaned-up entry.
    if (leaving.discordUserId && room.pendingRemovals) {
      const pending = room.pendingRemovals.get(leaving.discordUserId);
      if (pending) clearTimeout(pending);
      room.pendingRemovals.delete(leaving.discordUserId);
    }

    room.players = room.players.filter((p) => p.socketId !== socket.id);
    gameRooms.set(roomCode, room);
    io.to(roomCode).emit('playersUpdate', room.players);
    detachFromTeamIfAbandoned(roomCode, leaving);

    socket.leave(roomCode);
    socket.gameRoomCode = null;

    // Ack tells the client the server has actually processed the leave —
    // only then is it safe to disconnect without falling back to the
    // grace-period path. See usePlayerSync.js's leaveGame().
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);

    if (socket.watchedVoiceChannelId) {
      const watchers = watchersByChannel.get(socket.watchedVoiceChannelId);
      watchers?.delete(socket.id);
      if (watchers && watchers.size === 0) watchersByChannel.delete(socket.watchedVoiceChannelId);
    }

    const roomCode = socket.gameRoomCode;
    if (!roomCode) return;
    const room = gameRooms.get(roomCode);
    if (!room?.players) return;

    const leaving = room.players.find((p) => p.socketId === socket.id);
    if (!leaving) return;

    // No stable Discord identity to match a future reconnect against —
    // nothing to hold onto, so treat this as an immediate real leave,
    // same as the original behavior.
    if (!leaving.discordUserId) {
      room.players = room.players.filter((p) => p.socketId !== socket.id);
      gameRooms.set(roomCode, room);
      io.to(roomCode).emit('playersUpdate', room.players);
      detachFromTeamIfAbandoned(roomCode, leaving);
      return;
    }

    // Mark them disconnected but keep their roster entry (and team
    // membership) intact for a grace period, rather than tearing it down
    // immediately — see DISCONNECT_GRACE_MS above for why.
    leaving.connected = false;
    gameRooms.set(roomCode, room);
    io.to(roomCode).emit('playersUpdate', room.players);

    // NOTE: controlDiscordUserId is deliberately left untouched here. It's
    // keyed by discordUserId, not socketId, so a disconnect doesn't
    // invalidate it — if they reconnect within the grace window they still
    // hold the board. If the host wants to hand control to someone else
    // while this player is gone, that's what hostSetControl is for; we
    // don't auto-reassign it, same reasoning as detachFromTeamIfAbandoned
    // not auto-picking a new team.

    room.pendingRemovals = room.pendingRemovals || new Map();
    const key = leaving.discordUserId;
    const existingTimeout = room.pendingRemovals.get(key);
    if (existingTimeout) clearTimeout(existingTimeout);

    const timeout = setTimeout(() => {
      const r = gameRooms.get(roomCode);
      if (!r?.players) return;

      const stillGone = r.players.find((p) => p.discordUserId === key && p.connected === false);
      if (!stillGone) return; // they reconnected within the grace window — nothing to do

      r.players = r.players.filter((p) => p.discordUserId !== key);
      gameRooms.set(roomCode, r);
      io.to(roomCode).emit('playersUpdate', r.players);
      detachFromTeamIfAbandoned(roomCode, stillGone);
      r.pendingRemovals?.delete(key);
    }, DISCONNECT_GRACE_MS);

    room.pendingRemovals.set(key, timeout);
  });
};
