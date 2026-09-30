/**
 * The iOS editor's comments and folder lists, from the host's side of the
 * bridge: the sink methods a list calls through, and the desired state kept
 * in step with the props. Split out of `LiveEditor.tsx` so that file stays
 * the editor's frame; the protocol itself is `./extras.ts`.
 */

import { useEffect } from "react";
import type { LiveEditorProps } from "../../liveEditorWeb/contract";
import type { HostBridge } from "./bridge";
import { wireListSource, type ExtrasSink } from "./extras";

type FolderLists = LiveEditorProps["folderLists"];

/** The list half of the sink, read off `current()` for the reason every sink in `LiveEditor` is. */
export function listSink(current: () => FolderLists): Required<ExtrasSink> {
  return {
    onLoadList: async (folder, subfolders) => {
      const source = await current()?.load(folder, subfolders);
      return source == null ? null : wireListSource(source);
    },
    onSetListProperty: (path, key, value) =>
      current()?.setProperty?.(path, key, value) ?? Promise.resolve("This list can’t be changed here."),
  };
}

/*
  Comments and folder lists, as the web editor draws them (see
  `../guestExtras.ts`). Who signs a comment and whether lists can be read are
  desired state, like `suggest`; a change to the notes reloads every list, as
  the web widget's own subscription does. Rows open through `onOpenNote`, so
  lists are offered only where that is wired.
*/
export function useExtras(
  bridge: HostBridge,
  commenter: string | null | undefined,
  commentModerator: boolean,
  folderLists: FolderLists,
  canOpenNotes: boolean,
): void {
  useEffect(() => {
    bridge.setCommenter(commenter ?? null, commentModerator);
  }, [bridge, commenter, commentModerator]);
  const listsAvailable = folderLists !== undefined && canOpenNotes;
  const listsEditable = folderLists?.setProperty !== undefined;
  useEffect(() => {
    bridge.setLists(listsAvailable, listsEditable);
    return folderLists?.subscribe?.(() => bridge.listsChanged());
  }, [bridge, folderLists, listsAvailable, listsEditable]);
}
