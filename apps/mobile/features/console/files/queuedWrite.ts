import type { Id } from "@context/convex/_generated/dataModel";
import {
  classifyOpFailure,
  classifyWriteFailure,
  type OpOutcome,
  type WriteOutcome,
} from "../../offline/sync";
import type { PendingOp, PendingWrite } from "../../offline/outbox";
import { toFileError } from "./browser";
import type { ConflictCheck } from "./types";

/**
 * Sending one queued write, in a named context.
 *
 * ## Why this is a function and not two call sites
 *
 * There are now two things that empty a queue — `useOfflineNotes`, for the
 * context on screen, and `useBackgroundDrain`, for every other one — and the
 * single most important property of both is that **the write they make is the
 * one the Save button makes**: `writeNote` with the etag the draft was typed
 * against, so it inherits the server's `onlyIf: { etagMatches }` where the
 * bucket has one and its read-compare where it does not, and comes back with
 * the same `CONFLICT` carrying the same `currentEtag` when somebody got there
 * first.
 *
 * Two copies of that would be two places for a `force` flag to appear, or for
 * an `expectedEtag` to be dropped "to get things through" — which is
 * last-write-wins with extra steps and would read like a bug fix. So there is
 * one, and the two callers differ only in which workspace they bind.
 *
 * ## The workspace is an argument
 *
 * `useFileBrowser`'s queue is the open context's and binds it; the background
 * drain passes the one each queue is *filed under*. That distinction is the
 * whole safety of the background pass: a drain that reused a sender bound to
 * the open context would write every context's queued edits into whichever one
 * happened to be on screen — a cross-tenant write performed by a code path
 * nobody pressed. `writeNote` has always taken a `workspaceId`; this makes it
 * impossible to call without deciding which.
 */
export type QueuedWriteSender = (
  workspaceId: string,
  pending: PendingWrite,
) => Promise<WriteOutcome>;

/**
 * The Convex action both callers already hold.
 *
 * Narrower than what `useAction` hands back — the real answer carries `kind`,
 * `path` and `forms` too — because a return type may widen freely and naming
 * only what is read keeps this from breaking every time that action grows a
 * field. The argument shape is exact, which is the half that has to be.
 */
export type WriteNoteAction = (args: {
  workspaceId: Id<"workspaces">;
  path: string;
  text: string;
  expectedEtag?: string;
}) => Promise<{ etag: string; conflictCheck: ConflictCheck }>;

export function queuedWriteSender(writeNote: WriteNoteAction): QueuedWriteSender {
  return async (workspaceId, pending) => {
    try {
      const result = await writeNote({
        /*
          The one cast, and the only place the offline layer's plain `string`
          meets the control plane's branded id. `features/offline` holds no
          Convex types by design — it is tested with no Convex, no React and no
          network — so a queue records the workspace as a string, and it is the
          string an `Id<"workspaces">` already is. Nothing is proved by the
          brand: the server re-reads membership for this id on every write, so
          an id that was somehow wrong is refused there rather than trusted
          here.
        */
        workspaceId: workspaceId as Id<"workspaces">,
        path: pending.path,
        text: pending.text,
        /*
          `?? undefined`, never omitted and never replaced. A queued write with
          no base etag is one typed against a note that did not exist, and the
          server reads that as "create, and refuse if it is there now". Sending
          a *different* etag, or none at all where one was recorded, is the
          clobber this whole feature is built not to perform.
        */
        expectedEtag: pending.baseEtag ?? undefined,
      });
      return { kind: "written", etag: result.etag, conflictCheck: result.conflictCheck };
    } catch (error) {
      return classifyWriteFailure(toFileError(error));
    }
  };
}

/* ------------------------------------------------------------------------ */
/*                 renames, moves, archives, deletes, folders                */
/* ------------------------------------------------------------------------ */

/**
 * Sending one queued op, in a named context.
 *
 * The same argument as `queuedWriteSender`, and one more reason for there to
 * be exactly one of it: **an op on a note is never sent without the version it
 * was asked about.** `moveEntry`, `archiveEntry` and `trashEntry` treat an
 * absent `expectedEtag` as an online press, made while looking at the list —
 * unchecked. So an op that reached here with no version (which the drain
 * should never let happen) is refused locally rather than sent, and that
 * refusal is a line in this function rather than a convention two callers are
 * trusted to keep.
 */
export type QueuedOpSender = (workspaceId: string, op: PendingOp) => Promise<OpOutcome>;

/** The Convex actions an op is made of — each as narrow as `WriteNoteAction`. */
export interface OpActions {
  moveEntry: (args: {
    workspaceId: Id<"workspaces">;
    from: string;
    to: string;
    expectedEtag?: string;
  }) => Promise<{ to: string; etag?: string }>;
  archiveEntry: (args: {
    workspaceId: Id<"workspaces">;
    path: string;
    expectedEtag?: string;
  }) => Promise<{ to: string }>;
  trashEntry: (args: {
    workspaceId: Id<"workspaces">;
    path: string;
    expectedEtag?: string;
  }) => Promise<{ to: string }>;
  createDirectory: (args: { workspaceId: Id<"workspaces">; path: string }) => Promise<unknown>;
}

export function queuedOpSender(actions: OpActions): QueuedOpSender {
  return async (workspaceId, op) => {
    // See `queuedWriteSender` for this cast.
    const workspace = workspaceId as Id<"workspaces">;
    if (op.kind !== "folder" && op.baseEtag === null) {
      return {
        kind: "rejected",
        code: "NO_VERSION",
        message: "This was never checked against a version of the note, so it was not sent.",
      };
    }
    try {
      switch (op.kind) {
        case "move": {
          const moved = await actions.moveEntry({
            workspaceId: workspace,
            from: op.path,
            to: op.to ?? op.path,
            expectedEtag: op.baseEtag!,
          });
          return { kind: "done", to: moved.to, ...(moved.etag === undefined ? {} : { etag: moved.etag }) };
        }
        case "archive": {
          const archived = await actions.archiveEntry({
            workspaceId: workspace,
            path: op.path,
            expectedEtag: op.baseEtag!,
          });
          return { kind: "done", to: archived.to };
        }
        case "trash": {
          const trashed = await actions.trashEntry({
            workspaceId: workspace,
            path: op.path,
            expectedEtag: op.baseEtag!,
          });
          return { kind: "done", to: trashed.to };
        }
        case "folder":
          await actions.createDirectory({ workspaceId: workspace, path: op.path });
          return { kind: "done" };
      }
    } catch (error) {
      const failure = toFileError(error);
      /*
        A folder that is already there is the folder somebody asked for. The
        server refuses only when the folder's README exists, and writes nothing
        in that case, so "done" here overwrites nothing and claims nothing
        untrue — which a parked "that folder already exists" would, as a thing
        needing somebody's attention.
      */
      if (op.kind === "folder" && failure.code === "DESTINATION_EXISTS") return { kind: "done" };
      return classifyOpFailure(failure);
    }
  };
}
