import { describePreviewTitle, type NoteShare } from "../shares";
import type { CopyTarget, ShareDialogProps, ShareMoreAction } from "./props";
import type { ShareMenuItem } from "./ShareMenu";

/**
 * What the header's ⋯ menu holds: the things this dialog can do that most
 * people never need.
 *
 * The workspace link only once a public link exists — until then it is what
 * the footer's Copy link copies, and two buttons for one link was the old
 * sheet's complaint. The public link's own switches sit here too, next to the
 * caller's extra action (password encryption, today) and the long answers.
 */
export function moreItems({
  path,
  openLink,
  advanced,
  help,
  copyAndClose,
  onRevoke,
  onSetPreviewTitle,
  onToggleHelp,
}: {
  path: string;
  openLink: NoteShare | undefined;
  advanced: ShareMoreAction | undefined;
  help: boolean;
  copyAndClose: (target: CopyTarget) => void;
  onRevoke: ShareDialogProps["onRevoke"];
  onSetPreviewTitle: ShareDialogProps["onSetPreviewTitle"];
  onToggleHelp: () => void;
}): ShareMenuItem[] {
  const items: ShareMenuItem[] = [];
  if (openLink !== undefined) {
    items.push(
      {
        id: "workspace-link",
        label: "Copy workspace link",
        detail: "Only people who already have access can open it",
        icon: "link",
        testID: "share-team-link",
        onPress: () => copyAndClose({ kind: "team", path }),
      },
      {
        id: "preview",
        label: openLink.titleInPreview
          ? "Hide the name in link previews"
          : "Show the name in link previews",
        detail: openLink.titleInPreview
          ? describePreviewTitle(openLink.previewTitle, openLink.audience)
          : "Previews show nothing about this note.",
        icon: "eye",
        testID: "share-open-link-preview",
        onPress: () => onSetPreviewTitle(openLink, !openLink.titleInPreview),
      },
    );
  }
  if (advanced !== undefined) {
    items.push({ ...advanced, separatorBefore: items.length > 0 });
  }
  items.push({
    id: "help",
    label: help ? "Hide how sharing works" : "How sharing works",
    icon: "info",
    separatorBefore: true,
    testID: "share-help-toggle",
    onPress: onToggleHelp,
  });
  if (openLink !== undefined) {
    items.push({
      id: "revoke",
      label: "Turn off the public link",
      detail: "It stops working now. Copies already opened stay opened",
      icon: "close",
      danger: true,
      separatorBefore: true,
      testID: "share-open-link-revoke",
      onPress: () => onRevoke(openLink.shareId),
    });
  }
  return items;
}
