import {
  clearDraft,
  clearNote,
  getDraft,
  getListing,
  getNote,
  putDraft,
  putListing,
  putNote,
  type Draft,
} from "../cache";
import {
  forgetMirroredNote,
  mirroredAncestor,
  mirroredListing,
  mirroredTree,
  mirroredNote,
  putMirroredNotes,
  rememberMirroredFolders,
} from "../mirror";
import { neededEtags } from "../mirrorHolds";
import { openMirrorStore } from "../mirrorStore";
import type { KeyValueStore } from "../memory";
import {
  claimedPaths,
  counts,
  discard,
  dropOp as dropOpFrom,
  enqueue,
  find,
  forceMine,
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
} from "../outbox";
import type { DrainReport } from "../sync";
import type { CacheScope } from "../keys";
import type { Reachability } from "../copy";
import { newOpId } from "./reconcile";
import { PERSIST_DEBOUNCE_MS, type OfflineNotes } from "./contract";

/** Everything the object below closes over, from the render that builds it. */
export interface OfflineNotesInputs {
  workspaceId: string | null;
  scope: CacheScope | null;
  store: KeyValueStore;
  ready: boolean;
  reachability: Reachability;
  outbox: Outbox;
  lastDrain: DrainReport | null;
  mine: () => boolean;
  commit: (next: Outbox, immediate: boolean) => void;
  drain: () => void;
  rememberSent: (body: { path: string; text: string; etag: string }) => void;
  undoTo: (before: Outbox, after: Outbox) => () => boolean;
  epochRef: { readonly current: number };
  outboxRef: { readonly current: Outbox };
  draining: { readonly current: boolean };
  draftPending: { current: Draft | null };
  draftTimer: { current: ReturnType<typeof setTimeout> | null };
}

/**
 * The object `useOfflineNotes` returns, built inside that hook's `useMemo` and
 * under that memo's dependency list. A plain function so the hook file stays
 * the wiring: every value is handed in from the render that builds it, and the
 * refs are read when a method is called, exactly as the hook's own closures
 * read them.
 */
export function buildOfflineNotesApi({
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
}: OfflineNotesInputs): OfflineNotes {
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
    cachedTree: async (workspaceId) => {
      if (copies === null || copies.workspaceId !== workspaceId) return null;
      const mirror = await openMirrorStore();
      return mirror === null ? null : mirroredTree(mirror, copies.scope, copies.workspaceId);
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
}
