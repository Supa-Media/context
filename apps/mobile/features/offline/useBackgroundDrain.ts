import { useCallback, useEffect, useRef } from "react";
import { drainOtherContexts, type BackgroundDrainReport, type DrainAllDeps } from "./drainAll";
import { currentEpoch } from "./epoch";
import { useReachability } from "./reachability";
import { openStore } from "./store";
import { moveMirroredBody } from "./mirror";
import { neededEtags } from "./mirrorHolds";
import { openMirrorStore } from "./mirrorStore";

/**
 * One pass over every context's queue except the open one, on reconnection.
 *
 * The companion to `useOfflineNotes`'s own drain rather than a replacement for
 * it: that one owns the live queue of the context on screen, this one owns
 * every queue that has no live copy. `drainAll.ts` carries the argument for the
 * split and for why the boundary is exactly there.
 *
 * ## Why it is a hook and not a call inside the other one
 *
 * `useOfflineNotes` is instantiated per open context and its whole surface is
 * about that context — the outbox it returns, the counts the strip renders, the
 * drain report the editor reads. Putting a device-wide pass inside it would
 * mean the object describing one context also quietly acted on four others, and
 * the first person to mount it twice would drain everything twice.
 *
 * So it is mounted once, by `useLiveConsoleData`, beside the purge that already
 * runs there for the same kind of reason.
 *
 * ## Once per reconnection, and never twice at once
 *
 * The effect fires when reachability becomes anything other than `offline`,
 * which is the same trigger the foreground drain uses. A pass can take a long
 * time — four contexts' queues, sequentially, each entry a round trip — so a
 * second one starting while the first is still going would send the same
 * entries twice from two snapshots of the same queue. `running` is the guard,
 * and it is a ref rather than state because it must not cause a render and must
 * be readable by a callback that outlived the render that made it.
 */
export function useBackgroundDrain(options: {
  /** The context the console is showing, whose live queue it drains itself. */
  openWorkspaceId: string | null;
  write: DrainAllDeps["write"];
  /** For a caller that wants to say something about what a pass did. */
  onDrained?: (reports: BackgroundDrainReport[]) => void;
}): void {
  const reachability = useReachability();

  const storeRef = useRef<ReturnType<typeof openStore> | null>(null);
  if (storeRef.current === null) storeRef.current = openStore();
  const store = storeRef.current;

  const epochRef = useRef(currentEpoch());
  const mine = useCallback(() => epochRef.current === currentEpoch(), []);

  /*
    The injected write and the notification go through refs, not the dependency
    array. A pass runs seconds after the reconnection that started it, and
    `sendQueuedTo` is rebuilt whenever the console's mutation handle changes —
    depending on it directly would re-fire this effect mid-pass, which is the
    one thing `running` then has to stop. Same arrangement, same reason, as
    `useOfflineNotes`.
  */
  const writeRef = useRef(options.write);
  writeRef.current = options.write;
  /*
    The open context goes through a ref too, and that is a behavioural decision
    rather than a tidy-up.

    In the dependency array it would re-fire this effect on every context
    *switch*, and a switch is the one moment the queue of the context being left
    has no live owner and a persisted copy that trails it by up to
    `PERSIST_DEBOUNCE_MS`. A pass starting there reads that stale record, sends
    from it, and writes it back — and the unmounting hook's debounced persist
    then lands on top with the pre-drain queue, so the same entries go again on
    the next reconnection, to be settled or conflicted. No typing is lost and
    it is pure churn against somebody's request quota.

    Through a ref, the rule is the one this file's header states: **one pass per
    reconnection**, reading whichever context is open at the moment it runs.
    Nothing is left behind by that — while the app is online, the context on
    screen drains its own queue as it goes, so a queue only accumulates while
    offline, and coming back online is exactly what fires this.
  */
  const openRef = useRef(options.openWorkspaceId);
  openRef.current = options.openWorkspaceId;
  const onDrainedRef = useRef(options.onDrained);
  onDrainedRef.current = options.onDrained;

  const running = useRef(false);

  useEffect(() => {
    if (reachability === "offline") return;
    if (running.current) return;
    running.current = true;

    void drainOtherContexts(store, openRef.current, {
      write: (workspaceId, write) => writeRef.current(workspaceId, write),
      now: () => Date.now(),
      mine,
      onSent: (workspaceId, body) => {
        if (!mine()) return;
        const epoch = epochRef.current;
        void (async () => {
          const mirror = await openMirrorStore();
          if (mirror === null) return;
          const needed = await neededEtags(store, workspaceId);
          if (!mine()) return;
          await moveMirroredBody(mirror, epoch, workspaceId, body, needed, Date.now());
        })().catch(() => {});
      },
    })
      .then((reports) => {
        if (reports.length > 0 && mine()) onDrainedRef.current?.(reports);
      })
      .catch(() => {
        // `drainOtherContexts` does not throw; an injected `write` that rejects
        // rather than resolving an outcome would land here. Every queue is left
        // as it was, so the next reconnection tries again.
      })
      .finally(() => {
        running.current = false;
      });
  }, [mine, reachability, store]);
}
