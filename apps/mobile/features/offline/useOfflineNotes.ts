import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clearDraft,
  getDraft,
  getListing,
  getNote,
  getOutbox,
  putDraft,
  putListing,
  putNote,
  putOutbox,
  sweep,
  type Cached,
  type Draft,
} from "./cache";
import { openStore } from "./store";
import type { KeyValueStore } from "./memory";
import {
  counts,
  discard,
  emptyOutbox,
  enqueue,
  find,
  forceMine,
  retry,
  settle,
  type Outbox,
  type OutboxCounts,
  type PendingWrite,
} from "./outbox";
import { drainOutbox, type DrainReport, type WriteOutcome } from "./sync";
import { useReachability } from "./reachability";
import type { Reachability } from "./copy";
import type { FolderListing, OpenNote } from "../console/files/types";

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
 */

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

  /** The unsaved, un-queued draft for a note, if there is one. */
  savedDraft: (path: string) => Promise<Draft | null>;
  rememberDraft: (draft: Draft) => void;
  forgetDraft: (path: string) => void;

  pendingFor: (path: string) => PendingWrite | undefined;
  /** Queue a save that cannot be made now. */
  queueSave: (save: { path: string; text: string; baseEtag: string | null }) => void;
  /** The person took the bucket's version: the queued draft goes. */
  dropQueued: (path: string) => void;
  /** The person kept theirs: re-base onto the version they were shown. */
  keepQueued: (path: string) => void;
  /** Put a parked refusal back in the queue, unchanged. */
  retryQueued: (path: string) => void;

  /** Try to empty the queue now. A no-op while one is already running. */
  drain: () => void;
  /** What the last drain did, for the console to report. `null` until one runs. */
  lastDrain: DrainReport | null;
}

export function useOfflineNotes(options: {
  workspaceId: string | null;
  /** Performs one queued write against the control plane. */
  write: (write: PendingWrite) => Promise<WriteOutcome>;
  /** Called for each write that landed, so the editor can take the new etag. */
  onWritten?: (result: { path: string; etag: string }) => void;
}): OfflineNotes {
  const { workspaceId } = options;
  const reachability = useReachability();

  // One store for the life of the app. `openStore` probes the platform, and
  // doing that per render would be a `localStorage` write per render.
  const storeRef = useRef<KeyValueStore | null>(null);
  if (storeRef.current === null) storeRef.current = openStore();
  const store = storeRef.current;

  const [outbox, setOutbox] = useState<Outbox>(() => emptyOutbox(workspaceId ?? ""));
  const [ready, setReady] = useState(false);
  const [lastDrain, setLastDrain] = useState<DrainReport | null>(null);

  const outboxRef = useRef(outbox);
  outboxRef.current = outbox;

  const persistTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const draftPending = useRef<Draft | null>(null);
  const draining = useRef(false);

  /*
    The callbacks below outlive the render that made them — a drain runs
    seconds after the reconnection that started it — so the injected write and
    the notification go through refs rather than being captured. Without this
    every one of them would be rebuilt on each render and the drain effect
    would re-fire on each render with it.
  */
  const writeRef = useRef(options.write);
  writeRef.current = options.write;
  const onWrittenRef = useRef(options.onWritten);
  onWrittenRef.current = options.onWritten;

  const flush = useCallback(
    (next: Outbox) => {
      if (persistTimer.current !== null) {
        clearTimeout(persistTimer.current);
        persistTimer.current = null;
      }
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
    [store],
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
        void putOutbox(store, outboxRef.current).catch(() => {});
      }, PERSIST_DEBOUNCE_MS);
    },
    [flush, store],
  );

  /** Read the queue for this context back off the store. */
  useEffect(() => {
    let cancelled = false;
    setReady(false);
    if (workspaceId === null) {
      setOutbox(emptyOutbox(""));
      return;
    }
    void getOutbox(store, workspaceId).then((loaded) => {
      if (cancelled) return;
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
    void sweep(store, { now: Date.now() }).catch(() => {});
  }, [ready, store]);

  useEffect(
    () => () => {
      if (persistTimer.current !== null) clearTimeout(persistTimer.current);
      if (draftTimer.current !== null) clearTimeout(draftTimer.current);
    },
    [],
  );

  const drain = useCallback(() => {
    if (draining.current || workspaceId === null) return;
    const current = outboxRef.current;
    if (current.writes.length === 0) return;
    draining.current = true;

    void drainOutbox(current, {
      write: (write) => writeRef.current(write),
      now: () => Date.now(),
      onWritten: (result) => onWrittenRef.current?.({ path: result.path, etag: result.etag }),
    })
      .then(({ outbox: next, report }) => {
        /*
          Anything queued *while* the drain was running is in `outboxRef` and
          not in `next`, which was derived from the snapshot the drain started
          with. Re-applying the drain's result over the newer state — rather
          than replacing it — is what stops a save made mid-drain from being
          silently dropped.
        */
        commit(reconcile(outboxRef.current, next, report), true);
        setLastDrain(report);
      })
      .catch(() => {
        // `drainOutbox` does not throw; an injected `write` that rejects rather
        // than resolving an outcome would land here. The queue is untouched, so
        // the next reconnection tries again.
      })
      .finally(() => {
        draining.current = false;
      });
  }, [commit, workspaceId]);

  /** Empty the queue whenever we believe we can reach the bucket. */
  useEffect(() => {
    if (!ready || reachability === "offline") return;
    drain();
  }, [drain, reachability, ready]);

  const api = useMemo<OfflineNotes>(() => {
    const scope = workspaceId ?? "";
    return {
      ready,
      durable: store.durable,
      reachability,
      outbox,
      counts: counts(outbox),

      rememberNote: (note) => {
        if (workspaceId === null) return;
        void putNote(store, scope, note, Date.now()).catch(() => {});
      },
      rememberBody: (body) => {
        if (workspaceId === null) return;
        void getNote(store, scope, body.path)
          .then((cached) => {
            if (cached === null) return;
            return putNote(
              store,
              scope,
              { ...cached.value, text: body.text, etag: body.etag },
              Date.now(),
            );
          })
          .catch(() => {});
      },
      rememberListing: (listing) => {
        if (workspaceId === null) return;
        void putListing(store, scope, listing, Date.now()).catch(() => {});
      },
      cachedNote: async (path) => (workspaceId === null ? null : getNote(store, scope, path)),
      cachedListing: async (path) =>
        workspaceId === null ? null : getListing(store, scope, path),

      savedDraft: async (path) => (workspaceId === null ? null : getDraft(store, scope, path)),
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
          if (latest !== null) void putDraft(store, scope, latest).catch(() => {});
        }, PERSIST_DEBOUNCE_MS);
      },
      forgetDraft: (path) => {
        if (workspaceId === null) return;
        // Cancel anything still in flight for this note first, or the debounced
        // write lands a second after the clear and resurrects it.
        if (draftPending.current?.path === path) draftPending.current = null;
        void clearDraft(store, scope, path).catch(() => {});
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
      pendingFor: (path) => find(outboxRef.current, path),
      queueSave: (save) =>
        commit(enqueue(outboxRef.current, { ...save, now: Date.now() }), false),
      // The three below all take work *out* of the queue or change what it will
      // do, so they are written through rather than debounced.
      dropQueued: (path) => commit(discard(outboxRef.current, path), true),
      keepQueued: (path) => commit(forceMine(outboxRef.current, path), true),
      retryQueued: (path) => commit(retry(outboxRef.current, path), true),

      drain,
      lastDrain,
    };
  }, [commit, drain, lastDrain, outbox, reachability, ready, store, workspaceId]);

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
export function reconcile(live: Outbox, drained: Outbox, report: DrainReport): Outbox {
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

  return result;
}

function patch(outbox: Outbox, path: string, fields: Partial<PendingWrite>): Outbox {
  return {
    ...outbox,
    writes: outbox.writes.map((write) =>
      write.path === path ? { ...write, ...fields } : write,
    ),
  };
}
