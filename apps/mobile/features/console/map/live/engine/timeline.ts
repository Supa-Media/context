import type { Actor, Doing, MapEvent, WorkspaceGraph } from "../types";
import type { ExtraPath } from "./layout";
import { noteKey, splitPath } from "./paths";

/**
 * The map at any moment, from what is there now and what happened.
 *
 * The graphs are the present. Walking the events back from now to `t` undoes
 * them: a note created after `t` was not there yet, and a note moved after
 * `t` was still where it came from. Everything here is a pure function of
 * (graphs, events, t), which is what lets a replay be scrubbed: the same three
 * inputs always give the same picture.
 */

/** An actor as the engine takes it: a workspace's `Actor`, told which workspace. */
export type MapActor = Actor & { workspaceId?: string };

/** One thing an actor did, as the actor layer reads it. */
export type Step = {
  actorId: string;
  kind: "person" | "agent";
  name: string;
  workspaceId: string;
  path: string | null;
  doing: Doing;
  at: number;
  /** Set for a move: where the note came from. */
  from?: { workspaceId: string; path: string };
};

export const byTime = (a: { at: number }, b: { at: number }): number => a.at - b.at;

/** Where a move landed. */
export const moveTarget = (e: Extract<MapEvent, { kind: "move" }>): { workspaceId: string; path: string } => ({
  workspaceId: e.toWorkspaceId ?? e.workspaceId,
  path: e.to,
});

/**
 * Paths the layout must hold a place for although no graph has them now: where
 * moved notes came from, and notes created and since deleted. Their places stay
 * empty except while the replay is before the move.
 */
export function historyPaths(events: readonly MapEvent[], graphs: readonly WorkspaceGraph[] = []): ExtraPath[] {
  const titles = new Map<string, string>();
  for (const g of graphs) for (const n of g.nodes) titles.set(noteKey(g.workspaceId, n.path), n.title);
  const out: ExtraPath[] = [];
  for (const e of [...events].sort(byTime)) {
    if (e.kind === "move") {
      const to = moveTarget(e);
      // A note keeps its name across a move, whichever end the graphs know it by.
      const title = titles.get(noteKey(to.workspaceId, to.path)) ?? titles.get(noteKey(e.workspaceId, e.from));
      if (title) {
        titles.set(noteKey(to.workspaceId, to.path), title);
        titles.set(noteKey(e.workspaceId, e.from), title);
      }
      out.push({ workspaceId: e.workspaceId, path: e.from, title });
      out.push({ workspaceId: to.workspaceId, path: to.path, title });
    } else if (e.kind === "create") {
      out.push({ workspaceId: e.workspaceId, path: e.path });
    }
  }
  return out;
}

/** Note keys that exist at `t`. */
export function presentAt(graphs: readonly WorkspaceGraph[], events: readonly MapEvent[], t: number): Set<string> {
  const present = new Set<string>();
  for (const g of graphs) for (const n of g.nodes) present.add(noteKey(g.workspaceId, n.path));
  const later = events.filter((e) => e.at > t).sort(byTime).reverse();
  for (const e of later) {
    if (e.kind === "create") {
      present.delete(noteKey(e.workspaceId, e.path));
    } else if (e.kind === "move") {
      const to = moveTarget(e);
      present.delete(noteKey(to.workspaceId, to.path));
      present.add(noteKey(e.workspaceId, e.from));
    }
  }
  return present;
}

/** Notes per root folder per workspace at `t` (`""` is the top level), for the sidebar's counts. */
export function folderCountsAt(
  graphs: readonly WorkspaceGraph[],
  events: readonly MapEvent[],
  t: number,
): Record<string, Record<string, number>> {
  const counts: Record<string, Record<string, number>> = {};
  for (const g of graphs) counts[g.workspaceId] = {};
  for (const key of presentAt(graphs, events, t)) {
    const at = key.indexOf("\n");
    const ws = key.slice(0, at);
    const { root } = splitPath(key.slice(at + 1));
    const forWs = (counts[ws] ??= {});
    forWs[root] = (forWs[root] ?? 0) + 1;
  }
  return counts;
}

/** How many events fell in each of `buckets` equal slices of [from, to). */
export function histogram(events: readonly MapEvent[], from: number, to: number, buckets: number): number[] {
  const out = new Array<number>(Math.max(0, buckets)).fill(0);
  const span = to - from;
  if (buckets <= 0 || span <= 0) return out;
  for (const e of events) {
    if (e.at < from || e.at >= to) continue;
    const i = Math.min(buckets - 1, Math.floor(((e.at - from) / span) * buckets));
    out[i]! += 1;
  }
  return out;
}

/** A path between two workspaces that notes moved along. `a` < `b` by id. */
export type Highway = { a: string; b: string; count: number; lastAt: number };

/** Cross-workspace moves landed in [since, t], per pair of workspaces. */
export function highwaysAt(events: readonly MapEvent[], t: number, since: number): Highway[] {
  const byPair = new Map<string, Highway>();
  for (const e of events) {
    if (e.kind !== "move" || !e.toWorkspaceId || e.toWorkspaceId === e.workspaceId) continue;
    if (e.at < since || e.at > t) continue;
    const [a, b] = e.workspaceId < e.toWorkspaceId ? [e.workspaceId, e.toWorkspaceId] : [e.toWorkspaceId, e.workspaceId];
    const id = `${a}\n${b}`;
    const h = byPair.get(id) ?? { a, b, count: 0, lastAt: -Infinity };
    h.count += 1;
    h.lastAt = Math.max(h.lastAt, e.at);
    byPair.set(id, h);
  }
  return [...byPair.values()].sort((x, y) => (x.a + x.b < y.a + y.b ? -1 : 1));
}

/** Every pair of workspaces with moves in [since, t], including ones a single move made. */
export function highwayFor(highways: readonly Highway[], a: string, b: string): Highway | undefined {
  const [x, y] = a < b ? [a, b] : [b, a];
  return highways.find((h) => h.a === x && h.b === y);
}

/**
 * The notes an actor read up to `t` (since `since`), in the order it first
 * read them. "What an AI is reading" lists exactly these and nothing it only
 * passed by.
 */
export function readsAt(
  events: readonly MapEvent[],
  actorId: string,
  t: number,
  since = -Infinity,
): Array<{ workspaceId: string; path: string; at: number }> {
  const seen = new Set<string>();
  const out: Array<{ workspaceId: string; path: string; at: number }> = [];
  for (const e of [...events].sort(byTime)) {
    if (e.kind !== "read" || e.actor.id !== actorId || e.at > t || e.at < since) continue;
    const key = noteKey(e.workspaceId, e.path);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ workspaceId: e.workspaceId, path: e.path, at: e.at });
  }
  return out;
}

/** Each actor's steps, oldest first, from the events. */
export function stepsFromEvents(events: readonly MapEvent[]): Map<string, Step[]> {
  const out = new Map<string, Step[]>();
  for (const e of [...events].sort(byTime)) {
    const step = stepOf(e);
    const list = out.get(step.actorId);
    if (list) list.push(step);
    else out.set(step.actorId, [step]);
  }
  return out;
}

function stepOf(e: MapEvent): Step {
  const base = { actorId: e.actor.id, kind: e.actor.kind, name: e.actor.name, at: e.at };
  if (e.kind === "move") {
    const to = moveTarget(e);
    return { ...base, workspaceId: to.workspaceId, path: to.path, doing: "move", from: { workspaceId: e.workspaceId, path: e.from } };
  }
  return { ...base, workspaceId: e.workspaceId, path: e.path, doing: e.kind };
}

/**
 * Who was in the map at `t`, synthesised from the events for a replay: each
 * actor on the note of their last event, doing it, until they have been quiet
 * for `idleMs`. The sidebar's "Who was here" reads this too.
 */
export function actorsAt(events: readonly MapEvent[], t: number, idleMs: number): MapActor[] {
  const out: MapActor[] = [];
  for (const [id, steps] of stepsFromEvents(events)) {
    let last: Step | undefined;
    for (const s of steps) if (s.at <= t) last = s;
    if (!last || t - last.at > idleMs) continue;
    const actor: MapActor = {
      id,
      kind: last.kind,
      name: last.name,
      path: last.path,
      doing: last.doing,
      at: last.at,
      workspaceId: last.workspaceId,
    };
    if (last.kind === "agent") actor.reads = readsAt(events, id, t).map((r) => r.path);
    out.push(actor);
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : 1));
}

/** Marked moments for the replay bar: new notes, and the first move of a run of moves. */
export function momentsOf(events: readonly MapEvent[], title: (workspaceId: string, path: string) => string): Array<{ at: number; label: string }> {
  const out: Array<{ at: number; label: string }> = [];
  let lastMove = -Infinity;
  for (const e of [...events].sort(byTime)) {
    if (e.kind === "create") out.push({ at: e.at, label: `New note: ${title(e.workspaceId, e.path)}` });
    if (e.kind === "move") {
      if (e.at - lastMove > 10 * 60_000) out.push({ at: e.at, label: `${e.actor.name} moved notes` });
      lastMove = e.at;
    }
  }
  return out;
}

