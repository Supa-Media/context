/**
 * Who a `gone` log row is told to, when the move that took the note away
 * also rewrote the rules first.
 *
 * A move clears the source's exact visibility as part of the move, and the
 * tree's re-check runs after it. Judged by the rules as they stand then, a
 * private note that sat in a team folder looks like a team note, and its old
 * path would be told to every member's device. The writer knows who could see
 * the note before it moved (`left`), and the row records the narrower of the
 * two: what the writer says, never wider than the rules now say.
 *
 * The writer's `left` reaches the table only through `convexNodeTable` (`convexTable.ts`); the seam's own
 * observations carry none, so the cases below pass it there directly.
 *
 * Sabotage:
 *  - drop the `left` narrowing in `convexTable.ts` `logChange` and the first case fails;
 *  - take the union instead of the intersection and the never-widens case fails;
 */

import { applyTreeObservation } from "../fixtures.helpers";
import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import type { MutationCtx } from "../../_generated/server";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { convexNodeTable } from "../../functions/lib/nodes/convexTable";
import { applyObservation } from "../../functions/lib/nodes/observe";
import type { LeftAudiences } from "../../functions/lib/nodes/table";
import { translateMirror } from "../seededRules.helpers";

type T = ReturnType<typeof convexTest>;

/** The rules after the move: the folder is team, and the note's private exception is gone. */
const AFTER_MOVE = {
  etag: "privacy-2",
  invalid: false,
  folders: [
    // Folder rows are named without the trailing slash the rules file uses: the row is the folder's path.
    { prefix: "1-projects", visibility: "team" },
    { prefix: "2-areas", visibility: "private" },
  ],
  notes: [],
};

async function fixture() {
  const t = convexTest(schema, modules);
  const ws = await t.run(async (ctx) => {
    const now = Date.now();
    const ownerId = await ctx.db.insert("users", { email: "owner@example.test", emailVerificationTime: now } as never);
    const id = await ctx.db.insert("workspaces", {
      slug: "acme",
      displayName: "Acme",
      createdBy: ownerId,
      kind: "shared",
      structureTemplate: "para",
      createdAt: now,
      updatedAt: now,
    });
    await ctx.db.insert("workspaceMembers", { workspaceId: id, userId: ownerId, role: "owner", joinedAt: now });
    return id;
  });
  await translateMirror(t, ws, AFTER_MOVE);
  // Three live notes, written through the seam as the store reports them (keyed rows, so a removal can take them).
  await applyTreeObservation(t, {
    workspaceId: ws,
    at: 10,
    rows: ["1-projects/held.md", "1-projects/open.md", "2-areas/mine.md"].map((path) => ({ path, etag: "e" })),
    gone: [],
  });
  return { t, ws };
}

/** The seam reports `paths` gone at `at`, with what the writer knew of who could see each before it left, if it says. */
async function leave(t: T, ws: Id<"workspaces">, paths: string[], left?: LeftAudiences[]) {
  await t.run(async (ctx) => {
    await applyObservation(convexNodeTable(ctx as MutationCtx, ws, left), { at: 20, rows: [], gone: paths });
  });
}

async function goneAudiences(t: T) {
  const rows = await t.run(async (ctx) => await ctx.db.query("nodeLog").collect());
  return Object.fromEntries(rows.filter((row) => row.gone).map((row) => [row.path, row.audiences]));
}

describe("a gone row's audiences", () => {
  test("a private note moved out of a team folder is told only to the owner, by what the writer knew", async () => {
    const { t, ws } = await fixture();
    await leave(t, ws, ["1-projects/held.md", "1-projects/open.md"], [{ path: "1-projects/held.md", audiences: ["private"] }]);
    const audiences = await goneAudiences(t);
    expect(audiences["1-projects/held.md"]).toEqual(["private"]);
    // A team note that left stays told to the team.
    expect(audiences["1-projects/open.md"]).toEqual(["private", "team"]);
  });

  test("without what the writer knew, the rules as they stand decide (nothing was recorded)", async () => {
    const { t, ws } = await fixture();
    await leave(t, ws, ["1-projects/open.md"]);
    expect((await goneAudiences(t))["1-projects/open.md"]).toEqual(["private", "team"]);
  });

  test("what the writer says never widens a row past the rules", async () => {
    const { t, ws } = await fixture();
    // The writer says the team could see it; the rules say only the owner can, so the row stays with the owner.
    await leave(t, ws, ["2-areas/mine.md"], [{ path: "2-areas/mine.md", audiences: ["private", "team"] }]);
    expect((await goneAudiences(t))["2-areas/mine.md"]).toEqual(["private"]);
  });
});
