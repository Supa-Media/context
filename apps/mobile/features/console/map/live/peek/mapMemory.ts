import type { Cam } from "../engine/camera";
import type { PeekNote } from "./peekModel";

/**
 * Where you were on the map, for coming back to it.
 *
 * Opening a note from the card leaves the map, and the map page unmounts
 * with its engine. Back then has to find the map as it was: the same camera,
 * and the card still open on the note you expanded. Kept for the session in
 * memory, per workspace and scope, the way `graphCache.ts` keeps the graphs:
 * nothing here is worth a reload, and nothing is written to the device.
 */
export type MapMemory = { cam: Cam | null; peek: PeekNote | null };

const memory = new Map<string, MapMemory>();
/** Which scope (this workspace, or all of them) the map was last on, per workspace. */
const scopes = new Map<string, "one" | "all">();

export function recallScope(workspaceId: string | null): "one" | "all" {
  return scopes.get(workspaceId ?? "") ?? "one";
}

export function rememberScope(workspaceId: string | null, scope: "one" | "all"): void {
  scopes.set(workspaceId ?? "", scope);
}

export function mapMemoryKey(workspaceId: string | null, scope: "one" | "all"): string {
  return `${scope}|${workspaceId ?? ""}`;
}

export function recallMap(key: string): MapMemory {
  return memory.get(key) ?? { cam: null, peek: null };
}

export function rememberCamera(key: string, cam: Cam): void {
  memory.set(key, { ...recallMap(key), cam });
}

export function rememberPeek(key: string, peek: PeekNote | null): void {
  memory.set(key, { ...recallMap(key), peek });
}

/** For tests, and a session ending. */
export function forgetMapMemory(): void {
  memory.clear();
  scopes.clear();
}
