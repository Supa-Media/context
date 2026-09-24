import { loadedFolders, type FileBrowser } from "../browser";
import type { Dialog } from "../actions";
import {
  Confirm,
  CreatePrompt,
  MovePicker,
  NamePrompt,
  NEW_FOLDER_HINT,
} from "../Dialogs";
import { ShareDialog } from "../ShareDialog";
import type { AudienceContext } from "../../privacy/audience";
import { consoleOrigin } from "../shareOrigin";
import { sharesBreakingWarning, sharesBreakingWarningMany } from "../shares";
import { baseName, folderLabel, parentPath } from "../paths";
import { findEntry } from "../tree";
import type { AccessMember, AccessRow, RemovalRoute } from "../access";
import type { RecipientGroup } from "../recipients";

/**
 * The dialogs the tree can raise.
 *
 * Separated so the tree and the editor can drive the same set without either
 * owning it.
 */
export function ExplorerDialogs({
  files,
  dialog,
  onClose,
  access,
  create,
}: {
  files: FileBrowser;
  dialog: Dialog;
  onClose: () => void;
  /**
   * The rows of the `create` sheet that are not files.
   *
   * Passed in because neither belongs to the file browser: a meeting is the
   * meetings flow's and a conversation is the aside panel's, and this component
   * is mounted by surfaces that have one, both or neither. Absent means the row
   * is not drawn — see `CreatePrompt`.
   */
  create?: {
    onNewMeeting?: (() => void) | null;
    onNewChat?: (() => void) | null;
    /** Carry on a meeting that already has a note. See `CreatePrompt`. */
    resume?: { detail: string; onResume: () => void } | null;
  };
  /**
   * What the share dialog needs to list who can read a note, and to offer
   * groups as you type.
   *
   * Passed in rather than subscribed here: the console holds one membership
   * and one groups subscription, and a second of either in this component
   * would make every Explorer render test reach for a Convex provider it does
   * not have. Optional, so a caller that has neither draws the dialog without
   * them — which is what it did before this existed.
   */
  access?: {
    members: readonly AccessMember[];
    groups?: readonly RecipientGroup[];
    /**
     * `kind` travels with the path because a folder and a note go to different
     * actions — the note one refuses anything that is not `.md`, which is the
     * refusal an owner met when this dropped it.
     */
    onShareWithGroup?: (path: string, kind: "file" | "folder", group: string) => void;
    /**
     * What a row in the people list can do about somebody, for one path.
     *
     * A factory rather than a handler, because narrowing a note names the
     * note and this component is rendered once for a tree with many. Returns
     * `undefined` for a caller that can do none of it — see `removalHandler`
     * — and the dialog then draws roles rather than controls.
     */
    removalRouteFor?: (
      path: string,
      /** Decides which visibility mutation the narrow route means. */
      kind: "file" | "folder",
    ) => ((route: RemovalRoute, row: AccessRow) => void) | undefined;
    /** The workspace's slug, for showing the name a new group's label becomes. */
    groupSlug?: string;
    /** Whose context this is, so every audience can be named. */
    audience?: AudienceContext;
    /**
     * Make a group and point this path at it. Owner-only upstream.
     *
     * Answers, so the sheet can show a refusal from the control plane where
     * the person can read it — the notice line sits behind the modal.
     */
    onCreateGroup?: (
      path: string,
      /** Same reason `onShareWithGroup` carries one: it ends in the same call. */
      kind: "file" | "folder",
      label: string,
      userIds: readonly string[],
    ) => Promise<unknown>;
  };
}) {
  if (dialog === null) return null;

  switch (dialog.kind) {
    case "create":
      return (
        <CreatePrompt
          folder={dialog.folder}
          canEdit={files.canEdit}
          onCancel={onClose}
          /*
            Neither of these is named. The file is made now, called
            `untitled-<date>`, and takes the first heading typed into it —
            `untitled.ts` has the argument. `CreatePrompt` calls `onCancel`
            before either, so the sheet is gone by the time the editor opens on
            the new note.
          */
          onCreateNote={() => files.createUntitled(dialog.folder, "note")}
          onCreateDrawing={() => files.createUntitled(dialog.folder, "drawing")}
          onCreateFolder={(name) => {
            onClose();
            files.createFolder(dialog.folder, name);
          }}
          onNewMeeting={create?.onNewMeeting ?? null}
          onNewChat={create?.onNewChat ?? null}
          onResumeMeeting={create?.resume ?? null}
        />
      );
    case "newFolder":
      return (
        <NamePrompt
          title="New folder"
          description={NEW_FOLDER_HINT}
          confirmLabel="Create"
          onCancel={onClose}
          onConfirm={(name) => {
            onClose();
            files.createFolder(dialog.folder, name);
          }}
        />
      );
    case "rename":
      return (
        <NamePrompt
          title="Rename"
          description={sharesBreakingWarning(files.shares, dialog.path, "Renaming") ?? undefined}
          initialValue={baseName(dialog.path)}
          confirmLabel="Rename"
          onCancel={onClose}
          onConfirm={(name) => {
            onClose();
            files.rename(dialog.path, name);
          }}
        />
      );
    case "move":
      return (
        <MovePicker
          title={`Move ${folderLabel(baseName(dialog.path))}`}
          description={sharesBreakingWarning(files.shares, dialog.path, "Moving") ?? undefined}
          folders={loadedFolders(files.listings).filter(
            (folder) => dialog.path !== folder && !folder.startsWith(`${dialog.path}/`),
          )}
          currentFolder={parentPath(dialog.path)}
          /*
            Only offered where the browser says so, which is: this person owns
            the context the thing is leaving, and the far end is one they can
            write. Both halves are the server's rule — see
            `functions/contextMoves.ts` — and re-deciding either of them here
            would be a second answer that can drift from the one that is
            actually enforced.

            A folder is not filtered out of the far context's list the way it
            is out of this one, because it cannot be its own ancestor there:
            the two paths are in different buckets.
          */
          destinations={files.moveDestinations}
          loadDestinationFolders={files.destinationFolders}
          onCancel={onClose}
          onConfirm={(folder, contextId) => {
            onClose();
            if (contextId === null) files.move(dialog.path, folder);
            else files.moveToContext(dialog.path, contextId, folder);
          }}
        />
      );
    case "share":
      /*
        Re-checked here rather than trusted from the menu that opened it.
        `canShare` is `canEdit && isOwner`, so it moves independently of
        `canEdit` — the reason `openMenu` lists it in its own dependency array —
        and ownership can go away under a mounted console. A control that is
        present and refused is the defect this codebase records as a live
        breach, not the refusal.
      */
      if (!files.canShare) return null;
      // Braced so the binding below has a block of its own: a `const` bare in
      // a `case` leaks into every sibling arm, which is what
      // `no-case-declarations` is about.
      {
      /*
        Looked up ONCE and used by all four controls below. It was resolved
        inline four times, and one of those four then threw it away on its way
        into `onShareWithGroup` — which is how sharing a folder with a group
        reached the note action and came back "Only markdown notes can have
        their own visibility". One binding is not tidiness here: it is the
        thing that makes dropping it visible.
      */
      const entryKind = findEntry(files.listings, dialog.path)?.kind ?? "file";
      return (
        <ShareDialog
          path={dialog.path}
          shares={files.shares}
          origin={consoleOrigin()}
          onShare={(recipient) => files.share(dialog.path, recipient)}
          onCopyLink={files.copyShareLink}
          onRevoke={(shareId) => files.revokeShare(shareId)}
          onSetSlug={(shareId, slug) => files.setShareSlug(shareId, slug)}
          onSetCollecting={(shareId, on) => files.setShareCollecting(shareId, on)}
          onSetPreviewTitle={(share, on) =>
            files.setSharePreviewTitle(dialog.path, share, on)
          }
          // Deliberately does NOT close on share or revoke. Both are things an
          // owner does several of in a row, and a dialog that vanishes after
          // the first one makes them reopen it to check it worked — which is
          // also the moment they share it twice.
          onClose={onClose}
          /*
            The same two things Browse passes. The entry is looked up here
            rather than threaded through `Dialog`, because the listing is the
            authority on what this note currently reads as and the dialog is
            opened from several places.
          */
          access={
            access === undefined
              ? undefined
              : {
                  visibility: findEntry(files.listings, dialog.path)?.visibility ?? "private",
                  exception: findEntry(files.listings, dialog.path)?.exception ?? false,
                  members: access.members,
                }
          }
          groups={access?.groups}
          /*
            The audience control, wired straight from the browser rather than
            threaded through `access`: `setScope` is already the single point
            every surface goes through — its group guard lives there — and this
            component holds `files` anyway. Owner-only, absent otherwise.
          */
          entryKind={entryKind}
          onSetScope={
            files.canSetVisibility
              ? (from, to) =>
                  files.setScope(dialog.path, entryKind, from, to)
              : undefined
          }
          onRemovalRoute={access?.removalRouteFor?.(dialog.path, entryKind)}
          groupSlug={access?.groupSlug}
          context={access?.audience}
          onCreateGroup={
            access?.onCreateGroup === undefined
              ? undefined
              : (label, userIds) =>
                  access.onCreateGroup!(dialog.path, entryKind, label, userIds)
          }
          onShareWithGroup={
            access?.onShareWithGroup === undefined
              ? undefined
              : (group) => access.onShareWithGroup!(dialog.path, entryKind, group)
          }
        />
      );
      }
    case "moveMany":
      return (
        <MovePicker
          title={`Move ${dialog.paths.length} items`}
          description={sharesBreakingWarningMany(files.shares, dialog.paths, "Moving") ?? undefined}
          // No picked folder can be its own destination, nor anywhere inside
          // one — the same filter the single move applies, over every path.
          folders={loadedFolders(files.listings).filter(
            (folder) =>
              !dialog.paths.some((path) => path === folder || folder.startsWith(`${path}/`)),
          )}
          // Where they all already are, when they are all in one place.
          currentFolder={commonParent(dialog.paths)}
          /*
            No other contexts. A move into another context is its own server
            action with no batch form and no Undo (`moveToContext`), so a batch
            of them would be several long-running moves that finish at
            different times. Absent rather than offered one at a time.
          */
          onCancel={onClose}
          onConfirm={(folder) => {
            onClose();
            files.moveMany(dialog.paths, folder);
          }}
        />
      );
    case "archiveMany":
      return (
        <Confirm
          title={`Archive ${dialog.paths.length} items`}
          body={[
            `These move into 4-archive/ with their original paths kept inside, so you can move them straight back. Nothing is deleted.`,
            sharesBreakingWarningMany(files.shares, dialog.paths, "Archiving"),
          ]
            .filter(Boolean)
            .join(" ")}
          confirmLabel="Archive them"
          onCancel={onClose}
          onConfirm={() => {
            onClose();
            files.archiveMany(dialog.paths);
          }}
        />
      );
    case "archive":
      return (
        /*
          "Nothing is deleted" is true of the bytes and was false of the
          access: a share is stored against the path, so archiving takes every
          outstanding link with it. The sentence is appended rather than
          replacing the reassurance, because both are true and the reassurance
          is the one people came for.
        */
        <Confirm
          title="Archive"
          body={[
            `${dialog.path} moves into 4-archive/ with its original path kept inside, so you can move it straight back. Nothing is deleted.`,
            sharesBreakingWarning(files.shares, dialog.path, "Archiving"),
          ]
            .filter(Boolean)
            .join(" ")}
          confirmLabel="Archive it"
          onCancel={onClose}
          onConfirm={() => {
            onClose();
            files.archive(dialog.path);
          }}
        />
      );
  }
}

/** The folder every path is in, or `null` when they are not all in one. */
function commonParent(paths: readonly string[]): string | null {
  const parents = new Set(paths.map(parentPath));
  return parents.size === 1 ? [...parents][0]! : null;
}
