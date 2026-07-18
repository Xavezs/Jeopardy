import React, { useCallback, useRef, useState } from "react";
import MarqueeBulbs from "../lib/MarqueeBulbs";

/* =========================================================================
   TEAM RANDOMIZER — slot machine style
   One reel per turn position. Hitting Spin picks a random order and spins
   each reel through a shuffled strip of team names, landing on the result
   left-to-right (reel 1 = "goes first"). Reels lock one at a time to build
   suspense, then "Use This Order" writes the result back into data.teams
   so the team cards on the board itself re-render in that left-to-right
   order.
   ========================================================================= */
import startSound from "../assets/slot-start.mp3";
import spinningSound from "../assets/slot-spin.mp3"; 
import stopSound from "../assets/slot-stop.mp3";
import winSound from "../assets/slot-win.mp3";

const CELL_HEIGHT = 72; // must match .slot-cell height in board.css
const LOOPS = 7; // how many full shuffled loops each reel scrolls through
const BASE_DURATION = 2350; // ms — first reel's spin time
const STAGGER = 400; // ms added per subsequent reel, so they stop in order

const LEVER_TRAVEL = 168; // px — must match the lever track height in board.css
const LEVER_PULL_THRESHOLD = 0.6; // fraction of travel that counts as "pulled"
const LEVER_TAP_DISTANCE = 8; // px — drags shorter than this count as a tap, not a pull

// Initialize the sound elements
const startAudio = new Audio(startSound);
const spinningAudio = new Audio(spinningSound); // 
const stopAudio = new Audio(stopSound);
const winAudio = new Audio(winSound);

startAudio.preload = "auto";
spinningAudio.preload = "auto"; // 
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
// Combined start and spin into a single function to fire them once simultaneously
function playStartAndSpinOnce() {
  try {
    getAudioCtx();
    
    // Play start click sound once
    startAudio.currentTime = 0;
    startAudio.volume = 0.5;
    startAudio.play();

    // Play spinning sound once (will play through and stop naturally)
    spinningAudio.currentTime = 0;
    spinningAudio.volume = 0.4;
    spinningAudio.play();
  } catch (e) { /* blocked */ }
}

function playStop() {
  try {
    getAudioCtx();
    // Clone stop node so staggered stopped reels don't clip each other's playback
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

export default function TeamRandomizer({ teams, onApplyOrder, onClose }) {
  const n = teams.length;
  const [spinning, setSpinning] = useState(false);
  const [finished, setFinished] = useState(false);
  const [resultOrder, setResultOrder] = useState(null);
  const [lockedFlags, setLockedFlags] = useState([]);

  const trackRefs = useRef([]);
  const rafIds = useRef([]);

  const stopAll = () => {
    rafIds.current.forEach((id) => id && cancelAnimationFrame(id));
    rafIds.current = [];
    // Pause spinning if it's interrupted
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

  const spin = useCallback(() => {
    if (n < 2 || spinning) return;
    stopAll();
    setFinished(false);
    const order = shuffle(teams);
    setResultOrder(order);
    setLockedFlags(new Array(n).fill(false));
    setSpinning(true);

    // Plays both start & spin audio files exactly once
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
          
          // Reel Stopped: Play Stop sound cue
          playStop();

          setLockedFlags((prev) => {
            const next = [...prev];
            next[i] = true;
            
            // All Locked: Trigger the final Win Sound
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
  }, [teams, n, spinning]);

  function apply() {
    if (resultOrder) onApplyOrder(resultOrder);
  }

  /* ---------------- LEVER (drag-to-spin) ---------------- */
  const handleRef = useRef(null);
  const draggingRef = useRef(false);
  const startYRef = useRef(0);
  const pullPxRef = useRef(0);
  const canPull = n >= 2 && !spinning;

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
      <button className="btn randomizer-back" onClick={onClose}>
        ← Back to Board
      </button>

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

              <div className="lever-col">
                <div className="lever-label">{spinning ? "…" : finished ? "PULL\nAGAIN" : "PULL TO\nSPIN"}</div>
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
            </div>

            <div className="randomizer-actions">
              {finished && !spinning && (
                <button className="btn gold big" onClick={apply}>
                  ✓ Use This Order
                </button>
              )}
            </div>

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