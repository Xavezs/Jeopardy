import React, { useState, useEffect, useRef, useCallback } from "react";
import "./styles/board.css";
import {
  SessionStore,
  blankClue,
  blankCategory,
  migrateClueSchemaIfNeeded,
  MediaStore,
  isMediaRef,
  detectMediaTypeFromFile,
  detectMediaTypeFromUrl,
} from "./lib/storage";
import { formatDate, isDataUrl, humanSize } from "./lib/utils";
import ClueModal from "./components/ClueModal";
import EditClueModal from "./components/EditClueModal";
import SessionsModal from "./components/SessionsModal";
import ConfirmDialog from "./components/ConfirmDialog";
import TeamRandomizer from "./components/TeamRandomizer";
import BackgroundMusicPlayer from "./components/BackgroundMusicPlayer";
import { BgmStore } from "./lib/storage/bgmStore";
import MarqueeBulbs from "./lib/MarqueeBulbs";
import { createSfx, getSharedAudioCtx } from "./lib/sfx";
import { useScorePulse } from "./lib/hooks/useScorePulse";
import { useConfirmDialog } from "./lib/hooks/useConfirmDialog";
import { usePersistence } from "./lib/hooks/usePersistence";
import { useSessionManager } from "./lib/hooks/useSessionManager";
import { useBoardGrid } from "./lib/hooks/useBoardGrid";
import { useTeams } from "./lib/hooks/useTeams";
import { useClueEditor } from "./lib/hooks/useClueEditor";
import { useBgmSettings } from "./lib/hooks/useBgmSettings";
import { useBuzzer } from "./lib/hooks/useBuzzer";
import { playClickSfx, playHoverTick, playCatRevealSfx, installGlobalBoardSfx } from "./lib/boardSfx";

export default function JeopardyBoard() {
  const [editMode, setEditMode] = useState(false);
  const [view, setView] = useState("board"); // "board" | "randomizer"
  const [buzzerEnabled, setBuzzerEnabled] = useState(true); // Global buzzer toggle state

  const { dialog, appConfirm, appAlert, resolveDialog } = useConfirmDialog();

  const bgm = useBgmSettings({ appConfirm, appAlert });
  const persistence = usePersistence();

  const { buzzerLive, winner: buzzerWinner, armBuzzer, resetBuzzer } = useBuzzer();

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

  // Global click/hover SFX for every button in the app.
  useEffect(() => installGlobalBoardSfx(), []);

  async function resetRound() {
    if (!(await appConfirm("Reset all scores to 0 and mark all clues unused (both rounds)? Your questions/answers/media stay."))) return;
    board.resetRoundClues();
    teams.resetAllScores();
  }

  function toggleTimerEnabled() {
    const d = sessionRef.current.data;
    d.settings.timerEnabled = !d.settings.timerEnabled;
    session.touch();
    session.persist();
  }

  function setGlobalTimerDuration(rawValue) {
    const d = sessionRef.current.data;
    const parsed = parseInt(rawValue, 10);
    d.settings.timerDuration = isNaN(parsed) || parsed <= 0 ? d.settings.timerDuration : parsed;
    session.touch();
    session.persist();
  }

  /* ---------------- RESET ROUND ---------------- */
  async function resetRound() {
    if (!(await appConfirm("Reset all scores to 0 and mark all clues unused (both rounds)? Your questions/answers/media stay."))) return;
    const d = sessionRef.current.data;
    d.rounds.forEach((round) => {
      round.categories.forEach((cat) => {
        round.values.forEach((v) => {
          if (cat.clues[v]) cat.clues[v].used = false;
        });
      });
    });
    d.teams.forEach((t) => (t.score = 0));
    setRevealedCats(new Set());
    touch();
    persist();
  }

  if (!ready || !data) {
    return (
      <div className="jp-root" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: "var(--text-dim)", fontSize: 13 }}>Loading board…</div>
      </div>
    );
  }

  const data = session.data;
  const rd = data.rounds[data.currentRound];
  const nCats = rd.categories.length;
  const nRows = rd.values.length;
  const boardGridStyle = editMode
    ? { gridTemplateColumns: `74px repeat(${nCats}, minmax(0, 1fr)) 67px`, gridTemplateRows: `74px repeat(${nRows}, minmax(0, 1fr)) 67px` }
    : { gridTemplateColumns: `repeat(${nCats}, minmax(0, 1fr))`, gridTemplateRows: `auto repeat(${nRows}, minmax(0, 1fr))` };

  const activeCat = activeClue ? rd.categories.find((c) => c.id === activeClue.catId) : null;
  const activeClueObj = activeCat && activeClue ? activeCat.clues[activeClue.value] : null;

  const editingCat = editingTarget ? rd.categories.find((c) => c.id === editingTarget.catId) : null;

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
        <TeamRandomizer teams={data.teams} onApplyOrder={applyTeamOrder} onClose={() => setView("board")} />
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
              session.persist();
            }}
          />

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
            discordDisplayMode={teams.discordDisplayMode}
            onToggleDiscordMode={() => teams.setDiscordDisplayMode((m) => (m === "discord" ? "normal" : "discord"))}
            timerEnabled={data.settings.timerEnabled}
            timerDuration={data.settings.timerDuration}
            sessionId={session.session.id}
            onToggleTimerEnabled={toggleTimerEnabled}
            onSetTimerDuration={setGlobalTimerDuration}
            buzzerEnabled={buzzerEnabled}
            onToggleBuzzer={() => {
              setBuzzerEnabled((prev) => {
                const next = !prev;
                if (!next && resetBuzzer) resetBuzzer();
                return next;
              });
            }}
          />

      <div id="boardWrap">
        <div id="board" style={boardGridStyle}>
          {rd.categories.map((cat, catIndex) => {
            const isRevealed = editMode || revealedCats.has(cat.id);
            return (
              <div
                key={cat.id}
                className={
                  "cat-cell" +
                  (boardFlip === "out" ? " flip-out" : "") +
                  (boardFlip === "in-start" ? " flip-in-start" : "") +
                  (!isRevealed ? " cat-locked" : "")
                }
                style={{
                  gridRow: "1",
                  gridColumn: editMode ? catIndex + 2 : catIndex + 1,
                  transitionDelay: flipDelay(catIndex),
                }}
              >
                {editMode ? (
                  <>
                    <input
                      className="cat-name-input"
                      maxLength={30}
                      defaultValue={cat.name}
                      key={cat.id + "-name"}
                      onBlur={(e) => renameCategory(cat, e.target.value)}
                    />
                    <button className="cat-remove" title="Remove this category" onClick={() => removeCategory(cat)}>
                      ✕
                    </button>
                  </>
                ) : isRevealed ? (
                  <div className="cat-name cat-name-reveal">{cat.name}</div>
                ) : (
                  <button className="cat-reveal-btn" title="Click to reveal this category" onClick={() => revealCategory(cat)}>
                    <span className="cat-reveal-mark">?</span>
                  </button>
                )}
              </div>
            );
          })}

          {editMode && (
            <div className="grid-add-column-cell" style={{ gridColumn: nCats + 2, gridRow: `1 / span ${nRows + 1}` }}>
              <button title="Add Category Column" onClick={addCategory}>
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
                      onBlur={(e) => changeRowValue(v, e.target.value)}
                      onWheel={(e) => e.target.blur()}
                    />
                    <button className="row-delete-btn" title="Delete this row value pattern" onClick={() => removeRow(v)}>
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
                        (boardFlip === "out" ? " flip-out" : "") +
                        (boardFlip === "in-start" ? " flip-in-start" : "") +
                        (editMode && dragSource && dragSource.catId === cat.id && dragSource.value === v ? " drag-source" : "") +
                        (editMode && dragOverKey === cellKey && !(dragSource && dragSource.catId === cat.id && dragSource.value === v)
                          ? " drag-over"
                          : "")
                      }
                      style={{
                        gridRow: gridRowPosition,
                        gridColumn: editMode ? catIndex + 2 : catIndex + 1,
                        transitionDelay: flipDelay(catIndex),
                      }}
                      draggable={editMode}
                      onDragStart={(e) => {
                        if (!editMode) return;
                        setDragSource({ catId: cat.id, value: v });
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", cellKey); // Firefox requires data to be set for drag to start
                      }}
                      onDragOver={(e) => {
                        if (!editMode || !dragSource) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        if (dragOverKey !== cellKey) setDragOverKey(cellKey);
                      }}
                      onDragLeave={() => {
                        setDragOverKey((k) => (k === cellKey ? null : k));
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (!editMode || !dragSource) return;
                        swapClueCells(dragSource, { catId: cat.id, value: v });
                        setDragSource(null);
                        setDragOverKey(null);
                      }}
                      onDragEnd={() => {
                        setDragSource(null);
                        setDragOverKey(null);
                      }}
                      onClick={() => {
                        if (editMode) {
                          playClickSfx();
                          openEditModal(cat, v);
                        } else if (!clue.used) {
                          playClickSfx();
                          openClueModal(cat, v);
                        }
                      }}
                      onMouseEnter={() => {
                        if (editMode || !clue.used) playHoverTick();
                      }}
                    >
                      <div className="clue-value">${v}</div>
                      {editMode && 
                      clue.question?.trim() && 
                      clue.answer?.trim() && (
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
              <button title="Add Value Row" onClick={addRow}>
                +
              </button>
            </div>
          )}
        </div>
      </div>

      <div id="teamsWrap">
        {data.teams.map((team) => (
          <div
            key={team.id}
            className={
              "team-card" +
              (!editMode && selectedScoreTeamId === team.id ? " kb-selected" : "")
            }
            role={editMode ? undefined : "button"}
            tabIndex={editMode ? undefined : 0}
            title={editMode ? undefined : `Select (or press ${data.teams.indexOf(team) + 1}), then use ↑ / ↓ to adjust score`}
            aria-label={editMode ? undefined : `Select ${team.name}'s score to adjust with arrow keys, or press ${data.teams.indexOf(team) + 1}`}
            onClick={() => {
              if (editMode) return;
              setSelectedScoreTeamId((id) => (id === team.id ? null : team.id));
            }}
          >
            {editMode && (
              <button className="team-remove" title="Remove this team" onClick={() => removeTeam(team)}>
                ✕
              </button>
            )}
            {editMode ? (
               <input
                className="team-name-input"
                disabled={!editMode}
                defaultValue={team.name}
                key={team.id + "-name"}
                onBlur={(e) => renameTeam(team, e.target.value)}
              />
            ) : (
              <div className="team-name-display">{team.name}</div>
            )}
            <div className="team-score-row">
              {editMode ? (
                <input
                  className="team-score-display team-score-input"
                  type="number"
                  defaultValue={team.score}
                  key={team.id + "-score"}
                  title="Set this team's score manually"
                  onBlur={(e) => setTeamScore(team, e.target.value)}
                  onWheel={(e) => e.target.blur()}
                />
              ) : (
                <div
                  className={
                    "team-score-display" +
                    (scorePulse[team.id] ? " " + scorePulse[team.id] : "") +
                    (selectedScoreTeamId === team.id ? " kb-selected" : "")
                  }
                >
                  ${team.score}
                </div>
              )}
            </div>
          </div>
        ))}
        {editMode && (
          <div className="team-add-card">
            <button title="Add Team" onClick={addTeam}>
              +
            </button>
          </div>
        )}
      </div>

      <div className="save-indicator">{saveMsg || "\u00A0"}</div>

          {clueEditor.activeClue && activeCat && activeClueObj && (
            <ClueModal
              activeCat={activeCat}
              value={clueEditor.activeClue.value}
              clue={activeClueObj}
              teams={data.teams}
              revealed={clueEditor.revealed}
              onToggleReveal={() => clueEditor.setRevealed((r) => !r)}
              onClose={clueEditor.closeClueModal}
              onAdjustTeamScore={teams.adjustTeamScore}
              timerEnabled={data.settings.timerEnabled}
              timerSeconds={activeClueObj.timerSeconds != null ? activeClueObj.timerSeconds : data.settings.timerDuration}
              onDuckMusic={clueEditor.setDuckMusic}
              resolveDiscordMembersForTeam={teams.resolveDiscordMembersForTeam}
              scorePulse={teams.scorePulse}
              buzzerEnabled={buzzerEnabled}
              setBuzzerEnabled={setBuzzerEnabled}
              buzzerLive={buzzerLive}
              buzzerWinner={buzzerWinner}
              onArmBuzzer={armBuzzer}
              onResetBuzzer={resetBuzzer}
              resolveTeamForDiscordUser={teams.resolveTeamForDiscordUser}
            />
          )}

      {editingTarget && editingCat && (
        <EditClueModal
          editForm={editForm}
          setEditForm={setEditForm}
          mediaState={mediaState}
          setMediaState={setMediaState}
          onMediaFile={handleMediaFile}
          onClearMedia={clearMediaField}
          onSave={saveClue}
          onClose={closeEditModal}
          defaultTimerSeconds={data.settings.timerDuration}
        />
      )}

      {sessionsModalOpen && (
        <SessionsModal
          session={session}
          sessionIndex={sessionIndex}
          onClose={() => setSessionsModalOpen(false)}
          onLoad={handleLoadSession}
          onDuplicate={handleDuplicateSession}
          onDelete={handleDeleteSession}
          onCreateNew={handleCreateNewSession}
          onRenameCommit={handleRenameSessionCommit}
        />
      )}
        </>
      )}

      <ConfirmDialog dialog={dialog} onResolve={resolveDialog} />
      {bgmSettings && (
        <BackgroundMusicPlayer
          settings={bgm.bgmSettings}
          onUploadFile={bgm.handleBgmUpload}
          onClear={bgm.clearBgm}
          onVolumeChange={bgm.setBgmVolume}
          onToggleLoop={bgm.toggleBgmLoop}
          onSetSource={bgm.setBgmSource}
          onSetSpotifyUrl={bgm.setBgmSpotifyUrl}
          ducking={clueEditor.duckMusic}
        />
      )}
      <DiscordOverlay />
    </div>
  );
}