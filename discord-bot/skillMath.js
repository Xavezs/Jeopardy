// Pure skill math, kept free of sockets/rooms so it can be unit tested.

// Domain Expansion ("cleave"): every team except the caster's loses
// `percent` of its score, rounded, capped at `maxLoss`. Teams at or below 0
// are untouched, and a loss can never take a team below 0.
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
