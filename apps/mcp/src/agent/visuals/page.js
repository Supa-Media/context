/**
 * A PAGE'S COVER: the first screen of a `.page.md` note as a picture, texted
 * with the page's link (owner, 2026-10-27: "job results become pages").
 *
 * `draw_visual { template: "page", data: { path } }` reads the note through
 * the turn's own `read_note`, so the cover shows nothing the turn could not
 * read, and draws its header and first block with the page runtime's own
 * renderer and sheet (`packages/shared/src/pages/`): the picture is the page,
 * not a second design of it. The screenshot Worker runs no script and loads
 * nothing the turn did not vouch for, so a page's code boxes are left out, its
 * own CSS can restyle the cover but never load anything, and its photos are
 * read through the page's own note (`coverPictures`) and drawn in as bytes.
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
`;

/** The page's own faces, linked as Tex's cards link them (`kit.js`); the screenshot Worker lets Google Fonts load. */
const FONTS = "https://fonts.googleapis.com/css2?family=Instrument+Sans:wght@400;500;600&family=JetBrains+Mono:wght@500&display=block";

/** At most this many of a cover's pictures are read and drawn into it. */
export const MAX_COVER_PICTURES = 6;

/** CSS can't end the style element it is in. */
const sealed = (css) => css.replace(/<\/?style/gi, "\\3C style");

const UNESCAPE = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };

/**
 * The pictures a cover would show (`data-src` in its drawing), so the caller
 * can read them as the turn may (`read_image` through the page's own note) and
 * hand their bytes back to `pageCover`. A cover is a picture: nothing in it
 * loads anything by itself.
 */
export function coverPictures(text) {
  if (typeof text !== "string" || text.trim() === "") return [];
  const { html } = renderPage(parsePage(text), { cover: true });
  const found = [...html.matchAll(/data-src="([^"]*)"/g)].map((m) => m[1].replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => UNESCAPE[e]));
  return [...new Set(found)].slice(0, MAX_COVER_PICTURES);
}

/**
 * The cover page for a note's text, sized for `draw`, or an error the model
 * can act on. `theme` is the turn's pick; the page's own `theme:` wins.
 * `images` maps a picture's name in the page to a `data:` URL already read.
 */
export function pageCover(path, text, theme, images = null) {
  if (!isPagePath(String(path ?? ""))) return { error: 'The page template draws a .page.md note: pass data: { path: "<name>.page.md" }.' };
  if (typeof text !== "string" || text.trim() === "") return { error: `There is no page at ${String(path).slice(0, 200)} to draw. Write it first, then draw it.` };
  const page = parsePage(text);
  const pictures = new Map([...(images ?? new Map())].filter(([, data]) => /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(String(data))));
  const drawn = renderPage(page, { cover: true, images: pictures });
  const { vars } = pageTokens(page.fields, theme === "dark");
  // A cover is a picture: no link in it goes anywhere, and none should count as an address it tried to load.
  const body = drawn.html.replace(/\s(?:data-)?href="[^"]*"/g, "").replace(/\sdata-src="[^"]*"/g, "");
  const html =
    `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${FONTS.replace(/&/g, "&amp;")}"><style>:root{${vars}}${BASE_CSS}${COVER_CSS}${sealed(drawn.css.join("\n"))}</style></head>` +
    `<body><main class="pg">${body}</main></body></html>`;
  return { html, width: WIDTH * SCALE, height: HEIGHT * SCALE };
}
