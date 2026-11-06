/**
 * The last Tex page each chat showed, kept so coming back to it draws at once
 * (the owner, 2026-11-04: "make the hub page load fast ... instant
 * revisits"). The page draws what is here and reads again behind it; the
 * live feed corrects anything that changed.
 *
 * In memory only, like the folder pages' cache (`console/files/folderPage/
 * pageCache.ts`): a reload starts empty, and every clear of this device's
 * copy (signing out, leaving a workspace) forgets it (`offline/forget.ts`),
 * so nothing read under one session is drawn in the next.
 *
 * Tex's computer is never drawn from here: whether a browser is open is stale
 * within seconds, so its tile waits for a fresh answer.
 */

import type { Overview } from "./texPageTypes";

/** Chats kept, at most: one person's own and a few groups. */
const MAX_KEPT = 12;

const kept = new Map<string, Overview>();
const groups = new Map<string, string>();

const keyOf = (handle: string, chat: string) => `${handle}\n${chat}`;

/** The page `handle` last drew for `chat`, or null. */
export function keptOverview(handle: string, chat: string): Overview | null {
  return kept.get(keyOf(handle, chat)) ?? null;
}

export function keepOverview(handle: string, chat: string, overview: Overview): void {
  const key = keyOf(handle, chat);
  kept.delete(key);
  kept.set(key, overview);
  if (kept.size > MAX_KEPT) kept.delete(kept.keys().next().value as string);
}

/** The chat key a group address's words found last time, so a revisit skips the lookup. */
export function keptGroupKey(handle: string, words: string): string | null {
  return groups.get(keyOf(handle, words)) ?? null;
}

export function keepGroupKey(handle: string, words: string, key: string): void {
  groups.set(keyOf(handle, words), key);
  if (groups.size > MAX_KEPT) groups.delete(groups.keys().next().value as string);
}

/** Forget every kept page: beside every clear of this device's copy. */
export function forgetTexPages(): void {
  kept.clear();
  groups.clear();
}
