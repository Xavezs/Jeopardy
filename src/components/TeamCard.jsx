import React from "react";

// TEAM CARD
export default function TeamCard({
  team,
  teamIndex,
  editMode,
  selectedScoreTeamId,
  setSelectedScoreTeamId,
  discordDisplayMode,
  discordTeamMembers,
  discordMembers,
  toggleTeamDiscordUser,
  removeTeam,
  renameTeam,
  setTeamScore,
  scorePulse,
  buzzPosition,
  buzzIsActive,
  buzzIsStruck,
}) {
  const assignedIds = Array.isArray(team.discordUserIds)
    ? team.discordUserIds
    : team.discordUserId
    ? [team.discordUserId]
    : [];

  return (
    <div
      className={
        "team-card" +
        (editMode ? " is-editing" : "") +
        (!editMode && selectedScoreTeamId === team.id ? " kb-selected" : "") +
        (discordTeamMembers && discordTeamMembers.some((m) => m.speaking) ? " discord-speaking" : "")
      }
      data-team-id={team.id}
      role={editMode ? undefined : "button"}
      tabIndex={editMode ? undefined : 0}
      title={editMode ? undefined : `Select (or press ${teamIndex + 1}), then use ↑ / ↓ to adjust score`}
      aria-label={editMode ? undefined : `Select ${team.name}'s score to adjust with arrow keys, or press ${teamIndex + 1}`}
      onClick={() => {
        if (editMode) return;
        setSelectedScoreTeamId((id) => (id === team.id ? null : team.id));
      }}
    >
      {editMode && (
        <button className="team-remove" title="Remove this team" onClick={() => removeTeam(team)}>
          ✕
        </button>
      )}

      {!editMode && buzzPosition != null && (
        <div
          className={
            "team-buzz-badge" +
            (buzzIsActive ? " is-active" : "") +
            (buzzIsStruck ? " is-struck" : "")
          }
          title={
            buzzIsActive
              ? `Buzzed in — #${buzzPosition}, currently answering`
              : buzzIsStruck
              ? `Buzzed in — #${buzzPosition}, already tried`
              : `Buzzed in — #${buzzPosition} in line`
          }
        >
          {buzzPosition}
        </div>
      )}

      {editMode ? (
        <>
          <input
            className="team-name-input"
            disabled={!editMode}
            defaultValue={team.name}
            key={team.id + "-name"}
            onBlur={(e) => renameTeam(team, e.target.value)}
          />
          {discordDisplayMode === "discord" && (
            <div className="team-discord-picker" key={team.id + "-discord"}>
              {discordMembers.map((m) => {
                const isSelected = assignedIds.includes(m.id);
                return (
                  <button
                    type="button"
                    key={m.id}
                    className={"team-discord-chip" + (isSelected ? " is-selected" : "")}
                    title={m.username}
                    onClick={() => toggleTeamDiscordUser(team, m.id)}
                  >
                    <img src={m.avatarUrl} alt="" />
                    {m.speaking && <span className="team-discord-chip-speaking-dot" />}
                  </button>
                );
              })}
              {discordMembers.length === 0 && (
                <span className="team-discord-picker-empty">No one's in voice yet</span>
              )}
            </div>
          )}
        </>
      ) : (
        <div className="team-name-display">
          {discordTeamMembers && discordTeamMembers.length > 0 && (
            <div className="team-discord-facepile">
              {discordTeamMembers.map((dm) => (
                <div className="team-discord-avatar-wrap" key={dm.id}>
                  <img
                    src={dm.avatarUrl}
                    alt=""
                    className={"team-discord-avatar" + (dm.speaking ? " is-speaking" : "")}
                    style={{ opacity: dm.deafened ? 0.4 : 1 }}
                  />
                  {dm.muted && <div className="team-discord-muted-badge" title="Muted" />}
                </div>
              ))}
            </div>
          )}
          <span className="team-name-text">{team.name}</span>
        </div>
      )}

      <div className="team-score-row">
        {editMode ? (
          <input
            className="team-score-display team-score-input"
            type="number"
            defaultValue={team.score}
            key={team.id + "-score"}
            title="Set this team's score manually"
            onBlur={(e) => setTeamScore(team, e.target.value)}
            onWheel={(e) => e.target.blur()}
          />
        ) : (
          <div
            className={
              "team-score-display" +
              (scorePulse[team.id] ? " " + scorePulse[team.id] : "") +
              (selectedScoreTeamId === team.id ? " kb-selected" : "")
            }
          >
            ${team.score}
          </div>
        )}
      </div>
    </div>
  );
}