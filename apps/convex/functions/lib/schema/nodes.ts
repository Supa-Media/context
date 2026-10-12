import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * The workspace's file tree, in the control plane (decided by the owner,
 * 2026-10-12: "a move to Convex to have a better overall experience").
 *
 * One row per file or folder the bucket holds — names, versions and sizes,
 * **never note text** — plus each workspace's privacy rules, parsed. The
 * bucket stays canonical: these rows are rebuilt from a listing of it
 * (`lib/nodes/sweep.ts`) and kept current by re-checking what each change
 * touched (`lib/nodes/touch.ts`). Phase 1 of the migration is a **shadow**:
 * nothing reads these rows to answer a person yet; a parity check holds the
 * tree they describe equal to the bucket's at every clearance
 * (`lib/nodes/parity.ts`). See `docs/decisions/app-and-console/convex-tree.md`.
 *
 * Who may see a row is never stored on it. It is decided when served, by the
 * same `canSee` over the workspace's rules that every listing applies.
 *
 * One slice of the control-plane schema, spread into `defineSchema` by
 * `apps/convex/schema.ts`.
 */
export const nodeTables = {
  /**
   * One file or folder.
   *
   * `path` is the bucket key as the bucket spells it (`1-projects/a.md`; a
   * folder has no trailing slash). `parentId`/`name` are the same fact as a
   * tree, so a folder's children are one indexed read. Top-level dot folders
   * (`.context/`, `.obsidian/`) are never rows, as in the tree table.
   * A folder marker key (`a/`, what an S3 console writes for an empty folder)
   * is its own `file` row named `""` under the folder it marks (`nodeKey`).
   *
   * **Last observation wins.** `observedAt` is when the bucket was seen to
   * hold this row as it is; an observation older than it never overwrites it.
   * `goneAt` marks a key seen gone: a tombstone a slower listing that saw it
   * a moment before it left cannot undo. Tombstones are removed by the next
   * finished sweep that started after them.
   */
  nodes: defineTable({
    workspaceId: v.id("workspaces"),
    path: v.string(),
    parentId: v.optional(v.id("nodes")),
    name: v.string(),
    kind: v.union(v.literal("file"), v.literal("folder")),
    etag: v.optional(v.string()),
    size: v.optional(v.number()),
    uploaded: v.optional(v.number()),
    observedAt: v.number(),
    goneAt: v.optional(v.number()),
  })
    .index("by_workspace_path", ["workspaceId", "path"])
    .index("by_parent_name", ["workspaceId", "parentId", "name"])
    .index("by_workspace_observed", ["workspaceId", "observedAt"]),

  /**
   * One workspace's tree bookkeeping: how far a sweep has got, and whether the
   * rows can be trusted. Counts and times, never a path — except `cursor`,
   * the last key a running sweep listed, which is read only by the sweep.
   */
  nodeTrees: defineTable({
    workspaceId: v.id("workspaces"),
    status: v.union(
      v.literal("empty"),
      v.literal("filling"),
      v.literal("ready"),
      v.literal("unsupported"),
    ),
    /** Set while a sweep runs: the last key it listed, `""` before the first. */
    cursor: v.optional(v.string()),
    /** When the running sweep began; rows observed before it and not since are gone. */
    startedAt: v.optional(v.number()),
    /** A pass that ran this recently holds the sweep. */
    leaseAt: v.optional(v.number()),
    sweptAt: v.optional(v.number()),
    /** A change too big to re-check asked for a sweep. */
    dirty: v.boolean(),
    /** Live file rows after the last finished sweep. */
    files: v.number(),
    /** A fixed, path-free label for a failing pass (never a raw storage error). */
    error: v.optional(v.string()),
    /** The last parity check: how many paths disagreed with the bucket, over every clearance checked. */
    parity: v.optional(
      v.object({
        checkedAt: v.number(),
        clearances: v.number(),
        mismatches: v.number(),
        privacyMatches: v.boolean(),
      }),
    ),
  }).index("by_workspace", ["workspaceId"]),

  /**
   * One workspace's privacy rules, parsed from the `privacy.md` the bucket
   * holds (`etag`). Rules only: the prose around the managed block is note
   * text and is not kept. In phase 1 this is a mirror the parity check
   * compares; phase 3 makes it the authority and writes `privacy.md` from it.
   */
  nodePrivacy: defineTable({
    workspaceId: v.id("workspaces"),
    /** The `privacy.md` version these rules were read from; absent when there is none. */
    etag: v.optional(v.string()),
    /** Set when the file exists but its managed block does not parse. */
    invalid: v.boolean(),
    folders: v.array(v.object({ prefix: v.string(), visibility: v.string() })),
    notes: v.array(v.object({ path: v.string(), visibility: v.string() })),
    observedAt: v.number(),
  }).index("by_workspace", ["workspaceId"]),

  /**
   * The migration's one switch, a single row (absent means running). Staff
   * pause it from admin › Search › Indexes; while paused nothing new starts,
   * changes only mark trees dirty, and a running sweep stops at its next pass.
   */
  nodeMigration: defineTable({
    paused: v.boolean(),
    updatedAt: v.number(),
    updatedBy: v.optional(v.id("users")),
  }),
};
