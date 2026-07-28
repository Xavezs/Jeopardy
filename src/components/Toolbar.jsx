import React from "react";

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