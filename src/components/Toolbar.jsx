import React, { useState, useRef, useEffect } from "react";
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
  roomCode,
  players,
  teams,
  controlDiscordUserId,
  onHostSetControl,
  onEndGame,
  onRotateRoomCode,
  appConfirm,
  appAlert,
}) {
  const [copyState, setCopyState] = useState("idle"); // "idle" | "copied" | "error"
  const [rotatingRoomCode, setRotatingRoomCode] = useState(false);
  // The "⋯" menu holding the setup/rare-use actions (Edit Board, Sessions,
  // Reset Round, New Code) — kept out of the main row so the buttons a
  // host actually taps mid-game (Randomize Order, End Game, the room
  // code) aren't competing for attention with ones only used once per
  // session. Closes on an outside click or Escape, same as the app's
  // modals, so it doesn't linger open once the host has picked something
  // or clicked elsewhere on the board.
  const [overflowOpen, setOverflowOpen] = useState(false);
  const overflowRef = useRef(null);

  useEffect(() => {
    if (!overflowOpen) return;
    const handlePointerDown = (e) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target)) {
        setOverflowOpen(false);
      }
    };
    const handleKeyDown = (e) => {
      if (e.key === "Escape") setOverflowOpen(false);
    };
    document.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [overflowOpen]);

  async function rotateRoomCode() {
    if (!onRotateRoomCode || rotatingRoomCode) return;
    if (!(await appConfirm("Generate a new room code? Everyone must rejoin with the new code."))) return;
    setRotatingRoomCode(true);
    try {
      await onRotateRoomCode();
    } catch (error) {
      await appAlert(error?.message || "Could not generate a new room code.");
    } finally {
      setRotatingRoomCode(false);
    }
  }

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
        <div className="toolbar-overflow" ref={overflowRef}>
          <button
            type="button"
            className="btn toolbar-overflow-trigger"
            onClick={() => setOverflowOpen((v) => !v)}
            aria-haspopup="true"
            aria-expanded={overflowOpen}
            title="Board tools"
          >
            ☰
          </button>
          {overflowOpen && (
            <div className="toolbar-overflow-menu" role="menu">
              <button
                type="button"
                className="toolbar-overflow-item"
                role="menuitem"
                onClick={() => { onOpenRandomizer(); setOverflowOpen(false); }}
              >
                Randomize Order
              </button>
              <button
                type="button"
                className="toolbar-overflow-item"
                role="menuitem"
                onClick={() => { onOpenSessions(); setOverflowOpen(false); }}
              >
                Sessions
              </button>
              <button
                type="button"
                className="toolbar-overflow-item"
                role="menuitem"
                onClick={() => { onResetRound(); setOverflowOpen(false); }}
              >
                Reset Round
              </button>
              <button
                type="button"
                className="toolbar-overflow-item"
                role="menuitem"
                onClick={() => { rotateRoomCode(); setOverflowOpen(false); }}
                disabled={!roomCode || rotatingRoomCode}
              >
                {rotatingRoomCode ? "Changing code…" : "New Room Code"}
              </button>
            </div>
          )}
        </div>

        <button className="btn btn-edit-board" onClick={onToggleEditMode}>
          {editMode ? "Done Editing" : "Edit Board"}
        </button>

        <div className="room-code-badge" title="Players enter this code at /play">
          <span className="room-code-badge-code">{roomCode || "…"}</span>
          <button
            type="button"
            className="room-code-badge-copy"
            onClick={copyRoomCode}
            disabled={!roomCode}
            aria-label="Copy room code"
            title="Copy room code"
          >
            {copyState === "copied" ? "✓" : copyState === "error" ? "!" : "⧉"}
          </button>
        </div>

        <ControlAssign
          players={players}
          teams={teams}
          controlDiscordUserId={controlDiscordUserId}
          onHostSetControl={onHostSetControl}
        />

        {onEndGame && (
          <button
            className="btn btn-end-game"
            onClick={onEndGame}
            title="Save this playthrough's final scores and stats, ending the game"
          >
            End Game
          </button>
        )}
      </div>
    </>
  );
}