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
  // who to reveal next, one at a time, via selectRevealTeam below.
  // revealOrder is kept only as the full set of team ids so judgeTeam
  // knows when every team has been judged (see judgeTeam).
  function startReveal(teams) {
    const rd = currentFinal();
    if (!rd || rd.phase !== "answer") return;
    rd.revealOrder = teams.map((t) => t.id);
    rd.revealedTeamIds = [];
    rd.currentRevealTeamId = null;
    rd.results = {};
    rd.phase = "reveal";
    touch();
    persist();
  }

  // Host clicks a team from the "pick who's next" list. Ignored if that
  // team was already judged (defensive — the picker UI shouldn't show
  // already-revealed teams as choices in the first place).
  function selectRevealTeam(teamId) {
    const rd = currentFinal();
    if (!rd || rd.phase !== "reveal") return;
    if (rd.revealedTeamIds.includes(teamId)) return;
    rd.currentRevealTeamId = teamId;
    touch();
    persist();
  }

  // Judges one team at a time, whichever the host picked via
  // selectRevealTeam. Advances to "done" once every team has been judged,
  // and always clears currentRevealTeamId afterward so the host lands back
  // on the picker list to choose the next team (or sees "done" if that was
  // the last one). Records the verdict in rd.results so PlayerView's
  // reveal screen (and a host-side recap) can show correct/incorrect for
  // teams already revealed, not just the score change. "done" starts with
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
    rd.currentRevealTeamId = null;
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
    rd.currentRevealTeamId = null;
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
    selectRevealTeam,
    judgeTeam,
    revealStandings,
    setStandingsSfx,
    resetFinal,
  };
}