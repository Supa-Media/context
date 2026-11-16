/**
 * A click by the words on the thing: the element that shows them is marked
 * for the press. Split from ./browse.ts, which drives the steps.
 */

import { MAX_SCANNED } from "./reading";

/** The most words a click-by-words step may name: a button's or an option's, not a paragraph. */
export const MAX_CLICK_TEXT = 200;

export const BY_WORDS = `[data-tex-words]`;

/**
 * Mark the element that shows `words`, for a click: the smallest visible one
 * whose own text is exactly those words (any case and spacing), else the
 * smallest that starts with them. A picker's option or a box with only a
 * click handler has no number in a reading, and the words on it are what a
 * person would point at.
 */
export function wordsSource(words: string): string {
  return `(() => {
  for (const el of document.querySelectorAll("${BY_WORDS}")) el.removeAttribute("data-tex-words");
  const norm = (s) => (s || "").replace(/\\s+/g, " ").trim().toLowerCase();
  const want = norm(${JSON.stringify(words)});
  if (!want) return false;
  const visible = (el) => {
    const box = el.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return false;
    const style = getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  };
  let exact = null, starts = null;
  const all = document.body ? document.body.querySelectorAll("*") : [];
  for (let i = 0; i < all.length && i < ${MAX_SCANNED}; i++) {
    const el = all[i];
    const tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "HTML" || tag === "BODY") continue;
    const text = norm(el.innerText || el.getAttribute("aria-label") || el.value);
    if (!text || text.length > ${MAX_CLICK_TEXT * 2}) continue;
    const size = el.querySelectorAll("*").length;
    if (text === want && (!exact || size <= exact.size) && visible(el)) exact = { el, size };
    else if (!exact && text.startsWith(want) && (!starts || text.length < starts.length) && visible(el)) starts = { el, length: text.length };
  }
  const found = exact ? exact.el : starts ? starts.el : null;
  if (!found) return false;
  found.setAttribute("data-tex-words", "1");
  return true;
})()`;
}
