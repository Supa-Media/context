import type { FolderPlace, Layout, NotePlace } from "../layout";
import { notePx } from "../lod";
import { clamp } from "../math";
import type { MapLook } from "../../look";
import { bowOf, grain } from "./board";
import type { DrawEnv } from "./env";

/**
 * The map as a pencil drawing far out, and the drawing of it when it opens
 * (Dev2, 2026-11-04: "our theme is based off of pencil sketches and chaos").
 *
 * - **Far out, every folder is a pencil scribble** and, across workspaces,
 *   every workspace gets a loose pencil loop. No glow and no blur (Dev2
 *   disliked the "blurry pieces of light"). Zooming in, the scribble fades
 *   and the notes come through.
 * - **The opening**: the first time the map has notes, it is drawn in. The
 *   map's settings pick how: links sketched outward from each workspace's
 *   middle (the default), dots blooming out, folder by folder, or zooming in
 *   from everything. Reduced motion skips it.
 */

/** How strongly the scribbles show: none once notes are 14 pixels apart, full under 6. */
export function scribbleAlpha(s: number, spread: number): number {
  return clamp((14 - notePx(s) * spread) / 8, 0, 1);
}

/** A small seeded random source, so a folder's scribble is the same every time. */
function rng(seed: string): () => number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  };
}

/** A folder's scribble as points relative to its centre, in units of its radius. Made once per folder. */
const scribbles = new WeakMap<FolderPlace, Float32Array>();
export function scribbleOf(f: FolderPlace): Float32Array {
  const known = scribbles.get(f);
  if (known) return known;
  const rand = rng(f.key);
  const notes = f.subs.reduce((n, s) => n + s.notes.length, 0);
  const n = Math.min(400, notes * 6 + 40);
  const R0 = 0.85;
  const step = 0.11;
  const pts = new Float32Array(n * 2);
  let x = (rand() - 0.5) * R0;
  let y = (rand() - 0.5) * R0;
  let a = rand() * Math.PI * 2;
  for (let k = 0; k < n; k += 1) {
    a += (rand() + rand() + rand() - 1.5) * 1.4;
    let nx = x + Math.cos(a) * step;
    let ny = y + Math.sin(a) * step;
    if (Math.hypot(nx, ny) > R0) {
      a += Math.PI * (0.6 + rand() * 0.5);
      nx = x + Math.cos(a) * step;
      ny = y + Math.sin(a) * step;
      if (Math.hypot(nx, ny) > R0) {
        nx = x * 0.85;
        ny = y * 0.85;
      }
    }
    x = nx;
    y = ny;
    pts[k * 2] = x;
    pts[k * 2 + 1] = y;
  }
  scribbles.set(f, pts);
  return pts;
}

/** Each folder far out as a pencil scribble. */
export function drawScribbles(env: DrawEnv): void {
  const { ctx, style, model, s } = env;
  if (env.far <= 0) return;
  const C = style.palette;
  ctx.strokeStyle = grain(ctx, C, C.edge);
  ctx.lineWidth = 1;
  ctx.lineJoin = "round";
  ctx.globalAlpha = 0.55 * env.far * (env.trace ? 0.35 : 1) * (env.dim ? 0.6 : 1);
  ctx.beginPath();
  for (const island of model.layout.islands) {
    for (const f of island.folders) {
      if (f.collapsed) continue;
      const p = env.screen(f);
      const pr = f.r * s;
      if (pr < 3 || !env.onScreen(p, pr)) continue;
      const pts = scribbleOf(f);
      let px = p.x + pts[0]! * pr;
      let py = p.y + pts[1]! * pr;
      ctx.moveTo(px, py);
      for (let j = 2; j < pts.length; j += 2) {
        const x = p.x + pts[j]! * pr;
        const y = p.y + pts[j + 1]! * pr;
        ctx.quadraticCurveTo(px, py, (px + x) / 2, (py + y) / 2);
        px = x;
        py = y;
      }
    }
  }
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.lineJoin = "miter";
}

/** Across workspaces, a loose pencil loop round each workspace while it is small on screen. */
export function drawWorkspaceLoops(env: DrawEnv): void {
  const { ctx, style, model, s } = env;
  if (model.scope.kind !== "all") return;
  const C = style.palette;
  ctx.lineWidth = 1.2;
  ctx.lineCap = "round";
  model.layout.islands.forEach((island, wi) => {
    const pr = island.r * s;
    const al = clamp((520 - pr) / 260, 0, 1);
    const p = env.screen(island);
    if (al <= 0 || !env.onScreen(p, pr + 30)) return;
    const r = pr * 1.06 + 16;
    for (let pass = 0; pass < 2; pass += 1) {
      ctx.strokeStyle = C.ink;
      ctx.globalAlpha = (pass ? 0.22 : 0.42) * al * (env.dim ? 0.6 : 1);
      ctx.beginPath();
      const a0 = wi * 1.3 + pass * 0.7;
      const span = Math.PI * 2 + 0.35;
      for (let k = 0; k <= 90; k += 1) {
        const th = a0 + (span * k) / 90;
        const rr = 1 + 0.03 * Math.sin(3 * th + wi) + 0.018 * Math.sin(7 * th + pass * 2) + (0.012 * k) / 90;
        const x = p.x + Math.cos(th) * r * rr;
        const y = p.y + Math.sin(th) * r * rr * 0.96;
        if (k === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  });
  ctx.globalAlpha = 1;
  ctx.lineCap = "butt";
  ctx.lineWidth = 1;
}

// ---- The opening ----

export type OpeningKind = MapLook["opening"];

/** How long each opening takes, in seconds, before the last note settles. */
export const OPENING_S: Record<OpeningKind, number> = { sketch: 2.9, bloom: 1.9, order: 3.4, zoom: 3.1 };

/** How far into the opening a frame is: which one, and seconds since it began. */
export type Opening = { kind: OpeningKind; t: number; delay: Map<string, number> };

/** When each note starts to appear, in seconds from the start, for each kind of opening. */
const delays = new WeakMap<Layout, Map<OpeningKind, Map<string, number>>>();
export function openingDelays(layout: Layout, kind: OpeningKind): Map<string, number> {
  let byKind = delays.get(layout);
  if (!byKind) delays.set(layout, (byKind = new Map()));
  const known = byKind.get(kind);
  if (known) return known;
  const out = new Map<string, number>();
  for (const island of layout.islands) {
    island.folders.forEach((f, fi) => {
      for (const sub of f.subs) {
        for (const n of sub.notes) {
          const jitter = (bowOf(n.x, n.y, n.y, n.x) + 1) / 2;
          const dist = Math.hypot(n.x - island.x, n.y - island.y) / Math.max(1, island.r);
          out.set(
            n.key,
            kind === "sketch"
              ? dist * 1.3 + jitter * 0.35
              : kind === "order"
                ? (fi / Math.max(1, island.folders.length)) * 2.6 + jitter * 0.3
                : (kind === "zoom" ? 0.9 : 0) + dist * 0.85 + jitter * 0.25,
          );
        }
      }
    });
  }
  byKind.set(kind, out);
  return out;
}

const easeOutBack = (k: number): number => {
  const c = 1.7;
  return 1 + (c + 1) * Math.pow(k - 1, 3) + c * Math.pow(k - 1, 2);
};

/** How big a note's dot is during the opening, as a share of its size: 0 not yet, 1 settled. */
export function openingScale(o: Opening | null, n: NotePlace): number {
  if (o === null) return 1;
  const d = o.delay.get(n.key) ?? 0;
  const span = o.kind === "sketch" ? 0.3 : o.kind === "order" ? 0.45 : 0.9;
  const k = clamp((o.t - d) / span, 0, 1);
  return o.kind === "sketch" ? k : k < 1 ? Math.max(0, easeOutBack(k)) : 1;
}

/** How much of a link is drawn during the opening, from the end that appeared first. */
export function openingLink(o: Opening | null, a: NotePlace, b: NotePlace): { k: number; flip: boolean } {
  if (o === null) return { k: 1, flip: false };
  const da = o.delay.get(a.key) ?? 0;
  const db = o.delay.get(b.key) ?? 0;
  const start = Math.max(da, db) + 0.15;
  const k = clamp((o.t - start) / (o.kind === "sketch" ? 0.7 : 0.5), 0, 1);
  return { k, flip: db < da };
}
