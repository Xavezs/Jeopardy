import { storeGet, storeSet } from "./kvStore";

// BGM STORE
const BGM_KEY = "jp_global_bgm";

export function blankTrack() {
  return { source: "file", fileRef: "", fileName: "", loop: true };
}

export function defaultBgmSettings() {
  return {
    mode: "universal",
    // Volume is intentionally NOT split per round/mode
    volume: 0.5,
    // The universal track
    source: "file",
    fileRef: "",
    fileName: "",
    loop: true,
    // Per-round tracks (used when mode === "perRound")
    perRound: {},
  };
}

export const BgmStore = {
  async load() {
    const raw = await storeGet(BGM_KEY);
    return raw ? { ...defaultBgmSettings(), ...JSON.parse(raw) } : defaultBgmSettings();
  },
  async save(settings) {
    return await storeSet(BGM_KEY, JSON.stringify(settings));
  },
};