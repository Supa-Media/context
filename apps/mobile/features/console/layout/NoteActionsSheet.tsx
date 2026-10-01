import type { Dispatch, SetStateAction } from "react";
import { Menu } from "../../design/components/Menu";
import { writeClipboard } from "../../design/clipboard";
import { runMenuAction, type ActionContext, type Dialog } from "../files/actions";
import { displayName, parentPath } from "../files/paths";
import { findEntry, treeRowFor } from "../files/tree";
import type { FileEntry } from "../files/types";
import type { ConsoleData } from "../types";
import { noteActionItems, type NoteActionId } from "./noteActions";

/**
 * The ••• sheet over the open note — see `noteActions.ts` for which rows and
 * why. This draws them with the shared `Menu` (a bottom sheet at phone width)
 * and runs each one through the operation the tree's menu already runs.
 */
export function NoteActionsSheet({
  data,
  entry,
  contextLabel,
  setBarDialog,
  onDismiss,
}: {
  data: ConsoleData;
  entry: FileEntry;
  contextLabel: string;
  /** The console's `barDialog` setter — a visitor's Share is a copy there. */
  setBarDialog: Dispatch<SetStateAction<Dialog>>;
  onDismiss: () => void;
}) {
  const files = data.files;
  const visitor = data.visitor;
  const items = noteActionItems({
    entry,
    canEdit: files.canEdit,
    canShare: files.canShare,
    visitor: visitor !== undefined,
  });

  const run = (id: NoteActionId) => {
    onDismiss();
    runNoteAction(id, { data, entry, contextLabel, setBarDialog });
  };

  return (
    <Menu<NoteActionId>
      items={items}
      title={displayName(entry.name)}
      onSelect={run}
      onDismiss={onDismiss}
    />
  );
}

/**
 * One of a note's actions, for the note in front of you: the ••• sheet's
 * rows and the phone's note bar (`ConsoleBottomBar`) both run them here, so
 * the two cannot disagree about what Share or Move does.
 */
export function runNoteAction(
  id: NoteActionId,
  {
    data,
    entry,
    contextLabel,
    setBarDialog,
  }: {
    data: ConsoleData;
    entry: FileEntry;
    contextLabel: string;
    setBarDialog: Dispatch<SetStateAction<Dialog>>;
  },
): void {
  const files = data.files;
  const visitor = data.visitor;
  if (id === "copyLink") {
    if (visitor !== undefined) return visitor.share(entry.path);
    /*
      The share sheet's own Copy link: the team link, which grants nothing —
      reading it is still authorised by membership on every request.
      `copyShareLink` mints-or-reuses it inside the press, which is what
      lets iOS Safari's clipboard accept the write.
    */
    void files
      .copyShareLink({ kind: "team", path: entry.path })
      .then(({ message }) => {
        if (message !== null) files.say(message);
      });
    return;
  }
  const folderDefault = files.listings[parentPath(entry.path)]?.folderDefault ?? "private";
  const context: ActionContext = {
    files,
    contextLabel,
    select: files.select,
    setDialog: setBarDialog,
    writeClipboard: (text) => void writeClipboard(text),
    inheritedOf: (path) => findEntry(files.listings, path)?.inherited ?? "private",
  };
  runMenuAction(id, { kind: "row", row: treeRowFor(entry, folderDefault) }, context);
}
