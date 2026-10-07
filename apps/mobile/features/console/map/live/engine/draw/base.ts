import { LAYER } from "../hit";
import type { IslandPlace } from "../layout";
import {
  dotRadius,
  edgeAlpha,
  folderLabelAlpha,
  highwayAlpha,
  islandLabelAlpha,
  subLabelAlpha,
  subRimAlpha,
} from "../lod";
import { clamp, lerp, quad, type Point } from "../math";
import { DUR } from "../scene";
import type { DrawEnv } from "./env";
import { circle, fillText, fontOf, haloText, roundRect } from "./primitives";

/**
 * The map's ground layers, back to front: workspaces, the paths between
 * them, folder and subfolder bubbles, links, trails, and the notes themselves
 * with their live marks (teal for writing, ink for reading).
 */

export function drawGround(env: DrawEnv): void {
  const { ctx, style, model, s } = env;
  const C = style.palette;
  if (model.scope.kind === "all") {
    for (const island of model.layout.islands) {
      const p = env.screen(island);
      if (!env.onScreen(p, island.r * s)) continue;
      circle(ctx, p.x, p.y, island.r * s);
      ctx.fillStyle = C.island;
      ctx.fill();
      ctx.strokeStyle = C.line;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      env.hit.circle(p.x, p.y, island.r * s, { kind: "workspace", workspaceId: island.workspaceId }, LAYER.workspace);
    }
    drawHighways(env);
  }
  ctx.lineWidth = 1;
  for (const island of model.layout.islands) {
    for (const f of island.folders) {
      const p = env.screen(f);
      const pr = f.r * s;
      if (!env.onScreen(p, pr)) continue;
      circle(ctx, p.x, p.y, pr);
      ctx.fillStyle = C.zone;
      ctx.fill();
      ctx.setLineDash([3, 5]);
      ctx.strokeStyle = C.zoneLine;
      ctx.lineWidth = 1.2;
      ctx.stroke();
      ctx.setLineDash([]);
      if (f.name !== "") env.hit.circle(p.x, p.y, pr, { kind: "folder", workspaceId: f.workspaceId, path: `${f.name}/` }, LAYER.folder);
      for (const sub of f.subs) {
        if (sub.name === "") continue;
        const q = env.screen(sub);
        const sr = sub.r * s;
        const a = subRimAlpha(sr);
        if (a <= 0 || !env.onScreen(q, sr)) continue;
        ctx.globalAlpha = a;
        circle(ctx, q.x, q.y, sr);
        ctx.setLineDash([2, 4]);
        ctx.strokeStyle = C.zoneLine;
        ctx.lineWidth = 1;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.globalAlpha = 1;
        env.hit.circle(q.x, q.y, sr, { kind: "folder", workspaceId: f.workspaceId, path: `${f.name}/${sub.name}/` }, LAYER.sub);
      }
    }
  }
}

/** Dashed paths between workspaces that notes moved along today, with a count that bumps. */
function drawHighways(env: DrawEnv): void {
  const { ctx, style, model, s } = env;
  const C = style.palette;
  const v = Math.min(env.vp.w, env.vp.h);
  const islands = model.layout.islands;
  const biggest = Math.max(...islands.map((i) => i.r)) * s * 2;
  const hw = highwayAlpha(biggest, v);
  if (hw <= 0) return;
  for (const h of env.scene.highways) {
    const A = islands.find((i) => i.workspaceId === h.a);
    const B = islands.find((i) => i.workspaceId === h.b);
    if (!A || !B) continue;
    const [p1, p2] = rimToRim(A, B);
    const a = env.screen(p1);
    const b = env.screen(p2);
    ctx.globalAlpha = hw * 0.5;
    ctx.strokeStyle = C.ink;
    ctx.lineWidth = Math.min(5, 1 + h.count * 0.22);
    ctx.setLineDash([2, 6]);
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineCap = "butt";
    ctx.lineWidth = 1;
    ctx.globalAlpha = hw;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2 - h.bump * 3;
    const text = `${h.count} moved today`;
    ctx.font = fontOf(style, 12, 600);
    const w = ctx.measureText(text).width + 18;
    roundRect(ctx, mx - w / 2, my - 12, w, 24, 12);
    ctx.fillStyle = h.bump > 0 ? C.ink : C.ground;
    ctx.fill();
    ctx.strokeStyle = C.line;
    ctx.stroke();
    ctx.fillStyle = h.bump > 0 ? C.ground : C.text2;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    fillText(ctx, text, mx, my + 0.5);
    ctx.textBaseline = "alphabetic";
    env.occ.claim({ x: mx - w / 2, y: my - 12, w, h: 24 });
    ctx.globalAlpha = 1;
  }
}

/** From one island's rim to the other's, a little off the centre line (as in the prototype). */
function rimToRim(A: IslandPlace, B: IslandPlace): [Point, Point] {
  const ang = Math.atan2(B.y - A.y, B.x - A.x);
  const off = 0.62;
  const px = -Math.sin(ang);
  const py = Math.cos(ang);
  const e1 = Math.sqrt(1 - off * off);
  return [
    { x: A.x + (Math.cos(ang) * e1 + px * off) * A.r, y: A.y + (Math.sin(ang) * e1 + py * off) * A.r },
    { x: B.x + (-Math.cos(ang) * e1 + px * off) * B.r, y: B.y + (-Math.sin(ang) * e1 + py * off) * B.r },
  ];
}

/** Links, new notes' links drawing themselves in teal, follow threads and move trails. */
export function drawLinks(env: DrawEnv): void {
  const { ctx, style, model, scene, s } = env;
  const C = style.palette;
  const notes = model.layout.notes;
  const ea = edgeAlpha(s);
  const popping = new Set(scene.pops.map((p) => p.note.key));
  const creating = new Set<string>();
  for (const [key, id] of scene.editing) {
    if (scene.actors.find((a) => a.id === id)?.doing === "create") creating.add(key);
  }
  if (ea > 0) {
    ctx.lineWidth = 1;
    ctx.strokeStyle = C.edge;
    ctx.globalAlpha = ea * (env.dim ? 0.55 : 1);
    ctx.beginPath();
    for (const [ka, kb] of model.layout.edges) {
      if (!scene.present.has(ka) || !scene.present.has(kb)) continue;
      if (popping.has(ka) || popping.has(kb) || creating.has(ka) || creating.has(kb)) continue;
      if (scene.hidden.has(ka) || scene.hidden.has(kb)) continue;
      const a = env.screen(notes.get(ka)!);
      const b = env.screen(notes.get(kb)!);
      if (!env.onScreen(a, 0) && !env.onScreen(b, 0) && !crosses(env, a, b)) continue;
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  // A new note's links, drawn out one after another in teal.
  ctx.strokeStyle = C.accent;
  ctx.lineWidth = 1.6;
  for (const pop of scene.pops) {
    const p = env.screen(pop.note);
    pop.links.forEach((other, i) => {
      const k = model.reducedMotion ? 1 : clamp((pop.age - 0.6 - i * 0.9) / DUR.link, 0, 1);
      if (k <= 0) return;
      const q = env.screen(other);
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(lerp(p.x, q.x, k), lerp(p.y, q.y, k));
      ctx.stroke();
    });
  }
  for (const key of creating) {
    if (popping.has(key)) continue;
    const p = env.screen(notes.get(key)!);
    for (const [ka, kb] of model.layout.edges) {
      const other = ka === key ? kb : kb === key ? ka : null;
      if (!other || !scene.present.has(other)) continue;
      const q = env.screen(notes.get(other)!);
      ctx.globalAlpha = 0.75;
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(q.x, q.y);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;
  ctx.lineWidth = 1;

  // What the followed actor has read stays tied to it by a faint ink thread.
  const followed = model.following ? scene.actors.find((a) => a.id === model.following) : undefined;
  if (followed && scene.followReads.length > 0) {
    const f = env.screen(followed);
    ctx.strokeStyle = C.ink;
    ctx.globalAlpha = 0.28;
    ctx.setLineDash([2, 4]);
    ctx.beginPath();
    for (const n of scene.followReads) {
      const p = env.screen(n);
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(f.x, f.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
  }

  // Where moved notes came from: a dashed trail that fades after landing.
  for (const fl of scene.flights) {
    const fade = fl.landedFor < 0 ? 1 : 1 - fl.landedFor / DUR.trail;
    if (fade <= 0) continue;
    ctx.globalAlpha = (fl.cross ? 0.5 : 0.55) * fade;
    ctx.strokeStyle = C.ink;
    ctx.setLineDash([4, 5]);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    const steps = 24;
    for (let i = 0; i <= steps; i += 1) {
      const q = env.screen(quad(fl.from, fl.ctrl, fl.to, (i / steps) * fl.k));
      if (i === 0) ctx.moveTo(q.x, q.y);
      else ctx.lineTo(q.x, q.y);
    }
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.lineWidth = 1;
    ctx.globalAlpha = 1;
  }
}

/** Does a segment between two off-screen points still cross the screen? (A cheap bounding check.) */
function crosses(env: DrawEnv, a: Point, b: Point): boolean {
  const { w, h } = env.vp;
  return !(Math.max(a.x, b.x) < 0 || Math.min(a.x, b.x) > w || Math.max(a.y, b.y) < 0 || Math.min(a.y, b.y) > h);
}

/** Every note as a dot, and the marks of whatever is happening to it. */
export function drawNotes(env: DrawEnv): void {
  const { ctx, style, model, scene, s } = env;
  const C = style.palette;
  const rm = model.reducedMotion;
  const follow = new Set(scene.followReads.map((n) => n.key));
  const popping = new Set(scene.pops.map((p) => p.note.key));
  for (const key of scene.present) {
    if (scene.hidden.has(key) || popping.has(key)) continue;
    const n = model.layout.notes.get(key);
    if (!n) continue;
    const p = env.screen(n);
    if (!env.onScreen(p, 30)) continue;
    const R = dotRadius(s, n.deg);
    const ed = scene.editing.has(key);
    const rd = scene.reading.has(key) || follow.has(key);
    const sel = env.selected === key;
    if (ed) {
      const pulse = rm ? 0.35 : (scene.phase * 1.4) % 1;
      circle(ctx, p.x, p.y, R + 4 + pulse * 14);
      ctx.strokeStyle = C.accent;
      ctx.globalAlpha = 1 - pulse;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.globalAlpha = 0.18;
      circle(ctx, p.x, p.y, R + 7);
      ctx.fillStyle = C.accent;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
    }
    if (rd && !ed) {
      circle(ctx, p.x, p.y, R + 4);
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = C.ink;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.lineWidth = 1;
    }
    if (sel) {
      circle(ctx, p.x, p.y, R + 4);
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    circle(ctx, p.x, p.y, ed || rd ? Math.max(R, 2.6) + 0.6 : R);
    ctx.fillStyle = ed || sel ? C.accent : rd ? C.ink : C.dot;
    ctx.globalAlpha = env.dim && !(ed || rd || sel) ? 0.5 : 1;
    ctx.fill();
    ctx.globalAlpha = 1;
    env.hit.circle(p.x, p.y, Math.max(R, 3), { kind: "note", workspaceId: n.workspaceId, path: n.path }, LAYER.note);
  }
  // New notes pop in with an overshoot and a ring.
  for (const pop of scene.pops) {
    const p = env.screen(pop.note);
    const R = Math.max(dotRadius(s, pop.note.deg), 2.6) + 1.2;
    const k = clamp(pop.age / 0.5, 0, 1);
    const scale = k < 1 ? 1.6 * Math.sin((k * Math.PI) / 2) - 0.6 * k : 1;
    if (pop.age < DUR.pop) {
      circle(ctx, p.x, p.y, 8 + pop.age * 30);
      ctx.strokeStyle = C.accent;
      ctx.globalAlpha = 1 - pop.age / DUR.pop;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1;
    }
    circle(ctx, p.x, p.y, R * Math.max(0.01, scale));
    ctx.fillStyle = C.accent;
    ctx.fill();
    env.hit.circle(p.x, p.y, R, { kind: "note", workspaceId: pop.note.workspaceId, path: pop.note.path }, LAYER.note);
  }
}

/** Workspace names and totals, "PROJECTS 312" over folders, and subfolder names. */
export function drawContainerLabels(env: DrawEnv): void {
  const { ctx, style, model, s } = env;
  const C = style.palette;
  const all = model.scope.kind === "all";
  for (const island of model.layout.islands) {
    const p = env.screen(island);
    const pr = island.r * s;
    if (all) {
      const a = islandLabelAlpha(pr);
      if (a > 0 && env.onScreen(p, pr)) {
        ctx.globalAlpha = a;
        ctx.textAlign = "center";
        ctx.textBaseline = "alphabetic";
        const y = p.y - pr - 22;
        ctx.font = fontOf(style, 15, 700);
        ctx.fillStyle = C.text;
        fillText(ctx, island.name, p.x, y);
        ctx.font = fontOf(style, 12, 500);
        ctx.fillStyle = C.dim;
        const total = env.counts.get(island.workspaceId) ?? 0;
        fillText(ctx, `${total.toLocaleString("en-US")} ${total === 1 ? "note" : "notes"}`, p.x, y + 16);
        const w = Math.max(ctx.measureText(island.name).width, 80);
        env.occ.claim({ x: p.x - w / 2, y: y - 15, w, h: 34 });
        ctx.globalAlpha = 1;
      }
    }
    const halo = all ? C.island : C.ground;
    for (const f of island.folders) {
      const q = env.screen(f);
      const fr = f.r * s;
      if (!env.onScreen(q, fr)) continue;
      const a = f.label ? folderLabelAlpha(fr) : 0;
      if (a > 0) {
        const size = clamp(fr / 9, 10, 13);
        const text = `${f.label.toUpperCase()}  ${env.counts.get(f.key) ?? 0}`;
        ctx.globalAlpha = a;
        haloText(ctx, style, text, q.x, q.y - fr - 7, size, 700, C.muted, halo);
        ctx.globalAlpha = 1;
        const w = ctx.measureText(text).width;
        env.occ.claim({ x: q.x - w / 2, y: q.y - fr - 7 - size, w, h: size * 1.25 });
      }
      for (const sub of f.subs) {
        if (sub.name === "") continue;
        const sq = env.screen(sub);
        const sr = sub.r * s;
        const sa = subLabelAlpha(sr);
        if (sa <= 0 || !env.onScreen(sq, sr)) continue;
        ctx.globalAlpha = sa;
        haloText(ctx, style, sub.label, sq.x, sq.y - sr - 6, 12.5, 700, C.text2);
        ctx.globalAlpha = 1;
        const w = ctx.measureText(sub.label).width;
        env.occ.claim({ x: sq.x - w / 2, y: sq.y - sr - 18, w, h: 15 });
      }
    }
  }
}
