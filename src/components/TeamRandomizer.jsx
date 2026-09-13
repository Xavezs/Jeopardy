import React, { useCallback, useEffect, useRef, useState } from "react";
import MarqueeBulbs from "../lib/MarqueeBulbs";

/* =========================================================================
   TEAM RANDOMIZER — slot machine style
   Host mode: pull the lever, get a random order, "Use This Order" applies
   it to the board and broadcasts it (see onBroadcast/onApplyOrder).
   Player mode (readOnly): no lever, no apply button. Instead this watches
   `syncedState` (the host's broadcast) and REPLAYS the same reel animation
   locally the moment `syncedState.spinning` flips true, landing on
   `syncedState.order` — never re-randomizes, so the result always matches
   the host's exactly, it just LOOKS like it's spinning independently.
   ========================================================================= */
import startSound from "../assets/slot-start.mp3";
import spinningSound from "../assets/slot-spin.mp3";
import stopSound from "../assets/slot-stop.mp3";
import winSound from "../assets/slot-win.mp3";

const CELL_HEIGHT = 92; // must match .slot-cell height in board.css
const LOOPS = 7; // how many full shuffled loops each reel scrolls through
const BASE_DURATION = 2350; // ms — first reel's spin time
const STAGGER = 400; // ms added per subsequent reel, so they stop in order

const LEVER_TRAVEL = 216; // px — must match the lever track height in board.css
const LEVER_PULL_THRESHOLD = 0.6; // fraction of travel that counts as "pulled"
const LEVER_TAP_DISTANCE = 8; // px — drags shorter than this count as a tap, not a pull

// Initialize the sound elements
const startAudio = new Audio(startSound);
const spinningAudio = new Audio(spinningSound);
const stopAudio = new Audio(stopSound);
const winAudio = new Audio(winSound);

startAudio.preload = "auto";
spinningAudio.preload = "auto";
// spinningAudio.loop is intentionally LEFT FALSE so it only plays once!
stopAudio.preload = "auto";
winAudio.preload = "auto";

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function easeOutCubic(t) {
  return 1 - Math.pow(1 - t, 3);
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Single shared AudioContext to prevent main-thread jank across playback instances
let sharedAudioCtx = null;
function getAudioCtx() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!sharedAudioCtx || sharedAudioCtx.state === "closed") {
    sharedAudioCtx = new Ctx();
  }
  if (sharedAudioCtx.state === "suspended") {
    sharedAudioCtx.resume().catch(() => {});
  }
  return sharedAudioCtx;
}

/* --- Sound Control Functions --- */
function playStartAndSpinOnce() {
  try {
    getAudioCtx();
    startAudio.currentTime = 0;
    startAudio.volume = 0.5;
    startAudio.play();
    spinningAudio.currentTime = 0;
    spinningAudio.volume = 0.4;
    spinningAudio.play();
  } catch (e) { /* blocked */ }
}

function playStop() {
  try {
    getAudioCtx();
    const clone = stopAudio.cloneNode();
    clone.volume = 0.6;
    clone.play();
  } catch (e) { /* blocked */ }
}

function playWin() {
  try {
    getAudioCtx();
    winAudio.currentTime = 0;
    winAudio.volume = 0.7;
    winAudio.play();
  } catch (e) { /* blocked */ }
}

export default function TeamRandomizer({
  teams,
  onApplyOrder,
  onClose,
  onBroadcast,        // host only — (state) => void, mirrors the spin to players
  readOnly = false,   // player mode: no lever, no back button, no apply button
  syncedState = null, // player mode: { active, spinning, order, startedAt } from the host
}) {
  const n = teams.length;
  const [spinning, setSpinning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [resultOrder, setResultOrder] = useState(null);
  const [lockedFlags, setLockedFlags] = useState([]);

  const trackRefs = useRef([]);
  const rafIds = useRef([]);
  // Guards against re-triggering the same broadcast twice (e.g. a second
  // player joining causes a re-render with the identical syncedState).
  const lastHandledStartedAt = useRef(null);

  const stopAll = () => {
    rafIds.current.forEach((id) => id && cancelAnimationFrame(id));
    rafIds.current = [];
    try {
      spinningAudio.pause();
    } catch (e) {}
  };

  const initRef = useCallback(
    (el, i) => {
      trackRefs.current[i] = el;
      if (el && !el.dataset.inited) {
        el.dataset.inited = "1";
        const mid = teams[i] || { name: "?" };
        const others = teams.filter((t) => t !== mid);
        const above = others[0] || mid;
        const below = others[1] || others[0] || mid;
        el.innerHTML = [above, mid, below].map((t) => `<div class="slot-cell">${escapeHtml(t.name)}</div>`).join("");
        el.style.transform = "translateY(0px)";
      }
    },
    [teams]
  );

  React.useEffect(() => stopAll, []);

  // Host-only: let players know the moment this screen opens, not just
  // when the lever gets pulled. Without this, `onBroadcast` never fires
  // until `spin()` runs, so a player's `randomizer` state stays null and
  // their view only switches away from the board on the FIRST spin —
  // they never see a "getting ready" screen while the host is still
  // standing at the machine. Guarded by a ref (not state) so it fires
  // exactly once per mount and never re-fires from unrelated re-renders.
  const announcedOpenRef = useRef(false);
  useEffect(() => {
    if (readOnly || !onBroadcast || announcedOpenRef.current) return;
    announcedOpenRef.current = true;
    onBroadcast({ active: true, spinning: false, order: null, startedAt: null });
  }, [readOnly, onBroadcast]);

  // Host-only: tell players to leave the randomizer view when the host
  // backs out to the board, instead of leaving their screen stuck showing
  // the slot machine (possibly mid-result) indefinitely.
  const closeAndUnannounce = useCallback(() => {
    if (!readOnly) onBroadcast?.(null);
    onClose?.();
  }, [readOnly, onBroadcast, onClose]);

  // Core reel animation — takes an already-decided `order` and plays the
  // spin-and-land sequence for it. Used by BOTH the host (with a freshly
  // shuffled order) and the player (replaying the host's broadcast order),
  // so the visuals are shared code but the order is never re-randomized on
  // the player's side.
  const runSpin = useCallback(
    (order) => {
      if (!order || order.length < 2) return;
      stopAll();
      setFinished(false);
      setResultOrder(order);
      setLockedFlags(new Array(n).fill(false));
      setSpinning(true);

      playStartAndSpinOnce();

      order.forEach((team, i) => {
        const strip = [];
        for (let l = 0; l < LOOPS; l++) strip.push(...shuffle(teams));
        strip.push(team);
        const targetIndex = strip.length - 1;
        strip.push(shuffle(teams)[0]);

        const finalTranslate = -(targetIndex - 1) * CELL_HEIGHT;
        const duration = BASE_DURATION + i * STAGGER;
        const startTime = performance.now();

        const el = trackRefs.current[i];
        if (el) {
          el.style.transition = "none";
          el.innerHTML = strip.map((t) => `<div class="slot-cell">${escapeHtml(t.name)}</div>`).join("");
        }

        function step(now) {
          const t = Math.min(1, (now - startTime) / duration);
          const eased = easeOutCubic(t);
          const translate = eased * finalTranslate;
          if (el) el.style.transform = `translateY(${translate}px)`;

          if (t < 1) {
            rafIds.current[i] = requestAnimationFrame(step);
          } else {
            if (el) el.style.transform = `translateY(${finalTranslate}px)`;
            playStop();

            setLockedFlags((prev) => {
              const next = [...prev];
              next[i] = true;
              if (next.every(Boolean)) {
                setSpinning(false);
                playWin();
              }
              return next;
            });
          }
        }
        rafIds.current[i] = requestAnimationFrame(step);
      });

      setTimeout(() => setFinished(true), BASE_DURATION + (n - 1) * STAGGER + 50);
    },
    [teams, n]
  );

  // HOST PATH: generate a fresh random order, broadcast it to players, then
  // animate locally. onBroadcast is undefined in readOnly/player mode, so
  // this never fires there even if something tried to call it.
  const spin = useCallback(() => {
    if (readOnly || n < 2 || spinning) return;
    const order = shuffle(teams);
    onBroadcast?.({ active: true, spinning: true, order, startedAt: Date.now() });
    runSpin(order);
  }, [readOnly, teams, n, spinning, onBroadcast, runSpin]);

  // PLAYER PATH: watch the host's broadcast and replay the same spin
  // locally the moment a NEW one starts (keyed on startedAt so this only
  // fires once per spin, not on every re-render with the same payload).
  // A player who joins mid-spin or after it's already finished just sees
  // the final result appear without the animation — same trade-off the
  // roundBanner sync already accepts for its one-off pop-up.
  useEffect(() => {
    if (!readOnly || !syncedState?.spinning || !syncedState.order) return;
    if (lastHandledStartedAt.current === syncedState.startedAt) return;
    lastHandledStartedAt.current = syncedState.startedAt;
    runSpin(syncedState.order);
  }, [readOnly, syncedState, runSpin]);

  // Player mode with no spin in flight yet, but a result already landed
  // (e.g. this player connected right after the host finished spinning) —
  // show the static landed reels instead of the initial idle strip.
  useEffect(() => {
    if (!readOnly || spinning || resultOrder) return;
    if (syncedState?.order && !syncedState.spinning) {
      setResultOrder(syncedState.order);
      setLockedFlags(new Array(n).fill(true));
      setFinished(true);
      syncedState.order.forEach((team, i) => {
        const el = trackRefs.current[i];
        if (el) {
          el.innerHTML = `<div class="slot-cell">${escapeHtml(team.name)}</div>`;
          el.style.transform = "translateY(0px)";
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, syncedState, n]);

  function apply() {
    if (resultOrder) onApplyOrder(resultOrder);
  }

  /* ---------------- LEVER (drag-to-spin) — host only ---------------- */
  const handleRef = useRef(null);
  const draggingRef = useRef(false);
  const startYRef = useRef(0);
  const pullPxRef = useRef(0);
  const canPull = !readOnly && n >= 2 && !spinning;

  function setHandlePx(px, withSpring) {
    const el = handleRef.current;
    if (!el) return;
    el.style.transition = withSpring ? "transform 0.45s cubic-bezier(0.34,1.56,0.64,1)" : "none";
    el.style.transform = `translateY(${px}px)`;
  }

  function onLeverPointerDown(e) {
    if (!canPull) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = true;
    startYRef.current = e.clientY;
    pullPxRef.current = 0;
    setHandlePx(0, false);
  }
  function onLeverPointerMove(e) {
    if (!draggingRef.current) return;
    const px = Math.min(LEVER_TRAVEL, Math.max(0, e.clientY - startYRef.current));
    pullPxRef.current = px;
    setHandlePx(px, false);
  }
  function onLeverPointerUp(e) {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try {
      e.currentTarget.releasePointerCapture(e.pointerId);
    } catch (err) {
      /* already released */
    }
    const px = pullPxRef.current;
    setHandlePx(0, true);
    if (px < LEVER_TAP_DISTANCE) {
      quickPull();
    } else if (px / LEVER_TRAVEL >= LEVER_PULL_THRESHOLD) {
      spin();
    }
  }
  function quickPull() {
    if (!canPull) return;
    setHandlePx(LEVER_TRAVEL, false);
    setTimeout(() => {
      spin();
      setHandlePx(0, true);
    }, 140);
  }
  function onLeverKeyDown(e) {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      quickPull();
    }
  }

  return (
    <div className="randomizer-page">
      {!readOnly && (
        <button className="jp-role-back-btn randomizer-back" onClick={closeAndUnannounce}>
          ← Back to Board
        </button>
      )}

      <div className="randomizer-body">
        <div className="randomizer-title">Randomizer Order</div>

        {n < 2 ? (
          <div className="randomizer-empty">Add at least 2 teams on the board before spinning.</div>
        ) : (
          <>
            <div className="slot-machine">
              <MarqueeBulbs inset={9} radius={18} />
              {teams.map((team, i) => (
                <div className="slot-reel-col" key={team.id}>
                  <div className="slot-position-label">{ordinal(i + 1)}</div>
                  <div
                    className={
                      "slot-reel" +
                      (spinning && !lockedFlags[i] ? " is-spinning" : "") +
                      (lockedFlags[i] ? " is-locked" : "")
                    }
                  >
                    <div className="slot-reel-window">
                      <div className="slot-reel-track" ref={(el) => initRef(el, i)} />
                    </div>
                    <div className="slot-reel-shine" />
                  </div>
                </div>
              ))}

              {!readOnly && (
                <div className="lever-col">
                  <div className={"lever-track" + (canPull ? "" : " disabled")}>
                    <div
                      className="lever-handle"
                      ref={handleRef}
                      role="button"
                      tabIndex={0}
                      aria-label="Pull lever to spin"
                      onPointerDown={onLeverPointerDown}
                      onPointerMove={onLeverPointerMove}
                      onPointerUp={onLeverPointerUp}
                      onPointerCancel={onLeverPointerUp}
                      onKeyDown={onLeverKeyDown}
                    />
                  </div>
                  <div className="lever-base" />
                </div>
              )}
            </div>

            {!readOnly && (
              <div className="randomizer-actions">
                {finished && !spinning && (
                  <button className="btn gold big" onClick={apply}>
                    ✓ Use This Order
                  </button>
                )}
              </div>
            )}

            {finished && !spinning && resultOrder && (
              <div className="randomizer-result">
                <span className="randomizer-result-team">{resultOrder[0].name}</span> goes first!
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}