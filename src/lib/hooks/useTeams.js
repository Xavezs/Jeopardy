import { useState, useEffect, useMemo } from "react";
import { useScorePulse } from "./useScorePulse";
import { useDiscordMembers } from "./useDiscordMembers";
import { useSpeakingState } from "./useSpeakingState";
import { activityChannelId } from "../../discordSdk";
import { playClickSfx, playCorrectSfx, playIncorrectSfx } from "../boardSfx";

const SCORE_STEP = 50;

export function useTeams({ sessionRef, touch, persist, editMode, activeClue, setView, markTeamDeleted, markTeamAdded, players }) {
  const { scorePulse, firePulse } = useScorePulse();

  const { members: rawDiscordMembers, connected: discordConnected } = useDiscordMembers(activityChannelId);

  const speakingIds = useSpeakingState();
  const discordMembers = useMemo(
    () => rawDiscordMembers.map((m) => ({ ...m, speaking: speakingIds.has(m.id) })),
    [rawDiscordMembers, speakingIds]
  );

  const discordDisplayMode = "discord";
  const setDiscordDisplayMode = () => {};

  const [selectedScoreTeamId, setSelectedScoreTeamId] = useState(null);

  useEffect(() => {
    if (editMode || activeClue) setSelectedScoreTeamId(null);
  }, [editMode, activeClue]);

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
    const d = sessionRef.current.data;
    d.teams = d.teams.map((t) => (t.id === team.id ? { ...t, name: name || "Team" } : t));
    persist();
  }
  function adjustTeamScore(team, delta) {
    const d = sessionRef.current.data;
    d.teams = d.teams.map((t) => (t.id === team.id ? { ...t, score: (t.score ?? 0) + delta } : t));
    firePulse(team.id, delta >= 0 ? "pulse-up" : "pulse-down");
    touch();
    persist();
  }
  function setTeamScore(team, rawValue) {
    const parsed = parseInt(rawValue, 10);
    const newScore = Number.isNaN(parsed) ? 0 : parsed;
    if (newScore !== team.score) firePulse(team.id, newScore > team.score ? "pulse-up" : "pulse-down");
    const d = sessionRef.current.data;
    d.teams = d.teams.map((t) => (t.id === team.id ? { ...t, score: newScore } : t));
    touch();
    persist();
  }
  function addTeam() {
    const d = sessionRef.current.data;
    const newTeam = { id: "t_" + Math.random().toString(36).slice(2, 9), name: "Team " + (d.teams.length + 1), score: 0 };
    d.teams.push(newTeam);
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

  function toggleTeamDiscordUser(team, discordUserId) {
    const current = Array.isArray(team.discordUserIds)
      ? team.discordUserIds
      : team.discordUserId
      ? [team.discordUserId]
      : [];
    const nextIds = current.includes(discordUserId)
      ? current.filter((id) => id !== discordUserId)
      : [...current, discordUserId];
    const d = sessionRef.current.data;
    d.teams = d.teams.map((t) => {
      if (t.id !== team.id) return t;
      const { discordUserId: _legacy, ...rest } = t;
      return { ...rest, discordUserIds: nextIds };
    });
    touch();
    persist();
  }

  function resetAllScores() {
    const d = sessionRef.current.data;
    d.teams = d.teams.map((t) => ({ ...t, score: 0 }));
    touch();
    persist();
  }

  function resolveDiscordMembersForTeam(team) {
    if (discordDisplayMode !== "discord") return [];

    // 1. Manual assignments
    const assignedIds = Array.isArray(team.discordUserIds)
      ? team.discordUserIds
      : team.discordUserId
      ? [team.discordUserId]
      : [];

    const rosterIds = (players || [])
      .filter((p) => p.teamId === team.id && p.discordUserId)
      .map((p) => p.discordUserId);

    // Merge, deduplicate
    const allIds = [...new Set([...assignedIds, ...rosterIds])];
    if (allIds.length === 0) return [];

    return allIds
      .map((id) => {
        const voice = discordMembers.find((m) => m.id === id);
        if (voice) return voice;
        const p = (players || []).find((pl) => pl.discordUserId === id);
        return p
          ? { id, username: p.discordUsername, avatarUrl: p.discordAvatarUrl, speaking: speakingIds.has(id), muted: false, deafened: false }
          : null;
      })
      .filter(Boolean);
  }

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