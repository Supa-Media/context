/**
 * A move into another context, carried batch by batch through this
 * deployment: each batch read out of the source bucket, written into the
 * destination, and retired from the source (`contextMoveExport`,
 * `contextMoveImport`, `contextMoveDelete`).
 */

import { internal } from "../../_generated/api";
import type { ActionCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { CONTEXT_MOVE_SKIP_CAP } from "./fileOps";

/**
 * Notes a move may find edited mid-move, and take back and carry again, before
 * it stops. An open editor saving while its note moves is the usual one: its
 * copy goes, the batch is listed again, and the latest text is what arrives.
 * The pause gives the edit a moment to settle before the next read.
 */
export const CONTEXT_MOVE_CONFLICT_RETRIES = 5;
const CONTEXT_MOVE_CONFLICT_PAUSE_MS = 1_000;

export type MoverPass = {
  movedObjects: number;
  movedBytes: number;
  remaining: boolean;
  /** Set when the pass ended the move. */
  failed?: string;
  /** Edits met mid-move that the pass took back and carried again. */
  conflicts?: number;
};

/** Words for a move that kept meeting edits, never a provider's text. */
const CONFLICT_STOPPED =
  "A note changed while it was being moved, so the move stopped. Everything already moved is in the new context; run it again to finish.";

/**
 * A batch met an edit: its copy is already taken back. Within the move's
 * budget the batch is listed and carried again after a pause; past it, the
 * move stops and says so.
 */
async function absorbConflict(pass: MoverPass, conflictsLeft: number): Promise<boolean> {
  const used = pass.conflicts ?? 0;
  if (used >= conflictsLeft) return false;
  pass.conflicts = used + 1;
  pass.remaining = true;
  await new Promise((resolve) => setTimeout(resolve, CONTEXT_MOVE_CONFLICT_PAUSE_MS));
  return true;
}

const UNEXPECTED = "The move could not be completed. Nothing further was moved.";

type MoveRow = {
  sourceWorkspaceId: Id<"workspaces">;
  destinationWorkspaceId: Id<"workspaces">;
  from: string;
  to: string;
  movedObjects: number;
};
type Access = { scope: "private" | "team"; grantedNames: string[] };
type Skip = { path: string; reason: "encrypted" | "too_large" };

/** Carry up to `batches` batches here. `skipped` is added to in place. */
export async function carryHere(
  ctx: ActionCtx,
  input: { row: MoveRow; source: Access; destination: Access; skipped: Skip[]; batches: number; conflictsLeft: number },
): Promise<MoverPass> {
  const { row, source, destination, skipped } = input;
  const pass: MoverPass = { movedObjects: 0, movedBytes: 0, remaining: true };
  for (let batch = 0; batch < input.batches && pass.remaining; batch += 1) {
    const exported = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: row.sourceWorkspaceId,
      scope: source.scope,
      grantedNames: source.grantedNames,
      operation: {
        kind: "contextMoveExport",
        from: row.from,
        to: row.to,
        skip: skipped.map((entry) => entry.path),
      },
    });
    if (exported.kind !== "contextMoveExported") return { ...pass, failed: UNEXPECTED };
    pass.remaining = exported.remaining;
    for (const entry of exported.skipped) {
      if (!skipped.some((seen) => seen.path === entry.path)) skipped.push(entry);
    }
    if (skipped.length > CONTEXT_MOVE_SKIP_CAP) {
      return {
        ...pass,
        failed:
        `More than ${CONTEXT_MOVE_SKIP_CAP} notes here are encrypted to this context and cannot move. Take them out of the encrypted state first, or move this in smaller pieces.`,
      };
    }
    if (exported.objects.length === 0) {
      /*
        NOTHING TO CARRY, ON A MOVE THAT HAS CARRIED NOTHING.

        Every other way of reaching an empty export is ordinary — a batch
        whose candidates were all skipped, or the pass after the last
        object went. This one is not: it means the path somebody typed or
        picked is not there, and completing on it would tell them their
        note is in the other context.

        `movePath` throws `notFound` for the same case. Here the export
        cannot: an export that refused an empty subtree would refuse the
        final pass of every successful move.
      */
      if (row.movedObjects + pass.movedObjects === 0 && skipped.length === 0) {
        return {
          ...pass,
          failed:
          `There is nothing at ${row.from} to move.`,
        };
      }
      break;
    }

    const landed = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: row.destinationWorkspaceId,
      scope: destination.scope,
      grantedNames: destination.grantedNames,
      operation: {
        kind: "contextMoveImport",
        objects: exported.objects,
        /*
          Only while nothing of this move has landed yet. It is the check
          that refuses a merge onto a folder the destination already has —
          and by the second batch the folder it would be looking at is this
          move's own, so asking again would refuse the move halfway through
          itself.
        */
        ...(row.movedObjects + pass.movedObjects === 0 ? { root: row.to } : {}),
      },
    });
    if (landed.kind !== "contextMoveLanded") return { ...pass, failed: UNEXPECTED };

    if (landed.landed.length > 0) {
      const carried = new Map(
        exported.objects.map((object) => [object.source, object.bytes.byteLength]),
      );
      const removed = await ctx.runAction(internal.functions.files.runFileOperation, {
        workspaceId: row.sourceWorkspaceId,
        scope: source.scope,
        grantedNames: source.grantedNames,
        operation: {
          kind: "contextMoveDelete",
          sources: landed.landed.map((entry) => {
            const exportedObject = exported.objects.find(
              (object) => object.source === entry.source,
            )!;
            return { path: entry.source, etag: exportedObject.etag };
          }),
        },
      });
      if (removed.kind !== "contextMoveRemoved") return { ...pass, failed: UNEXPECTED };
      pass.movedObjects += removed.deleted.length;
      for (const path of removed.deleted) pass.movedBytes += carried.get(path) ?? 0;

      if (removed.conflicts.length > 0) {
        /*
          SOMEBODY EDITED IT BETWEEN THE COPY AND THE DELETE.

          The copy at the destination is the older text, so it is the copy
          that goes: taking the source out instead would lose the edit,
          and leaving both would quietly fork the note. Everything else in
          this batch has already moved and stays moved, and running the
          move again picks the note up with its new etag.
        */
        const stale = landed.landed.filter((entry) =>
          removed.conflicts.includes(entry.source),
        );
        const takenBack = await ctx
          .runAction(internal.functions.files.runFileOperation, {
            workspaceId: row.destinationWorkspaceId,
            scope: destination.scope,
            grantedNames: destination.grantedNames,
            // The same conditional-delete operation the source half uses,
            // pointed the other way: it removes each copy only if it still
            // holds the etag this move gave it, and clears the exception
            // the import wrote beside it. A plain delete would take
            // whatever is at that path, including something the
            // destination's own owner put there in between.
            operation: {
              kind: "contextMoveDelete",
              sources: stale.map((entry) => ({
                path: entry.destination,
                etag: entry.etag,
              })),
            },
          })
          .catch(() => undefined);
        // Listed again, the edited note is read at its new version and carried with the edit; a copy that
        // could not be taken back would stand in the way of that, so the move stops instead.
        const clear = takenBack?.kind === "contextMoveRemoved" && takenBack.deleted.length === stale.length;
        if (clear && (await absorbConflict(pass, input.conflictsLeft))) continue;
        return { ...pass, failed: CONFLICT_STOPPED };
      }
    }
    if (landed.failure !== null) {
      return {
        ...pass,
        failed:
        landed.failure.code === "DESTINATION_EXISTS"
          ? "Something is already at that path in the other context, so the move stopped. Pick a name nothing there is using and run it again."
          : landed.failure.message,
      };
    }
  }
  return pass;
}
