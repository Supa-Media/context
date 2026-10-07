import { visibleRect, type Viewport } from "./camera";
import { HitFrame, LAYER } from "./hit";
import { overlaps, type Rect } from "./labels";
import type { FolderPlace, IslandPlace, NotePlace } from "./layout";
import { clamp, ease, lerp } from "./math";
import { noteKey, splitPath } from "./paths";
import type { Model, SceneAt } from "./scene";
import { moveTarget, presentAt } from "./timeline";
import { drawCard, drawFace, drawFlag, fillText, fitText, flagSize, fontOf, roundRect, type Ctx, type Style } from "./draw/primitives";

/**
 * The Folders view: the same notes as columns, one per root folder, PARA
 * first. A move is a card flying from one column to another with its mover
 * riding along; a column's count bumps when the card lands.
 */

/** Visual seconds. */
const FLY = 1.8;
const LEAVE = 0.4;
const ARRIVE = 0.35;
const NEW_FOR = 3;
const BUMP = 0.8;
const CARD_H = 32;
const CARD_STEP = 40;
const TOP = 52;

export type Lane = { folder: FolderPlace; x: number; y: number; w: number; h: number };

const MIN_LANE = 156;

/** Columns for the workspace's root folders; wider than the view means it scrolls sideways. */
export function lanesFor(island: IslandPlace, vp: Viewport, scrollX: number): { lanes: Lane[]; contentW: number } {
  const v = visibleRect(vp);
  const folders = island.folders.filter((f) => f.name !== "");
  const n = Math.max(1, folders.length);
  const pad = 18;
  const gap = 14;
  const w = Math.max(MIN_LANE, (v.w - pad * 2 - gap * (n - 1)) / n);
  const contentW = pad * 2 + w * n + gap * (n - 1);
  const lanes = folders.map((folder, i) => ({
    folder,
    x: v.x + pad + i * (w + gap) - scrollX,
    y: v.y + 22,
    w,
    h: v.h - 44,
  }));
  return { lanes, contentW };
}

type Card = { note: NotePlace; presence: number; sortAt: number; isNew: boolean; leaving?: boolean };
type FlyingCard = { note: NotePlace; fromKey: string | null; at: number; fromLane: Lane | null; toLane: Lane | null; k: number; actor: { id: string; kind: "person" | "agent"; name: string }; dest: string };

const rootOf = (n: NotePlace): string => splitPath(n.path).root;

export function renderFolders(
  ctx: Ctx,
  model: Model,
  scene: SceneAt,
  island: IslandPlace,
  vp: Viewport,
  scrollX: number,
  style: Style,
): { hit: HitFrame; contentW: number } {
  const C = style.palette;
  const hit = new HitFrame();
  const speed = model.speed;
  const visSince = (at: number) => (scene.t - at) / 1000 / speed;
  ctx.save();
  ctx.fillStyle = C.ground;
  ctx.fillRect(0, 0, vp.w, vp.h);
  const { lanes, contentW } = lanesFor(island, vp, scrollX);
  const laneOf = new Map(lanes.map((l) => [l.folder.name, l]));
  const ws = island.workspaceId;

  // Cards per lane, with arrivals fading in and departures closing their gap.
  const cards = new Map<string, Card[]>(lanes.map((l) => [l.folder.name, []]));
  const sortAt = new Map<string, number>();
  const fresh = new Set<string>();
  const leaving: Array<{ note: NotePlace; presence: number; at: number }> = [];
  const flying: FlyingCard[] = [];
  const bumps = new Map<string, number>();
  for (const e of model.events) {
    if (e.at > scene.t) continue;
    const age = visSince(e.at);
    if (e.kind === "create" && e.workspaceId === ws) {
      sortAt.set(noteKey(ws, e.path), e.at);
      if (age < NEW_FOR) fresh.add(noteKey(ws, e.path));
    }
    if (e.kind !== "move") continue;
    const to = moveTarget(e);
    const fromHere = e.workspaceId === ws;
    const toHere = to.workspaceId === ws;
    if (!fromHere && !toHere) continue;
    if (toHere) sortAt.set(noteKey(ws, to.path), e.at);
    const fromNote = fromHere ? model.layout.notes.get(noteKey(ws, e.from)) : undefined;
    const toNote = model.layout.notes.get(noteKey(to.workspaceId, to.path));
    if (fromNote && age < LEAVE && !model.reducedMotion) {
      leaving.push({ note: fromNote, presence: 1 - age / LEAVE, at: sortAt.get(fromNote.key) ?? -Infinity });
    }
    if (age < FLY && toNote && !model.reducedMotion) {
      const dest = toHere ? "" : `${toNote.sub.folder.island.name} › ${toNote.sub.folder.label || "the top level"}`;
      flying.push({
        note: toNote,
        fromKey: fromNote ? fromNote.key : null,
        at: e.at,
        fromLane: fromNote ? laneOf.get(rootOf(fromNote)) ?? null : null,
        toLane: toHere ? laneOf.get(rootOf(toNote)) ?? null : null,
        k: ease(age / FLY),
        actor: e.actor,
        dest,
      });
    } else if (toHere && toNote && age - FLY < BUMP && !model.reducedMotion) {
      bumps.set(rootOf(toNote), 1 - (age - FLY) / BUMP);
    }
  }
  const inFlight = new Set(flying.map((f) => f.note.key));
  const count = new Map<string, number>();
  for (const key of scene.present) {
    const n = model.layout.notes.get(key);
    if (!n || n.workspaceId !== ws) continue;
    const list = cards.get(rootOf(n));
    if (!list || inFlight.has(key)) continue;
    count.set(rootOf(n), (count.get(rootOf(n)) ?? 0) + 1);
    const at = sortAt.get(key) ?? -Infinity;
    let presence = 1;
    if (at !== -Infinity && !model.reducedMotion) {
      const age = visSince(at);
      presence = fresh.has(key) ? clamp(age / 0.4, 0, 1) : clamp((age - FLY) / ARRIVE, 0, 1);
    }
    list.push({ note: n, presence, sortAt: at, isNew: fresh.has(key) });
  }
  for (const l of leaving) {
    const list = cards.get(rootOf(l.note));
    if (list) list.push({ note: l.note, presence: l.presence, sortAt: l.at, isNew: false, leaving: true });
  }

  const slotY = (lane: Lane, index: number) => lane.y + TOP + index * CARD_STEP;
  // Where the names on the cards are, so a mover's flag can stay off them.
  const titles: Rect[] = [];
  const indexOf = new Map<string, number>();
  for (const lane of lanes) {
    const list = cards.get(lane.folder.name)!;
    list.sort((a, b) => b.sortAt - a.sortAt || (a.note.title < b.note.title ? -1 : a.note.title > b.note.title ? 1 : 0));
    const fits = Math.max(0, Math.floor((lane.h - TOP - 34) / CARD_STEP));
    const shownCount = count.get(lane.folder.name) ?? 0;
    // Column.
    roundRect(ctx, lane.x, lane.y, lane.w, lane.h, 14);
    ctx.fillStyle = C.zone;
    ctx.fill();
    ctx.strokeStyle = C.zoneLine;
    ctx.setLineDash([3, 5]);
    ctx.stroke();
    ctx.setLineDash([]);
    hit.rect({ x: lane.x, y: lane.y, w: lane.w, h: lane.h }, { kind: "folder", workspaceId: ws, path: `${lane.folder.name}/` }, LAYER.folder);
    ctx.font = fontOf(style, 12, 700);
    ctx.textAlign = "left";
    ctx.textBaseline = "alphabetic";
    ctx.fillStyle = C.muted;
    fillText(ctx, lane.folder.label.toUpperCase(), lane.x + 14, lane.y + 28);
    const b = bumps.get(lane.folder.name) ?? 0;
    const text = String(shownCount);
    ctx.font = fontOf(style, 13, 700);
    const cw = ctx.measureText(text).width + 14;
    roundRect(ctx, lane.x + lane.w - 14 - cw, lane.y + 12 - b * 3, cw, 22, 11);
    ctx.fillStyle = b > 0 ? C.accent : C.chip;
    ctx.fill();
    ctx.fillStyle = b > 0 ? C.ground : C.text2;
    ctx.textAlign = "center";
    fillText(ctx, text, lane.x + lane.w - 14 - cw / 2, lane.y + 27 - b * 3);
    // Cards.
    let y = 0;
    let drawn = 0;
    for (const card of list) {
      if (drawn >= fits) break;
      indexOf.set(card.note.key, y);
      if (card.presence > 0) {
        ctx.globalAlpha = card.presence;
        drawCard(ctx, style, lane.x + 10, slotY(lane, y), lane.w - 20, card.note.title, card.isNew ? "new" : null);
        ctx.font = fontOf(style, 13, 500);
        const tw = ctx.measureText(fitText(ctx, card.note.title, lane.w - 20 - (card.isNew ? 76 : 44))).width;
        titles.push({ x: lane.x + 10 + 30, y: slotY(lane, y) + 6, w: tw, h: CARD_H - 12 });
        ctx.globalAlpha = 1;
        hit.rect({ x: lane.x + 10, y: slotY(lane, y), w: lane.w - 20, h: CARD_H }, { kind: "note", workspaceId: ws, path: card.note.path }, LAYER.card);
        if (!card.leaving) drawn += 1;
      }
      y += card.presence;
    }
    const more = shownCount - drawn;
    if (more > 0) {
      ctx.font = fontOf(style, 11.5, 500);
      ctx.fillStyle = C.dim;
      ctx.textAlign = "left";
      fillText(ctx, `+ ${more} more`, lane.x + 14, slotY(lane, y) + 20);
    }
  }

  // Cards in flight, over everything, with their mover.
  const v = visibleRect(vp);
  for (const f of flying) {
    const from = f.fromLane;
    const to = f.toLane;
    const fromXY = from && f.fromKey
      ? { x: from.x + 10, y: slotY(from, Math.min(departureIndex(model, ws, from.folder.name, f.fromKey, f.at), maxCards(from))) } : { x: (to?.x ?? v.x) + 10, y: v.y - 40 };
    const toXY = to ? { x: to.x + 10, y: slotY(to, 0) } : { x: v.x + v.w + 20, y: v.y + 30 };
    const w = (to ?? from)!.w - 20;
    const x = lerp(fromXY.x, toXY.x, f.k);
    const y = lerp(fromXY.y, toXY.y, f.k) - Math.sin(f.k * Math.PI) * 90;
    ctx.save();
    ctx.shadowColor = "rgba(0,0,0,0.22)";
    ctx.shadowBlur = 18;
    ctx.shadowOffsetY = 8;
    drawCard(ctx, style, x, y, w, f.note.title, "fly");
    ctx.restore();
    drawCard(ctx, style, x, y, w, f.note.title, "fly");
    // The mover holds the card by its leading corner, and their flag goes
    // beside the card wherever it covers no card's name: to its left, its
    // right, above, below. It fades out as the card settles.
    const fr = 13;
    const face = [
      { x, y: y + 3 },
      { x: x + w, y: y + 3 },
    ].find((p) => !titles.some((a) => overlaps(a, { x: p.x - fr, y: p.y - fr, w: fr * 2, h: fr * 2 }))) ?? { x: x + w - 18, y: y + CARD_H / 2 };
    drawFace(ctx, f.actor, face.x, face.y, 0.9, style);
    const label = f.dest ? `${f.actor.name} is moving it to ${f.dest}` : `${f.actor.name} is moving it`;
    const size = flagSize(ctx, style, label, null);
    const spot = flagSpot({ x, y, w, h: CARD_H }, size, titles, { minX: v.x + 4, maxX: v.x + v.w - 4, minY: v.y + 4, maxY: v.y + v.h - 4 });
    ctx.globalAlpha = clamp((1 - f.k) / 0.15, 0, 1);
    if (ctx.globalAlpha > 0) drawFlag(ctx, style, spot.x, spot.y, label, null);
    ctx.globalAlpha = 1;
    hit.rect({ x, y, w, h: CARD_H }, { kind: "note", workspaceId: f.note.workspaceId, path: f.note.path }, LAYER.card);
  }

  // Whoever just wrote a new note, beside it.
  for (const e of model.events) {
    if (e.kind !== "create" || e.workspaceId !== ws || e.at > scene.t || model.reducedMotion) continue;
    const age = visSince(e.at);
    if (age > 2.4) continue;
    const key = noteKey(ws, e.path);
    const n = model.layout.notes.get(key);
    const lane = n ? laneOf.get(rootOf(n)) : undefined;
    const idx = indexOf.get(key);
    if (!lane || idx === undefined) continue;
    const y = slotY(lane, idx);
    drawFace(ctx, e.actor, lane.x + lane.w - 14, y + 4, 0.9, style);
    const label = `${e.actor.name} wrote this`;
    const size = flagSize(ctx, style, label, null);
    const fx = lane.x + lane.w + 2 + size.w > v.x + v.w ? lane.x + lane.w - 30 - size.w : lane.x + lane.w + 2;
    drawFlag(ctx, style, fx, y - 10, label, null);
  }
  ctx.restore();
  return { hit, contentW };
}

/**
 * Where a flying card's flag goes: the first spot beside the card — left,
 * right, above, below — that is on screen and covers none of `avoid` (the
 * names on the cards in the columns). Above the card when none is free.
 */
export function flagSpot(
  card: Rect,
  size: { w: number; h: number },
  avoid: readonly Rect[],
  bounds: { minX: number; maxX: number; minY: number; maxY: number },
): { x: number; y: number } {
  const midY = card.y + 3 - size.h / 2;
  const spots: Rect[] = [
    { x: card.x - 16 - size.w, y: midY, ...size },
    { x: card.x + card.w + 12, y: midY, ...size },
    { x: card.x + 16, y: card.y - size.h - 6, ...size },
    { x: card.x + 16, y: card.y + card.h + 6, ...size },
  ];
  const fits = (r: Rect) => r.x >= bounds.minX && r.x + r.w <= bounds.maxX && r.y >= bounds.minY && r.y + r.h <= bounds.maxY;
  const free = spots.find((r) => fits(r) && !avoid.some((a) => overlaps(a, r)));
  const r = free ?? spots[2]!;
  return { x: clamp(r.x, bounds.minX, bounds.maxX - size.w), y: r.y };
}

const maxCards = (lane: Lane): number => Math.max(0, Math.floor((lane.h - TOP - 34) / CARD_STEP) - 1);

/** Where a card sat in its column the moment before it left: newest arrivals first, then by title. */
function departureIndex(model: Model, ws: string, root: string, key: string, at: number): number {
  const before = presentAt(model.graphs, model.events, at - 1);
  const arrived = new Map<string, number>();
  for (const e of model.events) {
    if (e.at >= at) break;
    if (e.kind === "create" && e.workspaceId === ws) arrived.set(noteKey(ws, e.path), e.at);
    if (e.kind === "move") {
      const to = moveTarget(e);
      if (to.workspaceId === ws) arrived.set(noteKey(ws, to.path), e.at);
    }
  }
  const list: Array<{ key: string; at: number; title: string }> = [];
  for (const k of before) {
    const n = model.layout.notes.get(k);
    if (!n || n.workspaceId !== ws || rootOf(n) !== root) continue;
    list.push({ key: k, at: arrived.get(k) ?? -Infinity, title: n.title });
  }
  list.sort((a, b) => b.at - a.at || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  return Math.max(0, list.findIndex((x) => x.key === key));
}

/** How many notes each column holds at this instant (the counts the columns show). */
export function laneCounts(model: Model, scene: SceneAt, island: IslandPlace): Record<string, number> {
  const out: Record<string, number> = {};
  for (const f of island.folders) if (f.name !== "") out[f.name] = 0;
  for (const key of scene.present) {
    const n = model.layout.notes.get(key);
    if (!n || n.workspaceId !== island.workspaceId) continue;
    const root = rootOf(n);
    if (root in out) out[root]! += 1;
  }
  return out;
}
