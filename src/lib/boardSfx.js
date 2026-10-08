import { createSfx, getSharedAudioCtx, withRunningCtx } from "./sfx";
import { getMediaUrl } from "./storage";
import { storeGet, storeSet } from "./storage/kvStore";

// BOARD SOUND EFFECTS

// HOVER TICK
const hoverTickUrl = new URL("../assets/hover-tick.mp3", import.meta.url).href;

function playSynthHoverTick() {
  try {
    const ctx = getSharedAudioCtx();
    if (!ctx) return;
    withRunningCtx(ctx, () => {
    const t0 = ctx.currentTime;

    // Low "thock" body
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

    // Short filtered noise burst
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
  }
}

export const playHoverTick = createSfx({
  url: hoverTickUrl,
  fallbackTone: playSynthHoverTick,
  volume: 0.1,
  minGapMs: 55,
});

// BGM DUCKING BUS
const duckingListeners = new Set();
const activeDuckHolds = new Set();
let duckingActive = false;

function recomputeDucking() {
  const shouldDuck = activeDuckHolds.size > 0;
  if (shouldDuck === duckingActive) return;
  duckingActive = shouldDuck;
  for (const listener of duckingListeners) listener(duckingActive);
}

export function subscribeSfxDucking(listener) {
  duckingListeners.add(listener);
  return () => duckingListeners.delete(listener);
}

// Opens an indefinite ducking hold
export function holdBgmDuck() {
  const token = {};
  activeDuckHolds.add(token);
  recomputeDucking();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeDuckHolds.delete(token);
    recomputeDucking();
  };
}

const BUILTIN_STANDINGS_SAFETY_MS = 15000;

// CLICK
const clickSfxUrl = new URL("../assets/click.mp3", import.meta.url).href;

function playSynthClickTone() {
  try {
    const ctx = getSharedAudioCtx();
    if (!ctx) return;
    withRunningCtx(ctx, () => {
    const t0 = ctx.currentTime;

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
  }
}

export const playClickSfx = createSfx({
  url: clickSfxUrl,
  fallbackTone: playSynthClickTone,
  volume: 0.1,
  minGapMs: 40,
});

// CORRECT / INCORRECT
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

// CATEGORY REVEAL
const catRevealSfxUrl = new URL("../assets/reveal-card.mp3", import.meta.url).href;

function playSynthCatRevealTone() {
  try {
    const ctx = getSharedAudioCtx(); // reuse the same shared AudioContext
    if (!ctx) return;
    withRunningCtx(ctx, () => {
    const t0 = ctx.currentTime;

    // Ascending bright chime
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
  }
}

export const playCatRevealSfx = createSfx({
  url: catRevealSfxUrl,
  fallbackTone: playSynthCatRevealTone,
  volume: 0.15,
  minGapMs: 40,
});

const buzzSfxUrl = new URL("../assets/buzz.mp3", import.meta.url).href;

function playSynthBuzzTone() {
  try {
    const ctx = getSharedAudioCtx();
    if (!ctx) return;
    withRunningCtx(ctx, () => {
    const t0 = ctx.currentTime;

    // Sharp, urgent buzzer
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
  }
}

export const playBuzzSfx = createSfx({
  url: buzzSfxUrl,
  fallbackTone: playSynthBuzzTone,
  volume: 0.2,
  minGapMs: 40,
});

// DAILY DOUBLE
const dailyDoubleSfxUrl = new URL("../assets/daily-double.mp3", import.meta.url).href;

let activeDailyDoubleSynthNodes = [];

function playSynthDailyDoubleTone() {
  try {
    const ctx = getSharedAudioCtx();
    if (!ctx) return;
    withRunningCtx(ctx, () => {
    const t0 = ctx.currentTime;
    const nodes = [];

    // Rising sweep
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
  }
}

function stopSynthDailyDoubleTone() {
  for (const node of activeDailyDoubleSynthNodes) {
    try {
      if (typeof node.stop === "function") node.stop(0);
    } catch (e) {
    }
    try {
      node.disconnect();
    } catch (e) {
    }
  }
  activeDailyDoubleSynthNodes = [];
}

// Not exported directly
const playDailyDoubleSfxRaw = createSfx({
  url: dailyDoubleSfxUrl,
  fallbackTone: playSynthDailyDoubleTone,
  volume: 0.18,
  minGapMs: 200,
  onEnded: () => {
    if (releaseDailyDoubleDuck) {
      releaseDailyDoubleDuck();
      releaseDailyDoubleDuck = null;
    }
  },
});

const DAILY_DOUBLE_DUCK_SAFETY_MS = 15000;

let releaseDailyDoubleDuck = null;

export function playDailyDoubleSfx() {
  if (releaseDailyDoubleDuck) releaseDailyDoubleDuck();
  releaseDailyDoubleDuck = holdBgmDuck();
  const thisDuckRelease = releaseDailyDoubleDuck;
  setTimeout(() => {
    if (releaseDailyDoubleDuck === thisDuckRelease && releaseDailyDoubleDuck) {
      releaseDailyDoubleDuck();
      releaseDailyDoubleDuck = null;
    }
  }, DAILY_DOUBLE_DUCK_SAFETY_MS);
  playDailyDoubleSfxRaw();
}

export function stopDailyDoubleSfx() {
  if (releaseDailyDoubleDuck) {
    releaseDailyDoubleDuck();
    releaseDailyDoubleDuck = null;
  }
  playDailyDoubleSfxRaw.stop();
  stopSynthDailyDoubleTone();
}

// FINAL STANDINGS
const finalStandingsSfxUrl = new URL("../assets/final-standings.mp3", import.meta.url).href;

// FINAL STANDINGS VOLUME
const FINAL_STANDINGS_VOLUME_KEY = "jp_final_standings_volume";
const FINAL_STANDINGS_MP3_BASE_VOLUME = 0.2;
const FINAL_STANDINGS_CUSTOM_BASE_VOLUME = 0.6;

let finalStandingsVolume = 1;

let currentCelebrationAudio = null;
let currentCelebrationBaseVolume = 0;

// Preloaded <audio> element for the custom
let preloadedCelebration = null;

function applyFinalStandingsVolume() {
  playFinalStandingsSfx.setVolume(FINAL_STANDINGS_MP3_BASE_VOLUME * finalStandingsVolume);
  if (currentCelebrationAudio) {
    currentCelebrationAudio.volume = currentCelebrationBaseVolume * finalStandingsVolume;
  }
}

export async function loadFinalStandingsVolume() {
  try {
    const raw = await storeGet(FINAL_STANDINGS_VOLUME_KEY);
    const parsed = raw != null ? parseFloat(raw) : NaN;
    if (Number.isFinite(parsed)) {
      finalStandingsVolume = Math.max(0, Math.min(1, parsed));
      applyFinalStandingsVolume();
    }
  } catch (e) {
  }
  return finalStandingsVolume;
}

// Called from the slider's onChange
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
    // 0 just skips scheduling anything
    if (finalStandingsVolume <= 0) return;
    withRunningCtx(ctx, () => {
    const t0 = ctx.currentTime;

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
  }
}

export const playFinalStandingsSfx = createSfx({
  url: finalStandingsSfxUrl,
  fallbackTone: playSynthFinalStandingsTone,
  volume: FINAL_STANDINGS_MP3_BASE_VOLUME,
  minGapMs: 500,
  onEnded: () => {
    if (releaseStandingsDuck) {
      releaseStandingsDuck();
      releaseStandingsDuck = null;
    }
  },
});

let releaseStandingsDuck = null;

// Kicks off loading the custom celebration sound
export async function preloadStandingsCelebration(customRef) {
  if (!customRef) {
    preloadedCelebration = null;
    return;
  }
  if (preloadedCelebration && preloadedCelebration.ref === customRef) return;
  try {
    const url = await getMediaUrl(customRef);
    if (!url) {
      preloadedCelebration = null;
      return;
    }
    const audio = new Audio(url);
    audio.preload = "auto";
    audio.load();
    preloadedCelebration = { ref: customRef, audio };
  } catch (e) {
    preloadedCelebration = null;
  }
}

export async function playStandingsCelebration(customRef) {
  // Open the duck hold FIRST
  if (releaseStandingsDuck) releaseStandingsDuck();
  releaseStandingsDuck = holdBgmDuck();

  if (customRef) {
    try {
      let audio;
      if (preloadedCelebration && preloadedCelebration.ref === customRef) {
        audio = preloadedCelebration.audio;
        audio.currentTime = 0;
      } else {
        const url = await getMediaUrl(customRef);
        audio = url ? new Audio(url) : null;
      }
      if (audio) {
        audio.volume = FINAL_STANDINGS_CUSTOM_BASE_VOLUME * finalStandingsVolume;
        currentCelebrationAudio = audio;
        currentCelebrationBaseVolume = FINAL_STANDINGS_CUSTOM_BASE_VOLUME;
        const stopTrackingVolume = () => {
          if (currentCelebrationAudio === audio) currentCelebrationAudio = null;
        };
        const unduck = () => {
          if (releaseStandingsDuck) {
            releaseStandingsDuck();
            releaseStandingsDuck = null;
          }
        };
        audio.addEventListener("ended", unduck, { once: true });
        audio.addEventListener("ended", stopTrackingVolume, { once: true });
        audio.addEventListener("error", unduck, { once: true });
        audio.addEventListener("error", stopTrackingVolume, { once: true });
        setTimeout(unduck, 15000);
        await audio.play();
        return;
      }
    } catch (e) {
      currentCelebrationAudio = null;
    }
  }
  const thisDuckRelease = releaseStandingsDuck;
  setTimeout(() => {
    if (releaseStandingsDuck === thisDuckRelease && releaseStandingsDuck) {
      releaseStandingsDuck();
      releaseStandingsDuck = null;
    }
  }, BUILTIN_STANDINGS_SAFETY_MS);
  playFinalStandingsSfx();
}

export function stopStandingsCelebration() {
  if (releaseStandingsDuck) {
    releaseStandingsDuck();
    releaseStandingsDuck = null;
  }
  if (currentCelebrationAudio) {
    try {
      currentCelebrationAudio.pause();
      currentCelebrationAudio.currentTime = 0;
    } catch (e) {
    }
    currentCelebrationAudio = null;
  }
}

// GLOBAL DELEGATED HANDLERS
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