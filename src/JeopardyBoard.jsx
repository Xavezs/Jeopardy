import React, { useEffect, useState, useMemo } from "react";
import "./styles/board.css";
import "./styles/final-jeopardy.css";
import { blankClue } from "./lib/storage";
import ClueGrid from "./components/ClueGrid";
import ClueModal from "./components/ClueModal";
import EditClueModal from "./components/EditClueModal";
import SessionsModal from "./components/SessionsModal";
import ConfirmDialog from "./components/ConfirmDialog";
import TeamRandomizer from "./components/TeamRandomizer";
import BackgroundMusicPlayer from "./components/BackgroundMusicPlayer";
import Marquee from "./components/Marquee";
import RoundTabs from "./components/RoundTabs";
import Toolbar from "./components/Toolbar";
import FinalJeopardyBoard from "./components/FinalJeopardyBoard";

import { useConfirmDialog } from "./lib/hooks/useConfirmDialog";
import { usePersistence } from "./lib/hooks/usePersistence";
import { useSessionManager } from "./lib/hooks/useSessionManager";
import { useBoardGrid } from "./lib/hooks/useBoardGrid";
import { useTeams } from "./lib/hooks/useTeams";
import { useCategoryRevealSync } from "./lib/hooks/useCategoryRevealSync";
import { useRoundBannerSync } from "./lib/hooks/useRoundBannerSync";
import { useClueEditor } from "./lib/hooks/useClueEditor";
import { useBgmSettings } from "./lib/hooks/useBgmSettings";
import { useBuzzer } from "./lib/hooks/useBuzzer";
import { useClueSync } from "./lib/hooks/useClueSync";
import { useControlSync } from "./lib/hooks/useControlSync";
import { useWagerSync } from "./lib/hooks/useWagerSync";
import { useFinalSync } from "./lib/hooks/useFinalSync";
import { useFinalJeopardy } from "./lib/hooks/useFinalJeopardy";
import { useBgmSync } from "./lib/hooks/useBgmSync";
import { playCatRevealSfx } from "./lib/boardSfx";

export default function JeopardyBoard({ onBack }) {
  const [editMode, setEditMode] = useState(false);
  const [view, setView] = useState("board"); // "board" | "randomizer"
  // Buzzer is always on now — the enable/disable toggle was removed since
  // this app always runs with buzzing live.
  const buzzerEnabled = true;
  const [questionFlipped, setQuestionFlipped] = useState(false);
  // Lifted the same way as questionFlipped/revealed — lets the locked-in
  // wager amount survive re-renders and (later, if you wire useClueSync
  // to include it) get broadcast to PlayerView the same way revealed/
  // flipped already are.
  const [dailyDoubleWager, setDailyDoubleWager] = useState(null);

  const { dialog, appConfirm, appAlert, resolveDialog } = useConfirmDialog();

  const bgm = useBgmSettings({ appConfirm, appAlert });
  const persistence = usePersistence();

  const board = useBoardGrid({
    sessionRef: persistence.sessionRef,
    touch: persistence.touch,
    persist: persistence.persist,
    appConfirm,
    appAlert,
  });

  const final = useFinalJeopardy({
    sessionRef: persistence.sessionRef,
    touch: persistence.touch,
    persist: persistence.persist,
    currentRoundOf: board.currentRoundOf,
  });

  const clueEditor = useClueEditor({
    sessionRef: persistence.sessionRef,
    touch: persistence.touch,
    persist: persistence.persist,
    currentRoundOf: board.currentRoundOf,
    appConfirm,
    appAlert,
  });

  const teams = useTeams({
    sessionRef: persistence.sessionRef,
    touch: persistence.touch,
    persist: persistence.persist,
    editMode,
    activeClue: clueEditor.activeClue,
    setView,
    markTeamDeleted: persistence.markTeamDeleted,
    markTeamAdded: persistence.markTeamAdded,
    players: persistence.players,
  });

  const session = useSessionManager({
    persistence,
    ensureClueGrid: board.ensureClueGrid,
    performFlip: board.performFlip,
    initBgm: bgm.initBgm,
    onSwitched: ({ editMode: nextEditMode }) => {
      setEditMode(nextEditMode);
      clueEditor.setActiveClue(null);
      clueEditor.closeEditModal();
      board.setRevealedCats(new Set());
    },
    appConfirm,
  });

  const roomCode = session.session?.roomCode || null;

  function ensureRoomCode() {
    if (session.session.roomCode) return session.session.roomCode;
    const code = Array.from({ length: 6 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"[Math.floor(Math.random() * 32)]).join("");
    session.session.roomCode = code;
    persistence.persist();
    return code;
  }

  useEffect(() => {
    if (session.ready && session.session && !session.session.roomCode) {
      ensureRoomCode();
    }
  }, [session.ready, session.session]);

  const { buzzerLive, queue: buzzerQueue, activeIndex: buzzerActiveIndex, winner: buzzerWinner, armBuzzer, resetBuzzer, nextBuzzer, prevBuzzer } = useBuzzer(roomCode, null);

  const { publishActiveClue } = useClueSync(roomCode);

  // Board control: who's allowed to pick the next clue. The host itself
  // always has free pick (that's the inline board grid below, unchanged);
  // this is what lets a PLAYER'S pick actually open something. When a
  // player's selectClue is validated server-side, it comes back here as
  // `clueSelected`, and the host responds by opening its own clueEditor
  // modal exactly as if it had clicked the cell itself — the host's local
  // state stays the single source of truth for reveal/timer/judging, a
  // player pick is just a remote trigger for it. `judgeAnswer` is handed
  // to ClueModal below so scoring a correct, buzzed-in answer transfers
  // control to that player.
  const { controlDiscordUserId, judgeAnswer, hostSetControl } = useControlSync(roomCode, null, {
    onClueSelected: ({ catId, value }) => {
      const data = session.data;
      if (!data) return;
      const currentRd = data.rounds?.[data.currentRound] || data.rounds?.[0];
      const cat = currentRd?.categories.find((c) => c.id === catId);
      if (cat) clueEditor.openClueModal(cat, value);
    },
  });
  // Daily Double wager, submitted by whoever currently holds board control
  // (the player who picked the clue) from their own device. The server
  // already validated discordUserId === controlDiscordUserId before
  // relaying this — the check here is just a defensive re-confirm against
  // whatever this tab currently thinks controlDiscordUserId is, in case
  // control moved on (e.g. host used the manual fallback, then a stale/
  // duplicate event from the player arrives a moment later) between the
  // clue opening and this event landing.
  const { submitWager } = useWagerSync(roomCode, null, {
    onWagerSubmitted: ({ discordUserId, amount }) => {
      if (discordUserId !== controlDiscordUserId) return;
      setDailyDoubleWager(amount);
    },
  });

  // Final Jeopardy wager/answer submitted from a player's own device —
  // parallel across all teams, no control-holder gate (see useFinalSync).
  // Resolves discordUserId -> team the same way judgeAnswer's buzz race
  // does (teams.resolveTeamForDiscordUser), then clamps the wager against
  // that team's current score before writing it in, same clamp
  // FinalJeopardyBoard's own manual input applies. A team already below
  // $0 may wager up to the size of its debt (so a correct answer brings
  // it exactly back to $0), rather than being floored to a $0 max.
  useFinalSync(roomCode, null, {
    onFinalWagerSubmitted: ({ discordUserId, amount }) => {
      const team = teams.resolveTeamForDiscordUser(discordUserId);
      if (!team) return;
      const maxWager = team.score < 0 ? Math.abs(team.score) : team.score;
      const clamped = Math.max(0, Math.min(maxWager, Number(amount) || 0));
      final.setWager(team.id, clamped);
    },
    onFinalAnswerSubmitted: ({ discordUserId, answer }) => {
      const team = teams.resolveTeamForDiscordUser(discordUserId);
      if (!team) return;
      final.setAnswer(team.id, answer);
    },
  });

  const { publishRevealedCats } = useCategoryRevealSync(roomCode);
  const { publishRoundBanner } = useRoundBannerSync(roomCode);
  const { publishBgm } = useBgmSync(roomCode);

  useEffect(() => {
    publishRevealedCats(Array.from(board.revealedCats));
  }, [board.revealedCats, publishRevealedCats]);

  // Mirrors the round-switch banner (RoundTabs' pop-up "DOUBLE JEOPARDY!"
  // announcement) to players in real time — board.roundBanner already
  // drives the host's own banner render, this just relays the same value.
  // PlayerView uses this SAME signal (not a separate broadcast) to also
  // time its own local flip-ripple choreography, since a second broadcast
  // for boardFlip would race against boardUpdate over a different socket
  // with no ordering guarantee between the two.
  useEffect(() => {
    publishRoundBanner(board.roundBanner);
  }, [board.roundBanner, publishRoundBanner]);

  const [playbackState, setPlaybackState] = useState({ isPlaying: false, currentTime: 0 });

  useEffect(() => {
    setPlaybackState({ isPlaying: false, currentTime: 0 });
    setQuestionFlipped(false);
    setDailyDoubleWager(null);
  }, [clueEditor.activeClue?.catId, clueEditor.activeClue?.value]);

  useEffect(() => {
    if (clueEditor.activeClue) {
      publishActiveClue({
        catId: clueEditor.activeClue.catId,
        value: clueEditor.activeClue.value,
        revealed: clueEditor.revealed,
        flipped: questionFlipped,
        isPlaying: playbackState.isPlaying,
        currentTime: playbackState.currentTime,
        dailyDoubleWager,
      });
    } else {
      publishActiveClue(null);
    }
  }, [clueEditor.activeClue, clueEditor.revealed, questionFlipped, playbackState, publishActiveClue, dailyDoubleWager]);

  useEffect(() => {
    persistence.setRoomCode(roomCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode, persistence.setRoomCode]);

  // Click/hover sfx is installed once at the App root (covers every
  // screen: RoleSelect, LoginGate, and this board) — see App.jsx, not here.

  async function resetRound() {
    if (!(await appConfirm("Reset all scores to 0 and mark all clues unused (both rounds)? Your questions/answers/media stay."))) return;
    board.resetRoundClues();
    teams.resetAllScores();
  }

  function toggleTimerEnabled() {
    const d = session.data;
    d.settings.timerEnabled = !d.settings.timerEnabled;
    session.touch();
    persistence.persist();
  }

  // Off by default (undefined -> !undefined -> true on first toggle, same
  // as toggleTimerEnabled) — that preserves the original Daily Double rule
  // (only the wagering team may answer, no buzz race) for every board that
  // hasn't explicitly opted into the house-rule variant.
  function toggleDdBuzzerEnabled() {
    const d = session.data;
    d.settings.ddBuzzerEnabled = !d.settings.ddBuzzerEnabled;
    session.touch();
    persistence.persist();
  }

  // Off by default (undefined -> !undefined -> true on first toggle, same
  // as toggleDdBuzzerEnabled) — preserves the original house rule (min
  // wager = the clue's own value, so the range is value..2x) for every
  // board that hasn't explicitly opted into allowing a $0 minimum. When
  // on, teams can wager anywhere from $0 up to 2x the clue's value.
  function toggleDdMinWagerZero() {
    const d = session.data;
    d.settings.ddMinWagerZero = !d.settings.ddMinWagerZero;
    session.touch();
    persistence.persist();
  }

  // Off by default (undefined -> !undefined -> true on first toggle, same
  // pattern as the two toggles above) — preserves the original house rule
  // (max wager = 2x the clue's own value) for every board that hasn't
  // explicitly opted in. When on, the max wager is based on the wagering
  // team's own current score instead of the clue's value — combined with
  // ddMinWagerZero this gives 4 total wager-range combinations:
  //   min 0        + max card value  (original default)
  //   min face val + max card value  (ddMinWagerZero off, this off)
  //   min 0        + max team score  (ddMinWagerZero on,  this on)
  //   min face val + max team score  (ddMinWagerZero off, this on)
  function toggleDdWagerBasisPlayerScore() {
    const d = session.data;
    d.settings.ddWagerBasisPlayerScore = !d.settings.ddWagerBasisPlayerScore;
    session.touch();
    persistence.persist();
  }

  function setGlobalTimerDuration(rawValue) {
    const d = session.data;
    const parsed = parseInt(rawValue, 10);
    d.settings.timerDuration = isNaN(parsed) || parsed <= 0 ? d.settings.timerDuration : parsed;
    session.touch();
    persistence.persist();
  }

  if (!session.ready || !session.data) {
    return (
      <div className="jp-root" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: "var(--text-dim)", fontSize: 13 }}>Loading board…</div>
      </div>
    );
  }

  const data = session.data;
  const rd = data.rounds?.[data.currentRound] || data.rounds?.[0];

  if (!rd) {
    return (
      <div className="jp-root" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: "var(--text-dim)", fontSize: 13 }}>No round configuration available.</div>
      </div>
    );
  }

  // Final Jeopardy has no categories/values grid at all (see
  // sessionStore.js's blankFinalRound) — these all fall back to safe
  // defaults for that round rather than crashing on rd.categories.length.
  const nCats = rd.type === "final" ? 0 : rd.categories.length;
  const nRows = rd.type === "final" ? 0 : rd.values.length;
  const boardGridStyle =
    rd.type === "final"
      ? {}
      : editMode
      ? { gridTemplateColumns: `74px repeat(${nCats}, minmax(0, 1fr)) 67px`, gridTemplateRows: `74px repeat(${nRows}, minmax(0, 1fr)) 67px` }
      : { gridTemplateColumns: `repeat(${nCats}, minmax(0, 1fr))`, gridTemplateRows: `auto repeat(${nRows}, minmax(0, 1fr))` };

  const activeCat = rd.type !== "final" && clueEditor.activeClue ? rd.categories.find((c) => c.id === clueEditor.activeClue.catId) : null;
  const activeClueObj = activeCat && clueEditor.activeClue ? activeCat.clues[clueEditor.activeClue.value] : null;
  const editingCat = rd.type !== "final" && clueEditor.editingTarget ? rd.categories.find((c) => c.id === clueEditor.editingTarget.catId) : null;

  return (
    <div className="jp-root" style={{ position: "relative" }}>
      {onBack && view !== "randomizer" && (
        <button
          type="button"
          onClick={onBack}
          className="jp-role-back-btn"
        >
          <span className="jp-role-back-arrow">←</span> Back
        </button>
      )}

      {view === "randomizer" ? (
        <TeamRandomizer teams={data.teams} onApplyOrder={teams.applyTeamOrder} onClose={() => setView("board")} />
      ) : (
        <>
          <Marquee
            editMode={editMode}
            title={data.title}
            sessionId={session.session.id}
            sessionName={session.session.name}
            sessionUpdatedAt={session.session.updatedAt}
            onTitleCommit={(title) => {
              data.title = title;
              persistence.persist();
            }}
          />

          <div className="jp-control-bar">
            <RoundTabs
              rounds={data.rounds}
              currentRound={data.currentRound}
              onSwitchRound={(idx) =>
                board.switchRound(idx, () => {
                  clueEditor.setActiveClue(null);
                  clueEditor.closeEditModal();
                })
              }
              roundBanner={board.roundBanner}
            />

            <Toolbar
              editMode={editMode}
              onToggleEditMode={() => setEditMode((v) => !v)}
              onOpenSessions={session.openSessionsModal}
              onOpenRandomizer={() => setView("randomizer")}
              onResetRound={resetRound}
              timerEnabled={data.settings.timerEnabled}
              timerDuration={data.settings.timerDuration}
              sessionId={session.session.id}
              onToggleTimerEnabled={toggleTimerEnabled}
              onSetTimerDuration={setGlobalTimerDuration}
              roomCode={roomCode}
              players={persistence.players}
              teams={data.teams}
              controlDiscordUserId={controlDiscordUserId}
              onHostSetControl={hostSetControl}
              onRandomizeDailyDoubles={board.randomizeDailyDoubles}
              ddBuzzerEnabled={data.settings.ddBuzzerEnabled}
              onToggleDdBuzzerEnabled={toggleDdBuzzerEnabled}
              ddMinWagerZero={data.settings.ddMinWagerZero}
              onToggleDdMinWagerZero={toggleDdMinWagerZero}
              ddWagerBasisPlayerScore={data.settings.ddWagerBasisPlayerScore}
              onToggleDdWagerBasisPlayerScore={toggleDdWagerBasisPlayerScore}
            />
          </div>

          {rd.type === "final" ? (
            <FinalJeopardyBoard
              rd={rd}
              editMode={editMode}
              teams={data.teams}
              final={final}
              adjustTeamScore={teams.adjustTeamScore}
              appConfirm={appConfirm}
              appAlert={appAlert}
              resolveDiscordMembersForTeam={teams.resolveDiscordMembersForTeam}
            />
          ) : (
            <ClueGrid
              rd={rd}
              nCats={nCats}
              nRows={nRows}
              boardGridStyle={boardGridStyle}
              editMode={editMode}
              boardFlip={board.boardFlip}
              flipDelay={board.flipDelay}
              revealedCats={board.revealedCats}
              revealCategory={(cat) => board.revealCategory(cat, playCatRevealSfx)}
              renameCategory={board.renameCategory}
              removeCategory={board.removeCategory}
              addCategory={board.addCategory}
              changeRowValue={board.changeRowValue}
              removeRow={board.removeRow}
              addRow={board.addRow}
              dragSource={board.dragSource}
              setDragSource={board.setDragSource}
              dragOverKey={board.dragOverKey}
              setDragOverKey={board.setDragOverKey}
              swapClueCells={board.swapClueCells}
              openEditModal={clueEditor.openEditModal}
              openClueModal={clueEditor.openClueModal}
              toggleDailyDouble={board.toggleDailyDouble}
              blankClue={blankClue}
            />
          )}

          {!(rd.type === "final" && rd.phase === "done" && rd.standingsRevealed) && (
          <div id="scoreboardSection">
            <div id="teamsWrap">
            {[...data.teams].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).map((team, rankIdx) => {
              const discordTeamMembers = teams.resolveDiscordMembersForTeam(team);
              return (
                <div
                  key={team.id}
                  className={
                    "team-card" +
                    (editMode ? " is-editing" : "") +
                    (!editMode && teams.selectedScoreTeamId === team.id ? " kb-selected" : "") +
                    (discordTeamMembers.some((m) => m.speaking) ? " discord-speaking" : "")
                  }
                  role={editMode ? undefined : "button"}
                  tabIndex={editMode ? undefined : 0}
                  title={editMode ? undefined : `Select (or press ${data.teams.indexOf(team) + 1}), then use ↑ / ↓ to adjust score`}
                  aria-label={editMode ? undefined : `Select ${team.name}'s score to adjust with arrow keys, or press ${data.teams.indexOf(team) + 1}`}
                  onClick={() => {
                    if (editMode) return;
                    teams.setSelectedScoreTeamId((id) => (id === team.id ? null : team.id));
                  }}
                >
                  {editMode && (
                    <button className="team-remove" title="Remove this team" onClick={() => teams.removeTeam(team)}>
                      ✕
                    </button>
                  )}
                  {editMode ? (
                    <>
                      <input
                        className="team-name-input"
                        disabled={!editMode}
                        defaultValue={team.name}
                        key={team.id + "-name"}
                        onBlur={(e) => teams.renameTeam(team, e.target.value)}
                      />
                      {teams.discordDisplayMode === "discord" && (
                        <div className="team-discord-picker" key={team.id + "-discord"}>
                          {teams.discordMembers.map((m) => {
                            const assignedIds = Array.isArray(team.discordUserIds)
                              ? team.discordUserIds
                              : team.discordUserId
                              ? [team.discordUserId]
                              : [];
                            return (
                              <button
                                type="button"
                                key={m.id}
                                className={"team-discord-chip" + (assignedIds.includes(m.id) ? " is-selected" : "")}
                                title={m.username}
                                onClick={() => teams.toggleTeamDiscordUser(team, m.id)}
                              >
                                <img src={m.avatarUrl} alt="" />
                                {m.speaking && <span className="team-discord-chip-speaking-dot" />}
                              </button>
                            );
                          })}
                          {teams.discordMembers.length === 0 && (
                            <span className="team-discord-picker-empty">No one's in voice yet</span>
                          )}
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="team-name-display">
                      {discordTeamMembers.length > 0 && (
                        <div className="team-discord-facepile">
                          {discordTeamMembers.map((dm) => (
                            <div className="team-discord-avatar-wrap" key={dm.id}>
                              <img
                                src={dm.avatarUrl}
                                alt=""
                                className={"team-discord-avatar" + (dm.speaking ? " is-speaking" : "")}
                                style={{ opacity: dm.deafened ? 0.4 : 1 }}
                              />
                              {dm.muted && <div className="team-discord-muted-badge" title="Muted" />}
                            </div>
                          ))}
                        </div>
                      )}
                      <span className="team-name-text">{team.name}</span>
                    </div>
                  )}
                  <div className="team-score-row">
                    {editMode ? (
                      <input
                        className="team-score-display team-score-input"
                        type="number"
                        defaultValue={team.score}
                        key={team.id + "-score"}
                        title="Set this team's score manually"
                        onBlur={(e) => teams.setTeamScore(team, e.target.value)}
                        onWheel={(e) => e.target.blur()}
                      />
                    ) : (
                      <div
                        className={
                          "team-score-display" +
                          (teams.scorePulse[team.id] ? " " + teams.scorePulse[team.id] : "") +
                          (teams.selectedScoreTeamId === team.id ? " kb-selected" : "")
                        }
                      >
                        ${team.score}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {editMode && (
              <div className="team-add-card">
                <button title="Add Team" onClick={teams.addTeam}>
                  +
                </button>
              </div>
            )}
            </div>
          </div>
          )}

          <div className="save-indicator">{session.saveMsg || "\u00A0"}</div>

          {clueEditor.activeClue && activeCat && activeClueObj && (
            <ClueModal
              activeCat={activeCat}
              value={clueEditor.activeClue.value}
              clue={activeClueObj}
              teams={data.teams}
              revealed={clueEditor.revealed}
              onToggleReveal={() => clueEditor.setRevealed((r) => !r)}
              flipped={questionFlipped}
              onFlip={() => setQuestionFlipped(true)}
              onClose={clueEditor.closeClueModal}
              onAdjustTeamScore={teams.adjustTeamScore}
              timerEnabled={data.settings.timerEnabled}
              timerSeconds={activeClueObj.timerSeconds != null ? activeClueObj.timerSeconds : data.settings.timerDuration}
              onDuckMusic={clueEditor.setDuckMusic}
              onMediaStateChange={(state) => setPlaybackState((prev) => ({ ...prev, ...state }))}
              resolveDiscordMembersForTeam={teams.resolveDiscordMembersForTeam}
              scorePulse={teams.scorePulse}
              buzzerEnabled={buzzerEnabled && (!activeClueObj.isDailyDouble || !!data.settings.ddBuzzerEnabled)}
              buzzerLive={buzzerLive}
              buzzerWinner={buzzerWinner}
              buzzerQueue={buzzerQueue}
              buzzerActiveIndex={buzzerActiveIndex}
              onArmBuzzer={armBuzzer}
              onResetBuzzer={resetBuzzer}
              onNextBuzzer={nextBuzzer}
              onPrevBuzzer={prevBuzzer}
              resolveTeamForDiscordUser={teams.resolveTeamForDiscordUser}
              onJudgeAnswer={judgeAnswer}
              dailyDoubleWager={dailyDoubleWager}
              onSetWager={setDailyDoubleWager}
              controlDiscordUserId={controlDiscordUserId}
              ddMinWagerZero={data.settings.ddMinWagerZero}
              ddWagerBasisPlayerScore={data.settings.ddWagerBasisPlayerScore}
            />
          )}

          {clueEditor.editingTarget && editingCat && (
            <EditClueModal
              editForm={clueEditor.editForm}
              setEditForm={clueEditor.setEditForm}
              mediaState={clueEditor.mediaState}
              setMediaState={clueEditor.setMediaState}
              onMediaFile={clueEditor.handleMediaFile}
              onClearMedia={clueEditor.clearMediaField}
              onSave={clueEditor.saveClue}
              onClose={clueEditor.closeEditModal}
              defaultTimerSeconds={data.settings.timerDuration}
            />
          )}

          {session.sessionsModalOpen && (
            <SessionsModal
              session={session.session}
              sessionIndex={session.sessionIndex}
              onClose={() => session.setSessionsModalOpen(false)}
              onLoad={session.handleLoadSession}
              onDuplicate={session.handleDuplicateSession}
              onDelete={session.handleDeleteSession}
              onCreateNew={session.handleCreateNewSession}
              onRenameCommit={session.handleRenameSessionCommit}
            />
          )}
        </>
      )}

      <ConfirmDialog dialog={dialog} onResolve={resolveDialog} />
      {bgm.bgmSettings && (
        <BackgroundMusicPlayer
          settings={bgm.bgmSettings}
          onUploadFile={bgm.handleBgmUpload}
          onClear={bgm.clearBgm}
          onVolumeChange={bgm.setBgmVolume}
          onToggleLoop={bgm.toggleBgmLoop}
          onSetDirectUrl={bgm.setBgmDirectUrl}
          onSetSoundcloudUrl={bgm.setBgmSoundcloudUrl}
          onPlaybackChange={publishBgm}
          ducking={clueEditor.duckMusic}
        />
      )}
    </div>
  );
}