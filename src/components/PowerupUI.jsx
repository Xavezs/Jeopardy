import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { POWERUP_INFO, powerupBlockedReason } from "../lib/powerups";
import "../styles/skill.css";

/* =========================================================================
   PowerupTray — the player's own granted power-ups as tappable buttons.
   Rendered both on the board screen and INSIDE the clue view (the clue overlay
   covers everything else), so a power-up can be fired mid-clue.
   Domain Expansion is NOT handled here — it has its own button and is blocked
   while a clue is open.
   ========================================================================= */
export function PowerupTray({
  items,            // labels this player holds, e.g. ["2x Points", "Freeze"]
  armed,            // public armed list from the server
  frozenTeams,      // { [teamId]: { live } }
  teams,            // all teams (for the Freeze picker)
  myTeamId,
  inClue,
  buzzerLive,
  isFinal,
  hasControl,
  hint,             // { label, hint } | null — private to this player
  onUse,            // (label, targetTeamId?) => Promise<{ ok } | { error }>
  inline = false,   // true inside the clue sidebar, false = floating on the board
}) {
  const [picking, setPicking] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Drop stale error/picker when the holdings change or the clue closes.
  useEffect(() => { setPicking(null); }, [items?.length, inClue]);
  useEffect(() => {
    if (!error) return undefined;
    const t = setTimeout(() => setError(""), 3500);
    return () => clearTimeout(t);
  }, [error]);

  const mine = (items || []).filter((l) => POWERUP_INFO[l]);
  const armedMine = (armed || []).filter((a) => a.teamId === myTeamId);
  if (mine.length === 0 && armedMine.length === 0 && !hint) return null;

  async function fire(label, targetTeamId = null) {
    setBusy(true);
    setError("");
    const res = await onUse(label, targetTeamId);
    setBusy(false);
    setPicking(null);
    if (res?.error) setError(res.error);
  }

  function handleClick(label) {
    if (POWERUP_INFO[label].needsTarget) setPicking((p) => (p === label ? null : label));
    else fire(label);
  }

  const targets = (teams || []).filter((t) => t.id !== myTeamId && !frozenTeams?.[t.id]);

  return (
    <div className={"pv-powerup-tray" + (inline ? " pv-powerup-tray--inline" : "")} aria-label="Your power-ups">
      {hint?.hint && (
        <div className="pv-powerup-hint" role="status">
          <span className="pv-powerup-hint-label">Hint</span>
          <span className="pv-powerup-hint-text">{hint.hint}</span>
        </div>
      )}

      {mine.length > 0 && (
        <div className="pv-powerup-row">
          {mine.map((label, i) => {
            const reason = powerupBlockedReason(label, { inClue, buzzerLive, isFinal, hasControl, armed, myTeamId });
            return (
              <button
                type="button"
                key={label + i}
                className={"pv-powerup-chip pv-powerup-btn" + (picking === label ? " is-picking" : "")}
                disabled={busy || !!reason}
                onClick={() => handleClick(label)}
                title={reason ? `${POWERUP_INFO[label].desc} — ${reason}` : POWERUP_INFO[label].desc}>
                {label}
              </button>
            );
          })}
        </div>
      )}

      {picking && (
        <div className="pv-powerup-picker" role="group" aria-label="Choose a team to freeze">
          <span className="pv-powerup-picker-title">Freeze which team?</span>
          {targets.length === 0 && <span className="pv-powerup-picker-empty">No team available</span>}
          {targets.map((t) => (
            <button type="button" key={t.id} className="pv-powerup-target" disabled={busy} onClick={() => fire(picking, t.id)}>
              {t.name}
            </button>
          ))}
          <button type="button" className="pv-powerup-target pv-powerup-cancel" onClick={() => setPicking(null)}>Cancel</button>
        </div>
      )}

      {armedMine.length > 0 && (
        <div className="pv-powerup-armed">
          {armedMine.map((a) => <span key={a.id} className="pv-powerup-armed-tag">{a.label} ready</span>)}
        </div>
      )}

      {error && <div className="pv-powerup-error" role="alert">{error}</div>}
    </div>
  );
}

/* =========================================================================
   PowerupNotice — short banner on every client when someone fires a power-up.
   ========================================================================= */
const NOTICE_MS = 4200;

function noticeText(n) {
  const who = `${n.username}${n.teamName ? ` (${n.teamName})` : ""}`;
  switch (n.kind) {
    case "double": return `${who} activated 2x Points — their next correct answer counts double!`;
    case "shield": return `${who} raised a Shield — their next wrong answer costs nothing.`;
    case "steal":  return `${who} stole board control!`;
    case "freeze": return `${who} froze ${n.targetTeamName || "a team"} — no buzzing!`;
    case "hint":   return `${who} used a Hint.`;
    case "rebuzz": return `${who} used Re-Buzz and jumped the queue!`;
    default:       return `${who} used ${n.label}.`;
  }
}

export function PowerupNotice({ notice, onDone }) {
  useEffect(() => {
    if (!notice) return undefined;
    const t = setTimeout(() => onDone?.(), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice, onDone]);

  if (!notice) return null;
  return createPortal(
    <div className="pu-notice" role="status" aria-live="polite" onClick={() => onDone?.()}>
      <span className="pu-notice-icon" aria-hidden="true">{POWERUP_INFO[notice.label]?.icon || "⚡"}</span>
      <span className="pu-notice-text">{noticeText(notice)}</span>
    </div>,
    document.body
  );
}
