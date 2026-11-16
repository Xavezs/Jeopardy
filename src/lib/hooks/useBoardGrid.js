import { useState, useRef, useEffect } from "react";
import { blankClue, blankCategory } from "../storage";

export function useBoardGrid({ sessionRef, touch, persist, appConfirm, appAlert }) {
  // FLIP TRANSITION
  const [boardFlip, setBoardFlip] = useState("idle");
  const boardFlipTimeouts = useRef([]);
  const FLIP_STAGGER_MS = 45;
  const FLIP_CELL_MS = 200;

  useEffect(() => {
    return () => boardFlipTimeouts.current.forEach((t) => clearTimeout(t));
  }, []);

  function flipDelay(catIndex) {
    return boardFlip === "idle" ? "0ms" : `${catIndex * FLIP_STAGGER_MS}ms`;
  }

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

    setBoardFlip("in-start");
    await new Promise((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(resolve))
    );
    setBoardFlip("in");
    const tIdle = setTimeout(() => setBoardFlip("idle"), outDuration);
    boardFlipTimeouts.current.push(tIdle);

    return result;
  }

  const [roundBanner, setRoundBanner] = useState(null);
  const BANNER_HOLD_MS = 750;
  const BANNER_FADE_MS = 300;

  // CATEGORY REVEAL
  const [revealedCats, setRevealedCats] = useState(() => new Set());

  // DRAG-TO-SWAP
  const [dragSource, setDragSource] = useState(null);
  const [dragOverKey, setDragOverKey] = useState(null); // catId + "-" + value

  function currentRoundOf(d) {
    return d.rounds[d.currentRound];
  }

  function ensureClueGrid(d) {
    d.rounds.forEach((round) => {
      if (round.type === "final") return;
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
    if (rd.type === "final") return;
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

  function switchRound(idx, onBeforeSwitch) {
    const d = sessionRef.current.data;
    if (idx === d.currentRound || !d.rounds[idx] || boardFlip !== "idle" || roundBanner) return;
    const rd = currentRoundOf(d);

    // Announce the incoming round first
    setRoundBanner({ text: (d.rounds[idx].name || "ROUND") + "!", phase: "in" });

    const tBanner = setTimeout(() => {
      setRoundBanner((b) => (b ? { ...b, phase: "out" } : b));
      performFlip(
        () => (rd.type === "final" ? 1 : rd.categories.length),
        () => {
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

  // DAILY DOUBLE
  const DD_COUNT_BY_ROUND = [1, 2];

  function randomizeDailyDoubles(roundIndex = null) {
    const d = sessionRef.current.data;
    d.rounds.forEach((round, i) => {
      if (round.type === "final") return;
      if (roundIndex !== null && i !== roundIndex) return;
      const count = DD_COUNT_BY_ROUND[i] ?? 1;

      const pool = [];
      round.categories.forEach((cat) => {
        round.values.forEach((v) => {
          if (cat.clues[v]) {
            cat.clues[v].isDailyDouble = false; // reset first
            pool.push(cat.clues[v]);
          }
        });
      });
      for (let picked = 0; picked < count && pool.length > 0; picked++) {
        const idx = Math.floor(Math.random() * pool.length);
        pool[idx].isDailyDouble = true;
        pool.splice(idx, 1);
      }
    });
    touch();
    persist();
  }

  function toggleDailyDouble(cat, v) {
    const d = sessionRef.current.data;
    const rd = currentRoundOf(d);
    if (rd.type === "final") return;
    const c = rd.categories.find((c) => c.id === cat.id);
    if (!c || !c.clues[v]) return;
    c.clues[v].isDailyDouble = !c.clues[v].isDailyDouble;
    touch();
    persist();
  }

  function renameCategory(cat, name) {
    cat.name = name || "Category";
    persist();
  }
  async function removeCategory(cat) {
    const d = sessionRef.current.data;
    const rd = currentRoundOf(d);
    if (rd.type === "final") return;
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
    if (rd.type === "final") return;
    rd.categories.push(blankCategory("New Category", rd.values));
    ensureClueGrid(d);
    touch();
    persist();
  }

  function changeRowValue(oldVal, input) {
    const d = sessionRef.current.data;
    const rd = currentRoundOf(d);
    if (rd.type === "final") return;
    const newVal = parseInt(input, 10);
    if (isNaN(newVal) || newVal <= 0 || rd.values.includes(newVal)) {
      touch();
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
    if (rd.type === "final") return;
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
    if (rd.type === "final") return;
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

  function resetRoundClues() {
    const d = sessionRef.current.data;
    d.rounds.forEach((round) => {
      if (round.type === "final") {
        round.phase = "category";
        round.wagers = {};
        round.answers = {};
        round.revealOrder = [];
        round.revealedTeamIds = [];
        return;
      }
      round.categories.forEach((cat) => {
        round.values.forEach((v) => {
          if (cat.clues[v]) cat.clues[v].used = false;
        });
      });
    });
    setRevealedCats(new Set());
  }

  return {
    boardFlip,
    setBoardFlip,
    flipDelay,
    performFlip,
    FLIP_STAGGER_MS,
    FLIP_CELL_MS,
    boardFlipTimeouts,
    roundBanner,
    switchRound,
    revealedCats,
    setRevealedCats,
    revealCategory,
    dragSource,
    setDragSource,
    dragOverKey,
    setDragOverKey,
    swapClueCells,
    randomizeDailyDoubles,
    toggleDailyDouble,
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