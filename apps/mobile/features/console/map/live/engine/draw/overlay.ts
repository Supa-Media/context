import { flagLine, flagName, groupActors, type Group } from "../actors";
import { LAYER } from "../hit";
import { placeFlag, placeLabel, type Rect } from "../labels";
import { dotRadius, flagsShown, noteLabelAlpha, facesApart } from "../lod";
import { lerp } from "../math";
import type { NotePlace } from "../layout";
import type { DrawEnv } from "./env";
import {
  FACE_R,
  drawCard,
  drawFace,
  drawFlag,
  circle,
  fillText,
  flagSize,
  fontOf,
  haloText,
  roundRect,
  typingDots,
} from "./primitives";

/**
 * What sits on top of the notes: faces and piles with their name tags, note
 * names that fit, reading dots flowing into readers, and notes in flight.
 */

const MAX_LABELS = 500;

/** Faces first (they claim their space), then their flags, then note names in what is left. */
export function placeFacesAndLabels(env: DrawEnv): { groups: Group[]; flags: Map<string, Rect & { sub: string | null }> } {
  const { s, scene } = env;
  const groups = groupActors(scene.actors, s, env.screen);
  const flags = new Map<string, Rect & { sub: string | null }>();
  for (const g of groups) {
    const w = g.single ? FACE_R * 2 + 4 : g.actors.length * 16 + 14;
    env.occ.claim({ x: g.x - w / 2, y: g.y - FACE_R - 2, w, h: FACE_R * 2 + 4 });
  }
  if (flagsShown(s) || groups.some((g) => g.single && g.actors[0]!.across.length >= 2)) {
    for (const g of groups) {
      if (!g.single) continue;
      const a = g.actors[0]!;
      if (a.onCard) continue;
      if (!flagsShown(s) && a.across.length < 2) continue;
      const sub = flagLine(a);
      const size = flagSize(env.ctx, env.style, flagName(a), sub);
      const r = placeFlag(env.occ, g.x, g.y, size.w, size.h, FACE_R, env.bounds, !env.narrow);
      if (r) flags.set(a.id, { ...r, sub });
    }
  }
  drawNoteLabels(env);
  return { groups, flags };
}

function drawNoteLabels(env: DrawEnv): void {
  const { ctx, style, model, scene, s } = env;
  const C = style.palette;
  const base = noteLabelAlpha(s);
  const follow = new Set(scene.followReads.map((n) => n.key));
  const popping = new Set(scene.pops.map((p) => p.note.key));
  const hotAlpha = Math.max(base, facesApart(s) ? 1 : 0);
  if (hotAlpha <= 0) return;
  type Cand = { n: NotePlace; hot: boolean };
  const cands: Cand[] = [];
  for (const key of scene.present) {
    if (scene.hidden.has(key)) continue;
    const n = model.layout.notes.get(key);
    if (!n) continue;
    const hot = env.hot.has(key) || follow.has(key) || popping.has(key);
    if (!hot && base <= 0) continue;
    if (!env.onScreen(env.screen(n), 0)) continue;
    cands.push({ n, hot });
  }
  cands.sort((a, b) => Number(b.hot) - Number(a.hot) || b.n.deg - a.n.deg || (a.n.title < b.n.title ? -1 : 1));
  let shown = 0;
  for (const { n, hot } of cands) {
    if (shown >= MAX_LABELS) break;
    const p = env.screen(n);
    const R = dotRadius(s, n.deg);
    const size = 11.5;
    ctx.font = fontOf(style, size, hot ? 700 : 500);
    const w = ctx.measureText(n.title).width + 6;
    const baseline = p.y + R + 14;
    if (!placeLabel(env.occ, p.x, baseline, w, size, env.bounds)) continue;
    shown += 1;
    ctx.globalAlpha = hot ? hotAlpha : base;
    haloText(ctx, style, n.title, p.x, baseline, size, hot ? 700 : 500, hot ? C.text : env.dim ? C.dim : C.text2);
    ctx.globalAlpha = 1;
    env.hit.rect({ x: p.x - w / 2, y: baseline - size, w, h: size * 1.3 }, { kind: "note", workspaceId: n.workspaceId, path: n.path }, LAYER.label);
  }
}

/** Ink dots streaming from the note being read into its reader. */
export function drawReading(env: DrawEnv, groups: Group[]): void {
  const { ctx, style, scene, model } = env;
  if (model.reducedMotion) return;
  const C = style.palette;
  const where = new Map<string, { x: number; y: number }>();
  for (const g of groups) for (const a of g.actors) where.set(a.id, g);
  for (const [key, ids] of scene.reading) {
    const n = model.layout.notes.get(key);
    if (!n) continue;
    const p = env.screen(n);
    for (const id of ids) {
      const q = where.get(id);
      if (!q || Math.hypot(p.x - q.x, p.y - q.y) < 6) continue;
      const lift = Math.min(16, Math.hypot(p.x - q.x, p.y - q.y) * 0.25);
      for (let i = 0; i < 7; i += 1) {
        const f = (scene.phase * 1.1 + i / 7) % 1;
        const x = lerp(p.x, q.x, f);
        const y = lerp(p.y, q.y, f) - Math.sin(f * Math.PI) * lift;
        circle(ctx, x, y, 2.4 * (1 - f * 0.4));
        ctx.fillStyle = C.ink;
        ctx.globalAlpha = 0.85 * Math.sin(f * Math.PI);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    }
  }
}

/** Notes in flight: a dot inside a workspace, a card with its mover between workspaces. */
export function drawFlights(env: DrawEnv): void {
  const { ctx, style, scene, s } = env;
  const C = style.palette;
  for (const fl of scene.flights) {
    const p = env.screen(fl.pos);
    if (fl.landedFor < 0) {
      if (fl.cross) {
        ctx.font = fontOf(style, 13, 500);
        const w = Math.min(280, ctx.measureText(fl.to.title).width + 50);
        ctx.save();
        ctx.shadowColor = "rgba(0,0,0,0.2)";
        ctx.shadowBlur = 14;
        ctx.shadowOffsetY = 6;
        roundRect(ctx, p.x - w / 2, p.y - 15, w, 30, 8);
        ctx.fillStyle = C.ground;
        ctx.fill();
        ctx.restore();
        drawCard(ctx, style, p.x - w / 2, p.y - 15, w, fl.to.title, "fly");
        drawFace(ctx, fl.actor, p.x - w / 2 - 4, p.y - 14, 0.85, style);
        const dest = fl.to.sub.folder.label || "the top level";
        const text = `${fl.actor.name} is moving it to ${fl.to.sub.folder.island.name} › ${dest}`;
        ctx.font = fontOf(style, 11, 500);
        const w2 = ctx.measureText(text).width + 14;
        const r = { x: p.x - w2 / 2, y: p.y + 19, w: w2, h: 20 };
        if (!env.narrow || (r.x >= env.bounds.minX && r.x + r.w <= env.bounds.maxX)) {
          roundRect(ctx, r.x, r.y, r.w, r.h, 6);
          ctx.fillStyle = C.ground;
          ctx.fill();
          ctx.strokeStyle = C.line;
          ctx.stroke();
          ctx.fillStyle = C.text2;
          ctx.textAlign = "center";
          fillText(ctx, text, p.x, p.y + 33);
        }
        env.hit.rect({ x: p.x - w / 2, y: p.y - 15, w, h: 30 }, { kind: "note", workspaceId: fl.to.workspaceId, path: fl.to.path }, LAYER.card);
      } else {
        const R = Math.max(dotRadius(s, fl.to.deg), 2.6) + 0.6;
        circle(ctx, p.x, p.y, R);
        ctx.fillStyle = C.ink;
        ctx.fill();
      }
    } else if (fl.cross) {
      const k = fl.landedFor / 1.6;
      if (k < 1) {
        const R = Math.max(dotRadius(s, fl.to.deg), 2);
        circle(ctx, p.x, p.y, R + 3 + k * 16);
        ctx.strokeStyle = C.ink;
        ctx.globalAlpha = 1 - k;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.globalAlpha = 1;
        ctx.lineWidth = 1;
      }
    }
  }
}

/** Faces, piles, name tags and typing dots. */
export function drawActors(env: DrawEnv, groups: Group[], flags: Map<string, Rect & { sub: string | null }>): void {
  const { ctx, style, scene, model } = env;
  const rm = model.reducedMotion;
  for (const g of groups) {
    if (g.single) {
      const a = g.actors[0]!;
      if (a.onCard) continue;
      const writing = a.doing === "edit" || a.doing === "create";
      const bob = writing && !rm ? Math.sin(scene.phase * 6) * 1.2 : 0;
      if (model.following === a.id) {
        circle(ctx, g.x, g.y + bob, FACE_R + 5);
        ctx.strokeStyle = style.palette.accent;
        ctx.lineWidth = 2;
        ctx.stroke();
        ctx.lineWidth = 1;
      }
      drawFace(ctx, a, g.x, g.y + bob, 1, style);
      const flag = flags.get(a.id);
      if (flag) drawFlag(ctx, style, flag.x, flag.y, flagName(a), flag.sub);
      if (writing) typingDots(ctx, g.x, g.y + 20, scene.phase, style, rm);
      env.hit.circle(g.x, g.y, FACE_R + 2, { kind: "actor", id: a.id }, LAYER.actor);
    } else {
      const n = g.actors.length;
      const w = (n - 1) * 16;
      g.actors.forEach((a, i) => drawFace(ctx, a, g.x - w / 2 + i * 16, g.y, 0.8, style));
      env.hit.rect(
        { x: g.x - w / 2 - FACE_R, y: g.y - FACE_R, w: w + FACE_R * 2, h: FACE_R * 2 },
        { kind: "pile", ids: g.actors.map((a) => a.id) },
        LAYER.pile,
      );
    }
  }
}
