/**
 * Which areas somebody has unfolded (or folded) on the Areas page, kept per
 * viewer, per workspace, per open folder and per view, List and Chart each
 * their own (the owner, 2026-11-26: "when I open the different areas, it
 * should persist per user please, dont want to have to keep reopening, same
 * for the chart view"). It is never written to a note.
 *
 * What is kept is the set of folders pressed away from the view's default,
 * so a default that changes later still applies to everything not pressed.
 * Like `viewMemory.ts`, a convenience and nothing more: it lives in this
 * browser's storage where there is one and in memory for the session where
 * there is not, and every access is inside a `try`.
 */

import { useCallback, useEffect, useState } from "react";

const PREFIX = "context.areaFolds";
const memory = new Map<string, readonly string[]>();

export type FoldView = "list" | "chart";

/** Whose folds and which page: the workspace and the open folder. */
export interface FoldHome {
  readonly workspaceId: string;
  readonly folder: string;
}

export interface FoldPlace {
  readonly workspaceId: string;
  readonly folder: string;
  readonly view: FoldView;
}

function keyOf(place: FoldPlace): string {
  return `${PREFIX}\u001f${place.workspaceId}\u001f${place.folder}\u001f${place.view}`;
}

function storage(): Storage | null {
  try {
    return (globalThis as { localStorage?: Storage }).localStorage ?? null;
  } catch {
    return null;
  }
}

export function rememberedFolds(place: FoldPlace): ReadonlySet<string> {
  const key = keyOf(place);
  const held = memory.get(key);
  if (held !== undefined) return new Set(held);
  try {
    const stored = storage()?.getItem(key);
    if (stored === null || stored === undefined) return new Set();
    const parsed: unknown = JSON.parse(stored);
    return new Set(Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []);
  } catch {
    return new Set();
  }
}

export function rememberFolds(place: FoldPlace, folds: ReadonlySet<string>): void {
  const key = keyOf(place);
  const list = [...folds].sort();
  memory.set(key, list);
  try {
    if (list.length === 0) storage()?.removeItem(key);
    else storage()?.setItem(key, JSON.stringify(list));
  } catch {
    // Remembered for this session only.
  }
}

/** For tests: forget everything held in memory. */
export function forgetFolds(): void {
  memory.clear();
}

/**
 * The folders pressed away from their default, and the press that flips one.
 * With no place (no workspace known) it is held only while the page is open.
 */
export function useFolds(place: FoldPlace | undefined): readonly [ReadonlySet<string>, (folder: string) => void] {
  const workspaceId = place?.workspaceId;
  const folder = place?.folder;
  const view = place?.view;
  const [folds, setFolds] = useState<ReadonlySet<string>>(() => (place === undefined ? new Set() : rememberedFolds(place)));
  // Another folder or view opened in the same page: read what was kept for it.
  useEffect(() => {
    if (workspaceId === undefined || folder === undefined || view === undefined) return;
    setFolds(rememberedFolds({ workspaceId, folder, view }));
  }, [workspaceId, folder, view]);
  const toggle = useCallback(
    (key: string) =>
      setFolds((previous) => {
        const next = new Set(previous);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        if (workspaceId !== undefined && folder !== undefined && view !== undefined) rememberFolds({ workspaceId, folder, view }, next);
        return next;
      }),
    [workspaceId, folder, view],
  );
  return [folds, toggle] as const;
}
