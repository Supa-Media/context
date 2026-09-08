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
import type { DegradedReason } from "./collectors.ts";

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
 *
 * **The calendar case gets its own sentence, naming what to do about it — but
 * only when the failure is actually a permission refusal.** The shape this
 * sentence exists for is a write-only Calendars grant — Apple Events to
 * Calendar allowed, the data itself refused — which `calendarScript` reports
 * as a `PermissionRefusedError` rather than an empty diary (see
 * `platform/macos/calendar.ts`). Whether that shape has ever actually
 * occurred on a real Mac is an open question, not a demonstrated fact — an
 * earlier version of this comment claimed it had been, and that claim is
 * retracted in `docs/decisions/desktop-updates.md`, "The one-way door": it
 * was inferred from a permission value, never observed, and a later
 * measurement against the running collector found no refusal at all on the
 * same write-only machine. The sentence below is written for the shape
 * regardless of whether it has ever fired. `attempt()` in `collectors.ts`
 * also marks the calendar degraded on a timeout, a malformed result, or
 * Calendar.app simply hanging — none of which is a permission problem — so
 * `reasons` is what tells the two apart. Sending somebody to System Settings for a grant that is
 * already correct is the same mistake as the notice that once blamed the
 * microphone for a fault that was never the microphone's: confidently naming
 * a cause the app never established. A transient failure gets the plain
 * sentence above and nothing more; it says the calendar could not be read
 * this time, which is exactly what happened and all that is known.
 *
 * When it *is* a permission refusal, the second sentence names the exact
 * place to fix it and the one thing this document has to say honestly:
 * **shipping the fuller permission request is not retroactive** — a grant
 * already sitting at write-only stays there until the person re-grants it
 * themselves; nothing this app does reaches into System Settings on their
 * behalf.
 *
 * **`tabUrlRefusals` is a different kind of gap and gets its own sentence,
 * appended whether or not any collector is degraded.** A browser refusing one
 * poll's tab URL does not degrade the window collector at all — its window
 * titles, including that browser's, are still in the evidence — so it cannot
 * be reached through `degraded`. Left uncounted, it would be exactly the
 * defect this file already closed once for the calendar: a refusal
 * indistinguishable from "nothing to see there". Naming a browser is
 * deliberately avoided — the count is what a person can act on (there is a
 * blind spot) without this app narrating which of their apps has one.
 */
export function degradedNotice(
  degraded: readonly string[],
  reasons: Readonly<Record<string, DegradedReason>> = {},
  tabUrlRefusals = 0,
): string | null {
  const names: Record<string, string> = {
    processes: "running apps",
    windows: "window titles",
    microphone: "microphone use",
    calendar: "your calendar",
  };
  let notice: string | null = null;
  if (degraded.length > 0) {
    const listed = degraded.map((name) => names[name] ?? name);
    const joined =
      listed.length === 1
        ? listed[0]
        : `${listed.slice(0, -1).join(", ")} and ${listed[listed.length - 1]}`;
    notice = `Cannot see ${joined} — detection is working with less than usual.`;
    if (degraded.includes("calendar") && reasons["calendar"] === "permission-refused") {
      notice +=
        ` Calendar access is often granted for adding events only, which ` +
        `looks identical to a fully working grant in System Settings but hides ` +
        `every event from this app. Open System Settings > Privacy & Security > ` +
        `Calendars and switch Context to Full Access — re-granting it yourself is ` +
        `required either way, since a fuller request from this app cannot upgrade ` +
        `a permission you already gave.`;
    }
  }
  if (tabUrlRefusals > 0) {
    const tabSentence =
      tabUrlRefusals === 1
        ? `A browser did not share one open tab's address, so a meeting open only in that tab may go unrecognized.`
        : `${tabUrlRefusals} open browsers did not share a tab's address, so a meeting open only in one of those tabs may go unrecognized.`;
    notice = notice ? `${notice} ${tabSentence}` : tabSentence;
  }
  return notice;
}
