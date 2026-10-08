import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

const ROLL_MS = 1400;
const HOLD_MS = 6500;

export default function PowerDrawOverlay({ result, onDone }) {
  const [revealed, setRevealed] = useState(false);

  useEffect(() => {
    if (!result) return undefined;
    setRevealed(false);
    const reveal = setTimeout(() => setRevealed(true), ROLL_MS);
    const done = setTimeout(() => onDone?.(), ROLL_MS + HOLD_MS);
    return () => { clearTimeout(reveal); clearTimeout(done); };
  }, [result, onDone]);

  if (!result) return null;
  const rows = result.results || [];
  const winners = rows.filter((r) => r.won);

  return createPortal(
    <div className="pd-overlay" onClick={() => onDone?.()} role="status" aria-live="polite">
      <div className="pd-card" onClick={(e) => e.stopPropagation()}>
        <div className="pd-title">Power Draw</div>
        {rows.length === 0 ? (
          <p className="pd-empty">No one has an unlocked power equipped.</p>
        ) : !revealed ? (
          <p className="pd-rolling">Rolling for {rows.length} {rows.length === 1 ? "power" : "powers"}…</p>
        ) : (
          <>
            <p className="pd-summary">
              {winners.length === 0
                ? "No powers granted this time."
                : `${winners.length} ${winners.length === 1 ? "power" : "powers"} granted!`}
            </p>
            <ul className="pd-list">
              {rows.map((r) => (
                <li key={r.discordUserId + r.skillId} className={"pd-row" + (r.won ? " pd-won" : "")}>
                  <span className="pd-name">{r.username}</span>
                  <span className="pd-skill">{r.skillName}</span>
                  <span className="pd-verdict">{r.won ? "Granted" : "No luck"}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}
