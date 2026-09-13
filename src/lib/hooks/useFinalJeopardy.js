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
    rd.judgeHistory = [];
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
  //
  // `amountOverride`: how many points to actually apply, instead of the
  // team's full wager — the host's Full/Half/Custom preset picker in
  // FinalJeopardyBoard.jsx feeds this. Undefined/null means "no override,
  // use the wager as-is", so every existing caller that doesn't pass this
  // keeps behaving exactly as before.
  //
  // Every judgment (here and in judgeBatch below) also pushes an entry
  // onto rd.judgeHistory — {teamId, delta, advancedToDone} — which is
  // ALL undoLastJudge needs to cleanly reverse it: reapply -delta to that
  // team's score, un-mark them as revealed, and if this was the specific
  // judgment that flipped the round to "done", drop back to "reveal".
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

  // Bulk convenience for "reveal bersamaan": judges every still-unjudged
  // team in the current batch with the SAME verdict in one go (e.g. "Mark
  // All Correct"). Teams already judged individually before this is
  // clicked (mixed verdicts) are simply skipped. Shares the exact same
  // scoring/results/advance-to-"done" logic as judgeTeam, just looped —
  // including pushing one rd.judgeHistory entry PER team, so "Undo" after
  // a batch judgment always undoes exactly one team at a time, the same
  // as after an individual judgment.
  //
  // `getAmount(teamId, wager)`: same override idea as judgeTeam's
  // amountOverride, but per-team since each team in the batch can have its
  // own Full/Half/Custom preset selected. Omitting it falls back to each
  // team's own wager, same as before this parameter existed.
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

  // Reverses the single most recent judgment (from either judgeTeam or
  // judgeBatch — see rd.judgeHistory, a flat list either one pushes onto
  // regardless of which was used). Reapplies -delta to that team's score,
  // un-marks them as revealed/judged, and puts them back into
  // currentRevealTeamIds with revealStage="answer" so the host can
  // immediately re-judge them without re-running the wager/answer reveal
  // beats. If that judgment was the one that flipped the round to "done",
  // drops back to "reveal" too (and clears standingsRevealed, though it
  // should never have been true yet — see the guard below).
  //
  // Deliberately refuses once standings are actually showing
  // (phase "done" && standingsRevealed): by then the host has already
  // moved on to presenting final results, possibly with saveGameResult
  // about to fire, and silently rewinding score history under that is
  // more likely to confuse than help. Undo is for "wait, I misjudged
  // that" in the moment, not for re-litigating after the fact.
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
    startClue,
    startAnswerPhase,
    setAnswer,
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