import { fitAll, fitIsland, toScreen, toWorld, visibleRect, type Cam, type Viewport } from "../camera";
import { notesNear } from "../grid";
import type { NotePlace } from "../layout";
import { HitFrame } from "../hit";
import { Occupancy } from "../labels";
import { minimapAlpha } from "../lod";
import type { Point } from "../math";
import type { Model, SceneAt } from "../scene";
import { drawGround, drawLinks, drawNotes } from "./base";
import { paintBoard } from "./board";
import { drawContainerLabels, placeContainerLabels } from "./containers";
import { countPresent, type DrawEnv } from "./env";
import { drawFlights } from "./flights";
import { drawHubFaces, drawHubLines } from "./hub";
import { zOf } from "./depth";
import { breathOffset, EYE_PX, PITCH_MAX, YAW_MAX } from "../motion";
import { drawAgentTrails, drawTrace, drawReadingMarks, traceOf } from "./marks";
import { drawScribbles, drawWorkspaceLoops, scribbleAlpha, type Opening } from "./sketch";
import { drawActors, placeFacesAndLabels } from "./overlay";
import { circle, fillText, fontOf, roundRect, type Ctx, type Style } from "./primitives";

/** Below this width the map behaves like a phone: anything that does not fit is dropped. */
export const NARROW = 560;

export type RenderOptions = {
  style: Style;
  selected: string | null;
  minimap: boolean;
  /** The map's opening while it plays. */
  opening?: Opening | null;
  /** The pointer, for "lines near the cursor" and "on hover". */
  pointer?: Point | null;
  hoverKey?: string | null;
  /** The 3D tilt, -1..1 each way, or null when the drawing is flat. */
  tilt?: { x: number; y: number } | null;
  /** The dots breathe, very slightly. */
  breathe?: boolean;
  /** The wall clock in ms, for the breathing. */
  wall?: number;
};

/** A point on screen, and for the 3D view how much nearer (over 1) or further (under 1) it is. */
export type ScreenPoint = Point & { per?: number };

/** A note's own seed for breathing, from its key. */
const seeds = new Map<string, number>();
function seedOf(key: string): number {
  let v = seeds.get(key);
  if (v === undefined) {
    let h = 2166136261;
    for (let i = 0; i < key.length; i += 1) h = Math.imul(h ^ key.charCodeAt(i), 16777619);
    v = ((h >>> 0) % 10007) / 37;
    if (seeds.size > 50_000) seeds.clear();
    seeds.set(key, v);
  }
  return v;
}

/** Draw one frame of the map view and return what can be clicked. */
export function renderMap(ctx: Ctx, model: Model, scene: SceneAt, cam: Cam, vp: Viewport, opts: RenderOptions): HitFrame {
  const C = opts.style.palette;
  ctx.save();
  paintBoard(ctx, C, cam, vp);
  const v = visibleRect(vp);
  const flat = (p: Point) => toScreen(cam, vp, p);
  const tilt = opts.tilt ?? null;
  const centre = flat(cam);
  const wall = opts.wall ?? 0;
  // Breathing: every note drifts a pixel or so round its place, out of step
  // with its neighbours, except the one under the pointer.
  const drift = opts.breathe
    ? (p: Point, q: ScreenPoint): ScreenPoint => {
        const k = (p as { key?: unknown; sub?: unknown }).key;
        if (typeof k !== "string" || !(p as { sub?: unknown }).sub || k === opts.hoverKey) return q;
        const o = breathOffset(wall, seedOf(k));
        return { x: q.x + o.x, y: q.y + o.y, per: q.per };
      }
    : null;
  // 3D depth, as the prototype draws it: every point has a depth (`zOf`),
  // the view turns about the screen's centre by the tilt, and what is nearer
  // is drawn bigger and further apart.
  let screen: (p: Point) => ScreenPoint = flat;
  if (tilt) {
    const yaw = tilt.x * YAW_MAX;
    const pitch = tilt.y * PITCH_MAX;
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const cp = Math.cos(pitch);
    const sp = Math.sin(pitch);
    const s = cam.s;
    screen = (p: Point) => {
      const q = flat(p);
      const z = zOf(p) * s;
      const dx = q.x - centre.x;
      const dy = q.y - centre.y;
      const x1 = dx * cy - z * sy;
      const z1 = dx * sy + z * cy;
      const y1 = dy * cp - z1 * sp;
      const z2 = dy * sp + z1 * cp;
      const per = Math.min(2.2, Math.max(0.45, EYE_PX / (EYE_PX + z2)));
      return { x: centre.x + x1 * per, y: centre.y + y1 * per, per };
    };
  }
  if (drift) {
    const placed = screen;
    screen = (p: Point) => drift(p, placed(p));
  }
  const hot = new Set<string>([...scene.editing.keys(), ...scene.reading.keys()]);
  // A clicked note and the notes it links to keep their names.
  // A clicked note traces its links; with none clicked, the note under the pointer does (as in the prototype).
  const traceFrom = opts.selected ?? opts.hoverKey ?? null;
  const trace = traceOf(model, scene, traceFrom);
  if (trace) for (const k of trace) hot.add(k);
  for (const a of scene.actors) if (a.note && a.doing) hot.add(a.note.key);
  // The widest margin any pass tests with is 30 + 40 pixels; a little more.
  // Turned in 3D, a note can be drawn well away from its flat place.
  const margin = tilt ? 120 + vp.w * 0.25 : 120;
  const lo = toWorld(cam, vp, { x: -margin, y: -margin });
  const hi = toWorld(cam, vp, { x: vp.w + margin, y: vp.h + margin });
  const near: NotePlace[] = [];
  // A folder drawn as an icon (Archive) keeps its notes out of sight.
  for (const n of notesNear(model.layout, lo.x, lo.y, hi.x, hi.y)) if (scene.present.has(n.key) && !n.sub.folder.collapsed) near.push(n);
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
    traceFrom: trace ? traceFrom : null,
    trace,
    far: scribbleAlpha(cam.s, opts.style.look.spread),
    opening: opts.opening ?? null,
    pointer: opts.pointer,
    breathe: opts.breathe ?? false,
    cull: margin,
    hoverKey: opts.hoverKey ?? null,
    counts: countPresent(model, scene),
    hot,
    near,
    pills: [],
    quiet: [],
    flyingAt: new Map(scene.flights.filter((f) => !f.cross && f.landedFor < 0).map((f) => [f.to.key, f.pos])),
  };
  drawGround(env);
  drawScribbles(env);
  drawWorkspaceLoops(env);
  const hub = drawHubLines(env);
  drawLinks(env);
  drawTrace(env);
  drawNotes(env);
  drawReadingMarks(env);
  drawAgentTrails(env);
  // Names of containers claim their space first and are drawn over the dots.
  const labels = placeContainerLabels(env);
  env.quiet.push(...labels.map((l) => l.rect), ...env.pills.map((p) => ({ x: p.x - p.w / 2, y: p.y - 12, w: p.w, h: 24 })));
  const mini = opts.minimap ? minimapRect(env) : null;
  if (mini) env.occ.claim(mini);
  const { groups, flags, captions } = placeFacesAndLabels(env);
  drawContainerLabels(env, labels, env.pills);
  drawFlights(env, captions);
  drawHubFaces(env, hub);
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
