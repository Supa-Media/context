import { toWorld } from "../camera";
import { LAYER } from "../hit";
import { ICON_R, type FolderPlace, type IslandPlace } from "../layout";
import { boardHaze, dotRadius, edgeAlpha, edgeWidth, highwayAlpha, subRimAlpha } from "../lod";
import { clamp, lerp, quad, type Point } from "../math";
import { DUR } from "../scene";
import { BOW, bowOf, grain, textureOf } from "./board";
import type { DrawEnv } from "./env";
import { dotColour } from "./colour";
import { drawBundles, linesShown } from "./lines";
import { TRACE_REST } from "./marks";
import { openingLink, openingScale } from "./sketch";
import { circle, fontOf, roundRect } from "./primitives";

/** How strongly a link between two folders is drawn, against one inside a folder. */
export const CROSS_FOLDER_LINK = 0.35;

/**
 * The map's ground layers, back to front: workspaces, the paths between
 * them, the clickable (undrawn) folder areas, links, trails, and the notes themselves
 * with their live marks (teal for writing, ink for reading).
 */

export function drawGround(env: DrawEnv): void {
  const { model, s } = env;
  // Nothing is drawn round a workspace, a folder or a subfolder: they are
  // told apart by the space between them (Dev2, 2026-10-10). Their areas are
  // still there to click, to go into them.
  if (model.scope.kind === "all") {
    for (const island of model.layout.islands) {
      const p = env.screen(island);
      if (!env.onScreen(p, island.r * s)) continue;
      env.hit.circle(p.x, p.y, island.r * s, { kind: "workspace", workspaceId: island.workspaceId }, LAYER.workspace);
    }
    drawHighways(env);
  }
  for (const island of model.layout.islands) {
    for (const f of island.folders) {
      const p = env.screen(f);
      const pr = f.r * s;
      if (!env.onScreen(p, pr)) continue;
      if (f.collapsed) {
        const ir = drawFolderIcon(env, p);
        env.occ.claim({ x: p.x - ir - 2, y: p.y - ir - 2, w: ir * 2 + 4, h: ir * 2 + 4 });
        env.hit.circle(p.x, p.y, ir + 4, { kind: "folder", workspaceId: f.workspaceId, path: `${f.name}/` }, LAYER.folder);
        continue;
      }
      if (f.name !== "") env.hit.circle(p.x, p.y, pr, { kind: "folder", workspaceId: f.workspaceId, path: `${f.name}/` }, LAYER.folder);
      for (const sub of f.subs) {
        if (sub.name === "") continue;
        const q = env.screen(sub);
        const sr = sub.r * s;
        if (subRimAlpha(sr) <= 0 || !env.onScreen(q, sr)) continue;
        env.hit.circle(q.x, q.y, sr, { kind: "folder", workspaceId: f.workspaceId, path: `${f.name}/${sub.name}/` }, LAYER.sub);
      }
    }
  }
}

/** How big a folder's icon is on screen, in pixels from its centre: readable far out, never a blot up close. */
export function folderIconRadius(s: number): number {
  return clamp(ICON_R * s, 9, 20);
}

/** A folder drawn as one icon (Archive): a lidded box with a handle slot, in the folder names' colour. */
function drawFolderIcon(env: DrawEnv, p: Point): number {
  const { ctx, style, s } = env;
  const C = style.palette;
  const r = folderIconRadius(s);
  const w = r * 1.7;
  const lidH = r * 0.5;
  const bodyH = r * 1.05;
  const x = p.x - w / 2;
  const top = p.y - (lidH + bodyH) / 2;
  ctx.globalAlpha = env.dim ? 0.5 : 1;
  ctx.lineWidth = Math.max(1.2, r / 9);
  ctx.lineJoin = "round";
  ctx.strokeStyle = C.muted;
  ctx.fillStyle = C.ground;
  roundRect(ctx, x, top, w, lidH, r * 0.12);
  ctx.fill();
  ctx.stroke();
  roundRect(ctx, x + w * 0.07, top + lidH, w * 0.86, bodyH, r * 0.12);
  ctx.fill();
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(p.x - w * 0.16, top + lidH + bodyH * 0.32);
  ctx.lineTo(p.x + w * 0.16, top + lidH + bodyH * 0.32);
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.lineJoin = "miter";
  ctx.globalAlpha = 1;
  return r;
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
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2 - h.bump * 3;
    const text = `${h.count} moved today`;
    ctx.font = fontOf(style, 12, 600);
    const w = ctx.measureText(text).width + 18;
    // Drawn later, over the dots; claimed now, so nothing is put on it.
    env.pills.push({ x: mx, y: my, w, text, bump: h.bump, alpha: hw });
    env.occ.claim({ x: mx - w / 2 - 4, y: my - 16, w: w + 8, h: 32 });
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
    const lo = toWorld(env.cam, env.vp, { x: -env.cull, y: -env.cull });
    const hi = toWorld(env.cam, env.vp, { x: env.vp.w + env.cull, y: env.vp.h + env.cull });
    const view = { x0: lo.x, y0: lo.y, x1: hi.x, y1: hi.y };
    const width = edgeWidth(s) * style.look.lineWidth;
    // Pencil on paper, chalk on the board: a grainy stroke with a slight bow.
    const stroke = grain(ctx, C, C.edge);
    // While a note is traced, its own links are drawn over in pen and the rest step back.
    // Far out the folders are scribbles, and the links under them step back.
    const base = ea * boardHaze(s) * (env.dim ? 0.55 : 1) * (env.trace ? TRACE_REST : 1) * (1 - 0.75 * env.far);
    // Links inside a folder at full strength, links between folders faint:
    // the groups read, and the long cross-links do not become the picture.
    // How rough the pencil is (the person's "neat to messy"): how far links
    // bow, and whether each gets a second, rougher pass beside it.
    const sketch = style.look.sketch;
    const bowK = BOW * (0.3 + sketch * 2.4);
    const second = sketch > SECOND_PASS_FROM;
    const shown = linesShown(env);
    const merge = style.look.mergeLines ? env.far : 0;
    const bundles = merge > 0 ? new Map<string, { a: FolderPlace; b: FolderPlace; n: number }>() : null;
    for (const across of [true, false]) {
     for (const pass of second ? [0, 1] : [0]) {
      const passAlpha = (pass === 0 ? 1 : 0.35 + 0.3 * sketch) * (across ? 1 - merge : 1);
      ctx.globalAlpha = (across ? base * CROSS_FOLDER_LINK : base) * passAlpha;
      ctx.beginPath();
      for (const [ka, kb] of model.layout.edges) {
        if (!scene.present.has(ka) || !scene.present.has(kb)) continue;
        if (env.traceFrom !== null && env.trace && (ka === env.traceFrom || kb === env.traceFrom)) continue;
        if (popping.has(ka) || popping.has(kb) || creating.has(ka) || creating.has(kb)) continue;
        const na = notes.get(ka)!;
        const nb = notes.get(kb)!;
        // Links into a folder drawn as an icon would all meet on it: left out.
        if (na.sub.folder.collapsed || nb.sub.folder.collapsed) continue;
        if ((na.sub.folder !== nb.sub.folder) !== across) continue;
        if (!shown(na, nb)) continue;
        // Far out, the links between two folders are gathered into one stroke.
        if (across && bundles && pass === 0) {
          const id = na.sub.folder.key < nb.sub.folder.key ? `${na.sub.folder.key}\t${nb.sub.folder.key}` : `${nb.sub.folder.key}\t${na.sub.folder.key}`;
          const b = bundles.get(id);
          if (b) b.n += 1;
          else bundles.set(id, { a: na.sub.folder, b: nb.sub.folder, n: 1 });
        }
        // A note moving within its workspace takes its links with it.
        const fa = env.flyingAt.get(ka);
        const fb = env.flyingAt.get(kb);
        if ((scene.hidden.has(ka) && !fa) || (scene.hidden.has(kb) && !fb)) continue;
        const wa = fa ?? na;
        const wb = fb ?? nb;
        // Off screen in the world's own units first: tens of thousands of
        // links are tested every frame, and most go nowhere near the view.
        if (Math.max(wa.x, wb.x) < view.x0 || Math.min(wa.x, wb.x) > view.x1) continue;
        if (Math.max(wa.y, wb.y) < view.y0 || Math.min(wa.y, wb.y) > view.y1) continue;
        const a = env.screen(wa);
        const b = env.screen(wb);
        if (!env.onScreen(a, 0) && !env.onScreen(b, 0) && !crosses(env, a, b)) continue;
        const bow = bowOf(wa.x, wa.y, wb.x, wb.y) * bowK + (pass === 0 ? 0 : bowOf(wb.x, wb.y, wa.x, wa.y) * BOW * 1.6 * sketch);
        const c = { x: (a.x + b.x) / 2 - (b.y - a.y) * bow, y: (a.y + b.y) / 2 + (b.x - a.x) * bow };
        // While the map opens, each link is drawn out from the note that appeared first.
        const drawn = openingLink(env.opening, na, nb);
        if (drawn.k <= 0) continue;
        if (drawn.k < 1) {
          const [from, to] = drawn.flip ? [b, a] : [a, b];
          const c1 = { x: lerp(from.x, c.x, drawn.k), y: lerp(from.y, c.y, drawn.k) };
          const end = quad(from, c, to, drawn.k);
          ctx.moveTo(from.x, from.y);
          ctx.quadraticCurveTo(c1.x, c1.y, end.x, end.y);
          continue;
        }
        ctx.moveTo(a.x, a.y);
        ctx.quadraticCurveTo(c.x, c.y, b.x, b.y);
      }
      // Chalk carries a soft dusty halo: the same path again, wide and faint.
      if (pass === 0 && textureOf(C.board) === "chalk") {
        ctx.strokeStyle = C.edge;
        ctx.lineWidth = width * 3.2;
        ctx.globalAlpha = (across ? base * CROSS_FOLDER_LINK : base) * 0.1;
        ctx.stroke();
        ctx.globalAlpha = across ? base * CROSS_FOLDER_LINK : base;
      }
      ctx.strokeStyle = stroke;
      ctx.lineWidth = pass === 0 ? width : width * 0.7;
      ctx.stroke();
     }
    }
    if (bundles) drawBundles(env, bundles, merge * ea * (env.dim ? 0.55 : 1));
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

/** From this much messiness on, every link gets a second, rougher pencil pass. */
export const SECOND_PASS_FROM = 0.25;

/** Over this many notes in view, the smallest dots are painted as squares. */
export const SQUARE_FROM = 4000;

/** A resting dot gets its drawn rim from this radius up; smaller ones are only grain. */
export const RIM_FROM = 2.4;

/** Every note as a dot, and the marks of whatever is happening to it. */
export function drawNotes(env: DrawEnv): void {
  const { ctx, style, model, scene, s } = env;
  const C = style.palette;
  const rm = model.reducedMotion;
  const follow = new Set(scene.followReads.map((n) => n.key));
  const popping = new Set(scene.pops.map((p) => p.note.key));
  // Resting dots, the great majority, go into one path and one fill: what a
  // frame costs is how many times the canvas paints, and a workspace of
  // 20,000 notes painted one dot at a time is a slide show.
  const rims = new Map<string, number[]>();
  const sketch = style.look.sketch;
  // One path per pencil colour ("Colour by" in the map's settings) and depth
  // band in 3D: a handful of fills, never one per dot.
  const colourOf = dotColour(env);
  const buckets = new Map<string, { colour: string; alpha: number; list: number[] }>();
  // A big workspace far out is thousands of dots a few pixels across: squares paint far faster and look the same.
  const square = env.near.length > SQUARE_FROM ? 2 : 1.2;
  for (const n of env.near) {
    const key = n.key;
    if (scene.hidden.has(key) || popping.has(key) || scene.editing.has(key) || scene.reading.has(key) || follow.has(key)) continue;
    if (env.selected === key || env.trace?.has(key)) continue;
    const p = env.screen(n);
    if (!env.onScreen(p, 30)) continue;
    const per = p.per ?? 1;
    const R = dotRadius(s, n.deg, env.style.look.dotSize) * per * openingScale(env.opening, n);
    if (R <= 0) continue;
    const colour = colourOf(n);
    // Further in 3D is fainter, as in the prototype; four bands are enough to read.
    const depthBand = per === 1 ? 4 : Math.max(1, Math.min(4, Math.round((0.35 + 0.65 * per) * 4)));
    const id = `${colour}|${depthBand}`;
    let b = buckets.get(id);
    if (!b) buckets.set(id, (b = { colour, alpha: depthBand / 4, list: [] }));
    b.list.push(p.x, p.y, R);
    if (R >= RIM_FROM) {
      let r = rims.get(id);
      if (!r) rims.set(id, (r = []));
      r.push(p.x, p.y, R + 0.7 + sketch * 1.2, bowOf(n.x, n.y, n.y, n.x));
    }
    env.hit.circle(p.x, p.y, Math.max(R, 3), { kind: "note", workspaceId: n.workspaceId, path: n.path }, LAYER.note);
  }
  // Drawn dots: a grainy fill, and round the bigger ones a loose pencil rim
  // in the dot's own colour, a little off centre and not quite closed.
  const rest = (env.dim ? 0.5 : 1) * (env.trace ? TRACE_REST + 0.1 : 1) * (1 - 0.6 * env.far);
  for (const [id, { colour, alpha, list }] of buckets) {
    ctx.globalAlpha = rest * alpha;
    ctx.beginPath();
    for (let i = 0; i < list.length; i += 3) {
      const x = list[i]!;
      const y = list[i + 1]!;
      const R = list[i + 2]!;
      if (R <= square) ctx.rect(x - R, y - R, R * 2, R * 2);
      else {
        ctx.moveTo(x + R, y);
        ctx.arc(x, y, R, 0, Math.PI * 2);
      }
    }
    ctx.fillStyle = grain(ctx, C, colour);
    ctx.fill();
    const rim = rims.get(id);
    if (!rim) continue;
    ctx.beginPath();
    for (let i = 0; i < rim.length; i += 4) {
      const off = rim[i + 3]! * (0.4 + sketch * 1.6);
      const x = rim[i]! + off;
      const y = rim[i + 1]! - off;
      const r = rim[i + 2]!;
      const a0 = (rim[i + 3]! + 1) * 3;
      ctx.moveTo(x + Math.cos(a0) * r, y + Math.sin(a0) * r);
      ctx.arc(x, y, r, a0, a0 + 5.3);
    }
    ctx.strokeStyle = colour;
    ctx.lineWidth = 1;
    ctx.globalAlpha = rest * alpha * 0.75;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  // Then the few with something happening to them, each with its own marks.
  const marked = new Set<string>([...scene.editing.keys(), ...scene.reading.keys(), ...follow]);
  if (env.selected !== null) marked.add(env.selected);
  if (env.trace) for (const k of env.trace) marked.add(k);
  for (const key of marked) {
    if (!scene.present.has(key) || scene.hidden.has(key) || popping.has(key)) continue;
    const n = model.layout.notes.get(key);
    if (!n || n.sub.folder.collapsed) continue;
    const p = env.screen(n);
    if (!env.onScreen(p, 30)) continue;
    const R = dotRadius(s, n.deg, env.style.look.dotSize) * (p.per ?? 1);
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
    if (sel) {
      circle(ctx, p.x, p.y, R + 4);
      ctx.strokeStyle = C.accent;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.lineWidth = 1;
    }
    circle(ctx, p.x, p.y, ed || rd ? Math.max(R, 2.6) + 0.6 : R);
    ctx.fillStyle = ed || sel ? C.accent : rd ? C.ink : colourOf(n);
    ctx.globalAlpha = env.dim && !(ed || rd || sel) ? 0.5 : 1;
    ctx.fill();
    ctx.globalAlpha = 1;
    env.hit.circle(p.x, p.y, Math.max(R, 3), { kind: "note", workspaceId: n.workspaceId, path: n.path }, LAYER.note);
  }
  // New notes pop in with an overshoot and a ring.
  for (const pop of scene.pops) {
    const p = env.screen(pop.note);
    const R = Math.max(dotRadius(s, pop.note.deg, env.style.look.dotSize), 2.6) + 1.2;
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
