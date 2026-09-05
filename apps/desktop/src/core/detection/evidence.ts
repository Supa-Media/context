/**
 * "What it noticed" — the evidence list in the panel.
 *
 * The mockup shows three ticked lines, and `DetectionResult.reason` is one
 * string. That is not a mismatch to fix by inventing a second field: the reason
 * exists precisely so a wrong guess can be explained, and the panel is where a
 * person reads it. So this module splits it and nothing more.
 *
 * It is deliberately tolerant about the separator. `detect()` is written next
 * door and its phrasing is its own business; a detector that answers with one
 * sentence gets one line here rather than an empty list, and one that answers
 * with a semicolon-separated list gets the mockup's three ticks. If the two
 * files ever want a structured reason, that is a change to `protocol.js` and
 * therefore a change every client agrees to — not something this file should
 * work around by parsing harder.
 */

import type { DetectionResult } from "../contract.ts";

/** Separators a reason might reasonably use, in one place. */
const SPLIT = /\s*[;\n·]\s*|\s+•\s+/;

/** The bulleted evidence, in the order the detector gave it. */
export function evidenceLines(result: Pick<DetectionResult, "reason">): string[] {
  const reason = typeof result.reason === "string" ? result.reason : "";
  const parts = reason
    .split(SPLIT)
    .map((part) => part.trim())
    .filter((part) => part !== "");
  return parts;
}

/** The one-line summary under the title. */
export function summaryLine(result: Pick<DetectionResult, "reason">): string {
  return typeof result.reason === "string" ? result.reason.trim() : "";
}

/**
 * The honest sentence for a collector that could not answer.
 *
 * Shown *with* the evidence rather than instead of it: "a calendar we cannot
 * read" is a different statement from "no calendar events", and the second one
 * is the one a person would wrongly infer from a short evidence list.
 */
export function degradedNotice(degraded: readonly string[]): string | null {
  if (degraded.length === 0) return null;
  const names: Record<string, string> = {
    processes: "running apps",
    windows: "window titles",
    microphone: "microphone use",
    calendar: "your calendar",
  };
  const listed = degraded.map((name) => names[name] ?? name);
  const joined =
    listed.length === 1
      ? listed[0]
      : `${listed.slice(0, -1).join(", ")} and ${listed[listed.length - 1]}`;
  return `Cannot see ${joined} — detection is working with less than usual.`;
}
