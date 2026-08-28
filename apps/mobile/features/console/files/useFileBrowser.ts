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
import { useAction } from "convex/react";
import { ConvexError } from "convex/values";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import type { FileBrowser } from "./browser";
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
  describeMoveProblem,
  describeNameProblem,
  ensureMarkdown,
  joinPath,
  parentPath,
} from "./paths";
import { raceTimeout } from "../storage/timeout";
import { findEntry, foldersToRefresh, namesIn } from "./tree";
import type { FileError, FolderListing, OpenNote, Visibility } from "./types";

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

type Listings = Record<string, FolderListing | undefined>;

/**
 * A `ConvexError`'s payload, or a fixed sentence.
 *
 * Never the raw error text: an unknown failure's message is whatever the
 * runtime produced, and putting that in front of somebody is how a stack trace
 * ends up in a screenshot.
 */
function toFileError(error: unknown): FileError {
  if (error instanceof ConvexError) {
    const data = error.data as Partial<FileError> | undefined;
    if (typeof data?.message === "string") {
      return {
        code: typeof data.code === "string" ? data.code : "UNKNOWN",
        message: data.message,
        currentEtag: typeof data.currentEtag === "string" ? data.currentEtag : undefined,
      };
    }
  }
  return { code: "UNKNOWN", message: "That did not work. Try again." };
}

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
}): FileBrowser {
  const workspaceId = options.workspaceId as Id<"workspaces"> | null;

  const listFiles = useAction(api.functions.files.listFiles);
  const readNote = useAction(api.functions.files.readNote);
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
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  // The reducer's state, readable from callbacks without making every callback
  // depend on it — `guardLeaving` has to see the *current* draft, not the one
  // captured when the row was rendered.
  const editorRef = useRef(editor);
  editorRef.current = editor;

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

  const refresh = useCallback(
    async (folders: readonly string[]) => {
      if (workspaceId === null) return;
      const pages = await Promise.all(
        folders.map(async (folder) => {
          try {
            return [folder, await listFiles({ workspaceId, path: folder })] as const;
          } catch (error) {
            const failure = toFileError(error);
            // A folder that has become invisible (its visibility changed, or
            // it was moved) is not an error worth shouting about — it is a
            // listing that should stop existing.
            if (failure.code === "FILE_NOT_FOUND") return [folder, null] as const;
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
    listFiles({ workspaceId, path: "" })
      .then((page) => {
        if (!cancelled) setListings({ "": page });
      })
      .catch((error: unknown) => {
        if (!cancelled) setNotice(toFileError(error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
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

  const select = useCallback(
    (path: string) => {
      const guard = guardLeaving(editorRef.current);
      if (!guard.allowed) {
        setNotice(guard.prompt ?? null);
        return;
      }
      setSelectedPath(path);
      setNotice(null);

      // A folder has no body. Reading one would come back `FILE_NOT_FOUND`,
      // and the console would tell somebody their own folder does not exist
      // every time they opened it.
      if (findEntry(listings, path)?.kind === "folder") {
        dispatch({ type: "closed" });
        return;
      }
      if (workspaceId === null) return;
      readNote({ workspaceId, path })
        .then((note: OpenNote) => dispatch({ type: "opened", note }))
        .catch((error: unknown) => {
          dispatch({ type: "closed" });
          setNotice(toFileError(error).message);
        });
    },
    [listings, readNote, workspaceId],
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
   */
  const run = useCallback(
    async (
      work: () => Promise<{ touched: string[]; cascadeFrom?: string; message?: string }>,
    ): Promise<boolean> => {
      if (!options.canEdit || workspaceId === null) return false;
      operationRun.current += 1;
      const mine = operationRun.current;
      setBusy(true);
      setNotice(null);

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
        await refresh(
          foldersToRefresh(result.touched, {
            cascadeFrom: result.cascadeFrom,
            loaded: Object.keys(listings),
          }),
        );
      } catch {
        listingReloaded = false;
      }

      if (operationRun.current !== mine) return true;
      setBusy(false);
      if (!listingReloaded) setNotice(STALE_LISTING_MESSAGE);
      else if (result.message !== undefined) setNotice(result.message);
      return true;
    },
    [listings, options.canEdit, refresh, workspaceId],
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
    if (workspaceId === null || current.path === null || current.readOnly) return;

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
      path: current.path,
      text: current.draft,
      expectedEtag: current.etag ?? undefined,
    })
      .then((result) => {
        if (saveRun.current !== mine) return;
        settle();
        dispatch({
          type: "saveSucceeded",
          etag: result.etag,
          conflictCheck: result.conflictCheck,
        });
        void refresh([parentPath(current.path!)]);
      })
      .catch((error: unknown) => {
        if (saveRun.current !== mine) return;
        settle();
        dispatch({ type: "saveFailed", error: toFileError(error) });
      });
  }, [refresh, workspaceId, writeNote]);

  const useTheirs = useCallback(() => {
    const current = editorRef.current;
    if (workspaceId === null || current.path === null) return;
    readNote({ workspaceId, path: current.path })
      .then((note: OpenNote) => dispatch({ type: "reloaded", note }))
      .catch((error: unknown) => setNotice(toFileError(error).message));
  }, [readNote, workspaceId]);

  const keepMine = useCallback(() => dispatch({ type: "conflictOverridden" }), []);
  const discard = useCallback(() => dispatch({ type: "discarded" }), []);
  const setDraft = useCallback((text: string) => dispatch({ type: "edited", text }), []);
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
      void run(async () => {
        await moveEntry({ workspaceId: workspaceId!, from: path, to });
        return { touched: [path, to] };
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
      void run(async () => {
        await moveEntry({ workspaceId: workspaceId!, from: path, to });
        return { touched: [path, to] };
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
          message: `Archived to ${result.to}. Move it back to restore it.`,
        };
      });
      if (selectedPath === path) {
        setSelectedPath(null);
        dispatch({ type: "closed" });
      }
    },
    [archiveEntry, run, selectedPath, workspaceId],
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
          ? "It has no folder rules yet, because the bucket has no folders at its root."
          : `It declares ${result.folders.length} folder${result.folders.length === 1 ? "" : "s"}, every one of them private.`;
      const kept =
        result.backedUpTo === null
          ? ""
          : ` The file that could not be read was kept at ${result.backedUpTo}.`;
      return {
        touched: [result.path],
        message: `privacy.md has been rewritten. ${declared}${kept} Share a folder when you are ready by changing its visibility.`,
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
      editor,
      setDraft,
      save,
      useTheirs,
      keepMine,
      discard,
      notice,
      dismissNotice,
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
      canResetPrivacy:
        options.canEdit &&
        options.isOwner === true &&
        listings[""]?.manifestUsable === false,
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
      duplicate,
      editor,
      expanded,
      keepMine,
      listings,
      loading,
      move,
      notice,
      options.canEdit,
      options.isOwner,
      options.readOnlyReason,
      paste,
      rename,
      resetPrivacy,
      save,
      select,
      selectedPath,
      setDraft,
      setVisibility,
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
