/**
 * "THE KEPT PDF WON'T LOAD" WITH THE PDF KEPT AND UNREAD (the owner's review
 * of a chat, 2026-10-26).
 *
 * A resume came with a text and was kept (`keptFiles.js`). Two texts later
 * Tex said "I tried again and still can't open the resume", took back the
 * pitch it had written from it, and asked them to paste its text, having
 * tried only a listing and a `fetch` that never reached the file. Asking
 * someone to paste a file Tex holds is handing work back
 * ([handing-back](../../../../docs/decisions/texting-assistant/handing-back.md)).
 *
 * So an answer that says a file won't open, or asks them to paste or resend
 * it, while a kept file is in reach and nothing read it this turn, gets one
 * more round, told the id and the one call that reads it. A read that ran
 * and failed lets the answer go: then the file really would not open, and
 * saying so is honest.
 */

import { keptRef } from "./keptFiles.js";

const FILE = /\b(?:pdf|file|resume|résumé|cv|document|attachment|spreadsheet|csv|export)s?\b/i;
const APOSTROPHE = "['’]?";
const CANT_OPEN = new RegExp(
  `\\b(?:can${APOSTROPHE}t|cannot|couldn${APOSTROPHE}t|unable to|won${APOSTROPHE}t|doesn${APOSTROPHE}t|isn${APOSTROPHE}t|not able to)\\b[^.?!\\n]{0,40}?\\b(?:open|load|read|see|access|view)`,
  "i",
);
const ASKS_AGAIN = /\b(?:paste|copy (?:and paste |the )?(?:text|words|it)|re-?send|send (?:it|that|the \w+) (?:again|over again)|share (?:it|that) again|type (?:it )?out)\b/i;

/** Whether an answer gives up on a file, or asks them for its words again. */
export function givesUpOnAFile(answer) {
  if (typeof answer !== "string" || !FILE.test(answer)) return false;
  return CANT_OPEN.test(answer) || ASKS_AGAIN.test(answer);
}

/** Which argument of which tool names a kept file (`withKeptFiles`). */
const READS = { read_file: "path", read_note: "path", fetch: "id", list_notes: "prefix" };

/** Whether this call read (or tried to read) a kept file. */
export function readsAKeptFile(name, args) {
  const field = READS[name];
  return field !== undefined && keptRef(args?.[field]) !== null;
}

export function keptFileNotice(ids, { shown = false } = {}) {
  const id = ids[0];
  return (
    `Before this goes: the file they sent is kept as ${id}${ids.length > 1 ? ` (and ${ids.slice(1).join(", ")})` : ""}` +
    `${shown ? ", and it is shown above in this very text" : ""}. Read it now: read_file with path "${id}" (or fetch with that id alone), then answer from what it says. ` +
    "What you said from it earlier stands unless the file says otherwise. Never say it won't open or load, and never ask them to paste, copy or resend it, " +
    "unless read_file itself refused it; then say plainly what it said."
  );
}
