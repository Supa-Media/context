import { flagLine, flagName, groupActors, type Group } from "../actors";
import { LAYER } from "../hit";
import { placeFlag, placeLabel, type Rect } from "../labels";
import { dotRadius, flagsShown, noteLabelAlpha, facesApart } from "../lod";
import { lerp } from "../math";
import type { NotePlace } from "../layout";
import type { Flight } from "../scene";
import { quietAt } from "./containers";
import type { DrawEnv } from "./env";
import { placeFlights, type FlightCaption } from "./flights";
import {
  FACE_R,
  drawFace,
  drawFlag,
  circle,
  flagSize,
  fontOf,
  haloText,
  typingDots,
} from "./primitives";

/**
 * What sits on top of the notes: faces and piles with their name tags, note
 * names that fit, reading dots flowing into readers, and notes in flight.
 */

const MAX_LABELS = 500;
/** On a phone, a handful of names reads; a crowd of them does not. */
const MAX_LABELS_NARROW = 14;

const BETWEEN_NUDGES: Array<[number, number]> = [
  [0, 0], [0, -26], [-30, -12], [30, -12], [0, -52], [-60, -20], [60, -20], [0, 26],
];

/** Faces first (they claim their space), then their flags, then note names in what is left. */
export function placeFacesAndLabels(env: DrawEnv): {
  groups: Group[];
  flags: Map<string, Rect & { sub: string | null }>;
  captions: Map<Flight, FlightCaption | null>;
} {
  const { s, scene } = env;
  const groups = groupActors(scene.actors, s, env.screen);
  const flags = new Map<string, Rect & { sub: string | null }>();
  for (const g of groups) {
    const w = g.single ? FACE_R * 2 + 4 : g.actors.length * 16 + 14;
    const box = (x: number, y: number) => ({ x: x - w / 2, y: y - FACE_R - 2, w, h: FACE_R * 2 + 4 });
    // An AI between workspaces has no note to sit on, so it may step aside
    // from a workspace's name rather than sit on it.
    if (g.single && g.actors[0]!.across.length >= 2) {
      const spot = BETWEEN_NUDGES.find(([dx, dy]) => !env.occ.hits(box(g.x + dx, g.y + dy)));
      if (spot) {
        g.x += spot[0];
        g.y += spot[1];
      }
    }
    env.occ.claim(box(g.x, g.y));
  }
  const captions = placeFlights(env);
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
  return { groups, flags, captions };
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
    const flying = env.flyingAt.get(key);
    if (scene.hidden.has(key) && !flying) continue;
    const n = model.layout.notes.get(key);
    if (!n) continue;
    // A note on the move carries its name with it.
    const hot = env.hot.has(key) || follow.has(key) || popping.has(key) || !!flying;
    if (!hot && base <= 0) continue;
    if (!env.onScreen(env.screen(flying ?? n), 0)) continue;
    cands.push({ n, hot });
  }
  cands.sort((a, b) => Number(b.hot) - Number(a.hot) || b.n.deg - a.n.deg || (a.n.title < b.n.title ? -1 : 1));
  // The names of notes somebody is on go first. After them, names go round
  // the dots, not over them: every dot on screen holds its own space.
  const claimDots = () => {
    for (const key of scene.present) {
      const n = model.layout.notes.get(key);
      if (!n || scene.hidden.has(key)) continue;
      const p = env.screen(n);
      if (!env.onScreen(p, 0)) continue;
      const R = dotRadius(s, n.deg) + 1;
      env.occ.claim({ x: p.x - R, y: p.y - R, w: R * 2, h: R * 2 });
    }
  };
  const max = env.narrow ? MAX_LABELS_NARROW : MAX_LABELS;
  const gap = env.narrow ? 3 : 0;
  let shown = 0;
  let dots = false;
  for (const { n, hot } of cands) {
    if (shown >= max) break;
    if (!hot && !dots) {
      claimDots();
      dots = true;
    }
    const p = env.screen(env.flyingAt.get(n.key) ?? n);
    const R = dotRadius(s, n.deg);
    const size = 11.5;
    ctx.font = fontOf(style, size, hot ? 700 : 500);
    const w = ctx.measureText(n.title).width + 6 + gap * 2;
    const baseline = p.y + R + 14;
    if (!placeLabel(env.occ, p.x, baseline + gap / 2, w, size + gap, env.bounds)) continue;
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
        const quiet = quietAt(env.quiet, x, y);
        if (quiet <= 0) continue;
        circle(ctx, x, y, 3 * (1 - f * 0.35));
        ctx.fillStyle = C.ink;
        ctx.globalAlpha = 0.85 * Math.sin(f * Math.PI) * quiet;
        ctx.fill();
      }
      ctx.globalAlpha = 1;
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
