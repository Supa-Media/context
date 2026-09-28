/**
 * Faces: what a person is drawn with, in place of two initials.
 *
 * Dev2 (2026-09-28) disliked "SE" and "SH" everywhere people appear and asked
 * for each person's personal workspace icon first (their 🧠), and for a photo
 * they can upload themselves, since a workspace icon photo lives in their own
 * bucket and may not always be reachable. The order is: uploaded photo, then
 * personal workspace icon, then a plain silhouette the app draws.
 *
 * The visibility rule and the order live in `lib/faces/people.ts`. See
 * `docs/decisions/app-and-console/faces.md`.
 *
 * ## The workspace photo path cannot name an object
 *
 * `workspacePhoto` takes a person, never a leaf, and reads the leaf off that
 * person's personal workspace row — the same shape as `workspaceIconPhoto`,
 * for the same reason: the set of objects it can ever return is one per
 * person, chosen by that person. It reaches another person's bucket, which is
 * why the gate is repeated in the internal query rather than trusted.
 */

import { ConvexError, v } from "convex/values";
import { getAuthUserId } from "@convex-dev/auth/server";
import { WORKSPACE_ICON_CONTENT_TYPES, WORKSPACE_ICON_MAX_BYTES } from "@context/shared";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { requireAuthId } from "@supa-media/convex/auth";
import { action, internalMutation, internalQuery, mutation, query } from "../_generated/server";
import { callerId } from "./lib/filesFns/access";
import type { OperationResult } from "./lib/filesFns/operationTypes";
import { deleteAccountPhoto, facesFor, faceOf, maySeeFace, personalWorkspaceOf } from "./lib/faces/people";

const faceValidator = v.union(
  v.object({ kind: v.literal("photo"), url: v.string() }),
  v.object({ kind: v.literal("emoji"), emoji: v.string() }),
  v.object({ kind: v.literal("workspacePhoto"), leaf: v.string() }),
  v.object({ kind: v.literal("none") }),
);

/**
 * The faces of everyone the caller shares a workspace with, and their own.
 *
 * One subscription for the whole console, rather than a lookup per surface:
 * the people a viewer can meet on any page are exactly this set, and it is
 * small. Signed out, it is empty.
 */
export const myPeople = query({
  args: {},
  returns: v.object({
    me: v.union(v.null(), v.object({ person: v.string(), face: faceValidator, uploaded: v.boolean() })),
    people: v.array(v.object({ person: v.string(), handle: v.string(), face: faceValidator })),
  }),
  handler: async (ctx) => {
    const userId = (await getAuthUserId(ctx)) as Id<"users"> | null;
    if (userId === null) return { me: null, people: [] };
    const photo = await ctx.db
      .query("accountPhotos")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .unique();
    return {
      me: { person: userId, face: await faceOf(ctx, userId), uploaded: photo !== null },
      people: await facesFor(ctx, userId),
    };
  },
});

/**
 * The leaf of `person`'s personal workspace icon photo, if `actor` may see it.
 *
 * Carries its own gate: `workspacePhoto` is its only caller today, and an
 * internal query that trusts its caller is a trap for the second one.
 */
export const workspacePhotoSource = internalQuery({
  args: { actorUserId: v.id("users"), person: v.id("users") },
  returns: v.union(v.null(), v.object({ workspaceId: v.id("workspaces"), leaf: v.string() })),
  handler: async (ctx, args) => {
    if (!(await maySeeFace(ctx, args.actorUserId, args.person))) return null;
    const workspace = await personalWorkspaceOf(ctx, args.person);
    if (workspace === null || workspace.icon?.kind !== "photo") return null;
    return { workspaceId: workspace._id, leaf: workspace.icon.leaf };
  },
});

/**
 * Read a person's personal workspace icon photo, for drawing their face.
 *
 * Every absence is the same `FILE_NOT_FOUND`: a stranger, a person with no
 * photo, and an id that names nobody, so this cannot tell anyone which is
 * which. The app draws a silhouette for all three.
 */
export const workspacePhoto = action({
  args: { person: v.string() },
  returns: v.object({ bytes: v.bytes(), contentType: v.string() }),
  handler: async (ctx, args): Promise<{ bytes: ArrayBuffer; contentType: string }> => {
    const actorUserId = await callerId(ctx);
    let source: { workspaceId: Id<"workspaces">; leaf: string } | null = null;
    try {
      source = await ctx.runQuery(internal.functions.faces.workspacePhotoSource, {
        actorUserId,
        person: args.person as Id<"users">,
      });
    } catch {
      // A string that is not a user id: the same absence as a stranger.
      source = null;
    }
    if (source === null) {
      throw new ConvexError({ code: "FILE_NOT_FOUND", message: "That person has no photo." });
    }
    /*
      `team` with no names is the narrowest clearance there is, and it does not
      matter here: `readImage` reads one leaf and consults no note. The leaf
      came off the owner's own row above, so nothing the caller sent chose it.
    */
    const result = (await ctx.runAction(internal.functions.files.runFileOperation, {
      workspaceId: source.workspaceId,
      scope: "team",
      grantedNames: [],
      operation: { kind: "readImage", leaf: source.leaf },
    })) as Extract<OperationResult, { kind: "image" }>;
    const extension = source.leaf.slice(source.leaf.lastIndexOf(".") + 1).toLowerCase();
    return { bytes: result.bytes, contentType: extension === "jpg" ? "image/jpeg" : `image/${extension}` };
  },
});

/**
 * Upload the caller's own photo. Replaces any earlier one, whose object is
 * deleted in the same step.
 *
 * Checked before anything is stored, so a refused photo leaves no object
 * behind: the same types and size cap as a workspace icon, from the same
 * constants.
 */
export const setMyPhoto = action({
  args: { bytes: v.bytes(), contentType: v.string() },
  returns: v.null(),
  handler: async (ctx, args): Promise<null> => {
    const userId = await callerId(ctx);
    if (!WORKSPACE_ICON_CONTENT_TYPES.has(args.contentType)) {
      throw new ConvexError({ code: "PHOTO_TYPE", message: "A photo must be a PNG, JPEG or WebP." });
    }
    if (args.bytes.byteLength > WORKSPACE_ICON_MAX_BYTES) {
      throw new ConvexError({
        code: "PHOTO_TOO_LARGE",
        message: "That photo is too large. Try a smaller one.",
      });
    }
    const storageId = await ctx.storage.store(new Blob([args.bytes], { type: args.contentType }));
    await ctx.runMutation(internal.functions.faces.recordMyPhoto, { userId, storageId });
    return null;
  },
});

export const recordMyPhoto = internalMutation({
  args: { userId: v.id("users"), storageId: v.id("_storage") },
  returns: v.null(),
  handler: async (ctx, args) => {
    const existing = await ctx.db
      .query("accountPhotos")
      .withIndex("by_user", (q) => q.eq("userId", args.userId))
      .unique();
    if (existing === null) {
      await ctx.db.insert("accountPhotos", {
        userId: args.userId,
        storageId: args.storageId,
        updatedAt: Date.now(),
      });
      return null;
    }
    const previous = existing.storageId;
    await ctx.db.patch(existing._id, { storageId: args.storageId, updatedAt: Date.now() });
    if (previous !== args.storageId) await ctx.storage.delete(previous);
    return null;
  },
});

/** Remove the caller's photo, so their workspace icon shows again. */
export const clearMyPhoto = mutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const userId = (await requireAuthId(ctx)) as Id<"users">;
    await deleteAccountPhoto(ctx, userId);
    return null;
  },
});
