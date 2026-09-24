import { useEffect, useMemo } from "react";
import { useAction, type ReactAction } from "convex/react";
import { api } from "@context/convex/_generated/api";
import type { Id } from "@context/convex/_generated/dataModel";
import { forgetDepartedContexts } from "../../offline/forget";
import { useBackgroundDrain } from "../../offline/useBackgroundDrain";
import { useMirrorSync, type MirrorActions } from "../../offline/useMirrorSync";
import { useMirrorStatuses } from "../../offline/mirrorStatus";
import type { BatchRead, ManifestPage } from "../../offline/mirrorSync";
import { queuedOpSender, queuedWriteSender } from "../files/queuedWrite";
import type { WorkspaceSummary } from "./summaries";

/**
 * What the live console keeps in step on this device for every context, not
 * only the open one: other contexts' queues, the mirror, and the purge of
 * contexts this person has left. Answers the mirrors' statuses.
 *
 * A contiguous run of `useLiveConsoleData`'s body, moved verbatim and called
 * at the same point, so its hooks run in the same order with the same
 * dependency lists. The three actions are the handles that hook already
 * held, passed in rather than taken twice.
 */
export function useOfflineUpkeep({
  writeNoteAction,
  syncManifestAction,
  readNotesAction,
  selectedContextId,
  liveWorkspaces,
}: {
  writeNoteAction: ReactAction<typeof api.functions.files.writeNote>;
  syncManifestAction: ReactAction<typeof api.functions.files.syncManifest>;
  readNotesAction: ReactAction<typeof api.functions.files.readNotes>;
  selectedContextId: Id<"workspaces"> | null;
  liveWorkspaces: WorkspaceSummary[] | undefined;
}) {
  /*
    Every *other* context's queue, emptied on the same reconnection.

    `useFileBrowser` holds a live queue for the context on screen and drains
    that one itself; until this was mounted, nothing drained the rest. Edit in
    your own context, switch to a shared one and edit there, go through a
    tunnel: the context on screen sent its writes and the other sat unsent
    until somebody navigated back into it. The status strip said "3 notes
    waiting to sync", correctly, about work the app had no way to act on.

    Here rather than inside `useOfflineNotes` because that hook is instantiated
    per open context and its whole surface describes that context — a
    device-wide pass inside it would mean the object describing one context
    quietly acted on four others. `drainAll.ts` carries the rest of the
    argument, including why the open context is excluded rather than shared.
  */
  const sendQueuedTo = useMemo(() => queuedWriteSender(writeNoteAction), [writeNoteAction]);
  const moveEntryAction = useAction(api.functions.files.moveEntry);
  const archiveEntryAction = useAction(api.functions.files.archiveEntry);
  const trashEntryAction = useAction(api.functions.files.trashEntry);
  const createDirectoryAction = useAction(api.functions.files.createDirectory);
  const sendQueuedOpTo = useMemo(
    () =>
      queuedOpSender({
        moveEntry: moveEntryAction,
        archiveEntry: archiveEntryAction,
        trashEntry: trashEntryAction,
        createDirectory: createDirectoryAction,
      }),
    [archiveEntryAction, createDirectoryAction, moveEntryAction, trashEntryAction],
  );
  useBackgroundDrain({ openWorkspaceId: selectedContextId, write: sendQueuedTo, op: sendQueuedOpTo });

  /*
    Every note of every context this person can reach, on the device, kept in
    step with the bucket — `features/offline/useMirrorSync.ts` decides when and
    `mirrorSync.ts` what. From `liveWorkspaces` and never from `workspaces`, for
    the reason the departed purge below gives at length: a remembered list is a
    memory, and a sync *prunes* — driving it from a memory that aged a live
    context out would delete that context's notes at the one moment they are
    earning their keep.

    The two actions are cast at this boundary and nowhere else: the validators
    type `visibility` as a string where the console's `Visibility` is the
    narrower template type, which is the same widening every other read in
    `useFileBrowser` accepts.
  */
  const mirrorActions = useMemo<MirrorActions>(
    () => ({
      syncManifest: async ({ workspaceId, cursor }) =>
        (await syncManifestAction({
          workspaceId: workspaceId as Id<"workspaces">,
          ...(cursor === undefined ? {} : { cursor }),
        })) as unknown as ManifestPage,
      readNotes: async ({ workspaceId, paths }) =>
        (await readNotesAction({
          workspaceId: workspaceId as Id<"workspaces">,
          paths,
        })) as unknown as { results: BatchRead[] },
    }),
    [readNotesAction, syncManifestAction],
  );
  useMirrorSync({
    contexts: liveWorkspaces?.map((workspace) => ({
      workspaceId: workspace.workspaceId,
      role: workspace.role,
    })),
    actions: mirrorActions,
  });
  const mirrors = useMirrorStatuses();

  /*
    The purge for "removed" belongs next to the purge for "left".

    `leaveContext` below clears a context's local copies on the server's answer,
    which covers the one ending this device can see. Every other way a
    membership ends — an owner removing somebody, a shared context deleted, a
    grant revoked — happens on another machine and produces no event here, so
    those copies sat on the device until `sweep`'s thirty-day age bound reached
    them. Thirty days is a cache-hygiene number, not a decision about how long a
    removal takes to land on somebody's laptop.

    This list is the fix, and it costs no new query: `listMyWorkspaces` returns
    the memberships that are still live — plus the pinned context, which is
    reach without a membership row and must count as live too, which is why this
    reads the raw list rather than `memberOf`. A workspace with copies on this
    device that is not in it is a context the server would no longer serve this
    person.

    The guard is the whole safety argument, and `forget.ts` carries it: the list
    must be *known*. `usable()` answers `undefined` while the subscription is in
    flight and for a query that failed — both of which produce an empty key here
    — and `forgetDepartedContexts` refuses an empty list, so a slow or broken
    subscription purges nothing rather than blanking the cache at the one moment
    it is earning its keep. What it takes is notes and listings only, never a
    draft or a queued write, so even a wrong reading of this list cannot cost
    somebody's typing.

    Keyed by the ids joined rather than by `workspaces`, because that array's
    identity changes on every tick of any field on any row: a re-render because
    somebody renamed a context is not a membership change, and the dependency
    should say so. Splitting the key back apart is sound because a Convex
    document id is base32 and cannot contain the separator — and if that ever
    stopped being true, the fragments would match no cached workspace, so the
    failure is a purged cache for a context the person still has. A cache miss,
    in the direction this whole function is allowed to be wrong in.
  */
  /*
    `liveWorkspaces`, never `workspaces`, and this is the one place below that
    difference matters.

    `workspaces` may be the list this device *remembers* when there is no
    network (see `useRememberedContexts`). A purge driven by a memory would be
    exactly the failure the paragraph above rules out: the guard is that the
    list must be **known**, and a remembered list is the opposite of an answer.
    It is also not merely redundant — a remembered row expires on its own age
    bound, so a memory can be a strict subset of what this person still has,
    and purging from it would delete the cached notes of a live context at the
    one moment they are earning their keep.
  */
  const knownContextKey = (liveWorkspaces ?? [])
    .map((workspace) => workspace.workspaceId)
    .join(",");
  useEffect(() => {
    if (knownContextKey === "") return;
    void forgetDepartedContexts(knownContextKey.split(","));
  }, [knownContextKey]);

  return mirrors;
}
