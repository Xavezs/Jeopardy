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
 * Resolves once `audioEl` has enough data buffered to play through
 * (`canplaythrough`), or after `timeoutMs`, whichever comes first — never
 * rejects. Used to give a cold-cache play() rejection one genuine second
 * chance instead of immediately assuming the file is broken.
 */
function waitForBuffered(audioEl, timeoutMs) {
  return new Promise((resolve) => {
    if (audioEl.readyState >= 3 /* HAVE_FUTURE_DATA */) {
      resolve();
      return;
    }
    let settled = false;
    const cleanup = () => {
      clearTimeout(timer);
      audioEl.removeEventListener("canplaythrough", onReady);
    };
    const onReady = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }, timeoutMs);
    audioEl.addEventListener("canplaythrough", onReady, { once: true });
  });
}

/**
 * Unlocks audio playback for this device/origin. Must be called
 * synchronously inside a genuine user-gesture handler (click/submit/tap) —
 * not inside a promise .then(), a setTimeout, or a websocket callback, or
 * browsers won't count it as a gesture and it's a no-op.
 *
 * This matters specifically for players (as opposed to the host): the
 * host's SFX calls all happen inside their own click handlers, so they get
 * a free unlock every time. A player's SFX (correct/incorrect, category
 * reveal, Daily Double, etc.) are fired from *incoming* websocket events —
 * the host's actions, not the player's — so without ever unlocking audio
 * on a real tap of their own, the browser (especially iOS Safari and
 * Discord's in-app webview) keeps AudioContext suspended and rejects
 * every audio.play() indefinitely, silently, forever. Call this once from
 * the player's first genuine interaction (e.g. submitting "Join Game").
 */
export function unlockAudioPlayback() {
  // WebAudio: resume the shared context and play a silent buffer through
  // it. iOS Safari in particular only actually unlocks once a sound has
  // been started from inside the gesture — resume() alone isn't always
  // enough.
  const ctx = getSharedAudioCtx();
  if (ctx) {
    if (ctx.state === "suspended") ctx.resume().catch(() => {});
    try {
      const buffer = ctx.createBuffer(1, 1, 22050);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);
    } catch (e) {
      /* best effort */
    }
  }

  // HTMLMediaElement: a muted play() inside the gesture unlocks <audio>
  // playback separately from WebAudio on some browsers/webviews.
  try {
    const el = new Audio();
    el.muted = true;
    const p = el.play();
    if (p && typeof p.catch === "function") {
      p.then(() => el.pause()).catch(() => {});
    }
  } catch (e) {
    /* best effort */
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

  function attemptPlay(isRetry) {
    try {
      const node = audioTemplate.cloneNode(true);
      node.volume = audioTemplate.volume;
      const playPromise = node.play();
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch(() => {
          if (isRetry) {
            // Already gave it a second chance after buffering — this is a
            // real, one-off playback failure (not just cold cache), so
            // fall back for this call only. `fileAvailable` stays true;
            // the next play() still gets a fair shot at the real audio.
            fallbackTone();
            return;
          }
          // First failure: most likely the file just hasn't buffered
          // enough yet (cold cache / slow network right after the
          // activity first opens). Wait briefly for it to catch up, then
          // try once more before giving up on it for this play.
          waitForBuffered(audioTemplate, 400).then(() => attemptPlay(true));
        });
      }
    } catch (e) {
      if (isRetry) {
        fileAvailable = false; // real, reproducible failure — stop trying the file
        fallbackTone();
      } else {
        waitForBuffered(audioTemplate, 400).then(() => attemptPlay(true));
      }
    }
  }

  return function play() {
    const now = performance.now();
    if (now - lastPlayedAt < minGapMs) return;
    lastPlayedAt = now;

    if (audioTemplate && fileAvailable) {
      attemptPlay(false);
      return;
    }
    fallbackTone();
  };
}