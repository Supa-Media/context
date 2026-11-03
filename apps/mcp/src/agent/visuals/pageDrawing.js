/**
 * A PAGE'S DRAWING: Tex draws a picture of every page it makes that has none
 * (owner, 2026-11-03: "whenever Tex makes pages, can you have it generate an
 * image representing the page if there is no image already in the page, it
 * should be in tex style"; "Tex draws it in ink"; "use the more calm version
 * of tex ... most people won't be generating images involving Tex").
 *
 * It rides on the cover call Tex already makes for every page
 * (`draw_visual { template: "page", data: { path, scene } }`):
 *
 *  - A page with a picture of its own (a cover photo, an option's photo, an
 *    embedded image, a map) is drawn as before: it needs no drawing.
 *  - A page with none, and no `scene`, is sent back with how to draw one, so
 *    the page is never texted bare; after `MAX_DRAWING_TRIES` the cover is
 *    drawn without it, so a turn always ends.
 *  - A `scene` (SVG shapes of the page's own topic, 1200 x 900) is read and
 *    drawn again in Tex's ink by `packages/shared/src/ink/drawing.cjs`, light
 *    and dark, photographed by the screenshot Worker, and saved into the page
 *    through `write_note` as two pictures named by `drawing:` and
 *    `drawing-dark:` in its front matter, so they borrow the note's
 *    visibility, travel with its export and show as its cover in the app.
 *
 * Decision: `docs/decisions/app-and-console/page-drawings.md`.
 */

import { DRAWING_HEIGHT, DRAWING_WIDTH, drawingHtml, readScene } from "../../../../../packages/shared/src/ink/drawing.cjs";
import { drawingOf, hasPicture, numberCover } from "../../../../../packages/shared/src/pages/cover.cjs";
import { parsePage } from "../../../../../packages/shared/src/pages/parse.cjs";

/** The names the two pictures are attached under; `write_note` stores each as an upload and rewrites the field to it. */
export const DRAWING_NAME = "tex-drawing.png";
export const DRAWING_DARK_NAME = "tex-drawing-dark.png";

/** What the model is told when a page has no picture: the floor, and the whole of how to draw one. */
export const SCENE_ASK =
  "This page has no picture, so draw it one first: call draw_visual again with template page and data { path, scene }. " +
  "scene is a simple line drawing of what the page is about (its subject, not you: a venue and a stage for a concert, a desk and a laptop for onboarding, a clipboard and a hard hat for a claim), " +
  'as SVG shapes on a 1200 x 900 canvas: path, line, polyline, polygon, rect, circle, ellipse, g (transform: translate, rotate, scale) and text (a word or a number, never a sentence). ' +
  'One ink: give no colours; fill is "none", "ink", "paper" (to cover what is behind) or "hatch" (shading). Five to fifteen bold, simple objects filling the canvas, like a quick confident sketch, nothing tiny. ' +
  'You stand in the scene yourself, small: put <tex x="..." y="..." size="200"/> where your feet go (flip="true" faces left), or leave it out and you stand at the bottom right. ' +
  "It is drawn in your ink, light and dark, and saved into the page as its picture.";

/**
 * Put the page's front matter `drawing:` and `drawing-dark:` lines in, in
 * place of any already there; a page without front matter gets some.
 */
export function withDrawingFields(text, light, dark) {
  const lines = [`drawing: ${light}`, `drawing-dark: ${dark}`];
  const open = /^---[ \t]*\r?\n/.exec(text);
  if (open) {
    const rest = text.slice(open[0].length);
    const close = /^---[ \t]*(?:\r?\n|$)/m.exec(rest);
    if (close) {
      const fields = rest.slice(0, close.index).split("\n").filter((line) => !/^drawing(?:-dark)?[ \t]*:/i.test(line) && line !== "");
      return `---\n${[...fields, ...lines].join("\n")}\n${rest.slice(close.index)}`;
    }
  }
  return `---\n${lines.join("\n")}\n---\n\n${text}`;
}

/** The note's body and etag as `read_note` answers, or null (`delegate.js` reads the same way). */
async function readWithEtag(callTool, path) {
  const result = await Promise.resolve(callTool("read_note", { path })).catch(() => null);
  const raw = result?.content?.[0]?.text;
  if (result?.isError === true || typeof raw !== "string") return null;
  const split = raw.indexOf("\n\n");
  return { etag: /^etag: (.+)$/m.exec(split === -1 ? raw : raw.slice(0, split))?.[1] ?? null, body: split === -1 ? "" : raw.slice(split + 2) };
}

/** One drawing photographed by the screenshot Worker: a PNG as base64, or null. */
async function photograph(shots, scene, dark, seed) {
  const response = await shots.fetch("https://site-shots/render", {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Nothing in a drawing loads anything but the page's face: no address is allowed.
    body: JSON.stringify({ html: drawingHtml(scene, { dark, seed }), width: DRAWING_WIDTH, height: DRAWING_HEIGHT, allow: [] }),
  });
  const body = await response.json().catch(() => null);
  return response.ok && typeof body?.png === "string" ? body.png : null;
}

/** How many times one turn is sent back to draw one page's picture before its cover is drawn without one. */
export const MAX_DRAWING_TRIES = 2;

/**
 * The page's drawing, drawn and saved when it needs one. `text` is the page as
 * this turn read it; `tries` is the turn's count, per page, of times it was
 * sent back. Answers `{ text }`, the page to draw the cover from (re-read when
 * a drawing was saved, with `saved`), or `{ error }` for the model to act on.
 * After `MAX_DRAWING_TRIES` a page is drawn as it is, with `note` saying why,
 * so a turn that cannot draw or save one (a read-only turn, a scene it keeps
 * getting wrong) still ends.
 */
export async function ensurePageDrawing({ path, text, scene, shots, callTool, tries }) {
  const page = parsePage(text);
  // A status page with a number has that as its cover; a page with a picture needs none.
  if (hasPicture(page) || numberCover(page.fields)) return { text };
  const given = typeof scene === "string" && scene.trim() !== "";
  if (!given && drawingOf(page) !== null) return { text };
  const tried = tries.get(path) ?? 0;
  if (tried >= MAX_DRAWING_TRIES) return { text, note: "The page has no picture: its drawing could not be made this turn." };
  const back = (error) => {
    tries.set(path, tried + 1);
    return { error };
  };
  if (!given) return back(SCENE_ASK);
  const read = readScene(scene);
  if (read.error) return back(`The scene could not be drawn: ${read.error} Fix it and call draw_visual again.`);
  const [light, dark] = await Promise.all([photograph(shots, read, false, path), photograph(shots, read, true, path)]);
  if (light === null || dark === null) return back("The drawing could not be made right now. Call draw_visual again.");
  const current = await readWithEtag(callTool, path);
  if (current === null) return { error: `There is no page at ${path.slice(0, 200)} to draw. Write it first, then draw it.` };
  const written = await Promise.resolve(
    callTool("write_note", {
      path,
      content: withDrawingFields(current.body, DRAWING_NAME, DRAWING_DARK_NAME),
      images: [
        { name: DRAWING_NAME, data: `data:image/png;base64,${light}`, alt: "Tex's drawing of this page" },
        { name: DRAWING_DARK_NAME, data: `data:image/png;base64,${dark}`, alt: "Tex's drawing of this page" },
      ],
      ...(current.etag ? { expected_etag: current.etag } : {}),
    }),
  ).catch(() => null);
  if (written === null || written.isError === true) {
    const why = written?.content?.find?.((part) => part?.type === "text")?.text ?? "";
    return back(`The drawing could not be saved into the page${why ? `: ${String(why).slice(0, 300)}` : ""}. Call draw_visual again.`);
  }
  const after = await readWithEtag(callTool, path);
  return { text: after?.body ?? text, saved: true };
}
