import React, { useState, useEffect, useRef, useCallback } from "react";
import "./styles/board.css";
import {
  SessionStore,
  blankClue,
  blankCategory,
  migrateClueSchemaIfNeeded,
  MediaStore,
  isMediaRef,
  detectMediaTypeFromFile,
  detectMediaTypeFromUrl,
} from "./lib/storage";
import { formatDate, isDataUrl, humanSize } from "./lib/utils";
import ClueModal from "./components/ClueModal";
import EditClueModal from "./components/EditClueModal";
import SessionsModal from "./components/SessionsModal";
import ConfirmDialog from "./components/ConfirmDialog";
import TeamRandomizer from "./components/TeamRandomizer";
import BackgroundMusicPlayer from "./components/BackgroundMusicPlayer";
import { BgmStore } from "./lib/storage/bgmStore";
import MarqueeBulbs from "./lib/MarqueeBulbs";
import { createSfx, getSharedAudioCtx } from "./lib/sfx";
import { useScorePulse } from "./lib/hooks/useScorePulse";
import { useConfirmDialog } from "./lib/hooks/useConfirmDialog";
import DiscordOverlay from "./components/DiscordOverlay";

/* =========================================================================
   HOVER SOUND
   Plays src/assets/hover-tick.mp3 if it's present; otherwise falls back to
   a short synthesized "tick" so hovering still has a sound effect even
   before you've dropped a file in. File-load/fallback/debounce plumbing
   lives in lib/sfx.js's createSfx() — only the synthesized tone (which is
   unique to this sound) stays here.

   Note: this uses `new URL(..., import.meta.url)` rather than a static
   `import x from "./assets/hover-tick.mp3"`. A static import needs Vite to
   resolve the file at BUILD time — if it's missing, the whole build fails.
   `new URL()` just builds a URL string, so it's safe to reference a file
   that may not exist yet; we detect that at runtime instead and swap to
   the fallback tone.
   ========================================================================= */
const hoverTickUrl = new URL("./assets/hover-tick.mp3", import.meta.url).href;

function playSynthHoverTick() {
  try {
    const ctx = getSharedAudioCtx();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume();
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
  } catch (e) {
    /* best effort — silently ignore if audio is blocked */
  }
}

const playHoverTick = createSfx({
  url: hoverTickUrl,
  fallbackTone: playSynthHoverTick,
  volume: 0.1,
  minGapMs: 55, // guards against a rapid mouse-sweep firing a pile of overlapping plays
});

/* =========================================================================
   CLICK SOUND
   Same idea as the hover tick above: plays src/assets/click.mp3 if it's
   present, otherwise falls back to a short synthesized "click" so every
   button still has a sound effect even before a file's been dropped in.
   Fired globally (see the document-level listener in the component below)
   so every <button> in the app — board, toolbar, modals, custom players,
   the music widget — gets it for free, with no per-button wiring needed.
   ========================================================================= */
const clickSfxUrl = new URL("./assets/click.mp3", import.meta.url).href;

function playSynthClickTone() {
  try {
    const ctx = getSharedAudioCtx(); // reuse the same shared AudioContext as the hover tick
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume();
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
  } catch (e) {
    /* best effort — silently ignore if audio is blocked */
  }
}

const playClickSfx = createSfx({
  url: clickSfxUrl,
  fallbackTone: playSynthClickTone,
  volume: 0.1,
  minGapMs: 40, // guards against double-fires (e.g. a click that also triggers a synthetic one)
});

/* =========================================================================
   CORRECT / INCORRECT SOUNDS
   Same pair used in ClueModal for its ↑ / ↓ scoring shortcut — reused here
   so the main scoreboard's number-key-select + ↑/↓ shortcut sounds
   identical. Same file-with-synth-fallback pattern — see lib/sfx.js's
   createSfx().
   ========================================================================= */
const correctSfxUrl = new URL("./assets/correct.mp3", import.meta.url).href;
const incorrectSfxUrl = new URL("./assets/incorrect.mp3", import.meta.url).href;

function playSynthCorrectTone() {
  try {
    const ctx = getSharedAudioCtx();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume();
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
  } catch (e) {
    /* best effort — silently ignore if audio is blocked */
  }
}

function playSynthIncorrectTone() {
  try {
    const ctx = getSharedAudioCtx();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume();
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
  } catch (e) {
    /* best effort — silently ignore if audio is blocked */
  }
}

const playCorrectSfx = createSfx({
  url: correctSfxUrl,
  fallbackTone: playSynthCorrectTone,
  volume: 0.15,
  minGapMs: 40,
});

const playIncorrectSfx = createSfx({
  url: incorrectSfxUrl,
  fallbackTone: playSynthIncorrectTone,
  volume: 0.15,
  minGapMs: 40,
});

/* =========================================================================
   CATEGORY REVEAL SOUND
   Plays src/assets/reveal.mp3 if present; otherwise falls back to a short
   synthesized ascending chime so category reveals still have audio even
   without a media file. File-load/fallback/debounce plumbing lives in
   lib/sfx.js's createSfx().
   ========================================================================= */
const catRevealSfxUrl = new URL("./assets/reveal-card.mp3", import.meta.url).href;

function playSynthCatRevealTone() {
  try {
    const ctx = getSharedAudioCtx(); // reuse the same shared AudioContext
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume();
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
  } catch (e) {
    /* best effort — silently ignore if audio is blocked */
  }
}

const playCatRevealSfx = createSfx({
  url: catRevealSfxUrl,
  fallbackTone: playSynthCatRevealTone,
  volume: 0.15,
  minGapMs: 40,
});

/* =========================================================================
   MARQUEE LIGHTS
   Moved to ./lib/MarqueeBulbs.jsx so it can be shared with the Team
   Randomizer's slot-machine border too.
   ========================================================================= */

/* =========================================================================
   MAIN APP
   ========================================================================= */
export default function JeopardyBoard() {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState(null);
  const sessionRef = useRef(null);
  useEffect(() => {
    sessionRef.current = session;
  }, [session]);

  const [editMode, setEditMode] = useState(false);
  const [view, setView] = useState("board"); // "board" | "randomizer"
  const [saveMsg, setSaveMsg] = useState("");
  const saveMsgTimeout = useRef(null);

  // Round-switch transition. Each category header + clue cell animates
  // individually (not the board as one piece) as a scale + fade ripple,
  // left to right: "idle" -> "out" (every column shrinks to 40% size and
  // fades to transparent, each column starting slightly later than the
  // column to its left) -> swap the actual round data -> "in-start"
  // (every cell jumps instantly back to 40%/transparent, no transition,
  // since it's already invisible either way) -> "idle" (pops back to full
  // size and opacity with a slight overshoot bounce, same left-to-right
  // stagger, revealing the new round). It's still just per-cell CSS
  // transform + opacity — GPU composited — so it stays smooth regardless
  // of grid size.
  const [boardFlip, setBoardFlip] = useState("idle"); // "idle" | "out" | "in-start" | "in"
  const boardFlipTimeouts = useRef([]);
  const FLIP_STAGGER_MS = 45; // delay added per column, left to right
  const FLIP_CELL_MS = 200; // must match the transition duration in board.css

  // "DOUBLE JEOPARDY!"-style announcement banner that pops up on a round
  // switch, holds briefly, then fades out right as the board flip begins.
  // { text, phase: "in" | "out" } | null — phase drives which CSS
  // animation (pop-in vs fade-out) is applied.
  const [roundBanner, setRoundBanner] = useState(null);
  const BANNER_HOLD_MS = 750; // how long the banner sits fully visible before fading
  const BANNER_FADE_MS = 300; // must match .round-banner-out transition in board.css
  useEffect(() => {
    return () => boardFlipTimeouts.current.forEach((t) => clearTimeout(t));
  }, []);
  // catIndex: which category column this cell belongs to — every cell in
  // the SAME column shares a delay, so the whole column flips together
  // and the wave rolls left to right across the board.
  // Only truly-idle (steady state, no flip in progress) resets the delay
  // to 0 — "in" is the pop-back-in leg itself and needs to KEEP the
  // stagger, or every cell would pop back at the exact same instant the
  // moment we transition away from "in-start".
  function flipDelay(catIndex) {
    return boardFlip === "idle" ? "0ms" : `${catIndex * FLIP_STAGGER_MS}ms`;
  }

  const [activeClue, setActiveClue] = useState(null); // {catId, value}
  const [revealed, setRevealed] = useState(false);

  // Category headers start blank (a clickable "?") and pop-reveal one at a
  // time as the host clicks each one — keyed by category id, so switching
  // rounds naturally re-hides the new round's categories (different ids)
  // while flipping back to an already-played round remembers what was
  // already shown. Never persisted — purely a live "for the show" state.
  const [revealedCats, setRevealedCats] = useState(() => new Set());
  function revealCategory(cat) {
    setRevealedCats((prev) => {
      if (prev.has(cat.id)) return prev;
      const next = new Set(prev);
      next.add(cat.id);
      return next;
    });
    playCatRevealSfx();
  }

  // True while the clue modal's own audio/video is playing — passed down to
  // BackgroundMusicPlayer so it can duck (fade down, not pause) instead of
  // the two overlapping. Reset to false whenever the clue modal closes.
  const [duckMusic, setDuckMusic] = useState(false);

  const [editingTarget, setEditingTarget] = useState(null); // {catId, value}
  const [editForm, setEditForm] = useState({ question: "", answer: "", timerSeconds: "" });
  const [mediaState, setMediaState] = useState({
    media: { mode: "url", url: "", fileRef: "", fileName: "", fileType: "" },
    answerMedia: { mode: "url", url: "", fileRef: "", fileName: "", fileType: "" },
  });

  // Drag-to-swap clue cards in Edit Mode. Dragging one cell onto another
  // swaps their CONTENT (question/answer/media/timer/used) between the two
  // grid positions — the $ value stays put since it's tied to the row, not
  // the clue. dragOverKey drives the visual "drop here" highlight while
  // hovering a valid target.
  const [dragSource, setDragSource] = useState(null); // {catId, value}
  const [dragOverKey, setDragOverKey] = useState(null); // catId + "-" + value

  // Which team's scoreboard number is "armed" for the ↑/↓ +/- shortcut —
  // click a team's score to select it (gold ring), then Up/Down adjusts
  // it by SCORE_STEP. Replaces the old dedicated +/- buttons. Cleared
  // whenever edit mode turns on, since editing uses a free-typed input
  // instead.
  const [selectedScoreTeamId, setSelectedScoreTeamId] = useState(null);
  const SCORE_STEP = 50;
  function swapClueCells(source, target) {
    if (!source || !target) return;
    if (source.catId === target.catId && source.value === target.value) return;
    const d = sessionRef.current.data;
    const rd = currentRoundOf(d);
    const srcCat = rd.categories.find((c) => c.id === source.catId);
    const tgtCat = rd.categories.find((c) => c.id === target.catId);
    if (!srcCat || !tgtCat) return;
    const srcClue = srcCat.clues[source.value] || blankClue();
    const tgtClue = tgtCat.clues[target.value] || blankClue();
    srcCat.clues[source.value] = tgtClue;
    tgtCat.clues[target.value] = srcClue;
    touch();
    persist();
  }

  const [sessionsModalOpen, setSessionsModalOpen] = useState(false);
  const [sessionIndex, setSessionIndex] = useState([]);

  // Background music is GLOBAL — deliberately its own bit of state, loaded
  // once at startup and saved to its own storage key, completely decoupled
  // from `session`. It must never live inside session.data, or switching
  // sessions hands BackgroundMusicPlayer a new settings object and the
  // track resets/restarts.
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

  const { scorePulse, firePulse } = useScorePulse();
  const { dialog, appConfirm, appAlert, resolveDialog } = useConfirmDialog();

  const data = session ? session.data : null;

  const persistTimeout = useRef(null);

  function touch() {
    setSession((s) => (s ? { ...s } : s));
  }

  const persist = useCallback(() => {
    // Update the UI immediately — don't make clicks wait on a storage write.
    touch();
    clearTimeout(persistTimeout.current);
    persistTimeout.current = setTimeout(async () => {
      const s = sessionRef.current;
      if (!s) return;
      await SessionStore.saveSession(s);
      setSaveMsg('Saved to "' + s.name + '"');
      clearTimeout(saveMsgTimeout.current);
      saveMsgTimeout.current = setTimeout(() => setSaveMsg(""), 1800);
    }, 400);
  }, []);

  const flushPersist = useCallback(async () => {
    if (persistTimeout.current) {
      clearTimeout(persistTimeout.current);
      persistTimeout.current = null;
    }
    const s = sessionRef.current;
    if (s) await SessionStore.saveSession(s);
  }, []);

  useEffect(() => {
    const handleBeforeUnload = () => {
      if (persistTimeout.current) {
        // Best-effort — fires a synchronous-ish save attempt before the tab closes.
        const s = sessionRef.current;
        if (s) SessionStore.saveSession(s);
      }
    };
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, []);

  // Global click SFX — fires for every <button> (and anything acting as one
  // via role="button", like the clue-modal's flip-to-reveal card) anywhere
  // in the app via one delegated listener, rather than wiring it into each
  // element individually. Skips disabled buttons since those don't actually
  // fire click events in the first place. The board's own clue cells play
  // this directly in their onClick instead (see below), since they're plain
  // divs with no role attribute — this selector never double-fires for them.
  useEffect(() => {
    const handleGlobalClick = (e) => {
      const btn = e.target.closest && e.target.closest("button, [role='button']");
      // data-sfx-handled opts an element out of the global click sound —
      // used by the clue-reveal front face, which plays its own reveal
      // chime instead and would otherwise double-fire both sounds at once.
      if (btn && !btn.disabled && !btn.closest("[data-sfx-handled]")) playClickSfx();
    };
    document.addEventListener("click", handleGlobalClick, true);
    return () => document.removeEventListener("click", handleGlobalClick, true);
  }, []);

  // Global hover SFX for every <button> OUTSIDE the board (toolbar, team
  // cards, modals, the music widget, etc.) — the clue cells themselves are
  // plain <div>s with their own dedicated hover handling below, so this
  // never double-fires for them. "mouseover" bubbles (unlike mouseenter),
  // so one delegated listener covers the whole app; lastHoveredBtn just
  // stops it from re-triggering on every pixel of mouse movement within
  // the same button.
  useEffect(() => {
    let lastHoveredBtn = null;
    const handleGlobalMouseOver = (e) => {
      const btn = e.target.closest && e.target.closest("button");
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
    return () => document.removeEventListener("mouseover", handleGlobalMouseOver, true);
  }, []);

  // Deselect the scoreboard team whenever edit mode is toggled on, or a
  // clue modal is open (its own ↑/↓ shortcut takes over scoring there —
  // see ClueModal — so the two never fight over the same keys).
  useEffect(() => {
    if (editMode || activeClue) setSelectedScoreTeamId(null);
  }, [editMode, activeClue]);

  // Number keys (1-9) select a team on the main scoreboard, mirroring the
  // 1-4 "arm a team" shortcut in ClueModal — press a digit to select that
  // team (by its position among the rendered team cards), then Up/Down
  // arrow keys +/- its score by SCORE_STEP. Only active when we're not in
  // edit mode, no clue modal is open (it has its own copy of this
  // shortcut), and focus isn't inside a text input (so typing in the team
  // name/score fields still works normally).
  useEffect(() => {
    const handleScoreKeyDown = (e) => {
      if (editMode || activeClue) return;
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      const teams = sessionRef.current?.data?.teams;

      const digit = Number(e.key);
      if (Number.isInteger(digit) && teams && digit >= 1 && digit <= teams.length) {
        playClickSfx();
        setSelectedScoreTeamId(teams[digit - 1].id);
        return;
      }

      if (selectedScoreTeamId == null) return;
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      const team = teams?.find((t) => t.id === selectedScoreTeamId);
      if (!team) return;
      e.preventDefault();
      if (e.key === "ArrowUp") {
        playCorrectSfx();
        adjustTeamScore(team, SCORE_STEP);
      } else {
        playIncorrectSfx();
        adjustTeamScore(team, -SCORE_STEP);
      }
    };
    window.addEventListener("keydown", handleScoreKeyDown);
    return () => window.removeEventListener("keydown", handleScoreKeyDown);
  }, [selectedScoreTeamId, editMode, activeClue]);

  /* ---------------- INIT ---------------- */
  useEffect(() => {
    (async () => {
      let index = await SessionStore.getIndex();
      let currentId = await SessionStore.getCurrentId();
      let loaded;
      if (index.length === 0) {
        loaded = await SessionStore.createSession("Session 1");
        await SessionStore.setCurrentId(loaded.id);
      } else {
        const validCurrent = currentId && index.some((e) => e.id === currentId);
        const idToLoad = validCurrent ? currentId : index.slice().sort((a, b) => b.updatedAt - a.updatedAt)[0].id;
        loaded = await SessionStore.loadSession(idToLoad);
        await SessionStore.setCurrentId(idToLoad);
      }
      migrateClueSchemaIfNeeded(loaded.data);
      ensureClueGrid(loaded.data);
      setSession(loaded);

      // Load the GLOBAL bgm settings — independent of whichever session
      // just loaded above. One-time migration: if this is the very first
      // time (no global track saved yet) but the loaded session happens to
      // have an old per-session track from before this was global, adopt
      // it so nobody's existing music silently disappears.
      let bgm = await BgmStore.load();
      const legacyBgm = loaded.data.settings.backgroundMusic;
      if (!bgm.fileRef && legacyBgm && legacyBgm.fileRef) {
        bgm = { ...bgm, ...legacyBgm };
        await BgmStore.save(bgm);
      }
      setBgmSettings(bgm);
      bgmRef.current = bgm;

      setReady(true);
    })();
  }, []);

  /* ---------------- SESSION SWITCHING ---------------- */
  async function switchToSession(id) {
    // Same per-cell stagger ripple used for round switching (see switchRound):
    // the CURRENT board flips out top-to-bottom, then — once both the flip-out
    // animation and the (async) session load have finished — the new board
    // is swapped in and flips back to idle with the same wave.
    if (boardFlip !== "idle") return;
    await flushPersist();

    const d = sessionRef.current.data;
    const rd = currentRoundOf(d);
    const maxSteps = rd.categories.length - 1; // last column's delay index (0-indexed)
    const outDuration = maxSteps * FLIP_STAGGER_MS + FLIP_CELL_MS;

    setBoardFlip("out");

    const [loaded] = await Promise.all([
      SessionStore.loadSession(id),
      new Promise((resolve) => {
        const t = setTimeout(resolve, outDuration);
        boardFlipTimeouts.current.push(t);
      }),
    ]);

    if (!loaded) {
      setBoardFlip("idle");
      return;
    }
    migrateClueSchemaIfNeeded(loaded.data);
    ensureClueGrid(loaded.data);
    await SessionStore.setCurrentId(id);
    setEditMode(false);
    setActiveClue(null);
    setEditingTarget(null);
    setRevealedCats(new Set());
    setSession(loaded);
    setBoardFlip("in-start"); // instant jump to the opposite edge-on angle, no transition
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setBoardFlip("in"); // transition back to flat, same left-to-right stagger
        const tIdle = setTimeout(() => setBoardFlip("idle"), outDuration); // pop finished — safe to clear the lingering delay now
        boardFlipTimeouts.current.push(tIdle);
      });
    });
  }
  async function createAndSwitchToNewSession(name) {
    if (boardFlip !== "idle") return;
    await flushPersist();

    const d = sessionRef.current.data;
    const rd = currentRoundOf(d);
    const maxSteps = rd.categories.length - 1; // last column's delay index (0-indexed)
    const outDuration = maxSteps * FLIP_STAGGER_MS + FLIP_CELL_MS;

    setBoardFlip("out");

    const [created] = await Promise.all([
      SessionStore.createSession(name),
      new Promise((resolve) => {
        const t = setTimeout(resolve, outDuration);
        boardFlipTimeouts.current.push(t);
      }),
    ]);

    await SessionStore.setCurrentId(created.id);
    setEditMode(true);
    setActiveClue(null);
    setEditingTarget(null);
    setRevealedCats(new Set());
    setSession(created);
    setBoardFlip("in-start");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setBoardFlip("in");
        const tIdle = setTimeout(() => setBoardFlip("idle"), outDuration);
        boardFlipTimeouts.current.push(tIdle);
      });
    });
  }

  async function refreshSessionList() {
    const index = (await SessionStore.getIndex()).slice().sort((a, b) => b.updatedAt - a.updatedAt);
    setSessionIndex(index);
  }
  async function openSessionsModal() {
    await refreshSessionList();
    setSessionsModalOpen(true);
  }

  /* ---------------- SESSIONS MODAL HANDLERS ---------------- */
  async function handleRenameSessionCommit(meta, newName) {
    const full = await SessionStore.loadSession(meta.id);
    if (full) {
      full.name = newName || "Untitled Session";
      await SessionStore.saveSession(full);
      if (session.id === meta.id) {
        const s = sessionRef.current;
        s.name = full.name;
        touch();
      }
      refreshSessionList();
    }
  }
  async function handleLoadSession(id) {
    await switchToSession(id);
    setSessionsModalOpen(false);
  }
  async function handleDuplicateSession(id, newName) {
    const copy = await SessionStore.duplicateSession(id, newName);
    if (copy) refreshSessionList();
  }
  async function handleDeleteSession(id, name) {
    if (!(await appConfirm('Delete session "' + name + '"? This cannot be undone.'))) return;
    await SessionStore.deleteSession(id);
    if (session.id === id) {
      const remaining = await SessionStore.getIndex();
      if (remaining.length > 0) await switchToSession(remaining[0].id);
      else await createAndSwitchToNewSession("Session 1");
    }
    refreshSessionList();
  }
  async function handleCreateNewSession() {
    const index = await SessionStore.getIndex();
    await createAndSwitchToNewSession("Session " + (index.length + 1));
    setSessionsModalOpen(false);
  }

  /* ---------------- CATEGORY / ROW ACTIONS ---------------- */
  function ensureClueGrid(d) {
    // Fills in any missing category×row combos, for every round. Only
    // called after a structural change (add/remove/load) — never during render.
    d.rounds.forEach((round) => {
      round.categories.forEach((cat) => {
        round.values.forEach((v) => {
          if (!cat.clues[v]) cat.clues[v] = blankClue();
        });
      });
    });
  }
  // Every category/row/clue action below operates on THIS round only —
  // the other round's categories, values, and clues are untouched.
  function currentRoundOf(d) {
    return d.rounds[d.currentRound];
  }

  function switchRound(idx) {
    const d = sessionRef.current.data;
    if (idx === d.currentRound || !d.rounds[idx] || boardFlip !== "idle" || roundBanner) return;
    const rd = currentRoundOf(d);
    const maxSteps = rd.categories.length - 1; // last column's delay index (0-indexed, the farthest column)
    const outDuration = maxSteps * FLIP_STAGGER_MS + FLIP_CELL_MS;

    // Announce the incoming round first — banner pops in immediately, then
    // once it's held on screen for a beat, it starts fading out at the
    // exact moment the board flip kicks off, so the two hand off cleanly.
    setRoundBanner({ text: (d.rounds[idx].name || "ROUND") + "!", phase: "in" });

    const tBanner = setTimeout(() => {
      setRoundBanner((b) => (b ? { ...b, phase: "out" } : b));
      setBoardFlip("out");
      const t = setTimeout(() => {
        d.currentRound = idx;
        // Close any open modals — they reference category ids scoped to the
        // round that was active when they were opened.
        setActiveClue(null);
        setEditingTarget(null);
        touch();
        persist();
        setBoardFlip("in-start"); // instant jump to the opposite edge-on angle, no transition
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            setBoardFlip("in"); // transition back to flat, same left-to-right stagger
            const tIdle = setTimeout(() => setBoardFlip("idle"), outDuration); // pop finished — safe to clear the lingering delay now
            boardFlipTimeouts.current.push(tIdle);
          });
        });
      }, outDuration);
      boardFlipTimeouts.current.push(t);

      const tClear = setTimeout(() => setRoundBanner(null), BANNER_FADE_MS);
      boardFlipTimeouts.current.push(tClear);
    }, BANNER_HOLD_MS);
    boardFlipTimeouts.current.push(tBanner);
  }

  function renameCategory(cat, name) {
    cat.name = name || "Category";
    persist();
  }
  async function removeCategory(cat) {
    const d = sessionRef.current.data;
    const rd = currentRoundOf(d);
    if (rd.categories.length <= 1) {
      appAlert("You must keep at least one column category!");
      return;
    }
    if (await appConfirm(`Delete column "${cat.name || "Category"}" and all its contained clues?`)) {
      rd.categories = rd.categories.filter((c) => c.id !== cat.id);
      touch();
      persist();
    }
  }
  function addCategory() {
    const d = sessionRef.current.data;
    const rd = currentRoundOf(d);
    rd.categories.push(blankCategory("New Category", rd.values));
    ensureClueGrid(d);
    touch();
    persist();
  }

  function changeRowValue(oldVal, input) {
    const d = sessionRef.current.data;
    const rd = currentRoundOf(d);
    const newVal = parseInt(input, 10);
    if (isNaN(newVal) || newVal <= 0 || rd.values.includes(newVal)) {
      touch(); // revert silently, no popup needed for a simple field edit
      return;
    }
    const oldIndex = rd.values.indexOf(oldVal);
    rd.values[oldIndex] = newVal;
    rd.categories.forEach((c) => {
      if (c.clues[oldVal]) {
        c.clues[newVal] = c.clues[oldVal];
        delete c.clues[oldVal];
      }
    });
    rd.values.sort((a, b) => a - b);
    touch();
    persist();
  }
  async function removeRow(v) {
    const d = sessionRef.current.data;
    const rd = currentRoundOf(d);
    if (rd.values.length <= 1) {
      appAlert("You must keep at least one row!");
      return;
    }
    if (await appConfirm(`Remove the entire $${v} row? All clue data inside it across columns will be lost.`)) {
      rd.values = rd.values.filter((val) => val !== v);
      rd.categories.forEach((c) => {
        delete c.clues[v];
      });
      touch();
      persist();
    }
  }
  function addRow() {
    const d = sessionRef.current.data;
    const rd = currentRoundOf(d);
    let nextVal = 100;
    if (rd.values && rd.values.length > 0) nextVal = Math.max(...rd.values) + 100;
    while (rd.values.includes(nextVal)) nextVal += 100;
    rd.values.push(nextVal);
    rd.values.sort((a, b) => a - b);
    rd.categories.forEach((c) => {
      c.clues[nextVal] = blankClue();
    });
    ensureClueGrid(d);
    touch();
    persist();
  }

  /* ---------------- TEAM ACTIONS ---------------- */
  function renameTeam(team, name) {
    team.name = name || "Team";
    persist();
  }
  function adjustTeamScore(team, delta) {
    team.score += delta;
    firePulse(team.id, delta >= 0 ? "pulse-up" : "pulse-down");
    touch();
    persist();
  }
  function setTeamScore(team, rawValue) {
    const parsed = parseInt(rawValue, 10);
    const newScore = Number.isNaN(parsed) ? 0 : parsed;
    if (newScore !== team.score) firePulse(team.id, newScore > team.score ? "pulse-up" : "pulse-down");
    team.score = newScore;
    touch();
    persist();
  }
  function addTeam() {
    const d = sessionRef.current.data;
    d.teams.push({ id: "t_" + Math.random().toString(36).slice(2, 9), name: "Team " + (d.teams.length + 1), score: 0 });
    touch();
    persist();
  }
  function removeTeam(team) {
    const d = sessionRef.current.data;
    d.teams = d.teams.filter((t) => t.id !== team.id);
    touch();
    persist();
  }
  function applyTeamOrder(orderedTeams) {
    const d = sessionRef.current.data;
    d.teams = orderedTeams;
    touch();
    persist();
    setView("board");
  }

  /* ---------------- CLUE PLAY MODAL ---------------- */
  function openClueModal(cat, value) {
    setActiveClue({ catId: cat.id, value });
    setRevealed(false);
  }
  function closeClueModal(markUsed) {
    if (markUsed && activeClue) {
      const d = sessionRef.current.data;
      const cat = currentRoundOf(d).categories.find((c) => c.id === activeClue.catId);
      if (cat) cat.clues[activeClue.value].used = true;
      touch();
      persist();
    }
    setActiveClue(null);
    setDuckMusic(false);
  }

  /* ---------------- CLUE EDIT MODAL ---------------- */
  function openEditModal(cat, value) {
    const clue = cat.clues[value];
    setEditingTarget({ catId: cat.id, value });
    setEditForm({
      question: clue.question || "",
      answer: clue.answer || "",
      timerSeconds: clue.timerSeconds != null ? String(clue.timerSeconds) : "",
    });
    const existing = clue.mediaUrl || "";
    const media =
      isMediaRef(existing) || isDataUrl(existing)
        ? { mode: "file", url: "", fileRef: existing, fileName: "File attached (from earlier) — remove to replace", fileType: clue.mediaType || "" }
        : { mode: "url", url: existing, fileRef: "", fileName: "", fileType: "" };
    const existingAnswer = clue.answerMediaUrl || "";
    const answerMedia =
      isMediaRef(existingAnswer) || isDataUrl(existingAnswer)
        ? { mode: "file", url: "", fileRef: existingAnswer, fileName: "File attached (from earlier) — remove to replace", fileType: clue.answerMediaType || "" }
        : { mode: "url", url: existingAnswer, fileRef: "", fileName: "", fileType: "" };
    setMediaState({ media, answerMedia });
  }
  function closeEditModal() {
    setEditingTarget(null);
  }
  async function handleMediaFile(type, file) {
    if (!file) return;
    // IndexedDB comfortably handles much larger files than the old base64/localStorage
    // approach did — this warning is now just a courtesy for very large uploads.
    const proceed =
      file.size < 50 * 1024 * 1024 ||
      (await appConfirm(`"${file.name}" is ${humanSize(file.size)}. That's a large file — it may take a moment to store. Use it anyway?`));
    if (!proceed) return;
    try {
      const ref = await MediaStore.put(file);
      const fileType = detectMediaTypeFromFile(file);
      setMediaState((prev) => ({
        ...prev,
        [type]: { mode: "file", url: "", fileRef: ref, fileName: `📎 ${file.name} (${humanSize(file.size)})`, fileType },
      }));
    } catch (e) {
      appAlert("Could not store that file — your browser may be blocking local storage (e.g. private browsing mode).");
    }
  }
  function clearMediaField(type) {
    setMediaState((prev) => ({ ...prev, [type]: { mode: "url", url: "", fileRef: "", fileName: "", fileType: "" } }));
  }
  function saveClue() {
    if (!editingTarget) return;
    const d = sessionRef.current.data;
    const cat = currentRoundOf(d).categories.find((c) => c.id === editingTarget.catId);
    if (cat) {
      const clue = cat.clues[editingTarget.value];
      clue.question = editForm.question.trim();
      clue.answer = editForm.answer.trim();
      const parsedTimer = parseInt(editForm.timerSeconds, 10);
      clue.timerSeconds = editForm.timerSeconds.trim() === "" || isNaN(parsedTimer) || parsedTimer <= 0 ? null : parsedTimer;
      const m = mediaState.media;
      if (m.mode === "file") {
        clue.mediaUrl = m.fileRef;
        clue.mediaType = m.fileType || "";
      } else {
        const url = m.url.trim();
        clue.mediaUrl = url;
        clue.mediaType = url ? detectMediaTypeFromUrl(url) : "";
      }
      const am = mediaState.answerMedia;
      if (am.mode === "file") {
        clue.answerMediaUrl = am.fileRef;
        clue.answerMediaType = am.fileType || "";
      } else {
        const answerUrl = am.url.trim();
        clue.answerMediaUrl = answerUrl;
        clue.answerMediaType = answerUrl ? detectMediaTypeFromUrl(answerUrl) : "";
      }
      touch();
      persist();
    }
    setEditingTarget(null);
  }

  /* ---------------- TIMER SETTINGS ---------------- */
  function toggleTimerEnabled() {
    const d = sessionRef.current.data;
    d.settings.timerEnabled = !d.settings.timerEnabled;
    touch();
    persist();
  }
  function setGlobalTimerDuration(rawValue) {
    const d = sessionRef.current.data;
    const parsed = parseInt(rawValue, 10);
    d.settings.timerDuration = isNaN(parsed) || parsed <= 0 ? d.settings.timerDuration : parsed;
    touch();
    persist();
  }

  /* ---------------- BACKGROUND MUSIC (global — not per-session) ---------------- */
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
    updateBgm({ fileRef: "", fileName: "" });
  }
  function setBgmVolume(volume) {
    updateBgm({ volume });
  }
  function toggleBgmLoop() {
    updateBgm({ loop: !bgmRef.current.loop });
  }
  function setBgmSource(source) {
    updateBgm({ source });
  }
  function setBgmSpotifyUrl(url) {
    updateBgm({ spotifyUrl: url });
  }

  /* ---------------- RESET ROUND ---------------- */
  async function resetRound() {
    if (!(await appConfirm("Reset all scores to 0 and mark all clues unused (both rounds)? Your questions/answers/media stay."))) return;
    const d = sessionRef.current.data;
    d.rounds.forEach((round) => {
      round.categories.forEach((cat) => {
        round.values.forEach((v) => {
          if (cat.clues[v]) cat.clues[v].used = false;
        });
      });
    });
    d.teams.forEach((t) => (t.score = 0));
    setRevealedCats(new Set());
    touch();
    persist();
  }

  if (!ready || !data) {
    return (
      <div className="jp-root" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={{ color: "var(--text-dim)", fontSize: 13 }}>Loading board…</div>
      </div>
    );
  }

  const rd = data.rounds[data.currentRound];
  const nCats = rd.categories.length;
  const nRows = rd.values.length;
  const boardGridStyle = editMode
    ? { gridTemplateColumns: `74px repeat(${nCats}, minmax(0, 1fr)) 67px`, gridTemplateRows: `74px repeat(${nRows}, minmax(0, 1fr)) 67px` }
    : { gridTemplateColumns: `repeat(${nCats}, minmax(0, 1fr))`, gridTemplateRows: `auto repeat(${nRows}, minmax(0, 1fr))` };

  const activeCat = activeClue ? rd.categories.find((c) => c.id === activeClue.catId) : null;
  const activeClueObj = activeCat && activeClue ? activeCat.clues[activeClue.value] : null;

  const editingCat = editingTarget ? rd.categories.find((c) => c.id === editingTarget.catId) : null;

  return (
    <div className="jp-root">
      {view === "randomizer" ? (
        <TeamRandomizer teams={data.teams} onApplyOrder={applyTeamOrder} onClose={() => setView("board")} />
      ) : (
        <>
      <div className={"marquee" + (editMode ? " editing" : "")}>
        {editMode ? null : <MarqueeBulbs />}
        <input
          className="marquee-title"
          maxLength={40}
          disabled={!editMode}
          defaultValue={data.title}
          key={"title-" + session.id}
          onBlur={(e) => {
            data.title = e.target.value || "GAME NIGHT";
            persist();
          }}
        />
      </div>
      <div className="session-bar">
        Session: <b>{session.name}</b> · last saved {formatDate(session.updatedAt)}
      </div>

      <div className="round-tabs">
        {data.rounds.map((round, i) => (
          <button
            key={i}
            className={"round-tab" + (data.currentRound === i ? " active" : "")}
            onClick={() => switchRound(i)}
          >
            {round.name}
          </button>
        ))}
      </div>

      {roundBanner && (
        <div className={"round-banner" + (roundBanner.phase === "out" ? " round-banner-out" : "")}>
          <MarqueeBulbs spacing={16} inset={7} radius={12} />
          <div className="round-banner-text">{roundBanner.text}</div>
        </div>
      )}

      <div className="toolbar">
        <button className="btn" onClick={() => setEditMode((v) => !v)}>
          {editMode ? "✓ Done Editing" : "✎ Edit Board"}
        </button>
        <button className="btn" onClick={openSessionsModal}>
          ⏱ Sessions
        </button>
        <button className="btn" onClick={() => setView("randomizer")}>
          Randomize Order
        </button>
        <button className="btn" onClick={resetRound}>
          ↺ Reset Round (keep content)
        </button>
      </div>
      <div className="edit-banner">
        {editMode ? "EDIT MODE — click any cell to edit its clue, edit headers, or add/delete rows and columns" : ""}
      </div>

      {editMode && (
        <div className="timer-settings-bar">
          <label>
            <input type="checkbox" checked={data.settings.timerEnabled} onChange={toggleTimerEnabled} />
            Answer timer
          </label>
          <label>
            Default:
            <input
              type="number"
              min="1"
              disabled={!data.settings.timerEnabled}
              defaultValue={data.settings.timerDuration}
              key={"timer-default-" + session.id}
              onBlur={(e) => setGlobalTimerDuration(e.target.value)}
              onWheel={(e) => e.target.blur()}
            />
            sec
          </label>
        </div>
      )}

      <div id="boardWrap">
        <div id="board" style={boardGridStyle}>
          {rd.categories.map((cat, catIndex) => {
            const isRevealed = editMode || revealedCats.has(cat.id);
            return (
              <div
                key={cat.id}
                className={
                  "cat-cell" +
                  (boardFlip === "out" ? " flip-out" : "") +
                  (boardFlip === "in-start" ? " flip-in-start" : "") +
                  (!isRevealed ? " cat-locked" : "")
                }
                style={{
                  gridRow: "1",
                  gridColumn: editMode ? catIndex + 2 : catIndex + 1,
                  transitionDelay: flipDelay(catIndex),
                }}
              >
                {editMode ? (
                  <>
                    <input
                      className="cat-name-input"
                      maxLength={30}
                      defaultValue={cat.name}
                      key={cat.id + "-name"}
                      onBlur={(e) => renameCategory(cat, e.target.value)}
                    />
                    <button className="cat-remove" title="Remove this category" onClick={() => removeCategory(cat)}>
                      ✕
                    </button>
                  </>
                ) : isRevealed ? (
                  <div className="cat-name cat-name-reveal">{cat.name}</div>
                ) : (
                  <button className="cat-reveal-btn" title="Click to reveal this category" onClick={() => revealCategory(cat)}>
                    <span className="cat-reveal-mark">?</span>
                  </button>
                )}
              </div>
            );
          })}

          {editMode && (
            <div className="grid-add-column-cell" style={{ gridColumn: nCats + 2, gridRow: `1 / span ${nRows + 1}` }}>
              <button title="Add Category Column" onClick={addCategory}>
                +
              </button>
            </div>
          )}

          {rd.values.map((v, rowIndex) => {
            const gridRowPosition = rowIndex + 2;
            return (
              <React.Fragment key={v}>
                {editMode && (
                  <div className="row-control-cell" style={{ gridRow: gridRowPosition, gridColumn: 1 }}>
                    <input
                      className="row-value-input"
                      type="number"
                      min="1"
                      defaultValue={v}
                      key={v + "-value"}
                      title="Point value for this row"
                      onBlur={(e) => changeRowValue(v, e.target.value)}
                      onWheel={(e) => e.target.blur()}
                    />
                    <button className="row-delete-btn" title="Delete this row value pattern" onClick={() => removeRow(v)}>
                      <span className="icon">✕</span>
                    </button>
                  </div>
                )}

                {rd.categories.map((cat, catIndex) => {
                  const clue = cat.clues[v] || blankClue();
                  const cellKey = cat.id + "-" + v;
                  return (
                    <div
                      key={cellKey}
                      className={
                        "clue-cell" +
                        (clue.used ? " used" : "") +
                        (editMode ? " edit-mode-cell" : "") +
                        (boardFlip === "out" ? " flip-out" : "") +
                        (boardFlip === "in-start" ? " flip-in-start" : "") +
                        (editMode && dragSource && dragSource.catId === cat.id && dragSource.value === v ? " drag-source" : "") +
                        (editMode && dragOverKey === cellKey && !(dragSource && dragSource.catId === cat.id && dragSource.value === v)
                          ? " drag-over"
                          : "")
                      }
                      style={{
                        gridRow: gridRowPosition,
                        gridColumn: editMode ? catIndex + 2 : catIndex + 1,
                        transitionDelay: flipDelay(catIndex),
                      }}
                      draggable={editMode}
                      onDragStart={(e) => {
                        if (!editMode) return;
                        setDragSource({ catId: cat.id, value: v });
                        e.dataTransfer.effectAllowed = "move";
                        e.dataTransfer.setData("text/plain", cellKey); // Firefox requires data to be set for drag to start
                      }}
                      onDragOver={(e) => {
                        if (!editMode || !dragSource) return;
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        if (dragOverKey !== cellKey) setDragOverKey(cellKey);
                      }}
                      onDragLeave={() => {
                        setDragOverKey((k) => (k === cellKey ? null : k));
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        if (!editMode || !dragSource) return;
                        swapClueCells(dragSource, { catId: cat.id, value: v });
                        setDragSource(null);
                        setDragOverKey(null);
                      }}
                      onDragEnd={() => {
                        setDragSource(null);
                        setDragOverKey(null);
                      }}
                      onClick={() => {
                        if (editMode) {
                          playClickSfx();
                          openEditModal(cat, v);
                        } else if (!clue.used) {
                          playClickSfx();
                          openClueModal(cat, v);
                        }
                      }}
                      onMouseEnter={() => {
                        if (editMode || !clue.used) playHoverTick();
                      }}
                    >
                      <div className="clue-value">${v}</div>
                      {editMode && 
                      clue.question?.trim() && 
                      clue.answer?.trim() && (
                        <div className={`media-dot ${clue.mediaUrl ? "has-media" : ""}`}>●</div>
                      )}
                    </div>
                  );
                })}
              </React.Fragment>
            );
          })}

          {editMode && (
            <div className="grid-add-row-cell" style={{ gridColumn: `1 / span ${nCats + 1}`, gridRow: nRows + 2 }}>
              <button title="Add Value Row" onClick={addRow}>
                +
              </button>
            </div>
          )}
        </div>
      </div>

      <div id="teamsWrap">
        {data.teams.map((team) => (
          <div
            key={team.id}
            className={
              "team-card" +
              (!editMode && selectedScoreTeamId === team.id ? " kb-selected" : "")
            }
            role={editMode ? undefined : "button"}
            tabIndex={editMode ? undefined : 0}
            title={editMode ? undefined : `Select (or press ${data.teams.indexOf(team) + 1}), then use ↑ / ↓ to adjust score`}
            aria-label={editMode ? undefined : `Select ${team.name}'s score to adjust with arrow keys, or press ${data.teams.indexOf(team) + 1}`}
            onClick={() => {
              if (editMode) return;
              setSelectedScoreTeamId((id) => (id === team.id ? null : team.id));
            }}
          >
            {editMode && (
              <button className="team-remove" title="Remove this team" onClick={() => removeTeam(team)}>
                ✕
              </button>
            )}
            {editMode ? (
               <input
                className="team-name-input"
                disabled={!editMode}
                defaultValue={team.name}
                key={team.id + "-name"}
                onBlur={(e) => renameTeam(team, e.target.value)}
              />
            ) : (
              <div className="team-name-display">{team.name}</div>
            )}
            <div className="team-score-row">
              {editMode ? (
                <input
                  className="team-score-display team-score-input"
                  type="number"
                  defaultValue={team.score}
                  key={team.id + "-score"}
                  title="Set this team's score manually"
                  onBlur={(e) => setTeamScore(team, e.target.value)}
                  onWheel={(e) => e.target.blur()}
                />
              ) : (
                <div
                  className={
                    "team-score-display" +
                    (scorePulse[team.id] ? " " + scorePulse[team.id] : "") +
                    (selectedScoreTeamId === team.id ? " kb-selected" : "")
                  }
                >
                  ${team.score}
                </div>
              )}
            </div>
          </div>
        ))}
        {editMode && (
          <div className="team-add-card">
            <button title="Add Team" onClick={addTeam}>
              +
            </button>
          </div>
        )}
      </div>

      <div className="save-indicator">{saveMsg || "\u00A0"}</div>

      {activeClue && activeCat && activeClueObj && (
        <ClueModal
          activeCat={activeCat}
          value={activeClue.value}
          clue={activeClueObj}
          teams={data.teams}
          revealed={revealed}
          onToggleReveal={() => setRevealed((r) => !r)}
          onClose={closeClueModal}
          onAdjustTeamScore={adjustTeamScore}
          timerEnabled={data.settings.timerEnabled}
          timerSeconds={activeClueObj.timerSeconds != null ? activeClueObj.timerSeconds : data.settings.timerDuration}
          onDuckMusic={setDuckMusic}
        />
      )}

      {editingTarget && editingCat && (
        <EditClueModal
          editForm={editForm}
          setEditForm={setEditForm}
          mediaState={mediaState}
          setMediaState={setMediaState}
          onMediaFile={handleMediaFile}
          onClearMedia={clearMediaField}
          onSave={saveClue}
          onClose={closeEditModal}
          defaultTimerSeconds={data.settings.timerDuration}
        />
      )}

      {sessionsModalOpen && (
        <SessionsModal
          session={session}
          sessionIndex={sessionIndex}
          onClose={() => setSessionsModalOpen(false)}
          onLoad={handleLoadSession}
          onDuplicate={handleDuplicateSession}
          onDelete={handleDeleteSession}
          onCreateNew={handleCreateNewSession}
          onRenameCommit={handleRenameSessionCommit}
        />
      )}
        </>
      )}

      <ConfirmDialog dialog={dialog} onResolve={resolveDialog} />
      {bgmSettings && (
        <BackgroundMusicPlayer
          settings={bgmSettings}
          onUploadFile={handleBgmUpload}
          onClear={clearBgm}
          onVolumeChange={setBgmVolume}
          onToggleLoop={toggleBgmLoop}
          onSetSource={setBgmSource}
          onSetSpotifyUrl={setBgmSpotifyUrl}
          ducking={duckMusic}
        />
      )}
      <DiscordOverlay />
    </div>
  );
}