/**
 * `tex_dev snapshot`: a Tex Lab graph as a picture that looks like the Lab's own canvas.
 *
 * The drawing is the Lab's: `canvas.generated.js` is `render.ts`, the Lab's stylesheet and the group folding
 * bundled to plain JavaScript by `scripts/tex-dev-canvas.mjs` (CI fails when it is stale), so the gateway holds no
 * second copy of how a step or a wire is drawn. This file only hands the page to the picture renderer
 * (`infra/site-shots`, `POST /render`, reached as `env.SITE_SHOTS`), which photographs static HTML: scripts are off
 * there, so the page is the SVG with the Lab's CSS inline.
 */
import { snapshotPage } from "./canvas.generated.js";

const NOT_SET_UP = "Snapshots are not set up on this deployment.";
const NOT_DRAWN = "The snapshot could not be drawn right now. Try again in a minute.";

/**
 * The page's HTML for `graph` (pure, no picture taken): `{ html, width, height }`. Throws one plain sentence when the
 * graph has nothing to draw or `focus` names no step or group.
 * `focus`: a step id or a group id, drawn focused the way the Lab's Focus does; else the whole graph with groups folded.
 * `page`: the Lab page drawn (tex_dev's `graph` argument), "texting" (the default) or "nightly": its steps and the wires among them, the canvas's own
 * filter (`engine/pages.ts`).
 * `base`: another graph (main); steps that differ from it are ringed "changed", steps it lacks "new".
 * `sim`: a traced test (`lab.js` `snapshotSim`, the Lab's own simulation): each step's time, its split bar and the
 * stats chip, as the canvas draws them; none (the default) draws nothing timed.
 */
export function snapshotHtml(graph, { focus = null, base = null, theme = "dark", width = 1600, sim = null, page = null } = {}) {
  return snapshotPage(graph, { focus, base, theme: theme === "light" ? "light" : "dark", width, sim, graph: page });
}

/** The SVG/HTML string of the drawing, for tests and for anyone who wants the page itself. */
export function graphSvg(graph, opts = {}) {
  return snapshotHtml(graph, opts).html;
}

/**
 * One picture of `graph`: `{ ok: true, png: <base64>, width, height }`, or `{ ok: false, error }` with one plain
 * sentence. Never throws.
 */
export async function snapshotGraph(env, graph, { focus = null, base = null, theme = "dark", width = 1600, sim = null, page = null } = {}) {
  const shots = env?.SITE_SHOTS;
  if (typeof shots?.fetch !== "function") return { ok: false, error: NOT_SET_UP };
  let drawn;
  try {
    drawn = snapshotHtml(graph, { focus, base, theme, width, sim, page });
  } catch (error) {
    return { ok: false, error: error instanceof Error && error.message ? error.message : "That graph could not be drawn." };
  }
  try {
    const response = await shots.fetch("https://site-shots/render", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ html: drawn.html, width: drawn.width, height: drawn.height, allow: [] }),
    });
    const body = await response.json().catch(() => null);
    if (!response.ok || typeof body?.png !== "string" || body.png === "") return { ok: false, error: NOT_DRAWN };
    return {
      ok: true,
      png: body.png,
      width: Number.isFinite(body.width) ? body.width : drawn.width,
      height: Number.isFinite(body.height) ? body.height : drawn.height,
    };
  } catch {
    return { ok: false, error: NOT_DRAWN };
  }
}
