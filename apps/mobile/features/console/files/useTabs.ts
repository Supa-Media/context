import { useCallback, useEffect, useReducer, useRef } from "react";
import type { FileBrowser } from "./browser";
import { emptyTabs, tabsReducer, tabsToClose, type TabsState } from "./tabs";

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
export function useTabs(
  files: FileBrowser,
  /**
   * Which context these tabs belong to. Changing it empties the strip.
   *
   * This was missing entirely: `useTabs` was called once, above the `[slug]`
   * segment, and nothing cleared it on a switch. Pruning could not stand in for
   * it — the rule is "a folder that is loaded and does not hold this note", and
   * a *subfolder* of the previous context is never loaded in the next one, so
   * those tabs survived indefinitely. The strip then showed note names from the
   * person's own brain while they were inside somebody else's workspace, which
   * is precisely what `useFileBrowser`'s reset effect exists to prevent for the
   * tree, the selection and the editor.
   *
   * `null` is the landing page, and is a context like any other here: leaving a
   * context for it must not keep the strip either.
   */
  contextKey: string | null,
): {
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
  useEffect(() => {
    for (const path of tabsToClose(state.tabs, listings)) {
      dispatch({ type: "removed", path });
    }
  }, [listings, state.tabs]);

  /**
   * The switch itself. Keyed on the context rather than on `files`, because
   * `files` changes identity on every render and the strip must survive that.
   *
   * The ref is seeded with the *initial* `contextKey`, so the equality check is
   * what stops a reset **on mount** — the effect runs there too, and without the
   * check it would wipe a strip that the `opened` effect above has already
   * filled, because that effect is declared first and both run in the same
   * commit. `useTabs` is mounted with a note already open every time somebody
   * reloads the console on a note.
   *
   * An earlier version of this comment claimed the opposite — that the effect
   * "only runs when the key has already changed", so the check "fails nothing"
   * and was kept as belt to a brace. That was wrong, and it contradicted the
   * sentence directly above it. It looked true because at mount the state is
   * already `emptyTabs`, so the redundant `reset` hits `useReducer`'s bail-out
   * and nothing is visibly lost; give the mount a tab to lose and it is
   * immediate. Tenth comment in this repository to argue for behaviour the code
   * does not have, and the first one written while claiming to be careful about
   * exactly that.
   */
  const openContext = useRef(contextKey);
  useEffect(() => {
    if (openContext.current === contextKey) return;
    // Moving the ref forward is what makes the NEXT switch fire. Pinned at the
    // first key, A->B resets and B->A does not — which is this file's own bug
    // back, on the most ordinary navigation a context rail produces.
    openContext.current = contextKey;
    dispatch({ type: "reset" });
  }, [contextKey]);

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
