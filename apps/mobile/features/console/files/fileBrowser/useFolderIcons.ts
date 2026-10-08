/**
 * The folder icons this console has been given, and the writes that change them.
 *
 * Part of `useFileBrowser`, and the first one: `useFileActions` wraps the four
 * folder-moving actions with `moved` and `removed`, so every move the console
 * makes (rename, move, undo, a batch, an offline replay) carries its icon along
 * on screen at once, without each caller knowing icons exist. The server does
 * the same to the bucket (`folderIcons.cjs`); this keeps the screen from waiting
 * on a second read to agree with it.
 *
 * Read once per workspace, not per listing: the icons are one small file, and
 * the rows that draw them are every folder in the tree. A failed read leaves
 * the map empty, and the rows show the plain folder icon.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { iconFor, iconMapOf, movedIcons, removedIcons, withIcon, type IconMap } from "../folderIcons";
import type { FileBrowserOptions } from "./types";

export interface FolderIconsValues {
  /** The emoji a folder was given, or `null` for the plain folder icon. */
  iconOf: (path: string) => string | null;
  /**
   * Give `path` an emoji, or remove its icon with `null`. Shows the new icon at
   * once and puts the old one back if the server refuses; rejects with the
   * server's error so the caller can say why.
   */
  setIcon: (path: string, icon: string | null) => Promise<void>;
  /** A folder (or a note) moved from `from` to `to`: its icon goes with it. */
  moved: (from: string, to: string) => void;
  /** A folder is gone for good: its icon goes too. */
  removed: (path: string) => void;
}

export function useFolderIcons(options: FileBrowserOptions): FolderIconsValues {
  const workspaceId = options.workspaceId as Id<"workspaces"> | null;
  const listIcons = useAction(api.functions.folderIcons.list);
  const setIconAction = useAction(api.functions.folderIcons.set);

  const [icons, setIcons] = useState<IconMap>({});
  // The same map, readable synchronously by the writers below. `apply` is the
  // only place either one changes, so the two cannot disagree.
  const current = useRef<IconMap>({});
  // Bumped when the workspace changes. An answer from an older workspace is
  // dropped rather than drawn over the new one's folders.
  const scope = useRef(0);

  const apply = useCallback((next: IconMap) => {
    current.current = next;
    setIcons(next);
  }, []);

  useEffect(() => {
    const mine = ++scope.current;
    apply({});
    if (workspaceId === null) return;
    void (async () => {
      try {
        const list = await listIcons({ workspaceId });
        if (mine === scope.current) apply(iconMapOf(list));
      } catch {
        // No icons, so every folder draws the plain folder icon. Nothing to say about that.
      }
    })();
  }, [apply, listIcons, workspaceId]);

  const setIcon = useCallback(
    async (path: string, icon: string | null) => {
      if (workspaceId === null) return;
      const mine = scope.current;
      const before = iconFor(current.current, path);
      apply(withIcon(current.current, path, icon));
      try {
        const answer = await setIconAction({ workspaceId, path, icon });
        if (mine === scope.current) apply(iconMapOf(answer));
      } catch (error) {
        if (mine === scope.current) apply(withIcon(current.current, path, before));
        throw error;
      }
    },
    [apply, setIconAction, workspaceId],
  );

  const moved = useCallback(
    (from: string, to: string) => apply(movedIcons(current.current, from, to)),
    [apply],
  );

  const removed = useCallback((path: string) => apply(removedIcons(current.current, path)), [apply]);

  const iconOf = useCallback((path: string) => iconFor(icons, path), [icons]);

  return { iconOf, setIcon, moved, removed };
}
