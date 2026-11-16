function pick(map, ids) {
  const out = {};
  if (!map || typeof map !== 'object') return out;
  for (const id of ids) {
    if (map[id] !== undefined) out[id] = map[id];
  }
  return out;
}

function redactFinalRound(rd, isCurrent, viewerTeamIds) {
  const phase = rd.phase;
  const inReveal = isCurrent && (phase === 'reveal' || phase === 'done');
  const stage = rd.revealStage;
  const judged = inReveal ? rd.revealedTeamIds || [] : [];
  const onScreen = isCurrent && phase === 'reveal' ? rd.currentRevealTeamIds || [] : [];

  const wagerIds = new Set([...judged, ...viewerTeamIds]);
  const answerIds = new Set([...judged, ...viewerTeamIds]);
  if (stage === 'wager' || stage === 'answer') onScreen.forEach((id) => wagerIds.add(id));
  if (stage === 'answer') onScreen.forEach((id) => answerIds.add(id));

  const correctVisible =
    isCurrent && (phase === 'done' || (phase === 'reveal' && (stage === 'answer' || judged.length > 0)));

  const out = { ...rd, wagers: pick(rd.wagers, wagerIds), answers: pick(rd.answers, answerIds) };
  if (!correctVisible && rd.clue) {
    const clue = { ...rd.clue };
    delete clue.answer;
    delete clue.answerMediaUrl;
    delete clue.answerMediaType;
    out.clue = clue;
  }
  return out;
}

function redactClueAnswers(rd, isCurrent, activeClue) {
  const openKey = isCurrent && activeClue?.revealed ? `${activeClue.catId}|${activeClue.value}` : null;
  return {
    ...rd,
    categories: (rd.categories || []).map((cat) => ({
      ...cat,
      clues: Object.fromEntries(
        Object.entries(cat.clues || {}).map(([value, clue]) => {
          if (!clue || typeof clue !== 'object') return [value, clue];
          if (openKey && openKey === `${cat.id}|${value}`) return [value, clue];
          if (clue.answer === undefined && clue.answerMediaUrl === undefined && clue.answerMediaType === undefined) return [value, clue];
          const c = { ...clue };
          delete c.answer;
          delete c.answerMediaUrl;
          delete c.answerMediaType;
          return [value, c];
        })
      ),
    })),
  };
}

function redactBoardData(data, viewerTeamIds = [], activeClue = null) {
  const rounds = data?.rounds;
  if (!Array.isArray(rounds)) return data;
  const currentIndex = rounds[data.currentRound] ? data.currentRound : 0;
  return {
    ...data,
    rounds: rounds.map((rd, i) => {
      if (rd?.type === 'final') return redactFinalRound(rd, i === currentIndex, viewerTeamIds);
      if (rd && Array.isArray(rd.categories)) return redactClueAnswers(rd, i === currentIndex, activeClue);
      return rd;
    }),
  };
}

function createBoardEmitters({ io, playerOfSocket }) {
  function viewerTeamIds(room, socket) {
    const player = playerOfSocket(room, socket.id);
    if (!player) return [];
    const ids = new Set();
    if (player.teamId) ids.add(player.teamId);
    for (const t of room?.board?.data?.teams || []) {
      if (player.discordUserId && Array.isArray(t.discordUserIds) && t.discordUserIds.includes(player.discordUserId)) {
        ids.add(t.id);
      }
    }
    return [...ids];
  }

  function boardFor(room, socket, cache) {
    const board = room?.board;
    if (!board) return null;
    if (socket.isHost) return board;
    const teamIds = viewerTeamIds(room, socket);
    const key = [...teamIds].sort().join('|');
    if (cache && cache.has(key)) return cache.get(key);
    const data = redactBoardData(board.data, teamIds, room.activeClue);
    const out = data === board.data ? board : { ...board, data };
    if (cache) cache.set(key, out);
    return out;
  }

  function broadcastBoard(roomCode, room, { exceptSocketId } = {}) {
    if (!room?.board) return;
    const ids = io.sockets?.adapter?.rooms?.get(roomCode);
    if (!ids) return;
    const cache = new Map();
    for (const id of ids) {
      if (id === exceptSocketId) continue;
      const target = io.sockets.sockets.get(id);
      if (!target) continue;
      target.emit('boardUpdate', boardFor(room, target, cache));
    }
  }

  return { boardFor, broadcastBoard };
}

module.exports = { redactBoardData, redactFinalRound, createBoardEmitters };
