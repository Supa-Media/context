/**
 * A page's own layout: HTML and CSS that place the page's sections, for work
 * that needs to look designed (owner, 2026-11-10: pages "similar to instinct",
 * "extensible enough for custom Ui using html css"; the Instinct roast:
 * editorial type, numbered findings, exhibits you tap to enlarge).
 *
 * The words stay in the note as Markdown. A ```` ```layout ```` fence holds
 * the HTML, and each `data-from` in it names what the runtime puts there:
 * `cover` (the title, the opening line and the cover), a `##` section by its
 * heading, or `rest` (every section the layout doesn't name). A section the
 * layout doesn't place and there is no `rest` for is added at the end, so a
 * layout never hides a word, and editing, comments, search and export all
 * keep working on the Markdown. Delete the fence and the page reads as it did.
 *
 * The layout is drawn only inside the sealed page frame, whose policy loads
 * nothing and runs only the runtime's own script; this file refuses at write
 * what the frame would strip anyway (`problems`), so a writer learns what is
 * not allowed instead of seeing it vanish, and the frame strips it again
 * (`apps/mobile/page-frame/layout.js`). Decision:
 * `docs/decisions/app-and-console/pages.md`, "A page can have a layout of its own".
 */

"use strict";

/** The longest layout, in characters: a layout places words, it doesn't hold them. */
const MAX_LAYOUT_CHARS = 40_000;

/** Elements a layout may not hold: anything that runs, loads, embeds, submits or redirects. */
const BANNED_TAGS = ["script", "iframe", "frame", "frameset", "object", "embed", "applet", "base", "meta", "link", "form", "input", "button", "textarea", "select", "option", "portal", "template", "svg", "math", "noscript"];

const CHECKS = [
  [new RegExp(`<\\s*(?:${BANNED_TAGS.join("|")})\\b`, "i"), (m) => `a layout can't hold ${m[0].replace(/[<\s]/g, "")} elements: it places the page's words and pictures, nothing that runs, loads or sends.`],
  [/\son[a-z]+\s*=/i, () => "a layout can't hold event handlers (onclick= and the like): nothing in it runs."],
  [/(?:javascript|vbscript|data)\s*:(?!image\/(?:png|jpeg|gif|webp);base64,)/i, () => "a layout can't link to javascript: or data: addresses."],
  [/@import\b/i, () => "a layout's CSS can't @import: it loads nothing."],
  [/url\(\s*['"]?(?!data:image\/)/i, () => "a layout's CSS can't load url(...) from anywhere: use the page's own photos in its sections."],
  [/\b(?:src|srcset|href|action|formaction|poster|background)\s*=/i, () => "a layout can't name its own addresses (src=, href=): pictures and links come from the page's words."],
];

/** What `data-from` names in a layout, in order, each once. */
function layoutSlots(html) {
  const seen = new Set();
  for (const match of String(html ?? "").matchAll(/\bdata-from\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const name = (match[1] ?? match[2] ?? "").trim();
    if (name !== "") seen.add(name);
  }
  return [...seen];
}

/** Section headings as a layout names them: case and spacing don't matter. */
function slotKey(name) {
  return String(name ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Why a layout can't be used, as page problems, or none. `sections` are the
 * page's `##` headings as text, so a slot that names no section is caught.
 */
function layoutProblems(html, sections = []) {
  const text = String(html ?? "");
  const problems = [];
  if (text.length > MAX_LAYOUT_CHARS) problems.push({ message: `a layout is at most ${MAX_LAYOUT_CHARS.toLocaleString("en-US")} characters; this one is ${text.length.toLocaleString("en-US")}.` });
  for (const [pattern, say] of CHECKS) {
    const found = pattern.exec(text);
    if (found) problems.push({ message: `This layout can't be drawn: ${say(found)}` });
  }
  const slots = layoutSlots(text);
  if (slots.length === 0) problems.push({ message: 'This layout can\'t be drawn: it places nothing. Name what goes where with data-from="cover", data-from="<a ## heading>" or data-from="rest".' });
  const known = new Set(["cover", "rest", ...sections.map(slotKey)]);
  for (const slot of slots) {
    if (!known.has(slotKey(slot))) problems.push({ message: `This layout's data-from="${slot.slice(0, 80)}" names no ## section of this page.` });
  }
  return problems;
}

module.exports = { MAX_LAYOUT_CHARS, BANNED_TAGS, layoutProblems, layoutSlots, slotKey };
