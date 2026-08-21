import React, { useState } from "react";
import "../styles/RoleSelect.css";

export default function RoleSelect({ onSelectHost, onSelectPlayer, defaultTeamName = "", isJoining = false }) {
  const [inputCode, setInputCode] = useState("");
  const [teamName, setTeamName] = useState(defaultTeamName);

  return (
    <div className="role-select-root">
      {/* Marquee-style title, matching the board's lit-sign header */}
      <div className="role-select-title-wrap">
        <h1 className="role-select-title">JEOPARDY!</h1>
        <p className="role-select-subtitle">Choose how you want to enter this session</p>
      </div>

      {/* Horizontal split card: Host on the left, Join on the right */}
      <div className="role-select-card">
        {/* Host panel */}
        <div className="role-select-panel host">
          <div>
            <h2 className="role-select-panel-title">Host / Manage Board</h2>
            <p className="role-select-panel-desc">
              Create or edit questions and run the game show.
            </p>
          </div>
          <button onClick={onSelectHost} className="role-select-host-btn">
            Enter as Host
          </button>
        </div>

        {/* Divider — vertical on desktop, horizontal on mobile, with an OR pill */}
        <div className="role-select-divider">
          <div className="role-select-divider-line" />
          <span className="role-select-divider-badge">OR</span>
        </div>

        {/* Player panel */}
        <div className="role-select-panel player">
          <div className="role-select-player-header">
            <h2 className="role-select-panel-title">Join as Player / Team</h2>
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              const trimmedCode = inputCode.trim();
              const trimmedName = teamName.trim();
              if (trimmedCode && trimmedName) onSelectPlayer(trimmedCode.toUpperCase(), trimmedName);
            }}
            className="role-select-form"
          >
            <div className="role-select-input-row">
              <div className="role-select-field">
                <label>Player / Team Name</label>
                <input
                  type="text"
                  placeholder={defaultTeamName || "e.g. Buzzer Beaters"}
                  value={teamName}
                  onChange={(e) => setTeamName(e.target.value)}
                  maxLength={24}
                />
              </div>
              <div className="role-select-field">
                <label>Room Code</label>
                <input
                  type="text"
                  placeholder="7FE4SE"
                  value={inputCode}
                  onChange={(e) => setInputCode(e.target.value)}
                  maxLength={8}
                  className="code-input"
                />
              </div>
            </div>
            <span className="role-select-hint">
              Joining an existing team name adds you to it — new names create a new team.
            </span>
            <button
              type="submit"
              disabled={!inputCode.trim() || !teamName.trim() || isJoining}
              className="role-select-join-btn"
            >
              {isJoining ? "Joining…" : "Join Game"}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}