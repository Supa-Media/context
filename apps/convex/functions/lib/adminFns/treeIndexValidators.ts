/** The tree index panel's shapes, apart so the public functions need not import the database code. */

import { v, type Infer } from "convex/values";

export const treeTargetsValidator = v.object({
  targets: v.array(
    v.object({
      workspaceId: v.id("workspaces"),
      slug: v.union(v.string(), v.null()),
      databaseId: v.string(),
      state: v.union(v.literal("backfilling"), v.literal("ready")),
    }),
  ),
  truncated: v.boolean(),
});

/** The Convex tree's bookkeeping for one workspace (`nodeTrees`): counts and times, never a path. */
export const convexTreeValidator = v.object({
  status: v.union(v.literal("empty"), v.literal("filling"), v.literal("ready"), v.literal("unsupported")),
  files: v.number(),
  sweptAt: v.union(v.number(), v.null()),
  /** The last parity check against the bucket, or `null` when none has run. */
  parity: v.union(
    v.null(),
    v.object({
      checkedAt: v.number(),
      clearances: v.number(),
      mismatches: v.number(),
      privacyMatches: v.boolean(),
    }),
  ),
});

export const treeIndexRowValidator = v.object({
  workspaceId: v.id("workspaces"),
  slug: v.union(v.string(), v.null()),
  /** `ready`: filled and served. `filling`: a sweep is part way. `empty`: never filled. */
  status: v.union(
    v.literal("ready"),
    v.literal("filling"),
    v.literal("empty"),
    v.literal("unsupported"),
    v.literal("unreachable"),
  ),
  rows: v.union(v.number(), v.null()),
  sweptAt: v.union(v.number(), v.null()),
  /** A change was too big to re-check, so the next read starts a sweep. */
  dirty: v.boolean(),
  /** Why the last sweep pass failed, keys removed; cleared once one moves on. */
  error: v.union(v.string(), v.null()),
  /** The Convex tree (`lib/nodes/`), shadowing the bucket in phase 1; `null` before its first sweep. */
  convex: v.union(convexTreeValidator, v.null()),
});

export const treeIndexReportValidator = v.object({
  rows: v.array(treeIndexRowValidator),
  truncated: v.boolean(),
});

export type TreeIndexRow = Infer<typeof treeIndexRowValidator>;

