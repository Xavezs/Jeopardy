import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import "../styles/player.css";
import "../styles/board.css"; // TeamCard's classes (.team-card, .team-discord-avatar, etc.) are defined here — this file never needed them before it built its own team markup.
import { usePlayerSync } from "../lib/hooks/usePlayerSync";
import { useBuzzer } from "../lib/hooks/useBuzzer";
import { useControlSync, OPEN_CONTROL } from "../lib/hooks/useControlSync";
import { useWagerSync } from "../lib/hooks/useWagerSync";
import { useFinalSync } from "../lib/hooks/useFinalSync";
import { useSpeakingState } from "../lib/hooks/useSpeakingState";
import { useDiscordMembers } from "../lib/hooks/useDiscordMembers";
import { getMediaUrl, isGoogleDriveUrl, extractGoogleDriveFileId, resolveGoogleDriveMediaType } from "../lib/storage";
import { isYoutubeUrl } from "../lib/youtube";
import { getDiscordIdentity, activityChannelId } from "../discordSdk";
import { unlockAudioPlayback, getSharedAudioCtx, withRunningCtx } from "../lib/sfx";
import MarqueeBulbs from "../lib/MarqueeBulbs";
import ShopModal from "./ShopModal";
import ShopWidget from "./ShopWidget";
import { fetchLoadout } from "../lib/api/shop";
import SkillOverlay from "./SkillOverlay";
import { useSkillSync } from "../lib/hooks/useSkillSync";
import { PowerupTray, PowerupNotice } from "./PowerupUI";
import TeamCard from "./TeamCard";
import TeamRandomizer from "./TeamRandomizer";
import {
  playCorrectSfx,
  playIncorrectSfx,
  playCatRevealSfx,
  playDailyDoubleSfx,
  stopDailyDoubleSfx,
  playStandingsCelebration,
  stopStandingsCelebration,
  preloadStandingsCelebration,
  holdBgmDuck,
} from "../lib/boardSfx";
import CustomAudioPlayer from "./CustomAudioPlayer";
import CustomVideoPlayer from "./CustomVideoPlayer";
import YoutubePlayer from "./YoutubePlayer";
import PlayerBgmWidget from "./PlayerBgmWidget";

/**
 * Attaches a ONE-TIME listener for the player's very first real gesture
 * anywhere on the page (pointerdown covers mouse/touch/pen) and unlocks
 * audio playback then, removing itself immediately after.
 *
 * This does NOT rely on the "Join Game" form actually being submitted —
 * on a returning player, `me` restores straight from localStorage (see
 * the effect above) and the join form is skipped entirely, so hooking
 * unlock only into handleJoin misses every returning player. This one
 * fires regardless of which screen the player lands on.
 */
function useUnlockAudioOnFirstGesture() {
  useEffect(() => {
    const unlock = () => {
      unlockAudioPlayback();
      window.removeEventListener("pointerdown", unlock, true);
    };
    window.addEventListener("pointerdown", unlock, true);
    return () => window.removeEventListener("pointerdown", unlock, true);
  }, []);
}

function readRoomCodeFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("room");
  return code ? code.toUpperCase() : "";
}

function randomPlayerId() {
  return "p_" + Math.random().toString(36).slice(2) + Date.now().toString(36);
}

// Called when the player deliberately leaves — without this, "Leave" only
// ever hid the screen; coming back to the same room code would silently
// restore `me` from here and rejoin automatically.
function clearCachedIdentity(roomCode) {
  const code = roomCode?.trim().toUpperCase();
  if (!code) return;
  localStorage.removeItem(`jeopardy:player:${code}:id`);
  localStorage.removeItem(`jeopardy:player:${code}:name`);
  localStorage.removeItem(`jeopardy:player:${code}:discordUser`);
}

function BuzzStatusText({ buzzerLive, iHaveFloor, alreadyBuzzed, myPosition, idle, className = "" }) {
  const text = idle
    ? "Buzzer is closed — wait for the host…"
    : !buzzerLive
    ? "Buzzer is closed — wait for the host…"
    : iHaveFloor
    ? "You have the floor — go!"
    : alreadyBuzzed
    ? `Buzzed in — you're #${myPosition} in line.`
    : "Buzzer is ready!";
  return <div className={"pv-buzzer-status " + className}>{text}</div>;
}

// Rendered on every player's device (not just the picker's) whenever the
// open clue is a Daily Double — the surprise/excitement of "it's a Daily
// Double!" is part of the show for everyone watching, same as it would be
// on a real broadcast, even though only the specific picker gets to act
// on it. Reuses board.css's `dd-title`/`dd-subtitle` classes (already
// imported into this file — see the top of PlayerView.jsx) so the styling
// matches the host's own Daily Double screen instead of inventing a
// second, slightly-different-looking treatment.
function DailyDoubleFront({
  value,
  wager,
  isSpecificPicker,
  wagerInput,
  setWagerInput,
  wagerJustSubmitted,
  onSubmitWager,
  minWagerZero,
  wagerBasisPlayerScore,
  myTeamScore,
}) {
  const wagerLocked = wager != null;
  // House-rule toggle synced from the host (boardData.settings.
  // ddWagerBasisPlayerScore — see JeopardyBoard.jsx and the matching logic
  // in ClueModal.jsx's wager screen, which this mirrors). Off (default):
  // max wager = 2x the clue's own value. On: max wager = this player's own
  // team's current score (a team in debt can wager up to the size of its
  // debt, same as Final Jeopardy, rather than being floored to $0).
  const rawMaxWager = wagerBasisPlayerScore
    ? myTeamScore < 0
      ? Math.abs(myTeamScore)
      : myTeamScore
    : value * 2;
  const maxWager = Math.max(0, rawMaxWager);
  // House-rule toggle synced from the host (boardData.settings.ddMinWagerZero
  // — see JeopardyBoard.jsx). Off (default): min wager = the clue's own
  // value. On: min wager = $0. Clamped to maxWager so a team with less
  // headroom than the clue's face value still gets a valid range.
  const minWager = Math.min(minWagerZero ? 0 : value, maxWager);
  const parsed = parseInt(wagerInput, 10);
  const clamped = isNaN(parsed) ? minWager : Math.max(minWager, Math.min(parsed, maxWager));

  return (
    <>
      <div className="dd-title" style={{ fontSize: "1.6rem" }}>DAILY DOUBLE!</div>

      {wagerLocked ? (
        <div className="pv-clue-front-val">${wager}</div>
      ) : isSpecificPicker ? (
        wagerJustSubmitted ? (
          <div className="pv-clue-front-hint">Wager submitted — waiting for the host…</div>
        ) : (
          <div className="pv-dd-wager-form" onClick={(e) => e.stopPropagation()}>
            <div className="dd-step-label">Your wager (${minWager}–${maxWager})</div>
            <input
              type="number"
              className="dd-wager-input"
              min={minWager}
              max={maxWager}
              value={wagerInput}
              autoFocus
              onChange={(e) => setWagerInput(e.target.value)}
              onWheel={(e) => e.target.blur()}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  onSubmitWager(clamped);
                }
              }}
            />
            <button
              type="button"
              className="btn dd-confirm-btn"
              onClick={() => onSubmitWager(clamped)}
            >
              Lock In Wager (${clamped})
            </button>
          </div>
        )
      ) : (
        <div className="pv-clue-front-hint">Someone's placing their wager…</div>
      )}
    </>
  );
}

// Team scoreboard — now backed by the same TeamCard component the host
// uses (instead of a second, hand-rolled facepile), so speaking state,
// mute/deafen badges, and any future TeamCard changes automatically apply
// here too instead of needing to be built twice. Rendered fully read-only:
// editMode is always false, and every edit-only callback (rename, remove,
// setTeamScore, toggleTeamDiscordUser) is a no-op since players never
// touch team management — those controls simply never render because
// TeamCard only shows them when editMode is true.
function TeamScoreRow({ teams, joinedTeamId, pulseMap, compact, discordMembersByTeam, buzzStateByTeam }) {
  if (!teams?.length) return null;
  const sortedTeams = useMemo(() => {
    return [...teams].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
  }, [teams]);

  return (
    <div className={"pv-teams" + (compact ? " pv-teams-compact" : "")}>
      {sortedTeams.map((team, i) => {
        const buzzState = buzzStateByTeam?.[team.id];
        return (
          <div
            key={team.id}
            className={"pv-team-card-wrap" + (joinedTeamId === team.id ? " pv-team-mine" : "")}
          >
            <TeamCard
              team={team}
              teamIndex={i}
              editMode={false}
              selectedScoreTeamId={null}
              setSelectedScoreTeamId={() => {}}
              discordDisplayMode="discord"
              discordTeamMembers={discordMembersByTeam?.[team.id] || []}
              discordMembers={[]}
              toggleTeamDiscordUser={() => {}}
              removeTeam={() => {}}
              renameTeam={() => {}}
              setTeamScore={() => {}}
              scorePulse={pulseMap}
              buzzPosition={buzzState?.position ?? null}
              buzzIsActive={buzzState?.isActive ?? false}
              buzzIsStruck={buzzState?.isStruck ?? false}
            />
          </div>
        );
      })}
    </div>
  );
}

// Rendered on every player's device instead of the normal board grid +
// clue overlay whenever the current round is Final Jeopardy (`rd.type ===
// "final"`) — that round has no categories/clue grid at all, so it needs
// its own screen entirely, walked forward by rd.phase the same way the
// host's FinalJeopardyBoard.jsx is. Wager/answer inputs here submit via
// useFinalSync (submitFinalWager/submitFinalAnswer, passed down from
// PlayerBoard below) — same parallel-submission model as this file's own
// DailyDoubleFront, just without a single "picker" gate since every team
// wagers/answers at once in Final Jeopardy.
//
// "clue" and "answer" are rendered as ONE screen below (no more
// write-it-on-paper interstitial) — players get the answer box the
// moment the clue appears and can submit any time up to the host's
// "Time's Up" click; rd.phase still flips clue -> answer underneath for
// the host's own flow, it just doesn't change what the player sees.
// During "reveal", every player's screen mirrors the host's judging
// card (current team + their answer + wager) plus a running history of
// already-judged teams (rd.results), so the reveal is a shared moment
// instead of something only visible on the host's screen.
// Standalone, simplified media resolver for Final Jeopardy's question/
// answer media — ported from the host's FinalMediaPlayer
// (FinalJeopardyBoard.jsx). The host had this all along; it was just
// never built on the player side, which is why a host-attached Google
// Drive (or any other) media link on the Final Jeopardy question/answer
// only ever showed up on the host's screen. Same resolve → detect →
// render cascade as the host: resolve the ref/URL, detect image vs
// video vs audio (falling back through the cascade on error), render
// the matching player. Renders nothing if there's no media set.
function FinalMediaPlayer({ mediaRef, mediaType, className }) {
  const [url, setUrl] = useState("");
  const [renderAs, setRenderAs] = useState("");
  const [playing, setPlaying] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let toRevoke = "";

    async function resolve() {
      const resolvedUrl = mediaRef ? await getMediaUrl(mediaRef) : "";
      if (cancelled) {
        if (resolvedUrl && resolvedUrl.startsWith("blob:")) URL.revokeObjectURL(resolvedUrl);
        return;
      }
      if (resolvedUrl && resolvedUrl.startsWith("blob:")) toRevoke = resolvedUrl;
      setUrl(resolvedUrl);

      let type = mediaType;
      if (!type && isGoogleDriveUrl(mediaRef)) {
        const fileId = extractGoogleDriveFileId(mediaRef);
        type = fileId ? await resolveGoogleDriveMediaType(fileId) : "";
      }
      if (!type) type = resolvedUrl ? "image" : "";
      if (!cancelled) setRenderAs(type);
    }
    resolve();

    return () => {
      cancelled = true;
      setPlaying(false);
      if (toRevoke) URL.revokeObjectURL(toRevoke);
    };
  }, [mediaRef, mediaType]);

  // Mirrors the host's identical fix (FinalJeopardyBoard.jsx) — Final
  // Jeopardy media manages its own local play state per-device with no
  // host-driven sync, so it needs to duck this player's own BGM directly
  // off `playing` rather than off any shared clue-play signal. Images
  // don't produce sound, so only video/audio hold the duck.
  const duckReleaseRef = useRef(null);
  useEffect(() => {
    const audible = (renderAs === "video" || renderAs === "audio") && playing;
    if (audible && !duckReleaseRef.current) {
      duckReleaseRef.current = holdBgmDuck();
    } else if (!audible && duckReleaseRef.current) {
      duckReleaseRef.current();
      duckReleaseRef.current = null;
    }
    return () => {
      if (duckReleaseRef.current) {
        duckReleaseRef.current();
        duckReleaseRef.current = null;
      }
    };
  }, [renderAs, playing]);

  if (!url || !renderAs) return null;

  return (
    <div className={"pv-clue-media" + (className ? ` ${className}` : "")}>
      {renderAs === "image" && <img src={url} alt="" onError={() => setRenderAs("video")} />}
      {renderAs === "video" &&
        (isYoutubeUrl(url) ? (
          // Same CSP escape hatch the host uses (FinalJeopardyBoard.jsx) —
          // YouTube can't be embedded inside the Activity, so open it in
          // the player's real browser instead.
          <div
            className="pv-final-youtube-external"
            onClick={() => window.open(url, "_blank", "noopener,noreferrer")}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter") window.open(url, "_blank", "noopener,noreferrer");
            }}
          >
            <div className="pv-final-youtube-external-label">Watch on YouTube</div>
          </div>
        ) : (
          <CustomVideoPlayer src={url} onError={() => setRenderAs("audio")} isPlaying={playing} onPlayStateChange={(p) => setPlaying(p)} />
        ))}
      {renderAs === "audio" && (
        <CustomAudioPlayer src={url} isPlaying={playing} onPlayStateChange={(p) => setPlaying(p)} />
      )}
    </div>
  );
}

// Same six phases as the host's FINAL_PHASES in FinalJeopardyBoard.jsx —
// kept in sync manually since these live in separate files/bundles, not
// shared through an import. Read-only here: players never drive rd.phase,
// they just watch it, so there's no interaction to wire up.
const FINAL_PHASES = [
  { key: "category", label: "Category" },
  { key: "wager", label: "Wager" },
  { key: "clue", label: "Clue" },
  { key: "answer", label: "Answer" },
  { key: "reveal", label: "Reveal" },
  { key: "done", label: "Done" },
];

function FinalProgressStepper({ phase }) {
  const currentIndex = FINAL_PHASES.findIndex((fp) => fp.key === phase);
  return (
    <div className="pv-final-progress-stepper">
      {FINAL_PHASES.map((p, i) => {
        const state = i < currentIndex ? "done" : i === currentIndex ? "active" : "upcoming";
        return (
          <React.Fragment key={p.key}>
            <div className={`pv-final-progress-step is-${state}`}>
              <span className="pv-final-progress-step-dot">{state === "done" ? "✓" : i + 1}</span>
              <span className="pv-final-progress-step-label">{p.label}</span>
            </div>
            {i < FINAL_PHASES.length - 1 && (
              <div className={`pv-final-progress-connector${state === "done" ? " is-done" : ""}`} />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}

function FinalJeopardyView({ rd, joinedTeam, teams, submitFinalWager, submitFinalAnswer, discordMembersByTeam, players, playerStats }) {
  const myTeamId = joinedTeam?.teamId;
  const myTeam = teams.find((t) => t.id === myTeamId);
  const [wagerInput, setWagerInput] = useState("");
  const [wagerSubmitted, setWagerSubmitted] = useState(false);
  const [answerInput, setAnswerInput] = useState("");
  const [answerSubmitted, setAnswerSubmitted] = useState(false);

  // Reset local draft state whenever we leave the phase group it belongs
  // to, so a leftover value from a *previous* Final Jeopardy round never
  // bleeds into the next one (same idea as PlayerBoard's wagerInput reset
  // on activeClue change). "clue" and "answer" are grouped as one
  // "collecting" phase here — players now type their answer as soon as
  // the clue appears, so that transition must NOT wipe their draft.
  const answerPhaseGroup = rd.phase === "clue" || rd.phase === "answer" ? "collecting" : rd.phase;

  useEffect(() => {
    setWagerInput("");
    setWagerSubmitted(false);
  }, [rd.phase]);

  useEffect(() => {
    setAnswerInput("");
    setAnswerSubmitted(false);
  }, [answerPhaseGroup]);

  // Celebration SFX fires once for every player too, right when Final
  // Standings appears — mirrors the same guarded effect on the host side
  // (FinalJeopardyBoard.jsx), each side plays its own copy locally since
  // rd.standingsRevealed is already synced state, no extra broadcast needed.
  const standingsSfxFiredRef = useRef(rd.standingsRevealed);
  useEffect(() => {
    if (rd.standingsRevealed && !standingsSfxFiredRef.current) {
      standingsSfxFiredRef.current = true;
      playStandingsCelebration(rd.standingsSfxUrl);
    } else if (!rd.standingsRevealed) {
      standingsSfxFiredRef.current = false;
      stopStandingsCelebration();
    }
  }, [rd.standingsRevealed]);

  // Belt-and-suspenders: this view only renders while the current round
  // is Final Jeopardy (see PlayerBoard below), so it unmounts both when
  // the round changes AND when the player leaves the room entirely
  // (PlayerBoard/PlayerView unmounts along with it). Either way, a
  // celebration sound still playing at that moment shouldn't keep going
  // once this screen is gone.
  useEffect(() => {
    return () => stopStandingsCelebration();
  }, []);

  // Same preload fix as the host side (FinalJeopardyBoard.jsx) — starts
  // loading the custom celebration sound as soon as this Final Jeopardy
  // view is up, not just at the exact moment standings reveal. Each
  // player independently preloads from the same synced rd.standingsSfxUrl.
  useEffect(() => {
    preloadStandingsCelebration(rd.standingsSfxUrl);
  }, [rd.standingsSfxUrl]);

  // Separate, longer-lived duck: BGM should stay OFF for the entire time
  // Final Standings is on screen, not just for however long the
  // celebration sound itself plays — mirrors the same fix on the host
  // side. playStandingsCelebration's own duck (inside boardSfx.js) is
  // released as soon as that sound finishes, which left the BGM free to
  // fade back in mid-standings whenever the celebration clip was short
  // (e.g. the default built-in tone, ~1.5s). This hold opens the moment
  // standingsRevealed goes true and only releases when it goes false
  // again or this view unmounts.
  const standingsDuckReleaseRef = useRef(null);
  useEffect(() => {
    if (rd.standingsRevealed) {
      if (!standingsDuckReleaseRef.current) {
        standingsDuckReleaseRef.current = holdBgmDuck();
      }
    } else if (standingsDuckReleaseRef.current) {
      standingsDuckReleaseRef.current();
      standingsDuckReleaseRef.current = null;
    }
    return () => {
      if (standingsDuckReleaseRef.current) {
        standingsDuckReleaseRef.current();
        standingsDuckReleaseRef.current = null;
      }
    };
  }, [rd.standingsRevealed]);

  // Same batch-change and new-history-entry cues as the host's
  // FinalJeopardyBoard — each side plays its own copy locally since
  // currentRevealTeamIds/revealedTeamIds are already synced state. Fires
  // only when a genuinely new team enters the spotlight (not when the
  // batch merely shrinks as teams get judged one at a time) — see
  // FinalJeopardyBoard's matching effect for why.
  const prevRevealTeamIdsRef = useRef(rd.currentRevealTeamIds || []);
  const [justChangedTeam, setJustChangedTeam] = useState(false);
  useEffect(() => {
    const ids = rd.currentRevealTeamIds || [];
    const prevSet = new Set(prevRevealTeamIdsRef.current || []);
    const hasNewTeam = ids.some((id) => !prevSet.has(id));
    if (hasNewTeam) {
      playCatRevealSfx();
      setJustChangedTeam(true);
      const t = setTimeout(() => setJustChangedTeam(false), 1200);
      prevRevealTeamIdsRef.current = ids;
      return () => clearTimeout(t);
    }
    prevRevealTeamIdsRef.current = ids;
  }, [rd.currentRevealTeamIds]);

  const prevRevealedCountRef = useRef((rd.revealedTeamIds || []).length);
  const [justAddedTeamId, setJustAddedTeamId] = useState(null);
  useEffect(() => {
    const ids = rd.revealedTeamIds || [];
    if (ids.length > prevRevealedCountRef.current) {
      const newestId = ids[ids.length - 1];
      rd.results?.[newestId] ? playCorrectSfx() : playIncorrectSfx();
      setJustAddedTeamId(newestId);
      const t = setTimeout(() => setJustAddedTeamId(null), 1200);
      prevRevealedCountRef.current = ids.length;
      return () => clearTimeout(t);
    }
    prevRevealedCountRef.current = ids.length;
  }, [rd.revealedTeamIds?.length]);

  if (!myTeam) {
    return (
      <div className="pv-final-panel">
        <div className="pv-final-title">Final Jeopardy</div>
        <p className="pv-final-hint">You're not assigned to a team — ask the host to add you before Final Jeopardy.</p>
      </div>
    );
  }

  // Negative score: max wager is the size of the debt, so a correct
  // answer brings the team exactly back to $0 instead of being stuck
  // there for the rest of the game (see FinalJeopardyBoard's maxWager
  // for the matching host-side logic).
  const maxWager = myTeam.score < 0 ? Math.abs(myTeam.score) : myTeam.score;
  const myWagerLocked = rd.wagers?.[myTeamId] != null;
  const myAnswerLocked = rd.answers?.[myTeamId] != null;

  if (rd.phase === "category") {
    return (
      <div className="pv-final-panel">
        <FinalProgressStepper phase={rd.phase} />
        <div className="pv-final-title">Final Jeopardy</div>
        <p className="pv-final-hint pulse">Waiting for the host to reveal the category…</p>
      </div>
    );
  }

  if (rd.phase === "wager") {
    return (
      <div className="pv-final-panel">
        <FinalProgressStepper phase={rd.phase} />
        <div className="pv-final-category">{rd.category}</div>
        {myWagerLocked || wagerSubmitted ? (
          <p className="pv-final-hint pulse">Wager locked in — waiting for other teams…</p>
        ) : (
          <div className="pv-final-form" onClick={(e) => e.stopPropagation()}>
            <div className="pv-final-label">Your wager (max ${maxWager})</div>
            <input
              type="number"
              min={0}
              max={maxWager}
              value={wagerInput}
              autoFocus
              onChange={(e) => setWagerInput(e.target.value)}
              onWheel={(e) => e.target.blur()}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                const parsed = parseInt(wagerInput, 10);
                const clamped = isNaN(parsed) ? 0 : Math.max(0, Math.min(maxWager, parsed));
                submitFinalWager(clamped);
                setWagerSubmitted(true);
              }}
            />
            <button
              type="button"
              className="pv-btn pv-btn-primary"
              onClick={() => {
                const parsed = parseInt(wagerInput, 10);
                const clamped = isNaN(parsed) ? 0 : Math.max(0, Math.min(maxWager, parsed));
                submitFinalWager(clamped);
                setWagerSubmitted(true);
              }}
            >
              Lock In Wager
            </button>
          </div>
        )}
      </div>
    );
  }

  if (rd.phase === "clue" || rd.phase === "answer") {
    return (
      <div className="pv-final-panel">
        <FinalProgressStepper phase={rd.phase} />
        <div className="pv-final-category">{rd.category}</div>
        <p className="pv-final-clue-text">{rd.clue?.question || "(no question set)"}</p>
        <FinalMediaPlayer mediaRef={rd.clue?.mediaUrl} mediaType={rd.clue?.mediaType} />
        {myAnswerLocked || answerSubmitted ? (
          <p className="pv-final-hint pulse">Answer locked in — waiting for other teams…</p>
        ) : (
          <div className="pv-final-form" onClick={(e) => e.stopPropagation()}>
            <div className="pv-final-label">Your answer</div>
            <input
              type="text"
              value={answerInput}
              title={answerInput}
              autoFocus
              maxLength={300}
              onChange={(e) => setAnswerInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                submitFinalAnswer(answerInput);
                setAnswerSubmitted(true);
              }}
            />
            <button
              type="button"
              className="pv-btn pv-btn-primary"
              onClick={() => {
                submitFinalAnswer(answerInput);
                setAnswerSubmitted(true);
              }}
            >
              Lock In Answer
            </button>
          </div>
        )}
      </div>
    );
  }

  if (rd.phase === "reveal") {
    const activeIds = rd.currentRevealTeamIds || [];
    const activeTeams = activeIds.map((id) => teams.find((t) => t.id === id)).filter(Boolean);
    const revealedTeams = (rd.revealedTeamIds || []).map((id) => teams.find((t) => t.id === id)).filter(Boolean);
    const isMyTurnActive = activeTeams.some((t) => t.id === myTeamId);
    const isBatch = activeTeams.length > 1;
    const stage = rd.revealStage || "hidden"; // "hidden" -> "wager" -> "answer"
    return (
      <div className="pv-final-panel">
        <FinalProgressStepper phase={rd.phase} />
        <div className="pv-final-category">{rd.category}</div>
        {activeTeams.length > 0 ? (
          <div className={`pv-final-reveal-batch${isMyTurnActive ? " is-my-turn" : ""}${justChangedTeam ? " is-flash" : ""}`}>
            <span className="pv-final-reveal-eyebrow">
              {isMyTurnActive ? "It's your team's turn!" : isBatch ? `Now Revealing — ${activeTeams.length} Teams` : "Now Revealing"}
            </span>
            <div className={"pv-final-reveal-grid" + (isBatch ? "" : " is-single")}>
              {activeTeams.map((team) => (
                <div className={"pv-final-reveal-tile" + (team.id === myTeamId ? " is-mine" : "")} key={team.id}>
                  <TeamAvatarStack team={team} />
                  <span className="pv-final-reveal-team">{team.name}</span>
                  {stage === "hidden" && <p className="pv-final-hint pulse">Wager hidden…</p>}
                  {stage !== "hidden" && (
                    <span className="pv-final-reveal-wager">Wagered ${rd.wagers[team.id] || 0}</span>
                  )}
                  {stage === "answer" && (
                    <p className="pv-final-reveal-answer">“{rd.answers[team.id] || "(no answer)"}”</p>
                  )}
                </div>
              ))}
            </div>
            {stage === "wager" && (
              <p className="pv-final-hint pulse">Waiting for the host to reveal the answer{isBatch ? "s" : ""}…</p>
            )}
          </div>
        ) : (
          <p className="pv-final-hint pulse">Waiting for the host to choose who's up next…</p>
        )}
        {revealedTeams.length > 0 && (
          <div className="pv-final-reveal-history">
            {revealedTeams.map((t) => {
              const members = (discordMembersByTeam?.[t.id] || []).slice(0, 1);
              return (
                <div
                  className={`pv-final-reveal-history-row ${rd.results?.[t.id] ? "is-correct" : "is-incorrect"}${justAddedTeamId === t.id ? " is-flash" : ""}`}
                  key={t.id}
                >
                  <span className="pv-final-reveal-history-icon">{rd.results?.[t.id] ? "✓" : "✗"}</span>
                  {members.length > 0 ? (
                    <img src={members[0].avatarUrl} alt="" className="pv-final-reveal-history-avatar" />
                  ) : (
                    <div className="pv-final-reveal-history-avatar-fallback">{(t.name || "?").trim().charAt(0).toUpperCase()}</div>
                  )}
                  <span className="pv-final-standing-name">{t.name}</span>
                  <span className="pv-final-reveal-history-answer">“{rd.answers[t.id] || "(no answer)"}”</span>
                  <span className="pv-final-standing-score">${t.score}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  // "done"
  if (!rd.standingsRevealed) {
    return (
      <div className="pv-final-panel">
        <div className="pv-final-title">Final Jeopardy Is Over</div>
        <div className="pv-final-correct-answer-box">
          <span className="pv-final-correct-answer-label">The Correct Answer Was</span>
          <p className="pv-final-correct-answer-text">{rd.clue?.answer || "(no answer set)"}</p>
          <FinalMediaPlayer mediaRef={rd.clue?.answerMediaUrl} mediaType={rd.clue?.answerMediaType} className="pv-final-answer-media" />
        </div>
        <p className="pv-final-hint pulse">Standings coming up…</p>
      </div>
    );
  }

  // Group teams by score so ties share a rank/column instead of one team
  // arbitrarily landing a place above the other — same convention as the
  // host's FinalJeopardyBoard podium (standard competition ranking: two
  // teams tied for 1st both show "1", next distinct score is "3").
  const sorted = [...teams].sort((a, b) => b.score - a.score);
  const groups = [];
  for (const team of sorted) {
    const last = groups[groups.length - 1];
    if (last && last.score === team.score) {
      last.teams.push(team);
    } else {
      const rank = groups.reduce((n, g) => n + g.teams.length, 0) + 1;
      groups.push({ rank, score: team.score, teams: [team] });
    }
  }
  // Podium shows the top 3 distinct SCORE TIERS (mirrors the same fix on
  // the host's FinalJeopardyBoard) — not "whichever groups happen to have
  // rank <= 3". A 3-way tie for 2nd, under standard competition ranking,
  // consumes ranks 2/3/4 entirely, so filtering by rank <= 3 used to leave
  // the podium with only 2 columns even when a clear 3rd tier existed just
  // below. Taking the first 3 groups by score always fills the podium
  // (when ≥3 tiers exist); each badge still shows that group's real rank
  // (can legitimately read "5", same as an Olympic medal table skipping a
  // rank after a tie) — only left/center/right position and height are
  // decided by tier order, not by the rank number itself.
  const podiumGroups = groups.slice(0, 3);
  const restGroups = groups.slice(3);
  const podiumHeightByPosition = [190, 148, 116]; // gold, silver, bronze
  const podiumOrder = [podiumGroups[1], podiumGroups[0], podiumGroups[2]]
    .map((group) => (group ? { group, position: podiumGroups.indexOf(group) } : null))
    .filter(Boolean);

  function TeamAvatarStack({ team }) {
    const members = (discordMembersByTeam?.[team.id] || []).slice(0, 3);
    if (members.length === 0) {
      return (
        <div className="pv-podium-avatar-fallback">
          {(team.name || "?").trim().charAt(0).toUpperCase()}
        </div>
      );
    }
    return (
      <div className="pv-podium-avatar-stack">
        {members.map((m) => (
          <img
            key={m.id}
            src={m.avatarUrl}
            alt=""
            className={"pv-podium-avatar" + (m.speaking ? " is-speaking" : "")}
          />
        ))}
      </div>
    );
  }

  const hasPlayerStats = !!(
    players &&
    playerStats &&
    Object.keys(playerStats).length > 0 &&
    restGroups.length > 0 &&
    restGroups.some((g) => g.teams.some((t) => players.some((p) => p.teamId === t.id && playerStats[p.discordUserId])))
  );

  return (
    <div className={`pv-final-panel${hasPlayerStats ? " has-stats" : ""}`}>
      <div className="pv-final-title">Final Standings</div>

      <div className="pv-final-body">
        <div className="pv-final-standings-col">
          <div className="pv-podium-row">
            {podiumOrder.map(({ group, position }) => (
              <div key={group.rank} className={`pv-podium-col${position === 0 ? " is-first" : ""}`}>
                <div
                  className={
                    "pv-podium-team-list" +
                    (group.teams.length >= 7 ? " is-dense-lg" : group.teams.length >= 4 ? " is-dense" : "")
                  }
                >
                  {group.teams.map((team) => {
                    // Per-player correct/wrong (+ accuracy) — shown inline
                    // under the team name here instead of in a separate
                    // standalone panel, so a team's stats always sit right
                    // next to that team regardless of whether they landed
                    // on the podium or in the list below.
                    const teamPlayers =
                      players && playerStats
                        ? players.filter((p) => p.teamId === team.id && playerStats[p.discordUserId])
                        : [];
                    return (
                      <div className="pv-podium-team-entry" key={team.id}>
                        <TeamAvatarStack team={team} />
                        <div className="pv-podium-name-row">
                          <div className="pv-podium-name">{team.name}</div>
                          {teamPlayers.length > 0 && (
                            <div className="pv-podium-player-stats">
                              {teamPlayers.map((p) => {
                                const s = playerStats[p.discordUserId];
                                const total = (s.correct || 0) + (s.wrong || 0);
                                return (
                                  <span
                                    className="pv-podium-stat-pill"
                                    key={p.discordUserId}
                                    title={p.discordUsername || "Player"}
                                  >
                                    <span className="pv-podium-stat-correct">✓{s.correct || 0}</span>
                                    <span className="pv-podium-stat-wrong">✗{s.wrong || 0}</span>
                                    {total > 0 && (
                                      <span className="pv-podium-stat-accuracy">
                                        {Math.round((s.correct / total) * 100)}%
                                      </span>
                                    )}
                                  </span>
                                );
                              })}
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
                <div className="pv-podium-score">${group.score}</div>
                <div className="pv-podium-block" style={{ height: podiumHeightByPosition[position] }}>
                  <div className="pv-podium-rank">{group.rank}</div>
                </div>
              </div>
            ))}
          </div>

          {restGroups.length > 0 && (
            <div className="pv-final-rest-list">
              {restGroups.map((group) =>
                group.teams.map((t) => {
                  const teamPlayers =
                    players && playerStats
                      ? players.filter((p) => p.teamId === t.id && playerStats[p.discordUserId])
                      : [];
                  return (
                    <div className="pv-final-standing-row" key={t.id}>
                      <div className="pv-final-standing-row-main">
                        <span className="pv-final-standing-rank">{group.rank}</span>
                        <span className="pv-final-standing-name">{t.name}</span>
                        <span className="pv-final-standing-score">${t.score}</span>
                      </div>
                      {teamPlayers.length > 0 && (
                        <div className="pv-podium-player-stats pv-final-standing-player-stats">
                          {teamPlayers.map((p) => {
                            const s = playerStats[p.discordUserId];
                            const total = (s.correct || 0) + (s.wrong || 0);
                            return (
                              <span
                                className="pv-podium-stat-pill"
                                key={p.discordUserId}
                                title={p.discordUsername || "Player"}
                              >
                                <span className="pv-podium-stat-correct">✓{s.correct || 0}</span>
                                <span className="pv-podium-stat-wrong">✗{s.wrong || 0}</span>
                                {total > 0 && (
                                  <span className="pv-podium-stat-accuracy">
                                    {Math.round((s.correct / total) * 100)}%
                                  </span>
                                )}
                              </span>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function PlayerView() {
  // Unlocks audio on the player's very first tap/click anywhere, whether
  // they land on the join form or skip straight to the board via a
  // cached identity — see the hook's own comment for why this can't just
  // live inside handleJoin.
  useUnlockAudioOnFirstGesture();

  // Discord Activities run inside an iframe embedded in Discord's own UI.
  // On first load, keyboard focus sits on Discord's parent frame, not this
  // iframe — so keydown events (like the buzzer's spacebar shortcut) never
  // reach us until something inside the iframe grabs focus. A click does
  // that implicitly; this does it proactively so players don't have to
  // click first before Space works.
  useEffect(() => {
    window.focus();
  }, []);

  // Click/hover sfx is installed once at the App root (covers this join
  // form and every other screen in the app) — see App.jsx, not here.
  const [roomCode, setRoomCode] = useState(readRoomCodeFromUrl());
  const [nameInput, setNameInput] = useState("");
  const [me, setMe] = useState(null);

  // Resolve Discord identity as early as possible (mount), independent of
  // roomCode/name — so by the time someone hits "Join Game" we already
  // know their Discord username/avatar and can fall back to it if they
  // left the name field blank, instead of only finding out after submit.
  const [discordUser, setDiscordUser] = useState(null);
  const [discordChecked, setDiscordChecked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      let user = null;
      try {
        user = await getDiscordIdentity();
      } catch (err) {
        console.warn("Discord identity resolution failed, continuing without it:", err.message);
      }
      if (!cancelled) {
        setDiscordUser(user);
        setDiscordChecked(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!roomCode) return;
    const savedName = localStorage.getItem(`jeopardy:player:${roomCode}:name`);
    const savedId = localStorage.getItem(`jeopardy:player:${roomCode}:id`);
    const savedDiscordUser = localStorage.getItem(`jeopardy:player:${roomCode}:discordUser`);
    if (savedName && savedId) {
      setMe({
        id: savedId,
        username: savedName,
        discordUser: savedDiscordUser ? JSON.parse(savedDiscordUser) : null,
      });
    }
  }, [roomCode]);

  // The effect above can restore `me` from a PAST join, cached in
  // localStorage — including a null discordUser from back when Discord
  // auth wasn't working yet. That skips the join form entirely (see
  // `if (!me)` below), so nothing else ever gets a chance to attach a
  // freshly-resolved Discord identity to `me`. Once identity resolution
  // finishes, reconcile: if what we now know from Discord doesn't match
  // what's on `me`, update both `me` and the cached copy. This also
  // self-heals automatically if the user's Discord identity changes for
  // any other reason (re-auth, different account, etc.).
  useEffect(() => {
    if (!discordChecked || !me) return;
    const cached = me.discordUser;
    const fresh = discordUser;
    // Deep-compare, not just id — id staying the same doesn't mean nothing
    // changed. A prior session can have cached a discordUser with a missing
    // avatarUrl (e.g. identity resolution failed or raced last time), and
    // comparing ids only would leave that stale/blank avatar stuck forever
    // even after a fresh, fully-populated identity resolves this time.
    const changed =
      (cached?.id || null) !== (fresh?.id || null) ||
      (cached?.avatarUrl || null) !== (fresh?.avatarUrl || null) ||
      (cached?.username || null) !== (fresh?.username || null);
    if (!changed) return;

    const code = roomCode?.trim().toUpperCase();
    if (code) {
      if (fresh) {
        localStorage.setItem(`jeopardy:player:${code}:discordUser`, JSON.stringify(fresh));
      } else {
        localStorage.removeItem(`jeopardy:player:${code}:discordUser`);
      }
    }
    setMe((prev) => (prev ? { ...prev, discordUser: fresh } : prev));
  }, [discordChecked, discordUser, me, roomCode]);

  const [joining, setJoining] = useState(false);

  function handleJoin(e) {
    e.preventDefault();
    // Must run synchronously inside this gesture, before any async work
    // below — this is the player's first real tap, and it's what lets
    // every later SFX (triggered by incoming host events, not the
    // player's own clicks) actually play instead of being silently
    // blocked by the browser's autoplay policy.
    unlockAudioPlayback();
    const code = roomCode.trim().toUpperCase();
    // Blank name -> fall back to the resolved Discord username, if any.
    const name = nameInput.trim() || discordUser?.username || "";
    if (!code || !name) return;

    let id = localStorage.getItem(`jeopardy:player:${code}:id`);
    if (!id) {
      id = randomPlayerId();
      localStorage.setItem(`jeopardy:player:${code}:id`, id);
    }
    localStorage.setItem(`jeopardy:player:${code}:name`, name);

    if (discordUser) {
      localStorage.setItem(`jeopardy:player:${code}:discordUser`, JSON.stringify(discordUser));
    } else {
      localStorage.removeItem(`jeopardy:player:${code}:discordUser`);
    }

    setRoomCode(code);
    setMe({ id, username: name, discordUser });
  }

  if (!me) {
    const namePlaceholder = discordUser?.username
      ? `Leave blank to join as "${discordUser.username}"`
      : "How you'll appear on the buzzer";
    return (
      <div className="pv-root pv-center">
        <form className="pv-join-card" onSubmit={handleJoin}>
          <h1>Join a Game</h1>
          <label>
            Room Code
            <input
              value={roomCode}
              onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
              placeholder="e.g. K7QX9M"
              maxLength={8}
              autoCapitalize="characters"
              required
            />
          </label>
          <label>
            Your Name
            <input
              value={nameInput}
              onChange={(e) => setNameInput(e.target.value)}
              placeholder={namePlaceholder}
              maxLength={24}
            />
          </label>
          <button
            type="submit"
            className="pv-btn pv-btn-primary"
            disabled={joining || !discordChecked}
          >
            {!discordChecked ? "Checking Discord…" : joining ? "Joining…" : "Join Game"}
          </button>
        </form>
      </div>
    );
  }

  return (
    <PlayerBoard
      roomCode={roomCode}
      me={me}
      onRoomCodeChanged={(nextRoomCode) => {
        const oldRoomCode = roomCode;
        for (const suffix of ["id", "name", "discordUser"]) {
          const value = localStorage.getItem(`jeopardy:player:${oldRoomCode}:${suffix}`);
          if (value !== null) localStorage.setItem(`jeopardy:player:${nextRoomCode}:${suffix}`, value);
        }
        sessionStorage.setItem("jeopardy:active-player-room", nextRoomCode);
        sessionStorage.setItem("jeopardy:active-player-room-saved-at", String(Date.now()));
        const params = new URLSearchParams(window.location.search);
        params.set("room", nextRoomCode);
        window.history.replaceState({}, "", `/play?${params.toString()}`);
        setRoomCode(nextRoomCode);
      }}
      onLeave={() => {
        sessionStorage.removeItem("jeopardy:active-player-room");
        sessionStorage.removeItem("jeopardy:active-player-room-saved-at");
        window.history.pushState({}, '', '/');
        window.dispatchEvent(new PopStateEvent('popstate'));
      }}
    />
  );
}

function PlayerBoard({ roomCode, me, onRoomCodeChanged, onLeave }) {
  const { boardData, connected, activeClue, joinedTeam, revealedCats, roundBanner, players, bgm, randomizer, playerStats, leaveGame } = usePlayerSync(roomCode, me, onRoomCodeChanged);

  // The actual "I'm leaving" action. Tells the server immediately (skips
  // the disconnect grace period entirely, since this is deliberate),
  // wipes the cached identity so coming back to this room code starts
  // fresh instead of silently rejoining, then hands off to the parent's
  // onLeave for navigation.
  async function handleLeave() {
    await leaveGame();
    clearCachedIdentity(roomCode);
    onLeave();
  }

  // Click/hover sfx is installed once at the PlayerView root (covers the
  // join form too) — see there, not here.


  // The host plays a "reveal" sound locally (inside ClueModal) whenever it
  // flips the question card or toggles the answer — but that's a direct
  // local function call, not something published over the socket. The
  // underlying state IS already synced though (activeClue.flipped /
  // .revealed), so watch for those transitions here and play the same
  // category-reveal cue (same reveal-card.mp3 asset) locally instead of
  // needing a new event just for this.
  const prevClueFlagsRef = useRef({ flipped: false, revealed: false });
  useEffect(() => {
    const prev = prevClueFlagsRef.current;
    const flipped = !!activeClue?.flipped;
    const revealed = !!activeClue?.revealed;
    if (flipped !== prev.flipped || revealed !== prev.revealed) {
      if (flipped || revealed) playCatRevealSfx();
    }
    prevClueFlagsRef.current = { flipped, revealed };
  }, [activeClue?.flipped, activeClue?.revealed]);

  // Same idea for category reveals — revealedCats is already synced, the
  // host just never told anyone else to make a sound when it grows.
  const prevRevealedCountRef = useRef(0);
  useEffect(() => {
    const count = revealedCats?.length || 0;
    if (count > prevRevealedCountRef.current) playCatRevealSfx();
    prevRevealedCountRef.current = count;
  }, [revealedCats]);

  // The host side (ClueModal) matches buzz-queue entries against Discord
  // user ids — that's how it resolves which *team* is buzzed in and
  // highlights the right avatar in the per-team facepile. `me.id` is just
  // our own locally-generated `p_...` id and will never match a Discord
  // id, so if this player has a linked Discord identity, buzz in with
  // THAT id instead. `me.id` itself is left untouched everywhere else
  // (localStorage keys, usePlayerSync, team join logic, etc.) — this
  // only changes what goes out over the buzzer channel.
  const buzzerMe = useMemo(
    () => ({
      id: me.discordUser?.id || me.id,
      username: me.username,
      avatarUrl: me.discordUser?.avatarUrl,
    }),
    [me.id, me.username, me.discordUser?.id, me.discordUser?.avatarUrl]
  );

  const { queue, activePlayer, alreadyBuzzed, buzz, buzzerLive } = useBuzzer(roomCode, buzzerMe);

  // ── Cosmetics shop ────────────────────────────────────────────────────
  // The player's equipped loadout — fetched once on mount (if they have a
  // Discord identity, which is the stable key for the wallet). Refreshed
  // whenever the shop modal closes so equip changes take effect immediately.
  const [loadout, setLoadout] = useState({});
  const hasDiscordId = !!me.discordUser?.id;

  const refreshLoadout = useCallback(async () => {
    if (!hasDiscordId) return;
    try {
      const data = await fetchLoadout();
      setLoadout(data || {});
    } catch (_) { /* non-fatal — default sound plays if loadout fails */ }
  }, [hasDiscordId]);

  useEffect(() => { refreshLoadout(); }, [refreshLoadout]);

  // Custom buzz sound — plays locally when THIS player presses buzz,
  // giving instant tactile feedback before the server round-trip lands.
  // Falls back to nothing extra (the universal playBuzzSfx() in useBuzzer
  // still fires for everyone on the server echo). Only synth items are
  // supported client-side for now; file-based assets would need a fetch.
  const playCustomBuzzSound = useCallback(() => {
    const buzzItem = loadout.buzz_sound;
    if (!buzzItem?.data?.synth || !buzzItem.data.synthParams) return;
    try {
      const ctx = getSharedAudioCtx();
      if (!ctx) return;
      withRunningCtx(ctx, () => {
        const t0 = ctx.currentTime;
        const { type = 'square', startHz = 220, endHz = 440, durationMs = 200, volume = 0.2 } = buzzItem.data.synthParams;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type;
        osc.frequency.setValueAtTime(startHz, t0);
        osc.frequency.linearRampToValueAtTime(endHz, t0 + durationMs / 1000);
        gain.gain.setValueAtTime(0.0001, t0);
        gain.gain.exponentialRampToValueAtTime(volume, t0 + 0.01);
        gain.gain.exponentialRampToValueAtTime(0.0001, t0 + durationMs / 1000);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.onended = () => { osc.disconnect(); gain.disconnect(); };
        osc.start(t0);
        osc.stop(t0 + durationMs / 1000 + 0.05);
      });
    } catch (_) { /* best effort */ }
  }, [loadout]);

  // Wrap buzz() so custom sound fires at click time, before the server echo.
  const handleBuzz = useCallback(() => {
    playCustomBuzzSound();
    buzz();
  }, [playCustomBuzzSound, buzz]);

  // Board control: who's currently allowed to pick the next category/clue.
  // Keyed by discordUserId (same stable id buzzerMe already uses), NOT this
  // player's local `me.id` — see useControlSync.js for why.
  const { controlDiscordUserId, isMyTurn, selectClue } = useControlSync(roomCode, {
    discordUserId: buzzerMe.id,
  });

  // Whether THIS player specifically is the one who picked the current
  // clue — stricter than isMyTurn, which is also true under OPEN_CONTROL
  // ("anyone can pick"). A Daily Double wager belongs to one individual,
  // not "whoever anyone is" — under OPEN_CONTROL there's no single owner
  // to defer to, so the host falls back to picking a team manually
  // instead (see ClueModal.jsx), and no player's device should show a
  // wager form in that case.
  const isSpecificPicker = !!controlDiscordUserId && controlDiscordUserId !== OPEN_CONTROL && controlDiscordUserId === buzzerMe.id;

  // This player's own current score — only needed for the "max wager =
  // team score" Daily Double house rule (see DailyDoubleFront), computed
  // here rather than inline at the call site since it needs boardData.teams.
  const myTeam = boardData?.teams?.find((t) => t.id === joinedTeam?.teamId);

  const { submitWager } = useWagerSync(roomCode, { discordUserId: buzzerMe.id });

  // Final Jeopardy wager/answer submission — no "isSpecificPicker" gate
  // needed here (unlike submitWager above), since every team submits in
  // parallel. See FinalJeopardyView below for where these get called.
  const { submitFinalWager, submitFinalAnswer } = useFinalSync(roomCode, { discordUserId: buzzerMe.id });

  // Skills — cutscene plays for everyone; the host applies the score change.
  const {
    skillsUsed, skillsGranted, powerupsGranted, activeSkill, castSkill, clearActiveSkill,
    armedPowerups, frozenTeams, powerupNotice, clearPowerupNotice, hint, clearHint, activatePowerup,
  } = useSkillSync(roomCode, { discordUserId: buzzerMe.id });
  const equippedSkill = loadout.skill || null;
  // Unlocked in the shop, but only usable once the host's Power-ups spin grants it.
  const skillGranted = !!equippedSkill && (skillsGranted[buzzerMe.id] || []).includes(equippedSkill.id);
  const skillSpent = !!equippedSkill && (skillsUsed[buzzerMe.id] || []).includes(equippedSkill.id);
  // Power-ups (2x / Shield / Steal / Freeze / Hint / Re-Buzz) — usable both on
  // the board and mid-clue (unlike Domain Expansion, which locks during a clue).
  const myPowerups = powerupsGranted[buzzerMe.id] || [];
  const myHint = hint && hint.catId === activeClue?.catId && hint.value === activeClue?.value ? hint : null;

  // Display name for whoever currently holds the board, for the "whose
  // turn" indicator — resolved from the synced players roster rather than
  // carried separately, since the roster already has discordUserId +
  // discordUsername for everyone connected.
  const controlHolderName = useMemo(() => {
    if (!controlDiscordUserId) return null;
    const holder = players.find((p) => p.discordUserId === controlDiscordUserId);
    return holder?.discordUsername || null;
  }, [controlDiscordUserId, players]);

  // If the room code is wrong (or points at a board the host hasn't
  // opened yet), the socket still connects fine but boardData never
  // arrives — there's no server-side error to catch, just silence. Give
  // up waiting after a few seconds so the person isn't stuck on a
  // "waiting for host" screen with no way out short of restarting the
  // whole Discord Activity.
  const [waitTimedOut, setWaitTimedOut] = useState(false);
  useEffect(() => {
    if (boardData) {
      setWaitTimedOut(false);
      return;
    }
    const timer = setTimeout(() => setWaitTimedOut(true), 8000);
    return () => clearTimeout(timer);
  }, [boardData, roomCode]);

  const myPosition = useMemo(() => {
    const idx = queue.findIndex((p) => p.id === buzzerMe.id);
    return idx === -1 ? null : idx + 1;
  }, [queue, buzzerMe.id]);

  const iHaveFloor = activePlayer?.id === buzzerMe.id;

  const playersByTeam = useMemo(() => {
    const map = {};
    for (const p of players) {
      if (!p.teamId) continue;
      if (!map[p.teamId]) map[p.teamId] = [];
      map[p.teamId].push(p);
    }
    return map;
  }, [players]);

  // 0-based index of whoever currently holds the buzzer, derived from
  // `activePlayer` the same way ClueModal derives `buzzerActiveIndex` on
  // the host side (queue.findIndex against the winner's id) — the player
  // hook doesn't expose activeIndex directly since it's built for a
  // single participant's perspective, not an observer's.
  const buzzActiveIndex = useMemo(
    () => (activePlayer ? queue.findIndex((p) => p.id === activePlayer.id) : -1),
    [queue, activePlayer]
  );

  // Maps each team to its buzz-queue state: position (1-based) of the
  // earliest of its members currently buzzed in, whether that member is
  // the one currently holding the floor, and whether they've already had
  // their turn and been passed over. Mirrors the per-avatar badge logic
  // ClueModal runs on the host side, just rolled up to one badge per team
  // (TeamCard shows a single corner badge, not one per member) — if any
  // of the team's queued members is the active one, that member's spot
  // wins over an earlier-but-now-inactive one. Queue entries key off
  // `buzzerMe.id` (a Discord id when linked, otherwise the local
  // `p_...` id — see buzzerMe above), so a roster entry can match on
  // either its own id or its discordUserId.
  const buzzStateByTeam = useMemo(() => {
    if (!queue.length) return {};
    const idToTeam = {};
    for (const p of players) {
      if (!p.teamId) continue;
      idToTeam[p.id] = p.teamId;
      if (p.discordUserId) idToTeam[p.discordUserId] = p.teamId;
    }
    const map = {};
    queue.forEach((q, i) => {
      const teamId = idToTeam[q.id];
      if (!teamId) return;
      const isActive = !!activePlayer && activePlayer.id === q.id;
      const isStruck = !isActive && i < buzzActiveIndex;
      if (!map[teamId] || isActive) {
        map[teamId] = { position: i + 1, isActive, isStruck };
      }
    });
    return map;
  }, [queue, players, activePlayer, buzzActiveIndex]);

  // Live "who's talking" — same client-side SDK source useTeams.js uses on
  // the host side (see useSpeakingState.js). Every client independently
  // subscribes to the same voice channel's RPC events, so this needs no
  // socket relay to stay in sync with the host's view.
  const speakingIds = useSpeakingState();

  // Real mute/deafen state for everyone in the voice channel, sourced from
  // the bot server the same way the host does (useDiscordMembers) — not a
  // self-only check, so a teammate's mute badge shows up here too, live,
  // without needing a separate detection path. Degrades gracefully to an
  // empty list (badges just don't show, same as before) in standalone
  // browser mode where activityChannelId is null.
  const { members: voiceMembers } = useDiscordMembers(activityChannelId);
  const voiceStateById = useMemo(() => {
    const map = {};
    voiceMembers.forEach((m) => { map[m.id] = m; });
    return map;
  }, [voiceMembers]);

  // Reshapes playersByTeam (roster entries keyed by socket/team) into what
  // TeamCard expects: { id, avatarUrl, speaking, muted, deafened } per
  // member, keyed by teamId.
  const discordMembersByTeam = useMemo(() => {
    const map = {};
    Object.entries(playersByTeam).forEach(([teamId, roster]) => {
      map[teamId] = roster
        .filter((p) => p.discordUserId)
        .map((p) => {
          const voiceState = voiceStateById[p.discordUserId];
          return {
            id: p.discordUserId,
            avatarUrl: p.discordAvatarUrl,
            speaking: speakingIds.has(p.discordUserId),
            muted: !!voiceState?.muted,
            deafened: !!voiceState?.deafened,
          };
        });
    });
    return map;
  }, [playersByTeam, speakingIds, voiceStateById]);

  const openClue = useMemo(() => {
    if (!activeClue || !boardData || !boardData.rounds) return null;
    const rd = boardData.rounds[boardData.currentRound] || boardData.rounds[0];
    if (!rd || !rd.categories) return null;

    const cat = rd.categories.find((c) => c.id === activeClue.catId);
    const clue = cat?.clues?.[activeClue.value];
    if (!cat || !clue) return null;

    // activeClue is published verbatim by the host's useClueSync as
    // { catId, value, revealed, flipped, isPlaying, currentTime,
    // dailyDoubleWager } — no renaming happens in between, so map
    // straight off those fields. isDailyDouble itself isn't part of that
    // payload — it comes from boardData (already synced separately via
    // usePlayerSync), same as question/answer/media below.
    const questionRev = Boolean(activeClue.flipped);
    const answerRev = Boolean(activeClue.revealed);

    return {
      categoryName: cat.name,
      value: activeClue.value,
      // Mirrors ClueModal.jsx's `effectiveValue`: once a Daily Double's
      // wager is locked in, that number replaces the row's $ value
      // everywhere it's displayed (here, the back face) — `value` itself
      // is left untouched above since the front-face wager form still
      // needs the original row value to compute maxWager (2x it).
      effectiveValue: clue.isDailyDouble && activeClue.dailyDoubleWager != null ? activeClue.dailyDoubleWager : activeClue.value,
      question: clue.question,
      answer: clue.answer,
      questionRevealed: questionRev,
      revealed: answerRev,
      mediaUrl: clue.mediaUrl,
      mediaType: clue.mediaType,
      answerMediaUrl: clue.answerMediaUrl,
      answerMediaType: clue.answerMediaType,
      isPlaying: activeClue.isPlaying,
      currentTime: activeClue.currentTime,
      isDailyDouble: !!clue.isDailyDouble,
      dailyDoubleWager: activeClue.dailyDoubleWager ?? null,
    };
  }, [activeClue, boardData]);

  // Same "fire once per clue" Daily Double sting as ClueModal.jsx on the
  // host side — but host and player are separate processes/browsers, so
  // each needs its own trigger; this doesn't ride along with the host's.
  // Keyed off catId+value (mirrors ClueModal's clueId) rather than just
  // isDailyDouble, so it fires exactly once when the wager screen first
  // appears and doesn't refire on unrelated re-renders while it's up.
  const ddSfxFiredForClueRef = useRef(null);
  useEffect(() => {
    const clueId = activeClue ? `${activeClue.catId}-${activeClue.value}` : null;
    const wagerLocked = openClue?.dailyDoubleWager != null;
    if (openClue?.isDailyDouble && !wagerLocked && clueId && ddSfxFiredForClueRef.current !== clueId) {
      ddSfxFiredForClueRef.current = clueId;
      playDailyDoubleSfx();
    }
    // Stop the sting the moment this is no longer the live Daily Double
    // wager screen — the clue closed, the wager got locked in, the host
    // moved to a different clue, the round changed, or the player left
    // the room (unmount) — rather than letting up to ~1.2-2s of tail
    // keep playing into whatever's on screen now. Only fires if we
    // actually started a sting for the clue this effect run is about.
    return () => {
      if (ddSfxFiredForClueRef.current) stopDailyDoubleSfx();
    };
  }, [openClue?.isDailyDouble, openClue?.dailyDoubleWager, activeClue?.catId, activeClue?.value]);

  useEffect(() => {
    if (!activeClue && hint) clearHint();
  }, [activeClue, hint, clearHint]);

  const buzzDisabled = !buzzerLive || iHaveFloor || alreadyBuzzed;
  const buzzBarActive = buzzerLive || alreadyBuzzed || iHaveFloor;

  /* ---------------- LOCAL BOARD FLIP RIPPLE ----------------
     The host's disappear/reappear column ripple (useBoardGrid.js's
     boardFlip: "idle" -> "out" -> [data swaps] -> "in-start" -> "in")
     is timing-critical — the fade-out has to play on the OLD categories
     before they're replaced. Relaying that phase as its own broadcast
     would travel over a separate socket from the one that delivers the
     actual boardUpdate (new categories), with no guarantee which arrives
     first — so instead this runs the identical choreography locally,
     using the SAME constants as the host, triggered off `roundBanner`
     going null -> { phase: "in" }, which is already reliably delivered
     (it's just text, not timing-sensitive) and fires at the exact moment
     the host's switchRound() does.

     IMPORTANT: the "pop back in" (in-start -> in) must NOT fire on a
     fixed local timer alone. The host swaps its round data synchronously,
     in local memory, right as its own timer elapses — but the PLAYER only
     finds out about that swap once the real `boardUpdate` arrives over
     the network, which takes however long the round trip takes. A fixed
     timer here would assume that packet always arrives instantly, and
     under any real lag the board pops back in still showing the OLD
     numbers for a beat, only re-rendering once boardUpdate actually
     lands — which is exactly the "reappears too early" bug. So the
     reveal instead waits for BOTH: the minimum animation duration AND
     confirmation (via the boardData effect below) that
     boardData.currentRound has actually changed — whichever finishes
     last is what triggers the pop-in. A generous fallback timer still
     forces the reveal if boardUpdate is ever dropped entirely, so the
     board can't get stuck invisible forever. */
  const BANNER_HOLD_MS = 750; // must match useBoardGrid.js
  const FLIP_STAGGER_MS = 45; // must match useBoardGrid.js
  const FLIP_CELL_MS = 200; // must match useBoardGrid.js / board.css transition duration
  const SWAP_FALLBACK_MS = 2500; // safety net if boardUpdate never arrives

  const [boardFlip, setBoardFlip] = useState("idle");
  const flipTimeoutsRef = useRef([]);
  const prevBannerPhaseRef = useRef(null);
  const boardDataRef = useRef(boardData);
  boardDataRef.current = boardData;
  // Mutable flip-in-progress state shared between the two effects below —
  // refs (not state) since neither flag should trigger its own re-render,
  // they just gate when `revealBoard()` is allowed to fire.
  const flipStateRef = useRef({ awaitingSwap: false, minDurationDone: false, dataArrived: false, outDuration: 0 });

  function revealBoard() {
    const s = flipStateRef.current;
    if (!s.awaitingSwap || !s.minDurationDone || !s.dataArrived) return;
    s.awaitingSwap = false;
    setBoardFlip("in-start");
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        setBoardFlip("in");
        const tIdle = setTimeout(() => setBoardFlip("idle"), s.outDuration);
        flipTimeoutsRef.current.push(tIdle);
      });
    });
  }

  // Kicks off the fade-out the moment the round banner appears, then arms
  // the two gates (min duration + data arrival) that revealBoard() waits on.
  useEffect(() => {
    const prevPhase = prevBannerPhaseRef.current;
    prevBannerPhaseRef.current = roundBanner?.phase ?? null;

    // Only trigger on the null -> "in" transition (banner just appeared),
    // not on "in" -> "out" (banner already fading, flip already scheduled).
    if (roundBanner?.phase !== "in" || prevPhase != null) return;

    flipTimeoutsRef.current.forEach(clearTimeout);
    flipTimeoutsRef.current = [];

    const tOut = setTimeout(() => {
      setBoardFlip("out");

      // Column count for the OUTGOING round — read at the moment the fade
      // starts, same as the host reading `rd.categories.length` before swap.
      const roundBeforeSwitch = boardDataRef.current?.currentRound;
      const rd0 = boardDataRef.current?.rounds?.[roundBeforeSwitch];
      const catCount = rd0?.categories?.length || 1;
      const outDuration = (catCount - 1) * FLIP_STAGGER_MS + FLIP_CELL_MS;

      flipStateRef.current = { awaitingSwap: true, minDurationDone: false, dataArrived: false, outDuration, roundBeforeSwitch };

      const tMinDuration = setTimeout(() => {
        flipStateRef.current.minDurationDone = true;
        revealBoard();
      }, outDuration);
      flipTimeoutsRef.current.push(tMinDuration);

      // Safety net: force the reveal even if boardUpdate never shows up,
      // so a dropped packet can't leave the board invisible forever.
      const tFallback = setTimeout(() => {
        if (flipStateRef.current.awaitingSwap) {
          flipStateRef.current.dataArrived = true;
          revealBoard();
        }
      }, outDuration + SWAP_FALLBACK_MS);
      flipTimeoutsRef.current.push(tFallback);
    }, BANNER_HOLD_MS);
    flipTimeoutsRef.current.push(tOut);
  }, [roundBanner]);

  // Watches for the real round swap to actually land. Only matters while
  // we're mid-animation waiting on it (awaitingSwap) — otherwise a normal
  // boardUpdate (e.g. a clue being marked used) would false-trigger this.
  useEffect(() => {
    const s = flipStateRef.current;
    if (s.awaitingSwap && boardData?.currentRound !== s.roundBeforeSwitch) {
      s.dataArrived = true;
      revealBoard();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boardData?.currentRound]);

  useEffect(() => {
    return () => flipTimeoutsRef.current.forEach(clearTimeout);
  }, []);

  function flipDelay(catIndex) {
    return boardFlip === "idle" ? "0ms" : `${catIndex * FLIP_STAGGER_MS}ms`;
  }

  useEffect(() => {
    function handleKeyDown(e) {
      if (e.key !== " " && e.code !== "Space") return;
      const tag = e.target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || e.target?.isContentEditable) return;
      e.preventDefault();
      if (e.repeat || buzzDisabled) return;
      handleBuzz();
    }
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [buzzDisabled, handleBuzz]);

  const [mediaUrl, setMediaUrl] = useState("");
  const [renderAs, setRenderAs] = useState("");
  const [answerMediaUrl, setAnswerMediaUrl] = useState("");
  const [answerRenderAs, setAnswerRenderAs] = useState("");
  const [preparedMediaUrl, setPreparedMediaUrl] = useState("");
  const [mediaStatus, setMediaStatus] = useState("ready");
  const [mediaRetryCount, setMediaRetryCount] = useState(0);

  // Daily Double wager, entered on THIS device by whoever is the specific
  // picker (see isSpecificPicker above). `wagerJustSubmitted` covers the
  // gap between tapping "Lock In" and the round trip through the server
  // and back into openClue.dailyDoubleWager — without it, the form would
  // flash back open for a moment after submitting. Both reset whenever
  // the open clue's identity changes, same as the media state below,
  // so a leftover value/submitted-flag from a previous Daily Double never
  // bleeds into the next one.
  const [wagerInput, setWagerInput] = useState("");
  const [wagerJustSubmitted, setWagerJustSubmitted] = useState(false);
  useEffect(() => {
    setWagerInput("");
    setWagerJustSubmitted(false);
  }, [activeClue?.catId, activeClue?.value]);

  useEffect(() => {
    let cancelled = false;

    // Same fix as ClueModal.jsx: a stored mediaType wins if we have one.
    // Otherwise, for a Drive link specifically, ask the server what the
    // file's real mimeType is (cheap metadata-only call, no download)
    // instead of blindly guessing "image" first and cascading on error.
    // That guess-and-check was letting audio files silently succeed
    // inside the video player (a <video> tag will often play audio-only
    // bytes just fine) instead of ever reaching the audio player — this
    // view was the one place that guess-and-check hadn't been replaced
    // yet, which is why the host and player could disagree on the same
    // clue's media type.
    async function resolveRenderType(rawRef, resolvedUrl, storedType) {
      if (storedType) return storedType;
      if (isGoogleDriveUrl(rawRef)) {
        const fileId = extractGoogleDriveFileId(rawRef);
        const detected = fileId ? await resolveGoogleDriveMediaType(fileId) : "";
        if (detected) return detected;
      }
      return resolvedUrl ? "image" : "";
    }

    async function resolve() {
      const url = openClue?.mediaUrl ? await getMediaUrl(openClue.mediaUrl) : "";
      const aUrl = openClue?.answerMediaUrl ? await getMediaUrl(openClue.answerMediaUrl) : "";
      if (cancelled) return;
      setMediaUrl(url);
      setAnswerMediaUrl(aUrl);

      const [type, answerType] = await Promise.all([
        resolveRenderType(openClue?.mediaUrl, url, openClue?.mediaType),
        resolveRenderType(openClue?.answerMediaUrl, aUrl, openClue?.answerMediaType),
      ]);
      if (cancelled) return;
      setRenderAs(type);
      setAnswerRenderAs(answerType);
    }
    resolve();

    return () => {
      cancelled = true;
    };
  }, [openClue?.mediaUrl, openClue?.mediaType, openClue?.answerMediaUrl, openClue?.answerMediaType]);

  // Players prepare the same question media locally while the clue is still
  // hidden. This makes the status visible to everyone and lets the media
  // player reuse the already-downloaded blob after the host reveals it.
  useEffect(() => {
    let cancelled = false;
    let blobUrl = null;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 45000);

    setPreparedMediaUrl("");
    setMediaStatus(mediaUrl ? "preparing" : "ready");
    if (!mediaUrl || !renderAs || (renderAs === "video" && isYoutubeUrl(mediaUrl))) {
      if (mediaUrl && renderAs === "video" && isYoutubeUrl(mediaUrl)) {
        setPreparedMediaUrl(mediaUrl);
      }
      setMediaStatus("ready");
      return () => {
        controller.abort();
        clearTimeout(timeoutId);
      };
    }

    if (mediaUrl.startsWith("blob:") || mediaUrl.startsWith("data:")) {
      setPreparedMediaUrl(mediaUrl);
      setMediaStatus("ready");
      return () => {
        controller.abort();
        clearTimeout(timeoutId);
      };
    }

    fetch(mediaUrl, { signal: controller.signal, cache: "default" })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.blob();
      })
      .then((blob) => {
        if (cancelled) return;
        blobUrl = URL.createObjectURL(blob);
        setPreparedMediaUrl(blobUrl);
        setMediaStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setMediaStatus("error");
      })
      .finally(() => clearTimeout(timeoutId));

    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timeoutId);
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [mediaUrl, renderAs, mediaRetryCount]);

  const playerMediaSrc = preparedMediaUrl || mediaUrl;

  // Duck this player's own BGM while the clue's video/audio media is
  // actually sounding on this device. Unlike Final Jeopardy media (see
  // FinalMediaPlayer above), playback here is fully host-driven
  // (isPlaying={openClue.isPlaying}, disablePlayPause on every player)
  // rather than a local play state, so the duck just follows that same
  // flag directly instead of anything self-managed. Covers both normal
  // clues and Daily Double, since they share this exact rendering path —
  // this is the one that was missing entirely on the player side before
  // (the host already had this via ClueModal.jsx's onDuckMusic).
  const clueDuckReleaseRef = useRef(null);
  useEffect(() => {
    const questionAudible = !!mediaUrl && (renderAs === "video" || renderAs === "audio");
    const answerAudible =
      !!openClue?.revealed && !!answerMediaUrl && (answerRenderAs === "video" || answerRenderAs === "audio");
    const audible = !!openClue?.isPlaying && (questionAudible || answerAudible);
    if (audible && !clueDuckReleaseRef.current) {
      clueDuckReleaseRef.current = holdBgmDuck();
    } else if (!audible && clueDuckReleaseRef.current) {
      clueDuckReleaseRef.current();
      clueDuckReleaseRef.current = null;
    }
    return () => {
      if (clueDuckReleaseRef.current) {
        clueDuckReleaseRef.current();
        clueDuckReleaseRef.current = null;
      }
    };
  }, [openClue?.isPlaying, openClue?.revealed, mediaUrl, renderAs, answerMediaUrl, answerRenderAs]);

  const prevScoresRef = useRef({});
  const [pulseMap, setPulseMap] = useState({});

  useEffect(() => {
    if (!boardData?.teams) return;
    const changed = {};
    boardData.teams.forEach((team) => {
      const prev = prevScoresRef.current[team.id];
      if (prev !== undefined && prev !== team.score) {
        changed[team.id] = team.score > prev ? "pulse-up" : "pulse-down";
      }
      prevScoresRef.current[team.id] = team.score;
    });
    if (Object.keys(changed).length === 0) return;
    setPulseMap((m) => ({ ...m, ...changed }));
    // Same score-change detection that drives the pulse animation also
    // drives the sound — the host's adjustTeamScore() plays these locally
    // on its own machine only, so without this the player never hears
    // anything for a scoring event, even though the score change itself
    // (boardData.teams) is already synced.
    if (Object.values(changed).some((dir) => dir === "pulse-up")) playCorrectSfx();
    else playIncorrectSfx();
    const timers = Object.keys(changed).map((id) =>
      setTimeout(() => {
        setPulseMap((m) => {
          const copy = { ...m };
          delete copy[id];
          return copy;
        });
      }, 500)
    );
    return () => timers.forEach(clearTimeout);
  }, [boardData?.teams]);

  if (!boardData) {
    return (
      <div className="pv-root pv-center">
        <div className="pv-status">
          {waitTimedOut ? (
            <>
              <p>
                Couldn't find room {roomCode}. The code may be wrong, or the host hasn't opened this board yet.
              </p>
              <button className="btn gold" onClick={handleLeave}>
                Try a different code
              </button>
            </>
          ) : connected ? (
            `Connected. Waiting for the host's board (room ${roomCode})…`
          ) : (
            "Connecting…"
          )}
        </div>
      </div>
    );
  }

  const rd = boardData.rounds?.[boardData.currentRound] || boardData.rounds?.[0];

  if (!rd) {
    return (
      <div className="pv-root pv-center">
        <div className="pv-status">
          <p>Waiting for round configuration...</p>
          <button className="btn gold" onClick={handleLeave}>
            Leave
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="pv-root">
      {roundBanner && (
        <div className={"round-banner" + (roundBanner.phase === "out" ? " round-banner-out" : "")}>
          <MarqueeBulbs />
          <div className="round-banner-text">{roundBanner.text}</div>
        </div>
      )}

      <div className="pv-title-banner">
        <MarqueeBulbs />
        <div className="pv-title">{boardData.title || "Jeopardy"}</div>
      </div>
      <div className="pv-room-bar">
        Room {roomCode} · {me.username}
        <button className="btn" onClick={handleLeave} title="Leave and return to page selection">
          Leave
        </button>
      </div>

      <ShopWidget discordUserId={me.discordUser?.id} onChanged={refreshLoadout} />
      <SkillOverlay activeSkill={activeSkill} onDone={clearActiveSkill} />
      <PowerupNotice notice={powerupNotice} onDone={clearPowerupNotice} />

      {!openClue && rd.type !== "final" && (
        <div className={"pv-control-indicator" + (isMyTurn ? " pv-control-mine" : "")}>
          {isMyTurn
            ? "Your turn to pick a clue"
            : controlDiscordUserId
            ? `Waiting on ${controlHolderName || "another player"} to pick`
            : "Waiting for the host to open the board"}
        </div>
      )}

      {/* Floating Leave button — the room bar above gets covered by
          .pv-clue-overlay whenever a clue is open, which made "Leave"
          unreachable mid-question. This renders on top of the overlay
          (fixed position, high z-index in CSS) so players can always
          bail out, e.g. if the game freezes or they need to disconnect
          mid-clue, without waiting for the clue to close first. */}
      {openClue && (
        <button
          className="btn pv-leave-floating"
          onClick={handleLeave}
          title="Leave and return to page selection"
        >
          Leave
        </button>
      )}

      {openClue && (
        <div className="pv-clue-overlay">
          <div className="pv-clue-flip-outer">
            <div className={"pv-clue-flip-inner" + (openClue.questionRevealed ? " is-flipped" : "")}>
              <div className={"pv-clue-flip-face pv-clue-flip-front" + (openClue.isDailyDouble ? " pv-clue-daily-double" : "")}>
                {openClue.isDailyDouble && (
                  <div className="dd-sparkles" aria-hidden="true">
                    {Array.from({ length: 8 }).map((_, i) => (
                      <span key={i} className={`dd-sparkle dd-sparkle-${i}`} />
                    ))}
                  </div>
                )}
                <div className="pv-clue-front-cat">{openClue.categoryName}</div>
                {openClue.isDailyDouble ? (
                  <DailyDoubleFront
                    value={openClue.value}
                    wager={openClue.dailyDoubleWager}
                    isSpecificPicker={isSpecificPicker}
                    wagerInput={wagerInput}
                    setWagerInput={setWagerInput}
                    wagerJustSubmitted={wagerJustSubmitted}
                    minWagerZero={boardData.settings?.ddMinWagerZero}
                    wagerBasisPlayerScore={boardData.settings?.ddWagerBasisPlayerScore}
                    myTeamScore={myTeam?.score ?? 0}
                    onSubmitWager={(amount) => {
                      submitWager(amount);
                      setWagerJustSubmitted(true);
                    }}
                  />
                ) : (
                  <>
                    <div className="pv-clue-front-val">${openClue.value}</div>
                    <div className="pv-clue-front-hint">Waiting for host to reveal...</div>
                  </>
                )}
                <div className={"pv-media-readiness is-" + mediaStatus} role="status" aria-live="polite">
                  <span className="pv-media-readiness-dot" aria-hidden="true" />
                  {mediaStatus === "ready" && (mediaUrl ? "Media ready" : "Ready")}
                  {mediaStatus === "preparing" && "Preparing media..."}
                  {mediaStatus === "error" && (
                    <>
                      <span>Media is still loading</span>
                      <button
                        type="button"
                        className="pv-media-readiness-retry"
                        onClick={() => setMediaRetryCount((count) => count + 1)}
                      >
                        Retry
                      </button>
                    </>
                  )}
                </div>
              </div>

              <div className="pv-clue-flip-face pv-clue-flip-back">
                <div className="pv-clue-cat-value">
                  <div className="pv-clue-cat">{openClue.categoryName}</div>
                  <div className="pv-clue-value">${openClue.effectiveValue}</div>
                </div>
                <div className="pv-clue-question">{openClue.question || "(no question text set)"}</div>

                {playerMediaSrc && renderAs && (
                  <div className="pv-clue-media">
                    {renderAs === "image" && (
                      <img src={playerMediaSrc} alt="" onError={() => setRenderAs("video")} />
                    )}
                    {renderAs === "video" &&
                      (isYoutubeUrl(playerMediaSrc) ? (
                        <YoutubePlayer
                          src={playerMediaSrc}
                          disablePlayPause={true}
                          disableSeeking={true}
                          isPlaying={openClue.isPlaying}
                          currentTime={openClue.currentTime}
                        />
                      ) : (
                        <CustomVideoPlayer 
                          src={playerMediaSrc}
                          onError={() => setRenderAs("audio")} 
                          disablePlayPause={true}
                          disableSeeking={true}
                          isPlaying={openClue.isPlaying}
                          currentTime={openClue.currentTime}
                        />
                      ))}
                    {renderAs === "audio" && (
                      <CustomAudioPlayer 
                        src={playerMediaSrc}
                        disablePlayPause={true}
                        disableSeeking={true}
                        isPlaying={openClue.isPlaying}
                        currentTime={openClue.currentTime}
                      />
                    )}
                  </div>
                )}

                {openClue.revealed && (
                  <>
                    <div className="pv-clue-answer">{openClue.answer || "(no answer set)"}</div>
                    {answerMediaUrl && answerRenderAs && (
                      <div className="pv-clue-media pv-clue-answer-media">
                        {answerRenderAs === "image" && (
                          <img src={answerMediaUrl} alt="" onError={() => setAnswerRenderAs("video")} />
                        )}
                        {answerRenderAs === "video" &&
                          (isYoutubeUrl(answerMediaUrl) ? (
                            <YoutubePlayer
                              src={answerMediaUrl}
                              disablePlayPause={true}
                              disableSeeking={true}
                              isPlaying={openClue.isPlaying}
                              currentTime={openClue.currentTime}
                            />
                          ) : (
                            <CustomVideoPlayer 
                              src={answerMediaUrl} 
                              onError={() => setAnswerRenderAs("audio")} 
                              disablePlayPause={true}
                              disableSeeking={true}
                              isPlaying={openClue.isPlaying}
                              currentTime={openClue.currentTime}
                            />
                          ))}
                        {answerRenderAs === "audio" && (
                          <CustomAudioPlayer 
                            src={answerMediaUrl} 
                            disablePlayPause={true}
                            disableSeeking={true}
                            isPlaying={openClue.isPlaying}
                            currentTime={openClue.currentTime}
                          />
                        )}
                      </div>
                    )}
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="pv-clue-scoreboard">
            <PowerupTray
              inline
              items={myPowerups}
              armed={armedPowerups}
              frozenTeams={frozenTeams}
              teams={boardData.teams}
              myTeamId={joinedTeam?.teamId}
              inClue
              buzzerLive={buzzerLive}
              isFinal={false}
              hasControl={controlDiscordUserId === buzzerMe.id}
              hint={myHint}
              onUse={activatePowerup}
            />
            <BuzzStatusText
              buzzerLive={buzzerLive}
              iHaveFloor={iHaveFloor}
              alreadyBuzzed={alreadyBuzzed}
              myPosition={myPosition}
              className="pv-buzzer-status-compact"
            />
            <button
              className={"pv-buzz-btn pv-buzz-btn-side" + (buzzDisabled ? " pv-buzz-disabled" : "")}
              disabled={buzzDisabled}
              onClick={handleBuzz}
            >
              BUZZ
            </button>
            <div className="pv-scoreboard-title">SCOREBOARD</div>
            <TeamScoreRow teams={boardData.teams} joinedTeamId={joinedTeam?.teamId} pulseMap={pulseMap} discordMembersByTeam={discordMembersByTeam} buzzStateByTeam={buzzStateByTeam} compact />
          </div>
        </div>
      )}

      {randomizer?.active ? (
        <TeamRandomizer
            teams={boardData.teams}
            players={players}
            myDiscordUserId={me?.discordUser?.id ?? null}
            readOnly
            syncedState={randomizer}
          />
      ) : rd.type === "final" ? (
        <FinalJeopardyView
          rd={rd}
          joinedTeam={joinedTeam}
          teams={boardData.teams}
          submitFinalWager={submitFinalWager}
          submitFinalAnswer={submitFinalAnswer}
          discordMembersByTeam={discordMembersByTeam}
          players={players}
          playerStats={playerStats}
        />
      ) : (
        <div className="pv-board">
          {rd.categories.map((cat, catIndex) => {
            const isRevealed = revealedCats.includes(cat.id);
            return (
              <div
                key={cat.id}
                className={
                  "pv-cat" +
                  (isRevealed ? "" : " pv-cat-locked") +
                  (boardFlip === "out" ? " flip-out" : "") +
                  (boardFlip === "in-start" ? " flip-in-start" : "")
                }
                style={{ transitionDelay: flipDelay(catIndex) }}
              >
                <div className={"pv-cat-name" + (isRevealed ? " cat-name-reveal" : "")}>
                  {isRevealed ? cat.name || "—" : <span className="pv-cat-mark">?</span>}
                </div>
                <div className="pv-cells">
                  {rd.values.map((v) => {
                    const clue = cat.clues?.[v];
                    const pickable = !clue?.used && isMyTurn;
                    return (
                      <div
                        key={v}
                        className={"pv-cell" + (clue?.used ? " pv-used" : "") + (pickable ? " pv-pickable" : "")}
                        role={pickable ? "button" : undefined}
                        onClick={() => {
                          // Client-side gating is just for UX (cursor/dim
                          // state) — the server re-validates against
                          // controlDiscordUserId regardless, so this can't be
                          // bypassed by forcing the click through.
                          if (!pickable) return;
                          selectClue({ catId: cat.id, value: v });
                        }}
                      >
                        ${v}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {!openClue && !randomizer?.active && rd.type !== "final" && (
        <div className="pv-leaderboard-powerups">
          <PowerupTray
            inline
            items={myPowerups}
            armed={armedPowerups}
            frozenTeams={frozenTeams}
            teams={boardData.teams}
            myTeamId={joinedTeam?.teamId}
            inClue={false}
            buzzerLive={buzzerLive}
            isFinal={false}
            hasControl={controlDiscordUserId === buzzerMe.id}
            hint={myHint}
            onUse={activatePowerup}
          />
          {/* Domain Expansion lives here, and ONLY here — it's the one skill
              blocked from firing while a clue is open (see bot-server.js's
              useSkill handler), so it has no place in the in-clue tray.
              Once used it's just gone for the rest of the game, no "(used)"
              ghost button hanging around. */}
          {equippedSkill && skillGranted && !skillSpent && (
            <button
              type="button"
              className="pv-skill-btn pv-skill-btn--inline"
              disabled={!!activeSkill}
              onClick={() => castSkill(equippedSkill.id)}
              title={equippedSkill.description}
            >
              {equippedSkill.name}
            </button>
          )}
        </div>
      )}
      {!openClue && rd.type !== "final" && (
        <TeamScoreRow teams={boardData.teams} joinedTeamId={joinedTeam?.teamId} pulseMap={pulseMap} discordMembersByTeam={discordMembersByTeam} buzzStateByTeam={buzzStateByTeam} />
      )}

      <PlayerBgmWidget roomCode={roomCode} bgm={bgm} />
    </div>
  );
}