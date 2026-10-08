
export const DEFAULT_FINAL_TIMER_SECONDS = 0;

export function useFinalJeopardy({ sessionRef, touch, persist, currentRoundOf }) {
  function currentFinal() {
    const rd = currentRoundOf(sessionRef.current.data);
    return rd && rd.type === "final" ? rd : null;
  }

  function setCategory(text) {
    const rd = currentFinal();
    if (!rd) return;
    rd.category = text;
    touch();
    persist();
  }

  function setClue(patch) {
    const rd = currentFinal();
    if (!rd) return;
    rd.clue = { ...rd.clue, ...patch };
    touch();
    persist();
  }

  function revealCategory() {
    const rd = currentFinal();
    if (!rd || rd.phase !== "category") return;
    rd.phase = "wager";
    touch();
    persist();
  }

  function setWager(teamId, amount) {
    const rd = currentFinal();
    if (!rd || rd.phase !== "wager") return;
    rd.wagers[teamId] = amount;
    touch();
    persist();
  }

  // Player-originated wager (relayed from the server)
  function submitWagerFromPlayer(teamId, amount) {
    const rd = currentFinal();
    if (!rd || rd.phase !== "wager") return false;
    if (rd.wagers[teamId] != null) return false;
    rd.wagers[teamId] = amount;
    touch();
    persist();
    return true;
  }

  // Per-board answer-timer length in seconds
  function setTimerSeconds(seconds) {
    const rd = currentFinal();
    if (!rd) return;
    const n = Math.round(Number(seconds));
    rd.timerSeconds = Number.isFinite(n) ? Math.max(0, Math.min(300, n)) : DEFAULT_FINAL_TIMER_SECONDS;
    touch();
    persist();
  }

  function startClue(teamsToFill) {
    const rd = currentFinal();
    if (!rd || rd.phase !== "wager") return;
    if (Array.isArray(teamsToFill)) {
      teamsToFill.forEach((t) => {
        if (rd.wagers[t.id] == null) rd.wagers[t.id] = 0;
      });
    }
    const seconds = rd.timerSeconds == null ? DEFAULT_FINAL_TIMER_SECONDS : rd.timerSeconds;
    rd.clueDeadline = seconds > 0 ? Date.now() + seconds * 1000 : null;
    rd.phase = "clue";
    touch();
    persist();
  }

  function startAnswerPhase() {
    const rd = currentFinal();
    if (!rd || rd.phase !== "clue") return;
    rd.phase = "answer";
    touch();
    persist();
  }

  function setAnswer(teamId, text) {
    const rd = currentFinal();
    if (!rd) return;
    rd.answers[teamId] = text;
    touch();
    persist();
  }

  // Player-originated answer (relayed from the server)
  function submitAnswerFromPlayer(teamId, text) {
    const rd = currentFinal();
    if (!rd || (rd.phase !== "clue" && rd.phase !== "answer")) return false;
    if (typeof text !== "string") return false;
    if (rd.answers[teamId] != null) return false;
    rd.answers[teamId] = text;
    touch();
    persist();
    return true;
  }

  function startReveal(teams) {
    const rd = currentFinal();
    if (!rd || rd.phase !== "answer") return;
    rd.revealOrder = teams.map((t) => t.id);
    rd.revealedTeamIds = [];
    rd.currentRevealTeamIds = [];
    rd.revealStage = "hidden";
    rd.results = {};
    rd.judgeHistory = [];
    rd.phase = "reveal";
    touch();
    persist();
  }

  function startRevealBatch(teamIds) {
    const rd = currentFinal();
    if (!rd || rd.phase !== "reveal") return;
    const ids = (teamIds || []).filter((id) => !rd.revealedTeamIds.includes(id));
    if (ids.length === 0) return;
    rd.currentRevealTeamIds = ids;
    rd.revealStage = "hidden";
    touch();
    persist();
  }

  function revealWager() {
    const rd = currentFinal();
    if (!rd || rd.phase !== "reveal" || !rd.currentRevealTeamIds?.length) return;
    rd.revealStage = "wager";
    touch();
    persist();
  }

  function revealAnswer() {
    const rd = currentFinal();
    if (!rd || rd.phase !== "reveal" || !rd.currentRevealTeamIds?.length) return;
    rd.revealStage = "answer";
    touch();
    persist();
  }

  function judgeTeam(team, correct, adjustTeamScore, amountOverride) {
    const rd = currentFinal();
    if (!rd || rd.phase !== "reveal") return;
    if (rd.revealedTeamIds.includes(team.id)) return;
    const wager = rd.wagers[team.id] || 0;
    const amount = amountOverride != null ? amountOverride : wager;
    const delta = correct ? amount : -amount;
    adjustTeamScore(team, delta);
    rd.results = rd.results || {};
    rd.results[team.id] = correct;
    rd.revealedTeamIds.push(team.id);
    rd.currentRevealTeamIds = (rd.currentRevealTeamIds || []).filter((id) => id !== team.id);
    if (rd.currentRevealTeamIds.length === 0) rd.revealStage = "hidden";
    rd.judgeHistory = rd.judgeHistory || [];
    const historyEntry = { teamId: team.id, delta, advancedToDone: false };
    rd.judgeHistory.push(historyEntry);
    if (rd.revealedTeamIds.length >= rd.revealOrder.length) {
      rd.phase = "done";
      rd.standingsRevealed = false;
      historyEntry.advancedToDone = true;
    }
    touch();
    persist();
  }

  function judgeBatch(teams, correct, adjustTeamScore, getAmount) {
    const rd = currentFinal();
    if (!rd || rd.phase !== "reveal") return;
    const ids = [...(rd.currentRevealTeamIds || [])];
    rd.judgeHistory = rd.judgeHistory || [];
    ids.forEach((id) => {
      if (rd.revealedTeamIds.includes(id)) return;
      const team = teams.find((t) => t.id === id);
      if (!team) return;
      const wager = rd.wagers[id] || 0;
      const amount = getAmount ? getAmount(id, wager) : wager;
      const delta = correct ? amount : -amount;
      adjustTeamScore(team, delta);
      rd.results = rd.results || {};
      rd.results[id] = correct;
      rd.revealedTeamIds.push(id);
      rd.judgeHistory.push({ teamId: id, delta, advancedToDone: false });
    });
    rd.currentRevealTeamIds = [];
    rd.revealStage = "hidden";
    if (rd.revealedTeamIds.length >= rd.revealOrder.length) {
      rd.phase = "done";
      rd.standingsRevealed = false;
      if (rd.judgeHistory.length > 0) rd.judgeHistory[rd.judgeHistory.length - 1].advancedToDone = true;
    }
    touch();
    persist();
  }

  function undoLastJudge(teams, adjustTeamScore) {
    const rd = currentFinal();
    if (!rd) return;
    if (rd.phase === "done" && rd.standingsRevealed) return;
    if (rd.phase !== "reveal" && rd.phase !== "done") return;
    const history = rd.judgeHistory || [];
    if (history.length === 0) return;
    const last = history[history.length - 1];
    const team = teams.find((t) => t.id === last.teamId);
    if (team) adjustTeamScore(team, -last.delta);
    if (rd.results) delete rd.results[last.teamId];
    rd.revealedTeamIds = rd.revealedTeamIds.filter((id) => id !== last.teamId);
    rd.currentRevealTeamIds = [...new Set([...(rd.currentRevealTeamIds || []), last.teamId])];
    rd.revealStage = "answer";
    if (last.advancedToDone) {
      rd.phase = "reveal";
      rd.standingsRevealed = false;
    }
    rd.judgeHistory = history.slice(0, -1);
    touch();
    persist();
  }

  function revealStandings() {
    const rd = currentFinal();
    if (!rd || rd.phase !== "done") return;
    rd.standingsRevealed = true;
    touch();
    persist();
  }

  function setStandingsSfx(patch) {
    const rd = currentFinal();
    if (!rd) return;
    Object.assign(rd, patch);
    touch();
    persist();
  }

  function resetFinal() {
    const rd = currentFinal();
    if (!rd) return;
    rd.phase = "category";
    rd.clueDeadline = null;
    rd.wagers = {};
    rd.answers = {};
    rd.revealOrder = [];
    rd.revealedTeamIds = [];
    rd.currentRevealTeamIds = [];
    rd.revealStage = "hidden";
    rd.results = {};
    rd.standingsRevealed = false;
    rd.judgeHistory = [];
    touch();
    persist();
  }

  return {
    currentFinal,
    setCategory,
    setClue,
    revealCategory,
    setWager,
    submitWagerFromPlayer,
    setTimerSeconds,
    startClue,
    startAnswerPhase,
    setAnswer,
    submitAnswerFromPlayer,
    startReveal,
    startRevealBatch,
    revealWager,
    revealAnswer,
    judgeTeam,
    judgeBatch,
    undoLastJudge,
    revealStandings,
    setStandingsSfx,
    resetFinal,
  };
}