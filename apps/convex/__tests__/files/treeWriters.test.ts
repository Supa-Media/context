/**
 * Console writes whose paths are decided inside them still reach the Convex
 * tree (`docs/decisions/app-and-console/convex-tree.md`): every bucket write
 * re-checks the tree promptly, or the console, which reads that tree, shows a
 * folder as it was until the hourly sweep.
 *
 * Sabotage:
 *  - drop `treeChangeOfResult` from the barrier, and drop `addBuiltInFolder`
 *    from `indexChangeOf`, and the built-in folder case fails;
 *  - drop the `every` sweep in `announceTreeChange` and the clear-vault case fails.
 */

import { describe, expect, test } from "vitest";
import { api, internal } from "../../_generated/api";
import { asUser } from "../fixtures.helpers";
import { fixture } from "./fixtures.helpers";

describe("console writers and the Convex tree", () => {
  test("adding a built-in folder puts its about.md in the tree before the action answers", async () => {
    const f = await fixture();
    const added = await asUser(f.t, f.owner).action(api.functions.builtInFolders.add, {
      workspaceId: f.workspaceId,
      role: "clients",
    });
    const rows = await f.t.run(async (ctx) =>
      await ctx.db
        .query("nodes")
        .withIndex("by_workspace_path", (q) => q.eq("workspaceId", f.workspaceId).eq("path", added.readme))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.goneAt).toBeUndefined();
  });

  test("clearing the vault asks for a sweep, since it names no path to re-check", async () => {
    const f = await fixture();
    await f.t.action(internal.functions.files.runFileOperation, {
      workspaceId: f.workspaceId,
      scope: "private",
      operation: { kind: "clearVault", countOnly: false },
    });
    const tree = await f.t.run(async (ctx) =>
      await ctx.db
        .query("nodeTrees")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", f.workspaceId))
        .unique(),
    );
    expect(tree?.dirty).toBe(true);
  });
});
