import React, { useState, useEffect } from "react";
import { isYoutubeUrl } from "../lib/youtube";
import { getMediaUrl, isGoogleDriveUrl, extractGoogleDriveFileId, resolveGoogleDriveMediaType } from "../lib/storage";
import CustomAudioPlayer from './CustomAudioPlayer';
import CustomVideoPlayer from './CustomVideoPlayer';
import YoutubePlayer from './YoutubePlayer';
import ClueMediaImage from './ClueMediaImage';
import { createSfx, getSharedAudioCtx, withRunningCtx } from "../lib/sfx";
import { playDailyDoubleSfx, stopDailyDoubleSfx } from "../lib/boardSfx";
import { OPEN_CONTROL } from "../lib/hooks/useControlSync";

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
const MEDIA_PRELOAD_TIMEOUT_MS = 45000;

async function preloadMedia(url, signal) {
  const response = await fetch(url, { signal, cache: "default" });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.blob();
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
  onNextBuzzer,
  onPrevBuzzer,
  resolveTeamForDiscordUser,
  flipped: propFlipped,
  onFlip,
  onJudgeAnswer,
  dailyDoubleWager,
  onSetWager,
  controlDiscordUserId,
  ddMinWagerZero,
  ddWagerBasisPlayerScore,
}) {
  const [mediaUrl, setMediaUrl] = useState("");
  const [renderAs, setRenderAs] = useState("");
  const [questionPlaying, setQuestionPlaying] = useState(false);
  const questionTimeRef = React.useRef(0);

  const [answerMediaUrl, setAnswerMediaUrl] = useState("");
  const [answerRenderAs, setAnswerRenderAs] = useState("");
  const [answerPlaying, setAnswerPlaying] = useState(false);
  const answerTimeRef = React.useRef(0);

  // True when renderAs/answerRenderAs came from a confirmed source (a
  // stored clue.mediaType, or the Drive /meta mimeType lookup) rather than
  // the "just assume image first" fallback guess. Only guessed types
  // should fall through the image -> video -> audio cascade on error — a
  // confirmed image that fails to load is an actual load failure (network,
  // timeout, proxy issue), not evidence it's secretly a video.
  const [renderTypeConfident, setRenderTypeConfident] = useState(false);
  const [answerRenderTypeConfident, setAnswerRenderTypeConfident] = useState(false);
  // True once the async media-type resolution below has finished for the
  // CURRENT clue (regardless of whether it turned up media or not) — the
  // reveal-time timer-start logic waits on this instead of reading
  // mediaUrl/renderAs directly, which race the reveal click while still
  // empty/mid-fetch (see the flipped+mediaResolved effect further down).
  const [mediaResolved, setMediaResolved] = useState(false);
  const [mediaStatus, setMediaStatus] = useState("preparing");
  const [mediaStatusMessage, setMediaStatusMessage] = useState("");
  const [mediaRetryCount, setMediaRetryCount] = useState(0);
  const [preparedMediaUrl, setPreparedMediaUrl] = useState("");

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

  /* ---------------- DAILY DOUBLE ----------------
     `dailyDoubleWager` is lifted to the parent (mirrors the `revealed` /
     `flipped` pattern) so it survives re-renders and can be broadcast to
     PlayerView the same way. Until it's set, this clue can't flip yet —
     a dedicated wager screen (further down) is shown instead of the usual
     flip-front. `effectiveValue` replaces every use of the raw row
     `value` below (header display + scoring), so the rest of the
     component doesn't need to know whether it's looking at a normal clue
     or a Daily Double.

     The wager is restricted to whichever player currently holds board
     control (the one who picked this category) — `controlDiscordUserId`
     is only a single specific player's id when a player, not the host,
     owns the pick; OPEN_CONTROL ("anyone can pick") and the locked/
     host-only state don't identify one player, so in those cases we fall
     back to letting the host pick a team manually. */
  const isDailyDouble = !!clue?.isDailyDouble;
  const wagerLocked = dailyDoubleWager != null;
  const effectiveValue = isDailyDouble ? dailyDoubleWager ?? 0 : value;
  // maxWager/minWager themselves are computed further down, in the wager
  // screen block — the "max wager = team score" house rule needs to know
  // which team is wagering, and that isn't resolved until sortedTeams/
  // pickingTeam/wagerTeamId are in scope.

  const hasSpecificPicker = !!(controlDiscordUserId && controlDiscordUserId !== OPEN_CONTROL);
  const pickingTeam = hasSpecificPicker && resolveTeamForDiscordUser ? resolveTeamForDiscordUser(controlDiscordUserId) : null;

  const [wagerTeamId, setWagerTeamId] = useState(null);
  const [wagerInput, setWagerInput] = useState("");
  // When there's a specific picker, the default is to wait for THEM to
  // submit the wager from their own device (see useWagerSync/PlayerView) —
  // the host's number input stays hidden until explicitly requested via
  // this override, e.g. because the picker disconnected or isn't in
  // Discord. Reset per clue so a fallback used on one Daily Double doesn't
  // silently carry over and hide the "waiting" screen on the next one.
  const [manualWagerOverride, setManualWagerOverride] = useState(false);

  // Fire the Daily Double sting exactly once per clue, right as the wager
  // screen appears. Keyed off clueId (not just isDailyDouble) so it
  // doesn't refire on unrelated re-renders while this screen is still up,
  // and resets cleanly when a new Daily Double clue is opened.
  const ddSfxFiredForClueRef = React.useRef(null);
  useEffect(() => {
    if (isDailyDouble && !wagerLocked && ddSfxFiredForClueRef.current !== clueId) {
      ddSfxFiredForClueRef.current = clueId;
      playDailyDoubleSfx();
    }
    // Stop the sting the moment this is no longer the live Daily Double
    // wager screen — the host closes the clue, the wager gets locked in,
    // a different clue opens, or this modal itself unmounts (e.g. round
    // changed) — rather than letting up to ~1.2-2s of tail keep playing
    // into whatever's on screen now. Mirrors the same fix on the player
    // side (PlayerView.jsx's matching effect). Only fires if a sting was
    // actually started for the clue this effect run is about.
    return () => {
      if (ddSfxFiredForClueRef.current) stopDailyDoubleSfx();
    };
  }, [isDailyDouble, wagerLocked, clueId]);

  // Once a wager is locked in, auto-select that team in the scoreboard
  // sidebar so the host doesn't have to press the digit key again.
  useEffect(() => {
    if (wagerLocked && wagerTeamId) setSelectedTeamId(wagerTeamId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wagerLocked]);

  const sortedTeams = React.useMemo(() => {
    if (!teams) return [];
    return [...teams].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }, [teams]);

  // Reveal the clue and arm buzzer ONLY if buzzer is enabled. Timer-start
  // is handled entirely by the flipped+mediaResolved effect below and the
  // questionPlaying effect further down — not here — so it can wait for
  // the async media-type resolution to actually finish first instead of
  // reading mediaUrl/renderAs synchronously (which are still empty on a
  // fast reveal click, before convertIds resolves).
  const revealClue = () => {
    if (mediaStatus !== "ready") return;
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
    setMediaResolved(false);
    setMediaStatus(clue?.mediaUrl ? "preparing" : "ready");
    setMediaStatusMessage("");
    setMediaRetryCount(0);
    setPreparedMediaUrl("");
    setWagerTeamId(pickingTeam ? pickingTeam.id : null);
    setWagerInput("");
    setManualWagerOverride(false);
  }, [clueId, effectiveDuration]);

  // Download the question media before the host can reveal the clue. The
  // media players use the same URL afterwards, so the browser/server cache
  // can reuse this prepared response instead of starting from zero again.
  useEffect(() => {
    if (!mediaResolved) return;

    let cancelled = false;
    let preparedBlobUrl = null;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), MEDIA_PRELOAD_TIMEOUT_MS);
    setPreparedMediaUrl("");

    async function prepareQuestionMedia() {
      if (!mediaUrl || !renderAs || (renderAs === "video" && isYoutubeUrl(mediaUrl))) {
        if (mediaUrl && renderAs === "video" && isYoutubeUrl(mediaUrl)) {
          setPreparedMediaUrl(mediaUrl);
        }
        setMediaStatus("ready");
        return;
      }

      setMediaStatus("preparing");
      setMediaStatusMessage("");
      try {
        if (mediaUrl.startsWith("blob:") || mediaUrl.startsWith("data:")) {
          setPreparedMediaUrl(mediaUrl);
          setMediaStatus("ready");
          return;
        }
        const blob = await preloadMedia(mediaUrl, controller.signal);
        if (!cancelled) {
          preparedBlobUrl = URL.createObjectURL(blob);
          setPreparedMediaUrl(preparedBlobUrl);
          setMediaStatus("ready");
        }
      } catch (error) {
        if (cancelled) return;
        setMediaStatus("error");
        setMediaStatusMessage(
          controller.signal.aborted
            ? "Media took too long to prepare."
            : error?.message || "Media could not be prepared."
        );
      } finally {
        clearTimeout(timeoutId);
      }
    }

    prepareQuestionMedia();
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timeoutId);
      if (preparedBlobUrl) URL.revokeObjectURL(preparedBlobUrl);
    };
  }, [mediaResolved, mediaUrl, renderAs, mediaRetryCount]);

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

  // Reveal-time timer start — waits for BOTH the card to be flipped AND
  // media-type resolution to finish for this clue, so it can't fire on
  // stale/empty mediaUrl+renderAs from a reveal click that landed before
  // convertIds resolved (that race was starting the timer immediately
  // even for video/audio clues, since a not-yet-resolved clue looked
  // identical to a no-media one).
  // - Real video/audio (including YouTube): skip — the questionPlaying
  //   effect above owns starting/pausing this one, in step with playback.
  // - Everything else (text, image, or resolution came back empty):
  //   start now, since no "play" event will ever come.
  useEffect(() => {
    if (!flipped || !mediaResolved || !timerEnabled || timeUp || running) return;
    const isRealPlayableMedia = renderAs === "video" || renderAs === "audio";
    if (!isRealPlayableMedia) {
      setRunning(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flipped, mediaResolved, renderAs, mediaUrl]);

  // For clues with a video/audio question, the timer stays in lockstep
  // with playback: starting the clip starts (or resumes) the clock,
  // pausing/stopping it (manual pause, or the clip ending) pauses the
  // clock too — instead of running independently once started. Doesn't
  // touch anything once timeUp is reached (nothing left to pause).
  useEffect(() => {
    if (!timerEnabled || timeUp) return;
    setRunning(questionPlaying);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [questionPlaying]);

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
      // Returns { type, confident }. confident=true means we know for sure
      // what this media is (stored on the clue, or confirmed via Drive's
      // /meta mimeType lookup) — confident=false means "image" is just a
      // starting guess with no real evidence behind it yet.
      async function resolveRenderType(rawRef, resolvedUrl, storedType) {
        if (storedType) return { type: storedType, confident: true };
        if (isGoogleDriveUrl(rawRef)) {
          const fileId = extractGoogleDriveFileId(rawRef);
          const detected = fileId ? await resolveGoogleDriveMediaType(fileId) : "";
          if (detected) return { type: detected, confident: true };
        }
        return { type: resolvedUrl ? "image" : "", confident: false };
      }

      const [questionResult, answerResult] = await Promise.all([
        resolveRenderType(clue?.mediaUrl, url, clue?.mediaType),
        resolveRenderType(clue?.answerMediaUrl, answerUrl, clue?.answerMediaType),
      ]);
      if (cancelled) return;
      setRenderAs(questionResult.type);
      setRenderTypeConfident(questionResult.confident);
      setAnswerRenderAs(answerResult.type);
      setAnswerRenderTypeConfident(answerResult.confident);
      setMediaResolved(true);
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

      // Nothing else should fire while the Daily Double wager screen is up
      // — space would otherwise skip straight to a flip/reveal, and digit
      // keys would pre-arm a scoreboard slot before a team is even chosen.
      if (isDailyDouble && !wagerLocked) return;

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
          onAdjustTeamScore(team, effectiveValue);
        } else {
          playIncorrectSfx();
          onAdjustTeamScore(team, -effectiveValue);
        }
        // If the team we just scored is whoever currently has the buzzer,
        // automatically advance to the next person in line — scoring them
        // means their turn is over, so the host shouldn't have to also
        // press the "next" shortcut separately. Doesn't fire when the
        // selected team was picked manually (digit key) and isn't who
        // actually buzzed in.
        const buzzedTeam = buzzerWinner && resolveTeamForDiscordUser ? resolveTeamForDiscordUser(buzzerWinner.id) : null;
        if (onNextBuzzer && buzzedTeam && buzzedTeam.id === team.id) {
          onNextBuzzer();
        }
        // Report the judgment to the server so it can update room.playerStats
        // .correct/wrong. Previously this only ran for ArrowUp, so a "wrong"
        // judged here never reached the server and playerStats.wrong stayed
        // stuck at 0 — the per-player correct/wrong counters looked broken
        // even though the on-screen score itself was adjusting correctly.
        // Same condition as the auto-advance above (must be the person who
        // actually buzzed in) — manually adjusting some other team's score
        // (digit key + arrow, unrelated to who buzzed) still shouldn't be
        // attributed to a specific player's stats.
        if (onJudgeAnswer && buzzedTeam && buzzedTeam.id === team.id && buzzerWinner) {
          onJudgeAnswer(buzzerWinner.id, e.key === "ArrowUp");
        }
        return;
      }

      // Left/Right: manually step through the buzz-in queue without
      // touching anyone's score. Right mirrors the same "next" the
      // auto-advance above uses; Left steps back via the matching
      // prevBuzzer server event (bot-server.js) for correcting an
      // accidental advance.
      if (e.key === "ArrowRight") {
        if (!onNextBuzzer) return;
        e.preventDefault();
        onNextBuzzer();
      }
      if (e.key === "ArrowLeft") {
        if (!onPrevBuzzer) return;
        e.preventDefault();
        onPrevBuzzer();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [flipped, revealed, onToggleReveal, teams, sortedTeams, selectedTeamId, value, effectiveValue, isDailyDouble, wagerLocked, onAdjustTeamScore, buzzerEnabled, onArmBuzzer, onNextBuzzer, onPrevBuzzer, buzzerWinner, resolveTeamForDiscordUser, onJudgeAnswer]);

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
  // can force a real pause rather than just muting the UI state. Also
  // stops the countdown timer for the same reason — once someone's
  // buzzed in, the clock shouldn't keep running while they answer.
  useEffect(() => {
    if (!buzzerWinner) return;
    setRunning(false);
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

  // Daily Double intercept: shown instead of the normal flip-front until a
  // team and wager amount are locked in. Once onSetWager fires, this
  // clue re-renders below the normal way — just with effectiveValue (the
  // wager) standing in for the row's $ value everywhere.
  if (isDailyDouble && !wagerLocked) {
    const lockedTeam = pickingTeam && sortedTeams.find((t) => t.id === pickingTeam.id);
    // The wagering team, however it's currently identified — locked in via
    // controlDiscordUserId, or picked manually by the host from the team
    // list further down. Used below for the "max wager = team score" house
    // rule; falls back to $0 (i.e. no headroom yet) until a team is chosen.
    const wagerTeam = lockedTeam || (wagerTeamId ? sortedTeams.find((t) => t.id === wagerTeamId) : null);
    const wagerTeamScore = wagerTeam ? wagerTeam.score ?? 0 : 0;

    // House-rule toggle (data.settings.ddWagerBasisPlayerScore, set in
    // JeopardyBoard.jsx): off (default) keeps the original rule — max
    // wager is 2x the clue's own value. On: max wager is the wagering
    // team's own current score instead (mirrors how Final Jeopardy handles
    // a team already in debt — they can wager up to the size of their
    // debt so a correct answer brings them exactly back to $0, rather than
    // being floored to a $0 max).
    const rawMaxWager = ddWagerBasisPlayerScore
      ? wagerTeamScore < 0
        ? Math.abs(wagerTeamScore)
        : wagerTeamScore
      : value * 2;
    const maxWager = Math.max(0, rawMaxWager);
    // House-rule toggle (data.settings.ddMinWagerZero, set in
    // JeopardyBoard.jsx): off (default) keeps the original rule — min
    // wager equals the clue's own value. On allows wagering anywhere from
    // $0 up. Clamped to maxWager so a team whose score basis leaves them
    // with less headroom than the clue's face value still gets a valid
    // (if narrow) range instead of an unplayable min > max.
    const minWager = Math.min(ddMinWagerZero ? 0 : value, maxWager);

    const parsedWager = parseInt(wagerInput, 10);
    const clampedPreview = isNaN(parsedWager) ? minWager : Math.max(minWager, Math.min(parsedWager, maxWager));
    // With a specific picker, the default is to wait for THEIR device to
    // submit the wager (useWagerSync -> onWagerSubmitted -> setDailyDoubleWager
    // in JeopardyBoard.jsx) rather than have the host type it — the host's
    // number input only appears if there's no specific picker to defer to
    // (host must choose a team manually, same as before) or the host has
    // explicitly reached for the fallback below.
    const showManualInput = !lockedTeam || manualWagerOverride;
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
        <div className="modal daily-double-modal">
          <div className="dd-sparkles" aria-hidden="true">
            {Array.from({ length: 8 }).map((_, i) => (
              <span key={i} className={`dd-sparkle dd-sparkle-${i}`} />
            ))}
          </div>
          <div className="dd-title">DAILY DOUBLE!</div>
          <div className="dd-subtitle">{activeCat.name}</div>

          {lockedTeam ? (
            <div className="dd-locked-team">
              <div className="dd-step-label">Wagering team</div>
              <div className="dd-locked-team-name">{lockedTeam.name}</div>
              <div className="dd-locked-team-hint">
                {showManualInput
                  ? `This clue was picked by ${lockedTeam.name} — only they can wager on it.`
                  : `Waiting for ${lockedTeam.name} to place their wager on their own device…`}
              </div>
            </div>
          ) : (
            <>
              <div className="dd-step-label">Who's wagering?</div>
              <div className="dd-team-list">
                {sortedTeams.map((team) => (
                  <button
                    key={team.id}
                    type="button"
                    className={"dd-team-btn" + (wagerTeamId === team.id ? " is-selected" : "")}
                    onClick={() => setWagerTeamId(team.id)}
                  >
                    {team.name} · ${team.score ?? 0}
                  </button>
                ))}
              </div>
            </>
          )}

          {lockedTeam && !showManualInput && (
            <div className="dd-wager-block dd-wager-waiting">
              <div className="dd-wager-waiting-spinner" aria-hidden="true" />
              <button
                type="button"
                className="dd-cancel-btn"
                onClick={() => setManualWagerOverride(true)}
              >
                {lockedTeam.name} can't submit? Enter wager manually
              </button>
            </div>
          )}

          {wagerTeamId && showManualInput && (
            <div className="dd-wager-block">
              <div className="dd-step-label">Wager (${minWager}–${maxWager})</div>
              <input
                type="number"
                className="dd-wager-input"
                min={minWager}
                max={maxWager}
                value={wagerInput}
                autoFocus
                onChange={(e) => setWagerInput(e.target.value)}
                onWheel={(e) => e.target.blur()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    if (onSetWager) onSetWager(clampedPreview);
                  }
                }}
              />
              <button
                type="button"
                className="btn dd-confirm-btn"
                onClick={() => {
                  if (onSetWager) onSetWager(clampedPreview);
                }}
              >
                Lock In Wager (${clampedPreview})
              </button>
            </div>
          )}

          <button className="dd-cancel-btn" onClick={() => requestClose(false)}>
            Cancel
          </button>
        </div>
      </div>
    );
  }

  // Identify winning team if a player buzzed in
  const winningTeam = buzzerWinner && resolveTeamForDiscordUser ? resolveTeamForDiscordUser(buzzerWinner.id) : null;
  const questionMediaSrc = preparedMediaUrl || mediaUrl;

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
            data-sfx-handled
            onClick={revealClue}
            role="button"
            tabIndex={0}
            aria-label={mediaStatus === "ready" ? "Reveal clue" : "Waiting for clue media"}
            aria-disabled={mediaStatus !== "ready"}
            className={"clue-flip-face clue-flip-front" + (mediaStatus !== "ready" ? " is-media-loading" : "")}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                revealClue();
              }
            }}
          >
            <div className="clue-flip-front-category">{activeCat.name}</div>
            <div className="clue-flip-front-value">${effectiveValue}</div>
            <div className="clue-flip-front-hint">
              {isDailyDouble
                ? `Daily Double — wager $${effectiveValue}`
                : mediaStatus === "ready"
                ? "Click to reveal"
                : "Please wait until media is ready"}
            </div>
            <div className={"clue-preload-status is-" + mediaStatus} role="status" aria-live="polite">
              <span className="clue-preload-status-dot" aria-hidden="true" />
              {mediaStatus === "ready" && (clue?.mediaUrl ? "Media ready" : "Ready to reveal")}
              {mediaStatus === "preparing" && "Preparing media..."}
              {mediaStatus === "error" && (
                <>
                  <span>{mediaStatusMessage}</span>
                  <button
                    type="button"
                    className="clue-preload-retry"
                    onClick={(event) => {
                      event.stopPropagation();
                      setMediaRetryCount((count) => count + 1);
                    }}
                  >
                    Retry
                  </button>
                </>
              )}
            </div>
          </div>

          <div className="clue-flip-face clue-flip-back">
            <div className="clue-cat-value">
              <div className="clue-modal-header">{activeCat.name}</div>
              <div className="clue-value-big">${effectiveValue}</div>
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
            {flipped && questionMediaSrc && renderAs && (
              <div className="clue-media">
                {renderAs === "image" && (
                  <ClueMediaImage
                    src={questionMediaSrc}
                    alt=""
                    onLoadError={() => {
                      // Only fall through to "maybe it's actually a video"
                      // when "image" was itself just a guess — a confirmed
                      // image that failed to load stays a failed image,
                      // not a reason to try mounting a video player against
                      // the same broken URL.
                      if (!renderTypeConfident) setRenderAs("video");
                    }}
                  />
                )}
                {renderAs === "video" &&
                  (isYoutubeUrl(questionMediaSrc) ? (
                    <YoutubePlayer
                      src={questionMediaSrc}
                      isPlaying={questionPlaying}
                      onPlayStateChange={(playing, time) => {
                        questionTimeRef.current = time ?? questionTimeRef.current;
                        setQuestionPlaying(playing);
                        if (onDuckMusic) onDuckMusic(playing);
                        if (onMediaStateChange) onMediaStateChange({ isPlaying: playing, currentTime: time });
                      }}
                    />
                  ) : (
                    <CustomVideoPlayer
                      src={questionMediaSrc}
                      onError={() => {
                        if (!renderTypeConfident) setRenderAs("audio");
                      }}
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
                    src={questionMediaSrc}
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
                  <ClueMediaImage
                    src={answerMediaUrl}
                    alt=""
                    onLoadError={() => {
                      if (!answerRenderTypeConfident) setAnswerRenderAs("video");
                    }}
                  />
                )}
                {answerRenderAs === "video" &&
                  (isYoutubeUrl(answerMediaUrl) ? (
                    <YoutubePlayer
                      src={answerMediaUrl}
                      isPlaying={answerPlaying}
                      onPlayStateChange={(playing, time) => {
                        answerTimeRef.current = time ?? answerTimeRef.current;
                        setAnswerPlaying(playing);
                        if (onDuckMusic) onDuckMusic(playing);
                        if (onMediaStateChange) onMediaStateChange({ isPlaying: playing, currentTime: time });
                      }}
                    />
                  ) : (
                    <CustomVideoPlayer 
                      src={answerMediaUrl} 
                      onError={() => {
                        if (!answerRenderTypeConfident) setAnswerRenderAs("audio");
                      }} 
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

        {flipped && (
          <div
            className="host-answer-preview"
            style={{
              background: "rgba(0,0,0,0.25)",
              border: "1px dashed rgba(255,255,255,0.25)",
              borderRadius: "8px",
              padding: "8px 10px",
              marginBottom: "10px",
            }}
          >
            <div
              style={{
                fontSize: "0.65rem",
                textTransform: "uppercase",
                letterSpacing: "0.06em",
                opacity: 0.6,
                marginBottom: "4px",
              }}
            >
              Answer (host only){revealed ? " · Revealed" : ""}
            </div>
            <div style={{ whiteSpace: "pre-line", fontSize: "0.9rem" }}>
              {clue.answer || "(no answer set)"}
            </div>
          </div>
        )}

        <div className="host-sidebar-actions">
          {!flipped ? (
            <button
              className="btn host-action-btn host-reveal-clue-btn"
              data-sfx-handled
              onClick={revealClue}
               disabled={mediaStatus !== "ready"}
               title={mediaStatus === "ready" ? "Reveal clue" : "Waiting for clue media"}
             >
               {mediaStatus === "ready" ? "Reveal Clue" : "Preparing Media..."}
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

            // One badge per team card, not one per avatar — mirrors
            // PlayerView's buzzStateByTeam so host and player render the
            // exact same badge in the exact same spot (card corner, not
            // hugging the profile picture). If more than one of the
            // team's members is in the queue, whichever is currently
            // active wins over an earlier-but-now-inactive member.
            let teamBuzzState = null;
            discordTeamMembers.forEach((dm) => {
              const queuePos = buzzerQueue.findIndex((p) => p.id === dm.id);
              if (queuePos === -1) return;
              const isActive = !!(buzzerWinner && buzzerWinner.id === dm.id);
              const isStruck = !isActive && queuePos < buzzerActiveIndex;
              if (!teamBuzzState || isActive) {
                teamBuzzState = { position: queuePos + 1, isActive, isStruck };
              }
            });

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
                {teamBuzzState && (
                  <div
                    className={
                      "team-buzz-badge" +
                      (teamBuzzState.isActive ? " is-active" : "") +
                      (teamBuzzState.isStruck ? " is-struck" : "")
                    }
                    title={
                      teamBuzzState.isActive
                        ? `Buzzed in — #${teamBuzzState.position}, currently answering`
                        : teamBuzzState.isStruck
                        ? `Buzzed in — #${teamBuzzState.position}, already tried`
                        : `Buzzed in — #${teamBuzzState.position} in line`
                    }
                  >
                    {teamBuzzState.position}
                  </div>
                )}
                <div className="host-sidebar-team-info">
                  {discordTeamMembers.length > 0 && (
                    <div className="score-team-discord-facepile">
                      {discordTeamMembers.map((dm) => (
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
                        </div>
                      ))}
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