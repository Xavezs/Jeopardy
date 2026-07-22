import React from "react";

export default function Toolbar({
  editMode,
  onToggleEditMode,
  onOpenSessions,
  onOpenRandomizer,
  onResetRound,
  discordDisplayMode,
  onToggleDiscordMode,
  timerEnabled,
  timerDuration,
  sessionId,
  onToggleTimerEnabled,
  onSetTimerDuration,
  buzzerEnabled,
  onToggleBuzzer,
}) {
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
          ↺ Reset Round (keep content)
        </button>
        <button
          className="btn"
          title="Toggle team cards between normal names and Discord profiles"
          onClick={onToggleDiscordMode}
        >
          {discordDisplayMode === "discord" ? "Discord Mode" : "Normal Mode"}
        </button>
        <button
          className={`btn ${buzzerEnabled ? "btn-active" : ""}`}
          title="Toggle Discord buzzer functionality on or off"
          onClick={onToggleBuzzer}
        >
          {buzzerEnabled ? "Buzzer: ON" : "Buzzer: OFF"}
        </button>
      </div>
      <div className="edit-banner">
        {editMode ? "EDIT MODE — click any cell to edit its clue, edit headers, or add/delete rows and columns" : ""}
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