import { agentPaint } from "../../agentKind";
import { overlaps, type Rect } from "../labels";
import { HUB_R, type IslandPlace } from "../layout";
import { highwayAlpha } from "../lod";
import { SPACING } from "../pack";
import type { Point } from "../math";
import type { DrawEnv } from "./env";
import { circle, drawFace, FACE_R, fitText, fontOf, haloText } from "./primitives";

/**
 * "All workspaces" as a picture of one person's estate: you in the middle,
 * a road out to each workspace you are in, and the AI tools you connected
 * standing between the workspaces they reach, with a dotted line in their
 * own colour to each (Dev2's board, 2026-10-10).
 *
 * Drawn only in the all-workspaces scope with a hub to draw, and only while
 * framed out far enough to see the ring: it fades with the paths between
 * workspaces as you zoom into one.
 */

export type HubAgent = { id: string; name: string; at: Point; to: Point[] };
export type HubMarks = { alpha: number; you: Point; name: string; agents: HubAgent[] };

/** The least distance between two agents' faces, in world units; more on a big map. */
const AGENT_GAP = SPACING * 7;

/**
 * Where a line from `from` meets a workspace: the near side of its nearest
 * folder, not of the island's circle. Folders pack to one side of an island
 * (Projects in the middle, the rest round it), so the circle's edge can be
 * open ground, and a line that stopped there pointed at nothing.
 */
export function landingOn(island: IslandPlace, from: Point): Point {
  let best = null as { x: number; y: number; r: number } | null;
  let bestGap = Infinity;
  for (const f of island.folders) {
    const gap = Math.hypot(from.x - f.x, from.y - f.y) - f.r;
    if (gap < bestGap) {
      bestGap = gap;
      best = f;
    }
  }
  const target = best ?? island;
  const d = Math.hypot(from.x - target.x, from.y - target.y) || 1;
  // A folder's radius carries a margin round its notes; stop inside it.
  const reach = target.r * (best ? 0.75 : 0.8);
  return { x: target.x + ((from.x - target.x) / d) * reach, y: target.y + ((from.y - target.y) / d) * reach };
}

/** Where every agent stands, in world units: between its workspaces, nudged clear of the others. */
export function placeAgents(islands: readonly IslandPlace[], agents: ReadonlyArray<{ id: string; name: string; workspaceIds: string[] }>): HubAgent[] {
  const byId = new Map(islands.map((i) => [i.workspaceId, i]));
  const out: HubAgent[] = [];
  // Framed whole, a face and its name need about a fifth of the map's radius
  // to themselves, whatever the map's size.
  const outer = Math.max(...islands.map((i) => Math.hypot(i.x, i.y) + i.r));
  const gap = Math.max(AGENT_GAP, outer * 0.2);
  agents.forEach((agent, k) => {
    const reach = agent.workspaceIds.map((id) => byId.get(id)).filter((i): i is IslandPlace => i !== undefined);
    if (reach.length === 0) return;
    let ux = 0;
    let uy = 0;
    for (const i of reach) {
      const d = Math.hypot(i.x, i.y) || 1;
      ux += i.x / d;
      uy += i.y / d;
    }
    // Workspaces straight across from each other: above you, between them.
    let ang = Math.hypot(ux, uy) < 1e-6 ? Math.atan2(reach[0]!.y, reach[0]!.x) - Math.PI / 2 : Math.atan2(uy, ux);
    // Halfway from the middle to the nearest edge of what it reaches.
    const inner = Math.min(...reach.map((i) => Math.hypot(i.x, i.y) - i.r));
    const rr = Math.max(HUB_R * 0.9, inner * 0.6);
    // One workspace only: off its road, to one side or the other.
    if (reach.length === 1) ang += ((k % 2 === 0 ? 1 : -1) * gap * 0.6) / rr;
    const want: Point = { x: Math.cos(ang) * rr, y: Math.sin(ang) * rr };
    // Taken, or too near you or inside a workspace: the free spot nearest
    // where it wanted to be, along the ring or nearer its workspaces.
    const free = (q: Point) =>
      Math.hypot(q.x, q.y) >= gap * 0.8 &&
      islands.every((i) => Math.hypot(q.x - i.x, q.y - i.y) > i.r) &&
      out.every((o) => Math.hypot(o.at.x - q.x, o.at.y - q.y) >= gap);
    let p = want;
    if (!free(p)) {
      const spots: Point[] = [];
      for (const f of [1, 1.3, 0.75, 1.55]) {
        for (let j = -12; j <= 12; j += 1) {
          const a = ang + (j * gap * 0.5) / rr;
          spots.push({ x: Math.cos(a) * rr * f, y: Math.sin(a) * rr * f });
        }
      }
      spots.sort((a, b) => Math.hypot(a.x - want.x, a.y - want.y) - Math.hypot(b.x - want.x, b.y - want.y));
      p = spots.find(free) ?? want;
    }
    const to = reach.map((i) => landingOn(i, p));
    out.push({ id: agent.id, name: agent.name, at: p, to });
  });
  return out;
}

/** The roads and the agents' lines, under the notes; returns what `drawHubFaces` puts on top. */
export function drawHubLines(env: DrawEnv): HubMarks | null {
  const { ctx, style, model, s } = env;
  const hub = model.hub;
  const islands = model.layout.islands;
  if (model.scope.kind !== "all" || !hub || islands.length < 2) return null;
  const biggest = Math.max(...islands.map((i) => i.r)) * s * 2;
  const alpha = highwayAlpha(biggest, Math.min(env.vp.w, env.vp.h));
  if (alpha <= 0) return null;
  const C = style.palette;
  const you = env.screen({ x: 0, y: 0 });

  // A road from you to the near side of each workspace, bowed a little.
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = C.zoneLine;
  ctx.lineWidth = 1.8;
  ctx.lineCap = "round";
  for (const island of islands) {
    const end = env.screen(landingOn(island, { x: 0, y: 0 }));
    const mx = (you.x + end.x) / 2;
    const my = (you.y + end.y) / 2;
    const len = Math.hypot(end.x - you.x, end.y - you.y);
    const bow = len * 0.12;
    ctx.beginPath();
    ctx.moveTo(you.x, you.y);
    ctx.quadraticCurveTo(mx - ((end.y - you.y) / (len || 1)) * bow, my + ((end.x - you.x) / (len || 1)) * bow, end.x, end.y);
    ctx.stroke();
  }

  // Each agent's dotted line to every workspace it reaches, in its colour.
  const agents = placeAgents(islands, hub.agents);
  ctx.lineWidth = 1.6;
  ctx.setLineDash([1, 5]);
  for (const agent of agents) {
    const tint = agentPaint(agent.name, C.agent).tint;
    const a = env.screen(agent.at);
    ctx.strokeStyle = tint;
    ctx.fillStyle = tint;
    for (const t of agent.to) {
      const b = env.screen(t);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.setLineDash([]);
      circle(ctx, b.x, b.y, 4);
      ctx.fill();
      ctx.setLineDash([1, 5]);
    }
  }
  ctx.setLineDash([]);
  ctx.lineCap = "butt";
  ctx.lineWidth = 1;
  ctx.globalAlpha = 1;

  // Claimed now, so no name or flag is put on a face.
  const youR = FACE_R * 2;
  env.occ.claim({ x: you.x - youR - 6, y: you.y - youR - 6, w: youR * 2 + 12, h: youR * 2 + 30 });
  const marks: HubMarks = { alpha, you, name: hub.you, agents: agents.map((g) => ({ ...g, at: env.screen(g.at) })) };
  for (const g of marks.agents) env.occ.claim({ x: g.at.x - 40, y: g.at.y - 20, w: 80, h: 48 });
  return marks;
}

/** The longest an agent's name runs under its face, in pixels. */
const NAME_MAX = 120;
const NAME_SIZE = 12;

/** You and the agents, over the notes and names. */
export function drawHubFaces(env: DrawEnv, marks: HubMarks | null): void {
  if (!marks) return;
  const { ctx, style } = env;
  const C = style.palette;
  ctx.globalAlpha = marks.alpha;
  drawFace(ctx, { kind: "person", id: "you", name: marks.name }, marks.you.x, marks.you.y, 2, style);
  const youBase = marks.you.y + FACE_R * 2 + 18;
  haloText(ctx, style, "You", marks.you.x, youBase, 14, 700, C.text, C.ground);
  // Faces and "You" first, so a name never runs over one; then each name
  // under its face, or over it or beside it when that is taken, or not at all.
  const taken: Rect[] = [{ x: marks.you.x - 20, y: youBase - 14, w: 40, h: 18 }];
  const faceR = FACE_R * 1.3;
  for (const g of marks.agents) taken.push({ x: g.at.x - faceR, y: g.at.y - faceR, w: faceR * 2, h: faceR * 2 });
  taken.push({ x: marks.you.x - FACE_R * 2, y: marks.you.y - FACE_R * 2, w: FACE_R * 4, h: FACE_R * 4 });
  for (const g of marks.agents) {
    drawFace(ctx, { kind: "agent", id: g.id, name: g.name }, g.at.x, g.at.y, 1.3, style);
    ctx.font = fontOf(style, NAME_SIZE, 600);
    const name = fitText(ctx, g.name.replace(/\s*\([^)]*\)$/, ""), NAME_MAX);
    const w = ctx.measureText(name).width + 6;
    const side = faceR + 6 + w / 2;
    const mid = g.at.y + NAME_SIZE / 2 - 1;
    const spot = (
      [
        [g.at.x, g.at.y + faceR + 15],
        [g.at.x, g.at.y - faceR - 7],
        [g.at.x + side, mid],
        [g.at.x - side, mid],
      ] as const
    )
      .map(([cx, base]) => ({ cx, base, r: { x: cx - w / 2, y: base - NAME_SIZE, w, h: NAME_SIZE * 1.3 } }))
      .find(({ r }) => !taken.some((t) => overlaps(r, t)));
    if (!spot) continue;
    taken.push(spot.r);
    haloText(ctx, style, name, spot.cx, spot.base, NAME_SIZE, 600, C.text2, C.ground);
  }
  ctx.globalAlpha = 1;
}
