import { createPortal } from "react-dom";
import DomainExpansion from "./DomainExpansion";

export default function SkillOverlay({ activeSkill, onDone }) {
  if (!activeSkill) return null;
  if (activeSkill.effect === "cleave") {
    return createPortal(
      <DomainExpansion onDone={onDone} deltas={activeSkill.deltas} casterName={activeSkill.username} casterTeamId={activeSkill.teamId} />,
      document.body
    );
  }
  return null;
}