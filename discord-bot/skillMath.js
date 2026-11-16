function computeCleaveDeltas(teams, casterTeamId, { percent, maxLoss }) {
  return (teams || [])
    .filter((t) => t.id !== casterTeamId && Number(t.score) > 0)
    .map((t) => {
      const score = Number(t.score);
      const loss = Math.min(maxLoss, score, Math.round(score * percent));
      return { teamId: t.id, teamName: t.name, delta: -loss };
    })
    .filter((d) => d.delta !== 0);
}

module.exports = { computeCleaveDeltas };
