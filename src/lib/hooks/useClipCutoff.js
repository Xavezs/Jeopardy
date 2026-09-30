import { useRef, useEffect } from 'react';

// Shared by CustomAudioPlayer and CustomVideoPlayer for the per-clue "stop
// after N seconds" cutoff (see useClueEditor.js's mediaClipSeconds /
// answerMediaClipSeconds) — undefined/null/0 clipSeconds means play in
// full. Built for "1-second music round"-style clues.
//
// `mediaRef` is the <audio>/<video> element ref; `isPlaying` is the
// player's current isPlaying (external-or-internal) value.
export function useClipCutoff(clipSeconds, isPlaying, mediaRef) {
  const clipEndTimeRef = useRef(null);

  // Keep the cutoff point in sync if clipSeconds itself changes mid-play.
  useEffect(() => {
    clipEndTimeRef.current = clipSeconds && isPlaying && mediaRef.current
      ? mediaRef.current.currentTime + Number(clipSeconds)
      : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clipSeconds]);

  // Call when playback starts or a seek happens, to (re)arm the cutoff
  // measured from `time`. Passing a falsy clipSeconds disarms it.
  function arm(time) {
    clipEndTimeRef.current = clipSeconds ? Number(time) + Number(clipSeconds) : null;
  }

  function disarm() {
    clipEndTimeRef.current = null;
  }

  // Call from onTimeUpdate with the element's current playback position.
  // True once `time` has reached the armed cutoff — the caller is still
  // responsible for actually pausing/seeking, since the native `ended`
  // event never fires for a manual cutoff.
  function hasReachedCutoff(time) {
    return clipEndTimeRef.current != null && time >= clipEndTimeRef.current;
  }

  // The position the clip started playing from, derived from the stored
  // cutoff point minus the clip length. Used to rewind playback back to
  // where the clip began (rather than leaving it sitting at the cutoff)
  // once hasReachedCutoff fires.
  function clipStartTime() {
    return clipEndTimeRef.current != null && clipSeconds
      ? Math.max(0, clipEndTimeRef.current - Number(clipSeconds))
      : 0;
  }

  return { arm, disarm, hasReachedCutoff, clipStartTime };
}
