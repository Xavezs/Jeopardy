import React from "react";
import { youTubeEmbed } from "../lib/utils";

export default function ClueModal({ activeCat, value, clue, teams, revealed, onToggleReveal, onClose, onAdjustTeamScore }) {
  if (!activeCat || !clue) return null;

  return (
    <div
      className="modal-overlay"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose(false);
      }}
    >
      <div className="modal">
        <div className="clue-modal-header">{activeCat.name}</div>
        <div className="clue-value-big">${value}</div>
        <div className="clue-media">
          {clue.imageUrl && <img src={clue.imageUrl} alt="" />}
          {clue.videoUrl &&
            (youTubeEmbed(clue.videoUrl) ? (
              <iframe
                src={youTubeEmbed(clue.videoUrl)}
                allow="autoplay; encrypted-media; picture-in-picture"
                allowFullScreen
                title="clue-video"
              />
            ) : (
              <video src={clue.videoUrl} controls />
            ))}
          {clue.audioUrl && <audio src={clue.audioUrl} controls />}
        </div>
        <div className="clue-question">{clue.question || "(no question text set — edit this clue in Edit Board mode)"}</div>
        <div className={"clue-answer-box" + (revealed ? " show" : "")}>{clue.answer || "(no answer set)"}</div>
        <div className="clue-actions">
          <button className="btn gold" onClick={onToggleReveal}>
            {revealed ? "Hide Answer" : "Reveal Answer"}
          </button>
          <button className="btn" onClick={() => onClose(true)}>
            Mark Complete &amp; Close
          </button>
        </div>
        <div className="score-row">
          {teams.map((team) => (
            <div key={team.id} className="score-team-block">
              <div className="name">{team.name}</div>
              <div className="btns">
                <button className="plus" onClick={() => onAdjustTeamScore(team, value)}>
                  +{value}
                </button>
                <button className="minus" onClick={() => onAdjustTeamScore(team, -value)}>
                  −{value}
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
