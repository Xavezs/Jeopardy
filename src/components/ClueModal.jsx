import React, { useState, useEffect } from "react";
import { youTubeEmbed } from "../lib/utils";
import { getMediaUrl, isGoogleDriveUrl, extractGoogleDriveFileId, resolveGoogleDriveMediaType } from "../lib/storage";
import CustomAudioPlayer from './CustomAudioPlayer';
import CustomVideoPlayer from './CustomVideoPlayer';
import { discordSdk } from '../discordSdk';
import { createSfx, getSharedAudioCtx } from "../lib/sfx";

/* =========================================================================
   REVEAL SOUND
   ========================================================================= */
const revealSfxUrl = new URL("../assets/reveal-card.mp3", import.meta.url).href;

function playSynthRevealTone() {
  try {
    const ctx = getSharedAudioCtx();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume();
    const t0 = ctx.currentTime;

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
  minGapMs: 40,
});

/* =========================================================================
   CORRECT / INCORRECT SOUNDS
   ========================================================================= */
const correctSfxUrl = new URL("../assets/correct.mp3", import.meta.url).href;
const incorrectSfxUrl = new URL("../assets/incorrect.mp3", import.meta.url).href;

function playSynthCorrectTone() {
  try {
    const ctx = getSharedAudioCtx();
    if (!ctx) return;
    if (ctx.state === "suspended") ctx.resume();
    const t0 = ctx.currentTime;
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

// YouTube can't be embedded inside this Activity — both script-src (IFrame
// API) and frame-src (plain <iframe>) are locked to 'self' by Discord's CSP,
// and unlike media/connect-src there's no proxy workaround for a live
// cross-origin page. openExternalLink is Discord's supported escape hatch
// for exactly this situation: it opens the link in the user's real browser,
// outside the Activity's CSP. Falls back to window.open for plain-browser
// testing (discordSdk commands aren't available outside a real Discord frame).
async function openYoutubeExternally(url) {
  try {
    if (discordSdk?.commands?.openExternalLink) {
      await discordSdk.commands.openExternalLink({ url });
      return;
    }
  } catch (err) {
    console.error('[ClueModal] openExternalLink failed, falling back to window.open:', err);
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

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
  onMediaStateChange, 
  resolveDiscordMembersForTeam,
  scorePulse,
  buzzerEnabled = true,
  buzzerLive,
  buzzerWinner,
  buzzerQueue = [],
  buzzerActiveIndex = -1,
  onArmBuzzer,
  onResetBuzzer,
  resolveTeamForDiscordUser,
  flipped: propFlipped,
  onFlip,
}) {
  const [mediaUrl, setMediaUrl] = useState("");
  const [renderAs, setRenderAs] = useState("");
  const [questionPlaying, setQuestionPlaying] = useState(false);
  const questionTimeRef = React.useRef(0);

  const [answerMediaUrl, setAnswerMediaUrl] = useState("");
  const [answerRenderAs, setAnswerRenderAs] = useState("");
  const [answerPlaying, setAnswerPlaying] = useState(false);
  const answerTimeRef = React.useRef(0);

  const effectiveDuration = Math.max(1, parseInt(timerSeconds, 10) || 30);
  const [remaining, setRemaining] = useState(effectiveDuration);
  const [running, setRunning] = useState(false);
  const [timeUp, setTimeUp] = useState(false);
  const alertPlayedRef = React.useRef(false);
  const [localFlipped, setLocalFlipped] = useState(false);
  const flipped = propFlipped !== undefined ? propFlipped : localFlipped;
  const [selectedTeamId, setSelectedTeamId] = useState(null);

  // Stable string identifier for the active clue to prevent reference-churn resets
  const clueId = activeCat && value ? `${activeCat.id}-${value}` : null;

  const sortedTeams = React.useMemo(() => {
    if (!teams) return [];
    return [...teams].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }, [teams]);

  // Reveal the clue and arm buzzer ONLY if buzzer is enabled
  const revealClue = () => {
    playRevealSfx();
    if (onFlip) {
      onFlip();
    } else {
      setLocalFlipped(true);
    }
    if (buzzerEnabled && onArmBuzzer) onArmBuzzer();
  };

  useEffect(() => {
    return () => onDuckMusic && onDuckMusic(false);
  }, [clueId, onDuckMusic]);

  // Reset clock & buzzer state when unique clue selection changes
  useEffect(() => {
    setRemaining(effectiveDuration);
    setRunning(false);
    setTimeUp(false);
    alertPlayedRef.current = false;
    setLocalFlipped(false);
    setSelectedTeamId(null);
    setQuestionPlaying(false);
    setAnswerPlaying(false);
  }, [clueId, effectiveDuration]);

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
      const url = clue?.mediaUrl ? await getMediaUrl(clue.mediaUrl) : "";
      const answerUrl = clue?.answerMediaUrl ? await getMediaUrl(clue.answerMediaUrl) : "";
      if (cancelled) {
        if (url && url.startsWith("blob:")) URL.revokeObjectURL(url);
        if (answerUrl && answerUrl.startsWith("blob:")) URL.revokeObjectURL(answerUrl);
        return;
      }
      urlsToRevoke = [url, answerUrl].filter((u) => u && u.startsWith("blob:"));
      setMediaUrl(url);
      setAnswerMediaUrl(answerUrl);

      // Figures out which player component to mount. A stored mediaType
      // wins if we have one. Otherwise, for a Drive link specifically, ask
      // the server what the file's real mimeType is (cheap metadata-only
      // call, no download) rather than blindly guessing "image" first and
      // cascading on error — that guess-and-check was letting audio files
      // silently succeed inside the video player (a <video> tag will often
      // play audio-only bytes just fine) instead of ever reaching the
      // audio player. Anything else keeps the original "image" starting
      // guess + onError cascade below.
      async function resolveRenderType(rawRef, resolvedUrl, storedType) {
        if (storedType) return storedType;
        if (isGoogleDriveUrl(rawRef)) {
          const fileId = extractGoogleDriveFileId(rawRef);
          const detected = fileId ? await resolveGoogleDriveMediaType(fileId) : "";
          if (detected) return detected;
        }
        return resolvedUrl ? "image" : "";
      }

      const [type, answerType] = await Promise.all([
        resolveRenderType(clue?.mediaUrl, url, clue?.mediaType),
        resolveRenderType(clue?.answerMediaUrl, answerUrl, clue?.answerMediaType),
      ]);
      if (cancelled) return;
      setRenderAs(type);
      setAnswerRenderAs(answerType);
    }
    convertIds();

    return () => {
      cancelled = true;
      urlsToRevoke.forEach((u) => URL.revokeObjectURL(u));
    };
  }, [clueId, clue?.mediaUrl, clue?.answerMediaUrl, clue?.mediaType, clue?.answerMediaType]);

  const [closing, setClosing] = useState(false);
  const mouseDownOnOverlay = React.useRef(false);

  const requestClose = (markComplete) => {
    if (onResetBuzzer) onResetBuzzer();
    setClosing(true);
    setTimeout(() => onClose(markComplete), 160);
  };

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        requestClose(false);
        return;
      }

      if (e.key === " " || e.code === "Space") {
        e.preventDefault();
        if (!flipped) {
          revealClue();
        } else {
          playRevealSfx();
          onToggleReveal();
        }
        return;
      }

      const digit = Number(e.key);
      if (Number.isInteger(digit) && digit >= 1 && digit <= sortedTeams.length) {
        const target = sortedTeams[digit - 1];
        setSelectedTeamId((prev) => (prev === target.id ? null : target.id));
        return;
      }

      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        if (!selectedTeamId) return;
        const team = teams.find((t) => t.id === selectedTeamId);
        if (!team) return;
        e.preventDefault();
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
  }, [flipped, revealed, onToggleReveal, teams, sortedTeams, selectedTeamId, value, onAdjustTeamScore, buzzerEnabled, onArmBuzzer]);

  // Auto-arm the buzzed-in team's scoreboard slot
  useEffect(() => {
    if (!buzzerWinner || !resolveTeamForDiscordUser) return;
    const winner = resolveTeamForDiscordUser(buzzerWinner.id);
    if (winner) setSelectedTeamId(winner.id);
  }, [buzzerWinner, resolveTeamForDiscordUser]);

  // Whenever someone buzzes in, immediately pause any clue media that's
  // playing — the point of buzzing is to answer over silence, not to keep
  // competing with the clue's own audio/video. Both players are rendered
  // as controlled components (isPlaying prop below) specifically so this
  // can force a real pause rather than just muting the UI state.
  useEffect(() => {
    if (!buzzerWinner) return;
    if (questionPlaying) {
      setQuestionPlaying(false);
      if (onDuckMusic) onDuckMusic(false);
      if (onMediaStateChange) onMediaStateChange({ isPlaying: false, currentTime: questionTimeRef.current });
    }
    if (answerPlaying) {
      setAnswerPlaying(false);
      if (onDuckMusic) onDuckMusic(false);
      if (onMediaStateChange) onMediaStateChange({ isPlaying: false, currentTime: answerTimeRef.current });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [buzzerWinner]);

  if (!activeCat || !clue) return null;

  // Identify winning team if a player buzzed in
  const winningTeam = buzzerWinner && resolveTeamForDiscordUser ? resolveTeamForDiscordUser(buzzerWinner.id) : null;

  return (
    <div
      className={"modal-overlay clue-modal-overlay" + (closing ? " closing" : "")}
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
            onClick={revealClue}
            role="button"
            tabIndex={0}
            aria-label="Reveal clue"
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                revealClue();
              }
            }}
          >
            <div className="clue-flip-front-category">{activeCat.name}</div>
            <div className="clue-flip-front-value">${value}</div>
            <div className="clue-flip-front-hint">Click to reveal</div>
          </div>

          <div className="clue-flip-face clue-flip-back">
            <div className="clue-cat-value">
              <div className="clue-modal-header">{activeCat.name}</div>
              <div className="clue-value-big">${value}</div>
            </div>

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
                    <div
                      className="clue-youtube-external"
                      onClick={() => openYoutubeExternally(mediaUrl)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") openYoutubeExternally(mediaUrl);
                      }}
                    >
                      <svg viewBox="0 0 24 24" className="player-icon play-arrow player-video-big-play">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                      <div className="clue-youtube-external-label">Watch on YouTube</div>
                      <div className="hint">Opens in your browser — YouTube can't be embedded inside the Activity</div>
                    </div>
                  ) : (
                    <CustomVideoPlayer 
                      src={mediaUrl} 
                      onError={() => setRenderAs("audio")} 
                      isPlaying={questionPlaying}
                      onPlayStateChange={(playing, time) => {
                        questionTimeRef.current = time ?? questionTimeRef.current;
                        setQuestionPlaying(playing);
                        if (onDuckMusic) onDuckMusic(playing);
                        if (onMediaStateChange) onMediaStateChange({ isPlaying: playing, currentTime: time });
                      }} 
                    />
                  ))}
                {renderAs === "audio" && (
                  <CustomAudioPlayer 
                    src={mediaUrl} 
                    isPlaying={questionPlaying}
                    onPlayStateChange={(playing, time) => {
                      questionTimeRef.current = time ?? questionTimeRef.current;
                      setQuestionPlaying(playing);
                      if (onDuckMusic) onDuckMusic(playing);
                      if (onMediaStateChange) onMediaStateChange({ isPlaying: playing, currentTime: time });
                    }} 
                  />
                )}
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
                    <div
                      className="clue-youtube-external"
                      onClick={() => openYoutubeExternally(answerMediaUrl)}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") openYoutubeExternally(answerMediaUrl);
                      }}
                    >
                      <svg viewBox="0 0 24 24" className="player-icon play-arrow player-video-big-play">
                        <path d="M8 5v14l11-7z" />
                      </svg>
                      <div className="clue-youtube-external-label">Watch on YouTube</div>
                      <div className="hint">Opens in your browser — YouTube can't be embedded inside the Activity</div>
                    </div>
                  ) : (
                    <CustomVideoPlayer 
                      src={answerMediaUrl} 
                      onError={() => setAnswerRenderAs("audio")} 
                      isPlaying={answerPlaying}
                      onPlayStateChange={(playing, time) => {
                        answerTimeRef.current = time ?? answerTimeRef.current;
                        setAnswerPlaying(playing);
                        if (onDuckMusic) onDuckMusic(playing);
                        if (onMediaStateChange) onMediaStateChange({ isPlaying: playing, currentTime: time });
                      }} 
                    />
                  ))}
                {answerRenderAs === "audio" && (
                  <CustomAudioPlayer 
                    src={answerMediaUrl} 
                    isPlaying={answerPlaying}
                    onPlayStateChange={(playing, time) => {
                      answerTimeRef.current = time ?? answerTimeRef.current;
                      setAnswerPlaying(playing);
                      if (onDuckMusic) onDuckMusic(playing);
                      if (onMediaStateChange) onMediaStateChange({ isPlaying: playing, currentTime: time });
                    }} 
                  />
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="host-clue-sidebar">
        {(buzzerEnabled || timerEnabled) && (
          <div className="host-sidebar-top-block">
            {buzzerEnabled && (buzzerWinner || buzzerLive) && (
              <div className="host-buzzer-status-wrap">
                {buzzerWinner ? (
                  <div className="buzzer-status has-winner" style={{ margin: 0 }}>
                    <strong>{buzzerWinner.username}</strong> buzzed in!
                    {winningTeam ? ` (${winningTeam.name})` : ""}
                    {onArmBuzzer && (
                      <button className="btn host-reopen-btn" onClick={onArmBuzzer}>
                        Re-open
                      </button>
                    )}
                  </div>
                ) : buzzerLive ? (
                  <div className="buzzer-status is-live">
                    BUZZER READY
                  </div>
                ) : null}
              </div>
            )}

            {timerEnabled && (
              <div className="host-sidebar-timer">
                <button className="clue-timer-reset" onClick={resetTimer} title="Reset timer" aria-label="Reset timer">
                  ↺
                </button>
                <button
                  className={"clue-timer-ring-btn" + (timeUp ? " time-up" : "") + (running ? " running" : "")}
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
          </div>
        )}

        <div className="host-sidebar-actions">
          {!flipped ? (
            <button
              className="btn host-action-btn host-reveal-clue-btn"
              data-sfx-handled
              onClick={revealClue}
            >
              Reveal Clue
            </button>
          ) : (
            <button
              className="btn host-action-btn"
              data-sfx-handled
              onClick={() => {
                playRevealSfx();
                onToggleReveal();
              }}
            >
              {revealed ? "Hide Answer" : "Reveal Answer"}
            </button>
          )}
          <button className="btn host-action-btn host-complete-btn" onClick={() => requestClose(true)}>
            Mark Complete &amp; Close
          </button>
        </div>

        <div className="host-sidebar-scoreboard-title">SCOREBOARD</div>
        <div className="host-sidebar-score-list">
          {sortedTeams.map((team, i) => {
            const discordTeamMembers = resolveDiscordMembersForTeam ? resolveDiscordMembersForTeam(team) : [];
            const isBuzzedIn = winningTeam && winningTeam.id === team.id;
            const isSelected = selectedTeamId === team.id;
            return (
              <div
                key={team.id}
                className={
                  "host-sidebar-team-card" +
                  (isSelected ? " kb-selected" : "") +
                  (isBuzzedIn ? " buzzed-in" : "") +
                  (discordTeamMembers.some((m) => m.speaking) ? " discord-speaking" : "")
                }
                onClick={() => setSelectedTeamId((prev) => (prev === team.id ? null : team.id))}
                role="button"
                tabIndex={0}
                aria-label={`Select ${team.name} (${i + 1})`}
              >
                <div className="host-sidebar-team-info">
                  {discordTeamMembers.length > 0 && (
                    <div className="score-team-discord-facepile">
                      {discordTeamMembers.map((dm) => {
                        const queuePos = buzzerQueue.findIndex((p) => p.id === dm.id);
                        const hasBuzzed = queuePos !== -1;
                        const isActive = buzzerWinner && buzzerWinner.id === dm.id;
                        const struckOut = hasBuzzed && !isActive && queuePos < buzzerActiveIndex;

                        return (
                          <div className="score-team-discord-avatar-wrap" key={dm.id}>
                            <img
                              src={dm.avatarUrl}
                              alt=""
                              className={"team-discord-avatar" + (dm.speaking ? " is-speaking" : "")}
                              style={{ opacity: dm.deafened ? 0.4 : 1 }}
                            />
                            {dm.muted && (
                              <div className="team-discord-muted-badge score-team-discord-muted-badge" title="Muted" />
                            )}
                            {hasBuzzed && (
                              <div
                                className="score-team-buzz-order-badge"
                                title={
                                  isActive
                                    ? `Buzzed in — #${queuePos + 1}, currently answering`
                                    : struckOut
                                    ? `Buzzed in — #${queuePos + 1}, already tried`
                                    : `Buzzed in — #${queuePos + 1}, waiting`
                                }
                                style={{
                                  position: "absolute",
                                  top: -4,
                                  left: -4,
                                  minWidth: 16,
                                  height: 16,
                                  padding: "0 3px",
                                  borderRadius: "50%",
                                  background: isActive ? "#ffd54a" : struckOut ? "#666" : "#4a90d9",
                                  color: isActive ? "#222" : "#fff",
                                  fontSize: 10,
                                  fontWeight: 700,
                                  lineHeight: "16px",
                                  textAlign: "center",
                                  boxShadow: "0 0 0 1.5px rgba(0,0,0,0.6)",
                                  textDecoration: struckOut ? "line-through" : "none",
                                }}
                              >
                                {queuePos + 1}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                  <span className="host-sidebar-team-name">{team.name}</span>
                </div>

                <div className={"host-sidebar-team-score" + (scorePulse && scorePulse[team.id] ? " " + scorePulse[team.id] : "")}>
                  ${team.score ?? 0}
                </div>
              </div>
            );
          })}
        </div>

        <div className="score-hint">
          Use <kbd>1-{Math.min(sortedTeams.length, 9)}</kbd> to select, <kbd>↑</kbd>/<kbd>↓</kbd> for score
        </div>
      </div>
    </div>
  );
}