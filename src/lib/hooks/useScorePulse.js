import { useState, useRef } from "react";

export function useScorePulse() {
  const [scorePulse, setScorePulse] = useState({});
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
