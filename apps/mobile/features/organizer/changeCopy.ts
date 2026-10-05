/**
 * Every word a What changed card puts on screen.
 *
 * Same rules as `./copy.ts`: plain, short, about the workspace and never the
 * machinery. A step is said as what will happen to a named person or project,
 * never as a field and a value.
 */

import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { baseName } from "../console/files/paths";
import { PRIORITY_LABELS, NO_PRIORITY_LABEL, type Priority } from "../console/files/folderPage/tasks/taskWords";
import type { ChangeCard, ChangeStep } from "./types";

export const changesCopy = {
  heading: "What changed",
  note: "Nothing changes until you apply. You can undo it.",
  wrong: "This is wrong",
  apply: (n: number) => (n === 0 ? "Apply" : n === 1 ? "Apply 1 change" : `Apply ${n} changes`),
  applied: (card: ChangeCard) => `Done: ${card.headline.replace(/[.!?]$/, "")}.`,
  dismissed: "Got it. It won’t suggest that again.",
  failed: "That did not go through. The notes may have changed; have another look.",
};

export const TOPIC_LABELS: Record<ChangeCard["topic"], string> = {
  people: "People",
  focus: "Focus",
  project: "Project",
};

const SOURCE_KINDS: Record<string, string> = {
  meeting: "Meeting",
  messages: "Email or chat",
  chat: "AI chat",
  note: "Note",
};

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Where the card was read, as a person names it: "Meeting, Oct 2: Leadership
 * sync", "Email or chat, Oct 3", "AI chat, Oct 4".
 */
export function sourceLine(source: ChangeCard["source"]): string {
  const kind = SOURCE_KINDS[source.kind] ?? "Note";
  const file = baseName(source.path).replace(/\.md$/i, "");
  const dated = /^(\d{4})-(\d{2})-(\d{2})(.*)$/.exec(file);
  // The name comes out of somebody's bucket: contained, like every other one.
  if (!dated) return `${kind}: ${isolateForDisplay(source.title)}`;
  const month = MONTHS[Number(dated[2]) - 1];
  const day = Number(dated[3]);
  const when = month ? `${month} ${day}` : "";
  // A time stamp after the date (a saved chat) is not a name.
  const rest = (dated[4] ?? "").replace(/^T[\d-]+Z?$/i, "").replace(/^[-_\s]+/, "").replace(/[-_]+/g, " ").trim();
  const name = rest ? rest.charAt(0).toUpperCase() + rest.slice(1) : "";
  return [kind, when].filter(Boolean).join(", ") + (name ? `: ${isolateForDisplay(name)}` : "");
}

function priorityWord(value: string | undefined): string {
  return value && value in PRIORITY_LABELS ? PRIORITY_LABELS[value as Priority] : NO_PRIORITY_LABEL;
}

const RANK = ["p0", "p1", "p2", "p3"];

/** A step's line, and the smaller line under it. */
export function stepLines(step: ChangeStep): { line: string; sub: string } {
  if (step.do === "archive") {
    return { line: step.about === "person" ? `Archive ${step.title}’s page` : `Archive ${step.title}`, sub: "Moves to Archive" };
  }
  const was = step.was ?? "";
  const value = step.value ?? "";
  switch (step.field) {
    case "owner":
      return value === ""
        ? { line: `Take ${was || "the owner"} off ${step.title}`, sub: "It will have no owner" }
        : { line: `Give ${step.title} to ${value}`, sub: was ? `Was ${was}` : "Had no owner" };
    case "priority": {
      const up = value !== "" && (was === "" || RANK.indexOf(value) < RANK.indexOf(was));
      return { line: `${up ? "Raise" : "Lower"} ${step.title}`, sub: `${priorityWord(was)} → ${priorityWord(value)}` };
    }
    case "status":
      return { line: `Mark ${step.title} ${value}`, sub: was ? `Was ${was}` : "Had no status" };
    default:
      return { line: step.title, sub: "" };
  }
}

/** For a screen reader: the step and what it replaces, in one sentence. */
export function stepLabel(step: ChangeStep): string {
  const { line, sub } = stepLines(step);
  return sub ? `${line}. ${sub}` : line;
}
