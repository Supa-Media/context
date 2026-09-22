import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  cachedNoteCopies,
  clearDraft,
  clearNote,
  getDraft,
  getListing,
  getNote,
  getOutbox,
  putDraft,
  putListing,
  putNote,
  putOutbox,
  retireCopies,
  sweep,
  type Cached,
  type Draft,
} from "./cache";
import { openStore } from "./store";
import { currentEpoch } from "./epoch";
import {
  adoptCachedNotes,
  forgetMirroredNote,
  mirroredAncestor,
  mirroredListing,
  mirroredNote,
  moveMirroredBody,
  putMirroredNotes,
  rememberMirroredFolders,
} from "./mirror";
import { holdAncestors, neededEtags, releaseAncestors } from "./mirrorHolds";
import { openMirrorStore } from "./mirrorStore";
import type { KeyValueStore } from "./memory";
import {
  claimedPaths,
  counts,
  discard,
  dropOp as dropOpFrom,
  emptyOutbox,
  enqueue,
  find,
  findOp,
  forceMine,
  isEmpty,
  opsOf,
  overrideOp as overrideOpIn,
  queueFolder as queueFolderIn,
  queueMove as queueMoveIn,
  queueRemoval as queueRemovalIn,
  retry,
  retryOp as retryOpIn,
  localPathOf,
  rebaseOp as rebaseOpIn,
  routesThroughQueue,
  serverPathOf,
  settle,
  type Outbox,
  type OutboxCounts,
  type PendingOp,
  type PendingWrite,
} from "./outbox";
import { drainOutbox, type DrainReport, type OpOutcome, type OpSent, type WriteOutcome } from "./sync";
import { collaborationOwnedPaths } from "./collaborationOwnership";
import { useReachability } from "./reachability";
import type { CacheScope } from "./keys";
import type { Reachability } from "./copy";
import type { VisibilityTier } from "../console/visibility";
import type { FolderListing, OpenNote, Visibility } from "../console/files/types";

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

/** A local handle for an op. Never sent, so it only has to be unique on this device. */
function newOpId(): string {
  return `op_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/** A second of typing is what a crash may cost. See the file comment. */
export const PERSIST_DEBOUNCE_MS = 1_000;

export interface OfflineNotes {
  /** The queue has been read back off the store. Nothing acts before this. */
  ready: boolean;
  /** Whether anything here survives the app closing. */
  durable: boolean;
  reachability: Reachability;
  outbox: Outbox;
  counts: OutboxCounts;

  /** Remember what the bucket just said. */
  rememberNote: (note: OpenNote) => void;
  /**
   * Move a cached note onto text and an etag that were just written.
   *
   * Separate from `rememberNote` because a save result carries neither the
   * visibility fields nor the read-only flag, and inventing them would put
   * wrong access markers on a note read offline. A note that is not cached
   * stays uncached: the next read will fetch the real thing.
   */
  rememberBody: (body: { path: string; text: string; etag: string }) => void;
  rememberListing: (listing: FolderListing) => void;
  cachedNote: (path: string) => Promise<Cached<OpenNote> | null>;
  cachedListing: (path: string) => Promise<Cached<FolderListing> | null>;
  /**
   * The body a three-way merge may use as the ancestor of a draft typed on
   * `baseEtag` — see `mirroredAncestor`. Not `cachedNote`: that is the newest
   * copy, for reading, and the newest copy is exactly what the ancestor is not
   * once the bucket has moved on.
   */
  ancestorFor: (
    path: string,
    baseEtag: string | null,
  ) => Promise<{ text: string; etag: string } | null>;
  /**
   * The mirror's copy of a note, for showing while the bucket is asked — and
   * `null` on a device with no mirror. Deliberately not the bounded cache: a
   * copy of what somebody happened to open is not what a whole-context mirror
   * reconciled minutes ago is, and the online open that would show it did not
   * do so before the mirror existed.
   */
  instantCopy: (path: string) => Promise<Cached<OpenNote> | null>;
  /**
   * Drop the cached copy of one note.
   *
   * The only *removal* on the copy side of this interface, and it exists for
   * the one case where a cached body is not a disposable derivative but a
   * plaintext this device has been asked to stop holding: a note that has just
   * become ciphertext. Every other reduction of the cache is `sweep`'s bounds
   * or `forgetWorkspace`, both of which act on a whole store rather than on a
   * note somebody named.
   *
   * Unlike `cachedNote`, this is **not** gated on the session's clearance: it
   * clears every clearance's copy (`clearNote`), because the copy this has to
   * take may have been filed under one this session cannot even read.
   */
  forgetNote: (path: string) => void;

  /** The unsaved, un-queued draft for a note, if there is one. */
  savedDraft: (path: string) => Promise<Draft | null>;
  rememberDraft: (draft: Draft) => void;
  forgetDraft: (path: string) => void;

  pendingFor: (path: string) => PendingWrite | undefined;
  /** Queue a save that cannot be made now. */
  queueSave: (save: { path: string; text: string; baseEtag: string | null }) => void;
  /** The person took the bucket's version: the queued draft goes. */
  dropQueued: (path: string) => void;
  /** Clear only the exact legacy entry acknowledged by collaboration. */
  adoptLegacy: (adoption: { path: string; text: string; baseEtag: string }) => void;
  /** The person kept theirs: re-base onto the version they were shown. */
  keepQueued: (path: string) => void;
  /** Put a parked refusal back in the queue, unchanged. */
  retryQueued: (path: string) => void;

  /*
    Renames, moves, archives, deletes and new folders — `PendingOp`. Every one
    of these takes the path *as the console shows it*; where that is a note
    this device has renamed, the queue knows the bucket's name for it
    (`serverPathOf`) and the callers never have to.
  */
  /** The bucket's name for a note this device may have renamed. */
  serverPathOf: (path: string) => string;
  /** Where the console shows a bucket path this device may have renamed. */
  localPathOf: (path: string) => string;
  /**
   * A save of this note reached the bucket directly: its queued edit is done,
   * and whatever was queued to happen to the note next follows the version the
   * save produced. Not `dropQueued` — that lets a create go, and with it
   * everything waiting on the create.
   */
  landedQueued: (path: string, etag: string) => void;
  /** Whether an action on this path has to go through the queue, even online. */
  routesThroughQueue: (path: string) => boolean;
  /** Whether the queue is holding this name — see `claimedPaths`. */
  claims: (path: string) => boolean;
  /** The create waiting for this path, if the note exists only on this device. */
  pendingCreate: (path: string) => PendingWrite | undefined;
  /**
   * Queue a rename or move. `etag` is the note's version as the device has it;
   * `false` when the queue would not take it — see `queueMove`.
   */
  queueMove: (move: { from: string; to: string; etag: string | null }) => QueuedOp;
  /**
   * Queue a delete or archive. `dropped` is a create that was never sent and is
   * now gone — the caller offers it back with `restoreCreate`.
   */
  queueRemoval: (removal: {
    kind: "trash" | "archive";
    path: string;
    etag: string | null;
  }) => QueuedOp & { dropped?: PendingWrite };
  queueFolder: (path: string) => QueuedOp;
  /** Take an op back, or discard a parked one. */
  dropOp: (id: string) => void;
  /** A refused op, back in the queue because a person asked. */
  retryOp: (id: string) => void;
  /** "Do it anyway" — against the version the conflict reported. */
  overrideOp: (id: string) => void;
  /** The undo of a delete that dropped an unsent create. */
  restoreCreate: (write: PendingWrite) => void;
  /** The id of the op this queue holds on a bucket path, for an undo. */

  /** Try to empty the queue now. A no-op while one is already running. */
  drain: () => void;
  /** What the last drain did, for the console to report. `null` until one runs. */
  lastDrain: DrainReport | null;
}

/**
 * What queueing an op answered. `undo` puts the queue back exactly as it was
 * before the press, and answers `false` when it no longer can — the op is on
 * its way to the bucket or already there, or something else in the queue has
 * moved since — so a caller never says "undone" about something that was not.
 */
export interface QueuedOp {
  ok: boolean;
  undo?: () => boolean;
}

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
  onWritten?: (result: { path: string; etag: string }) => void;
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
        onOpDoneRef.current?.(done);
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
        commit(
          reconcile(outboxRef.current, next, report, { id: newOpId, now: Date.now() }),
          true,
        );
        // Reconcile first. The editor needs to know whether a newer write was
        // queued while this request was in flight before it marks a create
        // settled or upgrades it to a canonical collaboration generation.
        for (const sent of report.sent) {
          onWrittenRef.current?.({ path: sent.path, etag: sent.etag });
        }
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

  const api = useMemo<OfflineNotes>(() => {
    /*
      One value that says whether a *copy* may be touched at all, and under what
      clearance: a context has to be open and its tier has to be known. It is an
      object rather than a boolean so that the two facts travel together — a
      flag plus two separately-read variables is how a call site ends up filing
      a note under a clearance the flag was not about. Drafts and the queue are
      deliberately not behind it: they are typing, not a copy of an answer.
    */
    const copies: { scope: CacheScope; workspaceId: string } | null =
      workspaceId === null || scope === null ? null : { scope, workspaceId };
    const workspace = workspaceId ?? "";
    return {
      ready,
      durable: store.durable,
      reachability,
      outbox,
      counts: counts(outbox),

      /*
        The three `remember*` writers below each drop their write when the
        session that started the read has ended — see the file comment. The
        check is here rather than inside `cache.ts` on purpose: those functions
        take a store and are the same ones `forget.ts` and the tests drive, and
        a module that silently refused to write under some global would be
        untestable and would make `putNote` mean two different things.
      */
      rememberNote: (note) => {
        if (copies === null || !mine()) return;
        const epoch = epochRef.current;
        void (async () => {
          const mirror = await openMirrorStore();
          if (mirror === null) {
            await putNote(store, copies.scope, copies.workspaceId, note, Date.now());
            return;
          }
          /*
            Through the one writer the sync uses too, so an online open keeps
            the ancestor a parked write needs — the read cache lost it here,
            the moment a note with a conflicted write was opened online.
          */
          const needed = await neededEtags(store, copies.workspaceId);
          if (!mine()) return;
          await putMirroredNotes(
            mirror,
            epoch,
            copies.scope,
            copies.workspaceId,
            [note],
            needed,
            Date.now(),
          );
        })().catch(() => {});
      },
      rememberBody: (body) => {
        if (copies === null) return;
        rememberSent(body);
      },
      rememberListing: (listing) => {
        if (copies === null || !mine()) return;
        const epoch = epochRef.current;
        void (async () => {
          const mirror = await openMirrorStore();
          if (mirror === null) {
            await putListing(store, copies.scope, copies.workspaceId, listing, Date.now());
            return;
          }
          // The mirror derives every listing from paths; what a listing adds
          // is each folder's own default, for its badge offline.
          await rememberMirroredFolders(mirror, epoch, copies.scope, copies.workspaceId, listing);
        })().catch(() => {});
      },
      cachedNote: async (path) => {
        if (copies === null) return null;
        const mirror = await openMirrorStore();
        return mirror === null
          ? getNote(store, copies.scope, copies.workspaceId, path)
          : mirroredNote(mirror, copies.scope, copies.workspaceId, path);
      },
      cachedListing: async (path) => {
        if (copies === null) return null;
        const mirror = await openMirrorStore();
        return mirror === null
          ? getListing(store, copies.scope, copies.workspaceId, path)
          : mirroredListing(mirror, copies.scope, copies.workspaceId, path);
      },
      instantCopy: async (path) => {
        if (copies === null) return null;
        const mirror = await openMirrorStore();
        return mirror === null ? null : mirroredNote(mirror, copies.scope, copies.workspaceId, path);
      },
      ancestorFor: async (path, baseEtag) => {
        if (copies === null) return null;
        const mirror = await openMirrorStore();
        if (mirror !== null) {
          return mirroredAncestor(mirror, copies.scope, copies.workspaceId, path, baseEtag);
        }
        const cached = await getNote(store, copies.scope, copies.workspaceId, path);
        return cached === null ? null : { text: cached.value.text, etag: cached.value.etag };
      },

      /*
        Not gated on `copies`, which is what every other line on the copy side
        of this object is. `copies` is `null` while the clearance is unknown,
        and a *read* must stop there — filing or serving a copy under a
        clearance nobody has established is the leak `keys.ts` argues about at
        length. A **removal** fails the other way round: refusing to clear
        because the tier has not landed yet would leave the plaintext exactly
        where the caller asked for it to stop being, in the one window where
        nobody can prove it is safe. So this needs only the workspace.
      */
      forgetNote: (path) => {
        if (workspaceId === null) return;
        void clearNote(store, workspace, path).catch(() => {});
        // Both bodies and the entry, at every clearance — the mirrored copy is
        // the same plaintext the lock was meant to be the last of.
        void openMirrorStore()
          .then((mirror) =>
            mirror === null
              ? undefined
              : forgetMirroredNote(mirror, epochRef.current, workspace, path),
          )
          .catch(() => {});
      },

      savedDraft: async (path) => (workspaceId === null ? null : getDraft(store, workspace, path)),
      rememberDraft: (draft) => {
        if (workspaceId === null) return;
        /*
          Trailing-debounced, for the same reason the queue's write-down is: this
          is called on every keystroke, and a `JSON.stringify` into
          `localStorage` per character is a typing experience. The bound on what
          a crash costs is `PERSIST_DEBOUNCE_MS` of typing.
        */
        draftPending.current = draft;
        if (draftTimer.current !== null) return;
        draftTimer.current = setTimeout(() => {
          draftTimer.current = null;
          const latest = draftPending.current;
          draftPending.current = null;
          // The gap this closes is the most ordinary sequence in the product:
          // type a word, press sign out. Checked when the timer fires.
          if (latest !== null && mine()) void putDraft(store, workspace, latest).catch(() => {});
        }, PERSIST_DEBOUNCE_MS);
      },
      forgetDraft: (path) => {
        if (workspaceId === null) return;
        // Cancel anything still in flight for this note first, or the debounced
        // write lands a second after the clear and resurrects it.
        if (draftPending.current?.path === path) draftPending.current = null;
        void clearDraft(store, workspace, path).catch(() => {});
      },

      /*
        Every mutation below derives from `outboxRef.current`, never from the
        `outbox` this memo closed over.

        React batches state updates, so two of these in one tick — a keystroke
        in one note and a discard in another, or a drain settling while
        somebody types — would both build on the queue as it was at the start
        of the render and the second would silently undo the first. `commit`
        writes the ref synchronously alongside `setOutbox`, so reading it is
        always the latest. The rendered `outbox` above is for drawing.
      */
      /*
        The edits are keyed by the bucket's name for a note — see
        `serverPathOf` — so an edit typed into a note renamed on this device is
        queued against the note the bucket has, and sent before the rename.
      */
      pendingFor: (path) => find(outboxRef.current, serverPathOf(outboxRef.current, path)),
      queueSave: (save) =>
        commit(
          enqueue(outboxRef.current, {
            ...save,
            path: serverPathOf(outboxRef.current, save.path),
            now: Date.now(),
          }),
          false,
        ),
      // The three below all take work *out* of the queue or change what it will
      // do, so they are written through rather than debounced.
      dropQueued: (path) =>
        commit(discard(outboxRef.current, serverPathOf(outboxRef.current, path)), true),
      adoptLegacy: (adoption) => {
        if (workspaceId === null) return;
        const path = serverPathOf(outboxRef.current, adoption.path);
        const queued = find(outboxRef.current, path);
        if (queued !== undefined && queued.text === adoption.text && queued.baseEtag === adoption.baseEtag) {
          commit(discard(outboxRef.current, path), true);
        }
        void (async () => {
          const draft = await getDraft(store, workspaceId, adoption.path);
          if (draft?.text === adoption.text && draft.baseEtag === adoption.baseEtag) {
            await clearDraft(store, workspaceId, adoption.path);
          }
        })().catch(() => {});
      },
      keepQueued: (path) =>
        commit(forceMine(outboxRef.current, serverPathOf(outboxRef.current, path)), true),
      retryQueued: (path) =>
        commit(retry(outboxRef.current, serverPathOf(outboxRef.current, path)), true),

      serverPathOf: (path) => serverPathOf(outboxRef.current, path),
      localPathOf: (path) => localPathOf(outboxRef.current, path),
      landedQueued: (path, etag) => {
        const current = outboxRef.current;
        const server = serverPathOf(current, path);
        const write = find(current, server);
        let next = settle(current, server);
        const op = opsOf(next).find((one) => one.path === server);
        if (write !== undefined && op !== undefined && (op.baseEtag === null || op.baseEtag === write.baseEtag)) {
          next = rebaseOpIn(next, op.id, etag);
        }
        commit(next, true);
      },
      routesThroughQueue: (path) => routesThroughQueue(outboxRef.current, path),
      claims: (path) => claimedPaths(outboxRef.current).has(path),
      pendingCreate: (path) => {
        const write = find(outboxRef.current, serverPathOf(outboxRef.current, path));
        return write?.baseEtag === null ? write : undefined;
      },
      /*
        Every op below is written through at once rather than debounced: each
        is one press, not a stream of keystrokes, and a rename that survived
        only in memory would come back after a crash as the old name with the
        person's edits queued against a path they think is gone.

        `coalesce` is off while a drain is running — see `QueueOpInput` — which
        is the one thing here that depends on the drain rather than the queue.
      */
      queueMove: ({ from, to, etag }) => {
        const next = queueMoveIn(outboxRef.current, {
          id: newOpId(),
          path: from,
          to,
          etag,
          now: Date.now(),
          coalesce: !draining.current,
        });
        if (next === null) return { ok: false };
        const before = outboxRef.current;
        commit(next, true);
        return { ok: true, undo: undoTo(before, next) };
      },
      queueRemoval: ({ kind, path, etag }) => {
        const id = newOpId();
        const result = queueRemovalIn(outboxRef.current, {
          id,
          kind,
          path,
          etag,
          now: Date.now(),
          coalesce: !draining.current,
        });
        if (result === null) return { ok: false };
        const before = outboxRef.current;
        commit(result.outbox, true);
        if (result.dropped !== undefined) return { ok: true, dropped: result.dropped };
        return { ok: true, undo: undoTo(before, result.outbox) };
      },
      queueFolder: (path) => {
        const next = queueFolderIn(outboxRef.current, { id: newOpId(), path, now: Date.now() });
        if (next === null) return { ok: false };
        const before = outboxRef.current;
        commit(next, true);
        return { ok: true, undo: undoTo(before, next) };
      },
      dropOp: (id) => commit(dropOpFrom(outboxRef.current, id), true),
      retryOp: (id) => commit(retryOpIn(outboxRef.current, id), true),
      overrideOp: (id) => commit(overrideOpIn(outboxRef.current, id), true),
      restoreCreate: (write) => {
        const current = outboxRef.current;
        // Only into a name nothing else has taken since.
        if (claimedPaths(current).has(write.path)) return;
        commit({ ...current, writes: [...current.writes, write] }, true);
      },

      drain,
      lastDrain,
    };
  }, [
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
  ]);

  return api;
}

/**
 * Fold a finished drain's result back over whatever the queue looks like now.
 *
 * A drain is asynchronous and a person keeps typing through it, so the queue
 * the drain started from is not the queue that exists when it finishes. `live`
 * is now, `drained` is what the drain decided, `report` says which version of
 * each entry actually went.
 *
 * Three cases, and each of them is a bug if collapsed into another:
 *
 *  - **Sent, and nothing typed since** (`updatedAt <= sentUpdatedAt`): drop it.
 *  - **Sent, and typed since**: keep the newer text, and **re-base it onto the
 *    etag the drain just wrote**. Without that re-base the person's next drain
 *    conflicts them against their own write of thirty seconds ago, which is the
 *    most confusing conflict it is possible to show somebody.
 *  - **Not sent**: take the drain's verdict — the conflict, the refusal, the
 *    attempt count — because those are facts about the bucket that newer typing
 *    does not change. The text stays whatever is live.
 *
 * `exported for its own test` rather than inlined: this is the one piece of the
 * offline layer whose bug would be invisible (an edit silently dropped, or a
 * self-conflict a minute later) and it is unreachable through the hook without
 * a fake timer race.
 */
export function reconcile(
  live: Outbox,
  drained: Outbox,
  report: DrainReport,
  /** For the one op reconciling can add — see the inverse move below. */
  make: { id: () => string; now: number } = { id: newOpId, now: Date.now() },
): Outbox {
  let result = live;

  for (const entry of live.writes) {
    const sent = report.sent.find((one) => one.path === entry.path);

    if (sent !== undefined) {
      if (entry.updatedAt <= sent.sentUpdatedAt) {
        result = settle(result, entry.path);
      } else {
        result = patch(result, entry.path, { baseEtag: sent.etag, state: "pending" });
      }
      continue;
    }

    const after = find(drained, entry.path);
    if (after === undefined) continue;
    result = patch(result, entry.path, {
      state: after.state,
      attempts: after.attempts,
      baseEtag: after.baseEtag,
      conflict: after.conflict,
      rejection: after.rejection,
      lastError: after.lastError,
    });
  }

  return reconcileOps(result, drained, report, make);
}

/**
 * The same fold for ops, which have one case the edits do not.
 *
 * Ops are never rewritten while a drain runs (`coalesce` is off), so an op the
 * drain sent is exactly the op still in the live queue — it goes. An op the
 * drain reached a verdict on takes that verdict, and its re-based version with
 * it. An op queued *during* the drain was not in the snapshot, so nothing
 * re-based it; it is moved here onto what the drain's landings produced, by
 * the same rule the drain uses (`rebaseOp`) — the edit it followed, or the
 * rename it was queued behind.
 *
 * **And an op the person took back while it was on the wire.** The undo that
 * could do that refuses during a drain, but "Discard" on a parked op in the
 * sheet is always a drop, and a `dropOp` racing a send is possible. The bucket
 * has done it; the person's last word was "don't". For a rename that is
 * answered by queueing the rename back, at the version the rename returned —
 * a real, conditional op the person can see. A delete or archive that landed
 * cannot be taken back from here and is not pretended to have been.
 */
function reconcileOps(
  live: Outbox,
  drained: Outbox,
  report: DrainReport,
  make: { id: () => string; now: number },
): Outbox {
  const done = new Map(report.ops.done.map((one) => [one.id, one]));
  const ops: PendingOp[] = [];
  for (const op of opsOf(live)) {
    if (done.has(op.id)) continue;
    const after = findOp(drained, op.id);
    if (after !== undefined) {
      ops.push({
        ...op,
        state: after.state,
        attempts: after.attempts,
        baseEtag: after.baseEtag,
        conflict: after.conflict,
        rejection: after.rejection,
        lastError: after.lastError,
      });
      continue;
    }
    ops.push(rebasedOnLandings(op, report));
  }

  for (const landed of report.ops.done) {
    if (landed.kind !== "move" || landed.to === undefined) continue;
    // Sent from the snapshot and gone from the live queue: dropped mid-flight.
    if (opsOf(live).some((op) => op.id === landed.id)) continue;
    if (landed.etag === undefined) continue;
    ops.push({
      id: make.id(),
      kind: "move",
      path: landed.to,
      to: landed.path,
      baseEtag: landed.etag,
      queuedAt: make.now,
      updatedAt: make.now,
      state: "pending",
      attempts: 0,
    });
  }
  return { ...live, ops };
}

function rebasedOnLandings(op: PendingOp, report: DrainReport): PendingOp {
  const edit = report.sent.find((one) => one.path === op.path);
  if (edit !== undefined && (op.baseEtag === null || op.baseEtag === edit.sentBaseEtag)) {
    return { ...op, baseEtag: edit.etag };
  }
  if (op.baseEtag === null) {
    const rename = report.ops.done.find(
      (one) => one.kind === "move" && one.to === op.path && one.etag !== undefined,
    );
    if (rename?.etag !== undefined) return { ...op, baseEtag: rename.etag };
  }
  return op;
}

function patch(outbox: Outbox, path: string, fields: Partial<PendingWrite>): Outbox {
  return {
    ...outbox,
    writes: outbox.writes.map((write) =>
      write.path === path ? { ...write, ...fields } : write,
    ),
  };
}
