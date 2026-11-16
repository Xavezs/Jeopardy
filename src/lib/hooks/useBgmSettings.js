import { useState, useRef, useEffect } from "react";
import { BgmStore, blankTrack } from "../storage/bgmStore";
import { MediaStore } from "../storage";
import { humanSize } from "../utils";

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

  // Called once during app init
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
  // Volume stays global
  function setBgmVolume(volume) {
    updateBgm({ volume });
  }
  function toggleBgmLoop() {
    const active = activeTrackOf(bgmRef.current, roundKeyRef.current);
    updateActiveTrack({ loop: !active?.loop });
  }
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