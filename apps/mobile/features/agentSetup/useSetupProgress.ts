import { useCallback, useEffect, useSyncExternalStore } from "react";
import type { KeyValueStore } from "../offline/memory";
import { openStore } from "../offline/store";
import type { SetupAgent } from "./guides";
import {
  decodeProgress,
  encodeProgress,
  progressKey,
  setupKeys,
  setupKeysForWorkspace,
  type SetupProgress,
} from "./progress";

/**
 * Saved progress, shared by everything on screen that shows it.
 *
 * The widget's tiles and the guide over them are two components reading one
 * record, and a step taken in the guide has to show on the tile the moment the
 * guide closes. One cache per key with listeners, filled from the device
 * store once, written through on every change.
 */
const cache = new Map<string, SetupProgress>();
const listeners = new Map<string, Set<() => void>>();
const loading = new Set<string>();

function notify(key: string) {
  for (const listener of listeners.get(key) ?? []) listener();
}

function load(key: string, agent: SetupAgent) {
  if (cache.has(key) || loading.has(key)) return;
  loading.add(key);
  void openStore()
    .get(key)
    .catch(() => null)
    .then((raw) => {
      loading.delete(key);
      // A write that raced the read wins: it is newer than anything stored.
      if (!cache.has(key)) cache.set(key, decodeProgress(agent, raw));
      notify(key);
    });
}

function subscribe(key: string, listener: () => void) {
  let set = listeners.get(key);
  if (set === undefined) listeners.set(key, (set = new Set()));
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

/** `undefined` until the device answers, so a tile never flashes "Set up" at somebody halfway through. */
export function useSetupProgress(
  workspaceId: string | null,
  agent: SetupAgent,
): [SetupProgress | undefined, (change: (current: SetupProgress) => SetupProgress) => void] {
  const key = workspaceId === null ? null : progressKey(workspaceId, agent);
  useEffect(() => {
    if (key !== null) load(key, agent);
  }, [key, agent]);
  const progress = useSyncExternalStore(
    useCallback((listener: () => void) => (key === null ? () => {} : subscribe(key, listener)), [key]),
    () => (key === null ? undefined : cache.get(key)),
    () => (key === null ? undefined : cache.get(key)),
  );
  const update = useCallback(
    (change: (current: SetupProgress) => SetupProgress) => {
      if (key === null) return;
      const next = change(cache.get(key) ?? decodeProgress(agent, null));
      cache.set(key, next);
      notify(key);
      void openStore()
        .set(key, encodeProgress(next))
        .catch(() => {
          // Kept for this session; a restart starts the guide again, which
          // loses a step, never a note.
        });
    },
    [key, agent],
  );
  return [progress, update];
}

/**
 * Forget every record this module holds on the device, and in this process.
 *
 * Called from sign-out beside the offline copies and the last place, for the
 * same reason those two are there rather than left to `ownedKeys`: `written`
 * is a list of **note paths**, and a path is the name of one of somebody's
 * notes. The next person to sign in on this machine is a member of the same
 * contexts often enough for that to matter, and `bringView` renders the list
 * from this record alone, before any fresh activity is fetched.
 *
 * The in-memory half goes too. It outlives a sign-out inside one running app,
 * and a `useSetupProgress` mounted after one would be served the previous
 * session's paths out of the cache without the device ever being read.
 */
export async function forgetSetupProgress(store: KeyValueStore): Promise<void> {
  resetSetupProgressCache();
  for (const key of setupKeys(await store.keys())) await store.remove(key);
}

/**
 * The same, for one context somebody left.
 *
 * Only that context's records, in memory as well as on the device — clearing
 * the whole cache here would make every other context's tile re-read before it
 * could draw. **Only this version's keys**, unlike sign-out: a stale-version
 * record cannot be attributed to a workspace at all, and taking every one of
 * them would delete the guide progress of contexts the person still has. The
 * residual is that a stale record survives a leave until the next sign-out,
 * which does take them all.
 */
export async function forgetSetupProgressFor(
  store: KeyValueStore,
  workspaceId: string,
): Promise<void> {
  for (const key of setupKeysForWorkspace([...cache.keys()], workspaceId)) {
    cache.delete(key);
    loading.delete(key);
  }
  for (const key of setupKeysForWorkspace(await store.keys(), workspaceId)) {
    await store.remove(key);
  }
}

/** Forget every cached record, without touching the device. */
export function resetSetupProgressCache() {
  cache.clear();
  loading.clear();
}
