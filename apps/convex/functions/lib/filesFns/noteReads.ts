/**
 * Reading a context from the console: a folder listing, one note, a page of
 * the offline mirror's manifest, a batch of notes, and the activity file. Any
 * member may call these, and sees what their clearance allows.
 *
 * Handler bodies of functions `functions/files.ts` registers, moved verbatim;
 * the registrations (names, args, returns) stay there.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import type { ActivityEntry } from "../activity";
import { FileOpError, READ_BATCH_PATHS } from "../fileOps";
import { callerId } from "./access";
import { toConvexError } from "./operationErrors";
import type { OperationResult } from "./operationTypes";

export async function listFilesHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    path: string;
  },
): Promise<Extract<OperationResult, { kind: "listing" }>> {
  const actorUserId = await callerId(ctx);
  const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId: args.workspaceId,
    minimum: "member",
  });
  const result = await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId: args.workspaceId,
    scope,
    grantedNames,
    operation: { kind: "list", path: args.path },
  });
  return result as Extract<OperationResult, { kind: "listing" }>;
}

export async function readNoteHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    path: string;
  },
): Promise<Extract<OperationResult, { kind: "file" }>> {
  const actorUserId = await callerId(ctx);
  const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId: args.workspaceId,
    minimum: "member",
  });
  const result = await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId: args.workspaceId,
    scope,
    grantedNames,
    /*
      A link into the console outlives the path it names. Somebody pastes
      `?note=2-areas/apps/x.md` into a thread, the folder is renamed to
      `5-areas`, and the address in the thread is the only copy of it left —
      no rewrite reaches a chat message. `onMiss` follows the bucket's
      forwarding ledger once the live path has already missed, so a note
      that exists where it says wins, and only a dead address is forwarded.
    */
    operation: { kind: "read", path: args.path, forward: "onMiss" },
  });
  return result as Extract<OperationResult, { kind: "file" }>;
}

export async function syncManifestHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    cursor?: string;
  },
): Promise<Extract<OperationResult, { kind: "manifest" }>> {
  const actorUserId = await callerId(ctx);
  const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId: args.workspaceId,
    minimum: "member",
  });
  const result = await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId: args.workspaceId,
    scope,
    grantedNames,
    operation: {
      kind: "manifest",
      ...(args.cursor === undefined ? {} : { cursor: args.cursor }),
    },
  });
  return result as Extract<OperationResult, { kind: "manifest" }>;
}

export async function readNotesHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    paths: string[];
  },
): Promise<Extract<OperationResult, { kind: "notes" }>> {
  const actorUserId = await callerId(ctx);
  const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId: args.workspaceId,
    minimum: "member",
  });
  // Refused before the barrier rather than inside it, so a request that can
  // never succeed does not open the bucket's credential to find that out.
  // `readFiles` refuses it again, for any other caller.
  if (args.paths.length > READ_BATCH_PATHS) {
    throw toConvexError(
      new FileOpError("BATCH_TOO_LARGE", `Read at most ${READ_BATCH_PATHS} notes at a time.`),
    );
  }
  const result = await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId: args.workspaceId,
    scope,
    grantedNames,
    operation: { kind: "readMany", paths: args.paths },
  });
  return result as Extract<OperationResult, { kind: "notes" }>;
}

export async function listActivityHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    limit?: number;
  },
): Promise<ActivityEntry[]> {
  const actorUserId: Id<"users"> = await callerId(ctx);
  const { scope, grantedNames } = await ctx.runQuery(
    internal.functions.files.authorizeFileAccess,
    { actorUserId, workspaceId: args.workspaceId, minimum: "member" },
  );
  const result = await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId: args.workspaceId,
    scope,
    grantedNames,
    operation: { kind: "readActivity" },
  });
  if (result.kind !== "activity") return [];
  const limit = Math.max(1, Math.min(args.limit ?? 50, 400));
  return result.entries.slice(0, limit);
}
