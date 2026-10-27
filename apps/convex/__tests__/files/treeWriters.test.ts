/**
 * Console writes whose paths are decided inside them still reach the Convex
 * tree (`docs/decisions/app-and-console/convex-tree.md`): every bucket write
 * re-checks the tree promptly, or the console, which reads that tree, shows a
 * folder as it was until the hourly sweep.
 *
 * Sabotage:
 *  - drop `treeChangeOfResult` from the barrier, and drop `addBuiltInFolder`
 *    from `indexChangeOf`, and the built-in folder case fails.
 */

import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import { asUser } from "../fixtures.helpers";
import { fixture } from "./fixtures.helpers";
import { nodeAt as treeNodeAt } from "../../functions/lib/nodes/paths";

describe("console writers and the Convex tree", { timeout: 60_000 }, () => {
  test("adding a built-in folder puts its about.md in the tree before the action answers", async () => {
    const f = await fixture();
    const added = await asUser(f.t, f.owner).action(api.functions.builtInFolders.add, {
      workspaceId: f.workspaceId,
      role: "clients",
    });
    const rows = await f.t.run(async (ctx) =>
      [await treeNodeAt(ctx.db, f.workspaceId, added.readme)].flatMap((row) => (row === null ? [] : [row])),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.goneAt).toBeUndefined();
  });
});
