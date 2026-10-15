import type { Dispatch, SetStateAction } from "react";
import { CreateButton } from "../CreateButton";
import type { Dialog } from "../files/Explorer";
import { targetFolder } from "../files/tree";
import type { ConsoleData } from "../types";
import type { ConsoleAside } from "./useConsoleAside";

/*
  The corner's `+`. A function returning the element (or `null`) rather than a
  component, so the children `AppFrame` receives are exactly the ones it
  received when this was inline.
*/

export function consoleCreateButton({
  data,
  phone,
  startMeetingFlow,
  resumeRow,
  setBarDialog,
}: {
  data: ConsoleData;
  phone: boolean;
  startMeetingFlow: ConsoleAside["startMeetingFlow"];
  resumeRow: ConsoleAside["resumeRow"];
  setBarDialog: Dispatch<SetStateAction<Dialog>>;
}) {
  /*
    THE +, AND WHY IT IS MOUNTED HERE.

    It is inside `AppFrame`'s editor region — the same corner the
    microphone floated in — but it is passed by the *layout*, which is on
    screen for every route under `/console`. That is the whole of the
    owner's second complaint: the microphone was drawn by `NoteEditor`,
    so it vanished on a folder page, on the map and on search. Nothing
    here asks what is open.

    `null` at compact from inside the component, where the phone's
    seven-key row is the reason — see `CreateButton`. Absent altogether on
    the demo console, which has no controller behind a recording and a
    `createNote` that is a no-op: a menu of three things that do nothing
    is worse than no menu. The homepage's visitor keeps it: their notes are
    real, in their tab. A shared link's
    reader does not: their notes are somebody else's, read only.
  */
  return (
    data.demo && (data.visitor === undefined || !data.files.canEdit) ? null : (
    <CreateButton
      compact={phone}
      onNewMeeting={startMeetingFlow}
      resume={resumeRow}
      /*
        The same `targetFolder` rule the tree's own `+` and the phone's
        bottom row both use: a selected folder is the destination, anything
        else means its parent.

        **It writes the file rather than raising a dialog.** The prompt asked
        for the one thing nobody has before they have written anything; the
        note arrives called `untitled-<date>` and renames itself to the first
        heading typed into it. See `files/untitled.ts`.
      */
      onNewNote={() =>
        data.files.createUntitled(
          targetFolder(data.files.listings, data.files.selectedPath),
          "note",
        )
      }
      /*
        The other two things that land in that same folder. A drawing is made
        on the press like the note — `untitled-<date>.excalidraw.md`, which is
        `createUntitled`'s rule and not this control's. **The folder is the
        one that still asks**, through the dialog the tree's own `+` raises
        (`ExplorerDialogs` is already mounted below for the toolbar's, and
        this is that rather than a second one): the reason a note needs no
        prompt is that it has a title field inside it, and a folder has no
        inside to type in.
      */
      onNewDrawing={() =>
        data.files.createUntitled(
          targetFolder(data.files.listings, data.files.selectedPath),
          "drawing",
        )
      }
      onNewFolder={() =>
        setBarDialog({
          kind: "newFolder",
          folder: targetFolder(data.files.listings, data.files.selectedPath),
        })
      }
    />
    )
  );
}
