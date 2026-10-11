import type { CameraInfo, MapScope, ZoomLevel } from "../types";
import type { FolderPlace, IslandPlace, Layout, SubPlace } from "./layout";
import { SPACING } from "./pack";
import { clamp, ease, lerp, type Point } from "./math";

/**
 * The camera: a world point at the centre of the visible rect, and a scale in
 * pixels per world unit. Semantic zoom reads its level off the scale.
 */
export type Cam = { x: number; y: number; s: number };

/** The parts of the canvas something covers (a bottom sheet, a toolbar). */
export type Inset = { top: number; right: number; bottom: number; left: number };

export type Viewport = { w: number; h: number; inset: Inset };

export const NO_INSET: Inset = { top: 0, right: 0, bottom: 0, left: 0 };

/** The rect the map may use: the canvas minus whatever covers it. */
export function visibleRect(vp: Viewport): { x: number; y: number; w: number; h: number } {
  const w = Math.max(1, vp.w - vp.inset.left - vp.inset.right);
  const h = Math.max(1, vp.h - vp.inset.top - vp.inset.bottom);
  return { x: vp.inset.left, y: vp.inset.top, w, h };
}

export function toScreen(cam: Cam, vp: Viewport, p: Point): Point {
  const r = visibleRect(vp);
  return { x: (p.x - cam.x) * cam.s + r.x + r.w / 2, y: (p.y - cam.y) * cam.s + r.y + r.h / 2 };
}

export function toWorld(cam: Cam, vp: Viewport, p: Point): Point {
  const r = visibleRect(vp);
  return { x: (p.x - r.x - r.w / 2) / cam.s + cam.x, y: (p.y - r.y - r.h / 2) / cam.s + cam.y };
}

/** A circle filling the visible rect, with room round it for its label (the prototype's 2.25). */
export function fitCircle(vp: Viewport, x: number, y: number, r: number, room = 2.25): Cam {
  const v = visibleRect(vp);
  return { x, y, s: Math.min(v.w, v.h) / Math.max(1e-6, r * room) };
}

/** A world box filling the visible rect, leaving `padX`/`padTop`/`padBottom` pixels for labels. */
export function fitBox(
  vp: Viewport,
  box: { minX: number; minY: number; maxX: number; maxY: number },
  padX = 24,
  padTop = 40,
  padBottom = 20,
): Cam {
  const v = visibleRect(vp);
  const bw = Math.max(1e-6, box.maxX - box.minX);
  const bh = Math.max(1e-6, box.maxY - box.minY);
  const s = Math.max(1e-6, Math.min((v.w - padX * 2) / bw, (v.h - padTop - padBottom) / bh));
  // Shift so the box sits between the top and bottom padding.
  const cy = (box.minY + box.maxY) / 2 - (padTop - padBottom) / 2 / s;
  return { x: (box.minX + box.maxX) / 2, y: cy, s };
}

type Disc = { x: number; y: number; r: number };
const boxOf = (discs: readonly Disc[]) => ({
  minX: Math.min(...discs.map((d) => d.x - d.r)),
  minY: Math.min(...discs.map((d) => d.y - d.r)),
  maxX: Math.max(...discs.map((d) => d.x + d.r)),
  maxY: Math.max(...discs.map((d) => d.y + d.r)),
});

/**
 * A workspace framed by its folders (tighter than its island's circle), with
 * room below for the faces that rest on a folder's lower edge.
 */
export function fitIsland(vp: Viewport, island: IslandPlace): Cam {
  if (island.folders.length === 0) return fitCircle(vp, island.x, island.y, island.r);
  return fitBox(vp, boxOf(island.folders), 24, 34, 30);
}

/** Every workspace, with room above each for its name and total. */
export function fitAll(vp: Viewport, layout: Layout): Cam {
  if (layout.islands.length === 0) return { x: 0, y: 0, s: 1 };
  return fitBox(vp, boxOf(layout.islands), 24, 56, 16);
}

/**
 * Between two cameras, in log space: the scale changes at a constant rate,
 * and the centre moves in step with the *visible width*, so a zoom out to
 * one place and in to another feels like one move, not a slide then a zoom.
 * This is the prototype's `camAt`.
 */
export function camLerp(a: Cam, b: Cam, k: number): Cam {
  const s = Math.exp(lerp(Math.log(a.s), Math.log(b.s), k));
  const w = Math.abs(a.s - b.s) < 1e-9 ? k : (1 / a.s - 1 / s) / (1 / a.s - 1 / b.s);
  return { x: lerp(a.x, b.x, w), y: lerp(a.y, b.y, w), s };
}

/** A camera move in progress. */
export type CamFlight = { from: Cam; to: Cam; start: number; duration: number };

export function camAt(f: CamFlight, now: number): { cam: Cam; done: boolean } {
  const k = f.duration <= 0 ? 1 : clamp((now - f.start) / f.duration, 0, 1);
  return { cam: camLerp(f.from, f.to, ease(k)), done: k >= 1 };
}

/** How long a move should take: longer for a bigger change of scale or a longer trip. */
export function flightDuration(a: Cam, b: Cam, vp: Viewport): number {
  const zoom = Math.abs(Math.log(b.s / a.s));
  const v = visibleRect(vp);
  const travel = (Math.hypot(b.x - a.x, b.y - a.y) * Math.min(a.s, b.s)) / Math.max(v.w, v.h);
  return clamp(420 + zoom * 260 + travel * 220, 420, 1400);
}

/** What the camera is looking at: the containers under the centre of the visible rect. */
export type Focus = { island: IslandPlace | null; folder: FolderPlace | null; sub: SubPlace | null };

export function focusAt(layout: Layout, cam: Cam): Focus {
  const p = { x: cam.x, y: cam.y };
  let island: IslandPlace | null = null;
  let best = Infinity;
  for (const i of layout.islands) {
    const d = Math.hypot(i.x - p.x, i.y - p.y) - i.r;
    if (d < best) {
      best = d;
      island = i;
    }
  }
  if (!island) return { island: null, folder: null, sub: null };
  let folder: FolderPlace | null = null;
  best = Infinity;
  for (const f of island.folders) {
    const d = Math.hypot(f.x - p.x, f.y - p.y) - f.r;
    if (d < best) {
      best = d;
      folder = f;
    }
  }
  let sub: SubPlace | null = null;
  if (folder) {
    best = Infinity;
    for (const s of folder.subs) {
      const d = Math.hypot(s.x - p.x, s.y - p.y) - s.r;
      if (d < best) {
        best = d;
        sub = s;
      }
    }
  }
  return { island, folder, sub };
}

export const LEVELS: readonly ZoomLevel[] = ["all", "workspace", "folders", "notes"];

/** The scale each level frames the focus at. `all` is absent when one workspace is shown. */
export type LevelScales = { levels: ZoomLevel[]; scales: number[]; min: number; max: number };

/** Notes are legible from about this many pixels apart, and stop gaining past this. */
const NOTES_MIN_PX = 22;
const NOTES_MAX_PX = 58;

export function levelScales(layout: Layout, vp: Viewport, focus: Focus, scope: MapScope): LevelScales {
  const levels: ZoomLevel[] = [];
  const scales: number[] = [];
  const push = (level: ZoomLevel, s: number) => {
    const prev = scales[scales.length - 1];
    levels.push(level);
    scales.push(prev === undefined ? s : Math.max(s, prev * 1.35));
  };
  if (scope.kind === "all" && layout.islands.length > 0) push("all", fitAll(vp, layout).s);
  const island = focus.island ?? layout.islands[0];
  if (island) push("workspace", fitIsland(vp, island).s);
  else push("workspace", 1);
  const folder = focus.folder ?? largest(island?.folders ?? []);
  push("folders", folder ? fitCircle(vp, folder.x, folder.y, folder.r, 2.4).s : scales[scales.length - 1]! * 2);
  const sub = focus.sub ?? largest(folder?.subs ?? []);
  const subFit = sub ? fitCircle(vp, sub.x, sub.y, sub.r, 2.35).s : NOTES_MIN_PX / SPACING;
  push("notes", clamp(subFit, NOTES_MIN_PX / SPACING, NOTES_MAX_PX / SPACING));
  return { levels, scales, min: scales[0]! * 0.7, max: scales[scales.length - 1]! * 2.2 };
}

function largest<T extends { r: number }>(list: readonly T[]): T | null {
  let best: T | null = null;
  for (const item of list) if (!best || item.r > best.r) best = item;
  return best;
}

/** The level whose framing scale is nearest `s`, measured in log space. */
export function levelFor(s: number, ls: LevelScales): ZoomLevel {
  let best = 0;
  ls.scales.forEach((v, i) => {
    if (Math.abs(Math.log(s / v)) < Math.abs(Math.log(s / ls.scales[best]!))) best = i;
  });
  return ls.levels[best]!;
}

/** 0 at the farthest level's framing, 1 at the nearest's, log-scaled. */
export function zoom01(s: number, ls: LevelScales): number {
  const a = Math.log(ls.scales[0]!);
  const b = Math.log(ls.scales[ls.scales.length - 1]!);
  return b - a < 1e-9 ? 1 : clamp((Math.log(s) - a) / (b - a), 0, 1);
}

/** Breadcrumb, far to near, as deep as the level goes. */
export function trailFor(level: ZoomLevel, focus: Focus, scope: MapScope): string[] {
  const depth = LEVELS.indexOf(level);
  const out: string[] = [];
  if (scope.kind === "all") out.push("All workspaces");
  if (depth >= 1 && focus.island) out.push(focus.island.name);
  if (scope.kind === "one" && out.length === 0 && focus.island) out.push(focus.island.name);
  if (depth >= 2 && focus.folder && focus.folder.label) out.push(focus.folder.label);
  if (depth >= 3 && focus.sub && focus.sub.label) out.push(focus.sub.label);
  return out;
}

/** What `onCamera` is told: `CameraInfo`, plus where each level sits on the 0..1 scale. */
export type CameraDetail = CameraInfo & {
  stops: Partial<Record<ZoomLevel, number>>;
  /** World camera, for an overview drawn outside the canvas. */
  cam: Cam;
};

export function cameraInfo(layout: Layout, vp: Viewport, cam: Cam, scope: MapScope): CameraDetail {
  const focus = focusAt(layout, cam);
  const ls = levelScales(layout, vp, focus, scope);
  const level = levelFor(cam.s, ls);
  const stops: Partial<Record<ZoomLevel, number>> = {};
  ls.levels.forEach((l, i) => (stops[l] = zoom01(ls.scales[i]!, ls)));
  return { level, zoom: zoom01(cam.s, ls), trail: trailFor(level, focus, scope), stops, cam };
}

/** The camera that frames `level` round the current focus. */
export function camForLevel(layout: Layout, vp: Viewport, cam: Cam, scope: MapScope, level: ZoomLevel): Cam {
  const focus = focusAt(layout, cam);
  const ls = levelScales(layout, vp, focus, scope);
  const i = ls.levels.indexOf(level);
  const s = ls.scales[i < 0 ? 0 : i]!;
  if (level === "all") return fitAll(vp, layout);
  const island = focus.island ?? layout.islands[0];
  if (!island) return { x: 0, y: 0, s };
  if (level === "workspace") return fitIsland(vp, island);
  const folder = focus.folder ?? largest(island.folders);
  if (level === "folders" || !folder) return { x: folder?.x ?? island.x, y: folder?.y ?? island.y, s };
  const sub = focus.sub ?? largest(folder.subs);
  return { x: sub?.x ?? folder.x, y: sub?.y ?? folder.y, s };
}

/** Keep the scale inside the zoom range for the current focus. */
export function clampScale(layout: Layout, vp: Viewport, cam: Cam, scope: MapScope): Cam {
  const ls = levelScales(layout, vp, focusAt(layout, cam), scope);
  return { ...cam, s: clamp(cam.s, ls.min, ls.max) };
}
