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
});

export const treeIndexReportValidator = v.object({
  rows: v.array(treeIndexRowValidator),
  truncated: v.boolean(),
});

export type TreeIndexRow = Infer<typeof treeIndexRowValidator>;

