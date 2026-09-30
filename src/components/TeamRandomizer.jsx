import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import MarqueeBulbs from "../lib/MarqueeBulbs";
import startSound    from "../assets/slot-start.mp3";
import spinningSound from "../assets/slot-spin.mp3";
import stopSound     from "../assets/slot-stop.mp3";
import winSound      from "../assets/slot-win.mp3";
import wheelSpinSound from "../assets/spinning-wheel.mp3";

/* =========================================================================
   RANDOMIZER — two modes:
     "order"   — spin wheel (spinning-wheel.mp3 drives duration), picks who
                 goes first
     "powerup" — slot machine with lever, assigns a random power-up per team
   ========================================================================= */

/* ── Slot constants (powerup tab) ── */
const CELL_HEIGHT   = 92;
const LOOPS         = 7;
const BASE_DURATION = 2350;
const STAGGER       = 400;
const LEVER_TRAVEL         = 216;
const LEVER_PULL_THRESHOLD = 0.6;
const LEVER_TAP_DISTANCE   = 8;

/* ── Wheel constants ── */
const WHEEL_SPIN_ROTATIONS = 30; // full extra rotations before landing

/* ── Power-up catalog ── */
const POWERUPS = [
  { id: "double", label: "2x Points", desc: "Next correct answer scores double" },
  { id: "shield", label: "Shield",    desc: "Negate one wrong-answer penalty" },
  { id: "steal",  label: "Steal",     desc: "Snatch another team's clue pick" },
  { id: "freeze", label: "Freeze",    desc: "Skip an opposing team's next turn" },
  { id: "hint",   label: "Hint",      desc: "Eliminate one wrong option on a clue" },
  { id: "rebuzz", label: "Re-Buzz",   desc: "Override the buzzer queue — jump to front" },
  // Skill from the shop. NOT handed out by the random shuffle: whether a player
  // lands on it is decided by the server's per-player grantChance roll (see
  // `onPowerDraw` in PowerupSlot), which also unlocks the in-game button.
  { id: "domain", label: "Domain Expansion", desc: "Every other team loses 10% of its score (max 500). One use per game." },
];
const DOMAIN_LABEL = "Domain Expansion";
const FILLER_POWERUPS = POWERUPS.filter((p) => p.label !== DOMAIN_LABEL);

/* ── Wheel segment colours ── */
const SEGMENT_COLORS = [
  "#1c2f9e","#0f5e6e","#6b2090","#8a3020",
  "#1a6b2e","#7a6200","#1a4a8a","#5a1a5a",
];

/* ── Audio ── */
const startAudio    = new Audio(startSound);
const spinningAudio = new Audio(spinningSound);
const stopAudio     = new Audio(stopSound);
const winAudio      = new Audio(winSound);
const wheelAudio    = new Audio(wheelSpinSound);
startAudio.preload = spinningAudio.preload = stopAudio.preload =
  winAudio.preload = wheelAudio.preload = "auto";

let sharedAudioCtx = null;
function getAudioCtx() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return null;
  if (!sharedAudioCtx || sharedAudioCtx.state === "closed") sharedAudioCtx = new Ctx();
  if (sharedAudioCtx.state === "suspended") sharedAudioCtx.resume().catch(() => {});
  return sharedAudioCtx;
}

/* Slot-tab audio helpers */
function playStartAndSpinOnce() {
  try {
    getAudioCtx();
    startAudio.currentTime = 0; startAudio.volume = 0.5; startAudio.play();
    spinningAudio.currentTime = 0; spinningAudio.volume = 0.4; spinningAudio.play();
  } catch (_) {}
}
function playStop() {
  try { getAudioCtx(); const c = stopAudio.cloneNode(); c.volume = 0.6; c.play(); } catch (_) {}
}
function playWin() {
  try { getAudioCtx(); winAudio.currentTime = 0; winAudio.volume = 0.7; winAudio.play(); } catch (_) {}
}

/* ── Utilities ── */
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function easeOutCubic(t) { return 1 - Math.pow(1 - t, 3); }
function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g,
    (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

/* ── Shared slot reel engine ── */
function buildStrip(items, targetItem) {
  const strip = [];
  for (let l = 0; l < LOOPS; l++) strip.push(...shuffle(items));
  strip.push(targetItem);
  strip.push(shuffle(items)[0]);
  return strip;
}
function animateReel({ trackEl, strip, duration, onDone, cellClass = "", cellHeight = CELL_HEIGHT }) {
  const targetIndex    = strip.length - 2;
  const finalTranslate = -(targetIndex - 1) * cellHeight;
  trackEl.style.transition = "none";
  const cls = cellClass ? `slot-cell ${cellClass}` : "slot-cell";
  trackEl.innerHTML = strip.map((t) => `<div class="${cls}${t.label === DOMAIN_LABEL ? " pu-domain" : ""}">${escapeHtml(t.label)}</div>`).join("");
  const startTime = performance.now();
  let rafId = null;
  function step(now) {
    const t = Math.min(1, (now - startTime) / duration);
    trackEl.style.transform = `translateY(${easeOutCubic(t) * finalTranslate}px)`;
    if (t < 1) { rafId = requestAnimationFrame(step); }
    else { trackEl.style.transform = `translateY(${finalTranslate}px)`; onDone(); }
  }
  rafId = requestAnimationFrame(step);
  return () => { if (rafId) cancelAnimationFrame(rafId); };
}

/* ── Lever (powerup tab) ── */
function Lever({ canPull, handleRef, onPointerDown, onPointerMove, onPointerUp, onKeyDown }) {
  return (
    <div className="lever-col">
      <div className={"lever-track" + (canPull ? "" : " disabled")}>
        <div
          className="lever-handle"
          ref={handleRef}
          role="button"
          tabIndex={0}
          aria-label="Pull lever to spin"
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onKeyDown={onKeyDown}
        />
      </div>
      <div className="lever-base" />
    </div>
  );
}

/* =========================================================================
   SPIN WHEEL — SVG pie, one segment per team, pointer at top.
   Duration = however long spinning-wheel.mp3 plays. rAF drives the
   rotation with easeOutCubic over the last 30% of the audio so it
   visually decelerates before the 'ended' event snaps it to the winner.
   ========================================================================= */
function segmentPath(cx, cy, r, startAngle, endAngle) {
  const toRad = (d) => (d * Math.PI) / 180;
  const x1 = cx + r * Math.cos(toRad(startAngle));
  const y1 = cy + r * Math.sin(toRad(startAngle));
  const x2 = cx + r * Math.cos(toRad(endAngle));
  const y2 = cy + r * Math.sin(toRad(endAngle));
  const large = endAngle - startAngle > 180 ? 1 : 0;
  return `M ${cx} ${cy} L ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2} Z`;
}

function WheelSVG({ teams, rotation }) {
  const n = teams.length;
  if (n < 2) return null;
  const cx = 250, cy = 250, r = 230;
  const segAngle = 360 / n;
  return (
    <svg
      viewBox="0 0 500 500"
      className="spin-wheel-svg"
      aria-hidden="true"
      style={{ transform: `translateZ(0) rotate(${rotation}deg)` }}
    >
      <defs>
        <filter id="wh-shadow" x="-10%" y="-10%" width="120%" height="120%">
          <feDropShadow dx="0" dy="0" stdDeviation="8" floodColor="rgba(0,0,0,0.6)" />
        </filter>
        <filter id="wh-text" x="-5%" y="-5%" width="110%" height="110%">
          <feDropShadow dx="0" dy="1" stdDeviation="2" floodColor="rgba(0,0,0,0.8)" />
        </filter>
        <radialGradient id="capGrad" cx="40%" cy="35%">
          <stop offset="0%"   stopColor="#2a3aae" />
          <stop offset="100%" stopColor="#080c28" />
        </radialGradient>
      </defs>

      <circle cx={cx} cy={cy} r={r + 8} fill="none"
        stroke="rgba(240,185,66,0.5)" strokeWidth="3" filter="url(#wh-shadow)" />

      {teams.map((team, i) => {
        const startA = i * segAngle - 90;
        const endA   = startA + segAngle;
        const midA   = startA + segAngle / 2;
        const toRad  = (d) => (d * Math.PI) / 180;
        // Centre the label in the free band between the hub cap and the rim,
        // so the text is balanced instead of hugging the outer edge.
        const bandInner = 28 + 16;   // cap radius + gap
        const bandOuter = r - 14;    // rim minus padding
        const textR  = (bandInner + bandOuter) / 2;
        const tx = cx + textR * Math.cos(toRad(midA));
        const ty = cy + textR * Math.sin(toRad(midA));
        const color = SEGMENT_COLORS[i % SEGMENT_COLORS.length];
        // Shrink the font to fit the radial band; truncate only as a last resort.
        const bandLen  = bandOuter - bandInner;
        const CHAR_W   = 0.7;        // approx. Arial Black glyph width / font size
        const MIN_FONT = 11;
        let fontSize = Math.max(MIN_FONT, Math.min(20, 180 / n));
        let label = team.name;
        if (label.length * fontSize * CHAR_W > bandLen) {
          fontSize = Math.max(MIN_FONT, Math.min(fontSize, bandLen / (label.length * CHAR_W)));
        }
        const maxChars = Math.floor(bandLen / (fontSize * CHAR_W));
        if (label.length > maxChars) label = label.slice(0, Math.max(1, maxChars - 1)) + "\u2026";
        return (
          <g key={team.id}>
            <path
              d={segmentPath(cx, cy, r, startA, endA)}
              fill={color}
              stroke="rgba(240,185,66,0.35)"
              strokeWidth="1.5"
            />
            <text
              x={tx} y={ty}
              textAnchor="middle"
              dominantBaseline="middle"
              transform={`rotate(${midA}, ${tx}, ${ty})`}
              fill="#f4f1ea"
              fontFamily="'Arial Black', Impact, sans-serif"
              fontSize={fontSize}
              fontWeight="bold"
              filter="url(#wh-text)"
            >{label}</text>
          </g>
        );
      })}

      <circle cx={cx} cy={cy} r={28}
        fill="url(#capGrad)"
        stroke="rgba(240,185,66,0.6)" strokeWidth="3"
      />
    </svg>
  );
}

function SpinWheel({ teams, readOnly, syncedState, onSpun }) {
  const n = teams.length;
  const [rotation,    setRotation]    = useState(0);
  const [spinning,    setSpinning]    = useState(false);
  const [winner,      setWinner]      = useState(null);
  const [resultOrder, setResultOrder] = useState(null);
  const rafRef       = useRef(null);
  const rotationRef  = useRef(0);
  const lastStartAt  = useRef(null);

  const stopAnim = useCallback(() => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    try { wheelAudio.pause(); wheelAudio.currentTime = 0; } catch (_) {}
  }, []);
  useEffect(() => stopAnim, [stopAnim]);

  const runSpinFixed = useCallback((order) => {
    if (!order || order.length < 2) return;
    stopAnim();
    setWinner(null);
    setResultOrder(order);
    setSpinning(true);

    const targetTeam  = order[0];
    const targetIndex = teams.findIndex((t) => t.id === targetTeam.id);
    if (targetIndex < 0) { setSpinning(false); return; }

    const segAngle   = 360 / n;
    // Segments are drawn starting at (i * segAngle - 90) degrees in SVG space.
    // The centre of segment i is therefore at (i * segAngle - 90 + segAngle/2).
    // The pointer sits at the top of the container = 270° in CSS rotate space.
    // To land segment i under the pointer, rotate the wheel so that
    // segCentre aligns with 270°.
    const segCentre  = targetIndex * segAngle - 90 + segAngle / 2;
    const landing    = (270 - segCentre + 360) % 360;
    const startRot   = rotationRef.current % 360;
    const delta      = (landing - startRot + 360) % 360 || 360;
    const totalDelta = WHEEL_SPIN_ROTATIONS * 360 + delta;
    const startRaw   = rotationRef.current;
    const endRot     = startRaw + totalDelta;

    // Snap wheel to final position and mark done
    function land() {
      rotationRef.current = endRot;
      setRotation(endRot);
      setSpinning(false);
      setWinner(targetTeam);
    }

    // The wheel spins for exactly as long as the audio plays.
    // 'ended' fires when the mp3 finishes — that's when we land.
    function onEnded() {
      if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
      land();
    }

    // rAF loop — runs until onEnded cancels it.
    // Uses the audio element's currentTime so the easing mirrors the
    // actual playback position even if the audio stutters slightly.
    const startTime = performance.now();
    function step(now) {
      const audioDuration = (wheelAudio.duration && isFinite(wheelAudio.duration))
        ? wheelAudio.duration * 1000
        : 4000; // fallback if metadata not yet loaded
      const elapsed  = now - startTime;
      const rawT = Math.min(0.99, elapsed / audioDuration);
      // Single continuous curve — no piecewise join, no velocity jump.
      // easeOutQuart: starts very fast (slope 4 at t=0), decelerates
      // smoothly all the way to a dead stop at t=1.
      // f(t) = 1 - (1-t)^4
      const t = 1 - Math.pow(1 - rawT, 4);
      setRotation(startRaw + t * totalDelta);
      rafRef.current = requestAnimationFrame(step);
    }

    wheelAudio.currentTime = 0;
    wheelAudio.loop   = false;
    wheelAudio.volume = 0.7;
    wheelAudio.addEventListener("ended", onEnded, { once: true });
    wheelAudio.play().catch(() => {
      // Autoplay blocked — use a 4 s fallback with the same easing
      wheelAudio.removeEventListener("ended", onEnded);
      const fallback = 4000;
      const st = performance.now();
      function stepFallback(now) {
        const t = Math.min(1, (now - st) / fallback);
        setRotation(startRaw + easeOutCubic(t) * totalDelta);
        if (t < 1) { rafRef.current = requestAnimationFrame(stepFallback); }
        else { land(); }
      }
      rafRef.current = requestAnimationFrame(stepFallback);
      return;
    });
    rafRef.current = requestAnimationFrame(step);
  }, [teams, n, stopAnim]);

  // Host spin
  const spin = useCallback(() => {
    if (n < 2 || spinning) return;
    const order = shuffle(teams);
    onSpun?.(order, false);
    runSpinFixed(order);
  }, [teams, n, spinning, onSpun, runSpinFixed]);

  // Player replay
  useEffect(() => {
    if (!readOnly || !syncedState?.spinning || !syncedState.order) return;
    if (lastStartAt.current === syncedState.startedAt) return;
    lastStartAt.current = syncedState.startedAt;
    runSpinFixed(syncedState.order);
  }, [readOnly, syncedState, runSpinFixed]);

  // Player static landed
  useEffect(() => {
    if (!readOnly || spinning || winner) return;
    if (syncedState?.order && !syncedState.spinning) {
      const order = syncedState.order;
      setResultOrder(order);
      const w = order[0];
      setWinner(w);
      const targetIndex = teams.findIndex((t) => t.id === w.id);
      if (targetIndex >= 0) {
        const segAngle  = 360 / n;
        const segCentre = targetIndex * segAngle - 90 + segAngle / 2;
        const landing   = (270 - segCentre + 360) % 360;
        rotationRef.current = landing;
        setRotation(landing);
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, syncedState, n]);

  if (n < 2) {
    return <div className="randomizer-empty">Add at least 2 teams on the board before spinning.</div>;
  }

  return (
    <div className="spin-wheel-wrap">
      <div className="spin-wheel-container">
        <div className="spin-wheel-pointer" aria-hidden="true" />
        <WheelSVG teams={teams} rotation={rotation} />
      </div>

      {!readOnly && (
        <button
          type="button"
          className={"btn gold big spin-wheel-btn" + (spinning ? " is-spinning" : "")}
          onClick={spin}
          disabled={spinning}
        >
          {spinning ? "Spinning\u2026" : winner ? "Spin Again" : "Spin!"}
        </button>
      )}

      {winner && !spinning && (
        <div className="randomizer-result spin-wheel-result">
          <span className="randomizer-result-team">{winner.name}</span> goes first!
        </div>
      )}

      {!readOnly && resultOrder && !spinning && (
        <div className="randomizer-actions">
          <button className="btn big" onClick={() => onSpun?.(resultOrder, true)}>
            Use This Order
          </button>
        </div>
      )}
    </div>
  );
}

/* =========================================================================
   POWER-UP SLOT — redesigned:
     • One column PER PLAYER (not per team), with slotCount reels each
     • Host sees all players; player in readOnly sees only their own column
     • Host controls slotCount (1–3) via a +/- picker before spinning
     • Broadcast: playerPowerups: { [discordUserId]: string[] }, slotCount
   ========================================================================= */
function PowerupSlot({ players, myDiscordUserId, readOnly, syncedState, onSpun, onPowerDraw }) {
  const [applying, setApplying] = useState(false);
  const [slotCount,  setSlotCount]  = useState(syncedState?.slotCount ?? 1);
  const [spinning,   setSpinning]   = useState(false);
  const [finished,   setFinished]   = useState(false);
  const [resultMap,  setResultMap]  = useState(null);
  const [drawing,    setDrawing]    = useState(false); // waiting on the server's grant roll
  const [drawError,  setDrawError]  = useState(null);

  // Flat array of refs — index = playerIndex * slotCount + itemIndex
  // Stored as a plain object so we can assign by key without re-creating the ref
  const trackRefs    = useRef({});
  const cancelFns    = useRef({});
  const lastHandledAt = useRef(null);

  // Stable ref to the current visible player list so runSpin always sees
  // the latest value without needing to be in its dep array
  const visiblePlayersRef = useRef([]);
  const visiblePlayers = readOnly && myDiscordUserId
    ? players.filter((p) => p.discordUserId === myDiscordUserId)
    : players;
  visiblePlayersRef.current = visiblePlayers;

  const stopAll = useCallback(() => {
    Object.values(cancelFns.current).forEach((fn) => fn?.());
    cancelFns.current = {};
    try { spinningAudio.pause(); } catch (_) {}
  }, []);
  useEffect(() => stopAll, [stopAll]);

  // runSpin reads visiblePlayersRef.current at call time — no stale closure
  const runSpin = useCallback((playerPowerups, sc) => {
    if (!playerPowerups || Object.keys(playerPowerups).length === 0) return;
    const vp = visiblePlayersRef.current;
    stopAll();
    setFinished(false);
    setResultMap(playerPowerups);
    setSpinning(true);
    playStartAndSpinOnce();

    // Build a flat list of { label, key } for every reel we need to animate
    const reels = [];
    vp.forEach((player, pi) => {
      const labels = playerPowerups[player.discordUserId] || [];
      for (let k = 0; k < sc; k++) {
        reels.push({
          label: labels[k] || POWERUPS[0].label,
          key:   `${pi}-${k}`,
        });
      }
    });

    const totalReels = reels.length;
    if (totalReels === 0) { setSpinning(false); return; }
    let locked = 0;

    reels.forEach(({ label, key }, flatIdx) => {
      const target = POWERUPS.find((p) => p.label === label) || POWERUPS[0];
      const strip  = buildStrip(POWERUPS, target);
      const el     = trackRefs.current[key];
      if (!el) { locked += 1; if (locked >= totalReels) { setSpinning(false); playWin(); } return; }
      const cancel = animateReel({
        trackEl:   el,
        strip,
        duration:  BASE_DURATION + flatIdx * STAGGER,
        cellClass: "pu-cell",
        cellHeight: 60,
        onDone: () => {
          playStop();
          locked += 1;
          if (locked >= totalReels) { setSpinning(false); playWin(); }
        },
      });
      cancelFns.current[key] = cancel;
    });

    setTimeout(() => setFinished(true), BASE_DURATION + (totalReels - 1) * STAGGER + 50);
  }, [stopAll]);  // only stopAll — reads visiblePlayersRef at call time

  // Host spin
  // The server rolls each eligible player's Domain Expansion chance first;
  // winners get it in one of their slots, everyone else gets ordinary
  // power-ups only. The finished result is then broadcast to all players.
  const spin = useCallback(async () => {
    if (players.length < 1 || spinning || drawing) return;
    setDrawError(null);

    let winnerIds = new Set();
    if (onPowerDraw) {
      setDrawing(true);
      const res = await onPowerDraw();
      setDrawing(false);
      if (res?.error) { setDrawError(res.error); return; }
      winnerIds = new Set((res?.winners || [])
        .filter((w) => w.skillName === DOMAIN_LABEL)
        .map((w) => w.discordUserId));
    }

    const playerPowerups = {};
    players.forEach((p) => {
      if (!p.discordUserId) return;
      if (winnerIds.has(p.discordUserId)) {
        const labels = [DOMAIN_LABEL, ...shuffle(FILLER_POWERUPS).slice(0, slotCount - 1).map((pu) => pu.label)];
        playerPowerups[p.discordUserId] = shuffle(labels);
      } else {
        playerPowerups[p.discordUserId] = shuffle(FILLER_POWERUPS).slice(0, slotCount).map((pu) => pu.label);
      }
    });
    onSpun?.({ playerPowerups, slotCount }, false);
    runSpin(playerPowerups, slotCount);
  }, [players, slotCount, spinning, drawing, onSpun, onPowerDraw, runSpin]);

  // Player replay — live spin
  useEffect(() => {
    if (!readOnly || !syncedState?.spinning || !syncedState.playerPowerups) return;
    if (lastHandledAt.current === syncedState.startedAt) return;
    lastHandledAt.current = syncedState.startedAt;
    const sc = syncedState.slotCount ?? 1;
    setSlotCount(sc);
    runSpin(syncedState.playerPowerups, sc);
  }, [readOnly, syncedState, runSpin]);

  // Player static landed (late join / refresh)
  useEffect(() => {
    if (!readOnly || spinning || resultMap) return;
    if (syncedState?.playerPowerups && !syncedState.spinning) {
      const sc = syncedState.slotCount ?? 1;
      setSlotCount(sc);
      setResultMap(syncedState.playerPowerups);
      setFinished(true);
      const vp = visiblePlayersRef.current;
      vp.forEach((player, pi) => {
        const labels = syncedState.playerPowerups[player.discordUserId] || [];
        for (let k = 0; k < sc; k++) {
          const label = labels[k] || POWERUPS[0].label;
          const el = trackRefs.current[`${pi}-${k}`];
          if (el) {
            el.innerHTML = `<div class="slot-cell pu-cell${label === DOMAIN_LABEL ? " pu-domain" : ""}">${escapeHtml(label)}</div>`;
            el.style.transform = "translateY(0px)";
          }
        }
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readOnly, syncedState]);

  /* Lever */
  const handleRef   = useRef(null);
  const draggingRef = useRef(false);
  const startYRef   = useRef(0);
  const pullPxRef   = useRef(0);
  const canPull     = !readOnly && players.length >= 1 && !spinning && !drawing;

  function setHandlePx(px, spring) {
    const el = handleRef.current;
    if (!el) return;
    el.style.transition = spring ? "transform 0.45s cubic-bezier(0.34,1.56,0.64,1)" : "none";
    el.style.transform = `translateY(${px}px)`;
  }
  function onLeverDown(e) {
    if (!canPull) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingRef.current = true; startYRef.current = e.clientY; pullPxRef.current = 0;
    setHandlePx(0, false);
  }
  function onLeverMove(e) {
    if (!draggingRef.current) return;
    const px = Math.min(LEVER_TRAVEL, Math.max(0, e.clientY - startYRef.current));
    pullPxRef.current = px; setHandlePx(px, false);
  }
  function onLeverUp(e) {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    try { e.currentTarget.releasePointerCapture(e.pointerId); } catch (_) {}
    const px = pullPxRef.current;
    setHandlePx(0, true);
    if (px < LEVER_TAP_DISTANCE) quickPull();
    else if (px / LEVER_TRAVEL >= LEVER_PULL_THRESHOLD) spin();
  }
  function quickPull() {
    if (!canPull) return;
    setHandlePx(LEVER_TRAVEL, false);
    setTimeout(() => { spin(); setHandlePx(0, true); }, 140);
  }
  function onLeverKey(e) {
    if (e.key === "Enter" || e.key === " ") { e.preventDefault(); quickPull(); }
  }

  if (players.length < 1) {
    return <div className="randomizer-empty">No players in the room yet.</div>;
  }

  return (
    <>
      {/* Slot count picker — host only */}
      {!readOnly && (
        <div className="pu-slot-count-row">
          <span className="pu-slot-count-label">Items per player</span>
          <div className="pu-slot-count-ctrl">
            <button type="button" className="pu-slot-count-btn"
              onClick={() => setSlotCount((v) => Math.max(1, v - 1))}
              disabled={slotCount <= 1 || spinning}>−</button>
            <span className="pu-slot-count-val">{slotCount}</span>
            <button type="button" className="pu-slot-count-btn"
              onClick={() => setSlotCount((v) => Math.min(3, v + 1))}
              disabled={slotCount >= 3 || spinning}>+</button>
          </div>
        </div>
      )}

      <div className="slot-machine">
        <MarqueeBulbs inset={9} radius={18} />

        {visiblePlayers.map((player, pi) => (
          <div className="slot-reel-col" key={player.discordUserId || pi}>
            <div className="slot-position-label pu-team-label">
              {player.discordUsername || `Player ${pi + 1}`}
            </div>
            {Array.from({ length: slotCount }).map((_, k) => {
              const reelKey = `${pi}-${k}`;
              return (
                <div
                  key={k}
                  className={
                    "slot-reel pu-reel" +
                    (spinning ? " is-spinning" : "") +
                    (finished ? " is-locked pu-locked" : "")
                  }
                >
                  <div className="slot-reel-window">
                    <div
                      className="slot-reel-track"
                      ref={(el) => {
                        trackRefs.current[reelKey] = el;
                        if (el && el.dataset.initedKey !== reelKey) {
                          el.dataset.initedKey = reelKey;
                          const s = shuffle(FILLER_POWERUPS);
                          el.innerHTML = [s[0], s[1] || s[0], s[2] || s[0]]
                            .map((p) => `<div class="slot-cell pu-cell${p.label === DOMAIN_LABEL ? " pu-domain" : ""}">${escapeHtml(p.label)}</div>`)
                            .join("");
                          el.style.transform = "translateY(0px)";
                        }
                      }}
                    />
                  </div>
                  <div className="slot-reel-shine" />
                </div>
              );
            })}
          </div>
        ))}

        {!readOnly && (
          <Lever
            canPull={canPull}
            handleRef={handleRef}
            onPointerDown={onLeverDown}
            onPointerMove={onLeverMove}
            onPointerUp={onLeverUp}
            onKeyDown={onLeverKey}
          />
        )}
      </div>

      {!readOnly && drawError && (
        <p className="pu-draw-note">{drawError}</p>
      )}

      {!readOnly && (
        <div className="randomizer-actions">
          {finished && !spinning && resultMap && (
            <button
              className="btn gold big"
              disabled={applying}
              onClick={async () => {
                setApplying(true);
                setDrawError(null);
                const err = await onSpun?.({ playerPowerups: resultMap, slotCount }, true);
                setApplying(false);
                if (err) setDrawError(err);
              }}
            >
              {applying ? "Applying…" : "Apply Power-ups"}
            </button>
          )}
        </div>
      )}

      {finished && !spinning && resultMap && (
        <div className="pu-results">
          {visiblePlayers.map((player, pi) => {
            const labels = resultMap[player.discordUserId] || [];
            if (labels.length === 0) return null;
            const isMe = readOnly && player.discordUserId === myDiscordUserId;
            return (
              <div className="pu-result-row" key={player.discordUserId || pi}>
                <span className="pu-result-team">
                  {isMe ? "You" : (player.discordUsername || `Player ${pi + 1}`)} got:
                </span>
                <div className="pu-result-badges">
                  {labels.map((label, k) => {
                    const pu = POWERUPS.find((p) => p.label === label);
                    return (
                      <span key={k} className={"pu-result-badge" + (label === DOMAIN_LABEL ? " is-domain" : "")} title={pu?.desc || ""}>{label}</span>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </>
  );
}


/* =========================================================================
   TOP-LEVEL EXPORT
   ========================================================================= */
export default function TeamRandomizer({
  teams,
  players,           // roster: [{ discordUserId, discordUsername, teamId, ... }]
  myDiscordUserId,   // current player's id — null on host
  onApplyOrder,
  onClose,
  onBroadcast,
  onPowerDraw,       // host only: () => Promise<{ winners } | { error }> — server grant roll (preview only)
  onPowerApply,      // host only: (playerPowerups) => Promise<{ ok } | { error }> — commits the grants
  readOnly = false,
  syncedState = null,
}) {
  const [mode, setMode] = useState("order");
  const activeMode = readOnly ? (syncedState?.mode ?? "order") : mode;

  // Normalise players: filter to those with a Discord id, deduplicate
  const playerList = useMemo(() => {
    const seen = new Set();
    return (players || []).filter((p) => {
      if (!p.discordUserId || seen.has(p.discordUserId)) return false;
      seen.add(p.discordUserId);
      return true;
    });
  }, [players]);

  const announcedOpenRef = useRef(false);
  useEffect(() => {
    if (readOnly || !onBroadcast || announcedOpenRef.current) return;
    announcedOpenRef.current = true;
    onBroadcast({ active: true, mode, spinning: false, order: null, playerPowerups: null, slotCount: 1, startedAt: null });
  }, [readOnly, onBroadcast, mode]);

  const prevModeRef = useRef(mode);
  useEffect(() => {
    if (readOnly || prevModeRef.current === mode) return;
    prevModeRef.current = mode;
    onBroadcast?.({ active: true, mode, spinning: false, order: null, playerPowerups: null, slotCount: 1, startedAt: null });
  }, [mode, readOnly, onBroadcast]);

  const closeAndUnannounce = useCallback(() => {
    if (!readOnly) onBroadcast?.(null);
    onClose?.();
  }, [readOnly, onBroadcast, onClose]);

  function handleOrderSpun(order, apply) {
    if (!apply) {
      onBroadcast?.({ active: true, mode: "order", spinning: true, order, playerPowerups: null, slotCount: 1, startedAt: Date.now() });
    } else {
      onApplyOrder?.(order);
    }
  }

  // Spinning is only a preview. Nothing is granted until the host confirms with
  // "Apply Power-ups", which asks the server to hand out every item.
  async function handlePowerupSpun({ playerPowerups, slotCount }, apply) {
    if (!apply) {
      onBroadcast?.({ active: true, mode: "powerup", spinning: true, order: null, playerPowerups, slotCount, startedAt: Date.now() });
      return null;
    }
    if (onPowerApply) {
      const res = await onPowerApply(playerPowerups);
      if (res?.error) return res.error;
    }
    closeAndUnannounce();
    return null;
  }

  return (
    <div className="randomizer-page">
      {!readOnly && (
        <button className="jp-role-back-btn randomizer-back" onClick={closeAndUnannounce}>
          &larr; Back to Board
        </button>
      )}

      <div className="randomizer-body">
        {!readOnly && (
          <div className="randomizer-tabs">
            <button
              type="button"
              className={"randomizer-tab" + (mode === "order"   ? " active" : "")}
              onClick={() => setMode("order")}
            >Team Order</button>
            <button
              type="button"
              className={"randomizer-tab" + (mode === "powerup" ? " active" : "")}
              onClick={() => setMode("powerup")}
            >Power-ups</button>
          </div>
        )}

        {activeMode === "order" ? (
          <SpinWheel
            teams={teams}
            readOnly={readOnly}
            syncedState={activeMode === syncedState?.mode ? syncedState : null}
            onSpun={handleOrderSpun}
          />
        ) : (
          <PowerupSlot
            players={playerList}
            myDiscordUserId={myDiscordUserId}
            readOnly={readOnly}
            syncedState={activeMode === syncedState?.mode ? syncedState : null}
            onSpun={handlePowerupSpun}
            onPowerDraw={onPowerDraw}
          />
        )}
      </div>
    </div>
  );
}