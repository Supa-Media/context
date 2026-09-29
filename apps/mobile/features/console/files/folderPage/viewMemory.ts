/**
 * Which view somebody last picked for a folder — Notes, List or Board — and
 * what its List's filter bar has ticked (`showFilter.ts`), kept per viewer, per
 * workspace, per folder. Neither is ever written to a note.
 *
 * A convenience and nothing more: it lives in this browser's storage where
 * there is one, and in memory for the session where there is not (a native
 * build, a private window, blocked site data). Every access is inside a
 * `try`, because the accessor itself can throw, and a page that cannot
 * remember simply opens in its default view.
 */

import type { FolderPageView } from "./model";
import { parseShowFilter, showFilterKey, type ShowFilter } from "./showFilter";

const PREFIX = "context.folderView";
const VIEWS: readonly FolderPageView[] = ["files", "list", "board"];
const memory = new Map<string, FolderPageView>();

function keyOf(workspaceId: string, folder: string): string {
  return `${PREFIX}\u001f${workspaceId}\u001f${folder}`;
}

function storage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

export function rememberedView(workspaceId: string, folder: string): FolderPageView | null {
  const key = keyOf(workspaceId, folder);
  const held = memory.get(key);
  if (held !== undefined) return held;
  try {
    const stored = storage()?.getItem(key);
    return VIEWS.find((view) => view === stored) ?? null;
  } catch {
    return null;
  }
}

export function rememberView(workspaceId: string, folder: string, view: FolderPageView): void {
  const key = keyOf(workspaceId, folder);
  memory.set(key, view);
  try {
    storage()?.setItem(key, view);
  } catch {
    // Remembered for this session only.
  }
}

const filters = new Map<string, ShowFilter>();

/** The List's filter this viewer last ticked here, without its search; null for none. */
export function rememberedFilter(workspaceId: string, folder: string): ShowFilter | null {
  const key = `${keyOf(workspaceId, folder)}\u001ffilter`;
  const held = filters.get(key);
  if (held !== undefined) return held;
  try {
    return parseShowFilter(storage()?.getItem(key));
  } catch {
    return null;
  }
}

export function rememberFilter(workspaceId: string, folder: string, filter: ShowFilter): void {
  const key = `${keyOf(workspaceId, folder)}\u001ffilter`;
  filters.set(key, filter);
  try {
    storage()?.setItem(key, showFilterKey(filter));
  } catch {
    // Remembered for this session only.
  }
}

const dismissed = new Set<string>();

/** Whether this viewer closed the "track these by status?" line on this folder. */
export function nudgeDismissed(workspaceId: string, folder: string): boolean {
  const key = `${keyOf(workspaceId, folder)}\u001fnudge`;
  if (dismissed.has(key)) return true;
  try {
    return storage()?.getItem(key) === "1";
  } catch {
    return false;
  }
}

export function dismissNudge(workspaceId: string, folder: string): void {
  const key = `${keyOf(workspaceId, folder)}\u001fnudge`;
  dismissed.add(key);
  try {
    storage()?.setItem(key, "1");
  } catch {
    // Dismissed for this session only.
  }
}

/** Where this device keeps "no" to the track nudge for a whole workspace. */
export function trackNudgeKey(workspaceId: string): string {
  return `context.lc.track-nudge.dismissed.v1.${workspaceId}`;
}

/** For tests: forget everything held in memory. */
export function forgetViews(): void {
  memory.clear();
  filters.clear();
  dismissed.clear();
}
