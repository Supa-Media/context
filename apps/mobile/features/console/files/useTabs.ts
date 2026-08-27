import { useCallback, useEffect, useReducer, useRef } from "react";
import type { FileBrowser } from "./browser";
import { emptyTabs, tabsReducer, type TabsState } from "./tabs";

/**
 * The tab strip, wired to the file browser.
 *
 * `tabs.ts` is the model and has no idea a `FileBrowser` exists; this is the
 * thin layer that keeps the two in step. It is separate from both for the usual
 * reason — the model stays testable in plain node, and the sync rules below are
 * the part that is actually easy to get wrong.
 *
 * ## Selection is the single source of truth, in one direction
 *
 * `files.selectedPath` drives the tabs, never the other way round. Opening a
 * tab calls `files.select`, and the effect below notices the new selection and
 * opens or activates the matching tab. Wiring it both ways — a tab that also
 * sets its own active path — gives you two states that agree until they do not,
 * and the disagreement shows up as a tab strip pointing at one note while the
 * editor holds another.
 *
 * ## Why a *preview* tab is the default
 *
 * Clicking through a tree to find something would otherwise leave a tab behind
 * for every note you glanced at. So a selection opens a preview tab, which the
 * next selection replaces; typing into it pins it (`edited`), which is the
 * clearest possible statement that you meant to keep it. Same as Obsidian and
 * VS Code, and the reason it is worth the extra state.
 *
 * ## What this replaces
 *
 * `editor.ts`'s `guardLeaving` refuses to open another note while a draft is
 * unsaved, because the single editor slot would have thrown the draft away.
 * With tabs there is nowhere for the draft to go — it stays in its own tab — so
 * that refusal is now a prompt in front of a problem that no longer exists.
 * Removing it belongs to the change that is confident the drafts survive; this
 * hook is what makes that true.
 */
export function useTabs(files: FileBrowser): {
  state: TabsState;
  activate: (path: string) => void;
  /** Keep this tab: what "Open in new tab" means when the default is a preview. */
  pin: (path: string) => void;
  close: (path: string) => void;
  closeOthers: (path: string) => void;
  reopen: () => void;
} {
  const [state, dispatch] = useReducer(tabsReducer, emptyTabs);

  /**
   * The path the editor is actually holding.
   *
   * Read from `editor.path` rather than `selectedPath` because selecting a
   * *folder* is a real selection with no note behind it — a folder must not
   * open a tab, and using `selectedPath` here would open one named after it.
   */
  const openPath = files.editor.path;
  const status = files.editor.status;

  useEffect(() => {
    if (openPath === null) return;
    dispatch({ type: "opened", path: openPath, mode: "preview" });
  }, [openPath]);

  // Typing pins the tab; saving clears its dot. Both are derived from the
  // editor's own status, so there is no second definition of "dirty".
  useEffect(() => {
    if (openPath === null) return;
    if (status === "dirty") dispatch({ type: "edited", path: openPath });
    if (status === "saved" || status === "clean") dispatch({ type: "saved", path: openPath });
  }, [openPath, status]);

  /**
   * A note that stopped existing cannot stay open.
   *
   * Renames and deletes both arrive as "the listings changed", so this compares
   * the open tabs against what is actually loaded. It only closes a tab whose
   * folder *is* loaded and does not contain it — an unloaded folder means "we
   * have not looked", not "it is gone", and closing on that would shut every
   * tab whenever a folder collapsed.
   */
  const listings = files.listings;
  const known = useRef<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const present = new Set<string>();
    const loadedFolders = new Set<string>();
    for (const [folder, listing] of Object.entries(listings)) {
      if (listing === undefined) continue;
      loadedFolders.add(folder);
      for (const entry of listing.entries) present.add(entry.path);
    }
    known.current = present;

    for (const tab of state.tabs) {
      const folder = tab.path.includes("/") ? tab.path.slice(0, tab.path.lastIndexOf("/")) : "";
      if (!loadedFolders.has(folder)) continue;
      if (!present.has(tab.path)) dispatch({ type: "removed", path: tab.path });
    }
  }, [listings, state.tabs]);

  const activate = useCallback(
    (path: string) => {
      dispatch({ type: "activated", path });
      files.select(path);
    },
    [files],
  );

  const close = useCallback(
    (path: string) => {
      dispatch({ type: "closed", path });
    },
    [],
  );

  const closeOthers = useCallback((path: string) => {
    dispatch({ type: "closedOthers", path });
  }, []);

  const reopen = useCallback(() => dispatch({ type: "reopened" }), []);

  /**
   * "Open in new tab".
   *
   * The selection effect above will open this path as a *preview* tab, which
   * the next click would replace — so pinning is what makes the menu item mean
   * anything different from a plain open. Dispatched after the open rather than
   * instead of it, because the reducer treats a pin of an unopened path as a
   * no-op by design.
   */
  const pin = useCallback((path: string) => {
    dispatch({ type: "opened", path, mode: "pinned" });
    dispatch({ type: "pinned", path });
  }, []);

  /**
   * Closing the active tab has to move the editor, not just the strip.
   *
   * The reducer already picks the neighbour; this follows it. Without it the
   * strip highlights one note while the editor still holds the closed one,
   * which is the exact desync this hook's one-direction rule exists to prevent.
   */
  const active = state.activePath;
  useEffect(() => {
    if (active !== null && active !== files.editor.path) files.select(active);
    // `files.select` is stable enough to leave out; re-running on every browser
    // identity change would fight the selection it just made.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  return { state, activate, pin, close, closeOthers, reopen };
}
