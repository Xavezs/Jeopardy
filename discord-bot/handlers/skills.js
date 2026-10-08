// Socket handlers: skills
const { randomUUID } = require('node:crypto');
const { computeCleaveDeltas } = require('../skillMath');

const MAX_PENDING_SKILL_EVENTS = 20;

module.exports = function registerSkillsHandlers(socket, ctx) {
  const { CLEAVE_MAX_LOSS, CLEAVE_PERCENT, MAX_ROOM_CODE_LENGTH, SKILL_ANIMATION_MS, SKILL_DOMAIN_EXPANSION, gameRooms, hasEquippedSkill, io } = ctx;


  // Player uses an equipped skill
  socket.on('useSkill', ({ roomCode: rawRoomCode, skillId, discordUserId }) => {
    if (typeof rawRoomCode !== 'string' || typeof skillId !== 'string' || !discordUserId) return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode || roomCode.length > MAX_ROOM_CODE_LENGTH) return;
    if (skillId !== SKILL_DOMAIN_EXPANSION) {
      socket.emit('errorMsg', 'Unknown skill.');
      return;
    }

    const room = gameRooms.get(roomCode);
    if (!room) return;

    const player = (room.players || []).find(
      (p) => p.discordUserId === discordUserId && p.socketId === socket.id
    );
    if (!player || !player.teamId) {
      socket.emit('errorMsg', 'Not registered in this room.');
      return;
    }

    const data = room.board?.data;
    const rd = data?.rounds?.[data.currentRound] || data?.rounds?.[0];
    if (rd?.type === 'final') {
      socket.emit('errorMsg', 'Skills cannot be used during Final Jeopardy.');
      return;
    }
    if (room.activeClue) {
      socket.emit('errorMsg', 'Domain Expansion cannot be used while a clue is open.');
      return;
    }
    if (room.skillBusyUntil && Date.now() < room.skillBusyUntil) {
      socket.emit('errorMsg', 'Another skill is already playing.');
      return;
    }
    if (!hasEquippedSkill(discordUserId, skillId)) {
      socket.emit('errorMsg', 'You do not have that skill equipped.');
      return;
    }

    const granted = room.skillsGranted?.[discordUserId] || [];
    if (!granted.includes(skillId)) {
      socket.emit('errorMsg', 'You have not been granted that skill yet — wait for a Power-ups spin.');
      return;
    }

    room.skillsUsed = room.skillsUsed || {};
    const used = room.skillsUsed[discordUserId] || [];
    if (used.includes(skillId)) {
      socket.emit('errorMsg', 'You already used that skill — win it again in a Power-ups spin.');
      return;
    }

    const deltas = computeCleaveDeltas(data?.teams, player.teamId, {
      percent: CLEAVE_PERCENT,
      maxLoss: CLEAVE_MAX_LOSS,
    });

    const eventId = randomUUID();
    if (deltas.length) {
      room.pendingSkillDeltas = [...(room.pendingSkillDeltas || []), { id: eventId, deltas }]
        .slice(-MAX_PENDING_SKILL_EVENTS);
    }

    room.skillsUsed[discordUserId] = [...used, skillId];
    room.skillBusyUntil = Date.now() + SKILL_ANIMATION_MS;
    gameRooms.set(roomCode, room);

    io.to(roomCode).emit('skillsUsedUpdate', room.skillsUsed);
    io.to(roomCode).emit('skillUsed', {
      skillId,
      effect: 'cleave',
      discordUserId,
      username: player.discordUsername || discordUserId,
      teamId: player.teamId,
      deltas,
      eventId,
    });
  });

  socket.on('skillDeltasApplied', ({ roomCode: rawRoomCode, eventId }) => {
    if (typeof rawRoomCode !== 'string' || typeof eventId !== 'string') return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode || roomCode.length > MAX_ROOM_CODE_LENGTH) return;
    if (!socket.isHost || socket.gameRoomCode !== roomCode) return;
    const room = gameRooms.get(roomCode);
    if (!room?.pendingSkillDeltas) return;
    room.pendingSkillDeltas = room.pendingSkillDeltas.filter((e) => e.id !== eventId);
  });
};
