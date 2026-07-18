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
import MarqueeBulbs from "./lib/MarqueeBulbs";
import hoverTickUrl from "./assets/hover-tick.mp3";

/* =========================================================================
   HOVER SOUND
   A short sound that plays when hovering a clickable clue cell, loaded
   from src/assets/hover-tick.mp3. One <audio> element is created once
   (module scope) and preloaded; each play clones it via cloneNode() so
   a fast mouse-sweep across several cells doesn't cut a still-playing
   sound short — overlapping clones just play independently and get
   garbage collected once they finish.
   ========================================================================= */
const hoverAudioTemplate = typeof Audio !== "undefined" ? new Audio(hoverTickUrl) : null;
if (hoverAudioTemplate) {
  hoverAudioTemplate.preload = "auto";
  hoverAudioTemplate.volume = 0.4; // adjust to taste
}

let lastHoverTickAt = 0;
const HOVER_TICK_MIN_GAP_MS = 55; // guards against a rapid mouse-sweep firing a pile of overlapping plays

function playHoverTick() {
  if (!hoverAudioTemplate) return;
  const now = performance.now();
  if (now - lastHoverTickAt < HOVER_TICK_MIN_GAP_MS) return;
  lastHoverTickAt = now;
  try {
    const node = hoverAudioTemplate.cloneNode(true);
    node.volume = hoverAudioTemplate.volume;
    node.play().catch(() => {
      /* best effort — browsers may block audio before the user has interacted with the page yet */
    });
  } catch (e) {
    /* best effort — silently ignore */
  }
}

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

  const [editingTarget, setEditingTarget] = useState(null); // {catId, value}
  const [editForm, setEditForm] = useState({ question: "", answer: "", timerSeconds: "" });
  const [mediaState, setMediaState] = useState({
    media: { mode: "url", url: "", fileRef: "", fileName: "", fileType: "" },
  });

  const [sessionsModalOpen, setSessionsModalOpen] = useState(false);
  const [sessionIndex, setSessionIndex] = useState([]);

  const [dialog, setDialog] = useState(null); // {title, message, okLabel, showCancel}
  const dialogResolveRef = useRef(null);

  // { [teamId]: "pulse-up" | "pulse-down" } — cleared automatically after the animation plays
  const [scorePulse, setScorePulse] = useState({});
  const scorePulseTimeouts = useRef({});
  function firePulse(teamId, direction) {
    setScorePulse((p) => ({ ...p, [teamId]: direction }));
    clearTimeout(scorePulseTimeouts.current[teamId]);
    scorePulseTimeouts.current[teamId] = setTimeout(() => {
      setScorePulse((p) => {
        const next = { ...p };
        delete next[teamId];
        return next;
      });
    }, 500);
  }

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

  function showDialog({ title, message, okLabel, showCancel }) {
    return new Promise((resolve) => {
      dialogResolveRef.current = resolve;
      setDialog({ title, message, okLabel, showCancel });
    });
  }
  function appConfirm(message) {
    return showDialog({ title: "Are you sure?", message, okLabel: "Confirm", showCancel: true });
  }
  function appAlert(message) {
    return showDialog({ title: "Heads up", message, okLabel: "OK", showCancel: false });
  }
  function resolveDialog(val) {
    const r = dialogResolveRef.current;
    dialogResolveRef.current = null;
    setDialog(null);
    if (r) r(val);
  }

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
    setMediaState({ media });
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

  if (view === "randomizer") {
    return (
      <div className="jp-root">
        <TeamRandomizer teams={data.teams} onApplyOrder={applyTeamOrder} onClose={() => setView("board")} />
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
          {rd.categories.map((cat, catIndex) => (
            <div
              key={cat.id}
              className={"cat-cell" + (boardFlip === "out" ? " flip-out" : "") + (boardFlip === "in-start" ? " flip-in-start" : "")}
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
              ) : (
                <div className="cat-name">{cat.name}</div>
              )}
            </div>
          ))}

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
                  return (
                    <div
                      key={cat.id + "-" + v}
                      className={
                        "clue-cell" +
                        (clue.used ? " used" : "") +
                        (editMode ? " edit-mode-cell" : "") +
                        (boardFlip === "out" ? " flip-out" : "") +
                        (boardFlip === "in-start" ? " flip-in-start" : "")
                      }
                      style={{
                        gridRow: gridRowPosition,
                        gridColumn: editMode ? catIndex + 2 : catIndex + 1,
                        transitionDelay: flipDelay(catIndex),
                      }}
                      onClick={() => {
                        if (editMode) openEditModal(cat, v);
                        else if (!clue.used) openClueModal(cat, v);
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
          <div key={team.id} className="team-card">
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
              <button className="plus" onClick={() => adjustTeamScore(team, 50)}>
                +
              </button>
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
                <div className={"team-score-display" + (scorePulse[team.id] ? " " + scorePulse[team.id] : "")}>
                  ${team.score}
                </div>
              )}
              <button className="minus" onClick={() => adjustTeamScore(team, -50)}>
                -
              </button>
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

      <ConfirmDialog dialog={dialog} onResolve={resolveDialog} />
    </div>
  );
}