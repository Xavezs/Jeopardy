import React, { useState, useEffect, useRef } from "react";
import MediaField from "./MediaField";
import CustomAudioPlayer from "./CustomAudioPlayer";
import CustomVideoPlayer from "./CustomVideoPlayer";
import { useCountdown } from "../lib/hooks/useCountdown";
import { DEFAULT_FINAL_TIMER_SECONDS } from "../lib/hooks/useFinalJeopardy";
import { youTubeEmbed, isDataUrl, humanSize } from "../lib/utils";
import {
  getMediaUrl,
  isGoogleDriveUrl,
  extractGoogleDriveFileId,
  resolveGoogleDriveMediaType,
  MediaStore,
  isMediaRef,
  detectMediaTypeFromFile,
  detectMediaTypeFromUrl,
} from "../lib/storage";
import { discordSdk } from "../discordSdk";
import { playStandingsCelebration, stopStandingsCelebration, preloadStandingsCelebration, playCatRevealSfx, playCorrectSfx, playIncorrectSfx, holdBgmDuck } from "../lib/boardSfx";

// The six Final Jeopardy phases in order
const FINAL_PHASES = [
  { key: "category", label: "Category" },
  { key: "wager", label: "Wager" },
  { key: "clue", label: "Clue" },
  { key: "answer", label: "Answer" },
  { key: "reveal", label: "Reveal" },
  { key: "done", label: "Done" },
];

async function openYoutubeExternally(url) {
  try {
    if (discordSdk?.commands?.openExternalLink) {
      await discordSdk.commands.openExternalLink({ url });
      return;
    }
  } catch (err) {
    console.error('[FinalJeopardyBoard] openExternalLink failed, falling back to window.open:', err);
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

// FinalMediaPlayer
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
    <div className={"clue-media" + (className ? ` ${className}` : "")}>
      {renderAs === "image" && <img src={url} alt="" onError={() => setRenderAs("video")} />}
      {renderAs === "video" &&
        (youTubeEmbed(url) ? (
          <div
            className="clue-youtube-external"
            onClick={() => openYoutubeExternally(url)}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter") openYoutubeExternally(url);
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
            src={url}
            onError={() => setRenderAs("audio")}
            isPlaying={playing}
            onPlayStateChange={(p) => setPlaying(p)}
          />
        ))}
      {renderAs === "audio" && (
        <CustomAudioPlayer src={url} isPlaying={playing} onPlayStateChange={(p) => setPlaying(p)} />
      )}
    </div>
  );
}

// UndoLastJudgmentButton
function UndoLastJudgmentButton({ rd, teams, final, adjustTeamScore, appConfirm }) {
  const lastEntry = rd.judgeHistory[rd.judgeHistory.length - 1];
  const lastTeam = teams.find((t) => t.id === lastEntry.teamId);
  const sign = lastEntry.delta >= 0 ? "+" : "";
  return (
    <button
      type="button"
      className="final-undo-btn"
      onClick={async () => {
        const label = lastTeam?.name || "that team";
        if (
          await appConfirm(
            `Undo judging for "${label}"? This reverses ${sign}${lastEntry.delta} points and puts them back up for re-judging.`
          )
        ) {
          final.undoLastJudge(teams, adjustTeamScore);
        }
      }}
    >
      ↩ Undo Last Judgment{lastTeam ? ` (${lastTeam.name})` : ""}
    </button>
  );
}

// FinalRevealPicker
function FinalRevealPicker({ teams, wagers, answers, onConfirm }) {
  const [pendingIds, setPendingIds] = useState([]);

  useEffect(() => {
    setPendingIds((prev) => prev.filter((id) => teams.some((t) => t.id === id)));
  }, [teams]);

  function toggle(teamId) {
    setPendingIds((prev) => (prev.includes(teamId) ? prev.filter((id) => id !== teamId) : [...prev, teamId]));
  }

  const allSelected = teams.length > 0 && pendingIds.length === teams.length;

  const ordered = [...teams].sort((a, b) => a.score - b.score);
  const lowest = ordered[0];

  return (
    <div className="final-reveal-picker">
      <h3 className="final-phase-title">Choose Who To Reveal Next</h3>
      <p className="final-phase-hint">Lowest score first. Select one or more teams, then confirm — order is entirely up to you.</p>
      {ordered.length > 1 && lowest && (
        <button
          type="button"
          className="final-reveal-lowest-btn"
          onClick={() => {
            onConfirm([lowest.id]);
            setPendingIds([]);
          }}
        >
          Reveal Lowest Score — {lowest.name} (${lowest.score})
        </button>
      )}
      {teams.length > 1 && (
        <button
          type="button"
          className="final-reveal-select-all-btn"
          onClick={() => setPendingIds(allSelected ? [] : teams.map((t) => t.id))}
        >
          {allSelected ? "Deselect All" : "Select All"}
        </button>
      )}
      {ordered.map((t) => {
        const selected = pendingIds.includes(t.id);
        return (
          <button
            type="button"
            key={t.id}
            className={"final-reveal-pick-row" + (selected ? " is-selected" : "")}
            onClick={() => toggle(t.id)}
            aria-pressed={selected}
          >
            <div className="final-reveal-pick-header">
              <span className="final-reveal-pick-checkbox" aria-hidden="true">{selected ? "✓" : ""}</span>
              <span className="final-team-name">{t.name}</span>
              <span className="final-team-score">${t.score}</span>
            </div>
            <div className="final-reveal-pick-meta">
              <span className="final-reveal-pick-wager">Wagered ${wagers?.[t.id] ?? 0}</span>
              <span className="final-reveal-pick-answer">
                {answers?.[t.id]?.trim() ? answers[t.id] : "(no answer submitted)"}
              </span>
            </div>
          </button>
        );
      })}
      <button
        type="button"
        className="final-advance-btn"
        disabled={pendingIds.length === 0}
        onClick={() => {
          onConfirm(pendingIds);
          setPendingIds([]);
        }}
      >
        {pendingIds.length > 1
          ? `Reveal Selected (${pendingIds.length})`
          : pendingIds.length === 1
          ? "Reveal Selected Team"
          : "Reveal Selected"}
      </button>
    </div>
  );
}

// FinalJeopardyBoard
export default function FinalJeopardyBoard({ rd, editMode, teams, final, adjustTeamScore, appConfirm, appAlert, resolveDiscordMembersForTeam, players, playerStats }) {
  const [localAnswerDraft, setLocalAnswerDraft] = useState({});

  const [localWagerDraft, setLocalWagerDraft] = useState({});
  const [timerDraft, setTimerDraft] = useState(null);
  const [advancedMode, setAdvancedMode] = useState(false);

  // Answer countdown (rd.clueDeadline, set by startClue)
  const clueRemainingMs = useCountdown(!editMode && rd.phase === "clue" ? rd.clueDeadline ?? null : null);

  // Per-team point-award override for judging
  const [judgeCustomAmount, setJudgeCustomAmount] = useState({}); // teamId -> string (raw input)

  function resolveJudgeAmount(teamId, wager) {
    const raw = judgeCustomAmount[teamId];
    if (raw === undefined || raw === "") return wager;
    const n = Number(raw);
    return Number.isFinite(n) ? Math.max(0, n) : wager;
  }

  function clearJudgeAmount(teamId) {
    setJudgeCustomAmount((p) => {
      const next = { ...p };
      delete next[teamId];
      return next;
    });
  }

  const maxWager = (team) => (team.score < 0 ? Math.abs(team.score) : team.score);

  function commitWagerDraft(team) {
    const raw = localWagerDraft[team.id];
    if (raw === undefined) return;
    setLocalWagerDraft((p) => {
      const next = { ...p };
      delete next[team.id];
      return next;
    });
    if (raw === "") return;
    final.setWager(team.id, Math.max(0, Math.min(maxWager(team), parseInt(raw, 10) || 0)));
  }

  function commitTimerDraft() {
    if (timerDraft === null) return;
    const raw = timerDraft;
    setTimerDraft(null);
    if (raw === "") return;
    final.setTimerSeconds(parseInt(raw, 10) || 0);
  }

  function fieldAccessor(field) {
    if (field === "media") {
      return {
        url: rd.clue.mediaUrl,
        type: rd.clue.mediaType,
        commit: (url, type) => final.setClue({ mediaUrl: url, mediaType: type }),
      };
    }
    if (field === "answerMedia") {
      return {
        url: rd.clue.answerMediaUrl,
        type: rd.clue.answerMediaType,
        commit: (url, type) => final.setClue({ answerMediaUrl: url, answerMediaType: type }),
      };
    }
    return {
      url: rd.standingsSfxUrl,
      type: rd.standingsSfxType,
      commit: (url, type) => final.setStandingsSfx({ standingsSfxUrl: url, standingsSfxType: type }),
    };
  }

  function mediaValueFor(field) {
    const { url: existing, type } = fieldAccessor(field);
    if (isMediaRef(existing) || isDataUrl(existing)) {
      return { mode: "file", url: "", fileRef: existing, fileName: "File attached — remove to replace", fileType: type || "" };
    }
    return { mode: "url", url: existing || "", fileRef: "", fileName: "", fileType: "" };
  }

  function handleMediaUrlChange(field, url) {
    const { url: prevRef, commit } = fieldAccessor(field);
    if (isMediaRef(prevRef)) MediaStore.delete(prevRef);
    commit(url, url ? detectMediaTypeFromUrl(url) : "");
  }

  async function handleMediaFile(field, file) {
    if (!file) return;
    const proceed =
      file.size < 50 * 1024 * 1024 ||
      (await appConfirm(`"${file.name}" is ${humanSize(file.size)}. That's a large file — it may take a moment to store. Use it anyway?`));
    if (!proceed) return;
    try {
      const ref = await MediaStore.put(file);
      const fileType = detectMediaTypeFromFile(file);
      const { url: prevRef, commit } = fieldAccessor(field);
      if (isMediaRef(prevRef) && prevRef !== ref) MediaStore.delete(prevRef);
      commit(ref, fileType);
    } catch (e) {
      appAlert("Could not store that file — your browser may be blocking local storage (e.g. private browsing mode).");
    }
  }

  function handleClearMedia(field) {
    const { url: prevRef, commit } = fieldAccessor(field);
    if (isMediaRef(prevRef)) MediaStore.delete(prevRef);
    commit("", "");
  }

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
    preloadStandingsCelebration(rd.standingsSfxUrl);
  }, [rd.standingsSfxUrl]);

  useEffect(() => {
    return () => stopStandingsCelebration();
  }, []);

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

  const prevRevealedCountRef = useRef(rd.revealedTeamIds.length);
  const [justAddedTeamId, setJustAddedTeamId] = useState(null);
  useEffect(() => {
    const ids = rd.revealedTeamIds;
    if (ids.length > prevRevealedCountRef.current) {
      const newestId = ids[ids.length - 1];
      rd.results?.[newestId] ? playCorrectSfx() : playIncorrectSfx();
      setJustAddedTeamId(newestId);
      const t = setTimeout(() => setJustAddedTeamId(null), 1200);
      prevRevealedCountRef.current = ids.length;
      return () => clearTimeout(t);
    }
    prevRevealedCountRef.current = ids.length;
  }, [rd.revealedTeamIds.length]);

  return (
    <div className="final-jeopardy-board">
      <button
        type="button"
        className="final-reset-corner"
        title="Reset Final Jeopardy"
        onClick={async () => {
          if (await appConfirm("Reset Final Jeopardy? This clears the category, wagers, answers, and reveal progress.")) {
            final.resetFinal();
          }
        }}
      >
        ⟲ Reset
      </button>
      <div className="final-eyebrow">Final Jeopardy</div>
      <div className="final-category-banner">
        {editMode || rd.phase !== "category" ? (
          <input
            className="final-category-input"
            value={rd.category}
            placeholder="Final category…"
            disabled={!editMode}
            onChange={(e) => final.setCategory(e.target.value)}
          />
        ) : (
          <button className="final-category-hidden" onClick={final.revealCategory}>
            Reveal Category
          </button>
        )}
      </div>

      {/* Progress stepper */}
      {!editMode && rd.phase !== "done" && (
        <div className="final-progress-stepper">
          {FINAL_PHASES.map((p, i) => {
            const currentIndex = FINAL_PHASES.findIndex((fp) => fp.key === rd.phase);
            const state = i < currentIndex ? "done" : i === currentIndex ? "active" : "upcoming";
            return (
              <React.Fragment key={p.key}>
                <div className={`final-progress-step is-${state}`}>
                  <span className="final-progress-step-dot">{state === "done" ? "✓" : i + 1}</span>
                  <span className="final-progress-step-label">{p.label}</span>
                </div>
                {i < FINAL_PHASES.length - 1 && <div className={`final-progress-connector${state === "done" ? " is-done" : ""}`} />}
              </React.Fragment>
            );
          })}
        </div>
      )}

      {editMode && (
        <div className="final-edit-clue">
          <div className="final-edit-row">
            <textarea
              className="final-clue-input"
              placeholder="Question…"
              value={rd.clue.question}
              onChange={(e) => final.setClue({ question: e.target.value })}
            />
            <textarea
              className="final-clue-input"
              placeholder="Answer…"
              value={rd.clue.answer}
              onChange={(e) => final.setClue({ answer: e.target.value })}
            />
          </div>
          <div className="final-edit-row">
            <MediaField
              label="Question media (optional)"
              type=""
              accept="image/*,video/*,audio/*"
              placeholder="https://... image, video, audio file, or a Google Drive link"
              value={mediaValueFor("media")}
              onUrlChange={(url) => handleMediaUrlChange("media", url)}
              onFile={(file) => handleMediaFile("media", file)}
              onClear={() => handleClearMedia("media")}
              hint="Image, video, or audio — type is detected automatically."
            />
            <MediaField
              label="Answer media (optional)"
              type=""
              accept="image/*,video/*,audio/*"
              placeholder="https://... image, video, audio file, or a Google Drive link"
              value={mediaValueFor("answerMedia")}
              onUrlChange={(url) => handleMediaUrlChange("answerMedia", url)}
              onFile={(file) => handleMediaFile("answerMedia", file)}
              onClear={() => handleClearMedia("answerMedia")}
              hint="Shown alongside the answer when revealed."
            />
          </div>
          <div className="edit-clue-advanced-toggle-wrap final-edit-advanced-toggle-wrap">
            <button
              type="button"
              className={"edit-clue-advanced-toggle" + (advancedMode ? " is-active" : "")}
              onClick={() => setAdvancedMode((enabled) => !enabled)}
              aria-expanded={advancedMode}
            >
              {advancedMode ? "Hide advanced" : "Advanced mode"}
            </button>
          </div>
          {advancedMode && (
            <div className="final-edit-advanced">
              <div className="final-timer-setting">
                <label htmlFor="final-timer-seconds">Answer timer (seconds, 0 = off)</label>
                <input
                  id="final-timer-seconds"
                  type="number"
                  min={0}
                  max={300}
                  value={timerDraft ?? String(rd.timerSeconds ?? DEFAULT_FINAL_TIMER_SECONDS)}
                  onChange={(e) => setTimerDraft(e.target.value)}
                  onBlur={commitTimerDraft}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                  onWheel={(e) => e.target.blur()}
                />
              </div>
              <MediaField
                label="Celebration sound (optional)"
                type=""
                accept="audio/*"
                placeholder="https://... audio file, or a Google Drive link"
                value={mediaValueFor("standingsSfx")}
                onUrlChange={(url) => handleMediaUrlChange("standingsSfx", url)}
                onFile={(file) => handleMediaFile("standingsSfx", file)}
                onClear={() => handleClearMedia("standingsSfx")}
                hint="Plays for everyone when standings are revealed. Leave empty for the built-in sound."
              />
            </div>
          )}
        </div>
      )}

      {!editMode && rd.phase === "wager" && (() => {
        const notWagered = teams.filter((t) => rd.wagers[t.id] === undefined);
        return (
          <div className="final-phase-panel">
            <h3 className="final-phase-title">Wagers</h3>
            <p className="final-phase-hint">Every team bets 0 up to their current score.</p>
            <p className="final-phase-hint">
              {teams.length - notWagered.length} / {teams.length} teams wagered
            </p>
            {teams.map((team) => (
              <div className="final-wager-row" key={team.id}>
                <span className="final-team-name">{team.name}</span>
                <span className="final-team-score">${team.score}</span>
                <input
                  type="number"
                  min={0}
                  max={maxWager(team)}
                  value={localWagerDraft[team.id] ?? rd.wagers[team.id] ?? ""}
                  placeholder="wager (Enter)"
                  onChange={(e) => setLocalWagerDraft((p) => ({ ...p, [team.id]: e.target.value }))}
                  onBlur={() => commitWagerDraft(team)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") e.currentTarget.blur();
                  }}
                  onWheel={(e) => e.target.blur()}
                />
              </div>
            ))}
            {notWagered.length > 0 && (
              <p className="final-waiting-on">Waiting on: {notWagered.map((t) => t.name).join(", ")}</p>
            )}
            <button
              className="final-advance-btn"
              disabled={notWagered.length > 0}
              onClick={() => final.startClue()}
            >
              Lock Wagers & Show Clue
            </button>
            {notWagered.length > 0 && (
              <button
                className="final-advance-btn final-advance-btn--secondary"
                onClick={async () => {
                  const names = notWagered.map((t) => t.name).join(", ");
                  if (await appConfirm(`Continue without a wager from ${names}? They will bet $0.`)) {
                    final.startClue(teams);
                  }
                }}
              >
                Continue Anyway (missing = $0)
              </button>
            )}
          </div>
        );
      })()}

      {!editMode && rd.phase === "clue" && (() => {
        const notAnswered = teams.filter((t) => rd.answers[t.id] == null);
        const answeredCount = teams.length - notAnswered.length;
        return (
          <div className="final-phase-panel final-clue-reveal">
            <p className="final-clue-text">{rd.clue.question || "(no question set)"}</p>
            <FinalMediaPlayer mediaRef={rd.clue.mediaUrl} mediaType={rd.clue.mediaType} />
            {clueRemainingMs != null && (
              <div className={"final-timer" + (clueRemainingMs <= 0 ? " is-expired" : clueRemainingMs <= 10000 ? " is-low" : "")}>
                {clueRemainingMs <= 0 ? "Time's up!" : Math.ceil(clueRemainingMs / 1000)}
              </div>
            )}
            <p className="final-phase-hint">
              {answeredCount} / {teams.length} teams locked in
            </p>
            {notAnswered.length > 0 && (
              <p className="final-waiting-on">Waiting on: {notAnswered.map((t) => t.name).join(", ")}</p>
            )}
            <button
              className={"final-advance-btn" + (clueRemainingMs != null && clueRemainingMs <= 0 ? " final-advance-btn--urgent" : "")}
              onClick={final.startAnswerPhase}
            >
              Time's Up — Collect Answers
            </button>
          </div>
        );
      })()}

      {!editMode && rd.phase === "answer" && (
        <div className="final-phase-panel">
          <h3 className="final-phase-title">Answers</h3>
          {teams.map((team) => (
            <div className="final-answer-row" key={team.id}>
              <span className="final-team-name">{team.name}</span>
              <textarea
                rows={1}
                placeholder="What they answered…"
                value={localAnswerDraft[team.id] ?? rd.answers[team.id] ?? ""}
                title={localAnswerDraft[team.id] ?? rd.answers[team.id] ?? ""}
                onChange={(e) => setLocalAnswerDraft((p) => ({ ...p, [team.id]: e.target.value }))}
                onBlur={(e) => final.setAnswer(team.id, e.target.value)}
              />
            </div>
          ))}
          <button className="final-advance-btn" onClick={() => final.startReveal(teams)}>
            Begin Reveal
          </button>
        </div>
      )}

      {!editMode && rd.phase === "reveal" && (() => {
        const activeIds = rd.currentRevealTeamIds || [];
        const activeTeams = activeIds.map((id) => teams.find((t) => t.id === id)).filter(Boolean);
        const remainingTeams = teams.filter((t) => !rd.revealedTeamIds.includes(t.id));
        const revealedTeams = rd.revealedTeamIds.map((id) => teams.find((t) => t.id === id)).filter(Boolean);
        const stage = rd.revealStage || "hidden"; // "hidden" -> "wager" -> "answer"
        const isBatch = activeTeams.length > 1;
        return (
          <div className="final-phase-panel">
            {activeTeams.length > 0 ? (
              <div className={`final-reveal-batch${justChangedTeam ? " is-flash" : ""}`}>
                <span className="final-eyebrow">{isBatch ? `Now Revealing — ${activeTeams.length} Teams` : "Now Revealing"}</span>
                <p className="final-clue-text">{rd.clue.question || "(no question set)"}</p>
                <FinalMediaPlayer mediaRef={rd.clue.mediaUrl} mediaType={rd.clue.mediaType} />
                <div className="final-correct-answer-box">
                  <span className="final-correct-answer-label">Correct Answer</span>
                  <p className="final-correct-answer-text">{rd.clue.answer || "(no answer set)"}</p>
                  <FinalMediaPlayer mediaRef={rd.clue.answerMediaUrl} mediaType={rd.clue.answerMediaType} className="final-answer-media" />
                </div>

                <div className={"final-reveal-grid" + (isBatch ? "" : " is-single")}>
                  {activeTeams.map((team) => {
                    const members = (resolveDiscordMembersForTeam?.(team) || []).slice(0, 3);
                    return (
                      <div className="final-reveal-tile" key={team.id}>
                        {members.length > 0 ? (
                          <div className="final-reveal-avatar-stack">
                            {members.map((m) => (
                              <img
                                key={m.id}
                                src={m.avatarUrl}
                                alt=""
                                className={"final-reveal-avatar" + (m.speaking ? " is-speaking" : "")}
                              />
                            ))}
                          </div>
                        ) : (
                          <div className="final-reveal-avatar-fallback">{(team.name || "?").trim().charAt(0).toUpperCase()}</div>
                        )}
                        <span className="final-team-name">{team.name}</span>

                        {stage === "hidden" && <p className="final-phase-hint final-reveal-tile-hint">Wager hidden</p>}
                        {stage !== "hidden" && (
                          <p className="final-wager-text">Wagered ${rd.wagers[team.id] || 0}</p>
                        )}
                        {stage === "answer" && (
                          <p className="final-answer-text">“{rd.answers[team.id] || "(no answer)"}”</p>
                        )}

                        {stage === "answer" && (
                          <div className="final-judge-preset-row">
                            <label className="final-judge-custom-label" htmlFor={`judge-amt-${team.id}`}>
                              Points
                            </label>
                            <input
                              id={`judge-amt-${team.id}`}
                              type="number"
                              className="final-judge-custom-input"
                              placeholder={`${rd.wagers[team.id] || 0}`}
                              value={judgeCustomAmount[team.id] ?? ""}
                              onChange={(e) => setJudgeCustomAmount((p) => ({ ...p, [team.id]: e.target.value }))}
                              onWheel={(e) => e.target.blur()}
                            />
                          </div>
                        )}

                        {stage === "answer" && (
                          <div className="final-judge-buttons final-judge-buttons-tile">
                            <button
                              className="final-correct-btn"
                              onClick={() => {
                                final.judgeTeam(team, true, adjustTeamScore, resolveJudgeAmount(team.id, rd.wagers[team.id] || 0));
                                clearJudgeAmount(team.id);
                              }}
                            >
                              Correct
                            </button>
                            <button
                              className="final-incorrect-btn"
                              onClick={() => {
                                final.judgeTeam(team, false, adjustTeamScore, resolveJudgeAmount(team.id, rd.wagers[team.id] || 0));
                                clearJudgeAmount(team.id);
                              }}
                            >
                              Incorrect
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {stage === "hidden" && (
                  <button className="final-advance-btn" onClick={() => final.revealWager()}>
                    Reveal Wager{isBatch ? "s" : ""}
                  </button>
                )}

                {stage === "wager" && (
                  <button className="final-advance-btn" onClick={() => final.revealAnswer()}>
                    Reveal {isBatch ? "Their Answers" : "Their Answer"}
                  </button>
                )}

                {stage === "answer" && isBatch && (
                  <div className="final-judge-buttons final-judge-buttons-batch">
                    <button
                      className="final-correct-btn"
                      onClick={() => {
                        final.judgeBatch(teams, true, adjustTeamScore, (id, wager) => resolveJudgeAmount(id, wager));
                        activeTeams.forEach((t) => clearJudgeAmount(t.id));
                      }}
                    >
                      Mark All Correct
                    </button>
                    <button
                      className="final-incorrect-btn"
                      onClick={() => {
                        final.judgeBatch(teams, false, adjustTeamScore, (id, wager) => resolveJudgeAmount(id, wager));
                        activeTeams.forEach((t) => clearJudgeAmount(t.id));
                      }}
                    >
                      Mark All Incorrect
                    </button>
                  </div>
                )}
              </div>
            ) : (
              remainingTeams.length > 0 && (
                <FinalRevealPicker
                  teams={remainingTeams}
                  wagers={rd.wagers}
                  answers={rd.answers}
                  onConfirm={(ids) => final.startRevealBatch(ids)}
                />
              )
            )}
            {rd.judgeHistory?.length > 0 && (
              <UndoLastJudgmentButton
                rd={rd}
                teams={teams}
                final={final}
                adjustTeamScore={adjustTeamScore}
                appConfirm={appConfirm}
              />
            )}
            {revealedTeams.length > 0 && (
              <div className="final-reveal-history">
                <h4 className="final-reveal-history-title">Already Revealed</h4>
                {revealedTeams.map((t) => {
                  const members = (resolveDiscordMembersForTeam?.(t) || []).slice(0, 1);
                  return (
                    <div
                      className={`final-reveal-history-row ${rd.results?.[t.id] ? "is-correct" : "is-incorrect"}${justAddedTeamId === t.id ? " is-flash" : ""}`}
                      key={t.id}
                    >
                      <span className="final-reveal-history-icon">{rd.results?.[t.id] ? "✓" : "✗"}</span>
                      {members.length > 0 ? (
                        <img src={members[0].avatarUrl} alt="" className="final-reveal-history-avatar" />
                      ) : (
                        <div className="final-reveal-history-avatar-fallback">{(t.name || "?").trim().charAt(0).toUpperCase()}</div>
                      )}
                      <span className="final-team-name">{t.name}</span>
                      <span className="final-reveal-history-answer">“{rd.answers[t.id] || "(no answer)"}”</span>
                      <span className="final-team-score">${t.score}</span>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}

      {!editMode && rd.phase === "done" && !rd.standingsRevealed && (
        <div className="final-phase-panel final-standings">
          <h3 className="final-phase-title">Final Jeopardy Is Over</h3>
          <div className="final-correct-answer-box">
            <span className="final-correct-answer-label">The Correct Answer Was</span>
            <p className="final-correct-answer-text">{rd.clue.answer || "(no answer set)"}</p>
            <FinalMediaPlayer mediaRef={rd.clue.answerMediaUrl} mediaType={rd.clue.answerMediaType} className="final-answer-media" />
          </div>
          {rd.judgeHistory?.length > 0 && (
            <UndoLastJudgmentButton
              rd={rd}
              teams={teams}
              final={final}
              adjustTeamScore={adjustTeamScore}
              appConfirm={appConfirm}
            />
          )}
          <button className="final-advance-btn" onClick={final.revealStandings}>
            Show Final Standings
          </button>
        </div>
      )}

      {!editMode && rd.phase === "done" && rd.standingsRevealed && (() => {
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
        const podiumHeightByPosition = [210, 164, 128]; // gold, silver, bronze
        // Left-to-right: silver, gold, bronze
        const podiumOrder = [podiumGroups[1], podiumGroups[0], podiumGroups[2]]
          .map((group) => (group ? { group, position: podiumGroups.indexOf(group) } : null))
          .filter(Boolean);

        return (
          <div className="final-phase-panel final-standings">
            <h3 className="final-phase-title">Final Standings</h3>

            <div className="final-standings-body">
              <div className="final-standings-col">
                <div className="final-podium-row">
                  {podiumOrder.map(({ group, position }) => (
                    <div key={group.rank} className={`final-podium-col${position === 0 ? " is-first" : ""}`}>
                      <div
                        className={
                          "final-podium-team-list" +
                          (group.teams.length >= 7 ? " is-dense-lg" : group.teams.length >= 4 ? " is-dense" : "")
                        }
                      >
                        {group.teams.map((team) => {
                          const members = (resolveDiscordMembersForTeam?.(team) || []).slice(0, 3);
                          const teamPlayers =
                            players && playerStats
                              ? players.filter((p) => p.teamId === team.id && playerStats[p.discordUserId])
                              : [];
                          return (
                            <div className="final-podium-team-entry" key={team.id}>
                              {members.length > 0 ? (
                                <div className="final-podium-avatar-stack">
                                  {members.map((m) => (
                                    <img
                                      key={m.id}
                                      src={m.avatarUrl}
                                      alt=""
                                      className={"final-podium-avatar" + (m.speaking ? " is-speaking" : "")}
                                    />
                                  ))}
                                </div>
                              ) : (
                                <div className="final-podium-avatar-fallback">
                                  {(team.name || "?").trim().charAt(0).toUpperCase()}
                                </div>
                              )}
                              <div className="final-podium-name-row">
                                <div className="final-podium-name">{team.name}</div>
                                {teamPlayers.length > 0 && (
                                  <div className="final-podium-player-stats">
                                    {teamPlayers.map((p) => {
                                      const s = playerStats[p.discordUserId];
                                      const total = (s.correct || 0) + (s.wrong || 0);
                                      return (
                                        <span
                                          className="final-podium-stat-pill"
                                          key={p.discordUserId}
                                          title={p.discordUsername || "Player"}
                                        >
                                          <span className="final-podium-stat-correct">✓{s.correct || 0}</span>
                                          <span className="final-podium-stat-wrong">✗{s.wrong || 0}</span>
                                          {total > 0 && (
                                            <span className="final-podium-stat-accuracy">
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
                      <div className="final-podium-score">${group.score}</div>
                      <div className="final-podium-block" style={{ height: podiumHeightByPosition[position] }}>
                        <div className="final-podium-rank">{group.rank}</div>
                      </div>
                    </div>
                  ))}
                </div>

                {restGroups.length > 0 && (
                  <div className="final-rest-list">
                    {restGroups.map((group) =>
                      group.teams.map((team) => {
                        const teamPlayers =
                          players && playerStats
                            ? players.filter((p) => p.teamId === team.id && playerStats[p.discordUserId])
                            : [];
                        return (
                          <div className="final-standing-row" key={team.id}>
                            <div className="final-standing-row-main">
                              <span className="final-standing-rank">{group.rank}</span>
                              <span className="final-team-name">{team.name}</span>
                              <span className="final-team-score">${team.score}</span>
                            </div>
                            {teamPlayers.length > 0 && (
                              <div className="final-podium-player-stats final-standing-player-stats">
                                {teamPlayers.map((p) => {
                                  const s = playerStats[p.discordUserId];
                                  const total = (s.correct || 0) + (s.wrong || 0);
                                  return (
                                    <span
                                      className="final-podium-stat-pill"
                                      key={p.discordUserId}
                                      title={p.discordUsername || "Player"}
                                    >
                                      <span className="final-podium-stat-correct">✓{s.correct || 0}</span>
                                      <span className="final-podium-stat-wrong">✗{s.wrong || 0}</span>
                                      {total > 0 && (
                                        <span className="final-podium-stat-accuracy">
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
      })()}
    </div>
  );
}