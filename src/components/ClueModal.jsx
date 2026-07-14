import React, { useState, useEffect } from "react";
import { youTubeEmbed } from "../lib/utils";
import { getMediaUrl } from "../lib/storage";
import CustomAudioPlayer from './CustomAudioPlayer';

function playAlertSound() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    const ctx = new Ctx();
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
    setTimeout(() => ctx.close(), 1200);
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
}) {
  const [mediaUrl, setMediaUrl] = useState("");
  // What to actually try rendering as. Starts from the stored mediaType;
  // if that guess turns out wrong (or was never set, e.g. old data / an
  // ambiguous pasted URL), onError below advances it to the next kind.
  const [renderAs, setRenderAs] = useState("");

  const effectiveDuration = Math.max(1, parseInt(timerSeconds, 10) || 30);
  const [remaining, setRemaining] = useState(effectiveDuration);
  const [running, setRunning] = useState(false);
  const [timeUp, setTimeUp] = useState(false);
  const alertPlayedRef = React.useRef(false);

  // Reset the clock whenever a new clue is opened (or its configured duration changes)
  useEffect(() => {
    setRemaining(effectiveDuration);
    setRunning(false);
    setTimeUp(false);
    alertPlayedRef.current = false;
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
      if (cancelled) {
        // Clue changed again before this resolved — don't leak the object URL we just made
        if (url && url.startsWith("blob:")) URL.revokeObjectURL(url);
        return;
      }
      urlsToRevoke = url && url.startsWith("blob:") ? [url] : [];
      setMediaUrl(url);
      // Prefer the stored type; if it's unknown, guess image first (most
      // common) and let onError cascade through video -> audio below.
      setRenderAs(clue.mediaType || (url ? "image" : ""));
    }
    convertIds();

    return () => {
      cancelled = true;
      urlsToRevoke.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [clue]);

  const [closing, setClosing] = useState(false);

  const requestClose = (markComplete) => {
    setClosing(true);
    setTimeout(() => onClose(markComplete), 160);
  };

  if (!activeCat || !clue) return null;

  return (
    <div className={"modal-overlay" + (closing ? " closing" : "")} onClick={(e) => { if (e.target === e.currentTarget) requestClose(false); }}>
      <div className="modal">
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

        <div className="clue-question">{clue.question || "(no question text set — edit this clue in Edit Board mode)"}</div>

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
                <video src={mediaUrl} controls onError={() => setRenderAs("audio")} />
              ))}
            {renderAs === "audio" && <CustomAudioPlayer src={mediaUrl} />}
          </div>
        )}

        <div className={"clue-answer-box" + (revealed ? " show" : "")}>{clue.answer || "(no answer set)"}</div>
        <div className="clue-actions">
          <button className="btn gold" onClick={onToggleReveal}>
            {revealed ? "Hide Answer" : "Reveal Answer"}
          </button>
          <button className="btn" onClick={() => requestClose(true)}>
            Mark Complete &amp; Close
          </button>
        </div>
        <div className="score-row">
          {teams.map((team) => (
            <div key={team.id} className="score-team-block">
              <div className="name">{team.name}</div>
              <div className="btns">
                <button className="plus" onClick={() => onAdjustTeamScore(team, value)}>+{value}</button>
                <button className="minus" onClick={() => onAdjustTeamScore(team, -value)}>−{value}</button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}