import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { FileBrowser } from "../console/files/browser";
import { put, type Clipboard } from "../console/files/clipboard";
import { editorReducer, emptyEditor } from "../console/files/editor";
import { knownNotePaths } from "../console/files/paths";
import { untitledName } from "../console/files/untitled";
import { demoNote, useStaticFileBrowser } from "../console/files/useDemoFileBrowser";
import type { DemoContextTree } from "../console/placeholderData/treeHelpers";
import type { HomeTree } from "./homeSite";
import {
  addFolder,
  addNote,
  copyPath,
  editNote,
  followPath,
  movePath,
  notesUnder,
  removePath,
  renamePath,
} from "./localTree";

/**
 * The homepage's workspace, writable, in this tab only.
 *
 * The homepage is there to show how the app is used, so a visitor gets the
 * console's own editing: type in a page, add notes and folders, rename, move,
 * copy and delete them, through the same Explorer and editor the app draws.
 * Every change lands in `localTree`'s in-memory tree and nowhere else — there
 * is no bucket behind it and nothing here calls one — so a reload is the site
 * again. Sharing, visibility and downloads stay off: each is a claim about a
 * real workspace, and this one is not.
 *
 * Until the visitor changes something the tree follows the site, so an edit
 * the owner makes to `website/` still reaches an open homepage. After the
 * first change it is theirs, and the site no longer rewrites it under them.
 *
 * Which page the address names is the shell's business; this keeps, for each
 * note that came from the site, the page it is (`routeOf`), and moves that
 * with the note when it is renamed or moved.
 */

/** What a change did to the tree's paths, for the shell's tabs and address. */
export interface LocalHomeEvents {
  /** A note now at `to` was at `from`: follow it. */
  onMoved?: (moves: ReadonlyArray<readonly [from: string, to: string]>) => void;
  /** These notes are gone. */
  onRemoved?: (paths: readonly string[]) => void;
}

export interface LocalHome {
  files: FileBrowser;
  notes: Readonly<Record<string, string>>;
  /** The site's page a note is, while it came from the site. */
  routeOf: (path: string) => string | undefined;
  /** The note a page of the site is now, wherever it has been moved to. */
  pathOf: (routePath: string) => string | undefined;
  /** The visitor has changed something; the site no longer replaces the tree. */
  touched: boolean;
}

/** How long typing rests before the editor calls it kept. */
const KEEP_AFTER_MS = 400;

function routesOf(home: HomeTree): Map<string, string> {
  return new Map([...home.paths].map(([route, path]) => [path, route]));
}

export function useLocalFileBrowser(
  home: HomeTree,
  contextId: string,
  routePath: string,
  events: LocalHomeEvents = {},
): LocalHome {
  const inert = useStaticFileBrowser(home.tree, contextId);
  const [tree, setTree] = useState<DemoContextTree>(home.tree);
  const [routes, setRoutes] = useState(() => routesOf(home));
  const [touched, setTouched] = useState(false);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set(home.tree.defaultExpanded));
  const [clipboard, setClipboard] = useState<Clipboard | null>(null);
  const initial = home.paths.get(routePath) ?? null;
  const [selectedPath, setSelectedPath] = useState<string | null>(initial);
  const [editor, dispatch] = useReducer(editorReducer, emptyEditor, () => {
    const note = initial === null ? null : demoNote(home.tree, initial);
    return note === null ? emptyEditor : editorReducer(emptyEditor, { type: "opened", note });
  });

  // Callbacks read these rather than closing over them, so each is made once
  // and a keystroke does not rebuild every handler the Explorer holds.
  const treeRef = useRef(tree);
  treeRef.current = tree;
  const editorRef = useRef(editor);
  editorRef.current = editor;
  const routesRef = useRef(routes);
  routesRef.current = routes;
  const eventsRef = useRef(events);
  eventsRef.current = events;

  const open = useCallback((path: string | null, within: DemoContextTree = treeRef.current) => {
    setSelectedPath(path);
    const note = path === null ? null : demoNote(within, path);
    if (note === null) dispatch({ type: "closed" });
    else dispatch({ type: "opened", note });
  }, []);

  // The site changed and the visitor has not: follow it, keeping what is open.
  const baseRef = useRef(home);
  useEffect(() => {
    if (baseRef.current === home) return;
    baseRef.current = home;
    if (touched) return;
    setTree(home.tree);
    setRoutes(routesOf(home));
    setExpanded((current) => new Set([...current, ...home.tree.defaultExpanded]));
    open(home.paths.get(routePath) ?? null, home.tree);
  }, [home, touched, routePath, open]);

  // The address moved (a link, Back): open the note that page now is.
  const pathOf = useCallback(
    (route: string) => [...routesRef.current].find(([, at]) => at === route)?.[0],
    [],
  );
  const lastRoute = useRef(routePath);
  useEffect(() => {
    if (lastRoute.current === routePath) return;
    lastRoute.current = routePath;
    open(pathOf(routePath) ?? null);
  }, [routePath, open, pathOf]);

  const change = useCallback((next: DemoContextTree) => {
    treeRef.current = next;
    setTree(next);
    setTouched(true);
  }, []);

  /** `from` is now `to` (or gone): routes, selection, editor and tabs follow. */
  const relocate = useCallback(
    (before: DemoContextTree, after: DemoContextTree, from: string, to: string | null) => {
      const moved = notesUnder(before, from);
      setRoutes((current) => {
        const next = new Map<string, string>();
        for (const [path, route] of current) {
          const at = followPath(path, from, to);
          if (at !== null) next.set(at, route);
        }
        return next;
      });
      setExpanded((current) => {
        const next = new Set<string>();
        for (const path of current) {
          const at = followPath(path, from, to);
          if (at !== null) next.add(at);
        }
        return next;
      });
      setClipboard((current) => (current !== null && followPath(current.path, from, to) !== current.path ? null : current));
      const selected = editorRef.current.path;
      if (selected !== null && followPath(selected, from, to) !== selected) {
        open(followPath(selected, from, to), after);
      }
      if (to === null) eventsRef.current.onRemoved?.(moved);
      else eventsRef.current.onMoved?.(moved.map((path) => [path, followPath(path, from, to)!] as const));
    },
    [open],
  );

  const reveal = useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      for (let at = path; at.includes("/"); ) {
        at = at.slice(0, at.lastIndexOf("/"));
        next.add(at);
      }
      return next;
    });
  }, []);

  const createNote = useCallback(
    (folder: string, name: string) => {
      const made = addNote(treeRef.current, folder, name);
      if (made === null) return;
      change(made.tree);
      reveal(made.path);
      open(made.path, made.tree);
    },
    [change, open, reveal],
  );

  const createFolder = useCallback(
    (folder: string, name: string) => {
      const made = addFolder(treeRef.current, folder, name);
      if (made === null) return;
      change(made.tree);
      reveal(`${made.path}/`);
    },
    [change, reveal],
  );

  const reshape = useCallback(
    (from: string, made: { tree: DemoContextTree; path: string } | null) => {
      if (made === null || made.path === from) return;
      const before = treeRef.current;
      change(made.tree);
      relocate(before, made.tree, from, made.path);
      reveal(made.path);
    },
    [change, relocate, reveal],
  );

  const remove = useCallback(
    (paths: readonly string[]) => {
      for (const path of paths) {
        const before = treeRef.current;
        const after = removePath(before, path);
        change(after);
        relocate(before, after, path, null);
      }
    },
    [change, relocate],
  );

  const copyInto = useCallback(
    (from: string, destination: string) => {
      const made = copyPath(treeRef.current, from, destination);
      if (made === null) return;
      change(made.tree);
      reveal(made.path);
    },
    [change, reveal],
  );

  const keepTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const keep = useCallback(() => {
    if (keepTimer.current !== null) clearTimeout(keepTimer.current);
    keepTimer.current = null;
    dispatch({ type: "saveStarted" });
    dispatch({ type: "saveSucceeded", etag: "local", conflictCheck: "conditional" });
  }, []);
  useEffect(() => () => {
    if (keepTimer.current !== null) clearTimeout(keepTimer.current);
  }, []);

  const setDraft = useCallback(
    (text: string) => {
      const path = editorRef.current.path;
      if (path === null) return;
      dispatch({ type: "edited", text });
      change(editNote(treeRef.current, path, text));
      if (keepTimer.current !== null) clearTimeout(keepTimer.current);
      keepTimer.current = setTimeout(keep, KEEP_AFTER_MS);
    },
    [change, keep],
  );

  const discard = useCallback(() => {
    const { path, baseline } = editorRef.current;
    if (keepTimer.current !== null) clearTimeout(keepTimer.current);
    dispatch({ type: "discarded" });
    if (path !== null) change(editNote(treeRef.current, path, baseline));
  }, [change]);

  const toggleFolder = useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const files = useMemo<FileBrowser>(
    () => ({
      ...inert,
      canEdit: true,
      readOnlyReason: undefined,
      listings: tree.listings,
      expanded,
      toggleFolder,
      collapseAll: () => setExpanded(new Set<string>()),
      selectedPath,
      select: (path: string) => {
        open(path);
        return true;
      },
      deselect: () => {
        open(null);
        return true;
      },
      editor,
      setDraft,
      save: keep,
      discard,
      flushAutosave: () => {
        if (keepTimer.current === null) return false;
        keep();
        return true;
      },
      clipboard,
      copy: (path: string) => setClipboard(put("copy", path)),
      cut: (path: string) => setClipboard(put("cut", path)),
      paste: (destination: string) => {
        if (clipboard === null) return;
        if (clipboard.mode === "copy") copyInto(clipboard.path, destination);
        else {
          reshape(clipboard.path, movePath(treeRef.current, clipboard.path, destination));
          setClipboard(null);
        }
      },
      copyTo: copyInto,
      copyManyTo: (paths: readonly string[], destination: string) => {
        for (const path of paths) copyInto(path, destination);
      },
      duplicate: (path: string) => copyInto(path, path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""),
      createNote,
      // A drawing needs the drawing editor's storage, which a page with no
      // bucket has none of; the visitor gets a note to write in instead.
      createDrawing: createNote,
      createFolder,
      createUntitled: (folder: string) =>
        createNote(folder, untitledName(treeRef.current.listings, folder, "note", new Date())),
      rename: (path: string, name: string) => reshape(path, renamePath(treeRef.current, path, name)),
      move: (path: string, destination: string) => reshape(path, movePath(treeRef.current, path, destination)),
      moveMany: (paths: readonly string[], destination: string) => {
        for (const path of paths) reshape(path, movePath(treeRef.current, path, destination));
      },
      // Nothing here is ever put away rather than gone: there is no archive
      // folder to restore from, and a reload brings every page back anyway.
      archive: (path: string) => remove([path]),
      destroy: (path: string) => remove([path]),
      archiveMany: remove,
      destroyMany: remove,
      linkPaths: knownNotePaths(tree.listings),
      readRaw: async (path: string) => {
        const text = treeRef.current.notes[path];
        return text === undefined ? null : { text, etag: "local" };
      },
    }),
    [
      clipboard,
      copyInto,
      createFolder,
      createNote,
      discard,
      editor,
      expanded,
      inert,
      keep,
      open,
      remove,
      reshape,
      selectedPath,
      setDraft,
      toggleFolder,
      tree.listings,
    ],
  );

  const routeOf = useCallback((path: string) => routes.get(path), [routes]);
  return { files, notes: tree.notes, routeOf, pathOf, touched };
}
