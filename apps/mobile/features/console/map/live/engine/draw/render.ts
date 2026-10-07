import { fitAll, fitIsland, toScreen, visibleRect, type Cam, type Viewport } from "../camera";
import { HitFrame } from "../hit";
import { Occupancy } from "../labels";
import { minimapAlpha } from "../lod";
import type { Point } from "../math";
import type { Model, SceneAt } from "../scene";
import { drawContainerLabels, drawGround, drawLinks, drawNotes } from "./base";
import { countPresent, type DrawEnv } from "./env";
import { drawActors, drawFlights, drawReading, placeFacesAndLabels } from "./overlay";
import { circle, fillText, fontOf, roundRect, type Ctx, type Style } from "./primitives";

/** Below this width the map behaves like a phone: anything that does not fit is dropped. */
export const NARROW = 560;

export type RenderOptions = {
  style: Style;
  selected: string | null;
  minimap: boolean;
};

/** Draw one frame of the map view and return what can be clicked. */
export function renderMap(ctx: Ctx, model: Model, scene: SceneAt, cam: Cam, vp: Viewport, opts: RenderOptions): HitFrame {
  const C = opts.style.palette;
  ctx.save();
  ctx.fillStyle = C.ground;
  ctx.fillRect(0, 0, vp.w, vp.h);
  const v = visibleRect(vp);
  const screen = (p: Point) => toScreen(cam, vp, p);
  const hot = new Set<string>([...scene.editing.keys(), ...scene.reading.keys()]);
  if (opts.selected) hot.add(opts.selected);
  for (const a of scene.actors) if (a.note && a.doing) hot.add(a.note.key);
  const env: DrawEnv = {
    ctx,
    style: opts.style,
    model,
    scene,
    cam,
    vp,
    s: cam.s,
    screen,
    onScreen: (p, m) => p.x > -m - 40 && p.x < vp.w + m + 40 && p.y > -m - 40 && p.y < vp.h + m + 40,
    hit: new HitFrame(),
    occ: new Occupancy(),
    bounds: { minX: v.x + 4, minY: v.y + 4, maxX: v.x + v.w - 6, maxY: v.y + v.h - 4 },
    narrow: v.w < NARROW,
    dim: model.following !== null,
    selected: opts.selected,
    counts: countPresent(model, scene),
    hot,
  };
  drawGround(env);
  drawLinks(env);
  drawNotes(env);
  drawContainerLabels(env);
  const mini = opts.minimap ? minimapRect(env) : null;
  if (mini) env.occ.claim(mini);
  const { groups, flags } = placeFacesAndLabels(env);
  drawReading(env, groups);
  drawFlights(env);
  drawActors(env, groups, flags);
  if (mini) drawMinimap(env, mini);
  ctx.restore();
  return env.hit;
}

/** Where the overview goes, or null while it is hidden (framed whole, or a phone). */
function minimapRect(env: DrawEnv): { x: number; y: number; w: number; h: number; a: number } | null {
  const { model, vp, cam } = env;
  const layout = model.layout;
  const v = visibleRect(vp);
  if (v.w < NARROW || layout.islands.length === 0) return null;
  const whole = model.scope.kind === "all" ? fitAll(vp, layout) : fitIsland(vp, layout.islands[0]!);
  const a = minimapAlpha(cam.s, whole.s);
  if (a <= 0) return null;
  return { x: v.x + v.w - 170 - 16, y: v.y + 16, w: 170, h: 154, a };
}

/** A small overview in the top right once zoomed in, with the visible rect outlined. */
function drawMinimap(env: DrawEnv, r: { x: number; y: number; w: number; h: number; a: number }): void {
  const { ctx, style, model, vp, cam } = env;
  const C = style.palette;
  const layout = model.layout;
  const v = visibleRect(vp);
  const a = r.a;
  const mw = r.w;
  const mh = r.h;
  const mx = r.x;
  const my = r.y;
  ctx.globalAlpha = a;
  ctx.save();
  ctx.shadowColor = "rgba(0,0,0,0.12)";
  ctx.shadowBlur = 12;
  roundRect(ctx, mx, my, mw, mh, 12);
  ctx.fillStyle = C.ground;
  ctx.fill();
  ctx.restore();
  roundRect(ctx, mx, my, mw, mh, 12);
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 1;
  ctx.stroke();
  const ms = (Math.min(mw, mh) * 0.9) / (layout.radius * 2);
  const X = (x: number) => (x - layout.center.x) * ms + mx + mw / 2;
  const Y = (y: number) => (y - layout.center.y) * ms + my + mh / 2;
  ctx.save();
  roundRect(ctx, mx, my, mw, mh, 12);
  ctx.clip();
  const all = model.scope.kind === "all";
  for (const island of layout.islands) {
    if (all) {
      circle(ctx, X(island.x), Y(island.y), island.r * ms);
      ctx.fillStyle = C.zone;
      ctx.fill();
      ctx.font = fontOf(style, 9.5, 600);
      ctx.fillStyle = C.dim;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      fillText(ctx, island.name, X(island.x), Y(island.y));
      ctx.textBaseline = "alphabetic";
    } else {
      for (const f of island.folders) {
        circle(ctx, X(f.x), Y(f.y), f.r * ms);
        ctx.fillStyle = C.zone;
        ctx.fill();
      }
    }
  }
  const vw = v.w / cam.s;
  const vh = v.h / cam.s;
  ctx.strokeStyle = C.ink;
  ctx.lineWidth = 1.5;
  ctx.strokeRect(X(cam.x - vw / 2), Y(cam.y - vh / 2), Math.max(3, vw * ms), Math.max(3, vh * ms));
  ctx.restore();
  ctx.lineWidth = 1;
  ctx.globalAlpha = 1;
}
