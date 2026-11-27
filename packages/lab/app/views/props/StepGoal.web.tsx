/**
 * A step's Goal, the first thing under its name on both cards (Dev, 2026-11-26: "the goal should literally be the
 * first thing I see when clicking on a node to understand it"; artboards in the project's `node-panel-artboards/`).
 *
 * It reads as plain text. A click (or Enter) opens it in place as a box that grows with it; leaving the box saves it,
 * Esc puts it back. A step with none says what a goal is for. A goal this draft changed is outlined yellow; the
 * changes box under the switch shows main's beside it.
 */
import { useState } from "react";
import { stepChange } from "../../engine/changeMarks";
import type { LabNode } from "../../types";
import { setNode } from "./nodeEdit";

/** Grows a textarea to fit what it holds, so the goal never scrolls inside its own box. */
const fit = (el: HTMLTextAreaElement | null) => {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight + 4}px`;
};

export function StepGoal({ n, card }: { n: LabNode; card: "run" | "set" }) {
  const [editing, setEditing] = useState(false);
  const goal = n.goal || "";
  const ch = stepChange(n.id);
  // Change marks belong to the Settings card; Run details never shows them.
  const changed = card === "set" && !!ch?.x.fields.includes("goal");
  if (editing)
    return (
      <div className="goaled">
        <textarea
          id="nGoal"
          aria-label="Goal"
          rows={3}
          autoFocus
          defaultValue={goal}
          placeholder="Why this step exists: what goes wrong without it"
          ref={fit}
          onInput={(e) => fit(e.currentTarget)}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              e.currentTarget.dataset.cancel = "1";
              setEditing(false);
            }
          }}
          onBlur={(e) => {
            const v = e.currentTarget.value.trim();
            if (!e.currentTarget.dataset.cancel && v !== goal) setNode(n.id, "goal", v);
            setEditing(false);
          }}
        />
        <div className="gk">
          <span>Esc to cancel</span>
          <span>Saves when you click away</span>
        </div>
      </div>
    );
  return (
    <div
      className={"goal" + (goal ? "" : " empty") + (changed ? " chgf" : "")}
      id="nGoalText"
      role="button"
      tabIndex={0}
      title="Edit the goal"
      onClick={() => setEditing(true)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          setEditing(true);
        }
      }}
    >
      {goal || "Add a goal: why this step exists, and what breaks without it."}
    </div>
  );
}
