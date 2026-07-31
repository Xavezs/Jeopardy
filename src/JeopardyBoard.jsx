import React, { useEffect, useState, useMemo } from "react";
import "./styles/board.css";
import { blankClue } from "./lib/storage";
import ClueModal from "./components/ClueModal";
import EditClueModal from "./components/EditClueModal";
import SessionsModal from "./components/SessionsModal";
import ConfirmDialog from "./components/ConfirmDialog";
import TeamRandomizer from "./components/TeamRandomizer";
import BackgroundMusicPlayer from "./components/BackgroundMusicPlayer";
import Marquee from "./components/Marquee";
import RoundTabs from "./components/RoundTabs";
import Toolbar from "./components/Toolbar";

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
import { useBgmSync } from "./lib/hooks/useBgmSync";
import { playClickSfx, playHoverTick, playCatRevealSfx, installGlobalBoardSfx } from "./lib/boardSfx";

export default function JeopardyBoard({ onBack }) {
  const [editMode, setEditMode] = useState(false);
  const [view, setView] = useState("board"); // "board" | "randomizer"
  // Buzzer is always on now — the enable/disable toggle was removed since
  // this app always runs with buzzing live.
  const buzzerEnabled = true;
  const [questionFlipped, setQuestionFlipped] = useState(false);

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
      });
    } else {
      publishActiveClue(null);
    }
  }, [clueEditor.activeClue, clueEditor.revealed, questionFlipped, playbackState, publishActiveClue]);

  useEffect(() => {
    persistence.setRoomCode(roomCode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode, persistence.setRoomCode]);

  useEffect(() => installGlobalBoardSfx(), []);

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

  const nCats = rd.categories.length;
  const nRows = rd.values.length;
  const boardGridStyle = editMode
    ? { gridTemplateColumns: `74px repeat(${nCats}, minmax(0, 1fr)) 67px`, gridTemplateRows: `74px repeat(${nRows}, minmax(0, 1fr)) 67px` }
    : { gridTemplateColumns: `repeat(${nCats}, minmax(0, 1fr))`, gridTemplateRows: `auto repeat(${nRows}, minmax(0, 1fr))` };

  const activeCat = clueEditor.activeClue ? rd.categories.find((c) => c.id === clueEditor.activeClue.catId) : null;
  const activeClueObj = activeCat && clueEditor.activeClue ? activeCat.clues[clueEditor.activeClue.value] : null;
  const editingCat = clueEditor.editingTarget ? rd.categories.find((c) => c.id === clueEditor.editingTarget.catId) : null;

  return (
    <div className="jp-root" style={{ position: "relative" }}>
      {onBack && (
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
            />
          </div>

          <div id="boardWrap">
            <div id="board" style={boardGridStyle}>
              {rd.categories.map((cat, catIndex) => {
                const isRevealed = editMode || board.revealedCats.has(cat.id);
                return (
                  <div
                    key={cat.id}
                    className={
                      "cat-cell" +
                      (board.boardFlip === "out" ? " flip-out" : "") +
                      (board.boardFlip === "in-start" ? " flip-in-start" : "") +
                      (!isRevealed ? " cat-locked" : "")
                    }
                    style={{
                      gridRow: "1",
                      gridColumn: editMode ? catIndex + 2 : catIndex + 1,
                      transitionDelay: board.flipDelay(catIndex),
                    }}
                  >
                    {editMode ? (
                      <>
                        <input
                          className="cat-name-input"
                          maxLength={30}
                          defaultValue={cat.name}
                          key={cat.id + "-name"}
                          onBlur={(e) => board.renameCategory(cat, e.target.value)}
                        />
                        <button className="cat-remove" title="Remove this category" onClick={() => board.removeCategory(cat)}>
                          ✕
                        </button>
                      </>
                    ) : isRevealed ? (
                      <div className="cat-name cat-name-reveal">{cat.name}</div>
                    ) : (
                      <button
                        className="cat-reveal-btn"
                        title="Click to reveal this category"
                        onClick={() => board.revealCategory(cat, playCatRevealSfx)}
                      >
                        <span className="cat-reveal-mark">?</span>
                      </button>
                    )}
                  </div>
                );
              })}

              {editMode && (
                <div className="grid-add-column-cell" style={{ gridColumn: nCats + 2, gridRow: `1 / span ${nRows + 1}` }}>
                  <button title="Add Category Column" onClick={board.addCategory}>
                    +
                  </button>
                </div>
              )}

              {rd.values.map((v, rowIndex) => {
                const gridRowPosition = rowIndex + 2;
                return (
                  <React.Fragment key={v}>
                    {editMode && (
                      <div className="row-control-cell" style={{ gridRow: gridRowPosition, gridColumn: 1 }}>
                        <input
                          className="row-value-input"
                          type="number"
                          min="1"
                          defaultValue={v}
                          key={v + "-value"}
                          title="Point value for this row"
                          onBlur={(e) => board.changeRowValue(v, e.target.value)}
                          onWheel={(e) => e.target.blur()}
                        />
                        <button className="row-delete-btn" title="Delete this row value pattern" onClick={() => board.removeRow(v)}>
                          <span className="icon">✕</span>
                        </button>
                      </div>
                    )}

                    {rd.categories.map((cat, catIndex) => {
                      const clue = cat.clues[v] || blankClue();
                      const cellKey = cat.id + "-" + v;
                      return (
                        <div
                          key={cellKey}
                          className={
                            "clue-cell" +
                            (clue.used ? " used" : "") +
                            (editMode ? " edit-mode-cell" : "") +
                            (board.boardFlip === "out" ? " flip-out" : "") +
                            (board.boardFlip === "in-start" ? " flip-in-start" : "") +
                            (editMode && board.dragSource && board.dragSource.catId === cat.id && board.dragSource.value === v ? " drag-source" : "") +
                            (editMode &&
                            board.dragOverKey === cellKey &&
                            !(board.dragSource && board.dragSource.catId === cat.id && board.dragSource.value === v)
                              ? " drag-over"
                              : "")
                          }
                          style={{
                            gridRow: gridRowPosition,
                            gridColumn: editMode ? catIndex + 2 : catIndex + 1,
                            transitionDelay: board.flipDelay(catIndex),
                          }}
                          draggable={editMode}
                          onDragStart={(e) => {
                            if (!editMode) return;
                            board.setDragSource({ catId: cat.id, value: v });
                            e.dataTransfer.effectAllowed = "move";
                            e.dataTransfer.setData("text/plain", cellKey);
                          }}
                          onDragOver={(e) => {
                            if (!editMode || !board.dragSource) return;
                            e.preventDefault();
                            e.dataTransfer.dropEffect = "move";
                            if (board.dragOverKey !== cellKey) board.setDragOverKey(cellKey);
                          }}
                          onDragLeave={() => {
                            board.setDragOverKey((k) => (k === cellKey ? null : k));
                          }}
                          onDrop={(e) => {
                            e.preventDefault();
                            if (!editMode || !board.dragSource) return;
                            board.swapClueCells(board.dragSource, { catId: cat.id, value: v });
                            board.setDragSource(null);
                            board.setDragOverKey(null);
                          }}
                          onDragEnd={() => {
                            board.setDragSource(null);
                            board.setDragOverKey(null);
                          }}
                          onClick={() => {
                            if (editMode) {
                              playClickSfx();
                              clueEditor.openEditModal(cat, v);
                            } else if (!clue.used) {
                              playClickSfx();
                              clueEditor.openClueModal(cat, v);
                            }
                          }}
                          onMouseEnter={() => {
                            if (editMode || !clue.used) playHoverTick();
                          }}
                        >
                          <div className="clue-value">${v}</div>
                          {editMode && clue.question?.trim() && clue.answer?.trim() && (
                            <div className={`media-dot ${clue.mediaUrl ? "has-media" : ""}`}>●</div>
                          )}
                        </div>
                      );
                    })}
                  </React.Fragment>
                );
              })}

              {editMode && (
                <div className="grid-add-row-cell" style={{ gridColumn: `1 / span ${nCats + 1}`, gridRow: nRows + 2 }}>
                  <button title="Add Value Row" onClick={board.addRow}>
                    +
                  </button>
                </div>
              )}
            </div>
          </div>

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
              buzzerEnabled={buzzerEnabled}
              buzzerLive={buzzerLive}
              buzzerWinner={buzzerWinner}
              buzzerQueue={buzzerQueue}
              buzzerActiveIndex={buzzerActiveIndex}
              onArmBuzzer={armBuzzer}
              onResetBuzzer={resetBuzzer}
              onNextBuzzer={nextBuzzer}
              onPrevBuzzer={prevBuzzer}
              resolveTeamForDiscordUser={teams.resolveTeamForDiscordUser}
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
          onSetSource={bgm.setBgmSource}
          onSetSpotifyUrl={bgm.setBgmSpotifyUrl}
          onPlaybackChange={publishBgm}
          ducking={clueEditor.duckMusic}
        />
      )}
    </div>
  );
}