/**
 * NO PAGE GOES OUT BARE (owner, 2026-11-10: "WE NEED TO MAKE VISUAL PAGES").
 *
 * A background job wrote a research page on new NYC churches with no picture
 * of any kind, thought "the draw is optional, so I'll leave it out for time",
 * and texted the link. The cover call is what draws a bare page its picture
 * (`visuals/pageDrawing.js`), so skipping it left the page bare.
 *
 * So the gateway checks it: a turn that saved a page whose words hold no
 * picture of their own (no cover photo, no option's photo, no embedded
 * image, no map) and no Tex drawing, and made no cover call afterwards, is
 * sent back once to make that call. The cover call then draws the picture
 * (or, after its own tries, draws the cover without it), so a turn still
 * always ends.
 *
 * Decision: `docs/decisions/app-and-console/pages.md`, "A page always has a picture, and its people and links show".
 */

import { drawingOf, hasPicture } from "../../../../packages/shared/src/pages/cover.cjs";
import { isPagePath, parsePage } from "../../../../packages/shared/src/pages/parse.cjs";

/** The words a note write carries, as `write_note` or as a `write`/`send` that wraps one. */
function written(args) {
  const inner = args?.args && typeof args.args === "object" ? args.args : null;
  const path = typeof args?.path === "string" ? args.path : typeof inner?.path === "string" ? inner.path : "";
  const content = typeof args?.content === "string" ? args.content : typeof inner?.content === "string" ? inner.content : "";
  return { path: path.trim(), content };
}

/**
 * Whether a successful write saved a page with no picture of its own and no
 * drawing: its path then, else "". Only a write of the whole page is read; an
 * edit that sends no words is never counted.
 */
export function barePageWritten(args) {
  const { path, content } = written(args);
  if (!isPagePath(path) || content.trim() === "") return "";
  const page = parsePage(content);
  return hasPicture(page) || drawingOf(page) !== null ? "" : path;
}

/** Whether a step is a cover call: `draw_visual`, directly or as a `send` action. */
function drewACover(step) {
  return step.ok && (step.name === "draw_visual" || step.action === "draw_visual");
}

/**
 * Whether the turn saved a bare page (`bare` on its write step) and made no
 * cover call after it. The path, or "".
 */
export function bareCoverMissing(steps = []) {
  let bare = "";
  for (const step of steps) {
    if (typeof step.bare === "string" && step.bare !== "") bare = step.bare;
    else if (bare !== "" && drewACover(step)) bare = "";
  }
  return bare;
}

export function bareCoverNotice(path) {
  return (
    `Before this goes: the page you saved (${path}) has no picture at all, so it would open as a wall of words. ` +
    `Call draw_visual now with template page and data { path: "${path}", scene }: scene is your simple line drawing of what the page is about, ` +
    "and it is saved into the page as its picture. Then send your answer again with the link. This isn't optional."
  );
}
