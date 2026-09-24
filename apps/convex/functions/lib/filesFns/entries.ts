/**
 * Creating, moving, copying, archiving, trashing and deleting files and
 * folders from the console.
 *
 * Handler bodies of functions `functions/files.ts` registers, moved verbatim;
 * the registrations (names, args, returns) stay there. Each one authorizes
 * through `authorizeFileAccess` before it reaches the credential barrier
 * `runFileOperation`, and records its audit event after.
 */

import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { callerId } from "./access";
import type { OperationResult } from "./operationTypes";

export async function createDirectoryHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    path: string;
  },
): Promise<Extract<OperationResult, { kind: "folderCreated" }>> {
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
    operation: { kind: "createFolder", path: args.path },
  })) as Extract<OperationResult, { kind: "folderCreated" }>;

  await ctx.runMutation(internal.functions.audit.recordEvent, {
    workspaceId: args.workspaceId,
    actorUserId,
    action: "folder.create",
    paths: [result.path],
  });
  return result;
}

export async function moveEntryHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    from: string;
    to: string;
    expectedEtag?: string;
  },
): Promise<Extract<OperationResult, { kind: "moved" }>> {
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
      kind: "move",
      from: args.from,
      to: args.to,
      ...(args.expectedEtag === undefined ? {} : { expectedEtag: args.expectedEtag }),
    },
  })) as Extract<OperationResult, { kind: "moved" }>;

  await ctx.runMutation(internal.functions.audit.recordEvent, {
    workspaceId: args.workspaceId,
    actorUserId,
    action: "file.move",
    paths: [result.from, result.to],
    details: { files: result.paths.length },
  });
  return result;
}

export async function copyEntryHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    from: string;
    to: string;
  },
): Promise<Extract<OperationResult, { kind: "moved" }>> {
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
    operation: { kind: "copy", from: args.from, to: args.to },
  })) as Extract<OperationResult, { kind: "moved" }>;

  await ctx.runMutation(internal.functions.audit.recordEvent, {
    workspaceId: args.workspaceId,
    actorUserId,
    action: "file.copy",
    paths: [result.from, result.to],
    details: { files: result.paths.length },
  });
  return result;
}

export async function duplicateEntryHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    path: string;
  },
): Promise<Extract<OperationResult, { kind: "moved" }>> {
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
    operation: { kind: "duplicate", path: args.path },
  })) as Extract<OperationResult, { kind: "moved" }>;

  await ctx.runMutation(internal.functions.audit.recordEvent, {
    workspaceId: args.workspaceId,
    actorUserId,
    action: "file.duplicate",
    paths: [result.from, result.to],
    details: { files: result.paths.length },
  });
  return result;
}

export async function archiveEntryHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    path: string;
    expectedEtag?: string;
  },
): Promise<Extract<OperationResult, { kind: "moved" }>> {
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
      kind: "archive",
      path: args.path,
      ...(args.expectedEtag === undefined ? {} : { expectedEtag: args.expectedEtag }),
    },
  })) as Extract<OperationResult, { kind: "moved" }>;

  await ctx.runMutation(internal.functions.audit.recordEvent, {
    workspaceId: args.workspaceId,
    actorUserId,
    action: "file.archive",
    paths: [result.from, result.to],
    details: { files: result.paths.length, recoverable: true },
  });
  return result;
}

export async function trashEntryHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    path: string;
    expectedEtag?: string;
  },
): Promise<Extract<OperationResult, { kind: "moved" }>> {
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
      kind: "trash",
      path: args.path,
      ...(args.expectedEtag === undefined ? {} : { expectedEtag: args.expectedEtag }),
    },
  })) as Extract<OperationResult, { kind: "moved" }>;
  await ctx.runMutation(internal.functions.audit.recordEvent, {
    workspaceId: args.workspaceId,
    actorUserId,
    action: "file.archive",
    paths: [result.from, result.to],
    details: { files: result.paths.length, recoverable: true, trash: true },
  });
  return result;
}

export async function restoreTrashEntryHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    from: string;
    to: string;
  },
): Promise<Extract<OperationResult, { kind: "moved" }>> {
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
    operation: { kind: "restoreTrash", from: args.from, to: args.to },
  })) as Extract<OperationResult, { kind: "moved" }>;
  await ctx.runMutation(internal.functions.audit.recordEvent, {
    workspaceId: args.workspaceId,
    actorUserId,
    action: "file.move",
    paths: [result.from, result.to],
    details: { files: result.paths.length, restoredFromTrash: true },
  });
  return result;
}

export async function deleteEntryHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    path: string;
    confirmation: string;
  },
): Promise<Extract<OperationResult, { kind: "deleted" }>> {
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
      kind: "delete",
      path: args.path,
      confirmation: args.confirmation,
    },
  })) as Extract<OperationResult, { kind: "deleted" }>;

  await ctx.runMutation(internal.functions.audit.recordEvent, {
    workspaceId: args.workspaceId,
    actorUserId,
    action: "file.delete",
    paths: result.paths,
    details: { recoverable: false },
  });
  return result;
}
