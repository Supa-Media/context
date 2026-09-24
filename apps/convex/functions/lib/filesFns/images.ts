/**
 * Images in the customer's bucket: a note's pasted image and the workspace
 * icon photo. The bytes pass through the credential barrier and are never
 * written to a table.
 *
 * Handler bodies of functions `functions/files.ts` registers, moved verbatim;
 * the registrations (names, args, returns) stay there.
 */

import { WORKSPACE_ICON_CONTENT_TYPES, WORKSPACE_ICON_MAX_BYTES } from "@context/shared";
import { ConvexError } from "convex/values";
import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";
import { pasteImageLeaf, workspaceIconLeaf } from "../fileOps";
import { callerId } from "./access";
import type { OperationResult } from "./operationTypes";

/** Sixteen hex characters of SHA-256, which is what names the object. */
async function contentHash(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
}

export async function storeNoteImageHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    bytes: ArrayBuffer;
    contentType: string;
  },
): Promise<{ leaf: string }> {
  const actorUserId = await callerId(ctx);
  const { scope, grantedNames } = await ctx.runQuery(
    internal.functions.files.authorizeFileAccess,
    { actorUserId, workspaceId: args.workspaceId, minimum: "editor" },
  );
  const leaf = pasteImageLeaf({
    hash: await contentHash(args.bytes),
    contentType: args.contentType,
  });
  await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId: args.workspaceId,
    scope,
    grantedNames,
    operation: {
      kind: "writeImage",
      leaf,
      bytes: args.bytes,
      contentType: args.contentType,
    },
  });
  return { leaf };
}

export async function readNoteImageHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    notePath: string;
    leaf: string;
  },
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const actorUserId = await callerId(ctx);
  const { scope, grantedNames } = await ctx.runQuery(
    internal.functions.files.authorizeFileAccess,
    { actorUserId, workspaceId: args.workspaceId, minimum: "member" },
  );
  const note = (await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId: args.workspaceId,
    scope,
    grantedNames,
    operation: { kind: "read", path: args.notePath },
  })) as Extract<OperationResult, { kind: "file" }>;
  if (!note.text.includes(args.leaf)) {
    throw new ConvexError({
      code: "FILE_NOT_FOUND",
      message: "No note you can see references that image.",
    });
  }
  const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId: args.workspaceId,
    scope,
    grantedNames,
    operation: { kind: "readImage", leaf: args.leaf },
  })) as Extract<OperationResult, { kind: "image" }>;
  /*
    The type comes from the extension rather than from the store, because an
    adapter is not obliged to hand one back and a picture served as
    `application/octet-stream` is a download rather than an image. The leaf has
    already been through `readImage`'s own gate by this point, so the extension
    here is one of the set.
  */
  const extension = args.leaf.slice(args.leaf.lastIndexOf(".") + 1).toLowerCase();
  return {
    bytes: result.bytes,
    contentType: extension === "jpg" || extension === "jpeg" ? "image/jpeg" : `image/${extension}`,
  };
}

export async function setWorkspaceIconPhotoHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
    bytes: ArrayBuffer;
    contentType: string;
  },
): Promise<{ leaf: string }> {
  const actorUserId = await callerId(ctx);
  const { scope, grantedNames } = await ctx.runQuery(
    internal.functions.files.authorizeFileAccess,
    { actorUserId, workspaceId: args.workspaceId, minimum: "owner" },
  );
  /*
    The type is checked before the hash is taken rather than left to
    `workspaceIconLeaf`, so the refusal names the actual problem. The two
    agree because they read the same map out of `@context/shared`.
  */
  if (!WORKSPACE_ICON_CONTENT_TYPES.has(args.contentType)) {
    throw new ConvexError({
      code: "WORKSPACE_ICON_TYPE",
      message: "A workspace icon must be a PNG, JPEG or WebP.",
    });
  }
  if (args.bytes.byteLength > WORKSPACE_ICON_MAX_BYTES) {
    throw new ConvexError({
      code: "WORKSPACE_ICON_TOO_LARGE",
      message: `A workspace icon must be at most ${WORKSPACE_ICON_MAX_BYTES} bytes.`,
    });
  }
  const leaf = workspaceIconLeaf({
    hash: await contentHash(args.bytes),
    contentType: args.contentType,
  });
  await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId: args.workspaceId,
    scope,
    grantedNames,
    operation: {
      kind: "writeImage",
      leaf,
      bytes: args.bytes,
      contentType: args.contentType,
    },
  });
  await ctx.runMutation(internal.functions.workspaces.recordWorkspaceIconPhoto, {
    workspaceId: args.workspaceId,
    actorUserId,
    leaf,
  });
  return { leaf };
}

export async function workspaceIconPhotoHandler(
  ctx: ActionCtx,
  args: {
    workspaceId: Id<"workspaces">;
  },
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const actorUserId = await callerId(ctx);
  const { scope, grantedNames } = await ctx.runQuery(
    internal.functions.files.authorizeFileAccess,
    { actorUserId, workspaceId: args.workspaceId, minimum: "member" },
  );
  const leaf = await ctx.runQuery(internal.functions.workspaces.workspaceIconLeaf, {
    workspaceId: args.workspaceId,
    actorUserId,
  });
  if (leaf === null) {
    throw new ConvexError({
      code: "FILE_NOT_FOUND",
      message: "That workspace has no icon photo.",
    });
  }
  const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
    workspaceId: args.workspaceId,
    scope,
    grantedNames,
    operation: { kind: "readImage", leaf },
  })) as Extract<OperationResult, { kind: "image" }>;
  /*
    From the extension, for the reason `readNoteImage` gives: an adapter is
    not obliged to hand a type back, and a picture served as
    `application/octet-stream` is a download rather than an image. The leaf
    came off our own row and through `readImage`'s gate, so the extension here
    is one of the three.
  */
  const extension = leaf.slice(leaf.lastIndexOf(".") + 1).toLowerCase();
  return {
    bytes: result.bytes,
    contentType: extension === "jpg" ? "image/jpeg" : `image/${extension}`,
  };
}
