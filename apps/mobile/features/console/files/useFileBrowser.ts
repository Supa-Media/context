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
import { onBucketWrite } from "./bucketWrites";
import { isServerRefusal, toFileError, type FileBrowser } from "./browser";
import type { FormOutcome, FormSubmission } from "./formBlock";
import type { NoteShare } from "./shares";
import { shareUrl } from "./shares";
import { stepsTo, type NoteScope } from "./scope";
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
  ensureMarkdown,
  joinPath,
  mergeLinkPaths,
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
import { isGroupVisibility } from "./types";
import type { FolderListing, OpenNote, SettableVisibility } from "./types";
import { canResetPrivacy, canSetVisibility, canShare } from "../capabilities";
import type { VisibilityTier } from "../visibility";

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
}): FileBrowser {
  const workspaceId = options.workspaceId as Id<"workspaces"> | null;
  const slug = options.slug ?? null;

  const listFiles = useAction(api.functions.files.listFiles);
  const readNote = useAction(api.functions.files.readNote);
  const searchContext = useAction(api.functions.files.searchContext);
  const notePathsAction = useAction(api.functions.files.notePaths);
  const writeNote = useAction(api.functions.files.writeNote);
  const submitFormAction = useAction(api.functions.forms.submitForm);
  const createDirectory = useAction(api.functions.files.createDirectory);
  const moveEntry = useAction(api.functions.files.moveEntry);
  const copyEntry = useAction(api.functions.files.copyEntry);
  const duplicateEntry = useAction(api.functions.files.duplicateEntry);
  const archiveEntry = useAction(api.functions.files.archiveEntry);
  const trashEntry = useAction(api.functions.files.trashEntry);
  const restoreTrashEntry = useAction(api.functions.files.restoreTrashEntry);
  const setNoteVisibility = useAction(api.functions.files.setNoteVisibility);
  const setNoteGroupAction = useAction(api.functions.files.setNoteGroup);
  const setDirectoryVisibility = useAction(api.functions.files.setDirectoryVisibility);
  const resetPrivacyAction = useAction(api.functions.files.resetPrivacy);
  const updateStorageLayoutAction = useAction(api.functions.files.updateStorageLayout);

  const [listings, setListings] = useState<Listings>({});
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
    if (current.path !== result.path) return;
    dispatch({ type: "queueSettled", etag: result.etag });
  }, []);

  const offline = useOfflineNotes({
    workspaceId,
    tier: options.tier,
    write: sendQueued,
    onWritten: onDrained,
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
            const cached = isServerRefusal(error) ? null : await offline.cachedNote(path);
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
            note = cached.value;
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
          /*
            And the queue entry goes with it, if there was one.

            There is one whenever this save is answering something the queue was
            already holding — a refusal being retried, or a conflict somebody
            has just decided. Leaving it behind would send the drain back at the
            bucket with the *stale* base etag it was parked on, which raises the
            same conflict again about a decision that has already been made.
          */
          offlineRef.current.dropQueued(path);
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
    [autosave, refresh, reportRefreshFailure, workspaceId, writeNote],
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
        const result = await trashEntry({ workspaceId: workspaceId!, path });
        return {
          touched: [path, result.to],
          message: `Moved ${baseName(path)} to trash.`,
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
    [restoreTrashEntry, run, selectedPath, trashEntry, workspaceId],
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
    (path: string, kind: "file" | "folder", visibility: SettableVisibility) => {
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
        return;
      }
      void run(async () => {
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
   * Point one note at a group.
   *
   * Its own verb rather than a third value on `setVisibility`, which takes the
   * two tiers and stays that way — see `SettableVisibility`. The server proves
   * the group belongs to this context before anything is written, so a name
   * from somebody else's workspace is refused here rather than landing in the
   * customer's manifest as a rule nobody can account for.
   */
  const shareWithGroup = useCallback(
    (path: string, group: string) => {
      void run(async () => {
        await setNoteGroupAction({ workspaceId: workspaceId!, path, group });
        return { touched: [path] };
      });
    },
    [run, setNoteGroupAction, workspaceId],
  );

  const setScope = useCallback(
    (path: string, kind: "file" | "folder", from: NoteScope, to: NoteScope) => {
      void (async () => {
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
        const current = findEntry(listings, path)?.visibility;
        if (current !== undefined && isGroupVisibility(current)) {
          setNotice(
            `${path} is shared with ${current}, which this control cannot change. ` +
              "Use the group settings for this context.",
          );
          return;
        }
        for (const step of stepsTo(from, to)) {
          if (step.kind === "visibility") {
            setVisibility(path, kind, step.to);
            continue;
          }
          if (step.on) {
            const ok = await runShare(
              () => createLinkShareAction({ workspaceId: workspaceId!, path }),
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
            if (!ok) return;
            continue;
          }
          const live = (shares ?? []).find(
            (share) => share.audience === "anyone" && share.entryPath === path,
          );
          // Nothing to revoke is not a failure: the row may have gone from
          // under us, and the caller's intent — no open link on this note — is
          // already true. Stopping here would strand the narrowing that
          // follows it.
          if (live === undefined) continue;
          const ok = await runShare(
            () => revokeShareMutation({ shareId: live.shareId as Id<"noteShares"> }),
            "That link no longer works.",
          );
          if (!ok) return;
        }
      })();
    },
    [
      createLinkShareAction,
      listings,
      revokeShareMutation,
      runShare,
      setVisibility,
      shareWithGroup,
      shares,
      workspaceId,
    ],
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

  return useMemo(
    () => ({
      canEdit: options.canEdit,
      submitForm,
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
      deselect,
      search,
      editor,
      setDraft,
      save,
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
      copyShareLink,
      shares,
      share,
      revokeShare,
      setSharePreviewTitle,
      ensureListing,
      readRaw,
    }),
    [
      submitForm,
      archive,
      busy,
      clipboard,
      contextId,
      copyTo,
      createFolder,
      createNote,
      destroy,
      discard,
      discardLocalCopies,
      encryptedElsewhere,
      dismissNotice,
      dismissToast,
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
      notice,
      offline.counts,
      offline.durable,
      offline.outbox,
      offline.reachability,
      offline.ready,
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
      search,
      select,
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
