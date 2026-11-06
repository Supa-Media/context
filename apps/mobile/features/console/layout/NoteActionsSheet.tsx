import type { Dispatch, SetStateAction } from "react";
import { Menu } from "../../design/components/Menu";
import { copyDeferred, writeClipboard } from "../../design/clipboard";
import { useAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { runMenuAction, type ActionContext, type Dialog } from "../files/actions";
import { displayName, parentPath } from "../files/paths";
import { setReadMode, useReadMode } from "../files/readMode";
import { findEntry, treeRowFor } from "../files/tree";
import type { FileEntry } from "../files/types";
import type { ConsoleData } from "../types";
import { noteActionItems, type NoteActionId } from "./noteActions";
import { askAddProperty } from "../files/noteEditor/chips/addPropertyAsk";
import { trackButton } from "../../observability/client";
import { isPagePath } from "@context/shared/src/pages/index.cjs";
import { PAGE_VIEW_AVAILABLE } from "../files/pageView/PageView";
import { setPageAsText, usePageAsText } from "../files/pageView/pageText";

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
  const reading = useReadMode();
  const asText = usePageAsText(entry.path);
  const page = PAGE_VIEW_AVAILABLE && isPagePath(entry.path);
  const items = noteActionItems({
    entry,
    canEdit: files.canEdit,
    canShare: files.canShare,
    visitor: visitor !== undefined,
    reading,
    pageAsText: page ? asText : undefined,
  });

  const readNote = useAction(api.functions.files.readNote);
  /*
    The file's whole text, read as Download reads it (`useRowCommands` `download`), so a history file copies the
    chat's JSON and a note its Markdown. `copyDeferred` keeps Safari's clipboard inside the press.
  */
  const copyText = () => {
    const workspaceId = data.selectedContextId;
    if (workspaceId === null) return;
    trackButton("copy_text");
    void copyDeferred(async () => {
      try {
        return (await readNote({ workspaceId: workspaceId as Id<"workspaces">, path: entry.path })).text;
      } catch {
        return null;
      }
    }).then(({ ok }) => files.say(ok ? "Text copied." : "Couldn't copy the text."));
  };

  const run = (id: NoteActionId) => {
    onDismiss();
    if (id === "read") return setReadMode(!reading);
    if (id === "pageText") return setPageAsText(entry.path, !asText);
    if (id === "addProperty") return askAddProperty();
    if (id === "copyText") return copyText();
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
  /** Reading mode, Add property and Copy text are the sheet's own rows (`NoteActionsSheet`), not operations on the note. */
  id: Exclude<NoteActionId, "read" | "pageText" | "addProperty" | "copyText">,
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
    trackButton("copy_link");
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
