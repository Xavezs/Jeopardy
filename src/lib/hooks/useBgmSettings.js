import { useState, useRef, useEffect } from "react";
import { BgmStore, blankTrack } from "../storage/bgmStore";
import { MediaStore } from "../storage";
import { humanSize } from "../utils";

/* =========================================================================
   useBgmSettings
   Background music is GLOBAL — deliberately its own bit of state, loaded
   once at startup and saved to its own storage key, completely decoupled
   from the session. It must never live inside session.data, or switching
   sessions would hand BackgroundMusicPlayer a new settings object and the
   track would reset/restart.

   `roundKey` (passed in by the caller, e.g. String(data.currentRound) or
   "final") identifies which round's track is "active" right now when
   bgmSettings.mode === "perRound". It's just a read each render — nothing
   here subscribes to it changing; `activeTrack` below is recomputed fresh
   every render from the latest bgmSettings + roundKey, so switching rounds
   naturally flows through to whatever's consuming activeTrack.
   ========================================================================= */
function activeTrackOf(bgm, roundKey) {
  if (!bgm) return null;
  if (bgm.mode === "perRound") {
    return { ...blankTrack(), ...bgm.perRound?.[roundKey] };
  }
  return { source: bgm.source, fileRef: bgm.fileRef, fileName: bgm.fileName, loop: bgm.loop };
}

export function useBgmSettings({ appConfirm, appAlert, roundKey }) {
  const [bgmSettings, setBgmSettings] = useState(null);
  const bgmRef = useRef(null);
  useEffect(() => {
    bgmRef.current = bgmSettings;
  }, [bgmSettings]);
  const roundKeyRef = useRef(roundKey);
  useEffect(() => {
    roundKeyRef.current = roundKey;
  }, [roundKey]);
  const bgmPersistTimeout = useRef(null);

  function updateBgm(patch) {
    const next = { ...bgmRef.current, ...patch };
    setBgmSettings(next);
    bgmRef.current = next;
    clearTimeout(bgmPersistTimeout.current);
    bgmPersistTimeout.current = setTimeout(() => {
      BgmStore.save(bgmRef.current);
    }, 400);
  }

  // Patches whichever track is currently "active": the universal track's
  // top-level fields in "universal" mode, or perRound[roundKeyRef.current]
  // in "perRound" mode. This is what upload/clear/loop/direct-url below
  // all go through, so the same controls in BackgroundMusicPlayer keep
  // working unchanged regardless of which mode is selected.
  function updateActiveTrack(patch) {
    const cur = bgmRef.current;
    if (!cur) return;
    if (cur.mode === "perRound") {
      const key = roundKeyRef.current;
      updateBgm({
        perRound: {
          ...cur.perRound,
          [key]: { ...blankTrack(), ...cur.perRound?.[key], ...patch },
        },
      });
    } else {
      updateBgm(patch);
    }
  }

  function setBgmMode(mode) {
    updateBgm({ mode });
  }

  // Called once during app init. One-time migration: if this is the very
  // first time (no global track saved yet) but the just-loaded session
  // happens to have an old per-session track from before this was global,
  // adopt it so nobody's existing music silently disappears.
  async function initBgm(loadedSessionData) {
    let bgm = await BgmStore.load();
    const legacyBgm = loadedSessionData.settings.backgroundMusic;
    if (!bgm.fileRef && legacyBgm && legacyBgm.fileRef) {
      bgm = { ...bgm, ...legacyBgm };
      await BgmStore.save(bgm);
    }
    setBgmSettings(bgm);
    bgmRef.current = bgm;
  }

  async function handleBgmUpload(file) {
    if (!file) return;
    const proceed =
      file.size < 50 * 1024 * 1024 ||
      (await appConfirm(`"${file.name}" is ${humanSize(file.size)}. That's a large file — it may take a moment to store. Use it anyway?`));
    if (!proceed) return;
    try {
      const ref = await MediaStore.put(file);
      updateActiveTrack({ source: "file", fileRef: ref, fileName: `${file.name} (${humanSize(file.size)})` });
    } catch (e) {
      appAlert("Could not store that track — your browser may be blocking local storage (e.g. private browsing mode).");
    }
  }
  function clearBgm() {
    updateActiveTrack({ fileRef: "", fileName: "", source: "file" });
  }
  // Volume stays global — not per-track, not per-round. See
  // defaultBgmSettings() in bgmStore.js for why.
  function setBgmVolume(volume) {
    updateBgm({ volume });
  }
  function toggleBgmLoop() {
    const active = activeTrackOf(bgmRef.current, roundKeyRef.current);
    updateActiveTrack({ loop: !active?.loop });
  }
  // Direct audio link (mp3/ogg/etc, played via a plain <audio> element —
  // same code path as an uploaded file, just backed by a URL instead of a
  // MediaStore ref).
  function setBgmDirectUrl(url, name) {
    updateActiveTrack({ source: "file", fileRef: url, fileName: name });
  }

  const activeTrack = activeTrackOf(bgmSettings, roundKey);

  return {
    bgmSettings,
    activeTrack,
    setBgmMode,
    initBgm,
    handleBgmUpload,
    clearBgm,
    setBgmVolume,
    toggleBgmLoop,
    setBgmDirectUrl,
  };
}