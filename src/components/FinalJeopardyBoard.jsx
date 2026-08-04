// components/FinalJeopardyBoard.jsx
import React, { useState, useEffect, useRef } from "react";
import MediaField from "./MediaField";
import CustomAudioPlayer from "./CustomAudioPlayer";
import CustomVideoPlayer from "./CustomVideoPlayer";
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
import { playStandingsCelebration } from "../lib/boardSfx";

// Same escape hatch ClueModal uses — YouTube can't be embedded inside
// Discord's Activity CSP, so open it in the user's real browser instead.
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

/* =========================================================================
   FinalMediaPlayer
   Standalone, simplified version of ClueModal's media-resolving logic —
   no timer/buzzer machinery, just: resolve a stored ref/URL to a playable
   URL, detect image vs video vs audio (falling back through the cascade on
   error the same way ClueModal does), and render the matching player.
   Renders nothing if there's no media set for this field.
   ========================================================================= */
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

/* =========================================================================
   FinalJeopardyBoard
   Renders instead of <ClueGrid> whenever the current round has
   `type: "final"` (see JeopardyBoard.jsx). Walks the host through
   category -> wager -> clue -> answer -> reveal -> done, driven entirely
   by `rd.phase` (owned by useFinalJeopardy.js).

   Wager/answer inputs here are the HOST'S manual entry — the same fallback
   pattern ClueModal already uses for Daily Double. If a player submits
   from their own device instead (useFinalSync, wired in JeopardyBoard.jsx),
   that fills in rd.wagers/rd.answers directly and these inputs just show
   the value as already locked, same as DailyDoubleFront in PlayerView.jsx
   treats a wager that arrived from the picker's own device.
   ========================================================================= */
export default function FinalJeopardyBoard({ rd, editMode, teams, final, adjustTeamScore, appConfirm, appAlert }) {
  const [localAnswerDraft, setLocalAnswerDraft] = useState({});

  // Teams at or above $0 wager up to their score, as usual. Teams already
  // in the negative can wager up to the size of their debt — correct
  // brings them exactly back to $0, incorrect digs them further in. This
  // is the one case where "max wager" isn't just the score itself, since
  // Math.max(negativeScore, 0) would otherwise floor everyone below $0 to
  // a $0 max and strand them there for the rest of the game.
  const maxWager = (team) => (team.score < 0 ? Math.abs(team.score) : team.score);

  // Final Jeopardy's clue fields commit live (no separate Save step, unlike
  // EditClueModal) — question/answer text already work this way via
  // final.setClue({question}) on every keystroke. Media follows the same
  // pattern: read straight off rd, write straight back via the matching
  // setter. "standingsSfx" lives directly on rd (not rd.clue) since it's a
  // per-board customization rather than clue content — see useFinalJeopardy's
  // setStandingsSfx.
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
    // "standingsSfx"
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

  // Celebration SFX fires once, right when Final Standings appears — not on
  // every re-render while that screen stays up. Resets when
  // standingsRevealed goes back to false (e.g. final.resetFinal), so a
  // second playthrough in the same session still gets the sting.
  const standingsSfxFiredRef = useRef(rd.standingsRevealed);
  useEffect(() => {
    if (rd.standingsRevealed && !standingsSfxFiredRef.current) {
      standingsSfxFiredRef.current = true;
      playStandingsCelebration(rd.standingsSfxUrl);
    } else if (!rd.standingsRevealed) {
      standingsSfxFiredRef.current = false;
    }
  }, [rd.standingsRevealed]);

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
            placeholder="Final Jeopardy category…"
            disabled={!editMode}
            onChange={(e) => final.setCategory(e.target.value)}
          />
        ) : (
          <button className="final-category-hidden" onClick={final.revealCategory}>
            ? Reveal Category
          </button>
        )}
      </div>

      {editMode && (
        <div className="final-edit-clue">
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
          <MediaField
            label="Question media (optional) — image, video, or audio: paste a URL, or upload a file"
            type=""
            accept="image/*,video/*,audio/*"
            placeholder="https://... image, video, audio file, or a YouTube link"
            value={mediaValueFor("media")}
            onUrlChange={(url) => handleMediaUrlChange("media", url)}
            onFile={(file) => handleMediaFile("media", file)}
            onClear={() => handleClearMedia("media")}
            hint="The type (image / video / audio) is detected automatically."
          />
          <MediaField
            label="Answer media (optional) — shown alongside the answer when revealed"
            type=""
            accept="image/*,video/*,audio/*"
            placeholder="https://... image, video, audio file, or a YouTube link"
            value={mediaValueFor("answerMedia")}
            onUrlChange={(url) => handleMediaUrlChange("answerMedia", url)}
            onFile={(file) => handleMediaFile("answerMedia", file)}
            onClear={() => handleClearMedia("answerMedia")}
            hint="Optional — e.g. reveal a photo, clip, or sound as part of the answer."
          />
          <MediaField
            label="Final Standings celebration sound (optional) — plays for everyone (host + players) when standings are revealed"
            type=""
            accept="audio/*"
            placeholder="https://... audio file, or a Google Drive link"
            value={mediaValueFor("standingsSfx")}
            onUrlChange={(url) => handleMediaUrlChange("standingsSfx", url)}
            onFile={(file) => handleMediaFile("standingsSfx", file)}
            onClear={() => handleClearMedia("standingsSfx")}
            hint="Leave empty to use the built-in celebration sound."
          />
        </div>
      )}

      {!editMode && rd.phase === "wager" && (
        <div className="final-phase-panel">
          <h3 className="final-phase-title">Wagers</h3>
          <p className="final-phase-hint">Every team bets 0 up to their current score.</p>
          {teams.map((team) => (
            <div className="final-wager-row" key={team.id}>
              <span className="final-team-name">{team.name}</span>
              <span className="final-team-score">${team.score}</span>
              <input
                type="number"
                min={0}
                max={maxWager(team)}
                value={rd.wagers[team.id] ?? ""}
                placeholder="wager"
                onChange={(e) => {
                  const val = Math.max(0, Math.min(maxWager(team), parseInt(e.target.value, 10) || 0));
                  final.setWager(team.id, val);
                }}
              />
            </div>
          ))}
          <button
            className="final-advance-btn"
            disabled={teams.some((t) => rd.wagers[t.id] === undefined)}
            onClick={final.startClue}
          >
            Lock Wagers & Show Clue
          </button>
        </div>
      )}

      {!editMode && rd.phase === "clue" && (
        <div className="final-phase-panel final-clue-reveal">
          <p className="final-clue-text">{rd.clue.question}</p>
          <FinalMediaPlayer mediaRef={rd.clue.mediaUrl} mediaType={rd.clue.mediaType} />
          <p className="final-phase-hint">
            {teams.filter((t) => rd.answers[t.id] != null).length} / {teams.length} teams locked in
          </p>
          <button className="final-advance-btn" onClick={final.startAnswerPhase}>
            Time's Up — Collect Answers
          </button>
        </div>
      )}

      {!editMode && rd.phase === "answer" && (
        <div className="final-phase-panel">
          <h3 className="final-phase-title">Answers</h3>
          {teams.map((team) => (
            <div className="final-answer-row" key={team.id}>
              <span className="final-team-name">{team.name}</span>
              <input
                type="text"
                placeholder="What they answered…"
                value={localAnswerDraft[team.id] ?? rd.answers[team.id] ?? ""}
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
        const team = rd.currentRevealTeamId ? teams.find((t) => t.id === rd.currentRevealTeamId) : null;
        const remainingTeams = teams.filter((t) => !rd.revealedTeamIds.includes(t.id));
        const revealedTeams = rd.revealedTeamIds.map((id) => teams.find((t) => t.id === id)).filter(Boolean);
        return (
          <div className="final-phase-panel">
            {team ? (
              <div className="final-reveal-card">
                <span className="final-eyebrow">Now Revealing</span>
                <span className="final-team-name">{team.name}</span>
                <p className="final-clue-text">{rd.clue.question}</p>
                <FinalMediaPlayer mediaRef={rd.clue.mediaUrl} mediaType={rd.clue.mediaType} />
                <div className="final-correct-answer-box">
                  <span className="final-correct-answer-label">Correct Answer</span>
                  <p className="final-correct-answer-text">{rd.clue.answer || "(no answer set)"}</p>
                  <FinalMediaPlayer mediaRef={rd.clue.answerMediaUrl} mediaType={rd.clue.answerMediaType} className="final-answer-media" />
                </div>
                <p className="final-answer-text">“{rd.answers[team.id] || "(no answer)"}”</p>
                <p className="final-wager-text">Wagered ${rd.wagers[team.id] || 0}</p>
                <div className="final-judge-buttons">
                  <button className="final-correct-btn" onClick={() => final.judgeTeam(team, true, adjustTeamScore)}>
                    Correct
                  </button>
                  <button className="final-incorrect-btn" onClick={() => final.judgeTeam(team, false, adjustTeamScore)}>
                    Incorrect
                  </button>
                </div>
              </div>
            ) : (
              remainingTeams.length > 0 && (
                <div className="final-reveal-picker">
                  <h3 className="final-phase-title">Choose Who To Reveal Next</h3>
                  <p className="final-phase-hint">Pick any remaining team — order is entirely up to you.</p>
                  {remainingTeams.map((t) => (
                    <button
                      type="button"
                      key={t.id}
                      className="final-reveal-pick-row"
                      onClick={() => final.selectRevealTeam(t.id)}
                    >
                      <span className="final-team-name">{t.name}</span>
                      <span className="final-team-score">${t.score}</span>
                    </button>
                  ))}
                </div>
              )
            )}
            {revealedTeams.length > 0 && (
              <div className="final-reveal-history">
                <h4 className="final-reveal-history-title">Already Revealed</h4>
                {revealedTeams.map((t) => (
                  <div
                    className={`final-reveal-history-row ${rd.results?.[t.id] ? "is-correct" : "is-incorrect"}`}
                    key={t.id}
                  >
                    <span className="final-reveal-history-icon">{rd.results?.[t.id] ? "✓" : "✗"}</span>
                    <span className="final-team-name">{t.name}</span>
                    <span className="final-reveal-history-answer">“{rd.answers[t.id] || "(no answer)"}”</span>
                    <span className="final-team-score">${t.score}</span>
                  </div>
                ))}
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
          <button className="final-advance-btn" onClick={final.revealStandings}>
            Show Final Standings
          </button>
        </div>
      )}

      {!editMode && rd.phase === "done" && rd.standingsRevealed && (
        <div className="final-phase-panel final-standings">
          <h3 className="final-phase-title">Final Standings</h3>
          {[...teams].sort((a, b) => b.score - a.score).map((team, i) => (
            <div className={`final-standing-row${i === 0 ? " is-winner" : ""}`} key={team.id}>
              <span className="final-standing-rank">{ `${i + 1}`}</span>
              <span className="final-team-name">{team.name}</span>
              <span className="final-team-score">${team.score}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}