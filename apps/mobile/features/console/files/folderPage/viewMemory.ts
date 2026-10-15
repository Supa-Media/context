/**
 * Which view somebody last picked for a folder — List or Board — kept per
 * viewer, per workspace, per folder. It is never written to a note. A "files"
 * remembered from when Notes was a view of its own reads as nothing, so the
 * folder opens in List, which is what Notes became.
 *
 * A convenience and nothing more: it lives in this browser's storage where
 * there is one, and in memory for the session where there is not (a native
 * build, a private window, blocked site data). Every access is inside a
 * `try`, because the accessor itself can throw, and a page that cannot
 * remember simply opens in its default view.
 */

import type { FolderPageView } from "./model";

const PREFIX = "context.folderView";
const VIEWS: readonly FolderPageView[] = ["list", "board"];
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

/** For tests: forget everything held in memory. */
export function forgetViews(): void {
  memory.clear();
}
