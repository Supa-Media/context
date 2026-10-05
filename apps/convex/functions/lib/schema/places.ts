import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * The places one person keeps going back to in one workspace: what they pinned
 * to Home, how often they open each folder, and the notes they were in last.
 *
 * Paths and counts, never note text: the same kind of metadata `noteShares`
 * already holds. Every table here is private to the person who wrote them — no
 * function reads another person's rows — and are deleted with the account
 * (`personalRows.ts`), with the workspace (`finalizeWorkspaceDeletion.ts`) and
 * when the person leaves or is removed (`workspaces/members.ts`). Decided by
 * the owner, 2026-09-30: the phone's Home shows the same Pinned and "You open
 * most" on every device, so they live on the account rather than the device.
 *
 * A path here is a pointer, not a grant. Every reader intersects it with the
 * tree the person can see now, so a note that moved out of reach, or a folder
 * made private since, simply stops showing.
 */
export const placeTables = {
  placePins: defineTable({
    userId: v.id("users"),
    workspaceId: v.id("workspaces"),
    path: v.string(),
    kind: v.union(v.literal("note"), v.literal("folder")),
    /** Position on Home, lowest first. Gaps are fine; ties fall back to `pinnedAt`. */
    order: v.number(),
    pinnedAt: v.number(),
  })
    .index("by_user_workspace", ["userId", "workspaceId"])
    .index("by_workspace_path", ["workspaceId", "path"])
    .index("by_user", ["userId"]),

  placeOpens: defineTable({
    userId: v.id("users"),
    workspaceId: v.id("workspaces"),
    /** A folder path. Opening a note counts for the folder it is in. */
    path: v.string(),
    /** Opens per UTC day, newest last, never older than the window. */
    days: v.array(v.object({ day: v.number(), n: v.number() })),
    lastAt: v.number(),
  })
    .index("by_user_workspace", ["userId", "workspaceId"])
    .index("by_user_workspace_path", ["userId", "workspaceId", "path"])
    .index("by_workspace_path", ["workspaceId", "path"])
    .index("by_user", ["userId"]),

  /**
   * The notes this person opened or edited lately, for the phone's Recent
   * (owner, 2026-10-05: Recent "doesn't actually show the notes that I've
   * personally recently opened/edited" — it listed whatever anybody in the
   * workspace changed last). One row per note, its latest open or edit.
   */
  placeRecents: defineTable({
    userId: v.id("users"),
    workspaceId: v.id("workspaces"),
    /** A note path. */
    path: v.string(),
    at: v.number(),
  })
    .index("by_user_workspace", ["userId", "workspaceId"])
    .index("by_user_workspace_path", ["userId", "workspaceId", "path"])
    .index("by_workspace_path", ["workspaceId", "path"])
    .index("by_user", ["userId"]),
};
