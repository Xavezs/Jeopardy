import React, { useEffect, useState, useMemo, useRef, useContext } from "react";
import "./styles/board.css";
import "./styles/final-jeopardy.css";
import { blankClue } from "./lib/storage";
import ClueGrid from "./components/ClueGrid";
import TeamCard from "./components/TeamCard";
import ClueModal from "./components/ClueModal";
import EditClueModal from "./components/EditClueModal";
import SessionsModal from "./components/SessionsModal";
import ConfirmDialog from "./components/ConfirmDialog";
import TeamRandomizer from "./components/TeamRandomizer";
import BackgroundMusicPlayer from "./components/BackgroundMusicPlayer";
import ShopWidget from "./components/ShopWidget";
import SkillOverlay from "./components/SkillOverlay";
import { HIT_AT } from "./components/DomainExpansion";
import PowerDrawOverlay from "./components/PowerDrawOverlay";
import { PowerupNotice } from "./components/PowerupUI";
import { useSkillSync } from "./lib/hooks/useSkillSync";
import { DiscordContext } from "./components/DiscordContext";
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
import { useControlSync, OPEN_CONTROL } from "./lib/hooks/useControlSync";
import { useWagerSync } from "./lib/hooks/useWagerSync";
import { useFinalSync } from "./lib/hooks/useFinalSync";
import { useFinalJeopardy } from "./lib/hooks/useFinalJeopardy";
import { useBgmSync } from "./lib/hooks/useBgmSync";
import { useRandomizerSync } from "./lib/hooks/useRandomizerSync";
import { useStatsSync } from "./lib/hooks/useStatsSync";
import { SessionStore } from "./lib/storage";
import { playCatRevealSfx, subscribeSfxDucking, loadFinalStandingsVolume, setFinalStandingsVolume } from "./lib/boardSfx";

export default function JeopardyBoard({ onBack }) {
  // Host's own Discord identity
  const discordAuth = useContext(DiscordContext);
  const hostDiscordUserId = discordAuth?.user?.id ?? null;
  const [editMode, setEditMode] = useState(false);
  const [view, setView] = useState("board"); // "board" | "randomizer"
  // Buzzer is always on now
  const buzzerEnabled = true;
  const [questionFlipped, setQuestionFlipped] = useState(false);
  // Lifted the same way as questionFlipped/revealed
  const [dailyDoubleWager, setDailyDoubleWager] = useState(null);

  const [sfxDucking, setSfxDucking] = useState(false);
  useEffect(() => subscribeSfxDucking(setSfxDucking), []);

  // Final Standings celebration sound's volume
  const [finalStandingsVolume, setFinalStandingsVolumeState] = useState(1);
  useEffect(() => {
    let cancelled = false;
    loadFinalStandingsVolume().then((v) => {
      if (!cancelled) setFinalStandingsVolumeState(v);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  function handleFinalStandingsVolumeChange(v) {
    setFinalStandingsVolumeState(v);
    setFinalStandingsVolume(v);
  }

  const { dialog, appConfirm, appAlert, resolveDialog } = useConfirmDialog();

  const bgmApiRef = useRef({});
  function initBgmBridge(loadedSessionData) {
    return bgmApiRef.current.initBgm?.(loadedSessionData);
  }

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
    initBgm: initBgmBridge,
    onSwitched: ({ editMode: nextEditMode }) => {
      setEditMode(nextEditMode);
      clueEditor.setActiveClue(null);
      clueEditor.closeEditModal();
      board.setRevealedCats(new Set());
    },
    appConfirm,
  });

  const sessionData = session.data;
  const activeRd = sessionData?.rounds?.[sessionData.currentRound] || sessionData?.rounds?.[0];
  const roundKey = activeRd?.type === "final" ? "final" : String(sessionData?.currentRound ?? 0);
  const roundLabel = activeRd?.type === "final" ? "Final Jeopardy" : `Round ${(sessionData?.currentRound ?? 0) + 1}`;

  const bgm = useBgmSettings({ appConfirm, appAlert, roundKey });
  bgmApiRef.current.initBgm = bgm.initBgm;

  const roomCode = session.session?.roomCode || null;
  const roomCodeRequestRef = useRef(null);

  useEffect(() => {
    if (
      !session.ready ||
      !session.session ||
      session.session.roomCode ||
      roomCodeRequestRef.current === session.session.id
    ) {
      return;
    }

    const sessionId = session.session.id;
    roomCodeRequestRef.current = sessionId;
    SessionStore.inviteToBoard(sessionId)
      .then(({ roomCode: persistentRoomCode }) => {
        if (!persistentRoomCode) {
          throw new Error("The server did not return a room code.");
        }

        session.session.roomCode = persistentRoomCode;
        persistence.touch();
      })
      .catch((err) => {
        if (roomCodeRequestRef.current === sessionId) roomCodeRequestRef.current = null;
        console.error("Unable to create or restore the persistent room code:", err);
      });
  }, [session.ready, session.session, persistence]);

  const { buzzerLive, queue: buzzerQueue, activeIndex: buzzerActiveIndex, winner: buzzerWinner, armBuzzer, resetBuzzer, nextBuzzer, prevBuzzer } = useBuzzer(roomCode, null);

  const { publishActiveClue } = useClueSync(roomCode);

  const { controlDiscordUserId, judgeAnswer, hostSetControl } = useControlSync(roomCode, null, {
    onClueSelected: ({ catId, value }) => {
      const data = session.data;
      if (!data) return;
      const currentRd = data.rounds?.[data.currentRound] || data.rounds?.[0];
      const cat = currentRd?.categories.find((c) => c.id === catId);
      if (cat) clueEditor.openClueModal(cat, value);
    },
    onLocalControlChanged: (nextControlDiscordUserId) => {
      const currentSession = persistence.sessionRef.current;
      if (!currentSession?.data) return;
      if (currentSession.data.controlDiscordUserId === nextControlDiscordUserId) return;
      currentSession.data.controlDiscordUserId = nextControlDiscordUserId;
      persistence.persist();
    },
  });
  const { submitWager } = useWagerSync(roomCode, null, {
    onWagerSubmitted: ({ discordUserId, amount }) => {
      if (discordUserId !== controlDiscordUserId) return;
      setDailyDoubleWager(amount);
    },
  });

  useFinalSync(roomCode, null, {
    onFinalWagerSubmitted: ({ discordUserId, amount }) => {
      const team = teams.resolveTeamForDiscordUser(discordUserId);
      if (!team) return;
      const maxWager = team.score < 0 ? Math.abs(team.score) : team.score;
      const clamped = Math.max(0, Math.min(maxWager, Number(amount) || 0));
      final.submitWagerFromPlayer(team.id, clamped);
    },
    onFinalAnswerSubmitted: ({ discordUserId, answer }) => {
      const team = teams.resolveTeamForDiscordUser(discordUserId);
      if (!team) return;
      final.submitAnswerFromPlayer(team.id, answer);
    },
  });

  const { publishRevealedCats } = useCategoryRevealSync(roomCode);
  const { publishRoundBanner } = useRoundBannerSync(roomCode);
  const { publishBgm } = useBgmSync(roomCode);
  const { publishRandomizer } = useRandomizerSync(roomCode);
  const { playerStats } = useStatsSync(roomCode);

  // Skills (e.g
  const {
    activeSkill, clearActiveSkill, powerDrawResult, runPowerDraw, runPowerApply, clearPowerDrawResult,
    armedPowerups, frozenTeams, powerupNotice, clearPowerupNotice, consumeArmed,
    pendingSkillDeltas, ackSkillDeltas,
  } = useSkillSync(roomCode, null);
  const appliedSkillRef = useRef(null);
  const applySkillDeltas = (eventId, deltas) => {
    const current = persistence.sessionRef.current;
    if (!current?.data?.teams) return;
    const applied = current.data.appliedSkillEvents || [];
    if (eventId && applied.includes(eventId)) {
      ackSkillDeltas(eventId);
      return;
    }
    for (const { teamId, delta } of deltas || []) {
      const team = current.data.teams.find((t) => t.id === teamId);
      if (team) team.score = Math.max(0, (Number(team.score) || 0) + delta);
    }
    if (eventId) current.data.appliedSkillEvents = [...applied, eventId].slice(-20);
    persistence.persist();
    ackSkillDeltas(eventId);
  };
  const applySkillDeltasRef = useRef(applySkillDeltas);
  applySkillDeltasRef.current = applySkillDeltas;

  useEffect(() => {
    const skill = activeSkill;
    if (!skill?.deltas?.length || appliedSkillRef.current === skill) return;
    appliedSkillRef.current = skill;
    setTimeout(() => {
      applySkillDeltasRef.current(skill.eventId, skill.deltas);
    }, HIT_AT + 600);
  }, [activeSkill]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    for (const entry of pendingSkillDeltas || []) {
      applySkillDeltasRef.current(entry.id, entry.deltas);
    }
  }, [pendingSkillDeltas]);
  const handleSkillDone = () => clearActiveSkill();

  useEffect(() => {
    if (view !== "randomizer") publishRandomizer(null);
  }, [view, publishRandomizer]);

  useEffect(() => {
    publishRevealedCats(Array.from(board.revealedCats));
  }, [board.revealedCats, publishRevealedCats]);

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

  async function rotateRoomCode() {
    const oldRoomCode = roomCode;
    const { roomCode: newRoomCode } = await SessionStore.rotateInviteCode(session.session.id);
    if (!newRoomCode || newRoomCode === oldRoomCode) throw new Error("The server did not return a new room code.");
    await persistence.rotateRoomCode(oldRoomCode, newRoomCode);
    persistence.setSession((currentSession) =>
      currentSession ? { ...currentSession, roomCode: newRoomCode } : currentSession
    );
  }

  async function resetRound() {
    if (!(await appConfirm("Reset all scores to 0 and mark all clues unused (both rounds)? Your questions/answers/media stay."))) return;
    board.resetRoundClues();
    teams.resetAllScores();
  }

  async function handleEndGame() {
    if (!(await appConfirm("End the game and save final standings? This can't be undone."))) return;

    const teamsList = data.teams;
    const ranking = [...teamsList]
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .map((t, i) => ({ teamId: t.id, rank: i + 1, score: t.score ?? 0 }));

    const playerStatsWithIdentity = Object.fromEntries(
      Object.entries(playerStats).map(([discordUserId, counts]) => {
        const p = (persistence.players || []).find((pl) => pl.discordUserId === discordUserId);
        return [
          discordUserId,
          {
            username: p?.discordUsername || null,
            teamId: p?.teamId || null,
            correct: counts.correct || 0,
            wrong: counts.wrong || 0,
          },
        ];
      })
    );

    try {
      await SessionStore.saveGameResult(session.session.id, {
        teams: teamsList.map((t) => ({ id: t.id, name: t.name, score: t.score ?? 0 })),
        ranking,
        playerStats: playerStatsWithIdentity,
      });
    } catch (e) {
      console.error("Failed to save game result:", e);
      appAlert("Couldn't save final standings — check your connection and try again.");
    }
  }

  function toggleTimerEnabled() {
    const d = session.data;
    d.settings.timerEnabled = !d.settings.timerEnabled;
    session.touch();
    persistence.persist();
  }

  // On by default
  function toggleDdBuzzerEnabled() {
    const d = session.data;
    d.settings.ddBuzzerEnabled = !d.settings.ddBuzzerEnabled;
    session.touch();
    persistence.persist();
  }

  function toggleDdMinWagerZero() {
    const d = session.data;
    d.settings.ddMinWagerZero = !d.settings.ddMinWagerZero;
    session.touch();
    persistence.persist();
  }

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

  function applyRandomizerOrder(order) {
    teams.applyTeamOrder(order);
    const firstDiscordId = order[0]?.discordUserIds?.[0] || null;
    hostSetControl(firstDiscordId || OPEN_CONTROL);
    publishRandomizer(null);
  }

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
        <TeamRandomizer
          teams={data.teams}
          players={persistence.players || []}
          myDiscordUserId={null}
          onApplyOrder={applyRandomizerOrder}
          onClose={() => setView("board")}
          onBroadcast={publishRandomizer}
          onPowerDraw={runPowerDraw}
          onPowerApply={runPowerApply}
        />
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
              onPowerDraw={runPowerDraw}
              onResetRound={resetRound}
              roomCode={roomCode}
              players={persistence.players}
              teams={data.teams}
              controlDiscordUserId={controlDiscordUserId}
              onHostSetControl={hostSetControl}
              onEndGame={handleEndGame}
              onRotateRoomCode={rotateRoomCode}
              appConfirm={appConfirm}
              appAlert={appAlert}
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
              players={persistence.players}
              playerStats={playerStats}
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
              timerEnabled={data.settings.timerEnabled}
              timerDuration={data.settings.timerDuration}
              sessionId={session.session.id}
              onToggleTimerEnabled={toggleTimerEnabled}
              onSetTimerDuration={setGlobalTimerDuration}
              ddBuzzerEnabled={data.settings.ddBuzzerEnabled}
              onToggleDdBuzzerEnabled={toggleDdBuzzerEnabled}
              ddMinWagerZero={data.settings.ddMinWagerZero}
              onToggleDdMinWagerZero={toggleDdMinWagerZero}
              ddWagerBasisPlayerScore={data.settings.ddWagerBasisPlayerScore}
              onToggleDdWagerBasisPlayerScore={toggleDdWagerBasisPlayerScore}
              onRandomizeDailyDoubles={board.randomizeDailyDoubles}
            />
          )}

          {!(rd.type === "final" && rd.phase === "done" && rd.standingsRevealed) && (
          <div id="scoreboardSection">
            <div id="teamsWrap">
            {[...data.teams].sort((a, b) => (b.score ?? 0) - (a.score ?? 0)).map((team) => (
              <TeamCard
                key={team.id}
                team={team}
                teamIndex={data.teams.indexOf(team)}
                editMode={editMode}
                selectedScoreTeamId={teams.selectedScoreTeamId}
                setSelectedScoreTeamId={teams.setSelectedScoreTeamId}
                discordDisplayMode={teams.discordDisplayMode}
                discordTeamMembers={teams.resolveDiscordMembersForTeam(team)}
                discordMembers={teams.discordMembers}
                toggleTeamDiscordUser={teams.toggleTeamDiscordUser}
                removeTeam={teams.removeTeam}
                renameTeam={teams.renameTeam}
                setTeamScore={teams.setTeamScore}
                scorePulse={teams.scorePulse}
              />
            ))}
            {editMode && data.teams.length === 0 && (
              <div className="teams-empty-placeholder">
                <span className="teams-empty-placeholder-text">No teams yet</span>
                <span className="teams-empty-placeholder-hint">Hit + to add one</span>
              </div>
            )}
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
              armedPowerups={armedPowerups}
              onConsumeArmed={consumeArmed}
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
              categoryName={editingCat?.name}
              clueValue={clueEditor.editingTarget.value}
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
      {bgm.bgmSettings && bgm.activeTrack && (
        <BackgroundMusicPlayer
          track={bgm.activeTrack}
          volume={bgm.bgmSettings.volume}
          mode={bgm.bgmSettings.mode}
          onSetMode={bgm.setBgmMode}
          roundLabel={roundLabel}
          onUploadFile={bgm.handleBgmUpload}
          onClear={bgm.clearBgm}
          onVolumeChange={bgm.setBgmVolume}
          onToggleLoop={bgm.toggleBgmLoop}
          onSetDirectUrl={bgm.setBgmDirectUrl}
          onPlaybackChange={publishBgm}
          ducking={clueEditor.duckMusic || sfxDucking}
          finalStandingsVolume={finalStandingsVolume}
          onFinalStandingsVolumeChange={handleFinalStandingsVolumeChange}
        />
      )}
      <ShopWidget discordUserId={hostDiscordUserId} />
      <SkillOverlay activeSkill={activeSkill} onDone={handleSkillDone} />
      <PowerDrawOverlay result={powerDrawResult} onDone={clearPowerDrawResult} />
      <PowerupNotice notice={powerupNotice} onDone={clearPowerupNotice} />
    </div>
  );
}