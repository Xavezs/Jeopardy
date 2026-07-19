import { useState, useRef } from "react";

/**
 * Manages the brief "pulse-up" / "pulse-down" CSS animation state that
 * flashes on a team's score display after a +/- adjustment. Fully
 * self-contained — doesn't touch session data, just transient visual state
 * that clears itself out after the animation plays.
 *
 * Usage:
 *   const { scorePulse, firePulse } = useScorePulse();
 *   firePulse(team.id, delta >= 0 ? "pulse-up" : "pulse-down");
 *   <div className={"team-score-display" + (scorePulse[team.id] ? " " + scorePulse[team.id] : "")}>
 */
export function useScorePulse() {
  const [scorePulse, setScorePulse] = useState({}); // { [teamId]: "pulse-up" | "pulse-down" }
  const scorePulseTimeouts = useRef({});

  function firePulse(teamId, direction) {
    setScorePulse((p) => ({ ...p, [teamId]: direction }));
    clearTimeout(scorePulseTimeouts.current[teamId]);
    scorePulseTimeouts.current[teamId] = setTimeout(() => {
      setScorePulse((p) => {
        const next = { ...p };
        delete next[teamId];
        return next;
      });
    }, 500);
  }

  return { scorePulse, firePulse };
}
