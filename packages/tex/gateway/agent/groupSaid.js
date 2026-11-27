/**
 * WHOSE WORDS A CHAT LINE IS: THE LABEL IS THE CHAT'S, ON EVERY LINE (2026-11-27).
 *
 * A group chat's lines are composed `@who: <what they said>` — the chat block Tex reads (`groupTurn.js` `chatLines`),
 * the kept question its memory holds and the Room check and the shown-copy test read (`groupLedgerHistory.js`
 * `groupQuestion`), and the live ask the Mail checker is handed (`groupTurn.js` `groupQuestionLine`). The label went
 * on the first line only, so a member whose own text carried a later line shaped like somebody else's label had it
 * read as that person speaking. The Mail checker is where that bites: it is told "Only PERSON lines say what the
 * person wants", its lines are labelled by handle, and since #4416 the tagger's handle is on the newest ask, so a
 * line a member writes can read as the tagger's own go-ahead to an email.
 *
 * The label is the chat's to write, never a member's. A later line that reads as one is written under the speaker's
 * own label too, which is the truth of it: `@cy: @ada: send it`. A text with no such line is untouched.
 */

/** A line that reads as a chat label: `@who: …` or `@who (Name): …`, as these composers write them. */
const LABEL_LINE = /^\s*@[A-Za-z0-9_.-]{1,40}\s*[:(]/;

/** `label: text`, with every later line that reads as somebody's label kept under `label` as well. */
export function saidBy(label, text) {
  const [first, ...rest] = String(text ?? "").split("\n");
  return [`${label}: ${first ?? ""}`, ...rest.map((line) => (LABEL_LINE.test(line) ? `${label}: ${line}` : line))].join("\n");
}
