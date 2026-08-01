import React from "react";
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
              {(p.discordUsername || p.discordUserId) + (teamName ? ` — ${teamName}` : "") + (p.connected === false ? " (disconnected)" : "")}
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
}) {
  async function copyRoomCode() {
    if (!roomCode) return;
    await navigator.clipboard?.writeText(roomCode);
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
          <button className="btn" onClick={copyRoomCode} disabled={!roomCode}>Copy</button>
        </div>

        <ControlAssign
          players={players}
          teams={teams}
          controlDiscordUserId={controlDiscordUserId}
          onHostSetControl={onHostSetControl}
        />
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
        </div>
      )}
    </>
  );
}