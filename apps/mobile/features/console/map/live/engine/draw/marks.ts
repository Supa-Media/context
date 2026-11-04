import { dotRadius } from "../lod";
import { noteKey } from "../paths";
import { readsAt } from "../timeline";
import type { Model, SceneAt } from "../scene";
import { BOW, bowOf, grain } from "./board";
import type { DrawEnv } from "./env";
import { circle } from "./primitives";

/**
 * Two marks drawn in pencil (Dev2, 2026-11-04):
 *
 * - **Somebody reading a note** is a mark on the note itself, never a line to
 *   the reader ("i do not like the lines which shows im reading a note"). The
 *   map's settings pick it: a loose pencil circle, slowly redrawn (the
 *   default), a ring that pulses out, or a soft halo.
 * - **A clicked note traces its links**: the links to the notes one step away
 *   are drawn over in pen, those notes keep their full strength and their
 *   names, and everything else steps back.
 */

/** The selected note and the notes one link away, or null when nothing is selected. */
export function traceOf(model: Model, scene: SceneAt, selected: string | null): Set<string> | null {
  if (selected === null || !model.layout.notes.has(selected)) return null;
  const out = new Set<string>([selected]);
  for (const [a, b] of model.layout.edges) {
    if (a === selected && scene.present.has(b)) out.add(b);
    else if (b === selected && scene.present.has(a)) out.add(a);
  }
  return out;
}

/** How far the rest of the map steps back while a note is traced. */
export const TRACE_REST = 0.25;

/** The selected note's own links, drawn over in pen. */
export function drawTrace(env: DrawEnv): void {
  const { ctx, style, model, scene } = env;
  const C = style.palette;
  const sel = env.selected;
  if (env.trace === null || sel === null) return;
  const from = model.layout.notes.get(sel);
  if (!from || scene.hidden.has(sel)) return;
  const p = env.screen(env.flyingAt.get(sel) ?? from);
  const sketch = style.look.sketch;
  const width = Math.max(1.4, 1.8 * style.look.lineWidth + 0.8);
  ctx.strokeStyle = grain(ctx, C, C.ink);
  for (const pass of sketch > 0.25 ? [0, 1] : [0]) {
    ctx.beginPath();
    for (const key of env.trace) {
      if (key === sel || scene.hidden.has(key)) continue;
      const n = model.layout.notes.get(key);
      if (!n || n.sub.folder.collapsed) continue;
      const w = env.flyingAt.get(key) ?? n;
      const q = env.screen(w);
      const bow = bowOf(from.x, from.y, w.x, w.y) * BOW * (0.3 + sketch * 2.4) + (pass === 0 ? 0 : bowOf(w.x, w.y, from.x, from.y) * BOW * 1.6 * sketch);
      ctx.moveTo(p.x, p.y);
      ctx.quadraticCurveTo((p.x + q.x) / 2 - (q.y - p.y) * bow, (p.y + q.y) / 2 + (q.x - p.x) * bow, q.x, q.y);
    }
    ctx.globalAlpha = pass === 0 ? 0.9 : 0.4;
    ctx.lineWidth = pass === 0 ? width : width * 0.7;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1;
}

/** Points round a loose, hand-drawn loop: a little more than one turn, its radius wandering. */
function loop(cx: number, cy: number, r: number, seed: number, start: number, turns: number, rough: number): Array<[number, number]> {
  const steps = 30;
  const out: Array<[number, number]> = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const a = start + t * turns * Math.PI * 2;
    const wob = 1 + rough * (Math.sin(a * 2 + seed * 7) * 0.06 + Math.sin(a * 3 + seed * 13) * 0.04) + t * 0.08 * rough;
    out.push([cx + Math.cos(a) * r * wob, cy + Math.sin(a) * r * wob * 0.92]);
  }
  return out;
}

/** The mark on every note somebody is reading, as the map's settings choose it. */
export function drawReadingMarks(env: DrawEnv): void {
  const { ctx, style, model, scene, s } = env;
  const C = style.palette;
  const rm = model.reducedMotion;
  const keys = new Set<string>([...scene.reading.keys(), ...scene.followReads.map((n) => n.key)]);
  for (const key of keys) {
    if (scene.editing.has(key) || !scene.present.has(key) || scene.hidden.has(key)) continue;
    const n = model.layout.notes.get(key);
    if (!n || n.sub.folder.collapsed) continue;
    const p = env.screen(env.flyingAt.get(key) ?? n);
    if (!env.onScreen(p, 30)) continue;
    const R = Math.max(dotRadius(s, n.deg, style.look.dotSize), 2.6);
    const seed = bowOf(n.x, n.y, n.y, n.x) * 10;
    if (style.look.reading === "pulse") {
      const k = rm ? 0.4 : (scene.phase * 0.9 + seed) % 1;
      circle(ctx, p.x, p.y, R + 4 + k * 13);
      ctx.strokeStyle = C.ink;
      ctx.globalAlpha = 0.9 * (1 - k);
      ctx.lineWidth = 1.6;
      ctx.stroke();
    } else if (style.look.reading === "halo") {
      const k = rm ? 0.5 : 0.5 + 0.5 * Math.sin(scene.phase * 2.4 + seed);
      ctx.fillStyle = C.ink;
      circle(ctx, p.x, p.y, R + 10);
      ctx.globalAlpha = 0.07 + 0.05 * k;
      ctx.fill();
      circle(ctx, p.x, p.y, R + 5);
      ctx.globalAlpha = 0.12 + 0.06 * k;
      ctx.fill();
    } else {
      // A pencil circle round the note, its start creeping round as if redrawn.
      const start = rm ? seed : seed + scene.phase * 0.5;
      const rough = 0.4 + style.look.sketch;
      ctx.strokeStyle = grain(ctx, C, C.ink);
      ctx.lineWidth = 1.4;
      ctx.globalAlpha = 0.9;
      const pts = loop(p.x, p.y, R + 6, seed, start, 1.12, rough);
      ctx.beginPath();
      ctx.moveTo(pts[0]![0], pts[0]![1]);
      for (const [x, y] of pts.slice(1)) ctx.lineTo(x, y);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
  }
}

/** How many of an AI's last reads its trail runs through. */
export const TRAIL_READS = 5;

/**
 * "AIs at work, as pencil trails": a faint dashed pencil line through the
 * notes an AI read last, ending where it is now. Only AIs, only while they
 * work, and never a stream of dots (Dev2, 2026-11-04).
 */
export function drawAgentTrails(env: DrawEnv): void {
  const { ctx, style, model, scene } = env;
  if (!style.look.showAgents) return;
  const C = style.palette;
  ctx.strokeStyle = grain(ctx, C, C.ink);
  ctx.lineWidth = 1.2;
  ctx.lineCap = "round";
  ctx.setLineDash([3, 5]);
  for (const a of scene.actors) {
    if (a.kind !== "agent" || a.doing === null || a.onCard) continue;
    const reads = model.live ? (model.liveReads.get(a.id) ?? []) : readsAt(model.events, a.id, scene.t);
    const pts = reads
      .slice(-TRAIL_READS)
      .map((r) => model.layout.notes.get(noteKey(r.workspaceId, r.path)))
      .filter((n): n is NonNullable<typeof n> => !!n && scene.present.has(n.key) && !n.sub.folder.collapsed)
      .map((n) => env.screen(n));
    // A trail needs somewhere to have come from: two reads at least.
    if (pts.length < 2) continue;
    pts.push(env.screen(a));
    ctx.globalAlpha = 0.35 * (env.dim ? 0.6 : 1);
    ctx.beginPath();
    ctx.moveTo(pts[0]!.x, pts[0]!.y);
    for (let i = 1; i < pts.length; i += 1) {
      const p = pts[i - 1]!;
      const q = pts[i]!;
      const bow = bowOf(p.x, p.y, q.x, q.y) * BOW * 3;
      ctx.quadraticCurveTo((p.x + q.x) / 2 - (q.y - p.y) * bow, (p.y + q.y) / 2 + (q.x - p.x) * bow, q.x, q.y);
    }
    ctx.stroke();
  }
  ctx.setLineDash([]);
  ctx.lineCap = "butt";
  ctx.lineWidth = 1;
  ctx.globalAlpha = 1;
}
