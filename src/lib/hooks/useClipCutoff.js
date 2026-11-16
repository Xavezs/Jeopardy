import { useRef, useEffect } from 'react';

export function useClipCutoff(clipSeconds, isPlaying, mediaRef) {
  const clipEndTimeRef = useRef(null);

  useEffect(() => {
    clipEndTimeRef.current = clipSeconds && isPlaying && mediaRef.current
      ? mediaRef.current.currentTime + Number(clipSeconds)
      : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipSeconds]);

  function arm(time) {
    clipEndTimeRef.current = clipSeconds ? Number(time) + Number(clipSeconds) : null;
  }

  function disarm() {
    clipEndTimeRef.current = null;
  }

  function hasReachedCutoff(time) {
    return clipEndTimeRef.current != null && time >= clipEndTimeRef.current;
  }

  function clipStartTime() {
    return clipEndTimeRef.current != null && clipSeconds
      ? Math.max(0, clipEndTimeRef.current - Number(clipSeconds))
      : 0;
  }

  return { arm, disarm, hasReachedCutoff, clipStartTime };
}
