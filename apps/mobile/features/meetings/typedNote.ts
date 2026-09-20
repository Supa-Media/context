import { clock } from "./format";

/**
 * A note somebody typed during a meeting, as one Markdown line.
 *
 * ## Why the panel types into a list rather than into a pad
 *
 * The meeting's own screen gives the notes the whole surface — `NotesPad`, a
 * text area somebody writes in while the transcript lands around them. The
 * console's right panel is 330pt of column beside a note, which is not a place
 * to write a page in, and a second free-text editor there would be a second
 * thing to keep the caret still in.
 *
 * What the panel is good for is the thing people actually do in a meeting they
 * are half-watching: drop a line. So the composer takes one line at a time and
 * this is the rule for what lands in the file — a Markdown list item, stamped
 * with the meeting's own clock, appended to the same `notes` the pad edits.
 * There is one store for what the human typed (`MeetingsController.setNotes`),
 * and the stamp is how a line typed at eleven minutes stays anchored to what
 * was being said at eleven minutes once the transcript is folded in.
 *
 * ## It is a pure function for `console/capabilities.ts`'s reason
 *
 * Every guard expressed inside a component in this app was held by nothing.
 * The rules worth holding here are small and exact — an empty line writes
 * nothing, a line never eats the line above it, a stamp is the elapsed clock
 * and not the wall clock — and each of them is a sentence in somebody's file.
 */
export function appendTypedNote(existing: string, text: string, elapsedMs: number): string {
  /*
    Collapsed to one line. A pasted paragraph is still one note taken at one
    moment, and letting its newlines through would break the list item in half
    and leave the second half looking like prose nobody stamped.
  */
  const line = text.replace(/\s+/g, " ").trim();
  if (line === "") return existing;

  const item = `- [${clock(Math.max(0, elapsedMs))}] ${line}`;
  if (existing.trim() === "") return item;
  /*
    Exactly one newline between items, whatever the pad left behind. Somebody
    typing in the pad ends with a trailing newline about half the time, and a
    version that appended `\n` unconditionally left a blank line between every
    pair of notes in the finished file.
  */
  return `${existing.replace(/\s+$/, "")}\n${item}`;
}
