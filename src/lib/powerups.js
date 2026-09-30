// lib/powerups.js
// Client-side catalog of the six spin power-ups. Labels must match the ones
// TeamRandomizer hands out and bot-server.js's POWERUP_KINDS.
//   needsTarget — the player must pick an opposing team first
//   clueOnly    — only usable while a clue is open
//   needsLive   — additionally needs the buzzer to be live
export const POWERUP_INFO = {
  "2x Points": { kind: "double", desc: "Your team's next correct answer scores double." },
  "Shield":    { kind: "shield", desc: "Cancels your team's next wrong-answer penalty." },
  "Steal":     { kind: "steal", desc: "Take board control — you pick the next clue." },
  "Freeze":    { kind: "freeze", desc: "Lock another team out of buzzing for this clue (or the next one).", needsTarget: true },
  "Hint":      { kind: "hint", desc: "Privately reveals the first letter of each answer word.", clueOnly: true },
  "Re-Buzz":   { kind: "rebuzz", desc: "Jump to the front of the buzz queue.", clueOnly: true, needsLive: true },
};

export const DOMAIN_LABEL = "Domain Expansion";

/* Why a power-up can't be used right now (null = usable). */
export function powerupBlockedReason(label, { inClue, buzzerLive, isFinal, hasControl, armed, myTeamId }) {
  const info = POWERUP_INFO[label];
  if (!info) return "Unknown power-up";
  if (isFinal) return "Not available in Final Jeopardy";
  if (info.clueOnly && !inClue) return "Only usable while a clue is open";
  if (info.needsLive && !buzzerLive) return "The buzzer isn't live";
  if (info.kind === "steal" && hasControl) return "You already have board control";
  if ((info.kind === "double" || info.kind === "shield") && (armed || []).some((a) => a.kind === info.kind && a.teamId === myTeamId)) {
    return "Already ready for your team";
  }
  return null;
}
