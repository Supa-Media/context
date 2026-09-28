import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * The photo a person chose to be drawn with, when they uploaded one.
 *
 * ## Why this picture is ours to keep and a workspace icon is not
 *
 * A workspace's icon photo lives in that workspace's bucket, because a picture
 * somebody put in their context is content and the control plane never holds
 * content (`CLAUDE.md` #1). This one is different in kind: it is a fact about
 * the *account*, like its name, and it exists to be shown to other people. It
 * is not in any context, so leaving with a context loses nothing, and keeping
 * it here is what lets it show while the person's own bucket is offline,
 * unverified or disconnected — which is why it exists at all (Dev2,
 * 2026-09-28: "because things might be hosted on their own storage").
 *
 * One row per person, deleted with the account (`personalRows.ts`), and the
 * object in file storage is deleted whenever the row stops pointing at it.
 * See `docs/decisions/app-and-console/faces.md`.
 */
export const faceTables = {
  accountPhotos: defineTable({
    userId: v.id("users"),
    storageId: v.id("_storage"),
    updatedAt: v.number(),
  }).index("by_user", ["userId"]),
};
