/* =========================================================================
   SHARED SFX UTILITIES

   Every sound effect in the app (hover tick, click, reveal chime, etc.)
   follows the same shape: try to play a real audio file, fall back to a
   synthesized tone if the file is missing/unloadable, and debounce rapid
   repeat fires. This used to be copy-pasted per-sound (~50-70 lines each).
   createSfx() below is that shared shape, factored out once.

   getSharedAudioCtx() is likewise shared: a single lazily-created
   AudioContext reused across every synthesized fallback tone, rather than
   `new AudioContext()` per call (an actual lag/hardware-conflict landmine
   we already hit once with the original timer-alert sound).
   ========================================================================= */

let sharedCtx = null;
export function getSharedAudioCtx() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!sharedCtx || sharedCtx.state === "closed") {
    sharedCtx = new Ctx();
  }
  return sharedCtx;
}

/**
 * Runs `schedule` once `ctx` is actually running — not just once resume()
 * has been *called*. AudioContext.resume() is async; scheduling nodes
 * against ctx.currentTime in the same tick as an unresolved resume() call
 * is a race — most of the time the browser catches up fast enough that it
 * "just works", but whenever it doesn't (context was suspended — common
 * right after a modal opens, tab regains focus, etc., especially inside a
 * Discord Activity iframe), the scheduled sound silently never plays.
 * Every synthesized fallback tone below goes through this instead of
 * calling ctx.resume() and scheduling in the same breath.
 */
export function withRunningCtx(ctx, schedule) {
  if (ctx.state === "suspended") {
    ctx.resume().then(schedule).catch(() => {});
  } else {
    schedule();
  }
}

/**
 * Build a player function for one sound effect.
 *
 * @param {string} url - Asset URL, e.g. `new URL("./assets/click.mp3", import.meta.url).href`
 * @param {() => void} fallbackTone - Synthesized tone to play if the file is missing/unloadable
 * @param {number} [volume=0.3] - 0–1 playback volume for the file-based sound
 * @param {number} [minGapMs=40] - Minimum ms between plays; guards against double-fires
 * @returns {() => void} play() — call this to trigger the sound
 */
export function createSfx({ url, fallbackTone, volume = 0.1, minGapMs = 40 }) {
  const audioTemplate = typeof Audio !== "undefined" ? new Audio(url) : null;
  let fileAvailable = !!audioTemplate;
  if (audioTemplate) {
    audioTemplate.preload = "auto";
    audioTemplate.volume = volume; 
    audioTemplate.addEventListener("error", () => {
      fileAvailable = false; // file missing/unloadable — every future play uses the fallback tone instead
    });
  }

  let lastPlayedAt = 0;

  return function play() {
    const now = performance.now();
    if (now - lastPlayedAt < minGapMs) return;
    lastPlayedAt = now;

    if (audioTemplate && fileAvailable) {
      try {
        const node = audioTemplate.cloneNode(true);
        node.volume = audioTemplate.volume;
        const playPromise = node.play();
        if (playPromise && typeof playPromise.catch === "function") {
          playPromise.catch(() => {
            // A cloned node failing to play (often just cold cache / slow
            // network right after the activity first opens, not enough
            // data buffered yet) is a ONE-OFF hiccup, not proof the file is
            // missing. Don't touch `fileAvailable` here — that's reserved
            // for the audioTemplate's own 'error' event below, which is
            // the only reliable signal the file itself is broken. Just
            // fall back for this single play so the next call still gets
            // a fair shot at the real audio.
            fallbackTone();
          });
        }
        return;
      } catch (e) {
        fileAvailable = false;
        // fall through to the synthesized tone below
      }
    }
    fallbackTone();
  };
}