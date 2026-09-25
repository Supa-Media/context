import { useCallback, useEffect, useSyncExternalStore } from "react";
import { openStore } from "../offline/store";
import type { SetupAgent } from "./guides";
import { decodeProgress, encodeProgress, progressKey, type SetupProgress } from "./progress";

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

/** For tests: forget every cached record. */
export function resetSetupProgressCache() {
  cache.clear();
  loading.clear();
}
