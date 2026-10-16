import { defineTable } from "convex/server";
import { v } from "convex/values";

/**
 * Who may see a tree row beyond its folder's default, as rows (phase 1 of
 * `docs/decisions/app-and-console/convex-tree.md`). Inert until PR 2: nothing
 * reads these to answer a person; `lib/nodes/accessBackfill.ts` derives them
 * from the workspace's privacy rules, and a share adds rows of its own.
 *
 * A row's base is `nodes.access` (`private` or `team`); its grants are the
 * rows here. Grantees are flattened (`granteeKind` plus one id field) because
 * a nested object cannot be indexed safely.
 */
export const nodeAccessTables = {
  /**
   * One grant on one tree row: a group, a person, or an email awaiting an
   * account, at `view` or `edit`.
   *
   * `source` says who wrote it. `privacy.md` rows are derived from the rules
   * and replaced whole on every derivation; `share` rows are an owner's
   * explicit grant and are never touched by one.
   */
  nodeAccess: defineTable({
    workspaceId: v.id("workspaces"),
    nodeId: v.id("nodes"),
    granteeKind: v.union(v.literal("user"), v.literal("group"), v.literal("email")),
    granteeUserId: v.optional(v.id("users")),
    granteeGroupId: v.optional(v.id("workspaceGroups")),
    granteeEmail: v.optional(v.string()),
    role: v.union(v.literal("view"), v.literal("edit")),
    grantedBy: v.optional(v.id("users")),
    at: v.number(),
    source: v.union(v.literal("privacy.md"), v.literal("share"), v.literal("owner")),
  })
    .index("by_node", ["nodeId"])
    .index("by_workspace", ["workspaceId"])
    .index("by_workspace_user", ["workspaceId", "granteeUserId"])
    .index("by_workspace_group", ["workspaceId", "granteeGroupId"])
    .index("by_workspace_email", ["workspaceId", "granteeEmail"]),

  /**
   * One workspace's access derivation: the version of its rows (bumped by
   * every finished derivation), the `privacy.md` version they came from, and
   * what the rules name that nothing could resolve. Paths and handles only,
   * never note text.
   */
  nodeAccessState: defineTable({
    workspaceId: v.id("workspaces"),
    version: v.number(),
    migratedFromEtag: v.optional(v.string()),
    migratedAt: v.optional(v.number()),
    orphans: v.array(
      v.object({
        kind: v.union(v.literal("override"), v.literal("unresolved"), v.literal("folder")),
        path: v.string(),
        handle: v.optional(v.string()),
        visibility: v.optional(v.string()),
      }),
    ),
    /**
     * Every row that carries a setting or a grant, as `accessRowsOf` reads
     * them, rebuilt by each finished derivation. Absent while a derivation is
     * walking (the readers scan the rows then) and whenever the set is too
     * large for one document (`accessBackfill.ts`, `SNAPSHOT_MAX_ROWS`).
     */
    snapshot: v.optional(
      v.array(
        v.object({
          path: v.string(),
          noteId: v.string(),
          kind: v.union(v.literal("file"), v.literal("folder")),
          base: v.optional(v.union(v.literal("private"), v.literal("team"))),
          grantees: v.array(
            v.object({
              kind: v.union(v.literal("user"), v.literal("group"), v.literal("email")),
              id: v.string(),
              role: v.union(v.literal("view"), v.literal("edit")),
            }),
          ),
        }),
      ),
    ),
  }).index("by_workspace", ["workspaceId"]),

  /**
   * Staff's last parity check of one workspace's access rows against its rules
   * (`lib/nodes/accessParity.ts`), run by `privacyRows.checkPage`. Counts and
   * the first few differences as path and clearance only, never note text.
   * `version` is the derivation version the check ran against; a check is
   * current only while `nodeAccessState.version` still equals it.
   */
  privacyRowChecks: defineTable({
    workspaceId: v.id("workspaces"),
    runId: v.number(),
    status: v.union(v.literal("running"), v.literal("done")),
    version: v.number(),
    startedAt: v.number(),
    checkedAt: v.optional(v.number()),
    checked: v.number(),
    differences: v.number(),
    sample: v.array(v.object({ path: v.string(), clearance: v.string() })),
    orphans: v.optional(v.number()),
  }).index("by_workspace", ["workspaceId"]),
};
