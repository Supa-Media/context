/**
 * The handler for `workspaces.applyStructure`.
 *
 * Split out of `functions/workspaces.ts` — see that file's header for what
 * owns a context and why a personal and a shared context are the same row,
 * and see `applyStructure`'s own doc comment there for why the layout choice
 * travels with this call rather than being read off a frozen field.
 */

import { ConvexError } from "convex/values";
import { requireAuthId } from "@supa-media/convex/auth";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { MutationCtx } from "../../../_generated/server";
import { recordAudit } from "../audit";
import { consumeRateLimit } from "../rateLimit";
import { validateCustomFolders } from "../scaffold";
import { requireWorkspaceRole, workspaceNotFound } from "../workspaceAuth";
import { APPLY_STRUCTURE_LIMIT, APPLY_STRUCTURE_WINDOW_MS } from "./constants";
import { folderRejectionError } from "./errors";

export async function applyStructureHandler(
  ctx: MutationCtx,
  args: {
    workspaceId: Id<"workspaces">;
    template: "para" | "custom";
    folders?: { folder: string; description: string }[];
  },
): Promise<{ queued: boolean; template: string; folders: string[] }> {
  const userId = (await requireAuthId(ctx)) as Id<"users">;
  await requireWorkspaceRole(ctx, args.workspaceId, userId, "owner");

  // Read here, and handed to the scaffolder below, because it decides what
  // `privacy.md` says the new folders default to: a personal workspace starts
  // all-private, a shared workspace starts team-visible to its members. See
  // `startingVisibility` in `lib/scaffold.ts` for why that is not a widening.
  // Loaded from the row rather than taken as an argument — `kind` is fixed at
  // creation, and a client that could name it could scaffold somebody's workspace
  // open.
  // `requireWorkspaceRole` already proved the membership, so this can only be
  // null if the row was deleted between the two reads. Same error either way,
  // from the one helper that constructs it — see `lib/workspaceAuth.ts`.
  const workspace = await ctx.db.get(args.workspaceId);
  if (workspace === null) throw workspaceNotFound();

  const binding = await ctx.db
    .query("storageBindings")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", args.workspaceId))
    .unique();
  if (binding === null) {
    throw new ConvexError({
      code: "NO_STORAGE_BINDING",
      message: "Connect storage before choosing a folder layout.",
    });
  }
  if (binding.status !== "connected") {
    throw new ConvexError({
      code: "STORAGE_NOT_VERIFIED",
      message:
        "This context's storage has not been verified yet. Wait for the connection check to finish, or fix the error it reported.",
    });
  }
  // FINISHING SOMETHING WE STARTED IS NOT THE SAME AS SCAFFOLDING OVER
  // SOMEBODY'S VAULT, AND THIS IS THE LINE BETWEEN THEM.
  //
  // A scaffold that stopped halfway leaves real files in the bucket, so from
  // then on every detector correctly reports "this bucket holds a context" —
  // and the retry got refused with `CONTEXT_NOT_EMPTY`, telling the owner
  // nothing had been changed while their bucket sat half-written. Finishing
  // it needed a person deleting objects over S3 (issue #22).
  //
  // `scaffoldMissing` is the discriminator, and it is the only thing here
  // that could be: it is written exclusively by an attempt that got past the
  // emptiness guard, which is to say by us, into a bucket we had just
  // observed empty. A vault that was here before we arrived never gets one —
  // the guard refuses before the first `get` — so the refusal below is
  // untouched for the case it exists to protect.
  const unfinished = (binding.scaffoldMissing?.length ?? 0) > 0;
  if (binding.scaffoldReason === "existing-context" && !unfinished) {
    throw new ConvexError({
      code: "CONTEXT_NOT_EMPTY",
      message:
        "This bucket already holds a context, so there is nothing to set up. Nothing has been changed.",
    });
  }
  if (binding.scaffoldReason === "created") {
    throw new ConvexError({
      code: "STRUCTURE_ALREADY_APPLIED",
      message:
        "A starting layout has already been written to this bucket. Rename or add folders from the console.",
    });
  }

  // Validated before anything is written or persisted: these become keys in
  // somebody's own bucket, and a bad one is refused rather than repaired.
  let folders: { folder: string; description: string }[] = [];
  if (args.template === "custom") {
    const proposed = args.folders ?? [];
    if (proposed.length === 0) {
      throw new ConvexError({
        code: "INVALID_STRUCTURE",
        message: "Name at least one folder, or choose the standard layout.",
      });
    }
    const validation = validateCustomFolders(proposed);
    if (!validation.ok) {
      throw folderRejectionError(validation.reason, validation.folder);
    }
    folders = validation.folders;
  } else if (args.folders !== undefined && args.folders.length > 0) {
    // Refused rather than ignored. Silently dropping folders somebody typed
    // would have them look for folders that were never created.
    throw new ConvexError({
      code: "INVALID_STRUCTURE",
      message:
        "The standard layout has its own folders. Choose a custom layout to name your own.",
    });
  }

  // Counted before the schedule, in the same transaction: a refusal throws
  // and rolls the whole thing back, so a scaffold is never queued uncounted.
  await consumeRateLimit(ctx, {
    key: `workspace.applyStructure:${args.workspaceId}`,
    limit: APPLY_STRUCTURE_LIMIT,
    windowMs: APPLY_STRUCTURE_WINDOW_MS,
  });

  // The row records what was asked for. What actually reached the bucket is
  // recorded on the binding as `scaffoldReason`, by the job below — this
  // field is a note for the console, never an input to a later write.
  await ctx.db.patch(args.workspaceId, {
    structureTemplate: args.template,
    customFolders: args.template === "custom" ? folders : undefined,
    updatedAt: Date.now(),
  });

  await ctx.scheduler.runAfter(
    0,
    internal.functions.provisioning.verifyStorageBinding,
    {
      workspaceId: args.workspaceId,
      actorUserId: userId,
      structure: { template: args.template, folders, kind: workspace.kind },
      // Only ever true for a bucket we half-wrote ourselves. The scaffolder
      // still refuses anything it did not write, byte for byte, and still
      // `get`s every key before it `put`s it.
      resume: unfinished,
    },
  );

  await recordAudit(ctx, {
    workspaceId: args.workspaceId,
    actorUserId: userId,
    action: "workspace.structure_applied",
    // The folders go in `paths`, which is what that field is for: they are
    // bucket-relative paths, and they are about to exist as keys in the
    // owner's own bucket. The descriptions are not recorded anywhere — they
    // are prose, and prose does not belong in an audit trail.
    paths: folders.map((entry) => `${entry.folder}/README.md`),
    details: {
      template: args.template,
      folderCount: folders.length,
    },
  });

  return {
    queued: true,
    template: args.template,
    folders: folders.map((entry) => entry.folder),
  };
}
