import type { Rect } from "../labels";
import { folderLabelAlpha, islandLabelAlpha, subLabelAlpha } from "../lod";
import { clamp } from "../math";
import type { DrawEnv } from "./env";
import { drawFace, FACE_R, fillText, fontOf, haloText, roundRect } from "./primitives";

/**
 * The names of containers — a workspace's title and total, "PROJECTS"
 * under a folder (a name, never a count), a subfolder's name — and the "N moved today" pills on the
 * paths between workspaces.
 *
 * Placed early, drawn late. They claim their space in the occupancy pass
 * before faces' flags and note names, so nothing is put on top of them; and
 * they are drawn after the reading dots, so a stream of dots running past a
 * name passes *under* it (and fades as it goes, see `quietAt`). A folder
 * label goes under its group; if that would collide it tries above, then
 * beside it, and is dropped if those are taken too.
 */

type Line = { text: string; size: number; weight: number; color: string; dy: number; dx?: number };

/** A member's face beside a workspace's "N people", by name. */
type MemberFace = { name: string; x: number; y: number };

export type ContainerLabel = { x: number; baseline: number; alpha: number; halo: string; lines: Line[]; rect: Rect; faces?: MemberFace[] };

/** At most this many member faces beside a workspace's "N people"; their size and overlap. */
const MEMBER_FACES = 4;
const MEMBER_SCALE = 0.55;
const MEMBER_R = FACE_R * MEMBER_SCALE;
const FACE_STEP = MEMBER_R * 1.5;

export type Pill = { x: number; y: number; w: number; text: string; bump: number; alpha: number };

const PAD = 4;

const pad = (r: Rect, p: number): Rect => ({ x: r.x - p, y: r.y - p, w: r.w + p * 2, h: r.h + p * 2 });

/** Work out where every container name goes and claim it. Call before faces and note names. */
export function placeContainerLabels(env: DrawEnv): ContainerLabel[] {
  const { ctx, style, model, s } = env;
  const C = style.palette;
  const all = model.scope.kind === "all";
  const out: ContainerLabel[] = [];
  const measure = (text: string, size: number, weight: number) => {
    ctx.font = fontOf(style, size, weight);
    return ctx.measureText(text).width;
  };

  // Workspace titles first: they are never dropped.
  if (all) {
    for (const island of model.layout.islands) {
      const p = env.screen(island);
      const pr = island.r * s;
      const a = islandLabelAlpha(pr);
      if (a <= 0 || !env.onScreen(p, pr)) continue;
      // With the hub drawn, who is in it; otherwise how much is in it.
      const people = model.hub?.workspaces[island.workspaceId];
      const total = env.counts.get(island.workspaceId) ?? 0;
      const count = people
        ? people.people <= 1
          ? "Just you"
          : `${people.people.toLocaleString("en-US")} people`
        : `${total.toLocaleString("en-US")} ${total === 1 ? "note" : "notes"}`;
      const faces = people ? people.faces.slice(0, MEMBER_FACES) : [];
      // Over its highest note: there is no rim to sit on.
      const baseline = env.screen({ x: island.x, y: island.top }).y - 34;
      const facesW = faces.length > 0 ? 6 + FACE_STEP * (faces.length - 1) + MEMBER_R * 2 : 0;
      const w = Math.max(measure(island.name, 15, 700), measure(count, 12, 500) + facesW) + 8;
      const rect = { x: p.x - w / 2, y: baseline - 15, w, h: 36 };
      env.occ.claim(pad(rect, PAD + 2));
      out.push({
        x: p.x,
        baseline,
        alpha: a,
        halo: C.ground,
        rect,
        lines: [
          { text: island.name, size: 15, weight: 700, color: C.text, dy: 0 },
          { text: count, size: 12, weight: 500, color: C.dim, dy: 16, ...(faces.length > 0 ? { dx: -facesW / 2 } : {}) },
        ],
        faces: faces.map((name, k) => ({
          name,
          x: p.x + (measure(count, 12, 500) - facesW) / 2 + 6 + MEMBER_R + k * FACE_STEP,
          y: baseline + 12,
        })),
      });
    }
  }

  // Then folders, biggest first, then named subfolders.
  type Cand = { x: number; y: number; rr: number; top: number; bottom: number; size: number; weight: number; text: string; color: string; halo: string; alpha: number; r: number };
  const cands: Cand[] = [];
  for (const island of model.layout.islands) {
    const halo = C.ground;
    for (const f of island.folders) {
      const q = env.screen(f);
      const fr = f.r * s;
      if (!env.onScreen(q, fr)) continue;
      const a = f.label ? folderLabelAlpha(fr) : 0;
      if (a > 0) {
        const size = clamp(fr / 9, 10, 13);
        cands.push({
          x: q.x,
          y: q.y,
          rr: fr,
          top: env.screen({ x: f.x, y: f.top }).y - 9,
          bottom: env.screen({ x: f.x, y: f.bottom }).y + size + 8,
          size,
          weight: 700,
          text: f.label.toUpperCase(),
          color: C.muted,
          halo,
          alpha: a,
          r: fr + 1e6,
        });
      }
      for (const sub of f.subs) {
        if (sub.name === "") continue;
        const sq = env.screen(sub);
        const sr = sub.r * s;
        const sa = subLabelAlpha(sr);
        if (sa <= 0 || !env.onScreen(sq, sr)) continue;
        cands.push({
          x: sq.x,
          y: sq.y,
          rr: sr,
          top: sq.y - sr - 6,
          bottom: sq.y + sr + 17,
          size: 12.5,
          weight: 700,
          text: sub.label,
          color: C.text2,
          halo: C.ground,
          alpha: sa,
          r: sr,
        });
      }
    }
  }
  cands.sort((a, b) => b.r - a.r);
  for (const c of cands) {
    const w = measure(c.text, c.size, c.weight) + 6;
    // Under its group, else over it, else beside it on either side.
    const mid = c.y + c.size * 0.35;
    const spots: Array<[number, number]> = [
      [c.x, c.bottom],
      [c.x, c.top],
      [c.x - c.rr - 8 - w / 2, mid],
      [c.x + c.rr + 8 + w / 2, mid],
    ];
    for (const [x, baseline] of spots) {
      const rect = { x: x - w / 2, y: baseline - c.size, w, h: c.size * 1.3 };
      const claim = pad(rect, PAD);
      if (env.occ.hits(claim)) continue;
      env.occ.claim(claim);
      out.push({
        x,
        baseline,
        alpha: c.alpha,
        halo: c.halo,
        rect,
        lines: [{ text: c.text, size: c.size, weight: c.weight, color: c.color, dy: 0 }],
      });
      break;
    }
  }
  return out;
}

/** Draw the pills and names placed earlier, on top of the dots and lines. */
export function drawContainerLabels(env: DrawEnv, labels: readonly ContainerLabel[], pills: readonly Pill[]): void {
  const { ctx, style } = env;
  const C = style.palette;
  for (const p of pills) {
    ctx.globalAlpha = p.alpha;
    roundRect(ctx, p.x - p.w / 2, p.y - 12, p.w, 24, 12);
    ctx.fillStyle = p.bump > 0 ? C.ink : C.ground;
    ctx.fill();
    ctx.strokeStyle = C.line;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.font = fontOf(style, 12, 600);
    ctx.fillStyle = p.bump > 0 ? C.ground : C.text2;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    fillText(ctx, p.text, p.x, p.y + 0.5);
    ctx.textBaseline = "alphabetic";
  }
  for (const l of labels) {
    ctx.globalAlpha = l.alpha;
    for (const line of l.lines) haloText(ctx, style, line.text, l.x + (line.dx ?? 0), l.baseline + line.dy, line.size, line.weight, line.color, l.halo);
    for (const f of l.faces ?? []) drawFace(ctx, { kind: "person", id: f.name, name: f.name }, f.x, f.y, MEMBER_SCALE, style);
  }
  ctx.globalAlpha = 1;
}

/**
 * How much a moving dot at (x, y) should show: fading to nothing as it
 * passes under a name or a pill, so a stream never reads as part of a word.
 */
export function quietAt(rects: readonly Rect[], x: number, y: number): number {
  let k = 1;
  for (const r of rects) {
    const dx = Math.max(r.x - x, 0, x - (r.x + r.w));
    const dy = Math.max(r.y - y, 0, y - (r.y + r.h));
    const d = Math.hypot(dx, dy);
    if (d < 10) k = Math.min(k, d / 10);
  }
  return k;
}
