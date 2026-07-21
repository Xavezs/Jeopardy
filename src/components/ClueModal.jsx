import React, { useState, useEffect } from "react";
import { youTubeEmbed } from "../lib/utils";
import { getMediaUrl } from "../lib/storage";
import CustomAudioPlayer from './CustomAudioPlayer';
import CustomVideoPlayer from './CustomVideoPlayer';
import { createSfx, getSharedAudioCtx } from "../lib/sfx";

/* =========================================================================
   REVEAL SOUND
   Plays src/assets/reveal.mp3 when the front face of a clue is clicked to
   flip/reveal the question. Falls back to a synthesized chime if the file
   is missing/unloadable. File-load/fallback/debounce plumbing lives in
   lib/sfx.js's createSfx() — only the synthesized tone (unique to this
   sound) stays here.
   ========================================================================= */
const revealSfxUrl = new URL("../assets/reveal-card.mp3", import.meta.url).href;

function playSynthRevealTone() {
  try {
    const ctx = getSharedAudioCtx();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume();
    const t0 = ctx.currentTime;

    // Bright upward chime — reads as a bigger, more celebratory moment
    // than the plain click tone used elsewhere in the app.
    const osc = ctx.createOscillator();
    const oscGain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(600, t0);
    osc.frequency.exponentialRampToValueAtTime(1100, t0 + 0.09);
    oscGain.gain.setValueAtTime(0.0001, t0);
    oscGain.gain.exponentialRampToValueAtTime(0.22, t0 + 0.01);
    oscGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
    osc.connect(oscGain);
    oscGain.connect(ctx.destination);
    osc.onended = () => {
      osc.disconnect();
      oscGain.disconnect();
    };
    osc.start(t0);
    osc.stop(t0 + 0.23);
  } catch (e) {
    /* best effort — silently ignore if audio is blocked */
  }
}

const playRevealSfx = createSfx({
  url: revealSfxUrl,
  fallbackTone: playSynthRevealTone,
  volume: 0.1,
  minGapMs: 40, // guards against double-fires
});

/* =========================================================================
   CORRECT / INCORRECT SOUNDS
   Triggered by the ↑ / ↓ keyboard shortcuts once a team is selected via
   number keys (1-4). Same file-with-synth-fallback pattern as the reveal
   sound above — see lib/sfx.js's createSfx().
   ========================================================================= */
const correctSfxUrl = new URL("../assets/correct.mp3", import.meta.url).href;
const incorrectSfxUrl = new URL("../assets/incorrect.mp3", import.meta.url).href;

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

function playAlertSound() {
  try {
    const ctx = getSharedAudioCtx();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume();
    const beepAt = (delay) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "square";
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.0001, ctx.currentTime + delay);
      gain.gain.exponentialRampToValueAtTime(0.25, ctx.currentTime + delay + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + delay + 0.28);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(ctx.currentTime + delay);
      osc.stop(ctx.currentTime + delay + 0.3);
    };
    beepAt(0);
    beepAt(0.35);
    beepAt(0.7);
  } catch (e) {
    /* best effort — silently ignore if audio is blocked */
  }
}

const RING_CIRCUMFERENCE = 2 * Math.PI * 27;

function formatClock(totalSeconds) {
  const s = Math.max(0, Math.ceil(totalSeconds));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return m > 0 ? `${m}:${String(rem).padStart(2, "0")}` : `${rem}`;
}

export default function ClueModal({
  activeCat,
  value,
  clue,
  teams,
  revealed,
  onToggleReveal,
  onClose,
  onAdjustTeamScore,
  timerEnabled,
  timerSeconds,
  onDuckMusic,
}) {
  const [mediaUrl, setMediaUrl] = useState("");
  // What to actually try rendering as. Starts from the stored mediaType;
  // if that guess turns out wrong (or was never set, e.g. old data / an
  // ambiguous pasted URL), onError below advances it to the next kind.
  const [renderAs, setRenderAs] = useState("");

  // Same idea as mediaUrl/renderAs above, but for the OPTIONAL media shown
  // alongside the answer once it's revealed (e.g. a payoff photo/clip).
  const [answerMediaUrl, setAnswerMediaUrl] = useState("");
  const [answerRenderAs, setAnswerRenderAs] = useState("");

  const effectiveDuration = Math.max(1, parseInt(timerSeconds, 10) || 30);
  const [remaining, setRemaining] = useState(effectiveDuration);
  const [running, setRunning] = useState(false);
  const [timeUp, setTimeUp] = useState(false);
  const alertPlayedRef = React.useRef(false);
  const [flipped, setFlipped] = useState(false);
  // Which team is "armed" for the ↑/↓ correct/incorrect keyboard shortcuts.
  // Selected via number keys 1-4 (index into teams array), cleared per-clue.
  const [selectedTeamIndex, setSelectedTeamIndex] = useState(null);

  // Whatever was playing (audio/video below) belongs to THIS clue — if the
  // clue changes or the modal closes while it was still playing, make sure
  // background music comes back up rather than staying ducked forever.
  useEffect(() => {
    return () => onDuckMusic && onDuckMusic(false);
  }, [clue, onDuckMusic]);

  // Reset the clock (and flip state) whenever a new clue is opened (or its configured duration changes)
  useEffect(() => {
    setRemaining(effectiveDuration);
    setRunning(false);
    setTimeUp(false);
    alertPlayedRef.current = false;
    setFlipped(false);
    setSelectedTeamIndex(null);
  }, [clue, effectiveDuration]);

  // Countdown tick while running
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          clearInterval(id);
          setRunning(false);
          setTimeUp(true);
          if (!alertPlayedRef.current) {
            alertPlayedRef.current = true;
            playAlertSound();
          }
          return 0;
        }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [running]);

  function toggleTimer() {
    if (timeUp) return;
    setRunning((r) => !r);
  }
  function resetTimer() {
    setRemaining(effectiveDuration);
    setRunning(false);
    setTimeUp(false);
    alertPlayedRef.current = false;
  }

  useEffect(() => {
    let cancelled = false;
    let urlsToRevoke = [];

    async function convertIds() {
      const url = clue.mediaUrl ? await getMediaUrl(clue.mediaUrl) : "";
      const answerUrl = clue.answerMediaUrl ? await getMediaUrl(clue.answerMediaUrl) : "";
      if (cancelled) {
        // Clue changed again before this resolved — don't leak the object URLs we just made
        if (url && url.startsWith("blob:")) URL.revokeObjectURL(url);
        if (answerUrl && answerUrl.startsWith("blob:")) URL.revokeObjectURL(answerUrl);
        return;
      }
      urlsToRevoke = [url, answerUrl].filter((u) => u && u.startsWith("blob:"));
      setMediaUrl(url);
      // Prefer the stored type; if it's unknown, guess image first (most
      // common) and let onError cascade through video -> audio below.
      setRenderAs(clue.mediaType || (url ? "image" : ""));
      setAnswerMediaUrl(answerUrl);
      setAnswerRenderAs(clue.answerMediaType || (answerUrl ? "image" : ""));
    }
    convertIds();

    return () => {
      cancelled = true;
      urlsToRevoke.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [clue]);

  const [closing, setClosing] = useState(false);
  const mouseDownOnOverlay = React.useRef(false);

  const requestClose = (markComplete) => {
    setClosing(true);
    setTimeout(() => onClose(markComplete), 160);
  };

  // Esc closes the clue the same way clicking the backdrop does — doesn't mark it complete.
  // Space progresses through both reveal stages: first press flips the card
  // (category/value -> question), second press reveals the answer text —
  // mirrors the two-step flow of clicking the card then "Reveal Answer".
  // Number keys (1-4) "arm" a team; ↑/↓ then score that team correct/incorrect
  // and play the matching sfx. Only active once the answer side is showing,
  // so these never fight with the reveal shortcuts above.
  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        requestClose(false);
        return;
      }

      if (e.key === " " || e.code === "Space") {
        e.preventDefault(); // stop page scroll
        if (!flipped) {
          playRevealSfx();
          setFlipped(true);
        } else {
          // Once flipped, space toggles the answer back and forth —
          // reveal it, hit space again to hide it, and so on.
          playRevealSfx();
          onToggleReveal();
        }
        return;
      }

      if (!flipped) return; // remaining shortcuts only apply once flipped

      const digit = Number(e.key);
      if (Number.isInteger(digit) && digit >= 1 && digit <= teams.length) {
        setSelectedTeamIndex(digit - 1);
        return;
      }

      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        if (selectedTeamIndex == null || !teams[selectedTeamIndex]) return;
        e.preventDefault(); // stop page scroll
        const team = teams[selectedTeamIndex];
        if (e.key === "ArrowUp") {
          playCorrectSfx();
          onAdjustTeamScore(team, value);
        } else {
          playIncorrectSfx();
          onAdjustTeamScore(team, -value);
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [flipped, revealed, onToggleReveal, teams, selectedTeamIndex, value, onAdjustTeamScore]);

  if (!activeCat || !clue) return null;

  return (
    <div
      className={"modal-overlay" + (closing ? " closing" : "")}
      onMouseDown={(e) => {
        mouseDownOnOverlay.current = e.target === e.currentTarget;
      }}
      onMouseUp={(e) => {
        if (mouseDownOnOverlay.current && e.target === e.currentTarget) {
          requestClose(false);
        }
        mouseDownOnOverlay.current = false;
      }}
    >
      <div className="modal clue-modal-flip-outer">
        <div className={"clue-flip-inner" + (flipped ? " is-flipped" : "")}>
          <div
            className="clue-flip-face clue-flip-front"
            data-sfx-handled
            onClick={() => {
              playRevealSfx();
              setFlipped(true);
            }}
            role="button"
            tabIndex={0}
            aria-label="Reveal clue"
            onKeyDown={(e) => {
              // Space is handled globally now (works regardless of focus).
              // Enter stays here for keyboard users who've tabbed to this element.
              if (e.key === "Enter") {
                e.preventDefault();
                playRevealSfx();
                setFlipped(true);
              }
            }}
          >
            <div className="clue-flip-front-category">{activeCat.name}</div>
            <div className="clue-flip-front-value">${value}</div>
            <div className="clue-flip-front-hint">Click to reveal</div>
          </div>

          <div className="clue-flip-face clue-flip-back">
            {timerEnabled && (
              <div className="clue-timer-corner">
                <button
                  className="clue-timer-reset"
                  onClick={resetTimer}
                  title="Reset timer"
                  aria-label="Reset timer"
                >
                  ↺
                </button>
                <button
                  className={
                    "clue-timer-ring-btn" + (timeUp ? " time-up" : "") + (running ? " running" : "")
                  }
                  onClick={toggleTimer}
                  disabled={timeUp}
                  title={timeUp ? "Time's up" : running ? "Pause" : remaining === effectiveDuration ? "Start" : "Resume"}
                >
                  <svg className="clue-timer-ring-svg" viewBox="0 0 64 64">
                    <circle className="clue-timer-ring-track" cx="32" cy="32" r="27" />
                    <circle
                      className="clue-timer-ring-progress"
                      cx="32"
                      cy="32"
                      r="27"
                      style={{
                        strokeDasharray: RING_CIRCUMFERENCE,
                        strokeDashoffset: RING_CIRCUMFERENCE * (1 - remaining / effectiveDuration),
                      }}
                    />
                  </svg>
                  <span className="clue-timer-value">{formatClock(remaining)}</span>
                </button>
              </div>
            )}

            <div className="clue-modal-header">{activeCat.name}</div>
            <div className="clue-value-big">${value}</div>

            <div className="clue-question">
              {clue.question ? (
                clue.question.split("\n").map((line, index) => (
                  <React.Fragment key={index}>
                    {line}
                    <br />
                  </React.Fragment>
                ))
              ) : (
                "(no question text set — edit this clue in Edit Board mode)"
              )}
            </div>
            {mediaUrl && renderAs && (
              <div className="clue-media">
                {renderAs === "image" && (
                  <img src={mediaUrl} alt="" onError={() => setRenderAs("video")} />
                )}
                {renderAs === "video" &&
                  (youTubeEmbed(mediaUrl) ? (
                    <iframe
                      src={youTubeEmbed(mediaUrl)}
                      allow="autoplay; encrypted-media; picture-in-picture"
                      allowFullScreen
                      title="clue-video"
                    />
                  ) : (
                    <CustomVideoPlayer src={mediaUrl} onError={() => setRenderAs("audio")} onPlayStateChange={onDuckMusic} />
                  ))}
                {renderAs === "audio" && <CustomAudioPlayer src={mediaUrl} onPlayStateChange={onDuckMusic} />}
              </div>
            )}

           <div className={"clue-answer-box" + (revealed ? " show" : "")} style={{ whiteSpace: "pre-line" }}>{clue.answer || "(no answer set)"}</div>
            {revealed && answerMediaUrl && answerRenderAs && (
              <div className="clue-media clue-answer-media">
                {answerRenderAs === "image" && (
                  <img src={answerMediaUrl} alt="" onError={() => setAnswerRenderAs("video")} />
                )}
                {answerRenderAs === "video" &&
                  (youTubeEmbed(answerMediaUrl) ? (
                    <iframe
                      src={youTubeEmbed(answerMediaUrl)}
                      allow="autoplay; encrypted-media; picture-in-picture"
                      allowFullScreen
                      title="clue-answer-video"
                    />
                  ) : (
                    <CustomVideoPlayer src={answerMediaUrl} onError={() => setAnswerRenderAs("audio")} onPlayStateChange={onDuckMusic} />
                  ))}
                {answerRenderAs === "audio" && <CustomAudioPlayer src={answerMediaUrl} onPlayStateChange={onDuckMusic} />}
              </div>
            )}
            <div className="clue-actions">
              <button
                className="btn"
                data-sfx-handled
                onClick={() => {
                  playRevealSfx();
                  onToggleReveal();
                }}
              >
                {revealed ? "Hide Answer" : "Reveal Answer"}
              </button>
              <button className="btn" onClick={() => requestClose(true)}>
                Mark Complete &amp; Close
              </button>
            </div>
            <div className="score-row">
              {teams.map((team, i) => (
                <div
                  key={team.id}
                  className={"score-team-block" + (i === selectedTeamIndex ? " kb-selected" : "")}
                  onClick={() => setSelectedTeamIndex(i)}
                  role="button"
                  tabIndex={0}
                  aria-label={`Select ${team.name} (${i + 1})`}
                >
                  <div className="name">{team.name}</div>
                  <div className="score-value">{team.score ?? 0}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}