import type { ActorRef, Doing, MapEvent, MapScope, MapView, WorkspaceGraph } from "../types";
import type { IslandPlace, Layout, NotePlace } from "./layout";
import { arcControl, clamp, ease, lerp, quad, type Point } from "./math";
import { noteKey } from "./paths";
import { highwaysAt, moveTarget, presentAt, readsAt, type Highway, type Step } from "./timeline";

/**
 * The map's state at one instant, ready to draw: which notes exist, which are
 * flying, being written or read, where every face is and what it is doing.
 *
 * A pure function of the model and `t`. Durations of animations are in
 * *visual* seconds and are stretched by the replay speed, so at 60× a note's
 * pop still takes half a second on screen; that keeps a replay frame fully
 * determined by (graphs, events, t, speed).
 */

export type Model = {
  graphs: WorkspaceGraph[];
  layout: Layout;
  /** Sorted by `at`. In live mode `at` is when the engine first saw it, if later. */
  events: MapEvent[];
  steps: Map<string, Step[]>;
  scope: MapScope;
  view: MapView;
  live: boolean;
  /** History milliseconds per visual millisecond: 1 live, 1/10/60 in a replay. */
  speed: number;
  selfId: string | null;
  /** Live: what each agent says it read, by actor id. */
  liveReads: Map<string, Array<{ workspaceId: string; path: string }>>;
  /** Replay: how long an actor stays after their last event (history ms). */
  idleMs: number;
  reducedMotion: boolean;
  following: string | null;
};

/** Visual seconds for each animation. */
export const DUR = {
  travel: 0.9,
  flight: 2.4,
  crossFlight: 3.2,
  trail: 1.5,
  pop: 1.2,
  link: 1.2,
  landing: 1.6,
  bump: 0.9,
} as const;

export type ActorView = {
  id: string;
  kind: "person" | "agent";
  name: string;
  self: boolean;
  /** World position. */
  x: number;
  y: number;
  /** What they are doing right now; null when idle. */
  doing: Doing | null;
  note: NotePlace | null;
  island: IslandPlace | null;
  /** Workspaces an agent is working across at once (sits between them). */
  across: IslandPlace[];
  /** Notes read so far in the window (agents). */
  readCount: number;
  /** Riding a note it is moving. */
  riding: boolean;
  /** Riding a note between workspaces: the flying card carries the face instead. */
  onCard: boolean;
  /** Where a note they are moving is going, in words ("Projects", "Supa › Projects"). */
  movingTo: string | null;
};

export type Flight = {
  from: NotePlace;
  to: NotePlace;
  /** Eased progress, 0..1; 1 once landed. */
  k: number;
  pos: Point;
  ctrl: Point;
  /** Visual seconds since it landed, or -1 while flying. */
  landedFor: number;
  cross: boolean;
  actor: ActorRef;
};

export type Pop = { note: NotePlace; age: number; actor: ActorRef; links: NotePlace[] };

export type SceneAt = {
  t: number;
  /** A clock for looping animations (pulses, particles), in visual seconds. */
  phase: number;
  present: Set<string>;
  /** Notes drawn by a flight instead of as a resting dot. */
  hidden: Set<string>;
  editing: Map<string, string>;
  reading: Map<string, string[]>;
  flights: Flight[];
  pops: Pop[];
  actors: ActorView[];
  highways: Array<Highway & { bump: number }>;
  /** What the followed actor has read, oldest first. */
  followReads: NotePlace[];
  /** True while anything is mid-animation, so the loop may not sleep. */
  animating: boolean;
};

const vis = (ms: number, speed: number): number => ms / 1000 / Math.max(1e-9, speed);
const hist = (sec: number, speed: number): number => sec * 1000 * speed;

/** Local midnight before `t`: "moved today" counts from here. */
export function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function sceneAt(model: Model, t: number): SceneAt {
  const { layout, speed } = model;
  const rm = model.reducedMotion;
  const phase = model.live ? (t % 1e7) / 1000 : vis(t, speed) % 1e5;
  let animating = false;
  const present = presentAt(model.graphs, model.events, t);
  const hidden = new Set<string>();
  const place = (ws: string, path: string | null): NotePlace | null =>
    path === null ? null : layout.notes.get(noteKey(ws, path)) ?? null;

  // Flights: moves whose animation window covers t.
  const flights: Flight[] = [];
  const flightOf = new Map<string, Flight>();
  for (const e of model.events) {
    if (e.kind !== "move" || e.at > t) continue;
    const to = moveTarget(e);
    const cross = to.workspaceId !== e.workspaceId;
    const dur = hist(cross ? DUR.crossFlight : DUR.flight, speed);
    const age = t - e.at;
    if (rm || age > dur + hist(DUR.trail + DUR.landing, speed)) continue;
    const from = place(e.workspaceId, e.from);
    const target = place(to.workspaceId, to.path);
    if (!from || !target) continue;
    const k = ease(clamp(age / dur, 0, 1));
    const ctrl = arcControl(from, target, cross ? 0.28 : 0.3, cross ? 0 : 8);
    const flight: Flight = {
      from,
      to: target,
      k,
      ctrl,
      pos: quad(from, ctrl, target, k),
      landedFor: age >= dur ? vis(age - dur, speed) : -1,
      cross,
      actor: e.actor,
    };
    flights.push(flight);
    flightOf.set(target.key, flight);
    if (age < dur) hidden.add(target.key);
    animating = true;
  }

  // New notes popping in and drawing their links.
  const pops: Pop[] = [];
  for (const e of model.events) {
    if (e.kind !== "create" || e.at > t) continue;
    const age = vis(t - e.at, speed);
    const note = place(e.workspaceId, e.path);
    if (!note || rm) continue;
    const links = linksOf(layout, note.key, present);
    const total = DUR.pop + 0.6 + links.length * 0.9 + DUR.link;
    if (age > Math.max(total, 3)) continue;
    pops.push({ note, age, actor: e.actor, links });
    animating = true;
  }

  // Actors.
  const editing = new Map<string, string>();
  const reading = new Map<string, string[]>();
  const actors: ActorView[] = [];
  for (const [id, steps] of model.steps) {
    const view = actorAt(model, id, steps, t, flightOf);
    if (!view) continue;
    if (view.moving) animating = true;
    actors.push(view.actor);
    const a = view.actor;
    for (const n of view.activeNotes) {
      if (a.doing === "edit" || a.doing === "create") editing.set(n.key, a.id);
      if (a.doing === "read") reading.set(n.key, [...(reading.get(n.key) ?? []), a.id]);
    }
    if (a.doing === "edit" || a.doing === "create" || a.doing === "read") animating = !rm || animating;
  }
  actors.sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

  // Paths between workspaces: count a move once its note has landed.
  const landedBy = t - hist(DUR.crossFlight, speed);
  const highways = highwaysAt(model.events, landedBy, startOfDay(t)).map((h) => {
    const age = vis(landedBy - h.lastAt, speed);
    const bump = rm ? 0 : age >= 0 && age < DUR.bump ? 1 - age / DUR.bump : 0;
    if (bump > 0) animating = true;
    return { ...h, bump };
  });

  const followReads: NotePlace[] = [];
  if (model.following) {
    const list = model.live
      ? model.liveReads.get(model.following) ?? []
      : readsAt(model.events, model.following, t);
    for (const r of list) {
      const n = place(r.workspaceId, r.path);
      if (n && present.has(n.key)) followReads.push(n);
    }
  }

  return { t, phase, present, hidden, editing, reading, flights, pops, actors, highways, followReads, animating };
}

/** Links of a note to notes that exist, in graph order. */
function linksOf(layout: Layout, key: string, present: Set<string>): NotePlace[] {
  const out: NotePlace[] = [];
  for (const [a, b] of layout.edges) {
    const other = a === key ? b : b === key ? a : null;
    if (!other || !present.has(other)) continue;
    const n = layout.notes.get(other);
    if (n) out.push(n);
    if (out.length >= 6) break;
  }
  return out;
}

const BETWEEN_MS = 90_000;

function actorAt(
  model: Model,
  id: string,
  steps: readonly Step[],
  t: number,
  flightOf: Map<string, Flight>,
): { actor: ActorView; activeNotes: NotePlace[]; moving: boolean } | null {
  const { layout, speed } = model;
  let curIndex = -1;
  for (let i = 0; i < steps.length; i += 1) if (steps[i]!.at <= t) curIndex = i;
  if (curIndex < 0) return null;
  const cur = steps[curIndex]!;
  if (!model.live && t - cur.at > model.idleMs) return null;
  const island = layout.islands.find((i) => i.workspaceId === cur.workspaceId) ?? null;
  if (!island) return null;
  const noteOf = (s: Step): NotePlace | null =>
    s.path === null ? null : layout.notes.get(noteKey(s.workspaceId, s.path)) ?? null;
  const restOf = (s: Step): Point => {
    const n = noteOf(s);
    if (n) return n;
    const i = layout.islands.find((x) => x.workspaceId === s.workspaceId) ?? island;
    return { x: i.x + i.r * 0.62, y: i.y + i.r * 0.78 };
  };

  // Working across workspaces at once: the latest step in each, if recent.
  const window = model.live ? BETWEEN_MS : Math.max(BETWEEN_MS, hist(8, speed));
  const latestByWs = new Map<string, Step>();
  for (let i = 0; i <= curIndex; i += 1) {
    const s = steps[i]!;
    if (cur.at - s.at <= window && s.path !== null) latestByWs.set(s.workspaceId, s);
  }
  const across = cur.kind === "agent" && latestByWs.size >= 2
    ? [...latestByWs.keys()].map((ws) => layout.islands.find((i) => i.workspaceId === ws)).filter((i): i is IslandPlace => !!i)
    : [];

  const note = noteOf(cur);
  const doing: Doing | null = cur.doing === "idle" ? null : cur.doing;
  let pos: Point = restOf(cur);
  let moving = false;
  let riding = false;
  let onCard = false;
  let movingTo: string | null = null;
  if (across.length >= 2) {
    pos = between(across[0]!, across[1]!);
  } else if (cur.doing === "move" && note) {
    const flight = flightOf.get(note.key);
    if (flight && flight.landedFor < 0) {
      pos = flight.pos;
      riding = true;
      onCard = flight.cross;
      moving = true;
    }
    const folder = note.sub.folder;
    const label = folder.label || "the top level";
    movingTo = cur.from && cur.from.workspaceId !== cur.workspaceId ? `${folder.island.name} › ${label}` : label;
  } else {
    const prev = curIndex > 0 ? steps[curIndex - 1]! : null;
    const travel = hist(DUR.travel, speed);
    if (prev && !model.reducedMotion && t - cur.at < travel) {
      const from = prev.doing === "move" && noteOf(prev) ? noteOf(prev)! : restOf(prev);
      const k = ease((t - cur.at) / travel);
      pos = { x: lerp(from.x, pos.x, k), y: lerp(from.y, pos.y, k) };
      moving = true;
    }
  }

  const activeNotes: NotePlace[] = [];
  if (across.length >= 2) {
    for (const s of latestByWs.values()) {
      const n = noteOf(s);
      if (n && s.doing === cur.doing) activeNotes.push(n);
    }
  } else if (note && doing && doing !== "move") activeNotes.push(note);

  const readCount = model.live
    ? model.liveReads.get(id)?.length ?? 0
    : readsAt(model.events, id, t).length;

  return {
    actor: {
      id,
      kind: cur.kind,
      name: cur.name,
      self: model.selfId === id,
      x: pos.x,
      y: pos.y,
      doing,
      note,
      island,
      across,
      readCount,
      riding,
      onCard,
      movingTo: doing === "move" ? movingTo : null,
    },
    activeNotes,
    moving,
  };
}

/** Halfway between two islands' facing rims. */
export function between(a: IslandPlace, b: IslandPlace): Point {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const d = Math.hypot(dx, dy) || 1;
  const gap = Math.max(0, d - a.r - b.r);
  // Nearer the first island and a little to the side, clear of the second's name above it.
  const along = a.r + gap * 0.42;
  const side = gap * 0.3;
  return { x: a.x + (dx / d) * along - (dy / d) * side, y: a.y + (dy / d) * along + (dx / d) * side };
}
