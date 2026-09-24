import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cachedNoteCopies,
  getNote,
  getOutbox,
  putNote,
  putOutbox,
  retireCopies,
  sweep,
  type Draft,
} from "./cache";
import { openStore } from "./store";
import { currentEpoch } from "./epoch";
import {
  adoptCachedNotes,
  forgetMirroredNote,
  mirroredNote,
  moveMirroredBody,
  putMirroredNotes,
} from "./mirror";
import { holdAncestors, neededEtags, releaseAncestors } from "./mirrorHolds";
import { openMirrorStore } from "./mirrorStore";
import type { KeyValueStore } from "./memory";
import {
  emptyOutbox,
  isEmpty,
  localPathOf,
  opsOf,
  type Outbox,
  type PendingOp,
  type PendingWrite,
} from "./outbox";
import { drainOutbox, type DrainReport, type OpOutcome, type OpSent, type WriteOutcome } from "./sync";
import { collaborationOwnedPaths } from "./collaborationOwnership";
import { useReachability } from "./reachability";
import type { CacheScope } from "./keys";
import type { VisibilityTier } from "../console/visibility";
import type { OpenNote, Visibility } from "../console/files/types";
import { PERSIST_DEBOUNCE_MS, type OfflineNotes } from "./offlineNotes/contract";
import { newOpId, reconcile } from "./offlineNotes/reconcile";
import { buildOfflineNotesApi } from "./offlineNotes/api";

/**
 * The offline layer, as one object the file browser can hold.
 *
 * Everything interesting is in the pure modules beside this one and is tested
 * without a renderer. This is the wiring: it owns the store, hydrates the queue
 * for the context you are in, keeps the queue mirrored to the store, and runs a
 * drain when the connection comes back.
 *
 * ## Why the queue lives in React state *and* in the store
 *
 * The store is the record; the state is what the console renders from. Writing
 * only to the store would mean a read on every render, and holding only state
 * would mean the queue dies with the tab — which is the bug. They are kept in
 * step in one place (`commit`), so there is no path that updates one without
 * the other.
 *
 * ## Why writing it down is debounced and settling it is not
 *
 * Every keystroke updates the in-memory queue, because that costs nothing and
 * the console has to draw from it. Persisting on every keystroke would be a
 * `JSON.stringify` of the whole queue into `localStorage` per character. So the
 * write down is trailing-debounced by `PERSIST_DEBOUNCE_MS`, which bounds what
 * a crash costs to a second of typing — and anything that *removes* work from
 * the queue (a drain settling, a person discarding) is written through
 * immediately, because the failure mode there is resurrection: an entry that
 * was sent successfully coming back after a reload and being sent again.
 *
 * ## Why every write is gated on the session epoch
 *
 * Everything this hook writes is fire-and-forget over an async store, and the
 * reads that feed it are Convex actions with no client-side timeout — so a
 * write can land arbitrarily long after the press that ended the session, and
 * neither sign-out nor unmount cancels one. `forgetLocalCopies` bumps
 * `epoch.ts` before it clears; this mount captured its number once, and every
 * writer below drops its write when the two no longer agree. Without that the
 * clear is a point-in-time `remove()` loop with an open window behind it, and
 * the measured result is a private note body back on the device after sign-out.
 * See `epoch.ts` for the whole argument, including why it re-arms by itself.
 *
 * ## Why the clearance is an input rather than something this hook derives
 *
 * A cached note is a copy of a *filtered* answer, so the clearance it was read
 * at belongs in its key — `keys.ts` argues that at length. The tier itself is
 * decided in exactly one place in this app (`visibilityTierForRole`, pinned
 * against the control plane's `scopeForRole` by
 * `__tests__/consoleVisibility.test.ts`) and is passed down from the console,
 * because a second derivation here would be a second answer that can disagree
 * with the one on screen — and the direction that disagreement fails is "the
 * device serves more than the person allowed".
 *
 * `unknown` — the moment before the context list lands, or a role a newer
 * control plane invented — writes nothing and reads nothing. Only the two
 * *copies* are gated on it: a draft and the queue are the person's own typing,
 * carry no clearance, and must keep working while the console is still finding
 * out what this person is.
 *
 * ## Where a copy comes from: the mirror, or the bounded cache
 *
 * On a device with a mirror (`mirrorStore.ts` — every native build, and every
 * browser that lets IndexedDB open) a note and a folder listing are read from
 * it and written to it, and the per-note cache in `cache.ts` is retired: its
 * copies are handed to the mirror once, on mount, and removed. The mirror
 * answers the same question for every note rather than for the ones somebody
 * opened, and is re-derived from the server's own filter on every complete
 * sync, which the bounded cache never was. On a browser with no mirror the
 * bounded cache is still the answer, unchanged — so both halves stay, and each
 * `remember*`/`cached*` below picks one per call rather than writing both.
 *
 * The draft and the queue are in `cache.ts` on every device, mirror or not.
 * They are the person's typing, not copies, and nothing about the mirror
 * touches them.
 */

export { PERSIST_DEBOUNCE_MS, type OfflineNotes, type QueuedOp } from "./offlineNotes/contract";
export { reconcile } from "./offlineNotes/reconcile";

export function useOfflineNotes(options: {
  workspaceId: string | null;
  /**
   * How much of this context the person at the keyboard can see.
   *
   * From `visibilityTierForRole`, never re-derived here. `unknown` turns the
   * note and listing cache off — see the file comment.
   */
  tier: VisibilityTier;
  /** Performs one queued write against the control plane. */
  write: (write: PendingWrite) => Promise<WriteOutcome>;
  /** Keep legacy full-file writes parked while durable collaboration owns a note. */
  shouldWrite?: (write: PendingWrite) => boolean;
  /** Called for each write that landed, so the editor can take the new etag. */
  onWritten?: (result: { path: string; etag: string; shownAt?: string }) => void;
  /**
   * Performs one queued op. Optional for the callers with nothing but edits —
   * without it, ops are left in the queue untouched.
   */
  op?: (op: PendingOp) => Promise<OpOutcome>;
  /** Called for each op that landed, so the editor can follow a renamed note. */
  onOpDone?: (done: OpSent) => void;
  /**
   * The visibility a new note in this folder gets, as the console last listed
   * it — for the badge of a note created offline, until a sync says. Absent,
   * `private`: a guess never claims a note is shared.
   */
  folderDefaultFor?: (path: string) => Visibility;
}): OfflineNotes {
  const { tier, workspaceId } = options;
  const reachability = useReachability();

  /*
    `null` is "we do not know yet", and it is not the same as `team`. Guessing
    the narrow one would be safe to *read* and wrong to *write*: an owner's
    private note would be filed under the clearance a team-level session reads
    at, which is the leak with an extra step. So both halves stop.
  */
  const scope: CacheScope | null = tier === "unknown" ? null : tier;

  // One store for the life of the app. `openStore` probes the platform, and
  // doing that per render would be a `localStorage` write per render.
  const storeRef = useRef<KeyValueStore | null>(null);
  if (storeRef.current === null) storeRef.current = openStore();
  const store = storeRef.current;

  /*
    The session this mount's writes belong to, captured once. Read through a
    ref rather than through state because every writer below is called from a
    callback that outlived the render that made it, which is the same reason
    the injected `write` goes through one — and because a re-render must not be
    able to re-capture it: re-capturing after a sign-out is exactly the race
    the epoch exists to close.
  */
  const epochRef = useRef(currentEpoch());
  /** Whether this mount's session is still the one the device belongs to. */
  const mine = useCallback(() => epochRef.current === currentEpoch(), []);

  const [outbox, setOutbox] = useState<Outbox>(() => emptyOutbox(workspaceId ?? ""));
  const [ready, setReady] = useState(false);
  const [lastDrain, setLastDrain] = useState<DrainReport | null>(null);

  const outboxRef = useRef(outbox);
  outboxRef.current = outbox;

  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftPending = useRef<Draft | null>(null);
  const draining = useRef(false);
  const collaborationOwnedRef = useRef<Set<string>>(new Set());

  /*
    The callbacks below outlive the render that made them — a drain runs
    seconds after the reconnection that started it — so the injected write and
    the notification go through refs rather than being captured. Without this
    every one of them would be rebuilt on each render and the drain effect
    would re-fire on each render with it.
  */
  const writeRef = useRef(options.write);
  writeRef.current = options.write;
  const shouldWriteRef = useRef(options.shouldWrite);
  shouldWriteRef.current = options.shouldWrite;
  const onWrittenRef = useRef(options.onWritten);
  onWrittenRef.current = options.onWritten;
  const opRef = useRef(options.op);
  opRef.current = options.op;
  const onOpDoneRef = useRef(options.onOpDone);
  onOpDoneRef.current = options.onOpDone;
  const folderDefaultRef = useRef(options.folderDefaultFor);
  folderDefaultRef.current = options.folderDefaultFor;

  const flush = useCallback(
    (next: Outbox) => {
      if (persistTimer.current !== null) {
        clearTimeout(persistTimer.current);
        persistTimer.current = null;
      }
      /*
        A drain settling during `await signOut()` reaches here through
        `commit(..., true)`. Writing then would re-persist the very queue the
        person was warned about and pressed "discard" on, onto the machine the
        next person signs in on.
      */
      if (!mine()) return;
      void putOutbox(store, next).catch(() => {
        /*
          The store refused — a full `localStorage`, most likely. The queue is
          still in memory and still drains; what is lost is surviving a reload.
          Nothing useful can be done here, and throwing would take down the
          render that made the edit. `copy.ts` has the sentence for a queue that
          is not written down; this is where the app finds out it is in that
          state.
        */
      });
    },
    [mine, store],
  );

  /** Update both copies. `immediate` for anything that removes work. */
  const commit = useCallback(
    (next: Outbox, immediate: boolean) => {
      setOutbox(next);
      outboxRef.current = next;
      if (immediate) {
        flush(next);
        return;
      }
      if (persistTimer.current !== null) clearTimeout(persistTimer.current);
      persistTimer.current = setTimeout(() => {
        persistTimer.current = null;
        // Checked when the timer fires, not when it is armed: the second in
        // between is the ordinary case — type, press sign out.
        if (!mine()) return;
        void putOutbox(store, outboxRef.current).catch(() => {});
      }, PERSIST_DEBOUNCE_MS);
    },
    [flush, mine, store],
  );

  /** Read the queue for this context back off the store. */
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    if (workspaceId === null) {
      setOutbox(emptyOutbox(""));
      return;
    }
    void Promise.all([getOutbox(store, workspaceId), collaborationOwnedPaths(store, workspaceId)]).then(([loaded, owned]) => {
      if (cancelled) return;
      collaborationOwnedRef.current = owned;
      setOutbox(loaded);
      outboxRef.current = loaded;
      setReady(true);
    });
    return () => {
      cancelled = true;
    };
  }, [store, workspaceId]);

  /**
   * Bound the cache, once, after the queue has loaded.
   *
   * Deliberately not on a timer and not before hydration: the sweep walks every
   * key, and the one thing it must never race is the read that decides what is
   * in the queue.
   */
  useEffect(() => {
    if (!ready) return;
    void (async () => {
      /*
        On a device with a mirror, the note and listing copies are handed over
        and retired first — see the file comment. Adopted before removal, so a
        copy that is the ancestor of an edit queued before the upgrade keeps
        its Merge; removed only once the adoption has been written, so a
        session that ended part-way (the adoption refused by the barrier)
        leaves the copies for `forgetLocalCopies`, which is already taking them.
      */
      const mirror = await openMirrorStore();
      if (mirror !== null && mine()) {
        let handedOver = true;
        for (const group of await cachedNoteCopies(store)) {
          const adopted = await adoptCachedNotes(
            mirror,
            epochRef.current,
            group.scope,
            group.workspaceId,
            group.copies,
          );
          if (!adopted && !mine()) handedOver = false;
        }
        if (handedOver && mine()) await retireCopies(store);
      }
      await sweep(store, { now: Date.now() });
    })().catch(() => {});
  }, [mine, ready, store]);

  /*
    The versions this context's live queue is based on, held for the mirror.

    The store's copy of the queue trails this one by up to
    `PERSIST_DEBOUNCE_MS`, and a sync that ran in that second would see no
    queued edit and replace the body it is based on. The hold closes that
    second; `mirrorHolds.ts` has the rest of the argument.
  */
  const holdOwner = useRef(`outbox:${Math.random().toString(36).slice(2)}`).current;
  useEffect(() => {
    const byPath: Record<string, (string | null)[]> = {};
    for (const write of outbox.writes) (byPath[write.path] ??= []).push(write.baseEtag);
    holdAncestors(holdOwner, workspaceId, byPath);
  }, [holdOwner, outbox, workspaceId]);
  useEffect(() => () => releaseAncestors(holdOwner), [holdOwner]);

  useEffect(
    () => () => {
      if (persistTimer.current !== null) clearTimeout(persistTimer.current);
      if (draftTimer.current !== null) clearTimeout(draftTimer.current);
    },
    [],
  );

  /**
   * Move this device's copy of a note onto text and an etag that are now in the
   * bucket. The mirror where there is one — at every clearance holding the
   * note, keeping any ancestor still needed — and the bounded cache where there
   * is not. Neither invents an entry for a note it does not hold: a save result
   * carries none of the visibility fields.
   */
  const rememberSent = useCallback(
    (body: { path: string; text: string; etag: string }) => {
      if (workspaceId === null || scope === null || !mine()) return;
      const epoch = epochRef.current;
      void (async () => {
        const mirror = await openMirrorStore();
        if (mirror !== null) {
          const needed = await neededEtags(store, workspaceId);
          if (!mine()) return;
          await moveMirroredBody(mirror, epoch, workspaceId, body, needed, Date.now());
          return;
        }
        const cached = await getNote(store, scope, workspaceId, body.path);
        /*
          Checked again here, and this is the one writer where the entry gate
          is not enough: every other one writes synchronously after it, or
          re-checks when its timer fires. This one awaits a read first, so the
          session can end in the gap.

          Web hid it — `store.web.ts` reads `localStorage` synchronously inside
          an async function, so the whole chain drains in microtasks before a
          press can be handled. Native does not: `AsyncStorage.getItem` is a
          queued bridge call, so a read issued before sign-out resolves after
          the clear has walked past that key, and the write behind it lands on
          a device whose session is over. Measured that way round, from
          `useFileBrowser`'s two call sites — a save, then sign out.
        */
        if (cached === null || !mine()) return;
        await putNote(
          store,
          scope,
          workspaceId,
          { ...cached.value, text: body.text, etag: body.etag },
          Date.now(),
        );
      })().catch(() => {});
    },
    [mine, scope, store, workspaceId],
  );

  /**
   * Move this device's copy of a note onto where an op just put it in the
   * bucket: a renamed note's body to its new name (at the version the move
   * returned, where it said), and a deleted or archived one off the device —
   * the next sync brings the archived copy back where the archive put it.
   * Without this the tree drawn from the mirror shows the note under its old
   * name, beside the new one, until the next sync prunes it.
   */
  /** A note this device created, now in the bucket: into the mirror. See the drain. */
  const rememberCreated = useCallback(
    (note: OpenNote) => {
      if (workspaceId === null || scope === null || !mine()) return;
      const epoch = epochRef.current;
      void (async () => {
        const mirror = await openMirrorStore();
        if (mirror === null) return;
        const needed = await neededEtags(store, workspaceId);
        if (!mine()) return;
        await putMirroredNotes(mirror, epoch, scope, workspaceId, [note], needed, Date.now());
      })().catch(() => {});
    },
    [mine, scope, store, workspaceId],
  );

  const rememberOpDone = useCallback(
    (done: OpSent) => {
      if (workspaceId === null || scope === null || !mine()) return;
      if (done.kind === "folder") return;
      const epoch = epochRef.current;
      void (async () => {
        const mirror = await openMirrorStore();
        if (mirror === null) return;
        if (done.kind === "move" && done.to !== undefined) {
          const copy = await mirroredNote(mirror, scope, workspaceId, done.path);
          if (copy !== null && mine()) {
            const needed = await neededEtags(store, workspaceId);
            if (!mine()) return;
            await putMirroredNotes(
              mirror,
              epoch,
              scope,
              workspaceId,
              [{ ...copy.value, path: done.to, etag: done.etag ?? copy.value.etag }],
              needed,
              Date.now(),
            );
          }
        }
        if (!mine()) return;
        await forgetMirroredNote(mirror, epoch, workspaceId, done.path);
      })().catch(() => {});
    },
    [mine, scope, store, workspaceId],
  );

  /**
   * An undo that puts the ops back exactly as they were before one press.
   *
   * Only while nothing has touched them since, and never during a drain: an op
   * already on the wire cannot be recalled by editing the queue, and restoring
   * the rename a delete folded into, after the delete reached the bucket, would
   * queue a rename of a note in the trash.
   */
  const undoTo = useCallback(
    (before: Outbox, after: Outbox) => () => {
      if (draining.current) return false;
      const now = outboxRef.current;
      if (now.ops !== after.ops || now.writes !== after.writes) return false;
      commit({ ...now, writes: before.writes, ops: opsOf(before) }, true);
      return true;
    },
    [commit],
  );

  const drain = useCallback(() => {
    /*
      Not a device write, and gated anyway. The console stays mounted through
      `await signOut()`, and this fires from an effect the moment a queue and a
      connection exist — so a reconnection inside that window would send the
      queue the person was just told had been discarded, to the bucket, under a
      session that is ending.

      It is still not a cancellation: a drain already in flight finishes, and
      what the epoch stops is anything it would write back to this device.
    */
    if (draining.current || workspaceId === null || !mine()) return;
    const current = outboxRef.current;
    if (isEmpty(current)) return;
    draining.current = true;

    const send = opRef.current;
    void drainOutbox(current, {
      write: (write) => writeRef.current(write),
      shouldWrite: (write) => !collaborationOwnedRef.current.has(write.path) && (shouldWriteRef.current?.(write) ?? true),
      ...(send === undefined ? {} : { op: (op: PendingOp) => send(op) }),
      now: () => Date.now(),
      onOpDone: (done) => {
        rememberOpDone(done);
      },
    })
      .then(({ outbox: next, report }) => {
        /*
          Anything queued *while* the drain was running is in `outboxRef` and
          not in `next`, which was derived from the snapshot the drain started
          with. Re-applying the drain's result over the newer state — rather
          than replacing it — is what stops a save made mid-drain from being
          silently dropped.
        */
        // Keep aliases before completed moves leave the queue. The editor may
        // already show the destination while this write used the source name.
        const shownPaths = new Map(report.sent.map((sent) => [
          sent.path, localPathOf(outboxRef.current, sent.path),
        ]));
        commit(
          reconcile(outboxRef.current, next, report, { id: newOpId, now: Date.now() }),
          true,
        );
        // Reconcile first. The editor needs to know whether a newer write was
        // queued while this request was in flight before it marks a create
        // settled or upgrades it to a canonical collaboration generation.
        for (const sent of report.sent) {
          onWrittenRef.current?.({ path: sent.path, etag: sent.etag, shownAt: shownPaths.get(sent.path) });
        }
        // Writes land before moves. Deliver their acknowledgements in that
        // order so a move can advance the version the write just established.
        for (const done of report.ops.done) onOpDoneRef.current?.(done);
        setLastDrain(report);
        /*
          What was sent is in the bucket now, at the etag the write returned,
          so the device's copy moves onto it — the same thing a Save that lands
          does (`rememberBody`). Without it, an edit made offline and drained
          reads back offline as the version it replaced until the next sync.
        */
        for (const sent of report.sent) {
          const entry = current.writes.find((write) => write.path === sent.path);
          if (entry === undefined) continue;
          if (sent.sentBaseEtag === null) {
            /*
              A note created offline is in the bucket now, and in nothing on
              the device: the queue has let it go and the mirror never held it,
              so the tree drawn offline would lose it until the next sync
              fetched it. It goes into the mirror as what was written, drawn
              with its folder's default for a badge — the next complete sync
              replaces that with the server's own answer.
            */
            const visibility = folderDefaultRef.current?.(sent.path) ?? "private";
            rememberCreated({
              path: sent.path,
              text: entry.text,
              etag: sent.etag,
              visibility,
              inherited: visibility,
              exception: false,
              readOnly: false,
            });
            continue;
          }
          rememberSent({ path: sent.path, text: entry.text, etag: sent.etag });
        }
      })
      .catch(() => {
        // `drainOutbox` does not throw; an injected `write` that rejects rather
        // than resolving an outcome would land here. The queue is untouched, so
        // the next reconnection tries again.
      })
      .finally(() => {
        draining.current = false;
      });
  }, [commit, mine, rememberCreated, rememberOpDone, rememberSent, workspaceId]);

  /** Empty the queue whenever we believe we can reach the bucket. */
  useEffect(() => {
    if (!ready || reachability === "offline") return;
    drain();
  }, [drain, reachability, ready]);

  const api = useMemo<OfflineNotes>(
    () =>
      buildOfflineNotesApi({
        workspaceId,
        scope,
        store,
        ready,
        reachability,
        outbox,
        lastDrain,
        mine,
        commit,
        drain,
        rememberSent,
        undoTo,
        epochRef,
        outboxRef,
        draining,
        draftPending,
        draftTimer,
      }),
    [
      commit,
      drain,
      lastDrain,
      mine,
      outbox,
      reachability,
      ready,
      rememberSent,
      scope,
      store,
      undoTo,
      workspaceId,
    ],
  );

  return api;
}
