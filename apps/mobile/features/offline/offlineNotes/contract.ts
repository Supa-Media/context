import type { Cached, Draft } from "../cache";
import type { MirroredTree } from "../mirror";
import type { Outbox, OutboxCounts, PendingWrite } from "../outbox";
import type { DrainReport } from "../sync";
import type { Reachability } from "../copy";
import type { FolderListing, OpenNote } from "../../console/files/types";

/*
  What `useOfflineNotes` hands the file browser, and the one timing constant
  it shares with its callers. Moved out of `useOfflineNotes.ts`, which
  re-exports all of it; "the file comment" below means that file's.
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
  rememberBody: (body: { path: string; text: string; etag: string; rawEtag?: string }) => void;
  rememberListing: (listing: FolderListing) => void;
  cachedNote: (path: string) => Promise<Cached<OpenNote> | null>;
  cachedListing: (path: string) => Promise<Cached<FolderListing> | null>;
  /**
   * Every folder's listing this device holds for `workspaceId`, from the
   * mirror's index in one pass — what the tree is drawn from before, and
   * instead of, asking the bucket folder by folder. `null` with no mirror, at
   * an unknown clearance, or for any context but the one this hook is for.
   * `listedAt` is when the walk behind it started; `complete` is whether that
   * walk named everything, so a folder it does not name is gone.
   */
  cachedTree: (workspaceId: string) => Promise<MirroredTree | null>;
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
