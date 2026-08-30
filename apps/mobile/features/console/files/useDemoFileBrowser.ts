/**
 * The read-only file browser on the landing page.
 *
 * The same components as the real console, driven by literals instead of a
 * bucket — so the marketing page is the product, not a screenshot of it. The
 * tree expands and notes open, because those are honest; **nothing here can
 * act**. `canEdit` is false and every mutating method is a no-op the UI never
 * renders a control for, which is the same rule `useDemoConsoleData` already
 * applies to Revoke: a visitor is never offered a button that would lie.
 *
 * The trees themselves live in `placeholderData.ts` — one per demo context,
 * with the material and the reasoning behind it documented there. This module
 * is the wiring, and the wiring's one real job is that **switching context
 * resets everything**: the tree, what is expanded, what is selected, and the
 * open note. A console that kept `1-projects/ltn-2026.md` open while you moved
 * to a context with no such file would be showing one context's note under
 * another context's name.
 */

import { useCallback, useEffect, useMemo, useReducer, useState } from "react";
import { demoTreeFor, type DemoContextTree } from "../placeholderData";
import type { FileBrowser } from "./browser";
import { editorReducer, emptyEditor } from "./editor";
import type { OpenNote } from "./types";

/** The note at a path in this tree, or `null` when it is a folder. */
export function demoNote(tree: DemoContextTree, path: string): OpenNote | null {
  const text = tree.notes[path];
  if (text === undefined) return null;
  const parent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  const entry = tree.listings[parent]?.entries.find((candidate) => candidate.path === path) ?? null;
  return {
    path,
    text,
    etag: "demo",
    visibility: entry?.visibility ?? "private",
    inherited: entry?.inherited ?? "private",
    exception: entry?.exception ?? false,
    // `readOnly` means "this *file* cannot be edited by anyone" — it is only
    // ever `privacy.md`, which is generated. That the demo cannot edit
    // anything is a different fact, carried by `canEdit`, and conflating the
    // two put the manifest's explainer on top of every note here.
    readOnly: entry?.readOnly ?? false,
  };
}

const noop = () => {};

export function useDemoFileBrowser(contextId: string | null): FileBrowser {
  const tree = demoTreeFor(contextId);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(
    () => new Set(tree.defaultExpanded),
  );
  const [selectedPath, setSelectedPath] = useState<string | null>(tree.defaultSelection);
  const [editor, dispatch] = useReducer(editorReducer, emptyEditor, () => {
    const note = demoNote(tree, tree.defaultSelection);
    return note === null ? emptyEditor : editorReducer(emptyEditor, { type: "opened", note });
  });

  const select = useCallback(
    (path: string): boolean => {
      setSelectedPath(path);
      const note = demoNote(tree, path);
      // A folder has no body, so the pane shows its summary instead of an editor.
      if (note === null) dispatch({ type: "closed" });
      else dispatch({ type: "opened", note });
      // Always allowed: the demo cannot edit, so there is never a draft to guard.
      return true;
    },
    [tree],
  );

  const toggleFolder = useCallback((path: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  // Switching context means a different bucket, so nothing about the old one
  // survives it. `useFileBrowser` does exactly this against a real workspace
  // id; the demo has to behave the same way or the landing page would be
  // demonstrating a bug.
  useEffect(() => {
    setExpanded(new Set(tree.defaultExpanded));
    setSelectedPath(tree.defaultSelection);
    const note = demoNote(tree, tree.defaultSelection);
    if (note === null) dispatch({ type: "closed" });
    else dispatch({ type: "opened", note });
  }, [tree]);

  return useMemo(
    () => ({
      canEdit: false,
      readOnlyReason: tree.readOnlyReason,
      loading: false,
      busy: false,
      listings: tree.listings,
      expanded,
      toggleFolder,
      selectedPath,
      select,
      editor,
      setDraft: noop,
      save: noop,
      useTheirs: noop,
      keepMine: noop,
      discard: noop,
      notice: null,
      dismissNotice: noop,
      // Nothing on the landing page mutates anything, so nothing there has an
      // inverse to offer. Empty rather than absent, because it is a required
      // member of the interface — see `browser.ts` on inert methods.
      toasts: [],
      dismissToast: noop,
      clipboard: null,
      copy: noop,
      cut: noop,
      paste: noop,
      copyTo: noop,
      createNote: noop,
      createFolder: noop,
      rename: noop,
      move: noop,
      duplicate: noop,
      archive: noop,
      destroy: noop,
      setVisibility: noop,
      resetPrivacy: noop,
      canResetPrivacy: false,
      canSetVisibility: false,
      // The landing page's console cannot share, and `shares` is `undefined`
      // rather than `[]` for the reason `browser.ts` gives: `[]` means "nobody
      // has access", which is a different claim from "this console never asked".
      canShare: false,
      shares: undefined,
      share: noop,
      revokeShare: noop,
      teamShareLink: async () => null,
      setSharePreviewTitle: noop,
    }),
    [editor, expanded, select, selectedPath, toggleFolder, tree],
  );
}
