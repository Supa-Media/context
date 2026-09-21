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

import { isDrawingPath, newDrawing } from "@context/drawings";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ConvexError } from "convex/values";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { onBucketWrite } from "./bucketWrites";
import { dataUrlFor } from "./imageBytes";
import {
  isServerRefusal,
  toFileError,
  type ContextMoveProgress,
  type FileBrowser,
  type MoveDestination,
} from "./browser";
import type {
  FormOutcome,
  FormResponsesOutcome,
  FormResponseRetract,
  FormResponseUpdate,
  FormSubmission,
  FormVote,
} from "./formBlock";
import type { NoteShare } from "./shares";
import { shareUrl } from "./shares";
import { scopeOf, stepsTo, type NoteScope } from "./scope";
import { createPressQueue } from "./pressQueue";
import { collectNotes, downloadNotice, pathsUnder } from "./download";
import { buildZip, downloadName } from "./zip";
import { saveFile } from "./saveFile";
import type { ToastSpec } from "../../design/components/Toast";
import { copyDeferred } from "../../design/clipboard";
import { consoleOrigin } from "./shareOrigin";
import { noteHref } from "../nav";
import { afterPaste, planPaste, put, type Clipboard } from "./clipboard";
import {
  SAVE_TIMEOUT_MS,
  autosaves,
  editorReducer,
  emptyEditor,
  guardLeaving,
  isDirty,
} from "./editor";
import { createAutosaveController, type AutosaveController } from "./autosave";
import {
  ancestorsOf,
  baseName,
  describeMoveProblem,
  describeNameProblem,
  displayName,
  displayPath,
  ensureMarkdown,
  joinPath,
  mergeLinkPaths,
  parentPath,
  isMarkdown,
  withoutSortPrefix,
} from "./paths";
import { raceTimeout } from "../storage/timeout";
import { useOfflineNotes } from "../../offline/useOfflineNotes";
import { holdAncestors, releaseAncestors } from "../../offline/mirrorHolds";
import { useMirrorStatus } from "../../offline/mirrorStatus";
import { restoreFor } from "../../offline/restore";
import { type WriteOutcome } from "../../offline/sync";
import { queuedOpSender, queuedWriteSender } from "./queuedWrite";
import { localPathOf, opsOf, type PendingOp, type PendingWrite } from "../../offline/outbox";
import { overlayListings, overlayKey } from "../../offline/overlay";
import type { OpOutcome, OpSent } from "../../offline/sync";
import { NOT_CACHED, cachedNotice } from "../../offline/copy";
import { KEEP_MINE_OFFLINE } from "../../offline/resolution";
import { useConflictReview } from "./useConflictReview";
import { findEntry, foldersToRefresh, namesIn } from "./tree";
import { isUntitled, nameFromTitle, untitledName } from "./untitled";
import { isGroupVisibility } from "./types";
import {
  applyFolderCreate,
  applyMove,
  rekeyPath,
  rekeyPaths,
  subtreeOf,
  undoFolderCreate,
} from "./optimistic";
import type { FolderListing, OpenNote, SettableVisibility } from "./types";
import { canResetPrivacy, canSetVisibility, canShare } from "../capabilities";
import type { VisibilityTier } from "../visibility";
import type { AppliedPluginNoteWrite } from "../plugins/runtime";
import { describeOp, pendingMarks } from "./pendingMarks";

/**
 * Where the draft for a note nobody is looking at actually is.
 *
 * Said out loud because the alternative is a notice about a save that did not
 * land and no answer to "so where is what I typed". It is on the device — and
 * how much that is worth depends on whether the store is durable, exactly as
 * the queued-save message does: a browser refusing `localStorage` gives a copy
 * that lives as long as the tab, and telling somebody it is kept there would
 * be a durability claim the console cannot make.
 */
export function draftIsKept(durable: boolean): string {
  return durable
    ? "Its draft is kept on this device — open the note to try again."
    : "Its draft is held for this session — open the note to try again. Closing the app loses it.";
}

/**
 * How long to wait for one file operation before giving the toolbar back.
 *
 * Longer than `SAVE_TIMEOUT_MS` (30s), and for the same reason
 * `CONNECT_TIMEOUT_MS` is: a save is one conditional PUT, while the operations
 * behind `run` are whole-tree jobs. A folder move, copy, delete or visibility
 * cascade walks the prefix and issues a bucket round trip per object, each with
 * its own 10s deadline in `functions/files.ts`, so a directory of any size is
 * legitimately many seconds of sequential I/O. 45s is generous enough that a
 * real folder operation over a slow provider is not cut off, and short enough
 * that nobody sits in front of a dead toolbar wondering.
 */
export const OPERATION_TIMEOUT_MS = 45_000;

/**
 * How long an online open waits for the bucket before showing the mirror's
 * copy. See `openNote`: long enough that an ordinary connection answers first
 * and nothing flickers, short enough that a slow one does not leave somebody
 * looking at a spinner over a note that is already on their device.
 */
export const INSTANT_OPEN_MS = 250;

/**
 * What to say when we stopped waiting.
 *
 * It does not claim the operation failed, because we do not know: the request
 * may have landed and only the answer was lost. Saying "try again" here is how
 * somebody retries a rename that already succeeded and gets told the name is
 * taken — so the sentence points at the list instead.
 */
const TIMED_OUT_MESSAGE =
  "That is taking too long, so we stopped waiting. It may still have gone through — check the list before trying it again.";

/**
 * The mutation worked; reloading the listing afterwards did not.
 *
 * Reported separately from a failure because they are opposite facts. Folding
 * the two together is what told somebody a successful rename "did not work",
 * and the retry they were invited to make then failed on the duplicate name.
 */
/**
 * An operation that cannot wait for a connection, asked for without one — a
 * duplicate, a paste, a visibility change. Said at once, because saying it
 * after the operation timeout would be "we do not know" about a request that
 * was never made.
 */
const NEEDS_CONNECTION =
  "You are offline, so that was not done. It needs a connection — new notes, renames, moves, archiving and deleting are the things that can wait for one.";

/** A name the offline queue is holding for something else. See `claimedPaths`. */
function claimedMessage(name: string): string {
  return `${name} has a change waiting to sync. Choose another name, or use this one once it has synced.`;
}

/** A folder operation asked for offline. See the offline section of `rename`. */
const FOLDER_NEEDS_CONNECTION =
  "Renaming, moving, archiving or deleting a folder needs a connection. A folder's notes can change on other devices while this one is offline, and there is no single version of a folder to check that against.";

/** A note whose version this device does not hold. */
const NOT_ON_DEVICE =
  "This note is not on this device, so it cannot be changed offline. Open it once with a connection and try again.";

/**
 * Drawings are online-only to create. The drawing editor on a phone is never
 * kept offline (`drawingOffline.ts`), and on the web it is kept only once a
 * drawing has been opened online — so a drawing made offline could open as a
 * picture nobody can draw in. A note can be made now.
 */
const DRAWING_NEEDS_CONNECTION =
  "A new drawing needs a connection, because its editor may not be on this device yet. A note can be made offline.";

const STALE_LISTING_MESSAGE =
  "That worked, but the file list did not reload. What you see may be out of date.";

/**
 * A folder, as it should read in the middle of a sentence.
 *
 * The root is `""`, and "Moved to ." is not a sentence. Every other place that
 * has to name the root spells it out too — the move picker's `detail`, the new
 * note dialog's description — so this says the same thing they do about *that*.
 *
 * It says something different about the folders below it, and deliberately:
 * `displayPath` drops their sort numbers, because this is a sentence somebody
 * reads about a move that has already happened, and it should name the folder
 * the way the tree, the crumb and the folder's own heading just named it. The
 * picker keeps the real keys, which is the opposite decision for the opposite
 * reason — there the string is a destination being chosen, not a place being
 * reported.
 */
function folderLabel(folder: string): string {
  return folder === "" ? "the root of your context" : displayPath(folder);
}

type Listings = Record<string, FolderListing | undefined>;

export function useFileBrowser(options: {
  workspaceId: string | null;
  canEdit: boolean;
  readOnlyReason?: string;
  /**
   * Whether the caller owns this context.
   *
   * Separate from `canEdit`, which an `editor` also has. Only the owner may
   * rewrite the access map, so this is what decides whether the repair control
   * exists — see `canResetPrivacy` on `FileBrowser`.
   */
  isOwner?: boolean;
  /**
   * How much of this context the person at the keyboard can see.
   *
   * Not derivable from `isOwner`, and that is the point: `isOwner === false`
   * covers both "an editor" and "the context list has not landed yet", and
   * those two need opposite answers from a cache. `visibilityTierForRole` is
   * the one place this app decides it, so it is passed rather than re-derived
   * — see `features/offline/keys.ts` for what a copy taken at the wrong
   * clearance costs.
   */
  tier: VisibilityTier;
  /**
   * The context's slug, for the readable team link (`/console/@slug?note=…`).
   *
   * Absent means no team link can be built, and `copyShareLink` copies nothing
   * rather than handing back a URL with `undefined` in it.
   */
  slug?: string;
  /**
   * Whether this bucket's connect-time probe found real conditional writes.
   *
   * Passed in rather than read here, because the binding is a Convex query the
   * console already holds and a second subscription to it would be a second
   * answer that can disagree. `undefined` while it is loading, which the copy
   * treats as "do not claim either way".
   */
  conditionalWrite?: boolean;
  /**
   * The other contexts this person could move something into.
   *
   * Passed in rather than queried here, because the console already holds the
   * list — `listMyWorkspaces`, one subscription — and a second one would be a
   * second answer that can disagree with the rail. Filtered to what the
   * *destination* side needs (`editor` and above there); whether the **source**
   * side allows a move at all is `isOwner`, and this hook applies that itself
   * rather than trusting the caller to have done both.
   */
  destinations?: readonly MoveDestination[];
}): FileBrowser {
  const workspaceId = options.workspaceId as Id<"workspaces"> | null;
  const slug = options.slug ?? null;

  const listFiles = useAction(api.functions.files.listFiles);
  const readNote = useAction(api.functions.files.readNote);
  const readNotesAction = useAction(api.functions.files.readNotes);
  const searchContext = useAction(api.functions.files.searchContext);
  const notePathsAction = useAction(api.functions.files.notePaths);
  const writeNote = useAction(api.functions.files.writeNote);
  const submitFormAction = useAction(api.functions.forms.submitForm);
  const storeNoteImageAction = useAction(api.functions.files.storeNoteImage);
  const readNoteImageAction = useAction(api.functions.files.readNoteImage);
  /**
   * Every image this session has already fetched, by workspace and key.
   *
   * A ref rather than state: nothing re-renders when it changes — the `<img>`
   * that asked is handed the src directly — and a state update per image would
   * re-render the whole browser once per picture in the note.
   */
  const imageCache = useRef(new Map<string, string>());
  const voteFormAction = useAction(api.functions.forms.voteForm);
  const updateSubmissionAction = useAction(api.functions.forms.updateSubmission);
  const retractSubmissionAction = useAction(api.functions.forms.retractSubmission);
  const createDirectory = useAction(api.functions.files.createDirectory);
  const moveEntry = useAction(api.functions.files.moveEntry);
  const folderPathsAction = useAction(api.functions.files.folderPaths);
  const startContextMoveAction = useAction(api.functions.contextMoves.startContextMove);
  const resumeContextMoveAction = useAction(api.functions.contextMoves.resumeContextMove);
  const dismissContextMoveMutation = useMutation(api.functions.contextMoves.dismissContextMove);
  const copyEntry = useAction(api.functions.files.copyEntry);
  const duplicateEntry = useAction(api.functions.files.duplicateEntry);
  const archiveEntry = useAction(api.functions.files.archiveEntry);
  const trashEntry = useAction(api.functions.files.trashEntry);
  const restoreTrashEntry = useAction(api.functions.files.restoreTrashEntry);
  const setNoteVisibility = useAction(api.functions.files.setNoteVisibility);
  const setNoteGroupAction = useAction(api.functions.files.setNoteGroup);
  const setFolderGroupAction = useAction(api.functions.files.setFolderGroup);
  const setDirectoryVisibility = useAction(api.functions.files.setDirectoryVisibility);
  const resetPrivacyAction = useAction(api.functions.files.resetPrivacy);
  const updateStorageLayoutAction = useAction(api.functions.files.updateStorageLayout);

  /*
    What the bucket (or, offline, the mirror) listed. What the console *draws*
    is `listings`, below: these with the offline queue's renames, deletes, new
    notes and new folders laid over them (`overlay.ts`).
  */
  const [bucketListings, setListings] = useState<Listings>({});
  /**
   * Every note path the search index's docmap knows about for this context,
   * or `null` while there is nothing to answer from — no index yet, offline,
   * or the request has not landed. See `linkPaths` below for what this is
   * merged with, and `docs/decisions/app-and-console.md` "L1" for why the
   * docmap rather than a second listing.
   */
  const [indexedPaths, setIndexedPaths] = useState<readonly string[] | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  /**
   * How many times `select` has moved somewhere. See `navigations` on
   * `FileBrowser` for what reads it and why a path alone cannot answer it.
   *
   * State rather than a ref, because its consumer is an effect
   * (`useNoteAddress`) and a ref change does not run one — the whole point is
   * that the commit carrying a new selection also carries the fact that
   * somebody navigated to it.
   */
  const [navigations, setNavigations] = useState(0);
  /*
    The selection whose contents are still on their way. See `opening` in
    `browser.ts` for what reads it and why the pane cannot infer it from
    `selectedPath` and `editor` alone.

    Cleared with a functional update comparing against the path that set it, so
    a slow read for a note somebody has already navigated away from cannot
    clear the flag belonging to the one they are waiting on now.
  */
  const [opening, setOpening] = useState<string | null>(null);
  const settleOpening = useCallback((path: string) => {
    setOpening((current) => (current === path ? null : current));
  }, []);
  const [editor, dispatch] = useReducer(editorReducer, emptyEditor);
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [toasts, setToasts] = useState<readonly ToastSpec[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  // The reducer's state, readable from callbacks without making every callback
  // depend on it — `guardLeaving` has to see the *current* draft, not the one
  // captured when the row was rendered.
  const editorRef = useRef(editor);
  editorRef.current = editor;

  /*
    The selection, readable from a callback that outlives the render that made
    it. An undo runs seconds after the operation it inverts, by which time the
    `selectedPath` captured in that render may be somebody else's.
  */
  const selectedPathRef = useRef(selectedPath);
  selectedPathRef.current = selectedPath;

  /*
    Toast identity. A counter rather than the message or the path, because two
    archives of the same note in one session would collide on either of those
    and React would reuse the first toast's element — including its timer, which
    is what decides when the undo goes away.
  */
  const nextToastId = useRef(0);
  const dismissToast = useCallback(
    (id: string) => setToasts((current) => current.filter((toast) => toast.id !== id)),
    [],
  );

  /**
   * Say something transient that is nobody's operation.
   *
   * A refused paste is the first of these: it is not the result of a row
   * command, so it has no undo and does not belong in the `notice` line, which
   * is about the console's own state. `nextToastId` rather than the message for
   * identity, for the reason that counter's own comment gives.
   */
  const say = useCallback((message: string) => {
    nextToastId.current += 1;
    setToasts([{ id: `say-${nextToastId.current}`, message }]);
  }, []);

  /**
   * The generation counter and timer handle for the save in flight, **per
   * note**.
   *
   * The same shape `createReverifyController` uses, and for the same reason: a
   * response that arrives after its own attempt was abandoned must not be able
   * to settle anything. Here the counter is bumped both when a new save starts
   * *and* when one times out, so a write that lands after we stopped waiting is
   * discarded rather than being allowed to mark the editor clean against a
   * draft the person has since typed more into.
   *
   * **Keyed by path, which it was not before autosave.** One counter was
   * enough while `guardLeaving` refused to leave a note with a save in flight:
   * only one save could exist. Now leaving flushes instead of refusing, so a
   * write for the note you just left is routinely still in the air when the
   * next one starts — and a single counter would let the second save silently
   * discard the first one's answer, skipping the cache bookkeeping that keeps
   * a device copy from resurrecting a draft that was written.
   */
  const saveRuns = useRef(new Map<string, number>());
  const saveTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  /**
   * The generation of the toolbar operation in flight.
   *
   * Same job as `saveRun`: an operation that answers after its own attempt was
   * abandoned must not be able to touch `busy` or `notice`, because by then
   * those belong to whatever the person did next.
   */
  const operationRun = useRef(0);

  /**
   * The generation of the note (or context) `openNote` is answering for.
   *
   * The same shape as `operationRun`, for a read rather than a write: a read
   * answers the request that made it, or nobody. `openNote` closes over
   * `workspaceId` and has no other way to tell "the read I started" from "the
   * read that happens to resolve while I am waiting" — two contexts and two
   * quick opens both look identical to a promise that has already gone out.
   *
   * Bumped in three places, each a moment nothing already on screen may be
   * answered into: the "load whenever context changes" effect (a read for the
   * *previous* context settling in the new one is note A's body under note
   * B's chrome), `openNote` itself (a second open makes the first one's
   * eventual answer stale, whatever path it was for), and `deselect` (closing
   * the note is not itself an open, but it is exactly as invalidating as one —
   * without this bump a read in flight when somebody closes the note would
   * spring the editor back open with content nobody asked for any more).
   *
   * Captured at the start of `openNote`, compared just before every dispatch
   * and `setNotice` that would otherwise let a stale answer speak for the
   * request now in flight (or for nothing in flight at all).
   */
  const openRun = useRef(0);

  /**
   * The autosave timers, and the one function they are allowed to call.
   *
   * The controller is created once for the life of the hook, so it cannot be
   * rebuilt — with its pending timers dropped — by a render. What it calls goes
   * through a ref for the same reason every other callback here does: `save`
   * would otherwise capture the first render's `performSave` and write with a
   * `workspaceId` from before a context switch.
   */
  const autosaveNowRef = useRef<(path: string) => void>(() => {});
  const autosaveRef = useRef<AutosaveController | null>(null);
  if (autosaveRef.current === null) {
    autosaveRef.current = createAutosaveController({
      schedule: (fn, ms) => setTimeout(fn, ms),
      cancel: (handle) => clearTimeout(handle),
      save: (path) => autosaveNowRef.current(path),
    });
  }
  const autosave = autosaveRef.current;

  useEffect(
    () => () => {
      for (const timer of saveTimers.current.values()) clearTimeout(timer);
      saveTimers.current.clear();
      autosave.dispose();
    },
    [autosave],
  );

  /* ------------------------------- offline -------------------------------- */

  /**
   * One queued write, sent through the same action the Save button uses.
   *
   * This is the whole reason a drained write is as safe as an online one: it is
   * not a second write path, it is `writeNote` with the etag the draft was
   * typed against, so it gets the server's `onlyIf: { etagMatches }` where the
   * bucket supports one and its read-compare where it does not — and the same
   * `CONFLICT`, with the same `currentEtag`, when somebody got there first.
   *
   * The write itself now lives in `queuedWrite.ts`, because there are two
   * things that empty a queue: this one for the open context, and
   * `useBackgroundDrain` for every other. One definition of what a queued
   * write *is*, bound here to the context on screen and there to the one each
   * queue is filed under — two copies would be two places for a `force` flag
   * or a dropped `expectedEtag` to appear.
   */
  const sendTo = useMemo(() => queuedWriteSender(writeNote), [writeNote]);
  const sendQueued = useCallback(
    async (pending: PendingWrite): Promise<WriteOutcome> => {
      if (workspaceId === null) return { kind: "failed", message: "No context is open." };
      return sendTo(workspaceId, pending);
    },
    [sendTo, workspaceId],
  );

  /**
   * Send one filled-in form block, and phrase what came back.
   *
   * The one write on this hook that does **not** go through
   * `api.functions.files` — see `FileBrowser.submitForm` for why a `member`
   * needs a path of its own. The note it names is the open one, read here
   * rather than taken from the widget: the widget knows which *form* was
   * pressed and this knows which note is on screen, and a widget that carried
   * a path would be a caller naming the file its submission lands beside.
   *
   * Resolves in both directions. A refusal from the server is a sentence
   * somebody wrote for exactly this case — "this form takes responses from
   * editors and above", "that response file cannot be read" — so it is passed
   * through rather than replaced with a generic one.
   */
  /**
   * The bytes behind an image the open note embeds.
   *
   * The note is read from `selectedPathRef` rather than taken from the widget,
   * for the reason `submitForm` gives: the widget knows which *image* is being
   * drawn and this knows which note is on screen. The server needs both, because
   * an image borrows its visibility from the notes that reference it — a widget
   * that carried a note path would be a caller choosing which note vouches for
   * the image it is asking for.
   *
   * Cached on the key, forever, and that is safe because the key is a content
   * hash: the same key is the same bytes, in this session and in every other.
   * The cache is what makes a row survive a keystroke — `toDOM` runs again on
   * every rebuild, and without it every character typed in a note with an image
   * in it would be a round trip to the bucket.
   *
   * `null` for every failure, deliberately: a missing image, an image in a note
   * this viewer cannot see, and a store that is down all draw the same absence,
   * and the row says so in its own words rather than reporting a server error
   * somebody reading a note can do nothing about.
   */
  const loadImage = useCallback(
    async (target: string): Promise<string | null> => {
      if (workspaceId === null) return null;
      const notePath = selectedPathRef.current;
      if (notePath === null) return null;
      const cacheKey = `${workspaceId}|${target}`;
      const cached = imageCache.current.get(cacheKey);
      if (cached !== undefined) return cached;
      try {
        const read = await readNoteImageAction({ workspaceId, notePath, leaf: target });
        const src = dataUrlFor(read.bytes, read.contentType);
        imageCache.current.set(cacheKey, src);
        return src;
      } catch {
        return null;
      }
    },
    [workspaceId, readNoteImageAction],
  );

  /**
   * Store a pasted or dropped image, and answer with the key to embed.
   *
   * The refusal is the server's sentence rather than a generic one — "a stored
   * image must be at most 5000000 bytes", "you do not have write access" — for
   * the same reason `submitForm` passes one through: somebody wrote those words
   * for exactly this moment, and the editor has nothing better to say.
   *
   * The returned key is put in the cache as well, so the image somebody just
   * pasted draws from the bytes already in hand instead of being read back out
   * of the bucket a moment after it was written.
   */
  const storeImage = useCallback(
    async (image: {
      bytes: ArrayBuffer;
      contentType: string;
    }): Promise<{ target: string } | { error: string }> => {
      if (workspaceId === null) return { error: "No context is open." };
      /*
        AN ENCRYPTED NOTE TAKES NO IMAGE, AND SAYS SO.

        The note's text is encrypted on this device and the bytes of an image are
        not: storing one beside it would put in the clear exactly what somebody
        turned encryption on to keep out of it, in the same bucket, under a name
        the note itself spells out. Encrypting attachments is real work —
        `encryption.md` scopes it — and until it is done the honest answer is a
        refusal a person can read, not a paste that quietly weakens the thing
        they asked for.
      */
      if (editorRef.current.encrypted) {
        return { error: "An encrypted note can’t hold an image yet." };
      }
      /*
        WHICH NOTE THE EMBED IS ABOUT TO LAND IN.

        An upload is a round trip, and the editor inserts the line when it comes
        back. Open another note in that window — a click in the tree, a link
        followed — and the insert would land in *that* note, which is an image
        appearing in a document nobody pasted into. The editor cannot notice:
        it is one view with notes swapped through it, and by then its state is
        the new note's.

        So the check is here, where the open note is already known, and it is
        made after the write rather than before: the bytes are in the bucket
        either way — content-addressed, so nothing is orphaned that a second
        paste would not reuse — and what is refused is the *insert*.
      */
      const noteAtStart = selectedPathRef.current;
      try {
        const stored = await storeNoteImageAction({
          workspaceId,
          bytes: image.bytes,
          contentType: image.contentType,
        });
        if (selectedPathRef.current !== noteAtStart) {
          imageCache.current.set(
            `${workspaceId}|${stored.leaf}`,
            dataUrlFor(image.bytes, image.contentType),
          );
          return {
            error: "That note closed before the image was stored. It is in your bucket.",
          };
        }
        imageCache.current.set(
          `${workspaceId}|${stored.leaf}`,
          dataUrlFor(image.bytes, image.contentType),
        );
        return { target: stored.leaf };
      } catch (error) {
        return { error: toFileError(error).message };
      }
    },
    [workspaceId, storeNoteImageAction],
  );

  const submitForm = useCallback(
    async (submission: FormSubmission): Promise<FormOutcome> => {
      if (workspaceId === null) return { ok: false, message: "No context is open." };
      const path = selectedPathRef.current;
      if (path === null) return { ok: false, message: "No note is open." };
      try {
        await submitFormAction({
          workspaceId,
          path,
          formId: submission.formId,
          values: submission.values.map((entry) => ({ ...entry })),
        });
        return { ok: true, message: "Sent. Thank you!" };
      } catch (error) {
        return { ok: false, message: toFileError(error).message };
      }
    },
    [workspaceId, submitFormAction],
  );

  /**
   * A drained write moves the open editor onto the etag the bucket now holds.
   *
   * Without this, the note you are looking at still carries the etag its
   * queued draft was typed against — which the drain has just superseded — and
   * your very next Save conflicts you against your own write of a moment ago.
   */
  const onDrained = useCallback((result: { path: string; etag: string }) => {
    const current = editorRef.current;
    /*
      The bucket's path, or the name this device shows it under: an edit of a
      note renamed here is sent to the note's old name, ahead of the rename,
      and the editor holding it is open at the new one.
    */
    const shownAt = offlineRef.current.localPathOf(result.path);
    if (current.path !== result.path && current.path !== shownAt) return;
    dispatch({ type: "queueSettled", etag: result.etag });
  }, []);

  /**
   * One queued rename, move, archive, delete or new folder — `queuedOpSender`,
   * bound to the context on screen exactly as `sendQueued` is, and for the same
   * reason: the background drain binds the same sender to each queue's own
   * context, and one definition is one place for the version to be required.
   */
  const sendOpTo = useMemo(
    () => queuedOpSender({ moveEntry, archiveEntry, trashEntry, createDirectory }),
    [archiveEntry, createDirectory, moveEntry, trashEntry],
  );
  const sendQueuedOp = useCallback(
    async (op: PendingOp): Promise<OpOutcome> => {
      if (workspaceId === null) return { kind: "failed", message: "No context is open." };
      return sendOpTo(workspaceId, op);
    },
    [sendOpTo, workspaceId],
  );

  /**
   * A queued rename reached the bucket: the open note follows it onto the
   * version the rename produced, so its next save is not a conflict with the
   * person's own rename. Guarded in the reducer on the version the editor was
   * holding (`rebased`).
   */
  const onOpDrained = useCallback((done: OpSent) => {
    if (done.kind !== "move" || done.etag === undefined || done.to === undefined) return;
    if (editorRef.current.path !== done.to) return;
    dispatch({ type: "rebased", from: opFromEtag.current.get(done.id) ?? null, etag: done.etag });
  }, []);
  /**
   * A tool wrote the open note, and presence has already merged the shared
   * document onto it.
   *
   * The etag moves so this client's next conditional save is checked against
   * the version the tool left rather than the one the editor opened — which
   * would otherwise be a conflict raised about a change already merged into
   * the text being saved. Everything else about the editor is untouched: the
   * draft is the merge, and it is still unsaved.
   */
  const onExternalWrite = useCallback((written: { path: string; etag: string | null }) => {
    if (written.etag === null) return;
    dispatch({ type: "externalWrite", path: written.path, etag: written.etag });
  }, []);

  /*
    **Who to tell when a save lands, and why it is a subscription.**

    A console save goes through the control plane's own file operation, not
    through the gateway's `write_note` — so the presence room has no other way
    to learn that the bucket moved, and every other member of the room keeps
    the etag their editor opened with. The moment the person who was saving
    leaves, the next one elected writes against a version two edits old and
    gets the conflict box this feature exists to delete.

    A subscription rather than a callback passed in, because the socket is
    opened from this browser's own state (`useNoteRoom` reads
    `data.files.editor.path`) — handing it back down here would be a cycle. So
    this emits, and whoever owns a room listens.
  */
  const savedListeners = useRef(new Set<(written: { path: string; etag: string }) => void>());
  const onSaved = useCallback((handler: (written: { path: string; etag: string }) => void) => {
    savedListeners.current.add(handler);
    return () => {
      savedListeners.current.delete(handler);
    };
  }, []);
  const announceSaved = useCallback((written: { path: string; etag: string }) => {
    for (const handler of [...savedListeners.current]) {
      try {
        handler(written);
      } catch {
        // A listener that throws must not fail the save that just succeeded.
      }
    }
  }, []);

  /*
    The version each op was sent with, by id — what `rebased` compares the
    editor against. Recorded as ops are sent rather than read off the queue,
    because by the time `onOpDone` runs the drain has already settled the op.
  */
  const opFromEtag = useRef(new Map<string, string | null>());
  const sendQueuedOpTracked = useCallback(
    (op: PendingOp) => {
      opFromEtag.current.set(op.id, op.baseEtag);
      return sendQueuedOp(op);
    },
    [sendQueuedOp],
  );

  const offline = useOfflineNotes({
    workspaceId,
    tier: options.tier,
    write: sendQueued,
    onWritten: onDrained,
    op: sendQueuedOpTracked,
    onOpDone: onOpDrained,
    folderDefaultFor: (path) => listingsRef.current[parentPath(path)]?.folderDefault ?? "private",
  });

  /*
    Read through a ref inside every callback below.

    `offline` is a fresh object whenever the queue changes — which is on every
    keystroke while offline — and a `refresh`/`select`/`save` that depended on
    it would be rebuilt just as often. `refresh` is a dependency of the effect
    that loads the root, so that is not a performance note: it is the render
    loop `consoleRenderLoop.test.ts` exists to catch. The rendered values
    (`reachability`, `counts`) come off `offline` itself; the behaviour reads
    the ref.
  */
  const offlineRef = useRef(offline);
  offlineRef.current = offline;

  /*
    The listings the console draws: the bucket's, with the queue laid over.

    Recomputed only when the queue's *shape* changes (`overlayKey` — which ops,
    which creates), never on a keystroke into a queued note: every callback
    below depends on `listings`, and rebuilding all of them per character is
    the churn `consoleRenderLoop.test.ts` watches for.
  */
  const overlayShape = useRef<{ key: string; outbox: typeof offline.outbox } | null>(null);
  const shapeKey = overlayKey(offline.outbox);
  if (overlayShape.current === null || overlayShape.current.key !== shapeKey) {
    overlayShape.current = { key: shapeKey, outbox: offline.outbox };
  }
  const shapedOutbox = overlayShape.current.outbox;
  const listings = useMemo(
    () => overlayListings(bucketListings, shapedOutbox),
    [bucketListings, shapedOutbox],
  );
  /** How much of this context is on the device — for `sync.mirror`. */
  const mirrorStatus = useMirrorStatus(workspaceId);

  /*
    The open note's version, held for the mirror's ancestor rule.

    A note can sit open and clean for ten minutes while a sync moves the
    device's copy on underneath it; the moment somebody then types, the draft
    is based on the version the editor opened, and a merge will need exactly
    that body. Neither the queue nor a draft names it yet, so the editor holds
    it itself (`mirrorHolds.ts`) — the etag it is showing, and the base of the
    draft it is holding, which differ once a conflict is open.
  */
  const editorHold = useRef(`editor:${Math.random().toString(36).slice(2)}`).current;
  useEffect(() => {
    holdAncestors(
      editorHold,
      workspaceId,
      editor.path === null ? {} : { [editor.path]: [editor.etag, editor.draftBase] },
    );
  }, [editor.draftBase, editor.etag, editor.path, editorHold, workspaceId]);
  useEffect(() => () => releaseAncestors(editorHold), [editorHold]);

  /**
   * Read a note **without** remembering it.
   *
   * The one caller is the conflict review, and the omission is the point: the
   * cache is holding the *ancestor* of the two versions being decided between,
   * and remembering the bucket's newer body over it would destroy the only
   * thing that makes a three-way merge possible. Every other read in this file
   * goes through `openNote`, which does remember.
   */
  const fetchNote = useCallback(
    async (path: string): Promise<OpenNote> => {
      if (workspaceId === null) throw new ConvexError({ code: "UNKNOWN", message: "No context." });
      // A note renamed here is still at its old name in the bucket.
      const read = await readNote({ workspaceId, path: offlineRef.current.serverPathOf(path) });
      return { ...read, path };
    },
    [readNote, workspaceId],
  );

  /**
   * `readRaw` on `FileBrowser`: a note's text and etag, for a view reading
   * several notes at once that are not "the open note" — see `browser.ts`.
   *
   * Bounded by `raceTimeout`, for the reason `run`'s own comment gives:
   * `readNote` is a Convex action with no client-side timeout, and offline it
   * neither resolves nor rejects. `null` covers every way this can fail to
   * answer — a refusal, a genuinely missing path, and a wait that timed out —
   * because a caller here has no "cached copy" to fall back to the way
   * `openNote` does, and the honest answer in all three cases is the same one
   * `read_channel_day` gives a caller who cannot see the path: not found.
   */
  const readRaw = useCallback(
    async (path: string): Promise<{ text: string; etag: string } | null> => {
      if (workspaceId === null) return null;
      const settled = await raceTimeout(readNote({ workspaceId, path }), {
        ms: OPERATION_TIMEOUT_MS,
        schedule: (fn, ms) => setTimeout(fn, ms),
        cancel: (handle) => clearTimeout(handle),
      });
      if (settled.kind !== "value") return null;
      return { text: settled.value.text, etag: settled.value.etag };
    },
    [readNote, workspaceId],
  );

  const readFormResponses = useCallback(
    async (responsesPath: string): Promise<FormResponsesOutcome> => {
      const note = await readRaw(responsesPath);
      return note === null
        ? { ok: false, message: "That response file is not available." }
        : { ok: true, text: note.text, message: "" };
    },
    [readRaw],
  );

  const voteForm = useCallback(
    async (vote: FormVote): Promise<FormOutcome> => {
      if (workspaceId === null) return { ok: false, message: "No context is open." };
      const path = selectedPathRef.current;
      if (path === null) return { ok: false, message: "No note is open." };
      try {
        await voteFormAction({ workspaceId, path, ...vote });
        return {
          ok: true,
          message: vote.vote === "up" ? "Vote added." : "Vote removed.",
        };
      } catch (error) {
        return { ok: false, message: toFileError(error).message };
      }
    },
    [voteFormAction, workspaceId],
  );

  const updateFormResponse = useCallback(
    async (change: FormResponseUpdate): Promise<FormOutcome> => {
      if (workspaceId === null) return { ok: false, message: "No context is open." };
      const path = selectedPathRef.current;
      if (path === null) return { ok: false, message: "No note is open." };
      try {
        await updateSubmissionAction({
          workspaceId,
          path,
          formId: change.formId,
          responseId: change.responseId,
          values: change.values.map((entry) => ({ ...entry })),
        });
        return { ok: true, message: "Response updated." };
      } catch (error) {
        return { ok: false, message: toFileError(error).message };
      }
    },
    [updateSubmissionAction, workspaceId],
  );

  const retractFormResponse = useCallback(
    async (change: FormResponseRetract): Promise<FormOutcome> => {
      if (workspaceId === null) return { ok: false, message: "No context is open." };
      const path = selectedPathRef.current;
      if (path === null) return { ok: false, message: "No note is open." };
      try {
        await retractSubmissionAction({ workspaceId, path, ...change });
        return { ok: true, message: "Response deleted." };
      } catch (error) {
        return { ok: false, message: toFileError(error).message };
      }
    },
    [retractSubmissionAction, workspaceId],
  );

  const conflict = useConflictReview({
    editor,
    fetchNote,
    ancestor: (path, baseEtag) => offlineRef.current.ancestorFor(offlineRef.current.serverPathOf(path), baseEtag),
    // `unknown` is treated as online: the read is what finds out, and refusing
    // to try would leave a cold load stuck on "cannot be read" forever.
    online: offline.reachability !== "offline",
    conditionalWrite: options.conditionalWrite,
  });
  const conflictRef = useRef(conflict);
  conflictRef.current = conflict;

  /**
   * Reload folders, from the bucket where it can be reached and from the device
   * where it cannot.
   *
   * **It answers whether anything came off the device, and callers have to use
   * that.** A tree redrawn from a cached listing is not a reloaded tree: it is
   * the same picture as before, and if an operation has just changed the bucket
   * it is a picture that is now wrong. `run` turns that into the same "the file
   * list did not reload" line a failed refresh has always produced, because it
   * is the same fact. Swallowing it would put the console back in the state it
   * already learned not to be in — showing somebody a listing it has no reason
   * to believe.
   */
  const refresh = useCallback(
    async (
      folders: readonly string[],
    ): Promise<{ servedFromCache: boolean; pages: Listings }> => {
      if (workspaceId === null) return { servedFromCache: false, pages: {} };
      const offline = offlineRef.current;
      let servedFromCache = false;
      /*
        EACH FOLDER LANDS ON ITS OWN, RATHER THAN ALL OF THEM AT THE END.

        This used to collect every page with `Promise.all` and write them in
        one `setListings` after the slowest one settled. For the two folders a
        note's rename touches that is the same thing; for the subtree a
        *folder* move cascades over it is not, and it is most of why the
        console felt like it was catching up rather than keeping up. Twelve
        folders meant twelve requests in flight and one repaint gated on the
        worst of them — so a tree that could have filled in from the top down
        sat still and then appeared.

        Writing each page as it arrives costs one render per folder instead of
        one per operation, which is what React batches for. The failure
        handling below is unchanged and still decides the *call's* answer: a
        page already committed is not un-committed by a later refusal, because
        it is the server's own answer for that folder and correct whatever
        happened to its neighbour.
      */
      /*
        The pages are kept as well as drawn, for the one caller that has to
        *read* what it just fetched: `createUntitled` picks a name against the
        destination's listing, and `setListings` is a state update — so
        `listingsRef` is still the pre-fetch map when this promise resolves.
        Every other caller wants the render and ignores this.

        A folder that came back gone is recorded as `undefined` rather than left
        out, so a caller spreading this over the map it already had drops the
        stale entry instead of keeping it.
      */
      const fetched: Listings = {};
      const commit = (folder: string, page: FolderListing | null) => {
        fetched[folder] = page ?? undefined;
        setListings((current) => {
          const next = { ...current };
          if (page === null) delete next[folder];
          else next[folder] = page;
          return next;
        });
      };
      await Promise.all(
        folders.map(async (folder) => {
          if (offline.reachability === "offline") {
            // Deliberately not "call it and see". `listFiles` is a Convex
            // action and `ConvexReactClient.action()` has no client-side
            // timeout, so with no connection the promise never settles at all
            // — the tree would sit empty forever rather than showing what is
            // on the device.
            const cached = await offline.cachedListing(folder);
            servedFromCache = true;
            commit(folder, cached?.value ?? null);
            return;
          }
          try {
            const page = await listFiles({ workspaceId, path: folder });
            offline.rememberListing(page);
            commit(folder, page);
            return;
          } catch (error) {
            const failure = toFileError(error);
            // A folder that has become invisible (its visibility changed, or
            // it was moved) is not an error worth shouting about — it is a
            // listing that should stop existing.
            if (failure.code === "FILE_NOT_FOUND") return commit(folder, null);
            // Every *other* refusal ends here rather than in the cache. The
            // line above is one too, and keeps its own answer — a folder that
            // is gone should stop existing rather than be redrawn from the
            // device. The rest have to reach the caller: a listing is a list of
            // somebody's note names, and repainting it after a refusal
            // discloses exactly what the refusal withheld. Only a transport
            // failure may fall back.
            if (isServerRefusal(error)) throw error;
            const cached = await offline.cachedListing(folder);
            if (cached !== null) {
              servedFromCache = true;
              return commit(folder, cached.value);
            }
            throw error;
          }
        }),
      );
      return { servedFromCache, pages: fetched };
    },
    [listFiles, workspaceId],
  );

  /**
   * Report a refresh nobody was waiting for.
   *
   * Four call sites fire `refresh` with `void` — expanding a folder, selecting
   * one, reloading a parent after a save, and opening the tree down to a
   * selection. None of them awaits it, so before this a refusal there was an
   * unhandled rejection and a folder that simply stayed empty: no listing, no
   * notice, nothing at all on screen to say the server had answered.
   *
   * That gap is not new, but it stopped being rare. `refresh` used to absorb a
   * refusal whenever it had something cached, so the throw only escaped for a
   * folder nobody had opened before; it now throws on **every** refusal,
   * because a listing repainted from the device after a refusal discloses
   * exactly what the refusal withheld. Making that guarantee stronger without
   * catching here would have made the silence the common case.
   *
   * The server's own sentence is what goes on screen rather than `run`'s
   * `STALE_LISTING_MESSAGE`: these are not operations whose result needs
   * qualifying, they *are* the thing that failed, and "the file list did not
   * reload" says less than the refusal it is standing in for.
   */
  const reportRefreshFailure = useCallback((error: unknown) => {
    setNotice(toFileError(error).message);
  }, []);

  /**
   * `ensureListing` on `FileBrowser`: fetch a folder's listing into the cache
   * without selecting it — see `browser.ts`. A no-op once it is there, and
   * fire-and-forget like every other background refresh in this file: the
   * result lands in `listings` on its own next render.
   */
  const ensureListing = useCallback(
    (path: string) => {
      if (workspaceId === null) return;
      if (listings[path] !== undefined) return;
      void refresh([path]).catch(reportRefreshFailure);
    },
    [listings, refresh, reportRefreshFailure, workspaceId],
  );

  /**
   * The context the state below actually belongs to.
   *
   * Published as `contextId` so a caller acting on a URL can wait for the
   * reset beneath to have happened — see the field's own comment in
   * `browser.ts` for the team link this existed to lose. It is set *inside*
   * the reset rather than derived from `workspaceId`, because the whole point
   * is that it moves one commit later than the prop does.
   */
  const [contextId, setContextId] = useState<string | null>(null);

  /**
   * Take the root's own listing without disturbing anything else in the map.
   *
   * **This used to be `setListings({ "": page })`, and the wholesale replace
   * was a bug with a witness.** `select` fetches a folder's own listing when it
   * does not have one — which is exactly what following a team link to a folder
   * does — and that fetch is started *after* this one and can land *before* it,
   * because a folder's listing is the smaller request. The root then replaced a
   * map holding a listing it was never told about, the folder page sat on
   * "Loading…", and nothing retried: the only way back was expanding that
   * folder in the side panel, which asks again.
   *
   * Merging is safe rather than merely lenient. Forgetting the previous context
   * is done by the reset at the top of the effect below, which runs before any
   * request goes out — so by the time a page comes back, the map holds only
   * listings for the context being loaded.
   */
  const takeRootListing = useCallback((page: FolderListing) => {
    setListings((current) => ({ ...current, "": page }));
  }, []);

  /** Load the root whenever the context changes, and forget the old one. */
  useEffect(() => {
    // Invalidates a read still in flight for the *previous* context before
    // anything else in this effect runs — see `openRun`. Without this, a read
    // started under the old `workspaceId` and answering after this effect has
    // already reset everything below would dispatch straight into the new
    // context's editor.
    openRun.current += 1;
    setListings({});
    setExpanded(new Set());
    setSelectedPath(null);
    // Nothing is on its way in a context nothing has asked for yet. A read
    // still in flight for the *previous* context settles onto its own path and
    // finds this `null`, which is the state it would have left anyway.
    setOpening(null);
    setClipboard(null);
    setNotice(null);
    dispatch({ type: "closed" });
    setContextId(workspaceId);
    if (workspaceId === null) return;

    let cancelled = false;
    setLoading(true);
    void (async () => {
      const offline = offlineRef.current;
      try {
        /*
          Offline, the root is read off the device rather than asked for. Not a
          fallback after a failure: `listFiles` is a Convex action with no
          client-side timeout, so with no connection nothing ever rejects and
          the console would sit on a spinner for as long as the tab was open.
        */
        if (offline.reachability === "offline") {
          const cached = await offline.cachedListing("");
          if (cancelled) return;
          if (cached === null) {
            setNotice(
              "You are offline and nothing from this context is on this device yet. Open it once with a connection.",
            );
            return;
          }
          takeRootListing(cached.value);
          return;
        }
        const page = await listFiles({ workspaceId, path: "" });
        if (cancelled) return;
        offline.rememberListing(page);
        takeRootListing(page);
      } catch (error: unknown) {
        if (cancelled) return;
        // A refusal is an answer, and the tree is not repainted from the
        // device over one — see `isServerRefusal`. The person gets the
        // server's own sentence instead of a root listing it just declined
        // to give them.
        const cached = isServerRefusal(error) ? null : await offline.cachedListing("");
        if (cancelled) return;
        if (cached !== null) {
          takeRootListing(cached.value);
          return;
        }
        setNotice(toFileError(error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [listFiles, takeRootListing, workspaceId]);

  /**
   * The note-path index, fetched once per context — best-effort, and never
   * blocking the editor on it.
   *
   * A separate effect from the root listing above rather than folded into
   * it: this is decoration for link resolution, not something a note or
   * folder needs on screen, so a slow or failed answer here must not touch
   * `loading` or `notice`. Offline is skipped outright — `notePaths` is a
   * Convex action with no client-side timeout, so calling it with no
   * connection would never settle rather than answering `null` quickly the
   * way the honest "not indexed yet" state does.
   */
  useEffect(() => {
    setIndexedPaths(null);
    if (workspaceId === null) return;
    if (offlineRef.current.reachability === "offline") return;
    let cancelled = false;
    void (async () => {
      try {
        const found = await notePathsAction({ workspaceId });
        if (!cancelled) setIndexedPaths(found.paths);
      } catch {
        // Best-effort: a failed or refused fetch leaves link resolution at
        // whatever the file tree already knows, which is exactly what this
        // surface did before the index existed.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [notePathsAction, workspaceId]);

  const toggleFolder = useCallback(
    (path: string) => {
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      if (listings[path] === undefined) void refresh([path]).catch(reportRefreshFailure);
    },
    [listings, refresh, reportRefreshFailure],
  );

  const collapseAll = useCallback(() => setExpanded(new Set()), []);

  /**
   * Ask the bucket, through the control plane's `searchContext`.
   *
   * Not routed through `run`: that is the mutation pipeline — it refuses when
   * `canEdit` is false, sets `busy`, and writes to `notice`. A search changes
   * nothing, a `member` must be able to run one, and a failure belongs to the
   * palette that asked rather than to the console's notice bar.
   */
  const search = useCallback(
    async (query: string) => {
      const found = await searchContext({
        workspaceId: workspaceId as Id<"workspaces">,
        query,
      });
      return {
        hits: found.hits,
        indexMissing: found.indexMissing,
        indexIncomplete: found.indexIncomplete,
        reducedRecall: found.reducedRecall,
        reducedRecallNotes: found.reducedRecallNotes,
      };
    },
    [searchContext, workspaceId],
  );

  /**
   * Put a note in the editor, from the bucket if it can be reached and from the
   * device if it cannot — and put back whatever was waiting for it.
   *
   * Three things happen here that did not before, and each is a case that was
   * previously an empty screen:
   *
   *  - **Offline reads go straight to the cache.** Not as a fallback after a
   *    failure: `readNote` is a Convex action with no client-side timeout, so
   *    with no connection it never rejects and the editor would sit blank.
   *  - **A read lost to the *transport* falls back to the cache.** The signal
   *    can say online and be wrong — a captive portal, a dead uplink — and a
   *    copy is better than an empty screen, as long as it says it is a copy.
   *    **A read the server *refused* does not**, and the distinction is the
   *    whole of `isServerRefusal`: the first sentence of this list used to say
   *    "a failed read", the `catch` could not tell the two apart, and a
   *    removed membership or a revoked grant was therefore converted into a
   *    cache hit — the console rendering a note body to somebody the control
   *    plane had just refused, with an age stamp under it that made it read as
   *    considered. A local copy never overrules an answer.
   *  - **Waiting work is restored.** A queued write, or a draft typed and never
   *    saved. `restoreFor` decides which, and turns a draft whose base etag has
   *    moved on into a conflict rather than into an armed overwrite.
   */
  const openNote = useCallback(
    async (path: string): Promise<void> => {
      if (workspaceId === null) return;
      const offline = offlineRef.current;
      /*
        This open's own generation. A new open (this one) makes whatever this
        hook was waiting on before stale, and everything this call eventually
        does — every `dispatch`, every `setNotice` — is guarded by comparing
        `mine` back against `openRun.current` first. See `openRun`'s own
        comment for the three moments that move it out from under a call
        already in flight.
      */
      openRun.current += 1;
      const mine = openRun.current;
      setOpening(path);
      try {
        /*
          A note created on this device and not yet sent has no copy anywhere
          but the queue — not in the bucket, not in the mirror — so it is opened
          from there, online or not. Asking the bucket for it would be a
          refusal about a file that does not exist yet, and the editor would
          close on the person's own new note.
        */
        const created = offline.pendingCreate(path);
        if (created !== undefined) {
          const folder = listingsRef.current[parentPath(path)];
          const visibility = folder?.folderDefault ?? "private";
          const unsent: OpenNote = {
            path,
            text: created.text,
            etag: "",
            visibility,
            inherited: visibility,
            exception: false,
            readOnly: false,
          };
          const restored = restoreFor({ note: unsent, pending: created, draft: null });
          if (openRun.current !== mine) return;
          dispatch({ type: "opened", note: unsent, restored, unsent: true });
          return;
        }
        /*
          And a note renamed on this device is still at its old name in the
          bucket until the rename is sent: it is read from there, and shown
          here. `relabel` puts the name the person gave it back on whatever the
          read returned.
        */
        const source = offline.serverPathOf(path);
        const relabel = (read: OpenNote): OpenNote => (read.path === path ? read : { ...read, path });
        let note: OpenNote | null = null;
        let fromCache = false;
        let notice: string | undefined;

        if (offline.reachability === "offline") {
          const cached = await offline.cachedNote(source);
          if (cached !== null) {
            note = relabel(cached.value);
            fromCache = true;
            notice = cachedNotice({ cachedAt: cached.cachedAt, now: Date.now() });
          }
        } else {
          const reading = readNote({ workspaceId, path: source });
          /*
            Online, the mirror answers first when the bucket is slow.

            A note that is on the device should open like a note in Apple
            Notes, not after a round trip to somebody's bucket on a train's
            wifi. So the read is given `INSTANT_OPEN_MS` — long enough that an
            ordinary connection answers inside it and nothing flickers — and
            past that the mirror's copy is put in the editor, marked
            `fromCache` (the save chip says "Cached copy" until the bucket
            answers), and the read carries on behind it.

            Three things keep that honest, each a rule this file already had:

             - **Not when there is work to restore.** A queued write or a draft
               is restored against the note it was typed on (`restoreFor`),
               once; showing a copy first would mean restoring twice against
               two versions. Those opens wait for the bucket, as they always
               did.
             - **A refusal still wins.** The copy was shown while there was no
               answer; when the answer is a refusal, the editor closes and says
               so — the same outcome `isServerRefusal` gives an open that never
               showed anything. A transport failure keeps the copy, as the
               fallback below always has.
             - **Typing is never replaced.** The bucket's version replaces the
               copy only while the editor is still clean on this note. If
               somebody started typing, their draft is based on the copy's
               version, a save is checked against it, and the mirror holds that
               version as the merge's ancestor (`mirrorHolds.ts`) — so a copy
               that turned out stale becomes an ordinary conflict with a real
               Merge, never an overwrite.
          */
          const quick = await raceTimeout(reading, {
            ms: INSTANT_OPEN_MS,
            schedule: (fn, ms) => setTimeout(fn, ms),
            cancel: (handle) => clearTimeout(handle),
          });
          let early: OpenNote | null = null;
          if (quick.kind === "timeout" && openRun.current === mine) {
            const copy = await offline.instantCopy(source);
            const waiting =
              offline.pendingFor(path) !== undefined || (await offline.savedDraft(path)) !== null;
            if (copy !== null && !waiting && openRun.current === mine) {
              early = relabel(copy.value);
              dispatch({ type: "opened", note: early, fromCache: true });
              settleOpening(path);
            }
          }
          try {
            const read = quick.kind === "value" ? quick.value : await reading;
            offline.rememberNote(read);
            note = relabel(read);
            if (early !== null) {
              if (openRun.current !== mine) return;
              const shown = editorRef.current;
              if (shown.path === path && shown.status === "clean") {
                dispatch({ type: "reloaded", note });
              }
              return;
            }
          } catch (error) {
            if (early !== null) {
              if (openRun.current !== mine) return;
              if (isServerRefusal(error)) {
                dispatch({ type: "closed" });
                setNotice(toFileError(error).message);
              }
              return;
            }
            const cached = isServerRefusal(error) ? null : await offline.cachedNote(source);
            if (cached === null) {
              // Superseded: do not put a *different* request's failure into
              // the notice line, and do not close whatever is open now on its
              // behalf — that state belongs to the open (or close) that came
              // after this one.
              if (openRun.current !== mine) return;
              dispatch({ type: "closed" });
              setNotice(toFileError(error).message);
              return;
            }
            note = relabel(cached.value);
            fromCache = true;
            notice = cachedNotice({ cachedAt: cached.cachedAt, now: Date.now() });
          }
        }

        if (note === null) {
          if (openRun.current !== mine) return;
          dispatch({ type: "closed" });
          setNotice(NOT_CACHED);
          return;
        }

        /*
          An encrypted note can never legitimately carry a draft or a queued
          write — `useNoteEncryption.ts`'s own header states that editing an
          unlocked note has no autosave and no offline queue, on purpose, and
          `__tests__/encryptionDraftQueueGuard.test.ts` holds that on the
          source of every file that could reach one. So whatever is found
          here for an encrypted note's path *predates* it becoming encrypted:
          a lock made on this device with nothing yet discarding it (see
          `discardLocalCopies`, and `BrowsePane`'s own caller of it), a lock
          made on another device or tab that shares this one's local storage,
          or a queued write that raced the lock and can now only ever come
          back refused (`fileOps.ts`'s "a note this request cannot open is a
          note this request cannot write").

          None of that is restorable, and `restoreFor` has no way to know to
          refuse it: it compares text and etags, a stale plaintext draft never
          equals the ciphertext envelope now on the bucket, and the lock
          always moves the etag — so an unguarded call would restore that
          plaintext into the editor as an "unsaved changes" conflict, on a
          note the console is about to tell this same person is locked. So an
          encrypted note skips the call entirely rather than trusting it to
          decline, and — because a skipped restore does not imply an absent
          one — whatever local copy exists for it is discarded right here,
          the first time any device notices the note is encrypted, instead of
          being left to resurface the same way on every future open.
        */
        const restored = note.encrypted
          ? undefined
          : restoreFor({
              note,
              pending: offline.pendingFor(path),
              draft: await offline.savedDraft(path),
            });
        if (note.encrypted === true) {
          offline.dropQueued(path);
          offline.forgetDraft(path);
        }
        // The one that matters most: a superseded read must not put its note
        // in an editor that has moved on to another context, another note, or
        // no note at all — see the module comment at the top of this file.
        if (openRun.current !== mine) return;
        dispatch({ type: "opened", note, fromCache, notice, restored });
      } finally {
        /*
          Every exit, including the early returns above that end in `closed`
          plus a notice. A read that failed is not still opening, and leaving
          the flag set would hold the region blank under the failure's own
          message.

          Guarded the same way: a superseded call's `opening` was already
          moved on by whatever superseded it (a new open sets its own path, a
          context switch or a `deselect` sets it to `null`), and clearing it
          here — even through the path comparison inside `settleOpening` —
          could still race a same-path reopen and clear a flag belonging to
          the call that came after it.
        */
        if (openRun.current === mine) settleOpening(path);
      }
    },
    [readNote, settleOpening, workspaceId],
  );

  const select = useCallback(
    (path: string): boolean => {
      /*
        Write what is pending before anything moves.

        This is what makes the relaxed `guardLeaving` honest: a draft that was
        waiting on the idle timer is handed to the bucket on the way out rather
        than being left to a timer that will refuse to fire under the next note.
        It is the same conditional write Save makes, against the etag this draft
        was typed on, and it is issued while the editor still holds the note it
        belongs to.

        Before the guard, deliberately. The guard reads `editorRef`, which is
        assigned during render and so still says `dirty` here — the flush cannot
        change the answer it gives about this navigation, and evaluating the
        guard first would only make the ordering look load-bearing when it is
        not.
      */
      autosave.flush();
      const guard = guardLeaving(editorRef.current);
      if (!guard.allowed) {
        setNotice(guard.prompt ?? null);
        return false;
      }
      setSelectedPath(path);
      // Past the guard, so a refused navigation is not one. See `navigations`.
      setNavigations((count) => count + 1);
      setNotice(null);

      /**
       * A folder has no body. Reading one comes back `FILE_NOT_FOUND`, and the
       * console then tells somebody their own folder does not exist.
       *
       * **`findEntry` is not enough to decide this, and that is the bug this
       * comment used to describe and not prevent.** It looks a path up in its
       * *parent's* listing, so on a cold load — following a team link straight
       * to `/console/@seyi?note=1-projects/pilot`, where nothing has been
       * expanded yet — the parent is absent, the entry is unknown, and the
       * folder falls through to `readNote`. The screenshot of that says "That
       * file does not exist" over an empty page.
       *
       * So the entry decides when it is known, and the path's own shape decides
       * when it is not. A note is `.md` by construction: `createNote` appends
       * it, `writeNote` refuses anything else, and `checkSharePath` requires it.
       * Anything else is a folder, and treating an unknown `.md` as a note is
       * the right failure anyway — that is a real read whose refusal is honest.
       */
      const known = findEntry(listings, path);
      const isFolder = known === null ? !isMarkdown(path) : known.kind === "folder";
      if (isFolder) {
        dispatch({ type: "closed" });
        // Its own listing, so the folder view has contents to draw rather than
        // an empty screen. `refresh` is a no-op for a folder already loaded.
        if (listings[path] === undefined) {
          /*
            A folder reached by a link has no listing yet either, and the gap
            before one arrives is the same blank the note path has — so it is
            reported the same way. A folder already loaded is not opening: the
            view has everything it needs this frame.
          */
          setOpening(path);
          void refresh([path])
            .catch(reportRefreshFailure)
            .finally(() => settleOpening(path));
        }
        return true;
      }
      if (workspaceId === null) return true;
      void openNote(path);
      // The selection moved; whether the *read* lands is a separate question
      // this answer is not about. A caller only needs to know the guard let go.
      return true;
    },
    [autosave, listings, openNote, refresh, reportRefreshFailure, settleOpening, workspaceId],
  );

  /**
   * Close what is open. The inverse of `select`, and see `browser.ts` for why
   * its absence was a shipped defect rather than a gap in the interface.
   *
   * The same three moves `select` makes on the way out of a note — flush the
   * autosave, ask the guard, clear the notice — and then `null` instead of a
   * path. `closed` empties the editor; `setOpening(null)` because a read that
   * was still in flight is a read for a note nobody is looking at any more, and
   * leaving the flag set would hold the region blank over an empty selection.
   *
   * The read itself is not cancelled — nothing here can cancel a Convex action
   * — and it does not need to be: bumping `openRun` is what stops it mattering.
   * `openNote` compares its own generation against `openRun.current` before
   * every `dispatch`, so a read still in flight when this runs finds itself
   * superseded and drops its answer rather than springing the editor back open
   * with a note nobody is looking at any more. What must not happen either is
   * the *selection* coming back, and it cannot: `selectedPath` is only ever
   * written by `select` and `deselect`.
   */
  const deselect = useCallback((): boolean => {
    autosave.flush();
    const guard = guardLeaving(editorRef.current);
    if (!guard.allowed) {
      setNotice(guard.prompt ?? null);
      return false;
    }
    // See `openRun`: a read still in flight for the note being closed must not
    // be able to dispatch `opened` back into an editor this call just closed.
    openRun.current += 1;
    setSelectedPath(null);
    setOpening(null);
    setNotice(null);
    dispatch({ type: "closed" });
    return true;
  }, [autosave]);

  /**
   * Run one mutating operation.
   *
   * The shape is the same every time — refuse if this console cannot edit,
   * mark busy, do it, refresh what it touched, report what happened — so
   * getting it right once is better than getting it nearly right eleven times.
   *
   * Two things it is careful about, both learned the hard way:
   *
   *  - **The work is raced against a timer.** Every `work()` here awaits a
   *    Convex action, and `ConvexReactClient.action()` has no client-side
   *    timeout: the promise settles only when the socket replies. A connection
   *    that drops mid-operation used to leave `busy` true forever — and `busy`
   *    is what disables rename, move, duplicate, archive, delete, paste and
   *    the visibility controls — with no way back but a reload. Same fix as the
   *    save above and `storage/reverify.ts`: an injected timer and a generation
   *    counter, so a reply from an abandoned attempt cannot settle the current
   *    one.
   *  - **A failed refresh is not a failed operation.** These were once in the
   *    same `try`, so a rename that succeeded and then failed to reload its
   *    folder was reported as "That did not work. Try again." — and the retry
   *    it invited failed on the duplicate name the first one had created.
   *
   * ## Where the result goes
   *
   * A `message` becomes a notice — it sits until dismissed, which is what a
   * refusal or a half-failure needs. A `message` *with* an `undo` becomes a
   * toast instead, because the offer it carries is only good for a few seconds
   * and a permanent line offering to undo something from ten minutes ago is a
   * line that gets pressed by mistake.
   *
   * Toasts are cleared here, before the work starts, so there is never an offer
   * to invert an operation that a later one has since moved out from under. The
   * undo of a move is "put it back where it was"; run it after somebody has
   * renamed the file and it is a request to move a path that no longer exists.
   */
  const run = useCallback(
    async (
      work: () => Promise<{
        touched: string[];
        cascadeFrom?: string;
        message?: string;
        /** The exact inverse, offered for `TOAST_MS` beside `message`. */
        undo?: () => void;
      }>,
      /**
       * Put the screen back, for an operation that was drawn before it was
       * sent.
       *
       * `move`, `rename` and `createFolder` repaint the tree on the press and
       * then send the mutation, because waiting two round trips to move a row
       * six pixels is what made the console feel broken (`optimistic.ts`).
       * Everything that follows from that is here: exactly one of the four
       * exits below is "it happened", and the other three have to undo the
       * drawing.
       *
       * It is the *inverse operation* rather than a snapshot restore. A
       * snapshot taken before the send would also roll back whatever landed
       * while it was in flight — a background refresh, another folder's
       * listing, a note somebody saved — and a rollback that quietly reverts
       * an unrelated fact is worse than the stale row it is fixing.
       */
      revert?: () => void,
    ): Promise<boolean> => {
      if (!options.canEdit || workspaceId === null) {
        /*
          Reverted, and this is not theoretical. A read-only console keeps all
          fourteen mutating methods — `menu.ts` opens by saying so, and
          `useDemoFileBrowser` sets every one of them to a no-op — so a call
          that slips past `canEdit` reaches here rather than throwing. Before
          the drawing existed that was a silent no-op; now it would be a row
          left sitting at a path nothing will ever write.
        */
        revert?.();
        return false;
      }
      /*
        Known offline, it is not sent at all. Every `work()` here awaits a
        Convex action with no client-side timeout, so the alternative is
        forty-five seconds of a disabled toolbar followed by "it may still have
        gone through" — about something that certainly did not. The operations
        that *can* wait for a connection (create, rename, move, archive,
        delete, new folder) never reach here offline: they are queued by their
        own callers. What does reach here offline is refused in a sentence.
      */
      if (offlineRef.current.reachability === "offline") {
        setToasts([]);
        setNotice(NEEDS_CONNECTION);
        revert?.();
        return false;
      }
      operationRun.current += 1;
      const mine = operationRun.current;
      setBusy(true);
      setNotice(null);
      setToasts([]);

      const settled = await raceTimeout(
        // Called inside the race so a `work()` that throws synchronously is a
        // rejected promise here rather than an exception out of `run`.
        (async () => await work())(),
        {
          ms: OPERATION_TIMEOUT_MS,
          schedule: (fn, ms) => setTimeout(fn, ms),
          cancel: (handle) => clearTimeout(handle),
        },
      );

      /*
        Superseded: something newer owns the toolbar now. Leave it alone — and
        that includes not reverting, because the drawing on screen is the
        newer operation's and undoing it would corrupt a listing this call has
        no claim on any more. The abandoned mutation is still in flight and its
        own refresh is what settles the truth.
      */
      if (operationRun.current !== mine) return false;

      if (settled.kind === "timeout") {
        setBusy(false);
        setNotice(TIMED_OUT_MESSAGE);
        /*
          Deliberately NOT reverted. A timeout is "no answer yet", not "it did
          not happen" — the socket may still deliver, and `TIMED_OUT_MESSAGE`
          says exactly that. Putting the row back would state the opposite. The
          refresh the next navigation or expand performs is what resolves it.
        */
        return false;
      }
      if (settled.kind === "failed") {
        setBusy(false);
        setNotice(toFileError(settled.error).message);
        revert?.();
        return false;
      }

      // From here the mutation has already happened. Nothing below may report
      // it as a failure.
      const result = settled.value;
      let listingReloaded = true;
      try {
        const reloaded = await refresh(
          /*
            `listingsRef` and not the closed-over `listings`. A folder move
            re-keys its subtree the moment it is pressed (`optimistic.ts`), so
            the folders a `cascadeFrom` has to reload are the ones keyed under
            the *destination* — and the render this callback was built in only
            ever saw them under the source. Reading the ref also stops `run`
            being rebuilt on every listing that lands, which is a new callback
            identity for each of the nineteen operations that close over it.
          */
          foldersToRefresh(result.touched, {
            cascadeFrom: result.cascadeFrom,
            loaded: Object.keys(listingsRef.current),
          }),
        );
        // A listing served off the device is the tree as it was *before* this
        // operation. Not a failure, and not a reload either — see `refresh`.
        listingReloaded = !reloaded.servedFromCache;
      } catch {
        listingReloaded = false;
      }

      if (operationRun.current !== mine) return true;
      setBusy(false);
      if (!listingReloaded) {
        // The tree on screen may be wrong, so an undo offered against it would
        // be acting on a listing we have just said not to trust. The notice
        // wins; there is nothing here worth undoing blind.
        setNotice(STALE_LISTING_MESSAGE);
      } else if (result.message !== undefined && result.undo !== undefined) {
        const undo = result.undo;
        nextToastId.current += 1;
        setToasts([{ id: `op-${nextToastId.current}`, message: result.message, undo }]);
      } else if (result.message !== undefined) {
        setNotice(result.message);
      }
      return true;
    },
    [options.canEdit, refresh, workspaceId],
  );

  /**
   * One conditional write, whatever asked for it.
   *
   * **The path, the text and the etag are arguments rather than reads off
   * `editorRef`, and that is the whole reason this exists separately from
   * `save`.** A conflict answer has to write text the editor has only just been
   * told about, against an etag the editor has only just been told about, in
   * the same tick — and `editorRef.current` is assigned during render, so it is
   * still the pre-dispatch state at that moment. Reading the state here would
   * make "keep mine" send the version it was replacing, and it would do it
   * silently.
   *
   * Every caller gets the same write: `writeNote` with `expectedEtag`, so the
   * server's `onlyIf: { etagMatches }` where the bucket has one and its
   * read-compare where it does not. There is no unconditional branch in this
   * file and no force flag anywhere in it.
   */
  const performSave = useCallback(
    (path: string, text: string, expectedEtag: string | null) => {
      if (workspaceId === null) return;
      const offline = offlineRef.current;
      /*
        Whatever the timer was holding for this note is being written now, by
        this call. Leaving it armed would spend a second request writing the
        same text against an etag this write is about to move past. Only this
        note's timer: another note's pending write is not this call's to drop.
      */
      if (autosave.pending() === path) autosave.cancel();

      /*
        With no connection the text goes into the queue instead of into a socket
        that will never answer.

        Decided from the signal rather than from an error, because there is no
        error to decide from: `writeNote` is a Convex action, `action()` has no
        client-side timeout, and offline it neither resolves nor rejects. The
        existing behaviour was thirty seconds of a disabled toolbar followed by
        "we don't know whether that save landed" — for a save that certainly did
        not.

        `enqueue` carries the etag this text was written against, so the write
        that eventually goes is the same conflict-checked write this function
        would have made now.
      */
      /*
        And a note renamed on this device goes through the queue even online:
        the bucket still has it under its old name, so a write to the new one
        would be a create beside it. Queued, it is sent to the old name ahead
        of the rename — see `serverPathOf` — and the drain runs now.
      */
      const renamedHere = offline.serverPathOf(path) !== path;
      if (offline.reachability === "offline" || renamedHere) {
        offline.queueSave({ path, text, baseEtag: expectedEtag });
        offline.forgetDraft(path);
        dispatch({
          type: "saveQueued",
          message:
            offline.reachability !== "offline"
              ? "Waiting for the rename before it to reach your bucket."
              : offline.durable
                ? "No connection, so this is written down on this device and will be sent when you are back."
                : "No connection, so this is held for this session and will be sent when you are back. Closing the app loses it.",
        });
        if (offline.reachability !== "offline") offline.drain();
        return;
      }

      const mine = (saveRuns.current.get(path) ?? 0) + 1;
      saveRuns.current.set(path, mine);
      const running = saveTimers.current.get(path);
      if (running !== undefined) clearTimeout(running);
      /*
        The one dispatch below that is *not* compared against the open note, and
        it needs no comparison rather than having been missed: every caller of
        `performSave` passes the note the editor is holding. `save` and
        `resolveWith` read the path straight off `editorRef`, and `autosaveNow`
        — the only caller that could ever pass another one — refuses before it
        gets here. The settlement dispatches below are guarded because they land
        *later*, when that is no longer true.
      */
      dispatch({ type: "saveStarted" });

      saveTimers.current.set(
        path,
        setTimeout(() => {
          saveTimers.current.delete(path);
          if (saveRuns.current.get(path) !== mine) return;
          // Bump past `mine` so the write, if it ever lands, cannot come back
          // and settle an attempt the editor has already given up on.
          saveRuns.current.set(path, mine + 1);
          // A timeout for a note that is no longer on screen has no editor to
          // put into `error`, and the reducer would put the *other* note there.
          // See the failure branch below for the whole argument.
          if (editorRef.current.path !== path) {
            setNotice(
              `${path} is still waiting on your bucket, so we stopped waiting. We don't know whether that save landed. ${draftIsKept(offlineRef.current.durable)}`,
            );
            return;
          }
          dispatch({ type: "saveTimedOut" });
        }, SAVE_TIMEOUT_MS),
      );

      const settle = () => {
        const timer = saveTimers.current.get(path);
        if (timer !== undefined) {
          clearTimeout(timer);
          saveTimers.current.delete(path);
        }
      };

      writeNote({
        workspaceId,
        path,
        text,
        expectedEtag: expectedEtag ?? undefined,
      })
        .then((result) => {
          if (saveRuns.current.get(path) !== mine) return;
          settle();
          /*
            The text is in the bucket now, so the copy of it on this device is
            not a draft any more — leaving it would restore "unsaved changes"
            identical to the file, on a note nobody had touched. The cache moves
            onto the text and etag that were just written, so a later offline
            read of this note shows what the person saved rather than what they
            opened.
          */
          offlineRef.current.forgetDraft(path);
          offlineRef.current.rememberBody({ path, text, etag: result.etag });
          // And anybody sharing this note right now, so their next save is
          // checked against the version this one just produced.
          announceSaved({ path, etag: result.etag });
          /*
            And the queue entry goes with it, if there was one.

            There is one whenever this save is answering something the queue was
            already holding — a refusal being retried, or a conflict somebody
            has just decided. Leaving it behind would send the drain back at the
            bucket with the *stale* base etag it was parked on, which raises the
            same conflict again about a decision that has already been made.
          */
          offlineRef.current.landedQueued(path, result.etag);
          /*
            The editor describes the note that is **open**, and with autosave
            this write is routinely for one that is not: leaving a note flushes
            its draft, and the answer arrives after the next note has loaded.
            `saveSucceeded` would then move the *other* note's baseline and
            etag onto this write's — marking somebody's real unsaved draft
            clean and arming their next save against a version it was never
            based on. The same guard `onDrained` has, for the same reason.

            Everything above this line still runs, because it is keyed by path
            and is what stops the device copy resurrecting a draft that was
            written. Only the reducer is skipped.
          */
          if (editorRef.current.path === path) {
            dispatch({
              type: "saveSucceeded",
              etag: result.etag,
              conflictCheck: result.conflictCheck,
            });
          }
          void refresh([parentPath(path)]).catch(reportRefreshFailure);
        })
        .catch((error: unknown) => {
          if (saveRuns.current.get(path) !== mine) return;
          settle();
          const failure = toFileError(error);
          if (editorRef.current.path !== path) {
            /*
              Same rule, and this direction is worse: `saveFailed` would put
              whatever note is open now into `conflict` or `error`, over a
              refusal that was about a different file — and a conflict carries
              `conflictEtag`, so the wrong note would be offered somebody
              else's version to merge with.

              It is not swallowed. The draft is on the device and comes back
              when the note is reopened (`restoreFor` — as a conflict if the
              bucket has moved on), so the notice says which note and where its
              text is rather than implying it is gone.
            */
            setNotice(
              `${path} could not be saved: ${failure.message} ${draftIsKept(offlineRef.current.durable)}`,
            );
            return;
          }
          dispatch({ type: "saveFailed", error: failure });
        });
    },
    [announceSaved, autosave, refresh, reportRefreshFailure, workspaceId, writeNote],
  );

  /**
   * Write the open note.
   *
   * `writeNote` is a Convex action and `ConvexReactClient.action()` has no
   * client-side timeout, so a connection that drops mid-save leaves the promise
   * pending forever — and the editor pinned in `saving`, where Save is
   * disabled, Discard is not rendered, and `guardLeaving` blocks opening
   * anything else. **There is no control left**, and the only escape is a
   * reload that loses the draft.
   *
   * So the save is raced against a timer, exactly the way `storage/reverify.ts`
   * races the probe: same 30s, same generation counter, and a settled state
   * that offers a way forward rather than a spinner that promises one.
   */
  const save = useCallback(() => {
    const current = editorRef.current;
    if (current.path === null || current.readOnly) return;
    performSave(current.path, current.draft, current.etag);
  }, [performSave]);

  /**
   * A timer came due. Write that note's draft — **if it is still that note.**
   *
   * The scariest bug available in this whole change is right here. A timer
   * armed while `1-projects/plan.md` was open fires two seconds later, by which
   * time somebody has clicked `0-inbox/idea.md`; without the comparison below
   * it would write `editorRef.current.draft` — the *other* note's text — to
   * whichever path, against whichever etag, the state happens to hold now.
   * Either arrangement of that is somebody's note overwritten with somebody
   * else's words, which is the one failure this console must never produce.
   *
   * So the path is captured when the timer is armed (`autosave.edited`), handed
   * back here, and compared. A note that has moved on simply drops the write:
   * the draft it was for is already on the device, and `select` flushed it on
   * the way out anyway.
   *
   * `autosaves` is re-asked here rather than trusted from arming time, because
   * the two seconds in between are long enough for a conflict to arrive, for a
   * save to be pressed, or for the person to have discarded the draft.
   */
  const autosaveNow = useCallback(
    (path: string) => {
      const current = editorRef.current;
      if (current.path !== path) return;
      if (!autosaves(current)) return;
      performSave(path, current.draft, current.etag);
    },
    [performSave],
  );
  autosaveNowRef.current = autosaveNow;

  /**
   * Write what the timer is holding, now.
   *
   * The other half of "stop bugging people to save": leaving a note, closing a
   * tab or closing the browser tab hands the pending draft over rather than
   * asking somebody to. Answers whether it wrote anything, so a caller can tell
   * "nothing was owed" from "it has been dealt with".
   */
  const flushAutosave = useCallback(
    (path?: string) => autosave.flush(path),
    [autosave],
  );

  /**
   * Drop every local copy of a path's plaintext — see `browser.ts`'s own
   * comment for who calls this and why. The same pair `discard` and
   * `useTheirs` already make for the *open* editor's path, generalised to an
   * arbitrary one: a lock's caller has just finished writing an envelope over
   * `path` and does not need — and must not have to force — that note back
   * open first to clear what predates it.
   *
   * Cancelling autosave is deliberately not this function's job: it takes a
   * path rather than reading `editorRef`, and an armed timer belongs to
   * whichever path the editor is *currently* holding, which may not be this
   * one. `performSave`'s own `if (autosave.pending() === path) autosave.cancel()`
   * is the guard for the note actually on screen; a lock success re-opens the
   * note it just wrote (`BrowsePane`'s `files.select`), and that reopen is
   * itself what clears `dirty`/`status`, so nothing here has to. `select`
   * flushes a pending timer rather than dropping it, so what that reopen can
   * still issue is the same *conditional* write `performSave` always makes,
   * against the etag the draft was typed on — which the lock has moved, so the
   * bucket refuses it and the envelope stands.
   *
   * What it does drop, beyond its old name: the cached body. See the block
   * inside, and `browser.ts` for the whole argument.
   */
  const discardLocalCopies = useCallback((path: string) => {
    offlineRef.current.dropQueued(path);
    offlineRef.current.forgetDraft(path);
    /*
      And the cached body, which is the copy nothing else here would take.

      `sweep`'s bounds reach it in thirty days and `forgetWorkspace` reaches it
      when the context is left; neither is "now", and now is what a lock
      promised. The reopen that follows a lock does overwrite it — but only if
      it lands, and a read that fails between the two falls back to exactly
      this record and serves the pre-lock plaintext into an ordinary editor,
      because a copy taken before the lock carries `encrypted: false` and so
      never reaches `openNote`'s guard below.
    */
    offlineRef.current.forgetNote(path);
  }, []);

  /**
   * React to a lock performed by another live console. Stop future local
   * writes, invalidate a save already in flight, remove durable copies, and
   * clear the editor before waiting for the bucket. `select` cannot be reused:
   * it intentionally flushes autosave, which would send the plaintext this
   * notification exists to revoke.
   */
  const encryptedElsewhere = useCallback(
    (path: string) => {
      if (autosave.pending() === path) autosave.cancel();
      const running = saveTimers.current.get(path);
      if (running !== undefined) {
        clearTimeout(running);
        saveTimers.current.delete(path);
      }
      saveRuns.current.set(path, (saveRuns.current.get(path) ?? 0) + 1);
      discardLocalCopies(path);
      if (editorRef.current.path !== path) return;
      dispatch({ type: "closed" });
      void openNote(path);
    },
    [autosave, discardLocalCopies, openNote],
  );

  /**
   * The person answered the conflict: this text, over the version they saw.
   *
   * One function for two of the three answers — "keep mine" is this with the
   * draft, "merge" is this with whatever they approved in the review — because
   * the only thing that differs is the text, and the thing that must **not**
   * differ is what the write is checked against.
   *
   * `theirsEtag` is the etag the review actually read the bucket at, so the
   * write is conditional on the version that was on screen when they decided.
   * If somebody has moved it again since, the write comes back `CONFLICT`, the
   * editor goes back into `conflict`, and this whole surface reappears with
   * fresh content. **There is no force flag and no second write path**; the
   * only way to overwrite somebody here is to be shown their version first.
   */
  const resolveWith = useCallback(
    (text: string) => {
      const current = editorRef.current;
      if (current.path === null || current.status !== "conflict") return;
      // An update resolution is not available until the bucket version has
      // actually been read and shown. A deletion resolution is the parallel
      // safe case: the failed conditional update authoritatively established
      // absence, so `null` means create-only rather than blind overwrite.
      // This guard keeps both boundaries intact if another caller invokes the
      // callback directly.
      const review = conflictRef.current;
      const reviewedEtag = review?.theirsDeleted === true ? null : review?.theirsEtag;
      if (reviewedEtag === undefined || (reviewedEtag === null && review?.theirsDeleted !== true)) {
        return;
      }
      const path = current.path;
      const offline = offlineRef.current;
      const etag = reviewedEtag;

      if (offline.reachability === "offline" || offline.serverPathOf(path) !== path) {
        /*
          Nothing can be read or written now, so this is a decision about what
          the queue holds rather than a write. (Online too, for a note renamed
          on this device: its write goes to the old name, ahead of the rename,
          so it is the queue's to send — `performSave` says the same.) `queueSave` takes the newer text
          (and cannot advance the base etag, by design), and `keepQueued`
          re-bases onto the version the conflict reported and puts it back in
          the queue — so what eventually drains is still a conditional write
          against a version this person was shown.
        */
        offline.queueSave({ path, text, baseEtag: etag });
        offline.keepQueued(path);
        dispatch({ type: "edited", text });
        dispatch({ type: "saveQueued", message: KEEP_MINE_OFFLINE });
        if (offline.reachability !== "offline") offline.drain();
        return;
      }

      /*
        The cache moves onto the version they were shown, and it moves *before*
        the write rather than after it.

        It is not optimism: at this moment the bucket really did hold that body
        at that etag — the review read it — and the cache is a mirror of the
        bucket, so this is the more accurate record either way. What it buys is
        the next round. If a third writer gets in before this write lands, the
        refusal comes back with the draft they just approved, whose common
        ancestor is precisely the version now cached — so the merge is offered
        again, correctly, instead of the console having to say the ancestor is
        gone.
      */
      const theirs = conflictRef.current?.theirs;
      if (theirs !== undefined && theirs !== null && etag !== null) {
        offline.rememberBody({ path, text: theirs, etag });
      }

      // The draft becomes what they approved, and the etag becomes the version
      // it is being written over, *before* the write — so a refusal leaves the
      // reviewed text in the editor rather than the text it replaced.
      dispatch({ type: "resolving", text, etag });
      performSave(path, text, etag);
    },
    [performSave],
  );

  /**
   * "Load theirs" — take the bucket's version and let this draft go.
   *
   * The one path in the console that deliberately destroys somebody's typing,
   * and it is reached from a control pressed with the conflict explained beside
   * it. So it has to take the draft *and* anything holding a copy of it: the
   * queue entry and the written-down draft both go, or the next time this note
   * is opened the console restores the very text the person just chose to drop.
   */
  const useTheirs = useCallback(() => {
    const current = editorRef.current;
    if (workspaceId === null || current.path === null) return;
    const path = current.path;
    const offline = offlineRef.current;
    const source = offline.serverPathOf(path);
    offline.dropQueued(path);
    offline.forgetDraft(path);
    if (conflictRef.current?.theirsDeleted === true) {
      autosave.cancel();
      setSelectedPath(null);
      dispatch({ type: "closed" });
      void refresh([parentPath(path)]).catch(reportRefreshFailure);
      return;
    }
    readNote({ workspaceId, path: source })
      .then((note: OpenNote) => {
        offlineRef.current.rememberNote(note);
        dispatch({ type: "reloaded", note: { ...note, path } });
      })
      .catch((error: unknown) => setNotice(toFileError(error).message));
  }, [autosave, readNote, refresh, reportRefreshFailure, workspaceId]);

  const applyPluginNoteWrite = useCallback((write: AppliedPluginNoteWrite) => {
    const current = editorRef.current;
    if (current.path !== write.path) return;
    if (current.etag !== write.expectedEtag) return;
    if (current.status !== "clean" && current.status !== "saved") return;

    const note: OpenNote = {
      path: write.path,
      text: write.text,
      etag: write.etag,
      visibility: current.visibility,
      inherited: current.inherited,
      exception: current.exception,
      readOnly: current.readOnly,
      encrypted: current.encrypted,
    };
    offlineRef.current.forgetDraft(write.path);
    offlineRef.current.dropQueued(write.path);
    offlineRef.current.rememberNote(note);
    dispatch({ type: "reloaded", note });
  }, []);

  /**
   * "Keep mine" — send this draft over the version that is there now.
   *
   * The queue is re-based in step with the editor. Leaving it behind would mean
   * the editor moving onto the current etag while a queued entry still carried
   * the stale one, so the next drain would raise the same conflict again about
   * a decision the person has already made.
   */
  const keepMine = useCallback(() => {
    const path = editorRef.current.path;
    if (path !== null) offlineRef.current.keepQueued(path);
    dispatch({ type: "conflictOverridden" });
    /*
      And arm the timer, because this is the one route into `dirty` that is not
      a keystroke.

      Autosave is armed from `setDraft`, which is right for every other path
      into that status — somebody typed. "Keep mine" produces a writable draft
      without anybody typing, and leaving it unarmed meant the person resolved
      the conflict, watched nothing happen, and still owed the app a press of
      Save. That is precisely the thing this change exists to remove, surviving
      in the one place somebody has just been made to think hard.

      Safe to arm unconditionally: the reducer has already moved the state to
      `dirty` on the etag they chose to replace, and `autosaveNow` re-asks
      `autosaves` when the timer comes due anyway.
    */
    if (path !== null) autosave.edited(path);
  }, [autosave]);

  const discard = useCallback(() => {
    const path = editorRef.current.path;
    if (path !== null) {
      offlineRef.current.dropQueued(path);
      offlineRef.current.forgetDraft(path);
    }
    // Belt and braces: `autosaveNow` would refuse a discarded draft anyway,
    // because the note is `clean` by the time the timer comes due. Cancelling
    // is what makes that a decision rather than a coincidence of ordering.
    autosave.cancel();
    dispatch({ type: "discarded" });
  }, [autosave]);

  /**
   * Every keystroke, written down.
   *
   * Two destinations, and which one depends on whether Save has been pressed
   * yet. Before it, the text is a *draft* — nothing has tried to send it — and
   * it is kept so that closing the tab, or the OS reclaiming a backgrounded
   * app, does not throw it away. After it, the text belongs to the queue, and
   * `queueSave` supersedes the entry so what eventually reaches the bucket is
   * the last thing typed rather than the version that happened to be waiting
   * when the signal went.
   *
   * Both are debounced inside `useOfflineNotes`; neither writes to storage per
   * character.
   */
  const setDraft = useCallback(
    (text: string) => {
      const current = editorRef.current;
      dispatch({ type: "edited", text });
      if (current.path === null || current.readOnly) return;

      /*
        And, unless the state says otherwise, scheduled to be written to the
        bucket.

        The decision is made against the state this edit *produces*, by running
        the reducer — not by re-deriving "is it dirty now" here. There is one
        definition of what an edit does to the status (`edited`, which keeps a
        conflict a conflict and a queued draft queued) and one definition of
        what may be written without being asked for (`autosaves`); a second
        copy of either in this callback is how they come to disagree, and the
        direction that disagreement fails is an automatic write over somebody
        else's version.
      */
      if (autosaves(editorReducer(current, { type: "edited", text }))) {
        autosave.edited(current.path);
      } else {
        autosave.cancel();
      }

      const offline = offlineRef.current;
      if (current.status === "queued") {
        offline.queueSave({ path: current.path, text, baseEtag: current.etag });
        return;
      }
      if (text === current.baseline) {
        offline.forgetDraft(current.path);
        return;
      }
      offline.rememberDraft({
        path: current.path,
        text,
        baseEtag: current.etag,
        savedAt: Date.now(),
      });
    },
    [autosave],
  );

  const dismissNotice = useCallback(() => setNotice(null), []);

  /* ---------------------- offline: more than saving ---------------------- */

  /**
   * Whether an operation on `path` goes into the queue rather than to the
   * bucket: always offline, and online for a note the bucket does not have at
   * that name yet (`routesThroughQueue`). Decided from the signal, never by
   * trying and waiting — see `run`.
   */
  const viaQueue = useCallback(
    (path: string) =>
      offlineRef.current.reachability === "offline" || offlineRef.current.routesThroughQueue(path),
    [],
  );

  /**
   * The version of a note this device holds, for an op to be checked against:
   * the open editor's if the note is open (what the person is looking at), the
   * mirror's otherwise. `null` when it has neither — and then the op is refused
   * locally rather than sent unchecked.
   */
  const deviceEtag = useCallback(async (path: string): Promise<string | null> => {
    const shown = editorRef.current;
    if (shown.path === path && shown.etag !== null) return shown.etag;
    const offline = offlineRef.current;
    const copy = await offline.cachedNote(offline.serverPathOf(path));
    return copy?.value.etag ?? null;
  }, []);

  /** A toast for something queued, with its undo — or with none once it has gone. */
  const queuedToast = useCallback((message: string, undo?: () => boolean, afterUndo?: () => void) => {
    nextToastId.current += 1;
    setToasts([
      {
        id: `queued-${nextToastId.current}`,
        message,
        ...(undo === undefined
          ? {}
          : {
              undo: () => {
                if (undo()) {
                  afterUndo?.();
                  return;
                }
                setNotice("That has already gone to your bucket, so it cannot be undone here.");
              },
            }),
      },
    ]);
    // A drain that is possible now goes now — online, a note renamed or
    // created here is queued only to keep its order.
    if (offlineRef.current.reachability !== "offline") offlineRef.current.drain();
  }, []);

  /**
   * Is this a folder, as the console draws it? The listing says when it knows,
   * and the path's shape when it does not — a note is `.md` by construction.
   */
  const isFolderPath = useCallback(
    (path: string) => {
      const known = findEntry(listings, path);
      return known === null ? !isMarkdown(path) : known.kind === "folder";
    },
    [listings],
  );

  /* ------------------------------------------------------------------ */
  /*                     drawing it before sending it                    */
  /* ------------------------------------------------------------------ */

  /**
   * Move a row on screen now, and hand back the undo `run` needs.
   *
   * The complaint this answers is in `optimistic.ts`: a rename or a drag used
   * to await `moveEntry` and then a `listFiles` per touched folder before one
   * pixel changed, and for a folder it then collapsed the subtree, because the
   * listings under it were still keyed at a path the bucket no longer had.
   *
   * Three things move together, and they have to be one function or they come
   * apart: the listings, the set of expanded folders, and the selection. The
   * middle one is the whole of "the tree does not collapse" — `expanded` names
   * paths, so a folder renamed without re-keying it is a folder that was open
   * and is now shut.
   *
   * The selection is deliberately *closed* rather than followed when it is
   * inside what moved. Following it means reading the note again at its new
   * path, and `move` has always closed the editor for the folder it was given;
   * a note three levels down is the same event and gets the same answer. An
   * open tab left pointing at a path the bucket no longer has is the bug this
   * replaces, not the behaviour it keeps.
   */
  const drawListingMove = useCallback(
    (from: string, to: string): (() => void) => {
      setListings((current) => applyMove(current, from, to));
      setExpanded((current) => rekeyPaths(current, from, to));
      return () => {
        setListings((current) => applyMove(current, to, from));
        setExpanded((current) => rekeyPaths(current, to, from));
      };
    },
    [],
  );

  /** `drawListingMove`, and the selection closed if it travelled with it. */
  const drawMove = useCallback(
    (from: string, to: string): (() => void) => {
      const undo = drawListingMove(from, to);
      const selected = selectedPathRef.current;
      if (selected !== null && rekeyPath(selected, from, to) !== selected) {
        setSelectedPath(null);
        dispatch({ type: "closed" });
      }
      return undo;
    },
    [drawListingMove],
  );

  /**
   * Which folders a move has to reload, and whether its subtree cascades.
   *
   * A note touches two folders and nothing else. A **folder** carries every
   * path beneath it into a different place in `privacy.md`, so the defaults
   * its contents inherit can change — and `applyMove` deliberately does not
   * recompute those, because guessing a visibility is how a console comes to
   * tell somebody a shared note is private. The re-keyed subtree is what makes
   * the screen right *now*; `cascadeFrom` is what makes it true, folder by
   * folder, as `refresh` commits each page.
   */
  const moveResult = useCallback((from: string, to: string) => {
    /*
      `listingsRef` and not the closed-over `listings`, and the call site has
      to make it **before** `drawMove` — the drawing re-keys the subtree, and a
      verdict taken after it would find nothing under `from` and quietly skip
      the cascade. That is exactly what an *undo* does, which is the path this
      was wrong on: moving a folder back left its contents drawn with the
      visibility the destination gave them.
    */
    const loaded = listingsRef.current;
    const known = findEntry(loaded, from);
    const isFolder = known === null ? !isMarkdown(from) : known.kind === "folder";
    return isFolder && subtreeOf(loaded, from).length > 0
      ? { touched: [from, to], cascadeFrom: to }
      : { touched: [from, to] };
  }, []);

  /**
   * Rename or move a note through the queue. Shared by `rename` and `move`,
   * which differ only in where the note ends up and what the toast says.
   */
  const queueMoveOf = useCallback(
    (path: string, to: string, message: string) => {
      if (!options.canEdit) return;
      const offline = offlineRef.current;
      if (isFolderPath(path)) return setNotice(FOLDER_NEEDS_CONNECTION);
      if (offline.claims(to) && offline.serverPathOf(path) !== to) {
        return setNotice(claimedMessage(displayName(baseName(to))));
      }
      void (async () => {
        // Anything the timer is holding for this note is queued first, under
        // the name the bucket knows — so it is sent ahead of the rename.
        autosave.flush(path);
        const etag = await deviceEtag(path);
        const queued = offlineRef.current.queueMove({ from: path, to, etag });
        if (!queued.ok) {
          setNotice(etag === null ? NOT_ON_DEVICE : claimedMessage(displayName(baseName(to))));
          return;
        }
        const followed = selectedPathRef.current === path;
        if (followed) select(to);
        queuedToast(`${message} Waiting to sync.`, queued.undo, () => {
          if (selectedPathRef.current === to) select(path);
        });
      })();
    },
    [autosave, deviceEtag, isFolderPath, options.canEdit, queuedToast, select],
  );

  /** Delete (to the trash) or archive a note through the queue. */
  const queueRemovalOf = useCallback(
    (path: string, kind: "trash" | "archive") => {
      if (!options.canEdit) return;
      if (isFolderPath(path)) return setNotice(FOLDER_NEEDS_CONNECTION);
      void (async () => {
        autosave.flush(path);
        const etag = await deviceEtag(path);
        const queued = offlineRef.current.queueRemoval({ kind, path, etag });
        if (!queued.ok) {
          setNotice(etag === null ? NOT_ON_DEVICE : claimedMessage(displayName(baseName(path))));
          return;
        }
        if (selectedPathRef.current === path) {
          setSelectedPath(null);
          dispatch({ type: "closed" });
        }
        const name = displayName(baseName(path));
        const dropped = queued.dropped;
        if (dropped !== undefined) {
          /*
            A note created here and deleted before it was sent: nothing reaches
            the bucket, and its text is gone from the device. The undo is the
            only way back, so it is offered — putting the create back exactly as
            it was, unless something has taken the name since.
          */
          nextToastId.current += 1;
          setToasts([
            {
              id: `queued-${nextToastId.current}`,
              message: `Deleted ${name}. It had not synced, so nothing was sent.`,
              undo: () => offlineRef.current.restoreCreate(dropped),
            },
          ]);
          return;
        }
        queuedToast(
          kind === "trash" ? `Deleted ${name}. Waiting to sync.` : `Archived ${name}. Waiting to sync.`,
          queued.undo,
        );
      })();
    },
    [autosave, deviceEtag, isFolderPath, options.canEdit, queuedToast],
  );

  const createNote = useCallback(
    (folder: string, rawName: string) => {
      const name = ensureMarkdown(rawName);
      const problem = describeNameProblem(name) ?? collision(listings, folder, name);
      if (problem !== null) return setNotice(problem);
      const path = joinPath(folder, name);
      /*
        Offline, the note is made on the device and opened at once — the core
        of taking notes offline. It is a queued create (`baseEtag: null`), so
        what is eventually sent is the same `writeNote` with no `expectedEtag`
        this function makes online, and the server's create refuses if a note
        appeared at that name meanwhile: parked as a conflict, with nothing
        overwritten. The name checks above are the same ones, against the
        listings as drawn — the queue's own new notes included.
      */
      if (offlineRef.current.reachability === "offline") {
        if (!options.canEdit || workspaceId === null) return;
        if (isDrawingPath(name)) return setNotice(DRAWING_NEEDS_CONNECTION);
        if (offlineRef.current.claims(path)) return setNotice(claimedMessage(displayName(name)));
        const text = `# ${name.replace(/\.md$/i, "")}\n\n`;
        offlineRef.current.queueSave({ path, text, baseEtag: null });
        setExpanded((current) => (folder === "" ? current : new Set([...current, folder])));
        select(path);
        return;
      }
      void run(async () => {
        /*
          A drawing is seeded as a drawing, whichever control got here.

          `# name` is right for a note and is a file the gateway *refuses* on a
          `.excalidraw.md` path — `toolWriteNote` demands that a write to one
          carry a payload, so a person who typed `plan.excalidraw` into New
          note used to get an error rather than a drawing. Branching on the
          name rather than adding a second write path means every surface that
          creates a note gets this: the toolbar, the phone's `+`, and a folder
          row's menu.
        */
        const text = isDrawingPath(name) ? newDrawing() : `# ${name.replace(/\.md$/i, "")}\n\n`;
        await writeNote({ workspaceId: workspaceId!, path, text });
        return { touched: [path] };
      }).then((ok) => {
        if (ok) select(path);
      });
    },
    [listings, options.canEdit, run, select, workspaceId, writeNote],
  );

  /**
   * New drawing: the same creation as above, with the suffix supplied.
   *
   * A person names a diagram, not a file format, and `<name>.excalidraw.md` is
   * two extensions they should not have to know about. Delegating rather than
   * writing means the collision and name checks are the note's, once.
   */
  const createDrawing = useCallback(
    (folder: string, rawName: string) => {
      const trimmed = rawName.trim();
      createNote(folder, isDrawingPath(ensureMarkdown(trimmed)) ? trimmed : `${trimmed}.excalidraw`);
    },
    [createNote],
  );

  /**
   * The notes made without a name that have not taken one yet.
   *
   * Session-scoped and deliberately not derived from the *name* alone. A path
   * matching `untitled-<date>` is not enough to earn an automatic rename: a
   * note made yesterday, opened today, whose heading somebody had already
   * changed by hand would rename itself the moment it loaded — a file moving in
   * somebody's bucket because they looked at it. Only a note this session
   * created without asking for a name is a note this session may name.
   *
   * An entry leaves when the rename fires, so the adoption happens **once**.
   * After that the heading and the filename are two things the person owns
   * separately, which is how every other note in the bucket already works.
   */
  const awaitingTitle = useRef<Set<string>>(new Set());

  /**
   * New note, new drawing: made now, called `untitled-<date>`, opened.
   *
   * Delegates rather than writing, so the name checks, the collision check, the
   * offline queue and the drawing seed are all `createNote`'s — one create in
   * this file, whatever asked for it. What is added here is the name and the
   * promise that the name is temporary. See `untitled.ts`.
   */
  const createUntitled = useCallback(
    (folder: string, kind: "note" | "drawing") => {
      if (!options.canEdit) return;
      const make = (known: Listings) => {
        const name = untitledName(known, folder, kind, new Date());
        awaitingTitle.current.add(joinPath(folder, name));
        createNote(folder, name);
      };
      /*
        THE DESTINATION IS LOADED FIRST, AND THAT IS NOT A TIDINESS POINT.

        The name is chosen against the folder's listing, and listings are fetched
        per folder — so a destination nobody has opened reads as *empty*, and
        every untitled note made into it is called `untitled-<date>` with no
        suffix. The second one is then a name the bucket already has, and the
        server's create refuses it.

        That is not hypothetical: the quick-note link (`?quickAction=note`) files
        into `0-inbox` from a widget, on a console that has loaded the root and
        nothing else. Two captures on one day, in two launches, is the ordinary
        use of a capture widget — and before this the second was an error
        message.

        Loaded, this is one `listFiles` the console was going to make anyway when
        the create's own `refresh` ran. Unloaded and unreachable, the refusal
        surfaces through `reportRefreshFailure` rather than as a note that
        silently did not appear.
      */
      if (listings[folder] !== undefined) return make(listings);
      void refresh([folder])
        .then(({ pages }) => make({ ...listingsRef.current, ...pages }))
        .catch(reportRefreshFailure);
    },
    [createNote, listings, options.canEdit, refresh, reportRefreshFailure],
  );

  const createFolder = useCallback(
    (folder: string, name: string) => {
      const problem = describeNameProblem(name) ?? collision(listings, folder, name);
      if (problem !== null) return setNotice(problem);
      const path = joinPath(folder, name);
      if (offlineRef.current.reachability === "offline") {
        /*
          The server makes a folder real by writing its README placeholder,
          and this is that same call made later (`queueFolder`). Drawn now, as
          an empty folder, so a note can be made in it straight away.
        */
        if (!options.canEdit || workspaceId === null) return;
        if (offlineRef.current.claims(path)) return setNotice(claimedMessage(name));
        const queued = offlineRef.current.queueFolder(path);
        if (!queued.ok) return setNotice(claimedMessage(name));
        setExpanded((current) => new Set([...current, path]));
        queuedToast(`New folder ${withoutSortPrefix(name)}. Waiting to sync.`, queued.undo);
        return;
      }
      /*
        Drawn before it is sent, like a move — see `optimistic.ts`. A new
        folder used to appear only after `createDirectory` and the two listing
        reads that followed it, so pressing "New folder" and typing a name got
        you an unchanged tree and then, a beat later, a folder. The offline arm
        above has always drawn it immediately (`queueFolder`, through
        `overlay.ts`); this is the online arm finally doing the same thing.
      */
      setListings((current) => applyFolderCreate(current, path));
      void run(
        async () => {
          await createDirectory({ workspaceId: workspaceId!, path });
          return { touched: [path, joinPath(path, "README.md")] };
        },
        () => setListings((current) => undoFolderCreate(current, path)),
      );
      setExpanded((current) => new Set([...current, path]));
    },
    [createDirectory, listings, options.canEdit, queuedToast, run, workspaceId],
  );

  const move = useCallback(
    (path: string, destinationFolder: string) => {
      const problem = describeMoveProblem(
        path,
        destinationFolder,
        namesIn(listings, destinationFolder),
      );
      if (problem !== null) return setNotice(problem);
      const to = joinPath(destinationFolder, path.slice(path.lastIndexOf("/") + 1));
      const from = parentPath(path);
      if (viaQueue(path)) return queueMoveOf(path, to, `Moved to ${folderLabel(destinationFolder)}.`);
      const result = moveResult(path, to);
      const undoDraw = drawMove(path, to);
      void run(async () => {
        await moveEntry({ workspaceId: workspaceId!, from: path, to });
        return {
          ...result,
          message: `Moved to ${folderLabel(destinationFolder)}.`,
          // `moveEntry` is its own inverse — the same action with the ends
          // swapped — so this is the real operation and not a re-derivation of
          // it. It goes through `run` for the same reason the move did: a
          // failure has to reach the notice line, and the tree has to reload.
          undo: () => {
            // Verdict first — see `moveResult`.
            const back = moveResult(to, path);
            const undoUndo = drawMove(to, path);
            void run(
              async () => {
                await moveEntry({ workspaceId: workspaceId!, from: to, to: path });
                return { ...back, message: `Moved back to ${folderLabel(from)}.` };
              },
              undoUndo,
            );
          },
        };
      }, undoDraw);
    },
    [drawMove, listings, moveEntry, moveResult, queueMoveOf, run, viaQueue, workspaceId],
  );

  /* ------------------------------------------------------------------ */
  /*                     moving into another context                      */
  /* ------------------------------------------------------------------ */

  /**
   * Whose contexts this person may send something to.
   *
   * Gated on owning the context they are standing in, which is the *source*
   * half of the rule `functions/contextMoves.ts` enforces. The caller has
   * already filtered the list by what they may write at the far end.
   */
  const moveDestinations = useMemo(
    () =>
      options.isOwner === true
        ? (options.destinations ?? []).filter((destination) => destination.id !== workspaceId)
        : [],
    [options.destinations, options.isOwner, workspaceId],
  );

  const destinationFolders = useCallback(
    async (contextId: string) => {
      const answer = await folderPathsAction({ workspaceId: contextId as Id<"workspaces"> });
      return { folders: answer.folders, truncated: answer.truncated };
    },
    [folderPathsAction],
  );

  /**
   * The moves out of this context, as the dialog and the pane read them.
   *
   * Owner-only on the server too, so this subscribes only where the rail
   * already says they own it — a query that would be refused is a permanent
   * error state on every paint.
   */
  const moveRows = useQuery(
    api.functions.contextMoves.listContextMoves,
    options.isOwner === true && workspaceId !== null ? { workspaceId } : "skip",
  );

  const contextMoves: readonly ContextMoveProgress[] = useMemo(() => {
    const named = new Map((options.destinations ?? []).map((one) => [one.id, one.label]));
    return (moveRows ?? []).map((row) => ({
      id: row.moveId,
      from: row.from,
      to: row.to,
      // The id is a poor label and a deliberate one: a context this person can
      // no longer see must not have its name re-printed from a stale row.
      destination: named.get(row.destinationWorkspaceId) ?? row.destinationWorkspaceId,
      status: row.status,
      objects: row.movedObjects,
      skipped: row.skipped,
      ...(row.error === undefined ? {} : { error: row.error }),
    }));
  }, [moveRows, options.destinations]);

  /*
    A MOVE THAT FINISHED SOMEWHERE ELSE STILL HAS TO SHOW UP HERE.

    Every other operation reloads the tree inside `run`, because it is over by
    the time `run` returns. This one is not: the press starts a job, the last
    batch lands seconds or minutes later in a scheduled action, and nothing on
    this device is waiting on it. Without this the folder it came out of keeps
    drawing notes the bucket no longer has, until something else happens to
    reload it.

    Keyed on the transition rather than on the row, so a completed move sitting
    in the list for its day does not re-refresh on every paint.
  */
  const settledMoves = useRef(new Set<string>());
  useEffect(() => {
    const done = contextMoves.filter((move) => move.status !== "moving");
    const fresh = done.filter((move) => !settledMoves.current.has(move.id));
    for (const move of done) settledMoves.current.add(move.id);
    if (fresh.length === 0) return;
    for (const move of fresh) {
      // `cascadeFrom` as well as the parent, because what moved was often a
      // folder: its own listing and every loaded listing beneath it describe a
      // subtree that is not there any more. The parent alone takes the row out
      // of the tree and leaves those behind, which is the state a reopened
      // breadcrumb draws from.
      void refresh(
        foldersToRefresh([move.from], {
          cascadeFrom: move.from,
          loaded: Object.keys(listingsRef.current),
        }),
      );
    }
  }, [contextMoves, refresh]);

  const moveToContext = useCallback(
    (path: string, contextId: string, destinationFolder: string) => {
      const destination = moveDestinations.find((one) => one.id === contextId);
      if (destination === undefined) {
        return setNotice("You can only move things into a context you can write to.");
      }
      const to = joinPath(destinationFolder, baseName(path));
      void run(async () => {
        await startContextMoveAction({
          sourceWorkspaceId: workspaceId!,
          from: path,
          destinationWorkspaceId: contextId as Id<"workspaces">,
          to,
        });
        return {
          touched: [path],
          /*
            The present tense is the honest one. `startContextMove` returns as
            soon as the job exists; nothing has crossed yet, and a folder of a
            few thousand notes will still be crossing when this toast is gone.
            `contextMoves` is what says when it is done — and no `undo`,
            because the inverse of a move that is still running is not a move.
          */
          message: `Moving to ${destination.label}…`,
        };
      });
      if (selectedPath === path) {
        setSelectedPath(null);
        dispatch({ type: "closed" });
      }
    },
    [moveDestinations, run, selectedPath, startContextMoveAction, workspaceId],
  );

  const resumeContextMove = useCallback(
    (id: string) => {
      void run(async () => {
        await resumeContextMoveAction({ moveId: id as Id<"contextMoves"> });
        return { touched: [], message: "Picking the move back up…" };
      });
    },
    [resumeContextMoveAction, run],
  );

  /**
   * Record that the outcome has been read, so the row stops being listed.
   *
   * Outside `run`, unlike every other call here, because it touches no file
   * and has nothing to say: `run` exists to reload what an operation changed
   * and to put a sentence on the screen, and a toast reporting that a notice
   * was dismissed is the notice again. The pane hides the line on the press
   * from its own state; this is what makes that answer survive the launch.
   *
   * Swallowed on failure on `dismissStorageMigrationOffer`'s model — what a
   * lost write costs is seeing the line once more, and an error banner over a
   * dismissal is a worse version of the thing being dismissed.
   */
  const dismissContextMove = useCallback(
    (id: string) => {
      void dismissContextMoveMutation({ moveId: id as Id<"contextMoves"> }).catch(() => {});
    },
    [dismissContextMoveMutation],
  );

  const rename = useCallback(
    (path: string, rawName: string) => {
      const folder = parentPath(path);
      const name = path.toLowerCase().endsWith(".md") ? ensureMarkdown(rawName) : rawName.trim();
      const problem = describeNameProblem(name) ?? collision(listings, folder, name);
      if (problem !== null) return setNotice(problem);
      const to = joinPath(folder, name);
      const was = baseName(path);
      if (viaQueue(path)) return queueMoveOf(path, to, `Renamed to ${name}.`);
      const result = moveResult(path, to);
      /*
        A rename of the OPEN note follows the editor rather than closing it,
        which is why `drawMove` is not used here and the listings are moved on
        their own. `drawMove` closes a selection that travelled — correct for a
        move, where you asked for the row to go somewhere else, and wrong for a
        rename, where you asked for the thing you are reading to be called
        something else and expect to go on reading it.

        Renaming a *folder* you have a note open inside is the move case and
        gets `drawMove`'s answer: the path changed under the editor and there
        is nothing sensible to keep it pointed at.
      */
      const renamedInPlace = selectedPath === path;
      const undoDraw = renamedInPlace ? drawListingMove(path, to) : drawMove(path, to);
      void run(async () => {
        await moveEntry({ workspaceId: workspaceId!, from: path, to });
        return {
          ...result,
          message: `Renamed to ${name}.`,
          undo: () => {
            // Verdict first — see `moveResult`.
            const backResult = moveResult(to, path);
            const open = selectedPathRef.current === to;
            const undoUndo = open ? drawListingMove(to, path) : drawMove(to, path);
            void run(async () => {
              await moveEntry({ workspaceId: workspaceId!, from: to, to: path });
              return { ...backResult, message: `Renamed back to ${was}.` };
            }, undoUndo).then((ok) => {
              // The editor follows the file, in both directions. Without this
              // an undone rename left the open tab pointing at a path the
              // bucket no longer has.
              if (ok && selectedPathRef.current === to) select(path);
            });
          },
        };
      }, undoDraw).then((ok) => {
        /*
          The listing is renamed on the press; the *editor* is not, and this
          stays where it was — after the server said yes. `select` reads the
          note at its new path, and that path does not exist until `moveEntry`
          returns, so moving this earlier would fetch a 404 and close the note
          somebody is reading.
        */
        if (ok && renamedInPlace) select(to);
      });
    },
    [
      drawListingMove,
      drawMove,
      listings,
      moveEntry,
      moveResult,
      queueMoveOf,
      run,
      select,
      selectedPath,
      viaQueue,
      workspaceId,
    ],
  );

  /**
   * AN UNTITLED NOTE TAKES THE TITLE YOU TYPE INTO IT.
   *
   * The other half of not asking for a name up front. `createUntitled` makes
   * `untitled-2026-09-19.md` seeded with that same word as its heading; the
   * person types over the heading, and this renames the file to match.
   *
   * ## Why it runs on a settled editor and nowhere else
   *
   * `clean` and `saved` are the two states where nothing is in flight: the draft
   * is in the bucket, the etag the editor holds is the one the bucket answered
   * with, and the autosave timer is spent. (`saved` is `clean` wearing a chip
   * that decays — see `EditorStatus` — so excluding it would mean the rename
   * waited on a *UI* timer, which is how it went missing the first time this was
   * written.) Renaming at any other moment races the write: `performSave`
   * captures the path when it is called, and a `moveEntry` that lands in between
   * would leave a conditional write aimed at a name the bucket no longer has.
   * There is machinery for exactly that — `serverPathOf`, which sends the queued
   * write to the old name ahead of the rename — and the right use of it is as a
   * safety net for the offline case rather than as the normal path for every new
   * note in the product.
   *
   * A note created **offline** is `queued`, so it is not titled until its drain
   * lands and the editor settles. That is the honest order: the bucket does not
   * have the note yet, so there is nothing there to rename.
   *
   * It is a rename and not a second create, so it goes through `rename` — the
   * collision check, the toast with its undo, and the `select(to)` that keeps
   * the open editor pointing at the file are all that function's, once.
   *
   * ## What stops it running twice
   *
   * The path leaves `awaitingTitle` **before** the rename is asked for, so a
   * re-render during the move cannot start a second one, and a person who
   * rewrites the heading afterwards keeps the filename they were given. A
   * rename that is refused therefore costs the note its automatic title and
   * nothing else: the notice says why, and Rename is on the row menu.
   */
  useEffect(() => {
    const path = editor.path;
    if (path === null) return;
    if (editor.status !== "clean" && editor.status !== "saved") return;
    if (!awaitingTitle.current.has(path)) return;
    // Belt and braces with the set above: a name that is not one of ours is
    // never renamed, whatever the set says.
    if (!isUntitled(path)) {
      awaitingTitle.current.delete(path);
      return;
    }
    const name = nameFromTitle(path, editor.draft);
    if (name === null) return;
    awaitingTitle.current.delete(path);
    rename(path, name);
  }, [editor.draft, editor.path, editor.status, rename]);

  const duplicate = useCallback(
    (path: string) => {
      void run(async () => {
        const result = await duplicateEntry({ workspaceId: workspaceId!, path });
        return { touched: [path, result.to] };
      });
    },
    [duplicateEntry, run, workspaceId],
  );

  /**
   * Put a note, or a whole folder, on the person's own disk.
   *
   * ## The last step of the exit, which was the one that was missing
   *
   * Non-negotiable #1 promises the customer can always leave with their
   * content and that the exit is never gated or degraded. Everything under
   * that was built — plain Markdown, a bucket they hold the key to, a
   * hand-off that survives cancellation — except the step somebody actually
   * takes. Getting your own writing out of the console meant opening the
   * bucket somewhere else, which asks a person to hold cloud credentials to
   * read what they wrote.
   *
   * ## Deliberately not behind `canEdit`
   *
   * Every other verb in this file goes through `run`, which refuses a
   * read-only console. This does not, and that is the point rather than an
   * oversight: downloading is a **read**, it asks the server nothing the row's
   * own Open does not, and gating the exit on write access would make it
   * exactly the degraded thing the non-negotiable forbids. A `member` in
   * somebody else's context downloads what they can see, and a note held back
   * is absent from the archive the same way it is absent from the listing —
   * `notePaths` and `readNotes` are both filtered by the live manifest.
   *
   * ## A folder is one archive, and a short one says so
   *
   * The fetching, its bound and what it does with a note it cannot read are in
   * `download.ts`, away from React, because the bound is the part a hand-test
   * never reaches. An archive that is quietly incomplete is the worst outcome
   * on this path — nobody finds out until the bucket is gone — so the count is
   * said out loud.
   */
  const download = useCallback(
    (path: string, kind: "file" | "folder") => {
      if (workspaceId === null) return;
      void (async () => {
        try {
          if (kind === "file") {
            const note = await readNote({ workspaceId, path });
            const saved = saveFile(
              downloadName(path, ".md"),
              new TextEncoder().encode(note.text),
              "text/markdown;charset=utf-8",
            );
            setNotice(
              saved
                ? downloadNotice("file", 1, 0)
                : "This device cannot save a file. Open the console in a browser to download.",
            );
            return;
          }

          const listed = await notePathsAction({ workspaceId });
          if (listed.paths === null) {
            // The walk did not reach the end, so an archive built from it
            // would be short with nothing saying so. Refused rather than
            // written — see the header.
            setNotice("That folder could not be listed to the end, so nothing was downloaded.");
            return;
          }
          const wanted = pathsUnder(listed.paths, path);
          const { entries, missed } = await collectNotes(wanted, async (batch) => {
            const answer = await readNotesAction({ workspaceId, paths: batch });
            return answer.results as never;
          });
          const saved = saveFile(
            downloadName(path, ".zip"),
            buildZip(entries),
            "application/zip",
          );
          setNotice(
            saved
              ? downloadNotice("folder", entries.length, missed.length)
              : "This device cannot save a file. Open the console in a browser to download.",
          );
        } catch (error) {
          setNotice(toFileError(error).message);
        }
      })();
    },
    [notePathsAction, readNote, readNotesAction, workspaceId],
  );

  const archive = useCallback(
    (path: string) => {
      if (viaQueue(path)) return queueRemovalOf(path, "archive");
      void run(async () => {
        const result = await archiveEntry({ workspaceId: workspaceId!, path });
        return {
          touched: [path, result.to],
          // Without its sort number, the way the row somebody just acted on
          // was drawn — that row is gone from the listing by the time they
          // read this. (`rename`'s own `was`, above, keeps the whole name on
          // disk: that message is the undo of a rename, so the name it will
          // put back is exactly the point.)
          message: `Archived ${withoutSortPrefix(baseName(path))}.`,
          // The inverse is a move, not an "unarchive": `archiveEntry` puts the
          // file under a timestamped folder in `4-archive/`, so the way back is
          // to move it out of there to where it was. `restoreTargetFor` reads
          // that original path back out and the row menu's Restore uses the
          // same function, so the two ways back cannot disagree.
          undo: () => {
            void run(async () => {
              await moveEntry({ workspaceId: workspaceId!, from: result.to, to: path });
              return {
                touched: [result.to, path],
                message: `Restored to ${folderLabel(parentPath(path))}.`,
              };
            });
          },
        };
      });
      if (selectedPath === path) {
        setSelectedPath(null);
        dispatch({ type: "closed" });
      }
    },
    [archiveEntry, moveEntry, queueRemovalOf, run, selectedPath, viaQueue, workspaceId],
  );

  const destroy = useCallback(
    (path: string) => {
      if (viaQueue(path)) return queueRemovalOf(path, "trash");
      void run(async () => {
        const result = await trashEntry({ workspaceId: workspaceId!, path });
        return {
          touched: [path, result.to],
          message: `Moved ${withoutSortPrefix(baseName(path))} to trash.`,
          undo: () => {
            void run(async () => {
              await restoreTrashEntry({
                workspaceId: workspaceId!,
                from: result.to,
                to: path,
              });
              return {
                touched: [result.to, path],
                message: `Restored to ${folderLabel(parentPath(path))}.`,
              };
            });
          },
        };
      });
      if (selectedPath === path) {
        setSelectedPath(null);
        dispatch({ type: "closed" });
      }
    },
    [queueRemovalOf, restoreTrashEntry, run, selectedPath, trashEntry, viaQueue, workspaceId],
  );

  const paste = useCallback(
    (destinationFolder: string) => {
      const plan = planPaste(clipboard, destinationFolder, namesIn(listings, destinationFolder));
      if (!plan.ok) return setNotice(plan.reason);
      const held = clipboard!;
      void run(async () => {
        if (plan.action === "move") {
          await moveEntry({ workspaceId: workspaceId!, from: plan.from, to: plan.to });
        } else {
          await copyEntry({ workspaceId: workspaceId!, from: plan.from, to: plan.to });
        }
        return { touched: [plan.from, plan.to] };
      }).then((ok) => {
        if (ok) setClipboard(afterPaste(held));
      });
    },
    [clipboard, copyEntry, listings, moveEntry, run, workspaceId],
  );

  /**
   * A copy whose source is an argument, for the ⌥-drop on the tree.
   *
   * `paste` above is right for the toolbar and the menu, where the clipboard
   * *is* what the person chose. A drop is not that: what is being copied is
   * what is under the cursor, and the clipboard is somebody else's business.
   * The call site used to bridge the two with `copy(from)` then `paste(to)`,
   * which cannot work — `copy` sets state and `paste` reads the clipboard from
   * the render that created it, so in one tick the paste sees the clipboard as
   * it was *before* the drag. On an empty clipboard that refused and threw the
   * person's clipboard away; on a pending cut it moved an unrelated file into
   * the drop folder.
   *
   * So the source is passed in and a `Clipboard` value is built here to hand to
   * `planPaste` — the naming and collision rules stay in one place, because a
   * drop and a paste disagreeing about which "… copy" name something lands
   * under would be its own small betrayal. Nothing here reads or writes
   * `clipboard`, which is also why this callback does not depend on it.
   *
   * The plan is always a copy (the mode says so), so there is no `move` branch
   * to get wrong — but it can still be refused, by a folder dropped inside
   * itself, and that refusal is worth showing.
   */
  const copyTo = useCallback(
    (from: string, destinationFolder: string) => {
      const plan = planPaste(
        put("copy", from),
        destinationFolder,
        namesIn(listings, destinationFolder),
      );
      if (!plan.ok) return setNotice(plan.reason);
      void run(async () => {
        await copyEntry({ workspaceId: workspaceId!, from: plan.from, to: plan.to });
        return { touched: [plan.from, plan.to] };
      });
    },
    [copyEntry, listings, run, workspaceId],
  );

  /**
   * Write one entry's visibility.
   *
   * **Answers whether it landed**, because `setScope` runs steps in sequence
   * and must not carry on past a refusal — the same contract `runShare` has,
   * and for the same reason. It used to return nothing, so the one step in a
   * sequence that goes through this one was fired and stepped over: "opening"
   * a note is *widen the manifest, then mint the link*, and the mint left
   * before the widening had answered. `stepsTo` settles that order and this is
   * what makes the order real.
   *
   * Every other caller presses it and walks away, which is unchanged — a
   * returned value nobody reads costs nothing.
   */
  const setVisibility = useCallback(
    async (
      path: string,
      kind: "file" | "folder",
      visibility: SettableVisibility,
    ): Promise<boolean> => {
      /*
        The backstop, beside the one in `setScope`.

        `setScope` refuses up front so no link work happens first; this catches
        every caller that reaches the setter directly — the Browse pane's
        button, the Explorer's cycle, the Privacy panel's folder toggle. Both
        exist because the first version of this guard was on one surface and
        the escalation was on three: a group rule is not one of the two words
        this setter can write, so writing either DELETES it, and the note it
        held back is published to the whole workspace.
      */
      const current = findEntry(listings, path)?.visibility;
      if (current !== undefined && isGroupVisibility(current)) {
        setNotice(
          `${path} is shared with ${current}. Changing that is not something this control can do.`,
        );
        return false;
      }
      return await run(async () => {
        if (kind === "folder") {
          await setDirectoryVisibility({ workspaceId: workspaceId!, path, visibility });
          return { touched: [path], cascadeFrom: path };
        }
        await setNoteVisibility({ workspaceId: workspaceId!, path, visibility });
        return { touched: [path] };
      });
    },
    [listings, run, setDirectoryVisibility, setNoteVisibility, workspaceId],
  );

  /**
   * Write a working `privacy.md` over one that is missing or unreadable.
   *
   * Goes through `run` like every other operation, so it inherits the timeout,
   * the generation counter and the "a failed refresh is not a failed
   * operation" rule — and, crucially, `run`'s own `canEdit` gate. The message
   * is not a courtesy: this rewrites the file that governs the whole context,
   * and the only visible change is that the banner disappears, so without a
   * sentence the person cannot tell it from a button that did nothing.
   *
   * **Refreshing the root alone is enough, and that is worth stating because
   * it looks like an omission.** A manifest rewrite would normally have to
   * cascade through every open folder. This one cannot change what anybody
   * sees: the caller is always the owner, who reads at `private` scope and
   * therefore sees every note either way, and the repair writes every folder
   * `private` over a manifest that was already failing closed — so each
   * entry's `visibility`, `inherited` and `exception` come out identical, and
   * so does every loaded folder's `folderDefault`. The one field that changes
   * is `manifestUsable`, and the pane reads it from `listings[""]`.
   */
  const resetPrivacy = useCallback(() => {
    void run(async () => {
      const result = await resetPrivacyAction({ workspaceId: workspaceId! });
      const declared =
        result.folders.length === 0
          ? "It has no folder rules yet."
          : `It declares ${result.folders.length} folder${result.folders.length === 1 ? "" : "s"}, every one of them private.`;
      // A short list is never printed as a complete one — the rule
      // `noteCountTruncated` follows, for the same reason. Anything left out
      // has no rule, so it stays private and can be given a line by hand.
      const short = result.partial
        ? " Some folders could not be listed as rules; those stay private and can be added to the file by hand."
        : "";
      const kept =
        result.backedUpTo === null
          ? ""
          : ` The file that could not be read was kept at ${result.backedUpTo}.`;
      return {
        touched: [result.path],
        message: `privacy.md has been rewritten. ${declared}${short}${kept} Share a folder when you are ready by changing its visibility.`,
      };
    });
  }, [resetPrivacyAction, run, workspaceId]);

  /**
   * Start the resumable storage-layout migration for an owner.
   *
   * The action copies only Context's reserved plumbing objects; it never
   * names a note path, and the server delays deletion of the legacy copies
   * for the rollback window after every destination has been verified.
   */
  const updateStorageLayout = useCallback(() => {
    void run(async () => {
      await updateStorageLayoutAction({ workspaceId: workspaceId! });
      return {
        touched: [],
        message:
          "Context is checking this bucket and will migrate its hidden system files in the background when it is safe. Your notes and folders are unchanged.",
      };
    });
  }, [run, updateStorageLayoutAction, workspaceId]);

  // Keep the tree open down to whatever is selected, so a path opened from a
  // link or restored after a move does not appear in a collapsed tree.
  useEffect(() => {
    if (selectedPath === null) return;
    const missing = ancestorsOf(selectedPath).filter((folder) => !expanded.has(folder));
    if (missing.length === 0) return;
    setExpanded((current) => new Set([...current, ...missing]));
    void refresh(missing.filter((folder) => listings[folder] === undefined)).catch(
      reportRefreshFailure,
    );
  }, [expanded, listings, refresh, reportRefreshFailure, selectedPath]);

  /**
   * Somebody else wrote to this bucket, so the folder it landed in is stale.
   *
   * Every write the console makes refreshes its own folder — `save`, `create`,
   * `move`, `archive`. A meeting is the first write that reaches the same
   * bucket from outside this hook (`features/meetings/convexGateway.ts`), and
   * until it announced itself the listing simply stayed as it was: the note was
   * in the customer's bucket, visible on any client that had not read that
   * folder yet, and absent on the phone that had. `bucketWrites.ts` carries the
   * whole argument, including why this hook does not know what a meeting is.
   *
   * The workspace check is not a formality. One device is signed into several
   * contexts and this hook is mounted for exactly one of them, so a write to
   * another one must refresh nothing here — the folder path means a different
   * folder in a different bucket, and reloading `0-inbox` because a meeting
   * landed in somebody else's `0-inbox` is a request that answers a question
   * nobody asked.
   *
   * It refreshes rather than invalidating: a listing dropped and not refetched
   * is a folder that empties on screen. `refresh` writes the answer through to
   * the device cache on its way past, so the stale copy is gone as well.
   *
   * ## The parent is not the only stale folder, and on the first meeting it is
   * not the stale one at all
   *
   * A write into a folder that did not exist changes its **grandparent** too:
   * the new folder is a new row there. The first version of this refreshed
   * `parentPath` alone, which was the whole fix for the second meeting and none
   * of it for the first — a person watching `0-inbox` records a meeting, the
   * default destination creates `0-inbox/meetings` under them, and the listing
   * they are actually looking at never learns it has a new folder in it. That
   * is the same symptom this effect exists to remove, one level up, and it was
   * reachable by exactly the path this change to the default makes ordinary.
   *
   * So it refreshes the parent **and every ancestor the browser is already
   * holding**, up to and including the root. Held, rather than all of them:
   * `refresh` on a folder nothing has asked for is a request whose answer
   * nothing draws. The parent stays unconditional because it is the folder that
   * certainly changed.
   *
   * `listingsRef` rather than `listings` in the dependency array: a listing
   * changes on every refresh, and an effect that re-subscribed each time would
   * tear down and rebuild the subscription inside its own callback's effects —
   * the render loop `consoleRenderLoop.test.ts` exists to catch.
   */
  const listingsRef = useRef(listings);
  listingsRef.current = listings;

  useEffect(() => {
    if (workspaceId === null) return;
    return onBucketWrite((write) => {
      if (write.workspaceId !== workspaceId) return;
      const held = listingsRef.current;
      const parent = parentPath(write.path);
      /*
        `""` is prepended because `ancestorsOf` starts at the first segment and
        never yields the root — right for auto-expanding a tree to a selection,
        wrong here, where a meeting filed into a brand new top-level folder
        makes the root listing the stale one.
      */
      const stale = ["", ...ancestorsOf(write.path)].filter(
        (folder) => folder === parent || held[folder] !== undefined,
      );
      void refresh([...new Set(stale)]).catch(reportRefreshFailure);
    });
  }, [refresh, reportRefreshFailure, workspaceId]);

  /* ------------------------------- sharing ------------------------------- */

  const mayShare = canShare({
    canEdit: options.canEdit,
    isOwner: options.isOwner === true,
  });

  /**
   * `"skip"` unless this console may share, and that is not an optimisation.
   *
   * `listShares` is `minimum: "owner"`, so subscribing as an editor throws — and
   * a Convex query that throws does so *during render*, which takes down the
   * whole console rather than hiding one dialog. The capability decides whether
   * to ask, exactly as it decides whether to draw the control.
   */
  const shares = useQuery(
    api.functions.shares.listShares,
    mayShare && workspaceId !== null ? { workspaceId } : "skip",
  ) as readonly NoteShare[] | undefined;
  /*
    The live rows, where a sequence that is already running can reach them.

    `setScope` runs several steps and the subscription can tick between two of
    them, so a closed-over `shares` is the set as it was when the press was
    made — which is exactly the staleness the queue beside it exists to remove.
    Same pattern, and the same reason, as `listingsRef`.
  */
  const sharesRef = useRef(shares);
  sharesRef.current = shares;

  const createShare = useMutation(api.functions.shares.createShare);
  const revokeShareMutation = useMutation(api.functions.shares.revokeShare);

  /**
   * Run a share mutation and put whatever it says in the notice line.
   *
   * The refusals here are ones the person can act on — a malformed `@name`, a
   * path that is not a note, too many shares outstanding — so the server's own
   * message is shown rather than replaced with a generic one. `toFileError` is
   * the same reader every other operation in this file uses.
   */
  const runShare = useCallback(
    async (work: () => Promise<unknown>, done: string | null): Promise<boolean> => {
      // Answers whether the work landed, because `setScope` runs steps in
      // sequence and must not carry on past a refusal — see `stepsTo`. A
      // caller that only wants the notice can ignore it, which every existing
      // one does.
      if (!mayShare || workspaceId === null) return false;
      try {
        await work();
        if (done !== null) setNotice(done);
        return true;
      } catch (error) {
        setNotice(toFileError(error).message);
        return false;
      }
    },
    [mayShare, workspaceId],
  );

  const share = useCallback(
    (path: string, recipient: string, titleInPreview?: boolean) => {
      if (workspaceId === null) return;
      void runShare(
        () =>
          createShare({
            workspaceId,
            path,
            recipient,
            ...(titleInPreview === undefined ? {} : { titleInPreview }),
          }),
        `Shared with ${recipient}.`,
      );
    },
    [createShare, runShare, workspaceId],
  );

  const createTeamShareMutation = useMutation(api.functions.shares.createTeamShare);
  const createLinkShareAction = useAction(api.functions.shares.createLinkShare);

  /**
   * The notes that currently have a link anybody can open.
   *
   * Derived from the same `listShares` subscription the dialog reads, so the
   * lock and the share list cannot disagree about what is published — a second
   * source for that would be a second place to be wrong, and the direction it
   * would fail is a control saying less is out there than is.
   *
   * `undefined` while the subscription is in flight is deliberately *not*
   * distinguished from "none": an owner whose shares have not loaded sees the
   * padlock they had before, and it corrects itself a tick later. The
   * alternative — a third icon state for "we do not know yet" — is a flicker on
   * every cold load of a control people press without looking.
   */
  const openLinkPaths = useMemo(() => {
    const paths = new Set<string>();
    for (const share of shares ?? []) {
      if (share.audience === "anyone") paths.add(share.entryPath);
    }
    return paths;
  }, [shares]);

  /**
   * Every note path this browser can offer the editor for link resolution:
   * `knownNotePaths(listings)` — the folders somebody has actually expanded,
   * which is always current — unioned with the search index's docmap, which
   * is complete but can be behind or entirely absent. See "L1" in
   * `docs/decisions/app-and-console.md`.
   *
   * A union rather than "prefer the index": a note created a moment ago and
   * visible in an expanded folder is real *now*, and the index has not
   * necessarily caught up with it yet — the same "the listing you can see
   * beats a derivative that has not" rule the rest of this file follows.
   */
  const linkPaths = useMemo(
    () => mergeLinkPaths(listings, indexedPaths),
    [listings, indexedPaths],
  );

  const copyShareLink = useCallback(
    async (
      target:
        | { kind: "team"; path: string }
        | { kind: "link"; path: string }
        | { kind: "share"; url: string },
    ): Promise<{ ok: boolean; message: string | null }> => {
      /**
       * Started inside the press, finished whenever the round trip is.
       *
       * `copyDeferred` calls this *once*, and calls it after it has already
       * asked the browser for the clipboard — which is the whole point, and
       * why minting cannot be hoisted out to an `await` above. See the
       * clipboard module for what iOS does to the alternative.
       */
      const produce = async (): Promise<string | null> => {
        if (target.kind === "share") return target.url;
        if (!mayShare || workspaceId === null || slug === null) return null;

        /**
         * The unlisted link, minted inside the copy like every other one.
         *
         * `createLinkShare` supersedes an active row **in place and keeps its
         * token**, so pressing this twice is one link rather than two — and
         * pressing it on a note that already has one copies the link that is
         * already out there rather than replacing it, which is the difference
         * between Copy link and Revoke.
         *
         * A note the team cannot read is refused here, in the server's own
         * words, rather than silently producing a URL that resolves to "not
         * available" for everybody who opens it.
         */
        if (target.kind === "link") {
          try {
            const { token, title } = await createLinkShareAction({
              workspaceId,
              path: target.path,
            });
            // The title comes back from the mint rather than being derived
            // here: the slug in this URL and the name on the card have to be
            // the same string, and a second copy of `titleFromPath` on this
            // side is a second thing to drift.
            return shareUrl(token, consoleOrigin(), title);
          } catch (error) {
            setNotice(toFileError(error).message);
            return null;
          }
        }

        try {
          await createTeamShareMutation({ workspaceId, path: target.path });
        } catch (error) {
          setNotice(toFileError(error).message);
          return null;
        }
        /**
         * The **readable** URL, not `/s/<token>`.
         *
         * A link pasted into a document or a chat should say what it points at,
         * and a 64-character token says nothing. The share row still exists —
         * it is what renders the card and what makes the preview *opt-in*, so a
         * note nobody linked unfurls as plain product branding — but the URL
         * people see and send is the one with the note's name in it.
         *
         * Access is unchanged either way: the console decides by membership.
         * The token is a locator for the card, never a grant.
         */
        return `${consoleOrigin()}${noteHref(slug, target.path)}`;
      };

      const { ok, text } = await copyDeferred(produce);
      /*
        A link that could not be made has already said why — `produce` set the
        server's own sentence. Saying "couldn't copy" over the top of it would
        replace a real refusal with a symptom of it.
      */
      if (text === null) return { ok: false, message: null };

      const message = ok
        ? "Link copied."
        : /*
            Not "copy failed". The clipboard is the only part that did not
            work, and the person still wants the link, so printing it is the
            one useful thing left.
          */
          `Couldn't reach the clipboard. The link is ${text}`;

      /*
        **Only a success is raised here.** The pane's notice sits *behind* the
        share dialog, and the dialog stays open when a copy fails — so putting
        the failure here made it unreadable, and on a platform where every copy
        failed the button appeared to do nothing at all. The caller shows that
        one where the press happened; see `copyShareLink` in `browser.ts`.
      */
      if (ok) setNotice(message);
      return { ok, message };
    },
    [createLinkShareAction, createTeamShareMutation, mayShare, slug, workspaceId],
  );

  const setShareSlugMutation = useMutation(api.functions.shares.setShareSlug);

  /**
   * Claim or release the name in `context.lc/@seyi/intake`.
   *
   * Answers whether it landed, unlike `revokeShare` beside it, because the
   * dialog's field has to decide whether to clear itself — and the notice this
   * sets is behind the modal, so a refusal it could not see would leave
   * somebody pressing Claim on a button that appears to do nothing.
   *
   * The name is lowercased here and nowhere else in the client: the server
   * lowercases it again, which is what actually decides, and a second place
   * that *did not* would make `Intake` a refusal on one path and a claim on
   * the other.
   */
  const setShareSlug = useCallback(
    (shareId: string, slug: string | null): Promise<boolean> =>
      runShare(
        () =>
          setShareSlugMutation({
            shareId: shareId as Id<"noteShares">,
            slug: slug === null ? null : slug.trim().toLowerCase(),
          }),
        slug === null
          ? "Short link released. That name is free again."
          : "Short link claimed. Anyone who types it gets what this link gives.",
      ),
    [runShare, setShareSlugMutation],
  );

  const setShareCollectingMutation = useMutation(api.functions.shares.setShareCollecting);

  /**
   * Turn a link's answer-taking on or off.
   *
   * A toggle, not a re-mint: `createLinkShare` supersedes, and routing this
   * through a creation path is how a press of "off" hands somebody a new token
   * for a link they had already sent. The server refuses a members link and a
   * folder link with its own sentence, which is what this reports — nothing
   * here decides who may collect.
   *
   * Answers whether it landed, like `setShareSlug` beside it and for the same
   * reason: the notice is behind the modal, so a switch that flipped back has
   * to be able to flip back.
   */
  const setShareCollecting = useCallback(
    (shareId: string, collecting: boolean): Promise<boolean> =>
      runShare(
        () =>
          setShareCollectingMutation({
            shareId: shareId as Id<"noteShares">,
            collecting,
          }),
        collecting
          ? "This link now takes answers. Anyone holding it can fill in the form without an account."
          : "This link no longer takes answers. It still opens the note.",
      ),
    [runShare, setShareCollectingMutation],
  );

  const revokeShare = useCallback(
    (shareId: string) => {
      void runShare(
        () => revokeShareMutation({ shareId: shareId as Id<"noteShares"> }),
        "Access revoked. That link no longer works.",
      );
    },
    [revokeShareMutation, runShare],
  );

  /**
   * Move one entry between the three positions of the visibility control.
   *
   * The steps come from `scope.ts` rather than being branched on here, so the
   * order — which matters, see `stepsTo` — is testable without a server, and
   * so the console and its tests cannot disagree about what a press does.
   *
   * **The steps run in sequence and stop at the first failure.** Not for
   * tidiness: closing a note is revoke-then-narrow, and carrying on after a
   * failed revoke would leave a note the owner believes is private with a live
   * public link on it. Each step reports through the path it already had —
   * `run` for the manifest, `runShare` for the link — so a refusal arrives in
   * the notice line in the server's own words.
   */
  /**
   * Point one note or folder at a group or a person.
   *
   * Its own verb rather than a third value on `setVisibility`, which takes the
   * two tiers and stays that way — see `SettableVisibility`. The server proves
   * the name belongs to this context before anything is written, so a group
   * from somebody else's workspace, or a handle belonging to nobody here, is
   * refused rather than landing in the customer's manifest as a rule nobody
   * can account for.
   *
   * **The branch on `kind` is the repair.** This called the note action for
   * everything, and the note action runs `fileOps.setVisibility`, which refuses
   * a path that is not `.md` — so a folder came back "Only markdown notes can
   * have their own visibility. Set the folder's default instead", which is
   * advice that cannot be followed, because that control takes the two tiers.
   * The two actions differ in the audit row as well as the writer: a folder's
   * named audience is `visibility.folder.named`, which is owner-only, because
   * the name of a group is not something every member may read off the trail.
   */
  const shareWithGroup = useCallback(
    (path: string, kind: "file" | "folder", group: string) => {
      void run(async () => {
        if (kind === "folder") {
          await setFolderGroupAction({ workspaceId: workspaceId!, path, group });
          // A folder's default cascades, so every open listing under it is
          // stale — the same reason `setVisibility` cascades for a folder.
          return { touched: [path], cascadeFrom: path };
        }
        await setNoteGroupAction({ workspaceId: workspaceId!, path, group });
        return { touched: [path] };
      });
    },
    [run, setFolderGroupAction, setNoteGroupAction, workspaceId],
  );

  /**
   * The presses on this control, one at a time and newest-wins.
   *
   * Created once and never replaced, so every press for a path lands in the
   * same queue whichever surface made it — the toolbar, the Browse pane, the
   * Explorer's cycle and the privacy panel all reach `setScope`. The argument
   * for it, and the failure it is for, are in `pressQueue.ts`.
   */
  const scopePresses = useRef(createPressQueue<NoteScope>());

  const setScope = useCallback(
    (path: string, kind: "file" | "folder", from: NoteScope, to: NoteScope) => {
      void scopePresses.current.run(path, async ({ live, carried }) => {
        /*
          The one guard for every surface that drives this control.

          `scopeOf` maps a group rule to the `private` POSITION — correct, since
          a group is not team — and the three-way control then offers the step
          out of it as an ordinary "share with your team". Pressing it wrote
          `team`, which deletes the group rule: a note two colleagues could read
          published to the whole workspace, from a control drawing a padlock,
          with nothing anywhere naming what was being given away.

          `folderControl` was taught to withhold its toggle for the same reason,
          and that fix reached one surface while the toolbar, the Browse pane
          and the Explorer's cycle kept theirs. So the guard lives HERE, at the
          single point all of them go through, rather than three times.

          Absent-not-disabled is the console's rule for a control somebody may
          not use; this one is reachable, so it refuses in words instead of
          doing nothing — the position it starts from is a lie the caller
          cannot see, and silence would leave them pressing it again.
        */
        const current = findEntry(listingsRef.current, path)?.visibility;
        if (current !== undefined && isGroupVisibility(current)) {
          setNotice(
            `${path} is shared with ${current}, which this control cannot change. ` +
              "Use the group settings for this context.",
          );
          return undefined;
        }
        /*
          **Where this press starts from, decided here rather than at the press.**

          `from` is what the screen was showing when somebody clicked, and
          during a burst the screen is showing a position an earlier press is
          in the middle of changing. Computing the steps from it is how two
          presses end up between them doing something neither asked for.

          `carried` first: the press before this one in the same burst knows
          where it left things, and its writes have landed while the
          subscription that would tell the screen has not necessarily ticked.
          Past the end of a burst there is no carried value and the live state
          is the better answer — see `pressQueue.ts`.

          `from` is still the argument's job at the very start of a burst,
          where the live state and the screen agree by construction and the
          caller has already resolved a group rule into a position.
        */
        const liveScope =
          current === undefined
            ? undefined
            : scopeOf(
                current,
                (sharesRef.current ?? []).some(
                  (share) => share.audience === "anyone" && share.entryPath === path,
                ),
              );
        const start = carried ?? liveScope ?? from;
        let reached = start;
        for (const step of stepsTo(start, to)) {
          // Somebody has pressed again. Stop rather than write for a position
          // nobody is asking for any more; the newer press computes from here.
          if (!live()) return reached;
          if (step.kind === "visibility") {
            if (!(await setVisibility(path, kind, step.to))) return reached;
            reached = step.to === "team" ? "team" : "private";
            continue;
          }
          if (step.on) {
            const ok = await runShare(
              () =>
                createLinkShareAction({
                  workspaceId: workspaceId!,
                  path,
                  // A folder link reaches the folder's whole subtree, filtered
                  // through the live privacy engine on every read. The server
                  // refuses a folder argument over a note and the reverse, so
                  // this is the console saying what it is looking at rather
                  // than the thing that decides.
                  kind: kind === "folder" ? "folder" : "note",
                }),
              // Says the reach, not just the fact. `SHARE_TRAVERSAL_DEPTH` is
              // 1, so a link carries the notes this one links to as well —
              // `ShareDialog` states that beside the personal-share control
              // because it is the part everybody guesses wrong, and a
              // one-press control that published silently would be the same
              // surprise with nowhere for the sentence to live. Copying the
              // link is in the share dialog rather than here: a copy has to
              // happen inside its own press to reach the clipboard on iOS.
              "Anyone with the link can now open this note and the notes it links to." +
                " Copy it from Share, under “Anyone with the link”.",
            );
            if (!ok) return reached;
            reached = "anyone";
            continue;
          }
          const open = (sharesRef.current ?? []).find(
            (share) => share.audience === "anyone" && share.entryPath === path,
          );
          // Nothing to revoke is not a failure: the row may have gone from
          // under us, and the caller's intent — no open link on this note — is
          // already true. Stopping here would strand the narrowing that
          // follows it.
          if (open === undefined) {
            reached = "team";
            continue;
          }
          const ok = await runShare(
            () => revokeShareMutation({ shareId: open.shareId as Id<"noteShares"> }),
            "That link no longer works.",
          );
          if (!ok) return reached;
          reached = "team";
        }
        return reached;
      });
    },
    [createLinkShareAction, revokeShareMutation, runShare, setVisibility, workspaceId],
  );

  /**
   * Toggling the preview title goes through `createShare`, which supersedes an
   * existing share **in place and keeps its token**. So this changes what a
   * crawler is told without breaking a link the owner has already sent — which
   * a revoke-and-reshare would not, because that deliberately mints a new one.
   */
  const setSharePreviewTitle = useCallback(
    (
      path: string,
      share: { audience: NoteShare["audience"]; recipient: string },
      titleInPreview: boolean,
    ) => {
      if (workspaceId === null) return;
      /**
       * Each kind of share is superseded through the mutation that made it.
       *
       * **This used to be `createShare` for all of them, and for two of the
       * three that could not work.** `recipient` on a `members` or an `anyone`
       * row is a *display string* — "Anyone with access" — and `parseInvitee`
       * rejects it, since it is neither an address nor a valid handle. So Hide
       * name on a team link has been raising a refusal rather than doing
       * anything, and adding a third kind would have added a second instance
       * of the same bug rather than exposing it.
       *
       * All three supersede in place and keep their token, which is the
       * property this control depends on: changing what a crawler is told must
       * not break a link the owner has already sent.
       */
      const change = () => {
        if (share.audience === "members") {
          return createTeamShareMutation({ workspaceId, path, titleInPreview });
        }
        if (share.audience === "anyone") {
          return createLinkShareAction({ workspaceId, path, titleInPreview });
        }
        return createShare({
          workspaceId,
          path,
          recipient: share.recipient,
          titleInPreview,
        });
      };
      void runShare(
        change,
        titleInPreview
          ? "The link will show the note's name."
          : "The link will show nothing about the note.",
      );
    },
    [
      createLinkShareAction,
      createShare,
      createTeamShareMutation,
      runShare,
      workspaceId,
    ],
  );

  /*
    Which rows the lists mark, from the queue this browser holds — the open
    context's, which is the only context any of those lists draws. Memoised on
    the queue itself so a keystroke that does not touch the queue does not hand
    every row a new selector.
  */
  const pending = useMemo(
    () =>
      pendingMarks(offline.outbox.writes, {
        ops: opsOf(offline.outbox),
        localPathOf: (path) => localPathOf(offline.outbox, path),
        creates: new Set(
          offline.outbox.writes.filter((write) => write.baseEtag === null).map((write) => write.path),
        ),
      }),
    [offline.outbox],
  );

  /*
    A drain that sent a new note or an op changed what the bucket lists, and
    the overlay stops drawing each thing the moment it leaves the queue — so the
    folders it touched are read again, or a note created offline blinks out of
    the tree until something else reloads it. Only those folders, and only ones
    the browser holds or that certainly changed.
  */
  const lastDrain = offline.lastDrain;
  useEffect(() => {
    if (lastDrain === null) return;
    const touched = [
      ...lastDrain.sent.filter((sent) => sent.sentBaseEtag === null).map((sent) => sent.path),
      ...lastDrain.ops.done.flatMap((done) => (done.to === undefined ? [done.path] : [done.path, done.to])),
    ];
    if (touched.length === 0) return;
    void refresh(foldersToRefresh(touched, { loaded: Object.keys(listingsRef.current) })).catch(
      reportRefreshFailure,
    );
  }, [lastDrain, refresh, reportRefreshFailure]);

  /**
   * A person's answer to a parked op, from the sync sheet. See `OpRow.answers`.
   * The answers are the queue's; what this adds is the editor following a
   * rename that was taken back, so the open note is not left at a name the
   * note no longer has on this device.
   */
  const answerOp = useCallback(
    (id: string, answer: "override" | "retry" | "discard") => {
      const offline = offlineRef.current;
      const op = opsOf(offline.outbox).find((one) => one.id === id);
      if (op === undefined) return;
      if (answer === "discard") {
        offline.dropOp(id);
        if (op.kind === "move" && op.to !== undefined && selectedPathRef.current === op.to) {
          select(localPathOf({ ...offline.outbox, ops: opsOf(offline.outbox).filter((one) => one.id !== id) }, op.path));
        }
        return;
      }
      if (answer === "override") offline.overrideOp(id);
      else offline.retryOp(id);
      offline.drain();
    },
    [select],
  );

  return useMemo(
    () => ({
      canEdit: options.canEdit,
      submitForm,
      loadImage,
      storeImage,
      readFormResponses,
      voteForm,
      updateFormResponse,
      retractFormResponse,
      readOnlyReason: options.readOnlyReason,
      contextId,
      loading,
      busy,
      listings,
      expanded,
      toggleFolder,
      collapseAll,
      selectedPath,
      opening,
      select,
      navigations,
      deselect,
      search,
      editor,
      setDraft,
      save,
      onExternalWrite,
      onSaved,
      applyPluginNoteWrite,
      flushAutosave,
      discardLocalCopies,
      encryptedElsewhere,
      useTheirs,
      keepMine,
      conflict,
      resolveWith,
      discard,
      sync: {
        reachability: offline.reachability,
        counts: offline.counts,
        ready: offline.ready,
        durable: offline.durable,
        conditionalWrite: options.conditionalWrite,
        stuckPaths: [
          ...offline.outbox.writes
            .filter((write) => write.state !== "pending")
            .map((write) => localPathOf(offline.outbox, write.path)),
          ...opsOf(offline.outbox)
            .filter((op) => op.state !== "pending")
            .map((op) => describeOp(op)),
        ],
        ...(mirrorStatus === undefined ? {} : { mirror: mirrorStatus }),
      },
      pending,
      answerOp,
      notice,
      dismissNotice,
      toasts,
      say,
      dismissToast,
      clipboard,
      copy: (path: string) => setClipboard(put("copy", path)),
      cut: (path: string) => setClipboard(put("cut", path)),
      paste,
      copyTo,
      createNote,
      createDrawing,
      createFolder,
      createUntitled,
      rename,
      move,
      moveDestinations,
      destinationFolders,
      moveToContext,
      contextMoves,
      resumeContextMove,
      dismissContextMove,
      duplicate,
      download,
      archive,
      destroy,
      setVisibility,
      shareWithGroup,
      setScope,
      openLinkPaths,
      linkPaths,
      resetPrivacy,
      updateStorageLayout: options.isOwner === true ? updateStorageLayout : undefined,
      // A control that cannot work is a control that is not drawn. All three
      // have to hold: the manifest is broken, this is the owner, and this
      // console can act.
      // Both derived in `../capabilities`, not here. Inline, each was
      // unreachable by any test — dropping the `isOwner` half of either failed
      // nothing across 1476 checks, and `canSetVisibility` is the capability
      // the console's one real authorization defect was about.
      canResetPrivacy: canResetPrivacy(
        { canEdit: options.canEdit, isOwner: options.isOwner === true },
        listings[""]?.manifestUsable,
      ),
      canSetVisibility: canSetVisibility({
        canEdit: options.canEdit,
        isOwner: options.isOwner === true,
      }),
      canShare: mayShare,
      // A real console always has one. See `canDownload` in `browser.ts` for
      // why this is a capability rather than a permission.
      canDownload: true,
      copyShareLink,
      shares,
      share,
      revokeShare,
      setShareSlug,
      setShareCollecting,
      setSharePreviewTitle,
      ensureListing,
      readRaw,
    }),
    [
      submitForm,
      loadImage,
      storeImage,
      readFormResponses,
      voteForm,
      updateFormResponse,
      retractFormResponse,
      archive,
      busy,
      clipboard,
      contextId,
      copyTo,
      createFolder,
      createNote,
      createDrawing,
      createUntitled,
      destroy,
      discard,
      discardLocalCopies,
      encryptedElsewhere,
      dismissNotice,
      dismissToast,
      download,
      duplicate,
      editor,
      expanded,
      conflict,
      flushAutosave,
      keepMine,
      linkPaths,
      listings,
      loading,
      move,
      moveDestinations,
      destinationFolders,
      moveToContext,
      contextMoves,
      resumeContextMove,
      dismissContextMove,
      notice,
      mirrorStatus,
      offline.counts,
      offline.durable,
      offline.outbox,
      offline.reachability,
      offline.ready,
      pending,
      answerOp,
      options.canEdit,
      options.conditionalWrite,
      options.isOwner,
      options.readOnlyReason,
      paste,
      rename,
      resetPrivacy,
      updateStorageLayout,
      resolveWith,
      save,
      applyPluginNoteWrite,
      search,
      select,
      navigations,
      deselect,
      selectedPath,
      opening,
      setDraft,
      setVisibility,
      shareWithGroup,
      setScope,
      openLinkPaths,
      share,
      revokeShare,
      setShareSlug,
      setShareCollecting,
      toasts,
      setSharePreviewTitle,
      copyShareLink,
      shares,
      mayShare,
      toggleFolder,
      collapseAll,
      useTheirs,
      ensureListing,
      readRaw,
    ],
  );
}

/** "That folder already has a …" — checked here so it costs no round trip. */
function collision(listings: Listings, folder: string, name: string): string | null {
  return namesIn(listings, folder).has(name)
    ? `${folder === "" ? "The root" : folder} already has something called ${name}.`
    : null;
}

/** Exported for the editor's unsaved-changes guard in the pane. */
export { isDirty };
