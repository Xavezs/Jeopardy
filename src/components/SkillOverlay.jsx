import { createPortal } from "react-dom";
import DomainExpansion from "./DomainExpansion";

/* Full-screen cutscene for whichever skill is currently active (from
   useSkillSync). Rendered on every client; `onDone` fires when it ends. */
export default function SkillOverlay({ activeSkill, onDone }) {
  if (!activeSkill) return null;
  if (activeSkill.effect === "cleave") {
    return createPortal(
      <DomainExpansion onDone={onDone} deltas={activeSkill.deltas} casterName={activeSkill.username} />,
      document.body
    );
  }
  return null;
}