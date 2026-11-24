/**
 * Tex's own iMessage polls (Dev, 2026-11-23: "real imessage polls"; design
 * `@supa projects/tex-imessage-line/photon-sending-design.md`). Tex reads a poll someone starts in words (the bridge's
 * `pollWords`), and starts one the same way it writes a list: a text whose first line is "(poll) <title>" and whose
 * other lines are its choices, one per line ("- Thai"). On Photon's line it goes as a real poll; on any other line, as
 * the same words without the mark, which still asks everyone to answer.
 *
 * Pure: no fetch, no storage.
 */

/** As the bridge allows (`validate.mjs` `poll/create`). */
const MAX_CHOICES = 12;
const MAX_TITLE = 200;
const MAX_CHOICE = 100;

const MARK = /^\s*\(poll\)[ \t]*/i;
/** A list line: "- x", "• x", "* x", "1. x" or "1) x". */
const ITEM = /^\s*(?:[-•*]|\d{1,2}[.)])\s+(.+?)\s*$/;

/** The poll a text of Tex's starts, or null when it is not one. */
export function pollOf(text: string): { title: string; choices: string[] } | null {
  const mark = MARK.exec(text);
  if (mark === null) return null;
  const lines = text.slice(mark[0].length).split("\n").map((line) => line.trimEnd()).filter((line) => line.trim() !== "");
  const title = (lines.shift() ?? "").trim();
  if (title === "" || title.length > MAX_TITLE) return null;
  const choices: string[] = [];
  for (const line of lines) {
    const item = ITEM.exec(line);
    // Words that are not a choice: not a poll, so nothing is lost by sending them as a poll.
    if (item === null) return null;
    const choice = item[1]!.trim();
    if (choice.length > MAX_CHOICE) return null;
    if (!choices.includes(choice)) choices.push(choice);
  }
  if (choices.length < 2 || choices.length > MAX_CHOICES) return null;
  return { title, choices };
}

/** A text's words without its "(poll)" mark, as a line that has no polls sends them. */
export function withoutPollMark(text: string): string {
  const mark = MARK.exec(text);
  return mark === null || text.slice(mark[0].length).trim() === "" ? text : text.slice(mark[0].length);
}
