import React, { useState, useEffect } from "react";
import { youTubeEmbed } from "../lib/utils";
import { getMediaUrl } from "../lib/storage";

export default function ClueModal({ activeCat, value, clue, teams, revealed, onToggleReveal, onClose, onAdjustTeamScore }) {
  const [imgUrl, setImgUrl] = useState("");
  const [videoUrl, setVideoUrl] = useState("");
  const [audioUrl, setAudioUrl] = useState("");

  useEffect(() => {
    let cancelled = false;
    let urlsToRevoke = [];

    async function convertIds() {
      const [img, vid, aud] = await Promise.all([
        clue.imageUrl ? getMediaUrl(clue.imageUrl) : Promise.resolve(""),
        clue.videoUrl ? getMediaUrl(clue.videoUrl) : Promise.resolve(""),
        clue.audioUrl ? getMediaUrl(clue.audioUrl) : Promise.resolve(""),
      ]);
      if (cancelled) {
        // Clue changed again before this resolved — don't leak the object URLs we just made
        [img, vid, aud].forEach((u) => u && u.startsWith("blob:") && URL.revokeObjectURL(u));
        return;
      }
      urlsToRevoke = [img, vid, aud].filter((u) => u && u.startsWith("blob:"));
      setImgUrl(img);
      setVideoUrl(vid);
      setAudioUrl(aud);
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
        <div className="clue-modal-header">{activeCat.name}</div>
        <div className="clue-value-big">${value}</div>
        
        <div className="clue-media">
          {imgUrl && <img src={imgUrl} alt="" />}
          {videoUrl &&
            (youTubeEmbed(videoUrl) ? (
              <iframe
                src={youTubeEmbed(videoUrl)}
                allow="autoplay; encrypted-media; picture-in-picture"
                allowFullScreen
                title="clue-video"
              />
            ) : (
              <video src={videoUrl} controls />
            ))}
          {audioUrl && <audio src={audioUrl} controls />}
        </div>
        
        <div className="clue-question">{clue.question || "(no question text set — edit this clue in Edit Board mode)"}</div>
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