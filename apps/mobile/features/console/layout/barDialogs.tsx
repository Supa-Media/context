import type { Dispatch, SetStateAction } from "react";
import { capabilitiesForRole } from "../capabilities";
import { removalHandler } from "../files/access";
import { ExplorerDialogs, type Dialog } from "../files/Explorer";
import { audienceContextOf } from "../privacy/audience";
import type { ConsoleContext, ConsoleData } from "../types";
import type { ConsoleRouter } from "./types";
import type { ConsoleAside } from "./useConsoleAside";

/**
 * The dialogs the toolbar's `+` and the top bar's Share raise.
 *
 * A function returning the element rather than a component, so the tree the
 * console layout renders is exactly the one it rendered when this was inline:
 * no extra fibre in `AppFrame`'s slots, nothing a render test can find twice.
 */
export function consoleBarDialogs({
  data,
  barDialog,
  setBarDialog,
  startMeeting,
  startNewChat,
  resumeRow,
  current,
  insideContext,
  router,
}: {
  data: ConsoleData;
  barDialog: Dialog;
  setBarDialog: Dispatch<SetStateAction<Dialog>>;
  startMeeting: ConsoleAside["startMeeting"];
  startNewChat: ConsoleAside["startNewChat"];
  resumeRow: ConsoleAside["resumeRow"];
  current: ConsoleContext | null;
  insideContext: boolean;
  router: ConsoleRouter;
}) {
  /* The toolbar's `+`. `Explorer` renders its own copy for the tree's. */
  return (
    <ExplorerDialogs
      files={data.files}
      dialog={barDialog}
      onClose={() => setBarDialog(null)}
      /*
        The two rows of the phone's create sheet that are not files. The same
        handlers the corner's menu gets, so the two `+`s offer the same
        things — see `CreatePrompt`.
      */
      create={{ onNewMeeting: startMeeting, onNewChat: startNewChat, resume: resumeRow }}
      /*
        The share dialog raised from the toolbar is the one a phone
        reaches, and it was drawing without the people or the groups —
        which is how it came to be three paragraphs and a keyboard. Read
        off the console's own single subscriptions; `groups.actions` is
        absent for anybody who is not an owner, so the field offers no
        group rows rather than a pick the server would refuse.
      */
      access={{
        members: data.members?.members ?? [],
        groups:
          data.groups?.actions === undefined
            ? undefined
            : data.groups.groups.map((group) => ({
                name: group.name,
                label: group.label,
                liveCount: group.members.filter((member) => member.live).length,
              })),
        onShareWithGroup:
          data.groups?.actions === undefined
            ? undefined
            : (path, kind, group) => data.files.shareWithGroup(path, kind, group),
        /*
          The same three halves the pane passes, each present only where
          this caller holds it. Built per path rather than once, because
          narrowing a note names the note — see `removalHandler`.
        */
        groupSlug: current?.slug,
        /*
          Named audiences, from the one derivation every surface uses. The
          share sheet says "Everyone in @supa" rather than "Workspace",
          which is a set the reader can check. See `privacy/audience.ts`.
        */
        audience: audienceContextOf(
          current?.slug,
          current?.kind,
          capabilitiesForRole(current?.role).isOwner,
        ),
        onCreateGroup:
          data.groups?.actions === undefined
            ? undefined
            : (path, kind, label, userIds) =>
                data
                  .groups!.actions!.createWith(label, userIds)
                  .then((name) => data.files.shareWithGroup(path, kind, name)),
        removalRouteFor: (path, kind) =>
          removalHandler({
            path,
            kind,
            setPrivate: (target, targetKind) =>
              data.files.setVisibility(target, targetKind, "private"),
            removeMember: data.members?.actions?.remove,
            openGroups:
              data.groups?.actions === undefined || !insideContext
                ? undefined
                : () => {
                    setBarDialog(null);
                    router.setParams({ settings: "groups" });
                  },
          }),
      }}
    />
  );
}
