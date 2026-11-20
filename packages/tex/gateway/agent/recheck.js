/**
 * Said after every recheck notice: only the turn's last answer is sent, so
 * the one written after a notice must carry the whole reply (the owner's
 * 1:1, 2026-10-26: five priced lunch spots found, then a notice's round
 * texted only "Namudol ... I can't give you a price for it").
 */
export const RECHECK_REPLACES =
  "\n\nOnly your next answer is sent, in place of every draft quoted above, so it must stand on its own: keep every option, figure and link from it they still need, changed only as this note asks, " +
  "written as plain text without the > marks, and never mention this note.";

/**
 * SAID BEFORE EVERY RECHECK NOTICE: WHO WROTE IT, AND WHAT THE PERSON HAS SEEN.
 *
 * A notice reaches the model as the next user message, right after the
 * unsent draft, so it reads like a text from the person replying to a text
 * Tex sent. On 2026-10-29, in a tester's chat, the calendar notice fired on
 * a passkey answer. Tex then texted a denial about a calendar nobody had
 * mentioned, answering the note as if they had asked. It also treated the
 * draft as something they had read. So every notice now starts by saying it
 * is the gateway's, and that the draft never went. Since 2026-11-05 the draft
 * is quoted inside the note (`sendBack.js`), never put in as said, so the
 * wording points below, at the quote.
 */
export const RECHECK_FROM =
  "[A check Context ran on your draft, not a text from them. They have not seen your draft quoted below or this note; " +
  "the last thing they read from you is your last answer before their text, and their newest text is still the one you are answering. " +
  "If this note doesn't fit what they asked, send your latest draft again as it was (its words, without the > marks), and never answer the note itself or say you didn't do what it names.]\n\n";

/** A notice as the model is shown it: whose it is first, then the notice, then that the next answer replaces the draft. */
export function recheckNote(notice) {
  return RECHECK_FROM + notice + RECHECK_REPLACES;
}
