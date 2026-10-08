// Socket handlers: powerups
module.exports = function registerPowerupsHandlers(socket, ctx) {
  const { MAX_ROOM_CODE_LENGTH, POWERUP_KINDS, broadcastGrants, broadcastPowerupState, buildAnswerHint, currentRound, emitControlState, findActiveClue, gameRooms, getEquippedSkills, io, teamOfPlayer } = ctx;


  socket.on('hostPowerDraw', ({ roomCode: rawRoomCode } = {}, ack) => {
    const reply = (payload) => { if (typeof ack === 'function') ack(payload); };
    if (typeof rawRoomCode !== 'string') { reply({ error: 'Bad request.' }); return; }
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode || roomCode.length > MAX_ROOM_CODE_LENGTH) { reply({ error: 'Bad request.' }); return; }
    if (!socket.isHost || socket.gameRoomCode !== roomCode) {
      socket.emit('errorMsg', 'Only the host can spin the Power-ups.');
      reply({ error: 'Only the host can spin the Power-ups.' });
      return;
    }

    const room = gameRooms.get(roomCode);
    if (!room) { reply({ error: 'Room not found.' }); return; }

    const data = room.board?.data;
    const rd = data?.rounds?.[data.currentRound] || data?.rounds?.[0];
    if (rd?.type === 'final') {
      socket.emit('errorMsg', 'Power-ups are disabled during Final Jeopardy.');
      reply({ error: 'Power-ups are disabled during Final Jeopardy.' });
      return;
    }

    room.skillsGranted = room.skillsGranted || {};
    console.log('[powerDraw] players:', (room.players || []).map(p => ({ id: p.discordUserId, team: p.teamId, connected: p.connected })));
    const results = [];
    const seen = new Set();
    for (const player of room.players || []) {
      const uid = player.discordUserId;
      if (!uid || !player.teamId || player.connected === false || seen.has(uid)) continue;
      seen.add(uid);

      const already = room.skillsGranted[uid] || [];
      const spent = room.skillsUsed?.[uid] || [];
      for (const skill of getEquippedSkills(uid)) {
        if (already.includes(skill.id) && !spent.includes(skill.id)) continue;
        const won = Math.random() < skill.grantChance;
        console.log('[powerDraw] roll', uid, skill.id, 'chance =', skill.grantChance, 'won =', won);
        results.push({
          discordUserId: uid,
          username: player.discordUsername || uid,
          teamId: player.teamId,
          skillId: skill.id,
          skillName: skill.name,
          won,
        });
      }
    }
    gameRooms.set(roomCode, room);

    room.pendingDraw = results.filter((r) => r.won).map((r) => ({ discordUserId: r.discordUserId, skillId: r.skillId }));
    reply({
      winners: results
        .filter((r) => r.won)
        .map((r) => ({ discordUserId: r.discordUserId, skillId: r.skillId, skillName: r.skillName })),
    });
  });

  // Host clicks "Apply Power-ups" after the spin
  socket.on('hostPowerApply', ({ roomCode: rawRoomCode, playerPowerups } = {}, ack) => {
    const reply = (payload) => { if (typeof ack === 'function') ack(payload); };
    if (typeof rawRoomCode !== 'string') { reply({ error: 'Bad request.' }); return; }
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode || roomCode.length > MAX_ROOM_CODE_LENGTH) { reply({ error: 'Bad request.' }); return; }
    if (!socket.isHost || socket.gameRoomCode !== roomCode) {
      socket.emit('errorMsg', 'Only the host can apply the Power-ups.');
      reply({ error: 'Only the host can apply the Power-ups.' });
      return;
    }
    const room = gameRooms.get(roomCode);
    if (!room) { reply({ error: 'Room not found.' }); return; }

    const data = room.board?.data;
    const rd = data?.rounds?.[data.currentRound] || data?.rounds?.[0];
    if (rd?.type === 'final') { reply({ error: 'Power-ups are disabled during Final Jeopardy.' }); return; }

    room.skillsGranted = room.skillsGranted || {};
    room.powerupsGranted = room.powerupsGranted || {};

    let rearmed = false;
    for (const w of room.pendingDraw || []) {
      const have = room.skillsGranted[w.discordUserId] || [];
      if (!have.includes(w.skillId)) room.skillsGranted[w.discordUserId] = [...have, w.skillId];
      const spent = room.skillsUsed?.[w.discordUserId];
      if (spent?.includes(w.skillId)) {
        room.skillsUsed[w.discordUserId] = spent.filter((id) => id !== w.skillId);
        rearmed = true;
      }
    }
    room.pendingDraw = [];
    if (rearmed) io.to(roomCode).emit('skillsUsedUpdate', room.skillsUsed);

    const known = new Set((room.players || []).map((p) => p.discordUserId).filter(Boolean));
    if (playerPowerups && typeof playerPowerups === 'object') {
      for (const [uid, labels] of Object.entries(playerPowerups)) {
        if (!known.has(uid) || !Array.isArray(labels)) continue;
        const clean = labels.filter((l) => typeof l === 'string' && l.length <= 40).slice(0, 3);
        room.powerupsGranted[uid] = [...(room.powerupsGranted[uid] || []), ...clean];
      }
    }

    gameRooms.set(roomCode, room);
    broadcastGrants(roomCode, room);
    reply({ ok: true });
  });

  // Player activates one of their granted power-ups
  socket.on('usePowerup', ({ roomCode: rawRoomCode, label, discordUserId, targetTeamId } = {}, ack) => {
    const reply = (payload) => { if (typeof ack === 'function') ack(payload); };
    const fail = (msg) => { socket.emit('errorMsg', msg); reply({ error: msg }); };
    if (typeof rawRoomCode !== 'string' || typeof label !== 'string' || !discordUserId) { reply({ error: 'Bad request.' }); return; }
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode || roomCode.length > MAX_ROOM_CODE_LENGTH) { reply({ error: 'Bad request.' }); return; }
    const kind = POWERUP_KINDS[label];
    if (!kind) return fail('Unknown power-up.');

    const room = gameRooms.get(roomCode);
    if (!room) { reply({ error: 'Room not found.' }); return; }

    const player = (room.players || []).find(
      (p) => p.discordUserId === discordUserId && p.socketId === socket.id
    );
    if (!player || !player.teamId) return fail('Not registered in this room.');
    if (currentRound(room)?.type === 'final') return fail('Power-ups cannot be used during Final Jeopardy.');

    const held = room.powerupsGranted?.[discordUserId] || [];
    const heldIdx = held.indexOf(label);
    if (heldIdx === -1) return fail('You do not have that power-up.');

    const teams = room.board?.data?.teams || [];
    const clue = findActiveClue(room);
    const inClue = !!room.activeClue;
    const teamId = player.teamId;
    let hint = null;

    if (kind === 'double' || kind === 'shield') {
      if ((room.armedPowerups || []).some((a) => a.kind === kind && a.teamId === teamId)) {
        return fail(`Your team already has ${label} ready.`);
      }
    } else if (kind === 'steal') {
      if (room.controlDiscordUserId === discordUserId) return fail('You already have board control.');
    } else if (kind === 'freeze') {
      const target = teams.find((t) => t.id === targetTeamId);
      if (!target || target.id === teamId) return fail('Pick an opposing team to freeze.');
      if (room.frozenTeams?.[target.id]) return fail(`${target.name} is already frozen.`);
    } else if (kind === 'hint') {
      if (!inClue || !clue) return fail('Hint can only be used while a clue is open.');
      if (room.activeClue.revealed) return fail('The answer is already revealed.');
      hint = buildAnswerHint(clue.answer);
      if (!hint) return fail('This clue has no answer to hint at.');
    } else if (kind === 'rebuzz') {
      if (!inClue) return fail('Re-Buzz can only be used while a clue is open.');
      if (!room.buzzer?.live) return fail('The buzzer is not live right now.');
      if (room.frozenTeams?.[teamId]?.live) return fail('Your team is frozen.');
      const q = room.buzzer.queue || [];
      if (q[room.buzzer.activeIndex]?.id === discordUserId) return fail('You already have the floor.');
    }

    const next = [...held];
    next.splice(heldIdx, 1);
    room.powerupsGranted = { ...(room.powerupsGranted || {}), [discordUserId]: next };

    const myTeam = teams.find((t) => t.id === teamId);
    const notice = {
      label, kind,
      discordUserId,
      username: player.discordUsername || discordUserId,
      teamId,
      teamName: myTeam?.name || 'Team',
      targetTeamId: null,
      targetTeamName: null,
    };

    if (kind === 'double' || kind === 'shield') {
      room.armedPowerups = [
        ...(room.armedPowerups || []),
        { id: `pu_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, kind, label, discordUserId, username: notice.username, teamId },
      ];
    } else if (kind === 'steal') {
      room.controlDiscordUserId = discordUserId;
      emitControlState(roomCode, room);
    } else if (kind === 'freeze') {
      const target = teams.find((t) => t.id === targetTeamId);
      notice.targetTeamId = target.id;
      notice.targetTeamName = target.name;
      room.frozenTeams = { ...(room.frozenTeams || {}), [target.id]: { live: inClue } };
      if (inClue && room.buzzer?.queue?.length) {
        const b = room.buzzer;
        const queue = b.queue.filter((e, i) => i <= b.activeIndex || teamOfPlayer(room, e.id) !== target.id);
        if (queue.length !== b.queue.length) {
          room.buzzer = { ...b, queue };
          io.to(roomCode).emit('buzzerState', room.buzzer);
        }
      }
    } else if (kind === 'rebuzz') {
      const b = room.buzzer;
      const existing = (b.queue || []).find((e) => e.id === discordUserId);
      const entry = existing || {
        id: discordUserId,
        username: player.discordUsername || discordUserId,
        avatarUrl: player.discordAvatarUrl,
      };
      const rest = (b.queue || []).filter((e) => e.id !== discordUserId);
      const oldIdx = (b.queue || []).findIndex((e) => e.id === discordUserId);
      let at = Math.max(0, b.activeIndex);
      if (oldIdx !== -1 && oldIdx < at) at -= 1;
      rest.splice(at, 0, entry);
      room.buzzer = { ...b, queue: rest, activeIndex: at };
      io.to(roomCode).emit('buzzerState', room.buzzer);
    }

    gameRooms.set(roomCode, room);
    broadcastGrants(roomCode, room);
    broadcastPowerupState(roomCode, room);
    io.to(roomCode).emit('powerupUsed', { ...notice, at: Date.now() });
    if (kind === 'hint') socket.emit('powerupHint', { label, hint, catId: room.activeClue.catId, value: room.activeClue.value });
    reply({ ok: true });
  });

  socket.on('hostConsumeArmed', ({ roomCode: rawRoomCode, id } = {}) => {
    if (typeof rawRoomCode !== 'string' || typeof id !== 'string') return;
    const roomCode = rawRoomCode.trim().toUpperCase();
    if (!roomCode || roomCode.length > MAX_ROOM_CODE_LENGTH) return;
    if (!socket.isHost || socket.gameRoomCode !== roomCode) return;
    const room = gameRooms.get(roomCode);
    if (!room?.armedPowerups) return;
    room.armedPowerups = room.armedPowerups.filter((a) => a.id !== id);
    gameRooms.set(roomCode, room);
    broadcastPowerupState(roomCode, room);
  });
};
