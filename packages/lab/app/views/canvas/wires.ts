/**
 * How the canvas draws a wire between two cards (`render.ts`): `wirePath`, the artifact's own curve, and `wireBows`,
 * which bends wires apart where two would draw one line (Dev, 2026-11-26).
 */
export const W = 180;
export const H = 64;

export type Pt = { x: number; y: number };

export function wirePath(
  a: Pt & { x: number; y: number },
  b: Pt,
  mode: string,
  /** How wide each end is: a step's box, or a group's wider card given with its x at the card's left edge. */
  aw = W,
  bw = W,
  /**
   * Bows the wire off the straight line (Dev, 2026-11-26: "lets try to have overlapping lines like this, let them bow
   * over each other"), from `wireBows`: `mid` moves its middle, `ends` moves its two ends along the cards' edges.
   */
  bow: WireBow = NO_BOW,
): { d: string; lx?: number; ly?: number } {
  const bowed = bow.mid.x || bow.mid.y || bow.ends.x || bow.ends.y;
  const curve = (x1: number, y1: number, c1x: number, c1y: number, c2x: number, c2y: number, x2: number, y2: number) => {
    const { mid: m, ends: e } = bow;
    const r = (n: number) => Math.round(n * 10) / 10;
    return `M${r(x1 + e.x)},${r(y1 + e.y)} C${r(c1x + m.x)},${r(c1y + m.y)} ${r(c2x + m.x)},${r(c2y + m.y)} ${r(x2 + e.x)},${r(y2 + e.y)}`;
  };
  if (mode === "loop") {
    const bot = Math.max(a.y, b.y) + H + 70;
    return {
      d: `M${a.x + W / 2},${a.y + H} C${a.x + W / 2},${bot} ${b.x + W / 2},${bot} ${b.x + W / 2},${b.y + H}`,
      lx: (a.x + b.x + W) / 2,
      ly: bot - 12,
    };
  }
  // Every bend is a circular arc, so it curves evenly end to end (Dev, 2026-11-26: "I was expecting a more uniform
  // curve"): an arc from (x1, y1) to (x2, y2) whose middle stands s off the straight line's middle, toward (nx, ny).
  const circ = (x1: number, y1: number, x2: number, y2: number, nx: number, ny: number, s: number) => {
    const c = Math.hypot(x2 - x1, y2 - y1);
    const r = (c * c) / 4 / (2 * s) + s / 2;
    const mx = (x1 + x2) / 2 + nx * s,
      my = (y1 + y2) / 2 + ny * s;
    const sweep = (mx - x1) * (y2 - my) - (my - y1) * (x2 - mx) > 0 ? 1 : 0;
    const k = (n: number) => Math.round(n * 10) / 10;
    return `M${k(x1)},${k(y1)} A${k(r)},${k(r)} 0 0 ${sweep} ${k(x2)},${k(y2)}`;
  };
  // A wire round the cards it skips: out of the middle of one card's top or bottom and into the other's, every one the
  // same shallow height (Dev picked it over arcs that grow with their length, 2026-11-26).
  if (bow.arc) {
    const under = bow.arc > 0;
    const sx = a.x + aw / 2,
      ex = b.x + bw / 2;
    return { d: circ(sx, under ? a.y + H : a.y, ex, under ? b.y + H : b.y, 0, under ? 1 : -1, ARC_HEIGHT) };
  }
  // Wires sharing a pair of cards along a row part as shallow arcs, side to side, either side of the line.
  const mid = Math.hypot(bow.mid.x, bow.mid.y);
  if (mid && Math.abs(a.x - b.x) >= W) {
    const fw = b.x > a.x;
    const n = { x: bow.mid.x / mid, y: bow.mid.y / mid };
    return { d: circ(fw ? a.x + aw : a.x, a.y + H / 2 + bow.ends.y, fw ? b.x : b.x + bw, b.y + H / 2 + bow.ends.y, n.x, n.y, mid * 0.6) };
  }
  let x1 = a.x + aw,
    y1 = a.y + H / 2,
    x2 = b.x,
    y2 = b.y + H / 2;
  if (Math.abs(a.x - b.x) < W) {
    x1 = a.x + aw / 2;
    x2 = b.x + bw / 2;
    y1 = b.y > a.y ? a.y + H : a.y;
    y2 = b.y > a.y ? b.y : b.y + H;
    const my = (y1 + y2) / 2;
    return { d: bowed ? curve(x1, y1, x1, my, x2, my, x2, y2) : `M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}` };
  }
  if (b.x + bw <= a.x) {
    x1 = a.x;
    x2 = b.x + bw;
  }
  const mx = (x1 + x2) / 2;
  return { d: bowed ? curve(x1, y1, mx, y1, mx, y2, x2, y2) : `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}` };
}

/**
 * How a wire bends off its straight line (`wirePath`, `wireBows`). `arc`: instead, it goes round the row, under it (1)
 * or over it (-1), from card bottom to bottom or top to top.
 */
export type WireBow = { mid: Pt; ends: Pt; arc?: number };
const NO_BOW: WireBow = { mid: { x: 0, y: 0 }, ends: { x: 0, y: 0 } };
/** How far a wire that goes round the row stands off its cards' tops or bottoms, at its middle. */
const ARC_HEIGHT = 70;
/** How far apart the wires between one pair of steps bow at their middles. */
const LANE = 48;
type Box = { x: number; y: number; w: number; h: number };

/** Whether the straight line from p to q runs through the box (Liang-Barsky clip). */
function crosses(p: Pt, q: Pt, r: Box): boolean {
  let t0 = 0,
    t1 = 1;
  const dx = q.x - p.x,
    dy = q.y - p.y;
  for (const [pp, qq] of [
    [-dx, p.x - r.x],
    [dx, r.x + r.w - p.x],
    [-dy, p.y - r.y],
    [dy, r.y + r.h - p.y],
  ] as const) {
    if (pp === 0) {
      if (qq < 0) return false;
    } else {
      const t = qq / pp;
      if (pp < 0) t0 = Math.max(t0, t);
      else t1 = Math.min(t1, t);
    }
  }
  return t0 < t1;
}

/**
 * Each wire's bow (`wirePath`), so no two wires draw one line (Dev, 2026-11-26):
 * - A wire whose straight line runs behind another card (Check & finish back to Intake, behind Front door) arcs clear of
 *   it, to its own left: a wire going back right to left arcs over the row, one going on arcs under it, card top to card
 *   top or bottom to bottom in an even, shallow circular arc, so it never lies on the wires between the cards it skips.
 * - Wires that join the same two ends, whichever way they run, take lanes either side of the line, one lane for each way
 *   and kind of wire (several steps folded into one box share theirs), measured across the line from the end whose id
 *   sorts first, so a wire and its return part. A pair with one lane stays straight. The ends part a third as far.
 * A send-back loop draws its own curve and takes neither.
 */
export function wireBows(edges: { from: string; to: string; mode: string }[], box: (id: string) => Box | null): Map<number, WireBow> {
  const centre = (r: Box): Pt => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
  const ids = [...new Set(edges.flatMap((e) => [e.from, e.to]))];
  const out = new Map<number, WireBow>();
  const add = (i: number, mid: Pt, ends: Pt) => {
    const o = out.get(i) ?? { mid: { x: 0, y: 0 }, ends: { x: 0, y: 0 } };
    out.set(i, { ...o, mid: { x: o.mid.x + mid.x, y: o.mid.y + mid.y }, ends: { x: o.ends.x + ends.x, y: o.ends.y + ends.y } });
  };
  const pairs = new Map<string, number[]>();
  edges.forEach((e, i) => {
    if (e.mode === "loop" || e.from === e.to) return;
    const ra = box(e.from),
      rb = box(e.to);
    if (!ra || !rb) return;
    const k = e.from < e.to ? e.from + "\u0000" + e.to : e.to + "\u0000" + e.from;
    pairs.set(k, [...(pairs.get(k) ?? []), i]);
    const a = centre(ra),
      b = centre(rb);
    const behind = ids.some((id) => {
      if (id === e.from || id === e.to) return false;
      const r = box(id);
      return !!r && crosses(a, b, { x: r.x - 6, y: r.y - 6, w: r.w + 12, h: r.h + 12 });
    });
    if (!behind) return;
    const dx = b.x - a.x,
      dy = b.y - a.y,
      len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len,
      ny = dx / len;
    // Along a row it goes round, from card top to card top or bottom to bottom: back over, on under,
    // all the same shallow height (`wirePath`).
    if (Math.abs(dx) > Math.abs(dy)) {
      out.set(i, { ...(out.get(i) ?? NO_BOW), arc: Math.sign(ny) });
      return;
    }
    // Otherwise it bows to its own left: it leaves and meets its cards near the corner on that side, and its middle
    // (three quarters of the way to its handles) clears the cards it passes.
    const half = Math.max(ra.h, rb.h) / 2;
    const lift = (half + 30 - (half - 10) / 4) / 0.75 + len * 0.06;
    add(i, { x: nx * lift, y: ny * lift }, { x: nx * (half - 10), y: ny * (half - 10) });
  });
  for (const [k, all] of pairs) {
    const laneOf = (i: number) => `${edges[i]!.from}>${edges[i]!.to}|${edges[i]!.mode}`;
    const lanes = [...new Set(all.map(laneOf))];
    if (lanes.length < 2) continue;
    const [lo, hi] = k.split("\u0000") as [string, string];
    const a = centre(box(lo)!),
      b = centre(box(hi)!);
    const dx = b.x - a.x,
      dy = b.y - a.y,
      len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len,
      ny = dx / len;
    // Many lanes squeeze closer, so a busy pair stays within two lanes' width of the line.
    const gap = Math.min(LANE, (LANE * 2.5) / (lanes.length - 1));
    for (const i of all) {
      const off = (lanes.indexOf(laneOf(i)) - (lanes.length - 1) / 2) * gap;
      add(i, { x: nx * off, y: ny * off }, { x: nx * off * 0.35, y: ny * off * 0.35 });
    }
  }
  return out;
}
