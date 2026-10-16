/**
 * What the barrier schedules, and records, once an operation has landed: the
 * next pass of a maintenance run, and the storage-layout state the console
 * reads.
 *
 * Split out of `fileOperationBarrier.ts` for size, and moved verbatim. It is
 * called after the operation's result is known and before the barrier returns
 * it, so nothing here decides the result. It opens no bucket credential and
 * raises none of the storage codes; both stay in the barrier, and
 * `__tests__/storageCodePosition.test.ts` holds that.
 */

import type { Infer } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { STORAGE_LAYOUT_ROLLBACK_MS } from "../../../../mcp/src/storageLayout.js";
import type { OperationResult } from "./operationTypes";
import { operationValidator } from "./operationValidators";

export async function afterMaintenance(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    scope: "private" | "team";
    operation: Infer<typeof operationValidator>;
  },
  result: OperationResult,
): Promise<void> {
  // A maintenance pass that got somewhere and is not finished schedules the
  // next one. Here rather than in a job of its own because a second internal
  // action that opens a bucket credential is a second credential barrier,
  // and `CREDENTIAL_BARRIERS` holding one entry with a long warning attached
  // is the point of it — see CLAUDE.md, "Credential barriers are enumerated,
  // never inferred". Scheduling from inside the barrier propagates no taint.
  if (
    args.operation.kind === "maintainIndex" &&
    result.kind === "indexMaintained" &&
    result.changed &&
    !result.complete
  ) {
    const passes = Math.floor(args.operation.passes ?? 0);
    if (passes > 0) {
      await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
        workspaceId: args.workspaceId,
        scope: args.scope,
        operation: { kind: "maintainIndex", passes: passes - 1 },
      });
    }
  }
  if (args.operation.kind === "migrateStorage" && result.kind === "storageMigrated") {
    /*
      WHAT THE BUCKET SAID, WRITTEN DOWN WHERE A QUERY CAN REACH IT.

      The bucket stays authoritative — `migrateStorageLayout` keeps its own
      state under `.context/` and short-circuits on `complete`. This is the
      copy the console reads, and it is recorded on **every** pass rather
      than only at the end, so an owner watching a long migration sees
      `copying` rather than nothing at all.

      Before this, nothing outside the bucket knew the migration had ever
      run. The console's offer to run it was therefore answered by a flag on
      one device, and came back on the next browser and the next phone for a
      bucket already migrated — which is the nag this is here to end.
    */
    await ctx.runMutation(internal.functions.storage.recordStorageLayoutState, {
      workspaceId: args.workspaceId,
      state: result.state,
    });
    const continuing =
      (args.operation.cleanup && result.state === "cleaning") ||
      (!args.operation.cleanup && result.state === "copying");
    if (continuing) {
      await ctx.scheduler.runAfter(0, internal.functions.files.runFileOperation, {
        workspaceId: args.workspaceId,
        scope: "private",
        operation: {
          kind: "migrateStorage",
          cleanup: args.operation.cleanup,
        },
      });
    } else if (!args.operation.cleanup && result.state === "copied") {
      await ctx.scheduler.runAfter(
        STORAGE_LAYOUT_ROLLBACK_MS + 5_000,
        internal.functions.files.runFileOperation,
        {
          workspaceId: args.workspaceId,
          scope: "private",
          operation: { kind: "migrateStorage", cleanup: true },
        },
      );
    }
  }
  if (args.operation.kind === "readStorageLayout" && result.kind === "storageLayoutRead") {
    /*
      THE QUESTION NOBODY WAS ASKING.

      `migrateStorage` records what the bucket said, but only a context that
      ran the migration *after* that recording existed ever had anything
      recorded. Every context migrated before it kept a `complete` in its own
      bucket and an empty column here, and the console reads an empty column
      as "nobody has run this" — so it offered the update again on every
      device, for ever, to the people who had already run it.

      This is the same write from the other direction: ask, and write down
      the answer, without running anything. `observed: false` is not an
      answer — a bucket that would not talk to us teaches us nothing, and
      recording a timestamp for it would claim otherwise and close the offer
      on a context that may genuinely still need it.
    */
    if (result.observed) {
      await ctx.runMutation(internal.functions.storage.recordStorageLayoutState, {
        workspaceId: args.workspaceId,
        ...(result.state === null ? {} : { state: result.state }),
      });
    }
  }
}
