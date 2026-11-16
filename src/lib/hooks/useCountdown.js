import { useEffect, useState } from "react";

export function useCountdown(deadline) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (deadline == null) return undefined;
    setNow(Date.now());
    const id = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (t >= deadline) clearInterval(id);
    }, 250);
    return () => clearInterval(id);
  }, [deadline]);

  if (deadline == null) return null;
  return Math.max(0, deadline - now);
}
