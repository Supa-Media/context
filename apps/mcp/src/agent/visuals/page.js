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
 * A page Tex drew a picture for (`drawing:`, no picture of its own) is drawn
 * as a wide card instead: its kicker and title on the page's paper and the
 * drawing beside them, 1200 x 630, so the texted picture and the link's card
 * are one picture at the size every unfurler shows (`drawingCard`).
 *
 * Decisions: `docs/decisions/app-and-console/pages.md`,
 * `docs/decisions/app-and-console/page-drawings.md`.
 */

import { isPagePath, parsePage } from "../../../../../packages/shared/src/pages/parse.cjs";
import { renderPage } from "../../../../../packages/shared/src/pages/render.cjs";
import { BASE_CSS, pageTokens } from "../../../../../packages/shared/src/pages/css.cjs";
import { drawingOf, hasPicture, kickerOf, numberCover, pageKind } from "../../../../../packages/shared/src/pages/cover.cjs";

export const PAGE_TEMPLATE = "page";
export const PAGE_TEMPLATE_LINE =
  "the first screen of a page you wrote (a .page.md note), to text with its link. {path, scene}: a page with no picture of its own gets your drawing of it, so pass scene, a simple SVG line drawing of what the page is about on a 1200 x 900 canvas (it says how if you leave it out).";

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
  const card = drawingCard(page, theme, pictures);
  if (card) return card;
  const drawn = renderPage(page, { cover: true, images: pictures });
  const { vars } = pageTokens(page.fields, theme === "dark");
  // A cover is a picture: no link in it goes anywhere, and none should count as an address it tried to load.
  const body = drawn.html.replace(/\s(?:data-)?href="[^"]*"/g, "").replace(/\sdata-src="[^"]*"/g, "");
  const html =
    `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${FONTS.replace(/&/g, "&amp;")}"><style>:root{${vars}}${BASE_CSS}${COVER_CSS}${sealed(drawn.css.join("\n"))}</style></head>` +
    `<body><main class="pg">${body}</main></body></html>`;
  return { html, width: WIDTH * SCALE, height: HEIGHT * SCALE };
}

/** The wide card's size: the one every unfurler shows without cropping. */
export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 630;

const escText = (value) => String(value ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * The 1200 x 630 card of a page Tex drew a picture for, or null for any other
 * page: its kicker and title on the page's paper, the drawing on the right,
 * and "Context, made by Tex" at its foot (round 2 artboard, approved
 * 2026-11-03). The drawing is drawn in only as bytes already read; with none,
 * the page's first screen is drawn as before.
 */
export function drawingCard(page, theme, pictures) {
  if (hasPicture(page)) return null;
  const drawn = drawingOf(page);
  if (drawn === null || numberCover(page.fields)) return null;
  const { dark, vars } = pageTokens(page.fields, theme === "dark");
  const art = (dark && drawn.dark && pictures.get(drawn.dark)) || pictures.get(drawn.light);
  if (!art) return null;
  const kicker = kickerOf(page.fields, pageKind(page.fields));
  const title = page.title || "";
  const size = title.length > 60 ? 48 : 56;
  const html =
    `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${FONTS.replace(/&/g, "&amp;")}"><style>:root{${vars}}` +
    `html,body{margin:0;padding:0}body{width:${CARD_WIDTH}px;height:${CARD_HEIGHT}px;overflow:hidden;background:var(--pg-bg);display:grid;grid-template-columns:560px 640px;-webkit-font-smoothing:antialiased}` +
    `.t{padding:64px 24px 56px 64px;display:flex;flex-direction:column;min-width:0}` +
    `.k{font:500 20px var(--pg-mono);letter-spacing:.08em;text-transform:uppercase;color:var(--pg-accent)}` +
    `h1{font:600 ${size}px/1.04 var(--pg-sans);letter-spacing:-.025em;color:var(--pg-ink);margin:22px 0 0;text-wrap:balance;display:-webkit-box;-webkit-line-clamp:6;-webkit-box-orient:vertical;overflow:hidden}` +
    `.w{margin-top:auto;font:600 26px var(--pg-sans);color:var(--pg-ink);display:flex;align-items:center;gap:12px}` +
    `.w i{width:12px;height:12px;border-radius:3px;background:#2F7BF5;display:inline-block;margin-left:-8px;margin-top:12px}` +
    `.w span{font:400 20px var(--pg-sans);color:var(--pg-muted);margin-left:10px}` +
    `.a{background:url("${art}") 50% 62%/cover no-repeat}</style></head>` +
    `<body><div class="t">${kicker ? `<div class="k">${escText(kicker)}</div>` : ""}<h1>${escText(title)}</h1><div class="w">Context<i></i><span>Made by Tex</span></div></div><div class="a"></div></body></html>`;
  return { html, width: CARD_WIDTH, height: CARD_HEIGHT };
}
