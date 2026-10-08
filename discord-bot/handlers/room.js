// Socket handlers: room
const { identityOf, clip, safeAvatarUrl } = require('./guards');

module.exports = function registerRoomHandlers(socket, ctx) {
  const { hostLocks, roomCodeExists, DISCONNECT_GRACE_MS, MAX_ROOM_CODE_LENGTH, MAX_TEAM_NAME_LENGTH, broadcastBoard, buildVoiceMemberList, detachFromTeamIfAbandoned, gameRooms, hostAuth, invalidatedRoomCodes, io, roomPersistence, sendRoomState, watchersByChannel } = ctx;


  socket.on('joinRoom', (payload) => {
    const rawRoomCode = typeof payload === 'string' ? payload : payload?.roomCode;
    if (typeof rawRoomCode !== 'string') return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode || roomCode.length > MAX_ROOM_CODE_LENGTH) return;
    if (invalidatedRoomCodes.has(roomCode)) {
      socket.emit('errorMsg', 'This room code has been replaced.');
      return;
    }

    if (socket.isHost && socket.hostRoomCode !== roomCode) socket.isHost = false;

    if (payload && typeof payload === 'object' && payload.role === 'host' && !socket.isHost) {
      const verdict = hostAuth.canHost(socket, roomCode, payload.ticket);
      const hostId = verdict.userId || socket.id;
      const lock = hostLocks.get(roomCode);
      const holder = lock && lock.socketId !== socket.id ? io.sockets.sockets.get(lock.socketId) : null;
      const heldByOther = !!(holder && holder.isHost && holder.gameRoomCode === roomCode && lock.userId !== hostId);
      if (verdict.ok && heldByOther) {
        console.warn(`[hostAuth] host refused for room ${roomCode}: room already has a host`);
        socket.emit('errorMsg', 'This room already has a host.');
      } else if (verdict.ok) {
        if (holder && holder.isHost) {
          holder.isHost = false;
          holder.emit('errorMsg', 'Host role moved to another tab.');
        }
        socket.isHost = true;
        socket.hostRoomCode = roomCode;
        hostLocks.set(roomCode, { userId: hostId, socketId: socket.id });
      } else {
        console.warn(`[hostAuth] host refused for room ${roomCode}: ${verdict.reason}`);
        socket.emit('errorMsg', 'You are not allowed to host this room.');
      }
    }
    socket.join(roomCode);
    socket.gameRoomCode = roomCode;

    sendRoomState(socket, gameRooms.get(roomCode));

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
    socket.hostRoomCode = newCode;
    const lock = hostLocks.get(oldCode);
    if (lock) { hostLocks.delete(oldCode); hostLocks.set(newCode, lock); }
    io.to(oldCode).emit('roomCodeChanged', { roomCode: newCode });
    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('watchVoiceChannel', (rawChannelId) => {
    if (!identityOf(socket, 'unverified')) return;
    if (typeof rawChannelId !== 'string' || !rawChannelId) return;
    const channelId = rawChannelId.trim();
    if (!channelId) return;

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

  socket.on('joinAsPlayer', ({ roomCode: rawRoomCode, teamName, discordUser: claimedUser } = {}) => {
    if (typeof rawRoomCode !== 'string' || typeof teamName !== 'string') return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    const trimmedName = teamName.trim();
    if (!roomCode || roomCode.length > MAX_ROOM_CODE_LENGTH || !trimmedName || trimmedName.length > MAX_TEAM_NAME_LENGTH) return;
    if (invalidatedRoomCodes.has(roomCode)) {
      socket.emit('errorMsg', 'This room code has been replaced.');
      return;
    }

    const verifiedId = identityOf(socket, claimedUser?.id);
    if (!verifiedId) {
      socket.emit('errorMsg', 'Could not verify your Discord login. Reload the Activity.');
      return;
    }
    if (!roomCodeExists(roomCode)) {
      socket.emit('errorMsg', 'Room not found.');
      return;
    }
    const discordUser = {
      id: verifiedId,
      username: clip(claimedUser?.username, 64),
      avatarUrl: safeAvatarUrl(claimedUser?.avatarUrl),
    };
    if (socket.isHost && socket.hostRoomCode !== roomCode) socket.isHost = false;

    socket.join(roomCode);
    socket.gameRoomCode = roomCode;

    const room = gameRooms.get(roomCode) || {};
    room.board = room.board || { data: { teams: [] }, updatedAt: Date.now() };
    room.board.data = room.board.data || { teams: [] };
    room.board.data.teams = room.board.data.teams || [];
    room.players = room.players || [];
    room.pendingRemovals = room.pendingRemovals || new Map();

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

      sendRoomState(socket, room, { players: false }); // playersUpdate already broadcast above
      return;
    }

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

    socket.emit('joinedTeam', { teamId: team.id, teamName: team.name });
    broadcastBoard(roomCode, room);
    io.to(roomCode).emit('playersUpdate', room.players);

    sendRoomState(socket, room, { board: false, players: false }); // both already broadcast above
  });

  socket.on('leaveGame', (rawRoomCode, ack) => {
    const roomCode = typeof rawRoomCode === 'string' ? rawRoomCode.trim().toUpperCase() : socket.gameRoomCode;
    if (!roomCode) { if (typeof ack === 'function') ack({ ok: false }); return; }
    const room = gameRooms.get(roomCode);
    if (!room?.players) { if (typeof ack === 'function') ack({ ok: false }); return; }

    const leaving = room.players.find((p) => p.socketId === socket.id);
    if (!leaving) { if (typeof ack === 'function') ack({ ok: false }); return; }

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

    if (typeof ack === 'function') ack({ ok: true });
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);

    const hostLock = socket.gameRoomCode && hostLocks.get(socket.gameRoomCode);
    if (hostLock && hostLock.socketId === socket.id) hostLocks.delete(socket.gameRoomCode);

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

    if (!leaving.discordUserId) {
      room.players = room.players.filter((p) => p.socketId !== socket.id);
      gameRooms.set(roomCode, room);
      io.to(roomCode).emit('playersUpdate', room.players);
      detachFromTeamIfAbandoned(roomCode, leaving);
      return;
    }

    leaving.connected = false;
    gameRooms.set(roomCode, room);
    io.to(roomCode).emit('playersUpdate', room.players);

    room.pendingRemovals = room.pendingRemovals || new Map();
    const key = leaving.discordUserId;
    const existingTimeout = room.pendingRemovals.get(key);
    if (existingTimeout) clearTimeout(existingTimeout);

    const timeout = setTimeout(() => {
      const r = gameRooms.get(roomCode);
      if (!r?.players) return;

      const stillGone = r.players.find((p) => p.discordUserId === key && p.connected === false);
      if (!stillGone) return;

      r.players = r.players.filter((p) => p.discordUserId !== key);
      gameRooms.set(roomCode, r);
      io.to(roomCode).emit('playersUpdate', r.players);
      detachFromTeamIfAbandoned(roomCode, stillGone);
      r.pendingRemovals?.delete(key);
    }, DISCONNECT_GRACE_MS);

    room.pendingRemovals.set(key, timeout);
  });
};
