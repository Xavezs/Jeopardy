import test from "node:test";
import assert from "node:assert/strict";
import { useFinalJeopardy } from "../src/lib/hooks/useFinalJeopardy.js";

function createFinalGame() {
  const data = {
    currentRound: 0,
    rounds: [
      {
        type: "final",
        phase: "category",
        wagers: {},
        answers: {},
        revealOrder: [],
        revealedTeamIds: [],
      },
    ],
  };
  const sessionRef = { current: { data } };
  let touches = 0;
  let persists = 0;
  const final = useFinalJeopardy({
    sessionRef,
    currentRoundOf: (sessionData) => sessionData.rounds[sessionData.currentRound],
    touch: () => {
      touches += 1;
    },
    persist: () => {
      persists += 1;
    },
  });

  return { data, final, get touches() { return touches; }, get persists() { return persists; } };
}

function teams() {
  return [
    { id: "team-a", name: "Team A", score: 1000 },
    { id: "team-b", name: "Team B", score: 500 },
  ];
}

function adjustTeamScore(team, delta) {
  team.score += delta;
}

test("Final Jeopardy advances through its phases in order", () => {
  const game = createFinalGame();
  const rd = game.data.rounds[0];

  game.final.revealCategory();
  assert.equal(rd.phase, "wager");
  game.final.setWager("team-a", 400);
  game.final.setWager("team-b", 200);
  game.final.startClue();
  assert.equal(rd.phase, "clue");
  game.final.startAnswerPhase();
  assert.equal(rd.phase, "answer");
  game.final.startReveal(teams());

  assert.equal(rd.phase, "reveal");
  assert.deepEqual(rd.revealOrder, ["team-a", "team-b"]);
  assert.ok(game.touches > 0);
  assert.equal(game.touches, game.persists);
});

test("Final Jeopardy ignores transitions from the wrong phase", () => {
  const game = createFinalGame();
  const rd = game.data.rounds[0];

  game.final.startClue();
  game.final.setWager("team-a", 999);

  assert.equal(rd.phase, "category");
  assert.deepEqual(rd.wagers, {});
  assert.equal(game.touches, 0);
  assert.equal(game.persists, 0);
});

test("batch judging applies per-team amounts and finishes the round", () => {
  const game = createFinalGame();
  const rd = game.data.rounds[0];
  const gameTeams = teams();

  game.final.revealCategory();
  game.final.setWager("team-a", 400);
  game.final.setWager("team-b", 200);
  game.final.startClue();
  game.final.startAnswerPhase();
  game.final.startReveal(gameTeams);
  game.final.startRevealBatch(["team-a", "team-b"]);
  game.final.judgeBatch(gameTeams, true, adjustTeamScore, (id, wager) => (id === "team-a" ? wager / 2 : wager));

  assert.equal(gameTeams[0].score, 1200);
  assert.equal(gameTeams[1].score, 700);
  assert.deepEqual(rd.revealedTeamIds, ["team-a", "team-b"]);
  assert.equal(rd.phase, "done");
  assert.equal(rd.judgeHistory.length, 2);
  assert.equal(rd.judgeHistory[1].advancedToDone, true);
});

test("undo reverses the last judgment and returns the team to the reveal queue", () => {
  const game = createFinalGame();
  const rd = game.data.rounds[0];
  const gameTeams = teams();

  game.final.revealCategory();
  game.final.setWager("team-a", 400);
  game.final.setWager("team-b", 200);
  game.final.startClue();
  game.final.startAnswerPhase();
  game.final.startReveal(gameTeams);
  game.final.startRevealBatch(["team-a"]);
  game.final.judgeTeam(gameTeams[0], false, adjustTeamScore);

  assert.equal(gameTeams[0].score, 600);
  assert.equal(rd.phase, "reveal");
  game.final.undoLastJudge(gameTeams, adjustTeamScore);

  assert.equal(gameTeams[0].score, 1000);
  assert.deepEqual(rd.revealedTeamIds, []);
  assert.deepEqual(rd.currentRevealTeamIds, ["team-a"]);
  assert.equal(rd.revealStage, "answer");
  assert.equal(rd.judgeHistory.length, 0);
});

test("player submissions are gated to their phase and first submission per team wins", () => {
  const game = createFinalGame();
  const rd = game.data.rounds[0];

  assert.equal(game.final.submitWagerFromPlayer("team-a", 100), false); // category phase
  game.final.revealCategory();
  assert.equal(game.final.submitWagerFromPlayer("team-a", 100), true);
  assert.equal(game.final.submitWagerFromPlayer("team-a", 900), false); // teammate / resubmit
  assert.equal(rd.wagers["team-a"], 100);
  assert.equal(game.final.submitAnswerFromPlayer("team-a", "too early"), false);

  game.final.setWager("team-a", 250);
  assert.equal(rd.wagers["team-a"], 250);

  game.final.startClue();
  assert.equal(game.final.submitWagerFromPlayer("team-b", 50), false); // wagers closed
  assert.equal(game.final.submitAnswerFromPlayer("team-a", "first"), true);
  assert.equal(game.final.submitAnswerFromPlayer("team-a", "second"), false);
  game.final.startAnswerPhase();
  assert.equal(game.final.submitAnswerFromPlayer("team-b", "late but allowed"), true);
  assert.equal(game.final.submitAnswerFromPlayer("team-b", 42), false);
  game.final.startReveal(teams());
  assert.equal(game.final.submitAnswerFromPlayer("team-b", "after reveal"), false);
  assert.deepEqual(rd.answers, { "team-a": "first", "team-b": "late but allowed" });
});

test("startClue can lock missing wagers at $0 and the answer timer is off by default", () => {
  const game = createFinalGame();
  const rd = game.data.rounds[0];
  game.final.revealCategory();
  game.final.setWager("team-a", 300);
  game.final.startClue(teams()); // team-b never wagered

  assert.deepEqual(rd.wagers, { "team-a": 300, "team-b": 0 });
  assert.equal(rd.phase, "clue");
  assert.equal(rd.clueDeadline, null);
});

test("a configured timer sets a deadline when the clue starts", () => {
  const game = createFinalGame();
  const rd = game.data.rounds[0];
  game.final.setTimerSeconds(30);
  game.final.revealCategory();
  game.final.startClue();
  const msLeft = rd.clueDeadline - Date.now();
  assert.ok(msLeft > 25000 && msLeft <= 30000, `timer should be ~30s, got ${msLeft}ms`);
});

test("a click event passed to startClue is not treated as a team list, and timer 0 disables the deadline", () => {
  const game = createFinalGame();
  const rd = game.data.rounds[0];
  game.final.revealCategory();
  game.final.setTimerSeconds(0);
  game.final.startClue({ type: "click" });
  assert.equal(rd.phase, "clue");
  assert.deepEqual(rd.wagers, {});
  assert.equal(rd.clueDeadline, null);
});

test("setTimerSeconds clamps and resetFinal clears the running deadline but keeps the setting", () => {
  const game = createFinalGame();
  const rd = game.data.rounds[0];
  game.final.setTimerSeconds(9999);
  assert.equal(rd.timerSeconds, 300);
  game.final.setTimerSeconds(45);
  game.final.revealCategory();
  game.final.startClue();
  assert.ok(rd.clueDeadline > Date.now());
  game.final.resetFinal();
  assert.equal(rd.clueDeadline, null);
  assert.equal(rd.timerSeconds, 45);
  assert.equal(rd.phase, "category");
});
