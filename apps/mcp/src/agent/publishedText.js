/**
 * PUBLISHED TEXT IS TEX'S TO FIND, NEVER THEIRS TO PASTE (owner, 2026-10-27).
 *
 * Asked to fill in the verse analysis of a Bible study note, Tex texted "I
 * couldn't open the LSB text for chapter 32 from here, so I haven't quoted
 * any verses. Paste them in and I'll quote them from your text." The owner:
 * "why is this a problem for tex?" A Bible chapter in a named translation is
 * on several public sites, and Tex has web search, a page reader and a real
 * browser. The same thing happened on 2026-10-22 for chapters 28 and 29
 * (`sources.js`).
 *
 * Every check that existed let that answer go:
 *
 *   - `TRY_NOTICE` (`claimCheck.js`) fires only when nothing on the web was
 *     tried. Here a page read had been tried and failed.
 *   - The browser checks want the answer to name a browser, page or site
 *     ("the LSB text for chapter 32" names none), or a failed browse step,
 *     and browse was never tried at all.
 *   - `otherRoutes.js` looks for "can't tell/check/find", not "couldn't open",
 *     and its other roads are email, calendar and notes, not another site.
 *   - The hand-back patterns know forwarding, checking and looking up, not
 *     pasting; and the hand-back judge only reads an answer with a question
 *     mark, which "Paste them in" has none of.
 *
 * So two checks, each once a turn and each judged on the answer's words and
 * the names of the calls the turn made, never on what a page said:
 *
 *   1. The answer asks them to paste or send text that is published (verses,
 *      a passage, lyrics, an article): one more round to find it, naming the
 *      way (search with the translation's name, browse when a read comes back
 *      refused or empty, the next site that carries it).
 *   2. The answer says it couldn't open or read something after a page read
 *      failed, with the browser on offer and never tried: one more round to
 *      open it with browse or find the same text on another site.
 *
 * And a page read that comes back with almost no text says so in its result
 * (`thinPageHint`): a reading site that draws its text with scripts looks
 * empty to a plain fetch, and the model should know to open it with browse
 * rather than call it unreadable.
 */

/** Text that is published somewhere, as an answer names it. */
const PUBLISHED =
  String.raw`(?:verses?|passages?|scriptures?|chapters?|psalms?|lyrics|poem|article|transcript|the (?:text|words|wording|quote|quotes)|its (?:text|words))`;

const ASKS_FOR_IT = [
  // "Paste them in", "paste it here", "if you paste the verses".
  /\bpaste\s+(?:them|it|those|that|these)\s+(?:in|here|over|into)\b/i,
  new RegExp(String.raw`\b(?:paste|copy(?:[- ]and[- ]|[- ])paste)\b[^.?!\n]{0,40}\b${PUBLISHED}`, "i"),
  // "Send me the verses", "text me the passage", "share the lyrics".
  new RegExp(String.raw`\b(?:send|text|share|type)\s+(?:me|over)\s+(?:the\s+|those\s+|these\s+|that\s+)?(?:\w+\s+){0,3}?${PUBLISHED}`, "i"),
];

/** Whether an answer asks them to paste or send text that is published. */
export function asksForPublishedText(answer) {
  const said = String(answer ?? "").replace(/[‘’]/g, "'");
  return said
    .split(/\n+|(?<=[.!?])\s+/)
    .some((sentence) => ASKS_FOR_IT.some((pattern) => pattern.test(sentence)));
}

/** The one more round for an answer that asks them for published text. */
export function publishedTextNotice({ canBrowse = false } = {}) {
  return (
    "Before this goes: your answer asks them to paste or send text that is published (a Bible passage in a named translation, lyrics, an article, a law), and finding it is yours. " +
    "Search for it with search_web, naming the passage and the translation or source (\"Deuteronomy 32 LSB\", \"Legacy Standard Bible Deuteronomy 32\"), and open the results. " +
    (canBrowse
      ? "When a page comes back refused, empty or without the text, open the same address with browse, which reads it the way a person's browser shows it, and then try the next site that carries it. "
      : "When a page comes back refused, empty or without the text, open the next site that carries it. ") +
    "Bible sites such as Bible Gateway, Bible Hub, Blue Letter Bible and bible.com each carry many translations. " +
    "Then do what they asked with the text you read, and name the page it came from. " +
    "Only if every site failed, say in one line which sites you tried and what each did, without asking them to paste it. " +
    "If those words weren't asking them for published text, send your answer again as it was."
  );
}

/** The calls that read a web page without a browser. */
const PAGE_READS = new Set(["open_page"]);

/** Whether this turn's steps had a page read fail. */
export function aPageReadFailed(steps = []) {
  return steps.some((step) => PAGE_READS.has(step?.name) && step.ok === false);
}

export const READ_FAILED_NOTICE =
  "Before this goes: a page read failed and your answer says you couldn't open or read it, but you never opened it in your browser. " +
  "Many sites refuse a plain read or draw their text with scripts, and browse reads them the way a person's browser shows them. " +
  "Open the same address with browse now, and if it still won't show the text, search_web for the same text on another site and open that. " +
  "Then answer from what you read and name the page. If your answer wasn't about a page, send it again as it was.";

/** Below this many characters, a page read probably missed text a browser would show. */
export const THIN_PAGE_CHARS = 200;

/** A line for a page read that came back with almost no text; empty otherwise. */
export function thinPageHint(text) {
  return String(text ?? "").trim().length < THIN_PAGE_CHARS
    ? "Almost no text came back from this page: it may draw its text with scripts or hide it from plain reads. Open it with browse to read it as a browser shows it, or open the same text on another site."
    : "";
}
