/**
 * Saving a note from the console, and taking a note's encryption off.
 *
 * Handler bodies of functions `functions/files.ts` registers, moved verbatim;
 * the registrations (names, args, returns) stay there.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { callerId } from "./access";
import type { OperationResult } from "./operationTypes";

export async function writeNoteHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    path: string;
    text: string;
    expectedEtag?: string;
  },
): Promise<Extract<OperationResult, { kind: "written" }>> {
  const actorUserId = await callerId(ctx);
  const { scope, grantedNames, actorName } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId: args.workspaceId,
    minimum: "editor",
  });
  const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId: args.workspaceId,
    scope,
    grantedNames,
    actorName,
    operation: {
      kind: "write",
      path: args.path,
      text: args.text,
      expectedEtag: args.expectedEtag,
    },
  })) as Extract<OperationResult, { kind: "written" }>;

  // Paths and an outcome. Never the text — the schema's flat-scalar `details`
  // makes an accidental `{ body }` impossible, and this is the deliberate
  // half of that rule.
  await ctx.runMutation(internal.functions.audit.recordEvent, {
    workspaceId: args.workspaceId,
    actorUserId,
    action: args.expectedEtag === undefined ? "file.create" : "file.write",
    paths: [result.path],
    details: { conflictCheck: result.conflictCheck },
  });
  return result;
}

export async function removeNoteEncryptionHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    path: string;
    text: string;
    expectedEtag?: string;
  },
): Promise<Extract<OperationResult, { kind: "written" }>> {
  const actorUserId = await callerId(ctx);
  const { scope, grantedNames } = await ctx.runQuery(internal.functions.files.authorizeFileAccess, {
    actorUserId,
    workspaceId: args.workspaceId,
    minimum: "editor",
  });
  const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId: args.workspaceId,
    scope,
    grantedNames,
    operation: {
      kind: "removeEncryption",
      path: args.path,
      text: args.text,
      expectedEtag: args.expectedEtag,
    },
  })) as Extract<OperationResult, { kind: "written" }>;

  // Paths and an outcome. Never the text, same as every other write here.
  await ctx.runMutation(internal.functions.audit.recordEvent, {
    workspaceId: args.workspaceId,
    actorUserId,
    action: "file.decrypt",
    paths: [result.path],
    details: { conflictCheck: result.conflictCheck },
  });
  return result;
}
