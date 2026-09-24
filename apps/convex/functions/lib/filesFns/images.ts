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

/**
 * Store an image somebody pasted into a note.
 *
 * **Editor or owner**, because this writes to the bucket; `member` is read
 * access and a paste is not a read. Nothing about the note is consulted: the
 * caller may already write every note in this context, so gating the *image* on
 * one particular note would be a check that refuses nothing and implies a
 * guarantee this does not make.
 *
 * The name is ours to choose and not the caller's, which is the security half:
 * a client-supplied leaf is a path to argue about, and this one is derived from
 * the bytes. `writeImage` still applies the gateway's own leaf rule to whatever
 * comes out, so a careless change to the derivation is refused rather than
 * writing a key `read_image` could never name.
 */
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

/**
 * Read a pasted image back, for a note that references it.
 *
 * **The reference is the gate, and it is the gateway's own.** An image has no
 * visibility of its own — it borrows the visibility of the notes that point at
 * it — so the question this asks is the question `read_image` asks: is there a
 * note *this caller can see* that names this file? The note is read through the
 * same `read` operation the editor uses, so `canSee` and `privacy.md` answer
 * exactly once, in the place they already answer for note text.
 *
 * A caller who can see no such note gets `FILE_NOT_FOUND` — the same error as
 * for an image that was never written, so this cannot be used to learn that one
 * exists. A `member` therefore cannot pull an image out of a private note by
 * naming its leaf, which is the isolation case worth a test rather than a
 * comment.
 *
 * Deliberately broad about what "references" means: any mention of the leaf
 * anywhere in the note. These notes are edited in Obsidian, in rclone and by
 * hand, and the failure mode of a strict rule ("must be a markdown embed") is an
 * image that silently stops loading in the app after somebody reformatted a
 * line.
 */
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

/**
 * Store the photo a workspace draws in its mark.
 *
 * **Owner**, not editor. `storeNoteImage` takes an editor because a paste is a
 * write to the bucket and an editor may write to the bucket. This is a write to
 * the bucket *and* a change to what the workspace looks like on every member's
 * screen, so it takes the role that owns the other facts about the workspace —
 * its name, its storage, its members. The stricter of the two checks wins.
 *
 * The name is ours and derived from the bytes, for the reason `storeNoteImage`
 * gives: a client-supplied leaf is a path to argue about. `writeImage` then
 * applies the gateway's own leaf rule to whatever `workspaceIconLeaf` produced,
 * so a careless change to the derivation is refused here rather than writing an
 * object no reader can ever name.
 *
 * ## The cap is this feature's, and it is much smaller than the store's
 *
 * `writeImage` allows five megabytes, which is right for a picture somebody
 * wants to look at and wrong for an 18pt square the console draws once per
 * workspace per paint. `WORKSPACE_ICON_MAX_BYTES` is checked here, before the
 * bytes reach the bucket, so a caller that is not our picker cannot make every
 * future context list a download. The picker crops square and compresses long
 * before this, and this is the backstop for everything that is not the picker.
 *
 * The row is patched only after the write lands, by
 * `recordWorkspaceIconPhoto` — so a failed upload leaves the old icon standing
 * rather than pointing the workspace at an object that is not there.
 */
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

/**
 * Read a workspace's icon photo back.
 *
 * **Note what this does not take: a leaf.** `readNoteImage` takes one and gates
 * it on a note the caller can see that references it, because an image in the
 * opaque store borrows its visibility from the notes pointing at it. An icon
 * has no note, and the wrong way to serve one is to loosen that gate.
 *
 * So the caller names a *workspace* and the leaf is read off the row by
 * `workspaceIconLeaf`, which is an internal query with its own membership
 * check. There is no argument here through which an object can be named, which
 * makes this strictly narrower than the note path rather than wider: the set of
 * objects it can return is at most one per workspace, chosen by that
 * workspace's owner. A test asserts the argument shape, because "there is no
 * leaf argument" is the property doing the work and a later convenience
 * parameter would quietly end it.
 *
 * `member` is the floor and it is honest: this picture is drawn in the rail of
 * everyone who can reach the workspace. A non-member gets the same
 * `WORKSPACE_NOT_FOUND` as for an id that never existed, so this cannot be used
 * to learn that a workspace exists.
 *
 * A workspace with no icon, or with an emoji, gets `FILE_NOT_FOUND` — the same
 * absence as a photo that was never written, which is what the console draws a
 * letter for anyway.
 */
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
