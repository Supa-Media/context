import type { Dispatch, SetStateAction } from "react";
import { useEncryptionAction } from "../../encryption/useEncryptionAction";
import { ShareDialog } from "../../files/ShareDialog";
import type { FileBrowser } from "../../files/browser";
import { consoleOrigin } from "../../files/shareOrigin";
import { removalHandler } from "../../files/access";
import type { entryAt } from "../../files/tree";
import { audienceContextOf } from "../../privacy/audience";
import { capabilitiesForRole } from "../../capabilities";
import type { ConsoleData, selectedContext } from "../../types";
import type { BrowsePaneProps } from "./props";
import type { BrowseEncryption } from "./useBrowseEncryption";
import { PublishWebsite, isWebsiteFolder } from "../../website/PublishWebsite";

/**
 * The share sheet for the open note or folder, wired to this console's data.
 * Whether it may be drawn at all is decided by `BrowsePane`, beside the
 * argument for why.
 */
export function BrowseShareDialog({
  data,
  files,
  current,
  selected,
  sharing,
  setSharing,
  onOpenSettings,
  noteEncryption,
  announceNoteLock,
  lockBusy,
  setLockBusy,
  lockError,
  setLockError,
}: {
  data: ConsoleData;
  files: FileBrowser;
  current: ReturnType<typeof selectedContext>;
  selected: NonNullable<ReturnType<typeof entryAt>>;
  sharing: string;
  setSharing: Dispatch<SetStateAction<string | null>>;
  onOpenSettings: BrowsePaneProps["onOpenSettings"];
  noteEncryption: BrowseEncryption["noteEncryption"];
  announceNoteLock: BrowseEncryption["announceNoteLock"];
  lockBusy: boolean;
  setLockBusy: BrowseEncryption["setLockBusy"];
  lockError: string | undefined;
  setLockError: BrowseEncryption["setLockError"];
}) {
  /*
    Only when the editor is actually holding this note — the same guard the
    breadcrumb's title uses, for the same reason: the plaintext this locks is
    `files.editor.draft`, and a draft belonging to a different path is a
    different note's content.
  */
  const encryption = useEncryptionAction({
    enabled: files.editor.path === sharing,
    path: sharing,
    encrypted: files.editor.encrypted,
    busy: lockBusy,
    error: lockError,
    onLock: (passphrase) => {
      setLockBusy(true);
      setLockError(undefined);
      noteEncryption
        .protect({
          path: sharing,
          plaintext: files.editor.draft,
          etag: files.editor.etag,
          passphrase,
        })
        .then(() => {
          /*
            The lock just wrote an envelope over `sharing`. The
            plaintext this call sent — `files.editor.draft` above
            — is exactly what a local draft or a queued write for
            this path would also be holding, and either one left
            behind would be a plaintext copy sitting outside the
            envelope this success is the whole promise of closing.
            `useNoteEncryption.ts`'s own header explains why this
            cannot be that call's job: it never touches
            `features/offline`, on purpose, so the door has to be
            reached from out here instead. See `discardLocalCopies`'s
            own comment on `FileBrowser` for the rest of the
            argument, including the boundary this keeps rather
            than widens.

            Before `select`, not after: `select` is what makes
            `files.editor.path` this note's next open, and
            `openNote` now refuses to restore anything for an
            encrypted note regardless — but there is no reason to
            depend on that ordering here when this is the one
            call that actually knows a lock, not a mere reopen,
            is what just happened.
          */
          files.discardLocalCopies(sharing);
          announceNoteLock(sharing);
          // Reopen so `files.editor.encrypted` catches up — the
          // note this session just locked is unlocked in it
          // already (`useNoteEncryption.protect` leaves it so),
          // but the ordinary editor state still shows the
          // plaintext it had a moment ago until it re-reads.
          files.select(sharing);
        })
        .catch((caught: unknown) => {
          setLockError(
            caught instanceof Error ? caught.message : "That did not work.",
          );
        })
        .finally(() => setLockBusy(false));
    },
  });

  return (
    <ShareDialog
      path={sharing}
      footExtra={
        files.contextId !== null && isWebsiteFolder(sharing) ? (
          <PublishWebsite workspaceId={files.contextId} testID="share-publish" />
        ) : undefined
      }
      shares={files.shares}
      origin={consoleOrigin()}
      onShare={(recipient) => files.share(sharing, recipient)}
      onCopyLink={files.copyShareLink}
      onRevoke={(shareId) => files.revokeShare(shareId)}
      /*
        The short link's claim control, and it was missing here while it
        was wired in `Explorer` — so on the pointer console the block never
        drew at all and the feature was, on the surface people actually
        use, absent. Exactly the failure this pane's own test file was
        written about: correct in the component, unreachable on a screen.
      */
      onSetSlug={(shareId, slug) => files.setShareSlug(shareId, slug)}
      onSetCollecting={(shareId, on) => files.setShareCollecting(shareId, on)}
      onSetPreviewTitle={(share, on) =>
        files.setSharePreviewTitle(sharing, share, on)
      }
      onClose={() => setSharing(null)}
      /*
        Only what the server already decided: `selected.visibility` came off
        the listing's own `effectiveVisibility` at this caller's scope, and
        `access.ts` joins it to the membership without evaluating anything.

        `data.members` rather than a `useMembers` of this pane's own: the
        console already holds one subscription for the People section, and a
        second one here made every BrowsePane render test reach for a Convex
        provider it does not have — 96 of them. One subscription, read in
        two places.
      */
      /*
        Only what this caller may actually do. `data.groups.actions` is
        absent for anybody who is not an owner — `listGroups` and
        `setNoteGroup` are both owner-only — so the field offers no group
        rows rather than offering a pick that would be refused. Optional
        all the way down: a data shape without groups at all offers none,
        which is the same answer and the right one.
      */
      groups={
        data.groups?.actions === undefined
          ? undefined
          : data.groups.groups.map((group) => ({
              name: group.name,
              label: group.label,
              liveCount: group.members.filter((member) => member.live).length,
            }))
      }
      onShareWithGroup={
        data.groups?.actions === undefined
          ? undefined
          : (group) => files.shareWithGroup(sharing, selected.kind, group)
      }
      /*
        Make one here, and point this note at it in the same press. The
        group is created, populated, and then named as this note's rule —
        which is the whole sequence somebody previously did by hand across
        two screens.
      */
      entryKind={selected.kind}
      onSetScope={
        files.canSetVisibility
          ? (from, to) => files.setScope(sharing, selected.kind, from, to)
          : undefined
      }
      groupSlug={current?.slug}
      /*
        Every audience is named rather than described — "Everyone in @supa"
        instead of "Workspace", which is a set the reader can check against
        the People list. See `privacy/audience.ts`.
      */
      context={audienceContextOf(
        current?.slug,
        current?.kind,
        capabilitiesForRole(current?.role).isOwner,
      )}
      onCreateGroup={
        data.groups?.actions === undefined
          ? undefined
          : (label, userIds) =>
              data
                .groups!.actions!.createWith(label, userIds)
                .then((name) => files.shareWithGroup(sharing, selected.kind, name))
      }
      access={{
        visibility: selected.visibility,
        exception: selected.exception,
        members: data.members?.members,
      }}
      /*
        What a row can actually do about somebody. Each half is present
        only where this caller holds it: `setPrivate` needs write access to
        the manifest, `removeMember` is owner-only in `apps/convex`, and
        `removalHandler` returns `undefined` when neither is — so a
        non-owner's rows draw their role, exactly as they always did.
      */
      onRemovalRoute={removalHandler({
        path: sharing,
        kind: selected.kind,
        setPrivate: (path, kind) => files.setVisibility(path, kind, "private"),
        removeMember: data.members?.actions?.remove,
        openGroups:
          data.groups?.actions === undefined || onOpenSettings === undefined
            ? undefined
            : () => onOpenSettings("sharing"),
      })}
      advanced={encryption}
    />
  );
}
