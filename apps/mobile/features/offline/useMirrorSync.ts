import { useCallback, useEffect, useMemo, useRef } from "react";
import { AppState } from "react-native";
import { currentEpoch } from "./epoch";
import { readIndex } from "./mirror";
import { neededEtags } from "./mirrorHolds";
import {
  UNAVAILABLE,
  mirrorStatuses,
  publishMirrorStatus,
  statusFromIndex,
} from "./mirrorStatus";
import { openMirrorStore } from "./mirrorStore";
import { syncAll, type BatchRead, type ManifestPage, type MirrorRun } from "./mirrorSync";
import { useReachability } from "./reachability";
import { openStore } from "./store";
import { visibilityTierForRole, type VisibilityTier } from "../console/visibility";

/**
 * When the mirror syncs, mounted once for the whole console.
 *
 * `mirrorSync.ts` decides what one sync does; this decides **when** and
 * **for which contexts**:
 *
 *  - **When:** on mount once the device says it is online, when it comes back
 *    online, when the app returns to the foreground, and every
 *    `MIRROR_INTERVAL_MS` while it stays there. Never while `offline`, and
 *    never on `unknown` either — unlike the queue's drain, which has a person's
 *    typing to deliver, a sync can wait the second it takes the platform to
 *    say, and starting one on a guess is minutes of Convex actions with no
 *    client-side timeout hanging on a socket that is not there.
 *  - **Single flight.** A trigger that lands while a pass is running marks one
 *    more pass to run after it rather than starting a second: two passes over
 *    one context would read every changed note twice on somebody's quota.
 *  - **For which:** the *live* context list and nothing else. A remembered
 *    list is a memory, not an answer (`useLiveConsoleData` makes the same
 *    refusal for the departed purge), and a sync is the thing that prunes.
 *    Each at the clearance `visibilityTierForRole` gives, which is the one
 *    place this app decides it; `unknown` is skipped by `syncContext`.
 *
 * Every Convex call is bounded by a timeout, because `action()` has none and
 * "online" can be wrong — a captive portal, a dead uplink. A timeout is a
 * failed page or batch, which `mirrorSync.ts` already treats as an
 * interrupted, unpruned run.
 */

/** Five minutes while the app is in front of somebody. */
export const MIRROR_INTERVAL_MS = 5 * 60 * 1000;
/** A manifest page is one walk of up to a thousand keys per store page. */
export const MANIFEST_TIMEOUT_MS = 60_000;
/** Fifty notes, up to four megabytes. */
export const READ_TIMEOUT_MS = 60_000;

export interface MirrorActions {
  syncManifest: (args: { workspaceId: string; cursor?: string }) => Promise<ManifestPage>;
  readNotes: (args: { workspaceId: string; paths: string[] }) => Promise<{ results: BatchRead[] }>;
}

/** A promise that rejects after `ms`, so a hung action becomes a failed one. */
export function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    work,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error("timed out")), ms);
    }),
  ]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
  });
}

export function useMirrorSync(options: {
  /** The live list only — `undefined` until it has landed. */
  contexts: readonly { workspaceId: string; role: string | undefined }[] | undefined;
  actions: MirrorActions;
  onSynced?: (runs: MirrorRun[]) => void;
}): void {
  const reachability = useReachability();
  const epochRef = useRef(currentEpoch());
  const kvRef = useRef<ReturnType<typeof openStore> | null>(null);
  if (kvRef.current === null) kvRef.current = openStore();

  const actionsRef = useRef(options.actions);
  actionsRef.current = options.actions;
  const onSyncedRef = useRef(options.onSynced);
  onSyncedRef.current = options.onSynced;

  /*
    Keyed by ids and roles, not by the array: the list's identity changes on
    every tick of any field on any row, and a rename is not a reason to walk
    somebody's bucket again.
  */
  const key = (options.contexts ?? [])
    .map((context) => `${context.workspaceId}:${visibilityTierForRole(context.role)}`)
    .join(",");
  const targets = useMemo<{ workspaceId: string; tier: VisibilityTier }[]>(
    () =>
      key === ""
        ? []
        : key.split(",").map((pair) => {
            const at = pair.lastIndexOf(":");
            return {
              workspaceId: pair.slice(0, at),
              tier: pair.slice(at + 1) as VisibilityTier,
            };
          }),
    [key],
  );
  const targetsRef = useRef(targets);
  targetsRef.current = targets;
  const reachabilityRef = useRef(reachability);
  reachabilityRef.current = reachability;

  const running = useRef(false);
  const again = useRef(false);

  /** Say what is already on the device, before and without any sync. */
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const store = await openMirrorStore();
      for (const target of targets) {
        if (cancelled || epochRef.current !== currentEpoch()) return;
        if (store === null) {
          publishMirrorStatus(target.workspaceId, UNAVAILABLE);
          continue;
        }
        if (target.tier === "unknown") continue;
        publishMirrorStatus(
          target.workspaceId,
          statusFromIndex(await readIndex(store, target.tier, target.workspaceId)),
        );
      }
    })().catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [targets]);

  const sync = useCallback(() => {
    if (reachabilityRef.current !== "online") return;
    if (targetsRef.current.length === 0) return;
    if (epochRef.current !== currentEpoch()) return;
    if (running.current) {
      again.current = true;
      return;
    }
    running.current = true;
    again.current = false;

    void (async () => {
      const store = await openMirrorStore();
      if (store === null) return;
      const epoch = epochRef.current;
      const mine = () => epoch === currentEpoch();
      const kv = kvRef.current!;
      const runs = await syncAll(
        {
          store,
          epoch,
          mine,
          now: () => Date.now(),
          needed: (workspaceId) => neededEtags(kv, workspaceId),
          manifest: (workspaceId, cursor) =>
            withTimeout(
              actionsRef.current.syncManifest({
                workspaceId,
                ...(cursor === undefined ? {} : { cursor }),
              }),
              MANIFEST_TIMEOUT_MS,
            ),
          readNotes: async (workspaceId, paths) =>
            (
              await withTimeout(
                actionsRef.current.readNotes({ workspaceId, paths }),
                READ_TIMEOUT_MS,
              )
            ).results,
          onProgress: (workspaceId, progress) => {
            if (!mine()) return;
            const before = mirrorStatuses().get(workspaceId);
            publishMirrorStatus(workspaceId, {
              bytes: before?.bytes ?? 0,
              lastSyncedAt: before?.lastSyncedAt ?? null,
              state: "syncing",
              notes: progress.done,
              remaining: progress.total - progress.done,
              total: progress.total,
            });
          },
        },
        targetsRef.current,
        // Each context's line settles as soon as its own run does, rather than
        // reading "Downloading…" until every other context has finished too.
        async (run) => {
          if (!mine()) return;
          publishMirrorStatus(
            run.workspaceId,
            statusFromIndex(await readIndex(store, run.scope, run.workspaceId)),
          );
        },
      );
      if (mine()) onSyncedRef.current?.(runs);
    })()
      .catch(() => {
        // `syncAll` does not throw; a store that does is a sync that did
        // nothing, and the next trigger tries again.
      })
      .finally(() => {
        running.current = false;
        if (again.current) {
          again.current = false;
          sync();
        }
      });
  }, []);

  // Mount, reconnection, and a change in which contexts there are.
  useEffect(() => {
    if (reachability === "online") sync();
  }, [reachability, sync, targets]);

  // Back to the foreground, and a modest interval while it stays there.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer === null) timer = setInterval(sync, MIRROR_INTERVAL_MS);
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    if (AppState.currentState !== "background") start();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") {
        start();
        sync();
      } else if (state === "background") {
        stop();
      }
    });
    return () => {
      stop();
      subscription.remove();
    };
  }, [sync]);
}
