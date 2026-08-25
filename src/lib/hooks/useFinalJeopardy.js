// lib/hooks/useFinalJeopardy.js
/* =========================================================================
   useFinalJeopardy
   Owns the Final Jeopardy phase state machine (category -> wager -> clue ->
   answer -> reveal -> done). Mirrors useBoardGrid's pattern (sessionRef +
   touch + persist, no local hidden state) so it syncs the same way
   everything else does — reload/refresh just picks up wherever `phase`
   currently is, same as boardFlip/currentRound do for the grid rounds.

   Wager/answer VALUES here can come from two places: the host typing them
   in manually (FinalJeopardyBoard.jsx's inputs), or a player submitting
   from their own device (relayed through useFinalSync -> JeopardyBoard.jsx
   -> setWager/setAnswer below) — both paths funnel through the same two
   functions, so there's exactly one way this data ever changes.
   ========================================================================= */
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

  // category -> wager
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

  // wager -> clue
  function startClue() {
    const rd = currentFinal();
    if (!rd || rd.phase !== "wager") return;
    rd.phase = "clue";
    touch();
    persist();
  }

  // clue -> answer
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

  // answer -> reveal. No fixed order is locked anymore — the host picks
  // who to reveal next via startRevealBatch below, one or several teams at
  // a time. revealOrder is kept only as the full set of team ids so
  // judgeTeam/judgeBatch know when every team has been judged.
  function startReveal(teams) {
    const rd = currentFinal();
    if (!rd || rd.phase !== "answer") return;
    rd.revealOrder = teams.map((t) => t.id);
    rd.revealedTeamIds = [];
    rd.currentRevealTeamIds = [];
    rd.revealStage = "hidden";
    rd.results = {};
    rd.phase = "reveal";
    touch();
    persist();
  }

  // Host confirms a selection from the "pick who's next" list — one team
  // or several at once (multi-select). Already-judged ids are filtered out
  // defensively (the picker UI shouldn't offer them in the first place).
  // A no-op empty selection is ignored rather than clearing the batch.
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

  // Staged reveal for the whole batch currently on screen: wagers first,
  // then answers — host controls the pace, and since revealStage lives
  // directly on rd (synced the same way answers/wagers/currentRevealTeamIds
  // already are), players' screens advance through the same two stages in
  // lockstep with no separate broadcast needed.
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

  // Judges a single team within the current batch (mixed verdicts across
  // the batch are fine — this is what lets the host correct one team and
  // wrong another in the same reveal). Removes the team from
  // currentRevealTeamIds as it's judged; once the batch empties, revealStage
  // resets to "hidden" so the host lands back on the picker for the next
  // batch. Advances to "done" once every team overall has been judged.
  // Records the verdict in rd.results so PlayerView's reveal screen (and
  // the host-side recap) can show correct/incorrect for teams already
  // revealed, not just the score change. "done" starts with
  // standingsRevealed=false so the host gets a beat to show the correct
  // answer on its own before advancing to the standings board (see
  // revealStandings below).
  function judgeTeam(team, correct, adjustTeamScore) {
    const rd = currentFinal();
    if (!rd || rd.phase !== "reveal") return;
    if (rd.revealedTeamIds.includes(team.id)) return;
    const wager = rd.wagers[team.id] || 0;
    adjustTeamScore(team, correct ? wager : -wager);
    rd.results = rd.results || {};
    rd.results[team.id] = correct;
    rd.revealedTeamIds.push(team.id);
    rd.currentRevealTeamIds = (rd.currentRevealTeamIds || []).filter((id) => id !== team.id);
    if (rd.currentRevealTeamIds.length === 0) rd.revealStage = "hidden";
    if (rd.revealedTeamIds.length >= rd.revealOrder.length) {
      rd.phase = "done";
      rd.standingsRevealed = false;
    }
    touch();
    persist();
  }

  // Bulk convenience for "reveal bersamaan": judges every still-unjudged
  // team in the current batch with the SAME verdict in one go (e.g. "Mark
  // All Correct"). Teams already judged individually before this is
  // clicked (mixed verdicts) are simply skipped. Shares the exact same
  // scoring/results/advance-to-"done" logic as judgeTeam, just looped.
  function judgeBatch(teams, correct, adjustTeamScore) {
    const rd = currentFinal();
    if (!rd || rd.phase !== "reveal") return;
    const ids = [...(rd.currentRevealTeamIds || [])];
    ids.forEach((id) => {
      if (rd.revealedTeamIds.includes(id)) return;
      const team = teams.find((t) => t.id === id);
      if (!team) return;
      const wager = rd.wagers[id] || 0;
      adjustTeamScore(team, correct ? wager : -wager);
      rd.results = rd.results || {};
      rd.results[id] = correct;
      rd.revealedTeamIds.push(id);
    });
    rd.currentRevealTeamIds = [];
    rd.revealStage = "hidden";
    if (rd.revealedTeamIds.length >= rd.revealOrder.length) {
      rd.phase = "done";
      rd.standingsRevealed = false;
    }
    touch();
    persist();
  }

  // done (correct-answer beat) -> done (standings shown)
  function revealStandings() {
    const rd = currentFinal();
    if (!rd || rd.phase !== "done") return;
    rd.standingsRevealed = true;
    touch();
    persist();
  }

  // Custom Final Standings celebration sound (uploaded file ref, direct
  // URL, or Google Drive link) — lives directly on rd (like rd.clue) so
  // it's synced to players the same way everything else in Final Jeopardy
  // is, no separate broadcast needed. Not touched by resetFinal, same as
  // rd.clue.mediaUrl isn't — it's a per-board customization, not part of
  // a specific playthrough's progress.
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
    rd.wagers = {};
    rd.answers = {};
    rd.revealOrder = [];
    rd.revealedTeamIds = [];
    rd.currentRevealTeamIds = [];
    rd.revealStage = "hidden";
    rd.results = {};
    rd.standingsRevealed = false;
    touch();
    persist();
  }

  return {
    currentFinal,
    setCategory,
    setClue,
    revealCategory,
    setWager,
    startClue,
    startAnswerPhase,
    setAnswer,
    startReveal,
    startRevealBatch,
    revealWager,
    revealAnswer,
    judgeTeam,
    judgeBatch,
    revealStandings,
    setStandingsSfx,
    resetFinal,
  };
}