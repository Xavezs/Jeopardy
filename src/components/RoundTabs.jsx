import React from "react";
import MarqueeBulbs from "../lib/MarqueeBulbs";

export default function RoundTabs({ rounds, currentRound, onSwitchRound, roundBanner }) {
  return (
    <>
      <div className="round-tabs">
        {rounds.map((round, i) => (
          <button
            key={i}
            className={"round-tab" + (currentRound === i ? " active" : "")}
            onClick={() => onSwitchRound(i)}
          >
            {round.name}
          </button>
        ))}
      </div>

      {roundBanner && (
        <div className={"round-banner" + (roundBanner.phase === "out" ? " round-banner-out" : "")}>
          <MarqueeBulbs spacing={16} inset={7} radius={12} />
          <div className="round-banner-text">{roundBanner.text}</div>
        </div>
      )}
    </>
  );
}
