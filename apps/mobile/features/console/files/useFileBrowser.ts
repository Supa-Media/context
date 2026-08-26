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
import { editorReducer, emptyEditor, guardLeaving, isDirty } from "./editor";
import {
  ancestorsOf,
  describeMoveProblem,
  describeNameProblem,
  ensureMarkdown,
  joinPath,
  parentPath,
} from "./paths";
import { findEntry, foldersToRefresh, namesIn } from "./tree";
import type { FileError, FolderListing, OpenNote, Visibility } from "./types";

/** The literal the backend requires before it will delete anything. */
const DELETE_CONFIRMATION = "permanently delete";

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
   */
  const run = useCallback(
    async (
      work: () => Promise<{ touched: string[]; cascadeFrom?: string; message?: string }>,
    ): Promise<boolean> => {
      if (!options.canEdit || workspaceId === null) return false;
      setBusy(true);
      setNotice(null);
      try {
        const result = await work();
        await refresh(
          foldersToRefresh(result.touched, {
            cascadeFrom: result.cascadeFrom,
            loaded: Object.keys(listings),
          }),
        );
        if (result.message !== undefined) setNotice(result.message);
        return true;
      } catch (error) {
        setNotice(toFileError(error).message);
        return false;
      } finally {
        setBusy(false);
      }
    },
    [listings, options.canEdit, refresh, workspaceId],
  );

  const save = useCallback(() => {
    const current = editorRef.current;
    if (workspaceId === null || current.path === null || current.readOnly) return;
    dispatch({ type: "saveStarted" });
    writeNote({
      workspaceId,
      path: current.path,
      text: current.draft,
      expectedEtag: current.etag ?? undefined,
    })
      .then((result) => {
        dispatch({
          type: "saveSucceeded",
          etag: result.etag,
          conflictCheck: result.conflictCheck,
        });
        void refresh([parentPath(current.path!)]);
      })
      .catch((error: unknown) => {
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
      createNote,
      createFolder,
      rename,
      move,
      duplicate,
      archive,
      destroy,
      setVisibility,
    }),
    [
      archive,
      busy,
      clipboard,
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
      options.readOnlyReason,
      paste,
      rename,
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
