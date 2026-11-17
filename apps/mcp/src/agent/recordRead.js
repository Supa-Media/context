/**
 * READ THE RECORD BEFORE ANSWERING ABOUT IT (2026-11-17).
 *
 * The front door's words already say a note, a page, their mail and their
 * calendar are the record, and memory loses. Nothing held the
 * turn to that: a reply could name what a note says with no search and no
 * fetch, and the code checks only caught a claim that a write had happened.
 *
 * This one looks at the ask and the calls, not at how the reply is phrased.
 * An ask about a note, a page, mail or the calendar, answered with
 * no read this turn, goes back once. A general question does not. A turn that
 * already searched or fetched does not. The chat is not in it: a check-in
 * mentions the chat without asking to read it.
 */

/**
 * Their ask is to read a record, not a mention of one in passing.
 * "the chat" is left out: a check-in says "if nothing needs the chat", and that is not an ask to read the record.
 * "note" and "page" count only with a determiner right against them ("the note", "my page").
 * "note the tulips" is a verb, and "the status page" is a web page, not the record.
 */
const ABOUT_RECORD =
  /\b(?:what(?:'s| is| does| did)|read|check|look (?:at|in|up))\b[^?\n]{0,80}\b(?:notes|pages|emails?|e-mails?|gmail|inbox|mail|calendar|(?:my|your|their|our|the|a|an|this|that)\s+(?:note|page))\b/i;

/** A call that opens a record. The six tools and the names they resolve to. */
const READS =
  /^(?:search|fetch|orient|search_notes|read_note|read_notes|read_image|read_file|search_email|read_email|read_calendar|read_texts|list_texts|search_texts|read_day|read_thread|group_chats|read_back)$/;

export const RECORD_READ_NOTICE =
  "Before this goes: this asks about their notes, a page, their mail or their calendar, and you have not read any of it this turn. " +
  "Search or fetch the record first, then answer from what it says. Do not answer from memory.";

/** Whether the ask is about a record Tex can open. */
export function asksForTheRecord(question) {
  return ABOUT_RECORD.test(String(question ?? ""));
}

/** Whether this turn already opened a record. A failed call still counts: it tried. */
export function readTheRecord(steps) {
  return (Array.isArray(steps) ? steps : []).some((step) => READS.test(String(step?.name ?? "")));
}

/** The send-back, or null when the ask is not about a record or a read already happened. */
export function recordReadNotice(question, steps) {
  if (!asksForTheRecord(question) || readTheRecord(steps)) return null;
  return RECORD_READ_NOTICE;
}
