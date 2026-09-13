import React, { useState } from "react";
import { OPEN_CONTROL } from "../lib/hooks/useControlSync";

// Manual "who gets to pick next" override. Only players with a resolved
// discordUserId are assignable — that's the same key hostSetControl and
// the rest of the control-sync system use (see useControlSync.js), so
// anyone without one (e.g. testing outside Discord) can't be targeted.
// Deliberately NOT filtered to `connected === true`: the main reason a
// host reaches for this is exactly because someone disconnected mid-game
// and control needs to move off them — hiding disconnected players would
// remove the one option a host needs in that moment.
function ControlAssign({ players, teams, controlDiscordUserId, onHostSetControl }) {
  const assignable = (players || []).filter((p) => p.discordUserId);
  if (assignable.length === 0) return null;

  const teamNameById = new Map((teams || []).map((t) => [t.id, t.name]));

  return (
    <div className="control-assign-container" title="Manually hand board-pick control to a specific player">
      <span className="control-assign-label">Board control</span>
      <select
        className="control-assign-select"
        value={controlDiscordUserId || ""}
        onChange={(e) => onHostSetControl(e.target.value || null)}
      >
        <option value="">Locked — host only</option>
        <option value={OPEN_CONTROL}>Open — anyone can pick</option>
        {assignable.map((p) => {
          const teamName = p.teamId ? teamNameById.get(p.teamId) : null;
          return (
            <option key={p.discordUserId} value={p.discordUserId}>
              {(teamName ? `${teamName} ` : "") + `(${p.discordUsername || p.discordUserId})` + (p.connected === false ? " (disconnected)" : "")}
            </option>
          );
        })}
      </select>
    </div>
  );
}

export default function Toolbar({
  editMode,
  onToggleEditMode,
  onOpenSessions,
  onOpenRandomizer,
  onResetRound,
  timerEnabled,
  timerDuration,
  sessionId,
  onToggleTimerEnabled,
  onSetTimerDuration,
  roomCode,
  players,
  teams,
  controlDiscordUserId,
  onHostSetControl,
  onRandomizeDailyDoubles,
  ddBuzzerEnabled,
  onToggleDdBuzzerEnabled,
  ddMinWagerZero,
  onToggleDdMinWagerZero,
  ddWagerBasisPlayerScore,
  onToggleDdWagerBasisPlayerScore,
  onEndGame,
}) {
  const [copyState, setCopyState] = useState("idle"); // "idle" | "copied" | "error"

  async function copyRoomCode() {
    if (!roomCode) return;

    let success = false;

    // Preferred path: async Clipboard API. This can silently be missing or
    // throw inside the Discord Activity iframe (no clipboard-write
    // permission), so we can't rely on it alone.
    try {
      const clipboardAllowed = navigator.permissions
        ? await navigator.permissions.query({ name: "clipboard-write" }).then((permission) => permission.state !== "denied")
        : false;
      if (clipboardAllowed && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(roomCode);
        success = true;
      }
    } catch {
      success = false;
    }

    // Fallback: hidden textarea + execCommand, works in more restrictive
    // embedded contexts than the async Clipboard API.
    if (!success) {
      try {
        const textarea = document.createElement("textarea");
        textarea.value = roomCode;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.focus();
        textarea.select();
        success = document.execCommand("copy");
        document.body.removeChild(textarea);
      } catch {
        success = false;
      }
    }

    setCopyState(success ? "copied" : "error");
    setTimeout(() => setCopyState("idle"), 1500);
  }

  return (
    <>
      <div className="toolbar">
        <button className="btn" onClick={onToggleEditMode}>
          {editMode ? "✓ Done Editing" : "✎ Edit Board"}
        </button>
        <button className="btn" onClick={onOpenSessions}>
          ⏱ Sessions
        </button>
        <button className="btn" onClick={onOpenRandomizer}>
          Randomize Order
        </button>
        <button className="btn" onClick={onResetRound}>
          ↺ Reset Round
        </button>
        {editMode && onRandomizeDailyDoubles && (
          <button
            className="btn"
            onClick={() => onRandomizeDailyDoubles()}
            title="Randomly reassign Daily Double clue(s) for both rounds"
          >
            Randomize Daily Doubles
          </button>
        )}
        <div className="room-code-container" title="Players enter this code at /play">
          <span className="room-code-label">Room code</span>
          <input
            readOnly
            value={roomCode || "Creating…"}
            onFocus={(event) => event.currentTarget.select()}
            onClick={(event) => event.currentTarget.select()}
            aria-label="Room code"
            className="room-code-input"
          />
          <button className="btn" onClick={copyRoomCode} disabled={!roomCode}>
            {copyState === "copied" ? "Copied!" : copyState === "error" ? "Couldn't copy" : "Copy"}
          </button>
        </div>

        <ControlAssign
          players={players}
          teams={teams}
          controlDiscordUserId={controlDiscordUserId}
          onHostSetControl={onHostSetControl}
        />

        {/* Optional — only shows once the host-side hook that assembles
            finalScores (teams + ranking + playerStats) actually wires up
            onEndGame. Left out entirely rather than rendered-disabled, so
            a board mid-refactor doesn't show a dead button. */}
        {onEndGame && (
          <button
            className="btn"
            onClick={onEndGame}
            title="Save this playthrough's final scores and stats, ending the game"
          >
            🏁 End Game
          </button>
        )}
      </div>


      {editMode && (
        <div className="timer-settings-bar">
          <label>
            <input type="checkbox" checked={timerEnabled} onChange={onToggleTimerEnabled} />
            Answer timer
          </label>
          <label>
            Default:
            <input
              type="number"
              min="1"
              disabled={!timerEnabled}
              defaultValue={timerDuration}
              key={"timer-default-" + sessionId}
              onBlur={(e) => onSetTimerDuration(e.target.value)}
              onWheel={(e) => e.target.blur()}
            />
            sec
          </label>
          {onToggleDdBuzzerEnabled && (
            <label title="Off (default): only the wagering team may answer a Daily Double, no buzzer race. On: the buzzer opens for everyone same as a normal clue.">
              <input type="checkbox" checked={!!ddBuzzerEnabled} onChange={onToggleDdBuzzerEnabled} />
              Buzzer on Daily Doubles
            </label>
          )}
          {onToggleDdMinWagerZero && (
            <label title="Off (default): minimum Daily Double wager equals the clue's own value (range: value–2x). On: minimum wager is $0 (range: 0–2x).">
              <input type="checkbox" checked={!!ddMinWagerZero} onChange={onToggleDdMinWagerZero} />
              Allow $0 Wager
            </label>
          )}
          {onToggleDdWagerBasisPlayerScore && (
            <label title="Off (default): max Daily Double wager is 2x the clue's own value. On: max wager is the wagering team's own current score. Combines with 'Allow $0 Wager' above for 4 total wager-range options.">
              <input
                type="checkbox"
                checked={!!ddWagerBasisPlayerScore}
                onChange={onToggleDdWagerBasisPlayerScore}
              />
              Max wager = Team Score
            </label>
          )}
        </div>
      )}
    </>
  );
}