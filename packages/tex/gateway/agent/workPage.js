/**
 * WORK TEX DID IS SHOWN AS A PAGE (owner, 2026-11-10: pages were "supposed to
 * ... be the default for all work output done through Tex that would be shown
 * to the user").
 *
 * A new note was already a page (`pageNotice.js`), and a background job
 * already delivered one (`PAGE_JOB_LINE`). What still came back as a wall of
 * text was work done in the turn itself: Tex searched, opened sites or
 * browsed, then texted what it found, the options, prices and sources, as
 * bubbles. That is a page someone looks at and comes back to, not a text.
 *
 * So an answer is sent back once to be a page when the turn looked things up
 * on the web and the answer is long (every word counted, list lines too: a
 * list of findings is the work, not the short form) or is a list of several
 * findings. A quick answer stays a text: a short reply, a turn that only read
 * their own notes, an answer that already made a page or a picture, a draft
 * to copy, or one they asked to have as a text.
 */

import { madeAResult } from "./wordy.js";

/** The tools that look things up on the web, as a turn's steps name them (directly, or as a send action). */
const LOOKED_UP = new Set(["search_web", "open_page", "browse"]);

/** Every word of the answer past this is a page's worth. */
export const WORK_WORDS = 110;
/** Or this many list lines of findings, with at least `WORK_LIST_WORDS` words in all. */
export const WORK_ITEMS = 4;
const WORK_LIST_WORDS = 50;

/** They want it as a text: in a text, quickly, just the answer, no page. */
const WANTS_A_TEXT =
  /\b(?:(?:just |quick(?:ly)? )?(?:text|tell) me|in (?:a|the|one) text|quick(?:ly)?|short (?:answer|version)|tl;?dr|just (?:the|a) (?:answer|number|name|link)|no page|not (?:as )?a page|without a page|plain (?:text|note))\b/i;
/** Words for someone else to copy, or code, stay as they are. */
const TO_COPY = /^(?:subject|to|dear|hi [A-Z][a-z]+,)\b|```/im;

/** Whether the turn looked things up on the web. */
export function lookedUp(steps = []) {
  return steps.some((step) => step.ok && (LOOKED_UP.has(step.name) || (step.name === "send" && LOOKED_UP.has(step.action))));
}

/** Every word of the answer, and how many of its lines are list lines. Links and picture markers are not words. */
function measure(answer) {
  let words = 0;
  let items = 0;
  for (const raw of String(answer ?? "").split(/\r?\n/)) {
    const line = raw.replace(/\[picture \d+\]/gi, " ").replace(/\bhttps?:\/\/\S+/gi, " ").trim();
    if (line === "") continue;
    words += line.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
    if (/^(?:[-*•]|\d+[.)])\s+\S/u.test(line)) items += 1;
  }
  return { words, items };
}

/** Whether this answer is work to show as a page rather than to text. */
export function workForAPage(answer, { question = "", steps = [] } = {}) {
  if (madeAResult(steps) || !lookedUp(steps)) return false;
  if (WANTS_A_TEXT.test(String(question ?? "")) || TO_COPY.test(String(answer ?? ""))) return false;
  const { words, items } = measure(answer);
  return words > WORK_WORDS || (items >= WORK_ITEMS && words > WORK_LIST_WORDS);
}

export const WORK_PAGE_NOTICE =
  "Before this goes: this is work they'll look at and come back to, so it's a page, not a text. " +
  'Pick the template that fits (orient about: "pages" lists them, and their own in tex/templates/ come first), ' +
  "write it as a .page.md note with every finding, figure and source you used, draw its cover (send action draw_visual, template page, data { path }), " +
  "then text ONE casual line with your take and the page's link. Never paste the findings into the text. " +
  "Only if you can't write a note here, send it as a text cut to your take and the few findings that matter.";
