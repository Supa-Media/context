/**
 * A PAGE'S COVER: the first screen of a `.page.md` note as a picture, texted
 * with the page's link (owner, 2026-10-27: "job results become pages").
 *
 * `draw_visual { template: "page", data: { path } }` reads the note through
 * the turn's own `read_note`, so the cover shows nothing the turn could not
 * read, and draws its header and first block with the page runtime's own
 * renderer and sheet (`packages/shared/src/pages/`): the picture is the page,
 * not a second design of it. The screenshot Worker runs no script and loads
 * nothing the turn did not vouch for, so a page's code boxes are left out and
 * its own CSS can restyle the cover but never load anything.
 *
 * Decision: `docs/decisions/app-and-console/pages.md`.
 */

import { isPagePath, parsePage } from "../../../../../packages/shared/src/pages/parse.cjs";
import { renderPage } from "../../../../../packages/shared/src/pages/render.cjs";
import { BASE_CSS, pageTokens } from "../../../../../packages/shared/src/pages/css.cjs";

export const PAGE_TEMPLATE = "page";
export const PAGE_TEMPLATE_LINE = "the first screen of a page you wrote (a .page.md note), to text with its link. {path}";

/** The cover is drawn at half size and photographed at twice that: 1080 x 1350, a portrait post. */
const WIDTH = 540;
const HEIGHT = 675;
const SCALE = 2;

const COVER_CSS = `
body{zoom:${SCALE};width:${WIDTH}px;height:${HEIGHT}px;overflow:hidden}
.pg{max-width:none;padding:34px 28px 0}
`;

/** CSS can't end the style element it is in. */
const sealed = (css) => css.replace(/<\/?style/gi, "\\3C style");

/**
 * The cover page for a note's text, sized for `draw`, or an error the model
 * can act on. `theme` is the turn's pick; the page's own `theme:` wins.
 */
export function pageCover(path, text, theme) {
  if (!isPagePath(String(path ?? ""))) return { error: 'The page template draws a .page.md note: pass data: { path: "<name>.page.md" }.' };
  if (typeof text !== "string" || text.trim() === "") return { error: `There is no page at ${String(path).slice(0, 200)} to draw. Write it first, then draw it.` };
  const page = parsePage(text);
  const drawn = renderPage(page, { cover: true });
  const { vars } = pageTokens(page.fields, theme === "dark");
  // A cover is a picture: no link in it goes anywhere, and none should count as an address it tried to load.
  const body = drawn.html.replace(/\s(?:data-)?href="[^"]*"/g, "");
  const html =
    `<!doctype html><html><head><meta charset="utf-8"><style>:root{${vars}}${BASE_CSS}${COVER_CSS}${sealed(drawn.css.join("\n"))}</style></head>` +
    `<body><main class="pg">${body}</main></body></html>`;
  return { html, width: WIDTH * SCALE, height: HEIGHT * SCALE };
}
