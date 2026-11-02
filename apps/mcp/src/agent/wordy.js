/**
 * A TEXT, NOT AN ESSAY (Dev2, 2026-10-29: "TEX NEEDS TO STOP BEING SO WORDY
 * WHAT THE HECK").
 *
 * Asked for a research page with diagrams and its take, Tex made the page and
 * then texted two long bubbles: one describing what the page holds, one with
 * its take and three reasons. What Dev2 wanted was one casual line: "I think
 * you keep what you've got, and borrow some of the stuff from Cloudflare,
 * here are my notes", with the link. The prompt already said to keep it
 * short; a job was told to "end with the result in a few lines", and a few
 * lines is what came back.
 *
 * Two shapes the gateway can count for itself, each sent back once:
 *
 *   1. The turn drew a picture or wrote a page, and the words beside it go
 *      past one line. The page or the card is the answer; the text is the
 *      bottom line and nothing that restates it.
 *   2. Any other answer whose sentences run past a few short texts. Short
 *      list lines (things to do, a list of names) and links are not counted:
 *      a list is already the short form.
 *
 * Neither applies when they asked for the long form (explain, in detail, walk
 * me through, a draft to copy) or set their length to detailed.
 */

/** The tools whose picture is the answer, as `visuals/notice.js` counts them. */
const DRAWN = new Set(["draw_visual", "draw_picture", "make_picture"]);

/** Words beside a page or a card: one line, as `PAGES_LINE` and "Answer with a picture" say. */
export const BESIDE_A_RESULT_WORDS = 30;
/** Words of sentences in any other answer: two or three short texts. */
export const MAX_PROSE_WORDS = 70;
/** A line of at most this many words is a list item, not a sentence. */
const ITEM_WORDS = 8;

/** They asked for the long form, or for words to copy. */
const WANTS_LONG =
  /\b(?:explain|in (?:more )?detail|detailed|elaborate|walk me through|break (?:it|this|that) down|tell me (?:more|everything)|go deeper|long(?:er)? version|full (?:answer|version|breakdown)|draft|write (?:me |up )?(?:a|an|the)\b|word for word|verbatim|copy(?:\s+and\s+|\s*\/\s*)paste)/i;
/** An answer that is a draft for someone else or a code to copy stays as it is. */
const TO_COPY = /^(?:subject|to|dear|hi [A-Z][a-z]+,)\b|```/im;

/** The words of an answer that are sentences: links, picture markers and short list lines left out. */
export function proseWords(answer) {
  let count = 0;
  for (const raw of String(answer ?? "").split(/\r?\n/)) {
    const line = raw
      .replace(/\[picture \d+\]/gi, " ")
      .replace(/\bhttps?:\/\/\S+/gi, " ")
      .trim();
    const words = line.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
    if (words > ITEM_WORDS || /[.!?]\s*$/.test(line)) count += words;
  }
  return count;
}

/** Whether this turn drew a picture or wrote a page (`steps` as `claimCheck.js` records them). */
export function madeAResult(steps = []) {
  return steps.some((step) => step.ok && (DRAWN.has(step.name) || step.page === true));
}

/** Whether they asked for the long form, or the answer is words to copy. */
function longAsked(question, answer, detailed) {
  return detailed === true || WANTS_LONG.test(String(question ?? "")) || TO_COPY.test(String(answer ?? ""));
}

/** Words beside a drawn picture or a written page that go past one line. */
export function restatesTheResult(answer, { question = "", steps = [], detailed = false } = {}) {
  return madeAResult(steps) && !longAsked(question, answer, detailed) && proseWords(answer) > BESIDE_A_RESULT_WORDS;
}

/** An answer whose sentences run past a few short texts. */
export function tooWordy(answer, { question = "", steps = [], detailed = false } = {}) {
  return !madeAResult(steps) && !longAsked(question, answer, detailed) && proseWords(answer) > MAX_PROSE_WORDS;
}

export const RESULT_NOTICE =
  "Before this goes: the page or picture you made is the answer, and your text goes on to describe it. Send it again as ONE casual line of at most 25 words: " +
  "your bottom line or your take, the way a friend would text it (\"I think you keep what you've got and borrow some of Cloudflare's stuff, here are my notes\"), " +
  "then the link on its own line and any [picture N] as it was. Never say what's on the page or in the picture, and no reasons unless they asked why.";

export const WORDY_NOTICE =
  "Before this goes: that's an essay, and this is a text. Send it again cut to what they need: the answer or your take first, in one or two short sentences, " +
  "the way a friend texts. Drop the recap, the reasons they didn't ask for and anything they already know. Keep every link, list line, figure and question that matters; " +
  "if it truly needs more, two short texts at most.";
