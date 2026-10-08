import React, { useState, useEffect, useMemo, useRef, useCallback } from "react";
import "../styles/player.css";
import "../styles/board.css";
import { usePlayerSync } from "../lib/hooks/usePlayerSync";
import { useBuzzer } from "../lib/hooks/useBuzzer";
import { useControlSync, OPEN_CONTROL } from "../lib/hooks/useControlSync";
import { useWagerSync } from "../lib/hooks/useWagerSync";
import { useFinalSync } from "../lib/hooks/useFinalSync";
import { useCountdown } from "../lib/hooks/useCountdown";
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

// Called when the player deliberately leaves
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
  const rawMaxWager = wagerBasisPlayerScore
    ? myTeamScore < 0
      ? Math.abs(myTeamScore)
      : myTeamScore
    : value * 2;
  const maxWager = Math.max(0, rawMaxWager);
  // House-rule toggle synced from the host (boardData.settings.ddMinWagerZero
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

// Team scoreboard
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

  const answerPhaseGroup = rd.phase === "clue" || rd.phase === "answer" ? "collecting" : rd.phase;

  useEffect(() => {
    setWagerInput("");
    setWagerSubmitted(false);
  }, [rd.phase]);

  useEffect(() => {
    setAnswerInput("");
    setAnswerSubmitted(false);
  }, [answerPhaseGroup]);

  const remainingMs = useCountdown(rd.phase === "clue" ? rd.clueDeadline ?? null : null);
  const hasTimer = rd.clueDeadline != null;
  const timeIsUp = rd.phase === "answer" || (hasTimer && rd.phase === "clue" && remainingMs != null && remainingMs <= 0);
  const answersClosed = hasTimer && timeIsUp;

  useEffect(() => {
    if (!timeIsUp) return;
    if (!myTeamId || rd.answers?.[myTeamId] != null || answerSubmitted) return;
    if (!answerInput.trim()) return;
    submitFinalAnswer(answerInput);
    setAnswerSubmitted(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [timeIsUp]);

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

  useEffect(() => {
    return () => stopStandingsCelebration();
  }, []);

  useEffect(() => {
    preloadStandingsCelebration(rd.standingsSfxUrl);
  }, [rd.standingsSfxUrl]);

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
        {hasTimer && rd.phase === "clue" && remainingMs != null && (
          <div className={"pv-final-timer" + (remainingMs <= 0 ? " is-expired" : remainingMs <= 10000 ? " is-low" : "")}>
            {remainingMs <= 0 ? "Time's up!" : Math.ceil(remainingMs / 1000)}
          </div>
        )}
        {myAnswerLocked || answerSubmitted ? (
          <p className="pv-final-hint pulse">Answer locked in — waiting for other teams…</p>
        ) : answersClosed ? (
          <p className="pv-final-hint">Time's up — answers are closed.</p>
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
        {(stage === "answer" || revealedTeams.length > 0) && (rd.clue?.answer || rd.clue?.answerMediaUrl) && (
          <div className="pv-final-correct-answer-box">
            <span className="pv-final-correct-answer-label">The Correct Answer Is</span>
            {rd.clue?.answer && <p className="pv-final-correct-answer-text">{rd.clue.answer}</p>}
            <FinalMediaPlayer mediaRef={rd.clue?.answerMediaUrl} mediaType={rd.clue?.answerMediaType} className="pv-final-answer-media" />
          </div>
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
                    // Per-player correct/wrong (+ accuracy)
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
  useUnlockAudioOnFirstGesture();

  useEffect(() => {
    window.focus();
  }, []);

  const [roomCode, setRoomCode] = useState(readRoomCodeFromUrl());
  const [nameInput, setNameInput] = useState("");
  const [me, setMe] = useState(null);

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

  useEffect(() => {
    if (!discordChecked || !me) return;
    const cached = me.discordUser;
    const fresh = discordUser;
    // Deep-compare, not just id
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
    unlockAudioPlayback();
    const code = roomCode.trim().toUpperCase();
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

  // The actual "I'm leaving" action
  async function handleLeave() {
    await leaveGame();
    clearCachedIdentity(roomCode);
    onLeave();
  }


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

  const prevRevealedCountRef = useRef(0);
  useEffect(() => {
    const count = revealedCats?.length || 0;
    if (count > prevRevealedCountRef.current) playCatRevealSfx();
    prevRevealedCountRef.current = count;
  }, [revealedCats]);

  const buzzerMe = useMemo(
    () => ({
      id: me.discordUser?.id || me.id,
      username: me.username,
      avatarUrl: me.discordUser?.avatarUrl,
    }),
    [me.id, me.username, me.discordUser?.id, me.discordUser?.avatarUrl]
  );

  const { queue, activePlayer, alreadyBuzzed, buzz, buzzerLive } = useBuzzer(roomCode, buzzerMe);

  // Cosmetics shop
  const [loadout, setLoadout] = useState({});
  const hasDiscordId = !!me.discordUser?.id;

  const refreshLoadout = useCallback(async () => {
    if (!hasDiscordId) return;
    try {
      const data = await fetchLoadout();
      setLoadout(data || {});
    } catch (_) { }
  }, [hasDiscordId]);

  useEffect(() => { refreshLoadout(); }, [refreshLoadout]);

  // Custom buzz sound
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

  const handleBuzz = useCallback(() => {
    playCustomBuzzSound();
    buzz();
  }, [playCustomBuzzSound, buzz]);

  const { controlDiscordUserId, isMyTurn, selectClue } = useControlSync(roomCode, {
    discordUserId: buzzerMe.id,
  });

  const isSpecificPicker = !!controlDiscordUserId && controlDiscordUserId !== OPEN_CONTROL && controlDiscordUserId === buzzerMe.id;

  const myTeam = boardData?.teams?.find((t) => t.id === joinedTeam?.teamId);

  const { submitWager } = useWagerSync(roomCode, { discordUserId: buzzerMe.id });

  // Final Jeopardy wager/answer submission
  const { submitFinalWager, submitFinalAnswer } = useFinalSync(roomCode, { discordUserId: buzzerMe.id });

  // Skills
  const {
    skillsUsed, skillsGranted, powerupsGranted, activeSkill, castSkill, clearActiveSkill,
    armedPowerups, frozenTeams, powerupNotice, clearPowerupNotice, hint, clearHint, activatePowerup,
  } = useSkillSync(roomCode, { discordUserId: buzzerMe.id });
  const equippedSkill = loadout.skill || null;
  const skillGranted = !!equippedSkill && (skillsGranted[buzzerMe.id] || []).includes(equippedSkill.id);
  const skillSpent = !!equippedSkill && (skillsUsed[buzzerMe.id] || []).includes(equippedSkill.id);
  // Power-ups
  const myPowerups = powerupsGranted[buzzerMe.id] || [];
  const myHint = hint && hint.catId === activeClue?.catId && hint.value === activeClue?.value ? hint : null;

  const controlHolderName = useMemo(() => {
    if (!controlDiscordUserId) return null;
    const holder = players.find((p) => p.discordUserId === controlDiscordUserId);
    return holder?.discordUsername || null;
  }, [controlDiscordUserId, players]);

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

  const buzzActiveIndex = useMemo(
    () => (activePlayer ? queue.findIndex((p) => p.id === activePlayer.id) : -1),
    [queue, activePlayer]
  );

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

  // Live "who's talking"
  const speakingIds = useSpeakingState();

  const { members: voiceMembers } = useDiscordMembers(activityChannelId);
  const voiceStateById = useMemo(() => {
    const map = {};
    voiceMembers.forEach((m) => { map[m.id] = m; });
    return map;
  }, [voiceMembers]);

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

    const questionRev = Boolean(activeClue.flipped);
    const answerRev = Boolean(activeClue.revealed);

    return {
      categoryName: cat.name,
      value: activeClue.value,
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

  const ddSfxFiredForClueRef = useRef(null);
  useEffect(() => {
    const clueId = activeClue ? `${activeClue.catId}-${activeClue.value}` : null;
    const wagerLocked = openClue?.dailyDoubleWager != null;
    if (openClue?.isDailyDouble && !wagerLocked && clueId && ddSfxFiredForClueRef.current !== clueId) {
      ddSfxFiredForClueRef.current = clueId;
      playDailyDoubleSfx();
    }
    return () => {
      if (ddSfxFiredForClueRef.current) stopDailyDoubleSfx();
    };
  }, [openClue?.isDailyDouble, openClue?.dailyDoubleWager, activeClue?.catId, activeClue?.value]);

  useEffect(() => {
    if (!activeClue && hint) clearHint();
  }, [activeClue, hint, clearHint]);

  const buzzDisabled = !buzzerLive || iHaveFloor || alreadyBuzzed;
  const buzzBarActive = buzzerLive || alreadyBuzzed || iHaveFloor;

  // LOCAL BOARD FLIP RIPPLE
  const BANNER_HOLD_MS = 750; // must match useBoardGrid.js
  const FLIP_STAGGER_MS = 45; // must match useBoardGrid.js
  const FLIP_CELL_MS = 200;
  const SWAP_FALLBACK_MS = 2500;

  const [boardFlip, setBoardFlip] = useState("idle");
  const flipTimeoutsRef = useRef([]);
  const prevBannerPhaseRef = useRef(null);
  const boardDataRef = useRef(boardData);
  boardDataRef.current = boardData;
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

  useEffect(() => {
    const prevPhase = prevBannerPhaseRef.current;
    prevBannerPhaseRef.current = roundBanner?.phase ?? null;

    if (roundBanner?.phase !== "in" || prevPhase != null) return;

    flipTimeoutsRef.current.forEach(clearTimeout);
    flipTimeoutsRef.current = [];

    const tOut = setTimeout(() => {
      setBoardFlip("out");

      // Column count for the OUTGOING round
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

  const [wagerInput, setWagerInput] = useState("");
  const [wagerJustSubmitted, setWagerJustSubmitted] = useState(false);
  useEffect(() => {
    setWagerInput("");
    setWagerJustSubmitted(false);
  }, [activeClue?.catId, activeClue?.value]);

  useEffect(() => {
    let cancelled = false;

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

      {/* Floating Leave button */}
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
          {/* Domain Expansion lives here, and ONLY here */}
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