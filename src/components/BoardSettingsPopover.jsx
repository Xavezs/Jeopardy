import React, { useState, useRef, useEffect } from "react";

/* =========================================================================
   BoardSettingsPopover
   Gear button → popover with on/off toggle switches for board settings.
   ========================================================================= */

// Reusable toggle-switch row: label on the left, switch on the right.
function SettingRow({ label, checked, onChange, title }) {
  return (
    <div className="bsp-row" title={title}>
      <span className="bsp-row-label">{label}</span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={"bsp-switch" + (checked ? " is-on" : "")}
        onClick={onChange}
      >
        <span className="bsp-switch-thumb" />
      </button>
    </div>
  );
}

export default function BoardSettingsPopover({
  timerEnabled,
  timerDuration,
  sessionId,
  onToggleTimerEnabled,
  onSetTimerDuration,
  ddBuzzerEnabled,
  onToggleDdBuzzerEnabled,
  ddMinWagerZero,
  onToggleDdMinWagerZero,
  ddWagerBasisPlayerScore,
  onToggleDdWagerBasisPlayerScore,
  onRandomizeDailyDoubles,
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e) {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setOpen(false);
      }
    }
    function onKeyDown(e) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="board-settings-gear-wrap" ref={containerRef}>
      <button
        type="button"
        className={"board-settings-gear-btn" + (open ? " is-open" : "")}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="true"
        aria-expanded={open}
        title="Board settings"
      >
        <svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true" width="16" height="16">
          <path
            fillRule="evenodd"
            d="M11.49 3.17c-.38-1.56-2.6-1.56-2.98 0a1.532 1.532 0 01-2.286.948c-1.372-.836-2.942.734-2.106 2.106.54.886.061 2.042-.947 2.287-1.561.379-1.561 2.6 0 2.978a1.532 1.532 0 01.947 2.287c-.836 1.372.734 2.942 2.106 2.106a1.532 1.532 0 012.287.947c.379 1.561 2.6 1.561 2.978 0a1.533 1.533 0 012.287-.947c1.372.836 2.942-.734 2.106-2.106a1.533 1.533 0 01.947-2.287c1.561-.379 1.561-2.6 0-2.978a1.532 1.532 0 01-.947-2.287c.836-1.372-.734-2.942-2.106-2.106a1.532 1.532 0 01-2.287-.947zM10 13a3 3 0 100-6 3 3 0 000 6z"
            clipRule="evenodd"
          />
        </svg>
      </button>

      {open && (
        <div className="board-settings-popover" role="dialog" aria-label="Board settings">

          {/* ── Answer Timer ───────────────────────────────── */}
          <div className="bsp-group-label">Answer Timer</div>

          <SettingRow
            label="Timer"
            checked={timerEnabled}
            onChange={onToggleTimerEnabled}
          />

          {timerEnabled && (
            <div className="bsp-duration-row">
              <span className="bsp-row-label">Duration</span>
              <input
                type="number"
                min="1"
                className="settings-timer-input"
                defaultValue={timerDuration}
                key={"timer-default-" + sessionId}
                onBlur={(e) => onSetTimerDuration(e.target.value)}
                onWheel={(e) => e.target.blur()}
              />
              <span className="settings-timer-unit">sec</span>
            </div>
          )}

          <div className="bsp-divider" />

          {/* ── Daily Double Rules ─────────────────────────── */}
          <div className="bsp-group-label">Daily Double Rules</div>

          {onToggleDdBuzzerEnabled && (
            <SettingRow
              label="Buzzer on DD"
              checked={!!ddBuzzerEnabled}
              onChange={onToggleDdBuzzerEnabled}
              title="Off: only wagering team may answer. On: buzzer opens for everyone."
            />
          )}
          {onToggleDdMinWagerZero && (
            <SettingRow
              label="Allow $0 Wager"
              checked={!!ddMinWagerZero}
              onChange={onToggleDdMinWagerZero}
              title="Off: min wager = clue value. On: min wager = $0."
            />
          )}
          {onToggleDdWagerBasisPlayerScore && (
            <SettingRow
              label="Max Wager = Score"
              checked={!!ddWagerBasisPlayerScore}
              onChange={onToggleDdWagerBasisPlayerScore}
              title="Off: max wager = 2x clue value. On: max wager = team score."
            />
          )}

          {onRandomizeDailyDoubles && (
            <>
              <div className="bsp-divider" />
              <button
                type="button"
                className="toolbar-overflow-item"
                onClick={() => { onRandomizeDailyDoubles(); setOpen(false); }}
                title="Randomly reassign Daily Double clue(s) across both rounds"
              >
                Randomize Daily Doubles
              </button>
            </>
          )}
        </div>
      )}
    </div>
  );
}
