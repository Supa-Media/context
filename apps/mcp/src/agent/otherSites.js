/**
 * ONE SITE FAILING NEVER ENDS THE LOOKING (owner, 2026-10-27).
 *
 * Asked to fill in the verse analysis of a Bible study note, Tex texted "I
 * couldn't open the LSB text for chapter 32 from here, so I haven't quoted
 * any verses. Paste them in and I'll quote them from your text." The owner:
 * "why is this a problem for tex?", and then: not a list of Bible sites,
 * "ideally this should expand to all websites, articles, platforms and etc.
 * Tex should be able to look at alternative sites if one doesn't work." The
 * same thing happened on 2026-10-22 for chapters 28 and 29 (`sources.js`).
 *
 * Every check that existed let that answer go:
 *
 *   - `TRY_NOTICE` (`claimCheck.js`) fires only when nothing on the web was
 *     tried. Here a page read had been tried and failed.
 *   - The browser checks want the answer to name a browser, page or site
 *     ("the LSB text for chapter 32" names none), or a failed browse step.
 *   - `otherRoutes.js` looks for "can't tell/check/find", not "couldn't open",
 *     and its other roads are email, calendar and notes, not another site.
 *   - The hand-back patterns know forwarding, checking and looking up, not
 *     pasting; and the hand-back judge only reads an answer with a question
 *     mark, which "Paste them in" has none of.
 *
 * Underneath all of them: a failed read told the model only "That page could
 * not be opened.", so one refusal looked like the end of the road. Now:
 *
 *   1. A failed read says what to do next (`READ_FAILED_NEXT`): the same
 *      address in the browser, or the same content on another site.
 *   2. An answer that gives up on something from the web after a page read failed,
 *      with fewer than `ENOUGH_SITES` sites tried, goes back once to find it
 *      elsewhere (`otherSitesNotice`). Sites are counted by host from the
 *      addresses the turn's reads and browser steps asked for.
 *   3. An answer asking them to paste or send text that is published (a
 *      passage, lyrics, an article, a post) goes back once, tried or not.
 *
 * No site is named anywhere: which sites carry a thing is the search's to find.
 * Judged on the answer's words, the calls' names and the addresses they were
 * asked for, never on what a page said.
 */

/** Fewer sites than this tried, and a give-up is premature. */
export const ENOUGH_SITES = 3;

/** What a failed page read tells the model to do next. */
export const READ_FAILED_NEXT =
  "One site failing doesn't mean the content isn't out there: open the same address with browse, which reads it the way a person's browser does, " +
  "or search_web for the same content (its title, or what it is and where it's from) and open a result on a different site.";

/** Text that is published somewhere, as an answer names it. */
const PUBLISHED =
  String.raw`(?:verses?|passages?|scriptures?|chapters?|psalms?|lyrics|poem|article|post|thread|recipe|transcript|menu|the (?:text|words|wording|quote|quotes|page|listing)|its (?:text|words))`;

const ASKS_FOR_IT = [
  // "Paste them in", "paste it here", "if you paste the verses".
  /\bpaste\s+(?:them|it|those|that|these)\s+(?:in|here|over|into)\b/i,
  new RegExp(String.raw`\b(?:paste|copy(?:[- ]and[- ]|[- ])paste)\b[^.?!\n]{0,40}\b${PUBLISHED}`, "i"),
  // "Send me the verses", "text me the passage", "share over the lyrics".
  new RegExp(String.raw`\b(?:send|text|share|type)\s+(?:me|over)\s+(?:the\s+|those\s+|these\s+|that\s+)?(?:\w+\s+){0,3}?${PUBLISHED}`, "i"),
];

/** Whether an answer asks them to paste or send text that is published. */
export function asksForPublishedText(answer) {
  const said = String(answer ?? "").replace(/[‘’]/g, "'");
  return said.split(/\n+|(?<=[.!?])\s+/).some((sentence) => ASKS_FOR_IT.some((pattern) => pattern.test(sentence)));
}

/** The one more round for an answer that asks them for published text. */
export function publishedTextNotice({ canBrowse = false } = {}) {
  return (
    "Before this goes: your answer asks them to paste or send something that is published (a passage, lyrics, an article, a post, a listing), and finding it is yours. " +
    "Search for it with search_web, naming what it is and where it's from, and open the results. " +
    (canBrowse
      ? "When a page comes back refused, empty or without it, open the same address with browse, then try a result on another site. "
      : "When a page comes back refused, empty or without it, open a result on another site. ") +
    "Then do what they asked with what you read, and name the page it came from. " +
    "Only if several sites failed, say in one line which you tried and what each did, without asking them to paste it. " +
    "If those words weren't asking them for published text, send your answer again as it was."
  );
}

/** The hosts a web call asked for: `open_page`'s url or urls, `browse`'s goto steps. */
export function hostsAsked(name, args) {
  const urls =
    name === "open_page"
      ? [...(Array.isArray(args?.urls) ? args.urls : []), args?.url]
      : name === "browse" && Array.isArray(args?.steps)
        ? args.steps.filter((step) => step?.do === "goto").map((step) => step.url)
        : [];
  const hosts = [];
  for (const url of urls) {
    try {
      hosts.push(new URL(String(url)).hostname.replace(/^www\./, "").toLowerCase());
    } catch {
      // Not an address: no site.
    }
  }
  return hosts;
}

/**
 * Whether this turn had a page read fail. A failed browser step is not
 * counted: it may be a click on the one site that has their cart or account,
 * where another site is no answer, and `BROWSER_RETRY_NOTICE` already runs it
 * again and says to search for a page the browser couldn't open.
 */
export function aSiteFailed(steps = []) {
  return steps.some((step) => step?.name === "open_page" && step.ok === false);
}

/** The one more round for an answer that gives up after too few sites. */
export function otherSitesNotice({ sites = 0, canBrowse = false } = {}) {
  return (
    `Before this goes: a page failed and your answer gives up, but you've tried ${sites === 1 ? "one site" : `${sites} sites`}. ` +
    "The same content is almost always on other sites: search_web for it (its title, or what it is and where it's from) and open results on different sites" +
    (canBrowse ? ", and open a page that refused you with browse, which reads it the way a person's browser does. " : ". ") +
    "Then do what they asked with what you read, and name where it came from. " +
    "Only if several sites failed, say in one line which you tried and what each did, and never ask them to find, paste or send it. " +
    "If your answer wasn't giving up on something from the web, send it again as it was."
  );
}

/** Below this many characters, a page read probably missed text a browser would show. */
export const THIN_PAGE_CHARS = 200;

/** A line for a page read that came back with almost no text; empty otherwise. */
export function thinPageHint(text) {
  return String(text ?? "").trim().length < THIN_PAGE_CHARS
    ? "Almost no text came back from this page: it may draw its text with scripts or hide it from plain reads. Open it with browse to read it as a browser shows it, or find the same content on another site."
    : "";
}
