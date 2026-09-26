/**
 * The live file editor.
 *
 * Binds the pure modules in this folder to the Convex actions in
 * `apps/convex/functions/files.ts`. Everything interesting — the marker rule,
 * the conflict handling, what a paste turns into — lives in those modules and
 * is tested without a renderer; this is the wiring.
 *
 * Two things it does that are worth knowing about:
 *
 *  - **Listings are fetched per folder, and refreshed per folder.** Convex
 *    actions are not reactive (they cannot be — the data is in the customer's
 *    bucket, not in a Convex table), so there is no subscription to lean on.
 *    After a change, only the folders that change touched are refetched, which
 *    is what stops an expanded tree from collapsing and reloading itself every
 *    time somebody renames a file.
 *  - **Nothing is applied optimistically.** A rename that failed but already
 *    moved on screen is a console telling you your bucket contains something
 *    it does not, which is the one thing this product cannot afford to do.
 */

import type { FileBrowser } from "./browser";
import { isDirty } from "./editor";
import type { FileBrowserOptions } from "./fileBrowser/types";
import { useFileActions } from "./fileBrowser/useFileActions";
import { useBrowserState } from "./fileBrowser/useBrowserState";
import { useWritesAndImages } from "./fileBrowser/useWritesAndImages";
import { useOfflineQueue } from "./fileBrowser/useOfflineQueue";
import { useNoteReads } from "./fileBrowser/useNoteReads";
import { useListings } from "./fileBrowser/useListings";
import { useOpenNote } from "./fileBrowser/useOpenNote";
import { useRunOperation } from "./fileBrowser/useRunOperation";
import { useSaving } from "./fileBrowser/useSaving";
import { useConflictsAndDrafts } from "./fileBrowser/useConflictsAndDrafts";
import { useQueuedOps } from "./fileBrowser/useQueuedOps";
import { useCreateAndMove } from "./fileBrowser/useCreateAndMove";
import { useContextMoves } from "./fileBrowser/useContextMoves";
import { useRowCommands } from "./fileBrowser/useRowCommands";
import { useBatch } from "./fileBrowser/useBatch";
import { useVisibility } from "./fileBrowser/useVisibility";
import { useShares } from "./fileBrowser/useShares";
import { useShareScope } from "./fileBrowser/useShareScope";
import { usePendingOps } from "./fileBrowser/usePendingOps";
import { useLinkedTitle } from "./fileBrowser/useLinkedTitle";
import { useFileBrowserValue } from "./fileBrowser/useFileBrowserValue";

export { draftIsKept } from "./fileBrowser/copy";
export { INSTANT_OPEN_MS, OPERATION_TIMEOUT_MS } from "./fileBrowser/timing";

/*
  The hook is a sequence of parts, each in its own file under `fileBrowser/`,
  called here in the order the code inside them used to run in this one
  function. That order is load-bearing: it is the order React sees the hooks
  in, and each part is handed everything the parts before it declared (the
  same values, not copies), which is all the code in it closes over.

  One declaration moved rather than just changing file: `listingsRef`, which
  used to sit near the end and was read, from callbacks, by code above it.
  It is now declared straight after `listings` in `useOfflineQueue`; see the
  comment there.
*/
export function useFileBrowser(options: FileBrowserOptions): FileBrowser {
  const bound = { options, ...useFileActions({ options }) };
  const withBrowserState = { ...bound, ...useBrowserState() };
  const withWritesAndImages = { ...withBrowserState, ...useWritesAndImages(withBrowserState) };
  const withOfflineQueue = { ...withWritesAndImages, ...useOfflineQueue(withWritesAndImages) };
  const withNoteReads = { ...withOfflineQueue, ...useNoteReads(withOfflineQueue) };
  const withListings = { ...withNoteReads, ...useListings(withNoteReads) };
  const withOpenNote = { ...withListings, ...useOpenNote(withListings) };
  const withRunOperation = { ...withOpenNote, ...useRunOperation(withOpenNote) };
  const withSaving = { ...withRunOperation, ...useSaving(withRunOperation) };
  const withConflictsAndDrafts = { ...withSaving, ...useConflictsAndDrafts(withSaving) };
  const withQueuedOps = { ...withConflictsAndDrafts, ...useQueuedOps(withConflictsAndDrafts) };
  const withCreateAndMove = { ...withQueuedOps, ...useCreateAndMove(withQueuedOps) };
  const withContextMoves = { ...withCreateAndMove, ...useContextMoves(withCreateAndMove) };
  const withRowCommands = { ...withContextMoves, ...useRowCommands(withContextMoves) };
  const withBatch = { ...withRowCommands, ...useBatch(withRowCommands) };
  const withVisibility = { ...withBatch, ...useVisibility(withBatch) };
  const withShares = { ...withVisibility, ...useShares(withVisibility) };
  const withShareScope = { ...withShares, ...useShareScope(withShares) };
  const withPendingOps = { ...withShareScope, ...usePendingOps(withShareScope) };
  const withLinkedTitle = { ...withPendingOps, ...useLinkedTitle(withPendingOps) };
  return useFileBrowserValue(withLinkedTitle);
}

/** Exported for the editor's unsaved-changes guard in the pane. */
export { isDirty };
