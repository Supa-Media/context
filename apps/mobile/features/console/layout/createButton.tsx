import type { Dispatch, SetStateAction } from "react";
import { AgentPanel } from "../../agent/AgentPanel";
import { CreateButton } from "../CreateButton";
import type { Dialog } from "../files/Explorer";
import { targetFolder } from "../files/tree";
import type { ConsoleData } from "../types";
import type { ConsoleAside } from "./useConsoleAside";

/*
  The corner's `+`, and the conversation a phone's `+` raises. Functions
  returning the element (or `null`) rather than components, so the children
  `AppFrame` receives are exactly the ones it received when these were inline.
*/

export function consoleCreateButton({
  data,
  phone,
  startMeetingFlow,
  resumeRow,
  setBarDialog,
  startNewChat,
}: {
  data: ConsoleData;
  phone: boolean;
  startMeetingFlow: ConsoleAside["startMeetingFlow"];
  resumeRow: ConsoleAside["resumeRow"];
  setBarDialog: Dispatch<SetStateAction<Dialog>>;
  startNewChat: ConsoleAside["startNewChat"];
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
    is worse than no menu.
  */
  return (
    data.demo ? null : (
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
      /*
        A fresh conversation in the right panel — `startNewChat` above, which
        the phone's `+` sheet also gets, with the three conditions and the
        owner's reason for the third stated there once.
      */
      onNewChat={startNewChat}
    />
    )
  );
}

export function consolePhoneChat({
  phoneChatAt,
  agentEngine,
  agentPlace,
  phone,
  setPhoneChatAt,
}: {
  phoneChatAt: number | null;
  agentEngine: ConsoleAside["agentEngine"];
  agentPlace: ConsoleAside["agentPlace"];
  phone: boolean;
  setPhoneChatAt: ConsoleAside["setPhoneChatAt"];
}) {
  /*
    THE PHONE'S CONVERSATION.

    A phone has no right panel (`hasAside`), so the Chat row in its `+`
    raises this instead — the same `AgentPanel` the note's own microphone
    raises, from the same engine and the same `agentPlace`, mounted by the
    layout so it is reachable on every route rather than only over an open
    note. See `startNewChat`.

    `key` is the timestamp, so each press starts a fresh conversation
    rather than reopening the last one — which is what "New chat" says.
    `compact` is `phone` rather than `true`: the value is only ever read
    here when `phone` holds, and passing the literal would be a second
    opinion about the density this component asks for.
  */
  return (
    phoneChatAt === null ? null : (
      <AgentPanel
        key={phoneChatAt}
        engine={agentEngine}
        place={agentPlace}
        compact={phone}
        onClose={() => setPhoneChatAt(null)}
      />
    )
  );
}
