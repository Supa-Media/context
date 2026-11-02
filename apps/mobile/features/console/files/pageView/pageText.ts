import { useSyncExternalStore } from "react";

/**
 * Whether the open `.page.md` note is shown as its text rather than as the
 * page: the ••• sheet's "Edit as text" row sets it, the note screen reads it.
 *
 * A page opens as nothing but the page (owner, 2026-10-27: "it shouldn't have
 * all this chrome around it ... no properties, no floating buttons, nothing
 * but the page please, maybe 1 menu to hide actions"), so the "Page | Text"
 * switch that sat over it moved into that one menu. The sheet and the editor
 * are two components apart with no props between them, so this is
 * `readMode.ts`'s shape: a module both import, one value, no replay. It is
 * keyed by path, so opening another note shows it as its page again.
 */

let textPath: string | null = null;
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Show `path` as text (`true`) or as its page (`false`). */
export function setPageAsText(path: string, asText: boolean): void {
  const next = asText ? path : textPath === path ? null : textPath;
  if (next === textPath) return;
  textPath = next;
  for (const listener of listeners) listener();
}

/** Whether `path` is being shown as text. */
export function pageAsText(path: string | null | undefined): boolean {
  return path != null && textPath === path;
}

export function usePageAsText(path: string | null | undefined): boolean {
  return useSyncExternalStore(subscribe, () => pageAsText(path), () => false);
}
