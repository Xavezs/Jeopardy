import { useState, useEffect, useMemo } from "react";
import { useScorePulse } from "./useScorePulse";
import { useDiscordMembers } from "./useDiscordMembers";
import { useSpeakingState } from "./useSpeakingState";
import { activityChannelId } from "../../discordSdk";
import { playClickSfx, playCorrectSfx, playIncorrectSfx } from "../boardSfx";

const SCORE_STEP = 50;

/* =========================================================================
   useTeams
   Owns team roster actions (rename/score/add/remove/reorder), the Discord
   voice integration used to decorate team cards, and the number-key +
   arrow-key scoreboard shortcut.

   `useDiscordMembers` (the raw socket/member feed) is only ever consumed
   HERE — nothing else in the app should import it directly, so there's a
   single owner of "how do we match a team to a Discord member".
   ========================================================================= */
export function useTeams({ sessionRef, touch, persist, editMode, activeClue, setView, markTeamDeleted, markTeamAdded, players }) {
  const { scorePulse, firePulse } = useScorePulse();

  // "normal" — team cards show the plain, manually-typed team name. No
  //   Discord lookups happen, no overlay shown.
  // "discord" — team cards additionally show a small face-pile of whichever
  //   Discord voice-channel members were manually assigned to that team
  //   (see toggleTeamDiscordUser below), each with live speaking/mute
  //   state. A team can have any number of members assigned — there's no
  //   auto-matching by name; it's all explicit, click-to-add/remove.
  const { members: rawDiscordMembers, connected: discordConnected } = useDiscordMembers(activityChannelId);

  // "Who's talking" comes from a completely different source than the rest
  // of this member data: rawDiscordMembers is the bot's socket feed (voice
  // channel roster, mute/deafen state), while speaking state is read
  // directly off the Discord Activity SDK client-side (see
  // useSpeakingState). They're merged here, once, so every consumer below
  // (resolveDiscordMembersForTeam, the discord-mode chip picker, etc.)
  // just sees a single `speaking` boolean and doesn't need to know there
  // are two feeds behind it.
  const speakingIds = useSpeakingState();
  const discordMembers = useMemo(
    () => rawDiscordMembers.map((m) => ({ ...m, speaking: speakingIds.has(m.id) })),
    [rawDiscordMembers, speakingIds]
  );

  // Always "discord" now — the normal/discord toggle was removed since
  // this app is always run inside Discord. Kept as a no-op setter (rather
  // than removing it from the return value) so Toolbar doesn't need to
  // change immediately if it still references onToggleDiscordMode.
  const discordDisplayMode = "discord";
  const setDiscordDisplayMode = () => {};

  // Which team's scoreboard number is "armed" for the ↑/↓ +/- shortcut —
  // click a team's score to select it (gold ring), then Up/Down adjusts it
  // by SCORE_STEP. Cleared whenever edit mode turns on or a clue modal is
  // open, since editing uses a free-typed input and the clue modal has its
  // own copy of this shortcut instead.
  const [selectedScoreTeamId, setSelectedScoreTeamId] = useState(null);

  useEffect(() => {
    if (editMode || activeClue) setSelectedScoreTeamId(null);
  }, [editMode, activeClue]);

  // Number keys (1-9) select a team on the main scoreboard, mirroring the
  // 1-4 "arm a team" shortcut in ClueModal. Only active when we're not in
  // edit mode, no clue modal is open, and focus isn't inside a text input.
  useEffect(() => {
    const handleScoreKeyDown = (e) => {
      if (editMode || activeClue) return;
      const tag = document.activeElement && document.activeElement.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;

      const teams = sessionRef.current?.data?.teams;

      const digit = Number(e.key);
      if (Number.isInteger(digit) && teams && digit >= 1 && digit <= teams.length) {
        playClickSfx();
        const teamId = teams[digit - 1].id;
        setSelectedScoreTeamId((prev) => (prev === teamId ? null : teamId));
        return;
      }

      if (selectedScoreTeamId == null) return;
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      const team = teams?.find((t) => t.id === selectedScoreTeamId);
      if (!team) return;
      e.preventDefault();
      if (e.key === "ArrowUp") {
        playCorrectSfx();
        adjustTeamScore(team, SCORE_STEP);
      } else {
        playIncorrectSfx();
        adjustTeamScore(team, -SCORE_STEP);
      }
    };
    window.addEventListener("keydown", handleScoreKeyDown);
    return () => window.removeEventListener("keydown", handleScoreKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedScoreTeamId, editMode, activeClue]);

  function renameTeam(team, name) {
    team.name = name || "Team";
    persist();
  }
  function adjustTeamScore(team, delta) {
    team.score += delta;
    firePulse(team.id, delta >= 0 ? "pulse-up" : "pulse-down");
    touch();
    persist();
  }
  function setTeamScore(team, rawValue) {
    const parsed = parseInt(rawValue, 10);
    const newScore = Number.isNaN(parsed) ? 0 : parsed;
    if (newScore !== team.score) firePulse(team.id, newScore > team.score ? "pulse-up" : "pulse-down");
    team.score = newScore;
    touch();
    persist();
  }
  function addTeam() {
    const d = sessionRef.current.data;
    const newTeam = { id: "t_" + Math.random().toString(36).slice(2, 9), name: "Team " + (d.teams.length + 1), score: 0 };
    d.teams.push(newTeam);
    // Protects this team for a few seconds against the boardUpdate merge
    // logic in usePersistence, which would otherwise see the server's
    // stale copy (missing this team, since it hasn't round-tripped yet)
    // and delete it right back out from under us.
    if (markTeamAdded) markTeamAdded(newTeam.id);
    touch();
    persist();
  }
  function removeTeam(team) {
    const d = sessionRef.current.data;
    d.teams = d.teams.filter((t) => t.id !== team.id);
    if (markTeamDeleted) markTeamDeleted(team.name);
    touch();
    persist();
  }
  function applyTeamOrder(orderedTeams) {
    const d = sessionRef.current.data;
    d.teams = orderedTeams;
    touch();
    persist();
    setView("board");
  }

  // Manually links (or unlinks) one Discord voice-channel member to/from a
  // team. A team can hold any number of members — this just toggles one
  // id in and out of the team's roster. Purely manual, no auto-matching.
  function toggleTeamDiscordUser(team, discordUserId) {
    const current = Array.isArray(team.discordUserIds)
      ? team.discordUserIds
      : team.discordUserId
      ? [team.discordUserId] // migrate old single-assignment data on first edit
      : [];
    team.discordUserIds = current.includes(discordUserId)
      ? current.filter((id) => id !== discordUserId)
      : [...current, discordUserId];
    delete team.discordUserId;
    touch();
    persist();
  }

  function resetAllScores() {
    const d = sessionRef.current.data;
    d.teams.forEach((t) => (t.score = 0));
    touch();
    persist();
  }

  // Resolves the live Discord members (if any) assigned to a given team.
  // Always an array — empty when Discord mode is off or nothing's assigned.
  function resolveDiscordMembersForTeam(team) {
    if (discordDisplayMode !== "discord") return [];
    const ids = Array.isArray(team.discordUserIds)
      ? team.discordUserIds
      : team.discordUserId
      ? [team.discordUserId]
      : [];
    return ids
      .map((id) => {
        // Live voice-channel presence wins when we have it (speaking/mute/
        // deafen state). Otherwise fall back to the identity broadcast on
        // join (playersUpdate) so the avatar still shows, just without
        // live state, instead of rendering nothing.
        const voice = discordMembers.find((m) => m.id === id);
        if (voice) return voice;
        const p = (players || []).find((pl) => pl.discordUserId === id);
        return p
          ? { id, username: p.discordUsername, avatarUrl: p.discordAvatarUrl, speaking: speakingIds.has(id), muted: false, deafened: false }
          : null;
      })
      .filter(Boolean);
  }

  // Reverse of resolveDiscordMembersForTeam: given a Discord user id (e.g.
  // whoever won the /buzz race), finds which team they're assigned to.
  // Works regardless of discordDisplayMode, since buzzing-in is a gameplay
  // fact, not a display toggle.
  function resolveTeamForDiscordUser(userId) {
    if (!userId) return null;
    const teams = sessionRef.current?.data?.teams || [];
    return (
      teams.find((t) => {
        const ids = Array.isArray(t.discordUserIds)
          ? t.discordUserIds
          : t.discordUserId
          ? [t.discordUserId]
          : [];
        return ids.includes(userId);
      }) || null
    );
  }

  return {
    scorePulse,
    discordMembers,
    discordConnected,
    discordDisplayMode,
    setDiscordDisplayMode,
    selectedScoreTeamId,
    setSelectedScoreTeamId,
    SCORE_STEP,
    renameTeam,
    adjustTeamScore,
    setTeamScore,
    addTeam,
    removeTeam,
    applyTeamOrder,
    toggleTeamDiscordUser,
    resetAllScores,
    resolveDiscordMembersForTeam,
    resolveTeamForDiscordUser,
  };
}