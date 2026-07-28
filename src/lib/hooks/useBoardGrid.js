import { useState, useRef, useEffect } from "react";
import { blankClue, blankCategory } from "../storage";

/* =========================================================================
   useBoardGrid
   Owns everything about the CURRENT round's grid: categories, row values,
   clue swapping, category reveal state, and the flip transition used both
   for round-switching (here) and session-switching (useSessionManager,
   which calls `performFlip` below rather than owning its own copy of this
   animation).

   Does NOT own: teams, clue-modal state, session state. Those come in as
   `sessionRef` / `touch` / `persist`, supplied by the orchestrator.
   ========================================================================= */
export function useBoardGrid({ sessionRef, touch, persist, appConfirm, appAlert }) {
  /* ---------------- FLIP TRANSITION ----------------
     Each category header + clue cell animates individually (not the board
     as one piece) as a scale + fade ripple, left to right: "idle" -> "out"
     (every column shrinks to 40% size and fades to transparent, each
     column starting slightly later than the column to its left) -> swap
     the actual data -> "in-start" (every cell jumps instantly back to
     40%/transparent, no transition) -> "idle" (pops back to full size and
     opacity with a slight overshoot bounce, same left-to-right stagger,
     revealing the new data). Still just per-cell CSS transform + opacity —
     GPU composited — so it stays smooth regardless of grid size. */
  const [boardFlip, setBoardFlip] = useState("idle"); // "idle" | "out" | "in-start" | "in"
  const boardFlipTimeouts = useRef([]);
  const FLIP_STAGGER_MS = 45; // delay added per column, left to right
  const FLIP_CELL_MS = 200; // must match the transition duration in board.css

  useEffect(() => {
    return () => boardFlipTimeouts.current.forEach((t) => clearTimeout(t));
  }, []);

  // catIndex: which category column this cell belongs to — every cell in
  // the SAME column shares a delay, so the whole column flips together
  // and the wave rolls left to right across the board. Only truly-idle
  // (steady state, no flip in progress) resets the delay to 0 — "in" is
  // the pop-back-in leg itself and needs to KEEP the stagger, or every
  // cell would pop back at the exact same instant.
  function flipDelay(catIndex) {
    return boardFlip === "idle" ? "0ms" : `${catIndex * FLIP_STAGGER_MS}ms`;
  }

  // Generic flip-out -> (swap data) -> flip-in choreography. Reused by
  // switchRound below AND by useSessionManager's session/session-create
  // switches, since both need the identical wave animation wrapped around
  // a different data swap. `getCatCount` reads however many columns are
  // about to be replaced (so the outgoing wave's timing matches); `swap`
  // performs the actual (possibly async) data change in between.
  async function performFlip(getCatCount, swap) {
    if (boardFlip !== "idle") return false;
    const maxSteps = getCatCount() - 1; // last column's delay index (0-indexed)
    const outDuration = maxSteps * FLIP_STAGGER_MS + FLIP_CELL_MS;

    setBoardFlip("out");
    await new Promise((resolve) => {
      const t = setTimeout(resolve, outDuration);
      boardFlipTimeouts.current.push(t);
    });

    const result = await swap();

    setBoardFlip("in-start"); // instant jump to the opposite edge-on angle, no transition
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    );
    setBoardFlip("in"); // transition back to flat, same left-to-right stagger
    const tIdle = setTimeout(() => setBoardFlip("idle"), outDuration);
    boardFlipTimeouts.current.push(tIdle);

    return result;
  }

  /* ---------------- ROUND-CHANGE BANNER ----------------
     "DOUBLE JEOPARDY!"-style announcement that pops up on a round switch,
     holds briefly, then fades out right as the board flip begins. */
  const [roundBanner, setRoundBanner] = useState(null); // { text, phase: "in" | "out" } | null
  const BANNER_HOLD_MS = 750; // how long the banner sits fully visible before fading
  const BANNER_FADE_MS = 300; // must match .round-banner-out transition in board.css

  /* ---------------- CATEGORY REVEAL ----------------
     Category headers start blank (a clickable "?") and pop-reveal one at a
     time as the host clicks each one — keyed by category id, so switching
     rounds naturally re-hides the new round's categories (different ids)
     while flipping back to an already-played round remembers what was
     already shown. Never persisted — purely a live "for the show" state. */
  const [revealedCats, setRevealedCats] = useState(() => new Set());

  /* ---------------- DRAG-TO-SWAP ----------------
     Dragging one clue cell onto another swaps their CONTENT
     (question/answer/media/timer/used) between the two grid positions —
     the $ value stays put since it's tied to the row, not the clue. */
  const [dragSource, setDragSource] = useState(null); // {catId, value}
  const [dragOverKey, setDragOverKey] = useState(null); // catId + "-" + value

  function currentRoundOf(d) {
    return d.rounds[d.currentRound];
  }

  // Fills in any missing category×row combos, for every round. Only called
  // after a structural change (add/remove/load) — never during render.
  function ensureClueGrid(d) {
    d.rounds.forEach((round) => {
      round.categories.forEach((cat) => {
        round.values.forEach((v) => {
          if (!cat.clues[v]) cat.clues[v] = blankClue();
        });
      });
    });
  }

  function revealCategory(cat, playCatRevealSfx) {
    setRevealedCats((prev) => {
      if (prev.has(cat.id)) return prev;
      const next = new Set(prev);
      next.add(cat.id);
      return next;
    });
    playCatRevealSfx();
  }

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

  // Called on round-tab click. `onBeforeSwitch` lets the orchestrator close
  // any open modals (they reference category ids scoped to the round that
  // was active when they were opened) right at the moment the data swaps.
  function switchRound(idx, onBeforeSwitch) {
    const d = sessionRef.current.data;
    if (idx === d.currentRound || !d.rounds[idx] || boardFlip !== "idle" || roundBanner) return;
    const rd = currentRoundOf(d);

    // Announce the incoming round first — banner pops in immediately, then
    // once it's held on screen for a beat, it starts fading out at the
    // exact moment the board flip kicks off, so the two hand off cleanly.
    setRoundBanner({ text: (d.rounds[idx].name || "ROUND") + "!", phase: "in" });

    const tBanner = setTimeout(() => {
      setRoundBanner((b) => (b ? { ...b, phase: "out" } : b));
      performFlip(
        () => rd.categories.length,
        () => {
          // Re-fetch here instead of reusing `d` from the top of this
          // function — up to ~1s has passed (banner hold + fade), and if
          // a remote boardUpdate arrived in that window (e.g. a second
          // host tab/window in the same room), sessionRef.current.data
          // may now point at a different object than the one we grabbed
          // on click. Mutating the stale one silently no-ops on screen.
          const liveData = sessionRef.current.data;
          liveData.currentRound = idx;
          if (onBeforeSwitch) onBeforeSwitch();
          touch();
          persist();
        }
      );
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

  // Reset all clues to unused (both rounds) — scores are reset by useTeams.
  function resetRoundClues() {
    const d = sessionRef.current.data;
    d.rounds.forEach((round) => {
      round.categories.forEach((cat) => {
        round.values.forEach((v) => {
          if (cat.clues[v]) cat.clues[v].used = false;
        });
      });
    });
    setRevealedCats(new Set());
  }

  return {
    // flip transition
    boardFlip,
    setBoardFlip,
    flipDelay,
    performFlip,
    FLIP_STAGGER_MS,
    FLIP_CELL_MS,
    boardFlipTimeouts,
    // round banner
    roundBanner,
    switchRound,
    // reveal state
    revealedCats,
    setRevealedCats,
    revealCategory,
    // drag-to-swap
    dragSource,
    setDragSource,
    dragOverKey,
    setDragOverKey,
    swapClueCells,
    // grid data helpers
    currentRoundOf,
    ensureClueGrid,
    renameCategory,
    removeCategory,
    addCategory,
    changeRowValue,
    removeRow,
    addRow,
    resetRoundClues,
  };
}