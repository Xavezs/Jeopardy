import { createSfx, getSharedAudioCtx, withRunningCtx } from "./sfx";
import { getMediaUrl } from "./storage";

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

function playSynthDailyDoubleTone() {
  try {
    const ctx = getSharedAudioCtx();
    if (!ctx) return;
    withRunningCtx(ctx, () => {
    const t0 = ctx.currentTime;

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
    });
    });
  } catch (e) {
    /* best effort — silently ignore if audio is blocked */
  }
}

export const playDailyDoubleSfx = createSfx({
  url: dailyDoubleSfxUrl,
  fallbackTone: playSynthDailyDoubleTone,
  volume: 0.18,
  minGapMs: 200,
});

/* ---------------- FINAL STANDINGS ----------------
   Plays once, for host and every player alike, the moment Final Standings
   is revealed — the actual "game's over" celebration beat. Bigger and
   brighter than Daily Double's sting: a rising arpeggio into a sustained
   major chord, since this needs to feel conclusive rather than just
   "something exciting is starting". */
const finalStandingsSfxUrl = new URL("../assets/final-standings.mp3", import.meta.url).href;

function playSynthFinalStandingsTone() {
  try {
    const ctx = getSharedAudioCtx();
    if (!ctx) return;
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
      gain.gain.exponentialRampToValueAtTime(0.16, start + 0.015);
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
      gain.gain.exponentialRampToValueAtTime(0.2, start + 0.03);
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
  volume: 0.2,
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
        audio.volume = 0.6;
        await audio.play();
        return;
      }
    } catch (e) {
      /* couldn't load/play the custom sound — fall through to the built-in */
    }
  }
  playFinalStandingsSfx();
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