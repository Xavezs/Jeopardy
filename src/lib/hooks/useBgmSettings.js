import { useState, useRef, useEffect } from "react";
import { BgmStore } from "../storage/bgmStore";
import { MediaStore } from "../storage";
import { humanSize } from "../utils";

/* =========================================================================
   useBgmSettings
   Background music is GLOBAL — deliberately its own bit of state, loaded
   once at startup and saved to its own storage key, completely decoupled
   from the session. It must never live inside session.data, or switching
   sessions would hand BackgroundMusicPlayer a new settings object and the
   track would reset/restart.
   ========================================================================= */
export function useBgmSettings({ appConfirm, appAlert }) {
  const [bgmSettings, setBgmSettings] = useState(null);
  const bgmRef = useRef(null);
  useEffect(() => {
    bgmRef.current = bgmSettings;
  }, [bgmSettings]);
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
      updateBgm({ fileRef: ref, fileName: `${file.name} (${humanSize(file.size)})` });
    } catch (e) {
      appAlert("Could not store that track — your browser may be blocking local storage (e.g. private browsing mode).");
    }
  }
  function clearBgm() {
    updateBgm({ fileRef: "", fileName: "", soundcloudUrl: "", source: "file" });
  }
  function setBgmVolume(volume) {
    updateBgm({ volume });
  }
  function toggleBgmLoop() {
    updateBgm({ loop: !bgmRef.current.loop });
  }
  // Direct audio link (mp3/ogg/etc, played via a plain <audio> element —
  // same code path as an uploaded file, just backed by a URL instead of a
  // MediaStore ref). Clears any previously-loaded SoundCloud track so the
  // two sources never both hang around in settings at once.
  function setBgmDirectUrl(url, name) {
    updateBgm({ source: "file", fileRef: url, fileName: name, soundcloudUrl: "" });
  }
  // SoundCloud track/set link, played via their embedded Widget player
  // (see lib/soundcloud.js) since SoundCloud doesn't offer direct file
  // URLs. Clears any direct file/upload so only one source is active.
  function setBgmSoundcloudUrl(url) {
    updateBgm({ source: "soundcloud", soundcloudUrl: url, fileRef: "", fileName: "SoundCloud track" });
  }

  return {
    bgmSettings,
    initBgm,
    handleBgmUpload,
    clearBgm,
    setBgmVolume,
    toggleBgmLoop,
    setBgmDirectUrl,
    setBgmSoundcloudUrl,
  };
}