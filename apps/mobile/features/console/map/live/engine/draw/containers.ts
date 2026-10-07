import type { Rect } from "../labels";
import { folderLabelAlpha, islandLabelAlpha, subLabelAlpha } from "../lod";
import { clamp } from "../math";
import type { DrawEnv } from "./env";
import { fillText, fontOf, haloText, roundRect } from "./primitives";

/**
 * The names of containers — a workspace's title and total, "PROJECTS 312"
 * over a folder, a subfolder's name — and the "N moved today" pills on the
 * paths between workspaces.
 *
 * Placed early, drawn late. They claim their space in the occupancy pass
 * before faces' flags and note names, so nothing is put on top of them; and
 * they are drawn after the reading dots, so a stream of dots running past a
 * name passes *under* it (and fades as it goes, see `quietAt`). A folder
 * label that would collide with a bigger folder's tries below its bubble,
 * and is dropped if that is taken too.
 */

type Line = { text: string; size: number; weight: number; color: string; dy: number };

export type ContainerLabel = { x: number; baseline: number; alpha: number; halo: string; lines: Line[]; rect: Rect };

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
      const total = env.counts.get(island.workspaceId) ?? 0;
      const count = `${total.toLocaleString("en-US")} ${total === 1 ? "note" : "notes"}`;
      const baseline = p.y - pr - 22;
      const w = Math.max(measure(island.name, 15, 700), measure(count, 12, 500)) + 8;
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
          { text: count, size: 12, weight: 500, color: C.dim, dy: 16 },
        ],
      });
    }
  }

  // Then folders, biggest first, then named subfolders.
  type Cand = { x: number; y: number; rr: number; top: number; bottom: number; size: number; weight: number; text: string; color: string; halo: string; alpha: number; r: number };
  const cands: Cand[] = [];
  for (const island of model.layout.islands) {
    const halo = all ? C.island : C.ground;
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
          top: q.y - fr - 7,
          bottom: q.y + fr + size + 5,
          size,
          weight: 700,
          text: `${f.label.toUpperCase()}  ${env.counts.get(f.key) ?? 0}`,
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
          halo: C.zone,
          alpha: sa,
          r: sr,
        });
      }
    }
  }
  cands.sort((a, b) => b.r - a.r);
  for (const c of cands) {
    const w = measure(c.text, c.size, c.weight) + 6;
    // Above the bubble, else below it, else beside it on either side.
    const mid = c.y + c.size * 0.35;
    const spots: Array<[number, number]> = [
      [c.x, c.top],
      [c.x, c.bottom],
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
    for (const line of l.lines) haloText(ctx, style, line.text, l.x, l.baseline + line.dy, line.size, line.weight, line.color, l.halo);
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
