import { isolateForDisplay } from "@context/shared/src/displayText.cjs";
import { fileTitle, folderLabel, noteKey, splitPath } from "./engine/paths";
import type { MapActor } from "./engine/timeline";
import type { ActorRef, MapEvent, WorkspaceGraph } from "./types";
import { clockText } from "./replayClock";

/**
 * The words beside the map: "Maya is reading **Pricing**", "Inbox sorter moved
 * **Receipt from Figma** to Areas", "Seyi moved **Call with Dana** to Supa ›
 * Projects". Plain language, a person's or tool's name first, the note's name
 * in bold, and where a move went in the words a person uses for a folder.
 *
 * Pure: the panel, the phone's sheet and the tests all build their lines here.
 */

/** One run of a line; `strong` is the note's name. */
export type FeedPart = { text: string; strong?: boolean };

export type FeedItem = {
  key: string;
  actor: ActorRef;
  /** Happening at this moment (live), or the actor's latest step (replay). */
  now: boolean;
  at: number;
  parts: FeedPart[];
  workspaceId: string;
  /** The note the line is about, where it is now. */
  path: string;
};

/** How the lines name notes, folders and workspaces. */
export type NameBook = {
  title(workspaceId: string, path: string): string;
  /** The graph's own name for a note, or `null` when no graph on the map holds it. */
  known(workspaceId: string, path: string): string | null;
  workspace(workspaceId: string): string;
};

/**
 * Names from the graphs on the map, falling back to the file name. Every name
 * came out of somebody's bucket, so each is isolated for display: a U+202E in
 * one file name must not reverse the rest of the line it is drawn in.
 */
export function nameBook(graphs: readonly WorkspaceGraph[]): NameBook {
  const titles = new Map<string, string>();
  const names = new Map<string, string>();
  for (const g of graphs) {
    names.set(g.workspaceId, g.name);
    for (const n of g.nodes) titles.set(noteKey(g.workspaceId, n.path), n.title);
  }
  return {
    title: (ws, path) => isolateForDisplay(titles.get(noteKey(ws, path)) ?? fileTitle(path)),
    known: (ws, path) => {
      const title = titles.get(noteKey(ws, path));
      return title === undefined ? null : isolateForDisplay(title);
    },
    workspace: (ws) => isolateForDisplay(names.get(ws) ?? "another workspace"),
  };
}

/** "Areas", "Projects", or "the top level" for a note outside every folder. */
export function folderWords(path: string): string {
  const { root } = splitPath(path);
  return root === "" ? "the top level" : isolateForDisplay(folderLabel(root));
}

/** Where a move landed, in words: "Areas", or "Supa › Projects" across workspaces. */
export function moveDestination(e: Extract<MapEvent, { kind: "move" }>, book: NameBook): string {
  if (!e.toWorkspaceId || e.toWorkspaceId === e.workspaceId) return folderWords(e.to);
  const { root } = splitPath(e.to);
  const ws = book.workspace(e.toWorkspaceId);
  return root === "" ? ws : `${ws} › ${isolateForDisplay(folderLabel(root))}`;
}

const strong = (text: string): FeedPart => ({ text, strong: true });

/** The words after the name for one event, as happening now or as done. */
export function eventParts(e: MapEvent, now: boolean, book: NameBook): FeedPart[] {
  if (e.kind === "move") {
    const ws = e.toWorkspaceId ?? e.workspaceId;
    // A note keeps its name across a move, whichever end the map knows it by.
    const title = book.known(ws, e.to) ?? book.known(e.workspaceId, e.from) ?? book.title(ws, e.to);
    return [{ text: now ? "is moving " : "moved " }, strong(title), { text: ` to ${moveDestination(e, book)}` }];
  }
  const title = book.title(e.workspaceId, e.path);
  if (e.kind === "read") return [{ text: now ? "is reading " : "read " }, strong(title)];
  if (e.kind === "edit") return [{ text: now ? "is editing " : "edited " }, strong(title)];
  return [{ text: now ? "is writing a new note, " : "wrote a new note, " }, strong(title)];
}

/** A whole line as one string, for a label or a test. */
export function sentence(item: Pick<FeedItem, "actor" | "parts">): string {
  return `${isolateForDisplay(item.actor.name)} ${item.parts.map((p) => p.text).join("")}`;
}

const eventPath = (e: MapEvent): { workspaceId: string; path: string } =>
  e.kind === "move" ? { workspaceId: e.toWorkspaceId ?? e.workspaceId, path: e.to } : { workspaceId: e.workspaceId, path: e.path };

const eventKey = (e: MapEvent): string => {
  const at = eventPath(e);
  return `${e.kind}|${e.at}|${e.actor.id}|${at.workspaceId}|${at.path}`;
};

/**
 * How long a tool's latest step reads as happening now. The gateway learns
 * about a tool only from finished calls, so "is reading" is a claim about the
 * last minute and no longer; after it, the line says what it did.
 */
export const AGENT_NOW_MS = 60_000;

/**
 * The live feed: what everyone is doing now, then what they did, newest first.
 * A step that is still happening is said once, in the present tense.
 */
export function liveFeed(options: {
  actors: readonly MapActor[];
  events: readonly MapEvent[];
  now: number;
  book: NameBook;
  limit?: number;
  /** The viewer's own id: their own lines are left out of a feed about everyone else. */
  selfId?: string | null;
}): FeedItem[] {
  const { actors, events, now, book, limit = 8, selfId = null } = options;
  const items: FeedItem[] = [];
  const current = new Set<string>();
  for (const a of actors) {
    if (a.path === null || a.doing === "idle" || a.id === selfId) continue;
    if (a.kind === "agent" && now - a.at > AGENT_NOW_MS) continue;
    const ws = a.workspaceId ?? "";
    const actor: ActorRef = { id: a.id, kind: a.kind, name: a.name };
    const step: MapEvent =
      a.doing === "move"
        ? { kind: "move", at: a.at, workspaceId: ws, from: a.path, to: a.path, actor }
        : { kind: a.doing, at: a.at, workspaceId: ws, path: a.path, actor };
    current.add(`${a.id}|${a.doing}|${ws}|${a.path}`);
    items.push({ key: `now|${a.id}|${ws}`, actor, now: true, at: a.at, parts: eventParts(step, true, book), workspaceId: ws, path: a.path });
  }
  const said = new Set<string>();
  for (const e of [...events].sort((x, y) => y.at - x.at)) {
    if (e.actor.id === selfId) continue;
    const at = eventPath(e);
    const sig = `${e.actor.id}|${e.kind}|${at.workspaceId}|${at.path}`;
    // The newest step an actor is still on is already the present-tense line.
    if (current.has(sig) && !said.has(sig)) {
      said.add(sig);
      continue;
    }
    items.push({ key: eventKey(e), actor: e.actor, now: false, at: e.at, parts: eventParts(e, false, book), ...at });
  }
  return items.sort((x, y) => Number(y.now) - Number(x.now) || y.at - x.at).slice(0, limit);
}

/**
 * The feed of a replay at `t`: what had happened by then, newest first. Each
 * actor's latest step reads as happening if it began within `nowMs` of `t`.
 */
export function replayFeed(options: {
  events: readonly MapEvent[];
  t: number;
  book: NameBook;
  limit?: number;
  nowMs?: number;
}): FeedItem[] {
  const { events, t, book, limit = 8, nowMs = 2 * 60_000 } = options;
  const past = events.filter((e) => e.at <= t).sort((x, y) => y.at - x.at);
  const latest = new Set<string>();
  const items: FeedItem[] = [];
  for (const e of past) {
    const first = !latest.has(e.actor.id);
    latest.add(e.actor.id);
    const now = first && t - e.at < nowMs;
    items.push({ key: eventKey(e), actor: e.actor, now, at: e.at, parts: eventParts(e, now, book), ...eventPath(e) });
    if (items.length >= limit) break;
  }
  return items;
}

/** When a live line happened: "now", "just now", "4 min ago", "2 hr ago". */
export function whenText(item: Pick<FeedItem, "now" | "at">, now: number): string {
  if (item.now) return "now";
  const seconds = Math.max(0, Math.round((now - item.at) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.round(minutes / 60)} hr ago`;
}

/** When a replayed line happened: the clock time it happened at. */
export function replayWhen(item: Pick<FeedItem, "at">): string {
  return clockText(item.at);
}

/** "2 people, 4 AI tools", "1 person", "3 AI tools", or nobody. */
export function workingNowLine(actors: ReadonlyArray<{ id: string; kind: "person" | "agent" }>, replaying = false): string {
  const ids = new Map<string, "person" | "agent">();
  for (const a of actors) ids.set(a.id, a.kind);
  let people = 0;
  let tools = 0;
  for (const kind of ids.values()) {
    if (kind === "person") people += 1;
    else tools += 1;
  }
  const parts = [
    people === 0 ? null : `${people} ${people === 1 ? "person" : "people"}`,
    tools === 0 ? null : `${tools} AI ${tools === 1 ? "tool" : "tools"}`,
  ].filter((part): part is string => part !== null);
  if (parts.length > 0) return parts.join(", ");
  return replaying ? "Nobody was working here at this point" : "Nobody is working here right now";
}

/** One direction notes moved in between two workspaces, and how many. */
export type CrossMoveRow = { from: string; to: string; fromName: string; toName: string; count: number; lastAt: number };

/** Moves between workspaces in [since, t], one row per direction, busiest first. */
export function crossMoveRows(events: readonly MapEvent[], since: number, t: number, book: NameBook): CrossMoveRow[] {
  const rows = new Map<string, CrossMoveRow>();
  for (const e of events) {
    if (e.kind !== "move" || !e.toWorkspaceId || e.toWorkspaceId === e.workspaceId) continue;
    if (e.at < since || e.at > t) continue;
    const id = `${e.workspaceId}\n${e.toWorkspaceId}`;
    const row = rows.get(id) ?? {
      from: e.workspaceId,
      to: e.toWorkspaceId,
      fromName: book.workspace(e.workspaceId),
      toName: book.workspace(e.toWorkspaceId),
      count: 0,
      lastAt: -Infinity,
    };
    row.count += 1;
    row.lastAt = Math.max(row.lastAt, e.at);
    rows.set(id, row);
  }
  return [...rows.values()].sort((a, b) => b.count - a.count || b.lastAt - a.lastAt);
}
