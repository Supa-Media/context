/**
 * A picture inside a shared note, read through the link.
 *
 * Dev2 (2026-10-25): a note with pasted screenshots, shared by link, opened
 * with every picture broken. A member's console asks `readNoteImage` with the
 * note on screen; a link's reader has no membership to ask with, so this is
 * the same question asked through the share instead.
 *
 * **The note vouches for the picture, and the note is read through the link
 * first.** `readSharedNoteHandler` is called unchanged, so every rule about
 * what a link reaches (the grant, the live rows at `team`, the entry note's
 * own links, a folder's bound, a collect link's one note, sealed and encrypted
 * notes) decides here exactly as it decides for the text. Then the picture
 * must be one that text embeds outside code (`publishedImageLeaves`, the rule
 * a published page uses). So a link publishes the pictures in what it already
 * publishes and no other object in the store: one the note does not embed is
 * the same refusal as a revoked link.
 */

import { ConvexError, v } from "convex/values";
import type { ObjectType } from "convex/values";
import { getAuthUserId } from "../signedIn";
import { internal } from "../../../_generated/api";
import type { ActionCtx } from "../../../_generated/server";
import type { Id } from "../../../_generated/dataModel";
import { publishedImageLeaves } from "@context/shared";
import { anonymousSafe, shareUnavailable } from "./errors";
import { readSharedNoteHandler, shortLinkTokenFor } from "./readPath";

export const readSharedImageArgs = {
  /** The link's token, for `/s/<token>`. */
  token: v.optional(v.string()),
  /** Or the name it was claimed under, for `/@handle/slug`. */
  handle: v.optional(v.string()),
  slug: v.optional(v.string()),
  /** The note on screen, as `readSharedNote` takes it. Omit for the entry note. */
  path: v.optional(v.string()),
  /** The embed's target, as the note writes it: `paste-….png`. */
  leaf: v.string(),
};

export const readSharedImageReturns = v.object({
  bytes: v.bytes(),
  contentType: v.string(),
});

const PICTURE_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

export async function readSharedImageHandler(
  ctx: ActionCtx,
  args: ObjectType<typeof readSharedImageArgs>,
): Promise<{ bytes: ArrayBuffer; contentType: string }> {
  const actorUserId = (await getAuthUserId(ctx)) as Id<"users"> | null;
  const token =
    args.token ??
    (args.handle !== undefined && args.slug !== undefined
      ? await shortLinkTokenFor(ctx, args.handle, args.slug)
      : null);
  if (token === null) throw anonymousSafe(actorUserId, shareUnavailable());

  const pathArg = args.path === undefined ? {} : { path: args.path };
  const note = await readSharedNoteHandler(ctx, { token, ...pathArg });
  if (note.kind !== "note" || note.text === null || !publishedImageLeaves(note.text).includes(args.leaf)) {
    throw anonymousSafe(actorUserId, shareUnavailable());
  }

  // The workspace is not in what a reader is handed, so it is asked for again
  // here. The read above has just resolved this grant; one that went away in
  // between is the same refusal.
  const grant = await ctx.runQuery(internal.functions.shares.authorizeShareRead, { actorUserId, token });
  if (grant === null) throw anonymousSafe(actorUserId, shareUnavailable());

  const type = PICTURE_TYPES[args.leaf.slice(args.leaf.lastIndexOf(".") + 1).toLowerCase()];
  if (type === undefined) throw anonymousSafe(actorUserId, shareUnavailable());
  let picture;
  try {
    picture = await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: grant.workspaceId,
      scope: "team",
      operation: { kind: "readImage", leaf: args.leaf },
    });
  } catch (error) {
    const code = error instanceof ConvexError ? (error.data as { code?: string } | undefined)?.code : undefined;
    // A picture the note names that was never stored is a miss like any other.
    if (code === "FILE_NOT_FOUND" || code === "PATH_INVALID") {
      throw anonymousSafe(actorUserId, shareUnavailable());
    }
    throw error;
  }
  if (picture.kind !== "image") throw anonymousSafe(actorUserId, shareUnavailable());
  return { bytes: picture.bytes, contentType: type };
}
