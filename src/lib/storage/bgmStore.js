import { storeGet, storeSet } from "./kvStore";

/* =========================================================================
   BGM STORE
   Background music settings used to live inside each session's
   data.settings.backgroundMusic — which meant switching sessions handed
   BackgroundMusicPlayer a brand new settings object and the track would
   reset/restart. This store keeps ONE global copy instead, under its own
   key, completely independent of which session is currently loaded.
   ========================================================================= */
const BGM_KEY = "jp_global_bgm";

export function defaultBgmSettings() {
  return {
    source: "file",
    fileRef: "",
    fileName: "",
    spotifyUrl: "",
    volume: 0.5,
    loop: true,
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
