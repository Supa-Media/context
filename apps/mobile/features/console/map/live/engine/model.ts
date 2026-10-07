import type { MapClock, MapEvent, MapScope, MapView, WorkspaceGraph } from "../types";
import { buildLayout, createLayoutCache, type Layout, type LayoutCache } from "./layout";
import type { MapPalette } from "./palette";
import type { Model } from "./scene";
import { byTime, historyPaths, stepsFromEvents, type MapActor, type Step } from "./timeline";

/**
 * Turning what the app hands the engine into the `Model` a frame is drawn
 * from. A replay's model is a pure function of its inputs. Live needs a little
 * memory, kept in `LiveMemory`: when each event and each change of what
 * somebody is doing was first seen, so an event that arrives a few seconds
 * late (polling) still animates when it shows up instead of having finished
 * before anyone saw it.
 */

/** What the app passes to `setData`. */
export type MapData = {
  graphs: WorkspaceGraph[];
  actors: MapActor[];
  events: MapEvent[];
  scope: MapScope;
  view: MapView;
  clock: MapClock;
  palette: MapPalette;
  selfId: string | null;
};

export type LiveMemory = {
  seen: Map<string, number>;
  steps: Map<string, Step[]>;
  started: boolean;
  layoutCache: LayoutCache;
  layout: Layout | null;
  layoutSig: string;
};

export const createMemory = (): LiveMemory => ({
  seen: new Map(),
  steps: new Map(),
  started: false,
  layoutCache: createLayoutCache(),
  layout: null,
  layoutSig: "",
});

const eventId = (e: MapEvent): string =>
  e.kind === "move" ? `m\n${e.at}\n${e.actor.id}\n${e.workspaceId}\n${e.from}\n${e.to}` : `${e.kind}\n${e.at}\n${e.actor.id}\n${e.workspaceId}\n${e.path}`;

/** The graphs the scope shows, in the order given. */
export function graphsInScope(graphs: readonly WorkspaceGraph[], scope: MapScope): WorkspaceGraph[] {
  return scope.kind === "all" ? [...graphs] : graphs.filter((g) => g.workspaceId === scope.workspaceId);
}

/** Events that touch a shown workspace. */
export function eventsInScope(events: readonly MapEvent[], ids: Set<string>): MapEvent[] {
  return events.filter((e) => ids.has(e.workspaceId) || (e.kind === "move" && !!e.toWorkspaceId && ids.has(e.toWorkspaceId)));
}

export function buildModel(
  data: MapData,
  memory: LiveMemory,
  now: number,
  options: { idleMs: number; reducedMotion: boolean; following: string | null },
): Model {
  const graphs = graphsInScope(data.graphs, data.scope);
  const ids = new Set(graphs.map((g) => g.workspaceId));
  const live = data.clock.kind === "live";
  let events = eventsInScope(data.events, ids);

  if (live) {
    // A late event animates from when it arrived; the first batch is history.
    events = events.map((e) => {
      const id = eventId(e);
      let seen = memory.seen.get(id);
      if (seen === undefined) {
        seen = memory.started ? Math.max(e.at, now) : e.at;
        memory.seen.set(id, seen);
      }
      return seen === e.at ? e : { ...e, at: seen };
    });
  }
  events.sort(byTime);

  const extra = historyPaths(events, data.graphs).filter((p) => ids.has(p.workspaceId));
  const sig = layoutSignature(graphs, extra);
  if (!memory.layout || sig !== memory.layoutSig) {
    memory.layout = buildLayout(graphs, extra, memory.layoutCache);
    memory.layoutSig = sig;
    if (memory.layoutCache.size > 4000) memory.layoutCache.clear();
  }

  const liveReads = new Map<string, Array<{ workspaceId: string; path: string }>>();
  let steps: Map<string, Step[]>;
  if (live) {
    steps = liveSteps(data.actors, graphs, memory, now);
    for (const a of data.actors) {
      if (!a.reads || a.reads.length === 0) continue;
      const ws = a.workspaceId ?? workspaceOf(a.path, graphs) ?? graphs[0]?.workspaceId;
      if (!ws) continue;
      const list = liveReads.get(a.id) ?? [];
      for (const path of a.reads) if (!list.some((r) => r.workspaceId === ws && r.path === path)) list.push({ workspaceId: ws, path });
      liveReads.set(a.id, list);
    }
  } else {
    steps = stepsFromEvents(events);
  }
  memory.started = true;

  return {
    graphs,
    layout: memory.layout,
    events,
    steps,
    scope: data.scope,
    view: data.view,
    live,
    speed: data.clock.kind === "replay" ? data.clock.speed : 1,
    selfId: data.selfId,
    liveReads,
    idleMs: data.clock.kind === "replay" && data.clock.idleMs !== undefined ? data.clock.idleMs : options.idleMs,
    reducedMotion: options.reducedMotion,
    following: options.following,
  };
}

function layoutSignature(graphs: readonly WorkspaceGraph[], extra: ReadonlyArray<{ workspaceId: string; path: string }>): string {
  const parts: string[] = [];
  for (const g of graphs) {
    parts.push(`${g.workspaceId}|${g.name}|${g.edges.length}`);
    for (const n of g.nodes) parts.push(`${n.path}|${n.title}`);
  }
  for (const e of extra) parts.push(`+${e.workspaceId}|${e.path}`);
  return parts.join("\n");
}

/** Which shown workspace has this path, when an actor did not say. */
function workspaceOf(path: string | null, graphs: readonly WorkspaceGraph[]): string | undefined {
  if (path === null) return undefined;
  return graphs.find((g) => g.nodes.some((n) => n.path === path))?.workspaceId;
}

/**
 * Live actors as steps: each time somebody's note or activity changes, a new
 * step stamped with when the engine saw it, so their face travels from the
 * last note to the new one. People who left are dropped.
 */
function liveSteps(actors: readonly MapActor[], graphs: readonly WorkspaceGraph[], memory: LiveMemory, now: number): Map<string, Step[]> {
  const present = new Set<string>();
  const shown = new Set(graphs.map((g) => g.workspaceId));
  for (const a of actors) {
    const ws = a.workspaceId ?? workspaceOf(a.path, graphs) ?? graphs[0]?.workspaceId;
    if (!ws || !shown.has(ws)) continue;
    present.add(a.id);
    const list = memory.steps.get(a.id) ?? [];
    const last = [...list].reverse().find((s) => s.workspaceId === ws);
    if (!last || last.path !== a.path || last.doing !== a.doing) {
      const step: Step = {
        actorId: a.id,
        kind: a.kind,
        name: a.name,
        workspaceId: ws,
        path: a.path,
        doing: a.doing,
        // The first sighting is where they already were: no travel.
        at: memory.started ? now : now - 600_000,
      };
      list.push(step);
      while (list.length > 8) list.shift();
      memory.steps.set(a.id, list);
    } else if (last.name !== a.name) {
      last.name = a.name;
    }
  }
  for (const id of [...memory.steps.keys()]) if (!present.has(id)) memory.steps.delete(id);
  return memory.steps;
}

