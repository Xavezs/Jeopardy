import { createSfx, getSharedAudioCtx, withRunningCtx } from "./sfx";
import { getMediaUrl } from "./storage";
import { storeGet, storeSet } from "./storage/kvStore";

/* =========================================================================
   BOARD SOUND EFFECTS
   All of the board's sound effects live here: each plays its real audio
   file (src/assets/*.mp3) if present, otherwise falls back to a short
   synthesized tone so the app still has sound before you've dropped any
   files in. File-load/fallback/debounce plumbing lives in ./sfx.js's
   createSfx() — only the synthesized tone (unique per sound) stays here.

   Note: these use `new URL(..., import.meta.url)` rather than a static
   `import x from "./assets/x.mp3"`. A static import needs Vite to resolve
   the file at BUILD time — if it's missing, the whole build fails.
   `new URL()` just builds a URL string, so it's safe to reference a file
   that may not exist yet; we detect that at runtime instead and swap to
   the fallback tone.
   ========================================================================= */

/* ---------------- HOVER TICK ---------------- */
const hoverTickUrl = new URL("../assets/hover-tick.mp3", import.meta.url).href;

function playSynthHoverTick() {
  try {
    const ctx = getSharedAudioCtx();
    if (!ctx) return;
    withRunningCtx(ctx, () => {
    const t0 = ctx.currentTime;

    // Low "thock" body — a quick pitch-drop thump, like a muted kick, gives
    // the deep low-end of a switch bottoming out.
    const osc = ctx.createOscillator();
    const oscGain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(170, t0);
    osc.frequency.exponentialRampToValueAtTime(65, t0 + 0.09);
    oscGain.gain.setValueAtTime(0.0001, t0);
    oscGain.gain.exponentialRampToValueAtTime(0.32, t0 + 0.006);
    oscGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.13);
    osc.connect(oscGain);
    oscGain.connect(ctx.destination);
    osc.onended = () => {
      osc.disconnect();
      oscGain.disconnect();
    };
    osc.start(t0);
    osc.stop(t0 + 0.14);

    // Short filtered noise burst — the plasticky "clack" transient on top
    // of the thump, the part that actually reads as a keypress.
    const bufferSize = Math.max(1, Math.floor(ctx.sampleRate * 0.02)); // ~20ms of noise
    const noiseBuffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
    const data = noiseBuffer.getChannelData(0);
    for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;

    const noise = ctx.createBufferSource();
    noise.buffer = noiseBuffer;
    const noiseFilter = ctx.createBiquadFilter();
    noiseFilter.type = "lowpass";
    noiseFilter.frequency.setValueAtTime(1200, t0);
    const noiseGain = ctx.createGain();
    noiseGain.gain.setValueAtTime(0.0001, t0);
    noiseGain.gain.exponentialRampToValueAtTime(0.16, t0 + 0.004);
    noiseGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.03);
    noise.connect(noiseFilter);
    noiseFilter.connect(noiseGain);
    noiseGain.connect(ctx.destination);
    noise.onended = () => {
      noise.disconnect();
      noiseFilter.disconnect();
      noiseGain.disconnect();
    };
    noise.start(t0);
    noise.stop(t0 + 0.03);
    });
  } catch (e) {
    /* best effort — silently ignore if audio is blocked */
  }
}

export const playHoverTick = createSfx({
  url: hoverTickUrl,
  fallbackTone: playSynthHoverTick,
  volume: 0.1,
  minGapMs: 55, // guards against a rapid mouse-sweep firing a pile of overlapping plays
});

/* ---------------- BGM DUCKING BUS ----------------
   A tiny pub/sub so a sound effect fired from anywhere (this module has
   no idea BackgroundMusicPlayer/PlayerBgmWidget even exist) can signal
   "duck the music for a moment" without needing props threaded all the
   way down to it. playStandingsCelebration below is called from
   FinalJeopardyBoard on the host and from wherever the player-side
   mirrors it — neither is anywhere near JeopardyBoard/PlayerView's BGM
   state, so a prop genuinely can't reach this call site directly.

   BackgroundMusicPlayer's existing `ducking` prop (driven by
   useClueEditor's duckMusic for clue audio/video) and PlayerBgmWidget's
   own ducking both OR this bus's signal in on top of whatever else is
   already ducking them — either source is enough to duck the music.
   ========================================================================= */
const duckingListeners = new Set();
let duckingTimeoutId = null;
let duckingActive = false;

function setDucking(active) {
  if (active === duckingActive) return;
  duckingActive = active;
  for (const listener of duckingListeners) listener(active);
}

// BackgroundMusicPlayer/PlayerBgmWidget call this once (in a useEffect)
// to be notified whenever this bus's ducking state changes. Returns an
// unsubscribe function.
export function subscribeSfxDucking(listener) {
  duckingListeners.add(listener);
  return () => duckingListeners.delete(listener);
}

// Ducks the BGM for `ms`, then un-ducks — unless another call comes in
// first, which just extends the window (clearTimeout below) rather than
// stacking two independent un-duck timers that could turn it back off
// too early relative to each other.
function duckBgmFor(ms) {
  clearTimeout(duckingTimeoutId);
  setDucking(true);
  duckingTimeoutId = setTimeout(() => setDucking(false), ms);
}

// The built-in tone (see playSynthFinalStandingsTone above) is a fixed,
// known-length chime (~1.5s) or, if final-standings.mp3 exists, an
// unknown-length file played through createSfx's own internal <audio>
// (see ./sfx.js) that this module doesn't have a handle to — so unlike
// the custom-file path in playStandingsCelebration below, there's no
// `ended` event available to duck against precisely. A fixed window
// covers the synth tone with room to spare; if you drop in a longer
// final-standings.mp3, bump this to match.
const BUILTIN_STANDINGS_DUCK_MS = 3500;

/* ---------------- CLICK ---------------- */
const clickSfxUrl = new URL("../assets/click.mp3", import.meta.url).href;

function playSynthClickTone() {
  try {
    const ctx = getSharedAudioCtx(); // reuse the same shared AudioContext as the hover tick
    if (!ctx) return;
    withRunningCtx(ctx, () => {
    const t0 = ctx.currentTime;

    // A brighter, snappier tick than the hover sound — higher pitch, shorter
    // decay — so the two read as distinct even played back to back.
    const osc = ctx.createOscillator();
    const oscGain = ctx.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(1400, t0);
    osc.frequency.exponentialRampToValueAtTime(700, t0 + 0.045);
    oscGain.gain.setValueAtTime(0.0001, t0);
    oscGain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.004);
    oscGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.06);
    osc.connect(oscGain);
    oscGain.connect(ctx.destination);
    osc.onended = () => {
      osc.disconnect();
      oscGain.disconnect();
    };
    osc.start(t0);
    osc.stop(t0 + 0.07);
    });
  } catch (e) {
    /* best effort — silently ignore if audio is blocked */
  }
}

export const playClickSfx = createSfx({
  url: clickSfxUrl,
  fallbackTone: playSynthClickTone,
  volume: 0.1,
  minGapMs: 40, // guards against double-fires (e.g. a click that also triggers a synthetic one)
});

/* ---------------- CORRECT / INCORRECT ---------------- */
const correctSfxUrl = new URL("../assets/correct.mp3", import.meta.url).href;
const incorrectSfxUrl = new URL("../assets/incorrect.mp3", import.meta.url).href;

function playSynthCorrectTone() {
  try {
    const ctx = getSharedAudioCtx();
    if (!ctx) return;
    withRunningCtx(ctx, () => {
    const t0 = ctx.currentTime;
    // Quick ascending two-note "ding-ding"
    [0, 0.1].forEach((delay, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = i === 0 ? 880 : 1320;
      gain.gain.setValueAtTime(0.0001, t0 + delay);
      gain.gain.exponentialRampToValueAtTime(0.25, t0 + delay + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + delay + 0.18);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t0 + delay);
      osc.stop(t0 + delay + 0.2);
    });
    });
  } catch (e) {
    /* best effort — silently ignore if audio is blocked */
  }
}

function playSynthIncorrectTone() {
  try {
    const ctx = getSharedAudioCtx();
    if (!ctx) return;
    withRunningCtx(ctx, () => {
    const t0 = ctx.currentTime;
    // Descending "buzz"
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(300, t0);
    osc.frequency.exponentialRampToValueAtTime(120, t0 + 0.25);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.2, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.28);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + 0.3);
    });
  } catch (e) {
    /* best effort — silently ignore if audio is blocked */
  }
}

export const playCorrectSfx = createSfx({
  url: correctSfxUrl,
  fallbackTone: playSynthCorrectTone,
  volume: 0.15,
  minGapMs: 40,
});

export const playIncorrectSfx = createSfx({
  url: incorrectSfxUrl,
  fallbackTone: playSynthIncorrectTone,
  volume: 0.15,
  minGapMs: 40,
});

/* ---------------- CATEGORY REVEAL ---------------- */
const catRevealSfxUrl = new URL("../assets/reveal-card.mp3", import.meta.url).href;

function playSynthCatRevealTone() {
  try {
    const ctx = getSharedAudioCtx(); // reuse the same shared AudioContext
    if (!ctx) return;
    withRunningCtx(ctx, () => {
    const t0 = ctx.currentTime;

    // Ascending bright chime — C5 to C6
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.setValueAtTime(523.25, t0);
    osc.frequency.exponentialRampToValueAtTime(1046.5, t0 + 0.15);

    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.2, t0 + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
    osc.start(t0);
    osc.stop(t0 + 0.22);
    });
  } catch (e) {
    /* best effort — silently ignore if audio is blocked */
  }
}

export const playCatRevealSfx = createSfx({
  url: catRevealSfxUrl,
  fallbackTone: playSynthCatRevealTone,
  volume: 0.15,
  minGapMs: 40,
});

/* ---------------- BUZZ IN ---------------- */
const buzzSfxUrl = new URL("../assets/buzz.mp3", import.meta.url).href;

function playSynthBuzzTone() {
  try {
    const ctx = getSharedAudioCtx();
    if (!ctx) return;
    withRunningCtx(ctx, () => {
    const t0 = ctx.currentTime;

    // Sharp, urgent buzzer — a fast square-wave blast, distinct from the
    // softer correct/incorrect tones since this needs to cut through and
    // grab attention the instant someone wins the buzzer race.
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "square";
    osc.frequency.setValueAtTime(220, t0);
    osc.frequency.setValueAtTime(440, t0 + 0.08);
    gain.gain.setValueAtTime(0.0001, t0);
    gain.gain.exponentialRampToValueAtTime(0.28, t0 + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.onended = () => {
      osc.disconnect();
      gain.disconnect();
    };
    osc.start(t0);
    osc.stop(t0 + 0.2);
    });
  } catch (e) {
    /* best effort — silently ignore if audio is blocked */
  }
}

export const playBuzzSfx = createSfx({
  url: buzzSfxUrl,
  fallbackTone: playSynthBuzzTone,
  volume: 0.2,
  minGapMs: 40,
});

/* ---------------- DAILY DOUBLE ----------------
   A bigger, more dramatic sting than the plain reveal chime — a rising
   pitch sweep followed by a bright three-note "ta-da" chord — since this
   moment is meant to stand out from a normal clue pick. Originally lived
   in ClueModal.jsx only; moved here so both the host (ClueModal) and
   player (PlayerView) sides import the same definition instead of each
   maintaining their own copy. */
const dailyDoubleSfxUrl = new URL("../assets/daily-double.mp3", import.meta.url).href;

// Active oscillator/gain nodes from the most recent synth fallback tone
// (see playSynthDailyDoubleTone below) — tracked so stopDailyDoubleSfx()
// can silence them immediately instead of letting the scheduled ~1.2s
// envelope play itself out after the player has already left the clue.
let activeDailyDoubleSynthNodes = [];

function playSynthDailyDoubleTone() {
  try {
    const ctx = getSharedAudioCtx();
    if (!ctx) return;
    withRunningCtx(ctx, () => {
    const t0 = ctx.currentTime;
    const nodes = [];

    // Rising sweep — builds anticipation for ~0.5s
    const sweep = ctx.createOscillator();
    const sweepGain = ctx.createGain();
    sweep.type = "sawtooth";
    sweep.frequency.setValueAtTime(140, t0);
    sweep.frequency.exponentialRampToValueAtTime(880, t0 + 0.5);
    sweepGain.gain.setValueAtTime(0.0001, t0);
    sweepGain.gain.exponentialRampToValueAtTime(0.18, t0 + 0.15);
    sweepGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.5);
    sweep.connect(sweepGain);
    sweepGain.connect(ctx.destination);
    sweep.start(t0);
    sweep.stop(t0 + 0.52);
    nodes.push(sweep, sweepGain);

    // Bright landing chord once the sweep peaks
    [523.25, 659.25, 783.99].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = freq;
      const start = t0 + 0.48 + i * 0.03;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.22, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.6);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.62);
      nodes.push(osc, gain);
    });

    activeDailyDoubleSynthNodes = nodes;
    });
  } catch (e) {
    /* best effort — silently ignore if audio is blocked */
  }
}

// Immediately silences whatever nodes the synth tone above last
// scheduled. .stop(0) on an oscillator that's already stopped (or never
// started) just throws, so every call is wrapped — this is a
// best-effort "make it quiet right now", not something that needs to be
// precise about what's currently actually sounding.
function stopSynthDailyDoubleTone() {
  for (const node of activeDailyDoubleSynthNodes) {
    try {
      if (typeof node.stop === "function") node.stop(0);
    } catch (e) {
      /* already stopped/never started — fine */
    }
    try {
      node.disconnect();
    } catch (e) {
      /* fine */
    }
  }
  activeDailyDoubleSynthNodes = [];
}

// Not exported directly — see playDailyDoubleSfx below, which wraps this
// with the same BGM-ducking treatment Final Standings gets.
const playDailyDoubleSfxRaw = createSfx({
  url: dailyDoubleSfxUrl,
  fallbackTone: playSynthDailyDoubleTone,
  volume: 0.18,
  minGapMs: 200,
});

// The synth tone runs ~1.2s (0.52s sweep + landing chord tail out to
// ~1.16s); if daily-double.mp3 exists, createSfx plays that instead and
// this module has no handle on its real length (same limitation as the
// built-in Final Standings tone — see BUILTIN_STANDINGS_DUCK_MS above).
// 2s gives either case room to breathe; bump this if you drop in a
// longer daily-double.mp3.
const DAILY_DOUBLE_DUCK_MS = 2000;

export function playDailyDoubleSfx() {
  duckBgmFor(DAILY_DOUBLE_DUCK_MS);
  playDailyDoubleSfxRaw();
}

// Stops the Daily Double sting immediately, whichever path is actually
// sounding — the real daily-double.mp3 clone (via createSfx's own
// play.stop(), see sfx.js) or the synthesized fallback tone's
// oscillators — and un-ducks the BGM right away instead of waiting out
// DAILY_DOUBLE_DUCK_MS. Call this whenever the Daily Double wager screen
// goes away before the sting has finished on its own: clue closed, host
// moved on, player left the room, etc. Safe to call even if nothing's
// currently playing.
export function stopDailyDoubleSfx() {
  clearTimeout(duckingTimeoutId);
  setDucking(false);
  playDailyDoubleSfxRaw.stop();
  stopSynthDailyDoubleTone();
}

/* ---------------- FINAL STANDINGS ----------------
   Plays once, for host and every player alike, the moment Final Standings
   is revealed — the actual "game's over" celebration beat. Bigger and
   brighter than Daily Double's sting: a rising arpeggio into a sustained
   major chord, since this needs to feel conclusive rather than just
   "something exciting is starting". */
const finalStandingsSfxUrl = new URL("../assets/final-standings.mp3", import.meta.url).href;

/* ---------------- FINAL STANDINGS VOLUME ----------------
   Unlike BGM (which has always had its own slider), every board SFX —
   including this one — used to just hardcode a fixed gain with no way
   for the host to turn it down live. This is the first one made
   adjustable, surfaced as a slider inside BackgroundMusicPlayer (the one
   audio widget that's actually still on-screen and reachable in the
   moment standings get revealed, unlike FinalJeopardyBoard's edit panel
   where the celebration sound file itself is uploaded).

   Range is 0–1, where 1 ("full") means exactly what each path already
   played before this existed — not some new louder ceiling — and 0 is
   silent. That's deliberate: the built-in mp3, the custom-file path, and
   the synth fallback each had their own independently-tuned base volume
   (0.2 / 0.6 / a set of peak gains) before this existed; treating the
   slider as a 0–1 multiplier on each path's own base, rather than
   inventing one shared absolute number, is what keeps the *default*
   slider position sounding identical to before across all three paths.

   Persisted the same way BGM settings are (see bgmStore.js): its own
   small key, loaded once, independent of any session. Kept as plain
   module state + get/set functions here rather than a React hook, since
   this needs to be readable from playStandingsCelebration below —
   nowhere near any component tree — the same way the ducking bus above
   is.
   ========================================================================= */
const FINAL_STANDINGS_VOLUME_KEY = "jp_final_standings_volume";
// The built-in mp3's own base volume (matches the `volume` given to
// createSfx below) — the live value pushed via .setVolume() is this
// times the current slider position, so slider=1 reproduces this exact
// number, unchanged from before the slider existed.
const FINAL_STANDINGS_MP3_BASE_VOLUME = 0.2;
// Same idea, for playStandingsCelebration's custom-uploaded-file path
// further below — its own separately-tuned base, since it was always a
// louder foreground sound than the built-in mp3 (an arbitrary user file,
// not the same fixed clip).
const FINAL_STANDINGS_CUSTOM_BASE_VOLUME = 0.6;

let finalStandingsVolume = 1;

// Handle to whatever custom celebration <audio> is currently mid-playback
// (see playStandingsCelebration below), so the slider can adjust it live
// instead of only affecting the *next* play. Without this, dragging the
// slider while the celebration sound is actually playing did nothing —
// and since it only ever fires once automatically per Final Standings
// reveal, that was effectively the only moment the slider was ever
// audible at all. Cleared back to null once that clip ends/errors, or
// (guarded by the audio-identity check) if a newer one starts first.
let currentCelebrationAudio = null;
let currentCelebrationBaseVolume = 0;

function applyFinalStandingsVolume() {
  playFinalStandingsSfx.setVolume(FINAL_STANDINGS_MP3_BASE_VOLUME * finalStandingsVolume);
  if (currentCelebrationAudio) {
    currentCelebrationAudio.volume = currentCelebrationBaseVolume * finalStandingsVolume;
  }
}

// Called once by JeopardyBoard on mount to hydrate the slider's initial
// position from storage. Safe to never call at all — everything just
// keeps using the in-memory default (1 = unchanged from before).
export async function loadFinalStandingsVolume() {
  try {
    const raw = await storeGet(FINAL_STANDINGS_VOLUME_KEY);
    const parsed = raw != null ? parseFloat(raw) : NaN;
    if (Number.isFinite(parsed)) {
      finalStandingsVolume = Math.max(0, Math.min(1, parsed));
      applyFinalStandingsVolume();
    }
  } catch (e) {
    /* stay on the default if storage is unavailable */
  }
  return finalStandingsVolume;
}

// Called from the slider's onChange. Updates the live built-in-mp3 sound
// immediately, persists for next time, and — since finalStandingsVolume
// is read directly by both the synth fallback below and
// playStandingsCelebration's custom-file path — takes effect on every
// path, not just the built-in one.
export function setFinalStandingsVolume(v) {
  finalStandingsVolume = Math.max(0, Math.min(1, v));
  applyFinalStandingsVolume();
  storeSet(FINAL_STANDINGS_VOLUME_KEY, String(finalStandingsVolume)).catch(() => {});
}

export function getFinalStandingsVolume() {
  return finalStandingsVolume;
}

function playSynthFinalStandingsTone() {
  try {
    const ctx = getSharedAudioCtx();
    if (!ctx) return;
    // 0 just skips scheduling anything — exponentialRampToValueAtTime
    // below can't ramp to a literal 0 target (WebAudio throws), and
    // "silent" is simpler to express as "don't play" than as an
    // infinitesimally quiet ramp.
    if (finalStandingsVolume <= 0) return;
    withRunningCtx(ctx, () => {
    const t0 = ctx.currentTime;

    // Quick ascending sparkle run leading into the landing chord.
    const sparkleNotes = [523.25, 659.25, 783.99, 1046.5]; // C5 E5 G5 C6
    sparkleNotes.forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = freq;
      const start = t0 + i * 0.07;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.16 * finalStandingsVolume, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.22);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 0.24);
    });

    // Sustained bright major chord (C5-E5-G5-C6) as the landing — held
    // noticeably longer than Daily Double's, since this is the finale.
    const chordStart = t0 + 0.32;
    [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = chordStart + i * 0.015;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.2 * finalStandingsVolume, start + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 1.1);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(start);
      osc.stop(start + 1.12);
    });
    });
  } catch (e) {
    /* best effort — silently ignore if audio is blocked */
  }
}

export const playFinalStandingsSfx = createSfx({
  url: finalStandingsSfxUrl,
  fallbackTone: playSynthFinalStandingsTone,
  volume: FINAL_STANDINGS_MP3_BASE_VOLUME,
  minGapMs: 500,
});

// Plays the host's custom celebration sound if one's set on the round
// (rd.standingsSfxUrl — an uploaded file ref, a direct URL, or a Google
// Drive link, resolved the same way clue media is via getMediaUrl), or
// falls back to the built-in playFinalStandingsSfx above. Kept as a plain
// <audio> element rather than routed through the WebAudio SFX plumbing
// above, since it's an arbitrary user file rather than a short fixed clip.
export async function playStandingsCelebration(customRef) {
  if (customRef) {
    try {
      const url = await getMediaUrl(customRef);
      if (url) {
        const audio = new Audio(url);
        audio.volume = FINAL_STANDINGS_CUSTOM_BASE_VOLUME * finalStandingsVolume;
        currentCelebrationAudio = audio;
        currentCelebrationBaseVolume = FINAL_STANDINGS_CUSTOM_BASE_VOLUME;
        // Duck for exactly as long as this clip actually plays, rather
        // than guessing a fixed duration — we own this <audio> element
        // directly, unlike the built-in tone below, so real 'ended'/
        // 'error' events are available. The safety-net timeout below
        // guards against a source that never fires either (e.g. a
        // stream that stalls) leaving the BGM permanently ducked.
        clearTimeout(duckingTimeoutId);
        setDucking(true);
        const stopTrackingVolume = () => {
          // Guard against a newer celebration having already taken over
          // this slot (e.g. host retriggers before this one finished).
          if (currentCelebrationAudio === audio) currentCelebrationAudio = null;
        };
        const unduck = () => setDucking(false);
        audio.addEventListener("ended", unduck, { once: true });
        audio.addEventListener("ended", stopTrackingVolume, { once: true });
        audio.addEventListener("error", unduck, { once: true });
        audio.addEventListener("error", stopTrackingVolume, { once: true });
        duckingTimeoutId = setTimeout(unduck, 15000);
        await audio.play();
        return;
      }
    } catch (e) {
      setDucking(false);
      currentCelebrationAudio = null;
      /* couldn't load/play the custom sound — fall through to the built-in */
    }
  }
  duckBgmFor(BUILTIN_STANDINGS_DUCK_MS);
  playFinalStandingsSfx();
}

// Hard-stops whatever celebration sound is currently playing (custom
// file/Drive link path only — the built-in tone is a short WebAudio
// blip with no handle to cancel mid-flight, but at ~1.5s it's not worth
// the extra plumbing). Also un-ducks the BGM immediately rather than
// waiting for the natural 'ended'/timeout path, since the reason we're
// stopping is usually "the moment this sound belonged to is already
// over" (round changed, player left the room, standings got reset for
// a replay, component unmounted, etc.) — leaving the BGM ducked for
// however many seconds were left on a sound nobody will hear the rest
// of would just be a second, quieter bug on top of the first.
export function stopStandingsCelebration() {
  clearTimeout(duckingTimeoutId);
  setDucking(false);
  if (currentCelebrationAudio) {
    try {
      currentCelebrationAudio.pause();
      currentCelebrationAudio.currentTime = 0;
    } catch (e) {
      /* best effort */
    }
    currentCelebrationAudio = null;
  }
}

/* ---------------- GLOBAL DELEGATED HANDLERS ---------------- */
// Wires the click/hover SFX to every button (or role="button") in the app
// via document-level listeners, rather than per-element handlers.
export function installGlobalBoardSfx() {
  const handleGlobalClick = (e) => {
    const btn = e.target.closest && e.target.closest("button, [role='button']");
    if (btn && !btn.disabled && !btn.closest("[data-sfx-handled]")) playClickSfx();
  };
  document.addEventListener("click", handleGlobalClick, true);

  let lastHoveredBtn = null;
  const handleGlobalMouseOver = (e) => {
    const btn = e.target.closest && e.target.closest("button, [role='button']");
    if (btn && !btn.disabled) {
      if (btn !== lastHoveredBtn) {
        lastHoveredBtn = btn;
        playHoverTick();
      }
    } else {
      lastHoveredBtn = null;
    }
  };
  document.addEventListener("mouseover", handleGlobalMouseOver, true);

  return () => {
    document.removeEventListener("click", handleGlobalClick, true);
    document.removeEventListener("mouseover", handleGlobalMouseOver, true);
  };
}