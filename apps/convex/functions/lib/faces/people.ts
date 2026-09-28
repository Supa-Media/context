import type { Doc, Id } from "../../../_generated/dataModel";
import type { MutationCtx, QueryCtx } from "../../../_generated/server";
import { handleForUser } from "../identities";

/**
 * Who a person may see the face of, and what that face is.
 *
 * A face is drawn wherever a person is: an owner column, the row of people on
 * a note, a typing flag, a comment. Every one of those names somebody the
 * viewer already works with, so the rule is the same everywhere and it is
 * narrow: **you see the faces of people you share a workspace with, and your
 * own**. A stranger's handle resolves to nothing, identical to a handle nobody
 * holds, so this cannot be used to learn who has an account.
 *
 * The order is Dev2's (2026-09-28): a photo the person uploaded, then their
 * personal workspace's icon, then nothing (the app draws a silhouette). Never
 * letters.
 */

/** Workspaces one person is read for, at most. */
export const MAX_FACE_MEMBERSHIPS = 200;
/** Members read per workspace, at most. */
export const MAX_FACE_MEMBERS = 500;
/** People one answer names, at most. */
export const MAX_FACE_PEOPLE = 200;

export type Face =
  | { kind: "photo"; url: string }
  | { kind: "emoji"; emoji: string }
  /** The personal workspace's icon photo, which lives in that bucket. */
  | { kind: "workspacePhoto"; leaf: string }
  | { kind: "none" };

/** The personal workspace a person owns, or null. */
export async function personalWorkspaceOf(
  ctx: QueryCtx,
  userId: Id<"users">,
): Promise<Doc<"workspaces"> | null> {
  const memberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(MAX_FACE_MEMBERSHIPS);
  for (const membership of memberships) {
    if (membership.role !== "owner") continue;
    const workspace = await ctx.db.get(membership.workspaceId);
    if (workspace !== null && workspace.kind === "personal") return workspace;
  }
  return null;
}

/** What one person is drawn with. */
export async function faceOf(ctx: QueryCtx, userId: Id<"users">): Promise<Face> {
  const photo = await ctx.db
    .query("accountPhotos")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  if (photo !== null) {
    const url = await ctx.storage.getUrl(photo.storageId);
    if (url !== null) return { kind: "photo", url };
  }
  const personal = await personalWorkspaceOf(ctx, userId);
  const icon = personal?.icon;
  if (icon?.kind === "emoji") return { kind: "emoji", emoji: icon.emoji };
  if (icon?.kind === "photo") return { kind: "workspacePhoto", leaf: icon.leaf };
  return { kind: "none" };
}

/**
 * Everybody who shares a workspace with `viewer`, the viewer included.
 *
 * Bounded three ways, so a person in a very large workspace gets a partial
 * set of faces (the rest draw a silhouette) rather than a query that fails.
 */
export async function peopleSharingWith(
  ctx: QueryCtx,
  viewer: Id<"users">,
): Promise<Id<"users">[]> {
  const people = new Set<Id<"users">>([viewer]);
  const memberships = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_user", (q) => q.eq("userId", viewer))
    .take(MAX_FACE_MEMBERSHIPS);
  for (const membership of memberships) {
    const members = await ctx.db
      .query("workspaceMembers")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", membership.workspaceId))
      .take(MAX_FACE_MEMBERS);
    for (const member of members) {
      if (people.size >= MAX_FACE_PEOPLE) return [...people];
      people.add(member.userId);
    }
  }
  return [...people];
}

/** Whether `viewer` may see `person`'s face: themselves, or a shared workspace. */
export async function maySeeFace(
  ctx: QueryCtx,
  viewer: Id<"users">,
  person: Id<"users">,
): Promise<boolean> {
  if (viewer === person) return true;
  const theirs = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_user", (q) => q.eq("userId", person))
    .take(MAX_FACE_MEMBERSHIPS);
  const ids = new Set(theirs.map((row) => row.workspaceId));
  const mine = await ctx.db
    .query("workspaceMembers")
    .withIndex("by_user", (q) => q.eq("userId", viewer))
    .take(MAX_FACE_MEMBERSHIPS);
  return mine.some((row) => ids.has(row.workspaceId));
}

export interface PersonFace {
  /** Opaque: passed back to `faces.workspacePhoto`, never shown. */
  person: string;
  /** "@seyi": how every surface names people, so how faces are looked up. */
  handle: string;
  face: Face;
}

/** Faces of everyone `viewer` works with. People with no handle are skipped. */
export async function facesFor(ctx: QueryCtx, viewer: Id<"users">): Promise<PersonFace[]> {
  const out: PersonFace[] = [];
  for (const userId of await peopleSharingWith(ctx, viewer)) {
    const handle = await handleForUser(ctx, userId);
    if (handle === null) continue;
    out.push({ person: userId, handle: `@${handle}`, face: await faceOf(ctx, userId) });
  }
  return out;
}

/**
 * Remove a person's uploaded photo and its object. Called when they clear it
 * and when their account is deleted: a face must not outlive its person.
 */
export async function deleteAccountPhoto(ctx: MutationCtx, userId: Id<"users">): Promise<void> {
  const row = await ctx.db
    .query("accountPhotos")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .unique();
  if (row === null) return;
  await ctx.db.delete(row._id);
  await ctx.storage.delete(row.storageId);
}
