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

import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ConvexError } from "convex/values";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { toFileError, type FileBrowser } from "./browser";
import type { NoteShare } from "./shares";
import type { ToastSpec } from "../../design/components/Toast";
import { consoleOrigin } from "./shareOrigin";
import { noteHref } from "../nav";
import { afterPaste, planPaste, put, type Clipboard } from "./clipboard";
import {
  SAVE_TIMEOUT_MS,
  editorReducer,
  emptyEditor,
  guardLeaving,
  isDirty,
} from "./editor";
import {
  ancestorsOf,
  baseName,
  describeMoveProblem,
  describeNameProblem,
  ensureMarkdown,
  joinPath,
  parentPath,
  isMarkdown,
} from "./paths";
import { raceTimeout } from "../storage/timeout";
import { useOfflineNotes } from "../../offline/useOfflineNotes";
import { restoreFor } from "../../offline/restore";
import { classifyWriteFailure, type WriteOutcome } from "../../offline/sync";
import type { PendingWrite } from "../../offline/outbox";
import { NOT_CACHED, cachedNotice } from "../../offline/copy";
import { KEEP_MINE_OFFLINE } from "../../offline/resolution";
import { useConflictReview } from "./useConflictReview";
import { findEntry, foldersToRefresh, namesIn } from "./tree";
import type { FolderListing, OpenNote, Visibility } from "./types";
import { canResetPrivacy, canSetVisibility, canShare } from "../capabilities";

/** The literal the backend requires before it will delete anything. */
const DELETE_CONFIRMATION = "permanently delete";

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
const STALE_LISTING_MESSAGE =
  "That worked, but the file list did not reload. What you see may be out of date.";

/**
 * A folder, as it should read in the middle of a sentence.
 *
 * The root is `""`, and "Moved to ." is not a sentence. Every other place that
 * has to name the root spells it out too — the move picker's `detail`, the new
 * note dialog's description — so this says the same thing they do.
 */
function folderLabel(folder: string): string {
  return folder === "" ? "the root of your context" : folder;
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
   * The context's slug, for the readable team link (`/console/@slug?note=…`).
   *
   * Absent means no team link can be built, and `teamShareLink` answers `null`
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
}): FileBrowser {
  const workspaceId = options.workspaceId as Id<"workspaces"> | null;
  const slug = options.slug ?? null;

  const listFiles = useAction(api.functions.files.listFiles);
  const readNote = useAction(api.functions.files.readNote);
  const searchContext = useAction(api.functions.files.searchContext);
  const writeNote = useAction(api.functions.files.writeNote);
  const createDirectory = useAction(api.functions.files.createDirectory);
  const moveEntry = useAction(api.functions.files.moveEntry);
  const copyEntry = useAction(api.functions.files.copyEntry);
  const duplicateEntry = useAction(api.functions.files.duplicateEntry);
  const archiveEntry = useAction(api.functions.files.archiveEntry);
  const deleteEntry = useAction(api.functions.files.deleteEntry);
  const setNoteVisibility = useAction(api.functions.files.setNoteVisibility);
  const setDirectoryVisibility = useAction(api.functions.files.setDirectoryVisibility);
  const resetPrivacyAction = useAction(api.functions.files.resetPrivacy);

  const [listings, setListings] = useState<Listings>({});
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
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
   * The generation counter and timer handle for the save in flight.
   *
   * The same shape `createReverifyController` uses, and for the same reason: a
   * response that arrives after its own attempt was abandoned must not be able
   * to settle anything. Here the counter is bumped both when a new save starts
   * *and* when one times out, so a write that lands after we stopped waiting is
   * discarded rather than being allowed to mark the editor clean against a
   * draft the person has since typed more into.
   */
  const saveRun = useRef(0);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  /**
   * The generation of the toolbar operation in flight.
   *
   * Same job as `saveRun`: an operation that answers after its own attempt was
   * abandoned must not be able to touch `busy` or `notice`, because by then
   * those belong to whatever the person did next.
   */
  const operationRun = useRef(0);

  useEffect(
    () => () => {
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
    },
    [],
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
   */
  const sendQueued = useCallback(
    async (pending: PendingWrite): Promise<WriteOutcome> => {
      if (workspaceId === null) return { kind: "failed", message: "No context is open." };
      try {
        const result = await writeNote({
          workspaceId,
          path: pending.path,
          text: pending.text,
          expectedEtag: pending.baseEtag ?? undefined,
        });
        return { kind: "written", etag: result.etag, conflictCheck: result.conflictCheck };
      } catch (error) {
        return classifyWriteFailure(toFileError(error));
      }
    },
    [workspaceId, writeNote],
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
    if (current.path !== result.path) return;
    dispatch({ type: "queueSettled", etag: result.etag });
  }, []);

  const offline = useOfflineNotes({ workspaceId, write: sendQueued, onWritten: onDrained });

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
      return readNote({ workspaceId, path });
    },
    [readNote, workspaceId],
  );

  const conflict = useConflictReview({
    editor,
    fetchNote,
    cachedNote: offline.cachedNote,
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
    async (folders: readonly string[]): Promise<{ servedFromCache: boolean }> => {
      if (workspaceId === null) return { servedFromCache: false };
      const offline = offlineRef.current;
      let servedFromCache = false;
      const pages = await Promise.all(
        folders.map(async (folder) => {
          if (offline.reachability === "offline") {
            // Deliberately not "call it and see". `listFiles` is a Convex
            // action and `ConvexReactClient.action()` has no client-side
            // timeout, so with no connection the promise never settles at all
            // — the tree would sit empty forever rather than showing what is
            // on the device.
            const cached = await offline.cachedListing(folder);
            servedFromCache = true;
            return [folder, cached?.value ?? null] as const;
          }
          try {
            const page = await listFiles({ workspaceId, path: folder });
            offline.rememberListing(page);
            return [folder, page] as const;
          } catch (error) {
            const failure = toFileError(error);
            // A folder that has become invisible (its visibility changed, or
            // it was moved) is not an error worth shouting about — it is a
            // listing that should stop existing.
            if (failure.code === "FILE_NOT_FOUND") return [folder, null] as const;
            const cached = await offline.cachedListing(folder);
            if (cached !== null) {
              servedFromCache = true;
              return [folder, cached.value] as const;
            }
            throw error;
          }
        }),
      );
      setListings((current) => {
        const next = { ...current };
        for (const [folder, page] of pages) {
          if (page === null) delete next[folder];
          else next[folder] = page;
        }
        return next;
      });
      return { servedFromCache };
    },
    [listFiles, workspaceId],
  );

  /** Load the root whenever the context changes, and forget the old one. */
  useEffect(() => {
    setListings({});
    setExpanded(new Set());
    setSelectedPath(null);
    setClipboard(null);
    setNotice(null);
    dispatch({ type: "closed" });
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
          setListings({ "": cached.value });
          return;
        }
        const page = await listFiles({ workspaceId, path: "" });
        if (cancelled) return;
        offline.rememberListing(page);
        setListings({ "": page });
      } catch (error: unknown) {
        if (cancelled) return;
        const cached = await offline.cachedListing("");
        if (cancelled) return;
        if (cached !== null) {
          setListings({ "": cached.value });
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
  }, [listFiles, workspaceId]);

  const toggleFolder = useCallback(
    (path: string) => {
      setExpanded((current) => {
        const next = new Set(current);
        if (next.has(path)) next.delete(path);
        else next.add(path);
        return next;
      });
      if (listings[path] === undefined) void refresh([path]);
    },
    [listings, refresh],
  );

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
   *  - **A failed read falls back to the cache.** The signal can say online and
   *    be wrong — a captive portal, a dead uplink — and a copy is better than a
   *    refusal, as long as it says it is a copy.
   *  - **Waiting work is restored.** A queued write, or a draft typed and never
   *    saved. `restoreFor` decides which, and turns a draft whose base etag has
   *    moved on into a conflict rather than into an armed overwrite.
   */
  const openNote = useCallback(
    async (path: string): Promise<void> => {
      if (workspaceId === null) return;
      const offline = offlineRef.current;

      let note: OpenNote | null = null;
      let fromCache = false;
      let notice: string | undefined;

      if (offline.reachability === "offline") {
        const cached = await offline.cachedNote(path);
        if (cached !== null) {
          note = cached.value;
          fromCache = true;
          notice = cachedNotice({ cachedAt: cached.cachedAt, now: Date.now() });
        }
      } else {
        try {
          note = await readNote({ workspaceId, path });
          offline.rememberNote(note);
        } catch (error) {
          const cached = await offline.cachedNote(path);
          if (cached === null) {
            dispatch({ type: "closed" });
            setNotice(toFileError(error).message);
            return;
          }
          note = cached.value;
          fromCache = true;
          notice = cachedNotice({ cachedAt: cached.cachedAt, now: Date.now() });
        }
      }

      if (note === null) {
        dispatch({ type: "closed" });
        setNotice(NOT_CACHED);
        return;
      }

      const restored = restoreFor({
        note,
        pending: offline.pendingFor(path),
        draft: await offline.savedDraft(path),
      });
      dispatch({ type: "opened", note, fromCache, notice, restored });
    },
    [readNote, workspaceId],
  );

  const select = useCallback(
    (path: string): boolean => {
      const guard = guardLeaving(editorRef.current);
      if (!guard.allowed) {
        setNotice(guard.prompt ?? null);
        return false;
      }
      setSelectedPath(path);
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
        if (listings[path] === undefined) void refresh([path]);
        return true;
      }
      if (workspaceId === null) return true;
      void openNote(path);
      // The selection moved; whether the *read* lands is a separate question
      // this answer is not about. A caller only needs to know the guard let go.
      return true;
    },
    [listings, openNote, refresh, workspaceId],
  );

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
    ): Promise<boolean> => {
      if (!options.canEdit || workspaceId === null) return false;
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

      // Superseded: something newer owns the toolbar now. Leave it alone.
      if (operationRun.current !== mine) return false;

      if (settled.kind === "timeout") {
        setBusy(false);
        setNotice(TIMED_OUT_MESSAGE);
        return false;
      }
      if (settled.kind === "failed") {
        setBusy(false);
        setNotice(toFileError(settled.error).message);
        return false;
      }

      // From here the mutation has already happened. Nothing below may report
      // it as a failure.
      const result = settled.value;
      let listingReloaded = true;
      try {
        const reloaded = await refresh(
          foldersToRefresh(result.touched, {
            cascadeFrom: result.cascadeFrom,
            loaded: Object.keys(listings),
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
    [listings, options.canEdit, refresh, workspaceId],
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
      if (offline.reachability === "offline") {
        offline.queueSave({ path, text, baseEtag: expectedEtag });
        offline.forgetDraft(path);
        dispatch({
          type: "saveQueued",
          message: offline.durable
            ? "No connection, so this is written down on this device and will be sent when you are back."
            : "No connection, so this is held for this session and will be sent when you are back. Closing the app loses it.",
        });
        return;
      }

      saveRun.current += 1;
      const mine = saveRun.current;
      if (saveTimer.current !== null) clearTimeout(saveTimer.current);
      dispatch({ type: "saveStarted" });

      saveTimer.current = setTimeout(() => {
        saveTimer.current = null;
        if (saveRun.current !== mine) return;
        // Bump past `mine` so the write, if it ever lands, cannot come back and
        // settle an attempt the editor has already given up on.
        saveRun.current += 1;
        dispatch({ type: "saveTimedOut" });
      }, SAVE_TIMEOUT_MS);

      const settle = () => {
        if (saveTimer.current !== null) {
          clearTimeout(saveTimer.current);
          saveTimer.current = null;
        }
      };

      writeNote({
        workspaceId,
        path,
        text,
        expectedEtag: expectedEtag ?? undefined,
      })
        .then((result) => {
          if (saveRun.current !== mine) return;
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
          /*
            And the queue entry goes with it, if there was one.

            There is one whenever this save is answering something the queue was
            already holding — a refusal being retried, or a conflict somebody
            has just decided. Leaving it behind would send the drain back at the
            bucket with the *stale* base etag it was parked on, which raises the
            same conflict again about a decision that has already been made.
          */
          offlineRef.current.dropQueued(path);
          dispatch({
            type: "saveSucceeded",
            etag: result.etag,
            conflictCheck: result.conflictCheck,
          });
          void refresh([parentPath(path)]);
        })
        .catch((error: unknown) => {
          if (saveRun.current !== mine) return;
          settle();
          dispatch({ type: "saveFailed", error: toFileError(error) });
        });
    },
    [refresh, workspaceId, writeNote],
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
      const path = current.path;
      const offline = offlineRef.current;
      const etag = conflictRef.current?.theirsEtag ?? current.conflictEtag ?? current.etag;

      if (offline.reachability === "offline") {
        /*
          Nothing can be read or written now, so this is a decision about what
          the queue holds rather than a write. `queueSave` takes the newer text
          (and cannot advance the base etag, by design), and `keepQueued`
          re-bases onto the version the conflict reported and puts it back in
          the queue — so what eventually drains is still a conditional write
          against a version this person was shown.
        */
        offline.queueSave({ path, text, baseEtag: etag });
        offline.keepQueued(path);
        dispatch({ type: "edited", text });
        dispatch({ type: "saveQueued", message: KEEP_MINE_OFFLINE });
        return;
      }

      // The draft becomes what they approved *before* the write, so a refusal
      // leaves the reviewed text in the editor rather than the text it replaced.
      dispatch({ type: "edited", text });
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
    offline.dropQueued(path);
    offline.forgetDraft(path);
    readNote({ workspaceId, path })
      .then((note: OpenNote) => {
        offlineRef.current.rememberNote(note);
        dispatch({ type: "reloaded", note });
      })
      .catch((error: unknown) => setNotice(toFileError(error).message));
  }, [readNote, workspaceId]);

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
  }, []);

  const discard = useCallback(() => {
    const path = editorRef.current.path;
    if (path !== null) {
      offlineRef.current.dropQueued(path);
      offlineRef.current.forgetDraft(path);
    }
    dispatch({ type: "discarded" });
  }, []);

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
  const setDraft = useCallback((text: string) => {
    const current = editorRef.current;
    dispatch({ type: "edited", text });
    if (current.path === null || current.readOnly) return;
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
  }, []);

  const dismissNotice = useCallback(() => setNotice(null), []);

  const createNote = useCallback(
    (folder: string, rawName: string) => {
      const name = ensureMarkdown(rawName);
      const problem = describeNameProblem(name) ?? collision(listings, folder, name);
      if (problem !== null) return setNotice(problem);
      const path = joinPath(folder, name);
      void run(async () => {
        await writeNote({ workspaceId: workspaceId!, path, text: `# ${name.replace(/\.md$/i, "")}\n\n` });
        return { touched: [path] };
      }).then((ok) => {
        if (ok) select(path);
      });
    },
    [listings, run, select, workspaceId, writeNote],
  );

  const createFolder = useCallback(
    (folder: string, name: string) => {
      const problem = describeNameProblem(name) ?? collision(listings, folder, name);
      if (problem !== null) return setNotice(problem);
      const path = joinPath(folder, name);
      void run(async () => {
        await createDirectory({ workspaceId: workspaceId!, path });
        return { touched: [path, joinPath(path, "README.md")] };
      });
      setExpanded((current) => new Set([...current, path]));
    },
    [createDirectory, listings, run, workspaceId],
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
      void run(async () => {
        await moveEntry({ workspaceId: workspaceId!, from: path, to });
        return {
          touched: [path, to],
          message: `Moved to ${folderLabel(destinationFolder)}.`,
          // `moveEntry` is its own inverse — the same action with the ends
          // swapped — so this is the real operation and not a re-derivation of
          // it. It goes through `run` for the same reason the move did: a
          // failure has to reach the notice line, and the tree has to reload.
          undo: () => {
            void run(async () => {
              await moveEntry({ workspaceId: workspaceId!, from: to, to: path });
              return { touched: [to, path], message: `Moved back to ${folderLabel(from)}.` };
            });
          },
        };
      });
      if (selectedPath === path) {
        setSelectedPath(null);
        dispatch({ type: "closed" });
      }
    },
    [listings, moveEntry, run, selectedPath, workspaceId],
  );

  const rename = useCallback(
    (path: string, rawName: string) => {
      const folder = parentPath(path);
      const name = path.toLowerCase().endsWith(".md") ? ensureMarkdown(rawName) : rawName.trim();
      const problem = describeNameProblem(name) ?? collision(listings, folder, name);
      if (problem !== null) return setNotice(problem);
      const to = joinPath(folder, name);
      const was = baseName(path);
      void run(async () => {
        await moveEntry({ workspaceId: workspaceId!, from: path, to });
        return {
          touched: [path, to],
          message: `Renamed to ${name}.`,
          undo: () => {
            void run(async () => {
              await moveEntry({ workspaceId: workspaceId!, from: to, to: path });
              return { touched: [to, path], message: `Renamed back to ${was}.` };
            }).then((ok) => {
              // The editor follows the file, in both directions. Without this
              // an undone rename left the open tab pointing at a path the
              // bucket no longer has.
              if (ok && selectedPathRef.current === to) select(path);
            });
          },
        };
      }).then((ok) => {
        if (ok && selectedPath === path) select(to);
      });
    },
    [listings, moveEntry, run, select, selectedPath, workspaceId],
  );

  const duplicate = useCallback(
    (path: string) => {
      void run(async () => {
        const result = await duplicateEntry({ workspaceId: workspaceId!, path });
        return { touched: [path, result.to] };
      });
    },
    [duplicateEntry, run, workspaceId],
  );

  const archive = useCallback(
    (path: string) => {
      void run(async () => {
        const result = await archiveEntry({ workspaceId: workspaceId!, path });
        return {
          touched: [path, result.to],
          message: `Archived ${baseName(path)}.`,
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
    [archiveEntry, moveEntry, run, selectedPath, workspaceId],
  );

  const destroy = useCallback(
    (path: string) => {
      void run(async () => {
        await deleteEntry({
          workspaceId: workspaceId!,
          path,
          confirmation: DELETE_CONFIRMATION,
        });
        return { touched: [path], message: `Deleted ${path}. That cannot be undone.` };
      });
      if (selectedPath === path) {
        setSelectedPath(null);
        dispatch({ type: "closed" });
      }
    },
    [deleteEntry, run, selectedPath, workspaceId],
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

  const setVisibility = useCallback(
    (path: string, kind: "file" | "folder", visibility: Visibility) => {
      void run(async () => {
        if (kind === "folder") {
          await setDirectoryVisibility({ workspaceId: workspaceId!, path, visibility });
          return { touched: [path], cascadeFrom: path };
        }
        await setNoteVisibility({ workspaceId: workspaceId!, path, visibility });
        return { touched: [path] };
      });
    },
    [run, setDirectoryVisibility, setNoteVisibility, workspaceId],
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

  // Keep the tree open down to whatever is selected, so a path opened from a
  // link or restored after a move does not appear in a collapsed tree.
  useEffect(() => {
    if (selectedPath === null) return;
    const missing = ancestorsOf(selectedPath).filter((folder) => !expanded.has(folder));
    if (missing.length === 0) return;
    setExpanded((current) => new Set([...current, ...missing]));
    void refresh(missing.filter((folder) => listings[folder] === undefined));
  }, [expanded, listings, refresh, selectedPath]);

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
    async (work: () => Promise<unknown>, done: string | null) => {
      if (!mayShare || workspaceId === null) return;
      try {
        await work();
        if (done !== null) setNotice(done);
      } catch (error) {
        setNotice(toFileError(error).message);
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

  const teamShareLink = useCallback(
    async (path: string): Promise<string | null> => {
      if (!mayShare || workspaceId === null) return null;
      try {
        await createTeamShareMutation({ workspaceId, path });
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
        return slug === null ? null : `${consoleOrigin()}${noteHref(slug, path)}`;
      } catch (error) {
        setNotice(toFileError(error).message);
        return null;
      }
    },
    [createTeamShareMutation, mayShare, slug, workspaceId],
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
   * Toggling the preview title goes through `createShare`, which supersedes an
   * existing share **in place and keeps its token**. So this changes what a
   * crawler is told without breaking a link the owner has already sent — which
   * a revoke-and-reshare would not, because that deliberately mints a new one.
   */
  const setSharePreviewTitle = useCallback(
    (path: string, recipient: string, titleInPreview: boolean) => {
      if (workspaceId === null) return;
      void runShare(
        () => createShare({ workspaceId, path, recipient, titleInPreview }),
        titleInPreview
          ? "The link will show the note's name."
          : "The link will show nothing about the note.",
      );
    },
    [createShare, runShare, workspaceId],
  );

  return useMemo(
    () => ({
      canEdit: options.canEdit,
      readOnlyReason: options.readOnlyReason,
      loading,
      busy,
      listings,
      expanded,
      toggleFolder,
      selectedPath,
      select,
      search,
      editor,
      setDraft,
      save,
      useTheirs,
      keepMine,
      conflict,
      resolveWith,
      discard,
      sync: {
        reachability: offline.reachability,
        counts: offline.counts,
        durable: offline.durable,
        conditionalWrite: options.conditionalWrite,
        stuckPaths: offline.outbox.writes
          .filter((write) => write.state !== "pending")
          .map((write) => write.path),
      },
      notice,
      dismissNotice,
      toasts,
      dismissToast,
      clipboard,
      copy: (path: string) => setClipboard(put("copy", path)),
      cut: (path: string) => setClipboard(put("cut", path)),
      paste,
      copyTo,
      createNote,
      createFolder,
      rename,
      move,
      duplicate,
      archive,
      destroy,
      setVisibility,
      resetPrivacy,
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
      teamShareLink,
      shares,
      share,
      revokeShare,
      setSharePreviewTitle,
    }),
    [
      archive,
      busy,
      clipboard,
      copyTo,
      createFolder,
      createNote,
      destroy,
      discard,
      dismissNotice,
      dismissToast,
      duplicate,
      editor,
      expanded,
      conflict,
      keepMine,
      listings,
      loading,
      move,
      notice,
      offline.counts,
      offline.durable,
      offline.outbox,
      offline.reachability,
      options.canEdit,
      options.conditionalWrite,
      options.isOwner,
      options.readOnlyReason,
      paste,
      rename,
      resetPrivacy,
      resolveWith,
      save,
      search,
      select,
      selectedPath,
      setDraft,
      setVisibility,
      share,
      revokeShare,
      toasts,
      setSharePreviewTitle,
      teamShareLink,
      shares,
      mayShare,
      toggleFolder,
      useTheirs,
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
