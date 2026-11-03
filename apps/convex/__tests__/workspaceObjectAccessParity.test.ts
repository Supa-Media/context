/**
 * The access dry run (`functions/workspaceObjectAccessParity.ts`) against real workspace objects, through the same
 * door and object the push tests use (`workspaceObjectWorld.helpers.ts`). It changes nothing: it asks each object-home
 * workspace to render its rules from the access set Convex sends and compare.
 *
 * Sabotage, to confirm these fail: count a workspace whose call threw as equal, or stop the page at the first failure.
 */

import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { workspaceAccess } from "../../mcp/src/workspaceStore/accessRows.js";
import { workspaceRows } from "../../mcp/src/workspaceStore/rows.js";
import { workspaceMarks } from "../../mcp/src/workspaceStore/marks.js";
import { texObjects } from "../../mcp/src/texStore/objects.js";
import { createWorkspace, createUser, seedTreeRows } from "./fixtures.helpers";
import { durableSql, setFolder, setHome, world } from "./workspaceObjectWorld.helpers";

/**
 * The object the door opens for a workspace, with the access rows the dry run asks (`ws.access.check` answers only
 * from a store that keeps them). The push harness (`workspaceObjectWorld.helpers.ts`) opens stores without them.
 */
function objectWithAccess(stores: Map<string, unknown>, workspaceId: Id<"workspaces">) {
  const sql = durableSql();
  stores.set(`workspace:${workspaceId}`, {
    rows: workspaceRows(sql),
    objects: texObjects(sql),
    marks: workspaceMarks(sql),
    access: workspaceAccess(sql),
    transact: (work: () => unknown) => sql.transact(work),
  });
}

describe("the workspace object's access dry run", () => {
  test("an object-home workspace whose object renders the same rules is counted equal", async () => {
    const { t, owner, workspaceId, stores } = await world();
    objectWithAccess(stores, workspaceId);
    await seedTreeRows(t, workspaceId, ["plans/a.md"]);
    await setFolder(t, workspaceId, owner, "plans", "team");
    await setHome(t, workspaceId, "object");

    const result = await t.action(internal.functions.workspaceObjectAccessParity.dryRun, {});

    expect(result).toMatchObject({ checked: 1, equal: 1, differs: 0, skipped: 0, failed: 0, next: null });
    expect(result.rows).toEqual([
      expect.objectContaining({ workspaceId: String(workspaceId), member: "equal", guest: "equal" }),
    ]);
  });

  test("a workspace whose object throws is counted failed by its error's name, and the next one is still checked", async () => {
    const { t, owner, workspaceId, onCall, stores } = await world();
    objectWithAccess(stores, workspaceId);
    await seedTreeRows(t, workspaceId, ["plans/a.md"]);
    await setFolder(t, workspaceId, owner, "plans", "team");
    await setHome(t, workspaceId, "object");
    const second = await createWorkspace(t, owner, "object-parity-second", { kind: "shared" });
    objectWithAccess(stores, second);
    await setHome(t, second, "object");

    // The first access check the object is asked to make throws; every later one answers.
    let refused = false;
    onCall(async (op) => {
      if (op === "ws.access.check" && !refused) {
        refused = true;
        throw new Error(`the object refused ${op} for a path`);
      }
    });

    const result = await t.action(internal.functions.workspaceObjectAccessParity.dryRun, {});

    expect(result).toMatchObject({ checked: 2, failed: 1, equal: 1, differs: 0, next: null });
    const failed = result.rows.filter((row) => row.error !== undefined);
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ member: "unchecked", guest: "unchecked", error: "ObjectUnreachable" });
    // The error's message, which can name a path, never reaches the answer.
    expect(JSON.stringify(result)).not.toContain("refused");
    expect(result.rows.some((row) => row.workspaceId === String(second) && row.member === "equal")).toBe(true);
  });

  test("a workspace still on the bucket is not listed at all", async () => {
    const { t, owner, workspaceId } = await world();
    await seedTreeRows(t, workspaceId, ["plans/a.md"]);
    await setFolder(t, workspaceId, owner, "plans", "team");
    const other = await createUser(t, "object-parity-bucket@example.com");
    await createWorkspace(t, other, "object-parity-bucket", { kind: "shared" });

    const result = await t.action(internal.functions.workspaceObjectAccessParity.dryRun, {});

    expect(result.checked).toBe(0);
    expect(result.rows).toEqual([]);
    expect(result.next).toBeNull();
  });
});
