// SHARED SFX UTILITIES

let sharedCtx = null;
const SFX_VOLUME_KEY = "jeopardy:sfx-volume";
const sfxVolumeListeners = new Set();
const activeSfxAudio = new Map();
let sfxVolume = loadSfxVolume();
let sfxOutputGain = null;

function loadSfxVolume() {
  try {
    const saved = Number.parseFloat(localStorage.getItem(SFX_VOLUME_KEY));
    if (Number.isFinite(saved)) return Math.max(0, Math.min(1, saved));
  } catch (e) {
  }
  return 1;
}

export function getSfxVolume() {
  return sfxVolume;
}

export function setSfxVolume(value) {
  sfxVolume = Math.max(0, Math.min(1, Number(value) || 0));
  if (sfxOutputGain && sharedCtx?.state !== "closed") {
    sfxOutputGain.gain.setTargetAtTime(sfxVolume, sharedCtx.currentTime, 0.02);
  }
  for (const [audio, baseVolume] of activeSfxAudio) {
    audio.volume = Math.max(0, Math.min(1, baseVolume * sfxVolume));
  }
  try {
    localStorage.setItem(SFX_VOLUME_KEY, String(sfxVolume));
  } catch (e) {
  }
  for (const listener of sfxVolumeListeners) listener(sfxVolume);
}

export function subscribeSfxVolume(listener) {
  sfxVolumeListeners.add(listener);
  return () => sfxVolumeListeners.delete(listener);
}

export function getSfxOutput(ctx) {
  if (ctx !== sharedCtx) return ctx.destination;
  if (!sfxOutputGain || sfxOutputGain.context.state === "closed") {
    sfxOutputGain = ctx.createGain();
    sfxOutputGain.gain.value = sfxVolume;
    sfxOutputGain.connect(ctx.destination);
  }
  return sfxOutputGain;
}

export function setSfxAudioVolume(audio, baseVolume, trackPlayback = false) {
  audio.volume = Math.max(0, Math.min(1, baseVolume * sfxVolume));
  if (trackPlayback && !activeSfxAudio.has(audio)) {
    activeSfxAudio.set(audio, baseVolume);
    const untrack = () => activeSfxAudio.delete(audio);
    audio.addEventListener("ended", untrack, { once: true });
    audio.addEventListener("error", untrack, { once: true });
  }
}

export function playSfxAudio(url, volume = 1) {
  const audio = new Audio(url);
  setSfxAudioVolume(audio, volume, true);
  audio.play().catch((err) => console.warn("Could not play sound effect:", err));
  return audio;
}

export function getSharedAudioCtx() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!sharedCtx || sharedCtx.state === "closed") {
    sharedCtx = new Ctx();
    sfxOutputGain = null;
  }
  return sharedCtx;
}

export function withRunningCtx(ctx, schedule) {
  if (ctx.state === "suspended") {
    ctx.resume().then(schedule).catch(() => {});
  } else {
    schedule();
  }
}

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

// Unlocks audio playback for this device/origin
export function unlockAudioPlayback() {
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
    }
  }

  try {
    const el = new Audio();
    el.muted = true;
    const p = el.play();
    if (p && typeof p.catch === "function") {
      p.then(() => el.pause()).catch(() => {});
    }
  } catch (e) {
  }
}

export function createSfx({ url, fallbackTone, volume = 0.1, minGapMs = 40, onEnded }) {
  const audioTemplate = typeof Audio !== "undefined" ? new Audio(url) : null;
  let fileAvailable = !!audioTemplate;
  let baseVolume = volume;
  if (audioTemplate) {
    audioTemplate.preload = "auto";
    setSfxAudioVolume(audioTemplate, baseVolume);
    audioTemplate.addEventListener("error", () => {
      fileAvailable = false;
    });
  }

  let lastPlayedAt = 0;
  const activeNodes = new Set();

  function attemptPlay(isRetry) {
    try {
      const node = audioTemplate.cloneNode(true);
      setSfxAudioVolume(node, baseVolume, true);
      activeNodes.add(node);
      const untrack = () => activeNodes.delete(node);
      node.addEventListener("ended", untrack, { once: true });
      node.addEventListener("error", untrack, { once: true });
      if (onEnded) node.addEventListener("ended", onEnded, { once: true });
      const playPromise = node.play();
      if (playPromise && typeof playPromise.catch === "function") {
        playPromise.catch(() => {
          untrack();
          if (isRetry) {
            fallbackTone();
            return;
          }
          waitForBuffered(audioTemplate, 400).then(() => attemptPlay(true));
        });
      }
    } catch (e) {
      if (isRetry) {
        fileAvailable = false;
        fallbackTone();
      } else {
        waitForBuffered(audioTemplate, 400).then(() => attemptPlay(true));
      }
    }
  }

  const play = function play() {
    const now = performance.now();
    if (now - lastPlayedAt < minGapMs) return;
    lastPlayedAt = now;

    if (audioTemplate && fileAvailable) {
      attemptPlay(false);
      return;
    }
    fallbackTone();
  };

  play.setVolume = (v) => {
    baseVolume = Math.max(0, Math.min(1, v));
    if (audioTemplate) setSfxAudioVolume(audioTemplate, baseVolume);
    for (const node of activeNodes) setSfxAudioVolume(node, baseVolume);
  };

  play.stop = () => {
    for (const node of activeNodes) {
      try {
        node.pause();
        node.currentTime = 0;
      } catch (e) {
      }
    }
    activeNodes.clear();
  };

  return play;
}