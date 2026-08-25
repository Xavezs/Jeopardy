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

// A round is identified by a "roundKey": the stringified index into
// data.rounds ("0", "1", ...) for normal rounds, or the literal "final"
// for the Final Jeopardy round (mirrors the rd.type === "final" check
// already used throughout JeopardyBoard.jsx). Keying by index rather than
// a hardcoded "normal"/"double" name means this keeps working no matter
// how many non-final rounds a session has.
export function blankTrack() {
  return { source: "file", fileRef: "", fileName: "", loop: true };
}

export function defaultBgmSettings() {
  return {
    // "universal": one track plays across every round (legacy/default
    // behavior). "perRound": each roundKey gets its own independent
    // track, looked up in `perRound` below.
    mode: "universal",
    // Volume is intentionally NOT split per round/mode — it's a device
    // preference (see calcGain/DUCK_LEVEL in BackgroundMusicPlayer.jsx),
    // not part of "which song plays when".
    volume: 0.5,
    // The universal track (used when mode === "universal"). Kept at the
    // top level, unchanged from before, so existing saved settings and
    // PlayerBgmWidget/useBgmSync keep working without any migration.
    source: "file",
    fileRef: "",
    fileName: "",
    loop: true,
    // Per-round tracks (used when mode === "perRound").
    // Shape: { [roundKey]: { source, fileRef, fileName, loop } }
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