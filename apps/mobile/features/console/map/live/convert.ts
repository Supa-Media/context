import type { ActivityEvent, AgentActivityView } from "../../agents/agentActivity";
import type { MapActor } from "./engine/timeline";
import type { ActorRef, MapEvent, MapNode, WorkspaceGraph } from "./types";

/**
 * The control plane's and the gateway's answers, as the engine's shapes
 * (`types.ts`). Every answer here is already filtered to what the viewer may
 * see; this only renames and drops what the map cannot draw.
 */

/** Who is in one workspace now, from its `/agent-activity` answer, as map actors. */
export function actorsFromActivity(view: AgentActivityView, workspaceId: string, now: number): MapActor[] {
  const out: MapActor[] = [];
  for (const agent of view.agents) {
    out.push({
      id: agent.id,
      kind: "agent",
      name: agent.name,
      ...(agent.self ? { self: true } : {}),
      path: agent.path,
      // An older gateway sends no `doing`: a write is then an edit.
      doing: agent.doing ?? (agent.kind === "read" ? "read" : "edit"),
      at: agent.at,
      reads: [...(agent.readPaths ?? [])],
      workspaceId,
    });
  }
  for (const person of view.people ?? []) {
    const path = person.path ?? null;
    out.push({
      id: person.id,
      kind: "person",
      name: person.name,
      ...(person.self ? { self: true } : {}),
      path,
      doing: path === null ? "idle" : (person.doing ?? "read"),
      // A person is counted while their console keeps asking: they are here now.
      at: now,
      workspaceId,
    });
  }
  return out;
}

/** One gateway event as a map event. A move with no `from` cannot be drawn. */
export function eventFromActivity(event: ActivityEvent, workspaceId: string): MapEvent | null {
  const actor: ActorRef = { id: event.actor.id, kind: event.actor.kind, name: event.actor.name };
  if (event.kind === "move") {
    if (!event.from) return null;
    return { kind: "move", at: event.at, workspaceId, from: event.from, to: event.to ?? event.path, actor };
  }
  return { kind: event.kind, at: event.at, workspaceId, path: event.path, actor };
}

export function eventsFromActivity(view: AgentActivityView, workspaceId: string): MapEvent[] {
  const out: MapEvent[] = [];
  for (const event of view.events ?? []) {
    const e = eventFromActivity(event, workspaceId);
    if (e !== null) out.push(e);
  }
  return out;
}

/** The newest event's time: the next poll's `since`. */
export function newestAt(events: readonly { at: number }[], since: number | null): number | null {
  let best = since;
  for (const e of events) if (best === null || e.at > best) best = e.at;
  return best;
}

/** The answer `files.workspaceGraph` gives (see `mapData.ts`). */
export type GraphAnswer = {
  nodes: ReadonlyArray<{ path: string; title: string }>;
  edges: ReadonlyArray<ReadonlyArray<number>>;
  truncated?: boolean;
  behind?: boolean;
  indexMissing?: boolean;
};

/** A workspace's graph, keeping only edges that join two nodes it holds. */
export function graphFromAnswer(
  answer: GraphAnswer,
  workspace: { id: string; slug: string; name: string; kind: string },
): WorkspaceGraph {
  const nodes: MapNode[] = answer.nodes.map((n) => ({ path: n.path, title: n.title }));
  const seen = new Set<string>();
  const edges: [number, number][] = [];
  for (const edge of answer.edges) {
    const [a, b] = edge;
    if (typeof a !== "number" || typeof b !== "number" || a === b) continue;
    if (a < 0 || b < 0 || a >= nodes.length || b >= nodes.length) continue;
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push([a, b]);
  }
  return {
    workspaceId: workspace.id,
    slug: workspace.slug,
    name: workspace.name,
    kind: workspace.kind === "shared" ? "shared" : "personal",
    nodes,
    edges,
    ...(answer.truncated ? { truncated: true } : {}),
  };
}

/** One line of `activity.md` as `files.listActivity` returns it. */
export type HistoryEntry = {
  at: string;
  kind: string;
  paths: readonly string[];
  by: string | null;
  via: string | null;
  /** `[from, to]` per note on a `moved` line, where the server sent them. */
  moves?: ReadonlyArray<ReadonlyArray<string>>;
};

/**
 * Who did a history line, named as the activity feed names it
 * (`actorLabel` in `activity.cjs`): "@seyi's Claude" for a tool, "@seyi" for a person.
 * The line names a tool only by its client, so the id is the words: two lines
 * by the same hand are the same face on the replay.
 */
export function historyActor(entry: Pick<HistoryEntry, "by" | "via">): ActorRef {
  const by = entry.by ?? null;
  const via = entry.via ?? null;
  if (via !== null) {
    const name = by === null ? via : `${by}'s ${via}`;
    return { id: `h:${by ?? ""}:${via}`, kind: "agent", name };
  }
  return { id: `h:${by ?? "someone"}`, kind: "person", name: by ?? "Someone" };
}

/**
 * A workspace's history as replay events. Reads are never recorded, so a
 * replay shows what was written, made and moved. A `moved` line with no pairs
 * (written before they existed) has nothing to fly and is left out rather than
 * guessed at.
 */
export function eventsFromHistory(entries: readonly HistoryEntry[], workspaceId: string): MapEvent[] {
  const out: MapEvent[] = [];
  for (const entry of entries) {
    const at = Date.parse(entry.at);
    if (!Number.isFinite(at)) continue;
    const actor = historyActor(entry);
    const notes = entry.paths.filter((path) => path.endsWith(".md"));
    if (entry.kind === "added") {
      for (const path of notes) out.push({ kind: "create", at, workspaceId, path, actor });
    } else if (entry.kind === "revised" || entry.kind === "meeting") {
      for (const path of notes) out.push({ kind: entry.kind === "meeting" ? "create" : "edit", at, workspaceId, path, actor });
    } else if (entry.kind === "moved" || entry.kind === "archived") {
      for (const pair of entry.moves ?? []) {
        const [from, to] = pair;
        if (typeof from !== "string" || typeof to !== "string" || !from.endsWith(".md") || !to.endsWith(".md")) continue;
        out.push({ kind: "move", at, workspaceId, from, to, actor });
      }
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

/** One move between two of the viewer's workspaces, as `workspaceMoves.list` returns it. */
export type CrossMove = {
  at: number;
  fromWorkspaceId: string;
  toWorkspaceId: string;
  fromPath: string;
  toPath: string;
  actorName: string | null;
  via: "console" | "agent";
};

export function eventsFromCrossMoves(moves: readonly CrossMove[]): MapEvent[] {
  return moves
    .map((m): MapEvent => {
      const name = m.actorName ?? "Someone";
      const actor: ActorRef =
        m.via === "agent"
          ? { id: `h:${name}:agent`, kind: "agent", name: `${name}'s AI tool` }
          : { id: `h:${name}`, kind: "person", name };
      return { kind: "move", at: m.at, workspaceId: m.fromWorkspaceId, from: m.fromPath, to: m.toPath, toWorkspaceId: m.toWorkspaceId, actor };
    })
    .sort((a, b) => a.at - b.at);
}

/** Events from several sources, each once, oldest first. */
export function mergeEvents(...lists: ReadonlyArray<readonly MapEvent[]>): MapEvent[] {
  const seen = new Set<string>();
  const out: MapEvent[] = [];
  for (const list of lists) {
    for (const e of list) {
      const key =
        e.kind === "move"
          ? `m|${e.at}|${e.actor.id}|${e.workspaceId}|${e.from}|${e.to}`
          : `${e.kind}|${e.at}|${e.actor.id}|${e.workspaceId}|${e.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(e);
    }
  }
  return out.sort((a, b) => a.at - b.at);
}
