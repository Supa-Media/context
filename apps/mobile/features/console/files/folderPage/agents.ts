/**
 * The agents a project can be owned by: a short list of names, kept as text.
 *
 * An agent owner is a word — `Claude`, `Codex`, `Cursor` — and, optionally,
 * whose it is: `@shay's Claude`. The list is not derived from connected
 * clients (their registered names are whatever their software said, and a
 * webhook is not somebody's agent); it is a line in a front note, the way a
 * folder's statuses are:
 *
 *     agents: Claude, Codex, Cursor
 *
 * A folder with no line uses the nearest folder above it that has one, and
 * with none at all the defaults, Claude and Codex. Adding an agent writes the
 * line where it lives: the front note that declared it or, while nothing has,
 * the projects folder's own, so every project under it offers the new name.
 *
 * Pure: no React, no storage. Decided by the owner, 2026-09-28; see "Agents
 * are a list the workspace writes" in `docs/decisions/folder-lists.md`.
 */

import { DEFAULT_AGENTS } from "@context/shared/src/agentOwners";
import { FRONT_NOTES } from "../../../../../mcp/src/lists/grammar.js";
import type { ListNote, PropertyValue } from "../listBlock/model";
import { NEW_FRONT_NOTE } from "./model";
export { agentName, agentOwner, agentShown, knownAgent, ownerNote, parseAgentOwner } from "../agentOwners";

export { DEFAULT_AGENTS };
/** The frontmatter key the list is kept under. */
export const AGENTS_KEY = "agents";

/** The agents that apply in a folder, and where the list is written down. */
export interface FolderAgents {
  readonly list: readonly string[];
  /** The front note that declares it; null for the defaults. */
  readonly note: string | null;
}

const fold = (text: string) => text.trim().toLowerCase();

function listOf(value: PropertyValue | undefined): string[] | null {
  const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : null;
  if (raw === null) return null;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    const name = typeof item === "string" ? item.trim() : "";
    if (name === "" || seen.has(fold(name))) continue;
    seen.add(fold(name));
    out.push(name);
  }
  return out;
}

export function folderAgents(folder: string, notes: readonly ListNote[]): FolderAgents {
  const byPath = new Map(notes.map((note) => [note.path, note]));
  let at = folder.replace(/^\/+|\/+$/g, "");
  while (at !== "") {
    const front = FRONT_NOTES.map((name) => byPath.get(`${at}/${name}`)).find((note) => note !== undefined);
    const list = front === undefined ? null : listOf(front.properties[AGENTS_KEY]);
    if (front !== undefined && list !== null && list.length > 0) return { list, note: front.path };
    at = at.includes("/") ? at.slice(0, at.lastIndexOf("/")) : "";
  }
  return { list: DEFAULT_AGENTS, note: null };
}

/**
 * Where a new list is written while none is declared: the front note of the
 * projects folder `folder` sits in (the outermost folder whose name says
 * "project"), else of `folder` itself. Null at the workspace root, which has
 * no front note of its own.
 */
export function agentsHome(folder: string, notes: readonly ListNote[]): { target: string; creates: boolean } | null {
  const parts = folder.replace(/^\/+|\/+$/g, "").split("/").filter((part) => part !== "");
  const at = parts.findIndex((part) => part.toLowerCase().includes("project"));
  const home = parts.slice(0, at === -1 ? parts.length : at + 1).join("/");
  if (home === "") return null;
  const paths = new Set(notes.map((note) => note.path));
  const existing = FRONT_NOTES.map((name) => `${home}/${name}`).find((path) => paths.has(path));
  return existing === undefined ? { target: `${home}/${NEW_FRONT_NOTE}`, creates: true } : { target: existing, creates: false };
}

/** `list` with `name` added, or the same list when it already holds it. */
export function withAgent(list: readonly string[], name: string): string[] {
  return list.some((agent) => fold(agent) === fold(name)) ? [...list] : [...list, name];
}
