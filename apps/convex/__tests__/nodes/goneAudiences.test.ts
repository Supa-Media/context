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
 * Sabotage:
 *  - drop the `left` narrowing in `convexTable.ts` `logChange` and the first case fails;
 *  - take the union instead of the intersection and the never-widens case fails;
 *  - drop `left` from `touchNodes`' observations and the touch case fails;
 *  - drop `touchLeft` from `gatewayTreeTouchHandler` and the route case fails.
 */

import { describe, expect, test } from "vitest";
import { convexTest } from "convex-test";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import schema from "../../schema";
import { modules } from "../../test.setup";
import { touchNodes } from "../../functions/lib/nodes/touch";
import type { NodeSink, Observation } from "../../functions/lib/nodes/table";
import { gatewayPost } from "../fixtures.helpers";
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
  await t.mutation(internal.functions.nodes.observe, {
    workspaceId: ws,
    at: 10,
    rows: ["1-projects/held.md", "1-projects/open.md", "2-areas/mine.md"].map((path) => ({ path, etag: `e-${path}`, size: 1 })),
    gone: [],
    vanishedUnder: [],
  });
  return { t, ws };
}

async function goneAudiences(t: T) {
  const rows = await t.run(async (ctx) => await ctx.db.query("nodeLog").collect());
  return Object.fromEntries(rows.filter((row) => row.gone).map((row) => [row.path, row.audiences]));
}

describe("a gone row's audiences", () => {
  test("a private note moved out of a team folder is told only to the owner, by what the writer knew", async () => {
    const { t, ws } = await fixture();
    await t.mutation(internal.functions.nodes.observe, {
      workspaceId: ws,
      at: 20,
      rows: [],
      gone: ["1-projects/held.md", "1-projects/open.md"],
      vanishedUnder: [],
      left: [
        { path: "1-projects/held.md", audiences: ["private"] },
        { path: "1-projects/open.md", audiences: ["private", "team"] },
      ],
    });
    const audiences = await goneAudiences(t);
    expect(audiences["1-projects/held.md"]).toEqual(["private"]);
    // A team note that left stays told to the team.
    expect(audiences["1-projects/open.md"]).toEqual(["private", "team"]);
  });

  test("without what the writer knew, the rules as they stand decide (the sweep's case)", async () => {
    const { t, ws } = await fixture();
    await t.mutation(internal.functions.nodes.observe, {
      workspaceId: ws,
      at: 20,
      rows: [],
      gone: ["1-projects/open.md"],
      vanishedUnder: [],
    });
    expect((await goneAudiences(t))["1-projects/open.md"]).toEqual(["private", "team"]);
  });

  test("what the writer says never widens a row past the rules", async () => {
    const { t, ws } = await fixture();
    await t.mutation(internal.functions.nodes.observe, {
      workspaceId: ws,
      at: 20,
      rows: [],
      gone: ["2-areas/mine.md"],
      vanishedUnder: [],
      left: [{ path: "2-areas/mine.md", audiences: ["private", "team", "@friends"] }],
    });
    expect((await goneAudiences(t))["2-areas/mine.md"]).toEqual(["private"]);
  });
});

describe("carrying `left` to the log", () => {
  test("touchNodes hands each observation what the writer knew", async () => {
    const seen: Observation[] = [];
    const sink = { observe: async (observation: Observation) => void seen.push(observation) } as unknown as NodeSink;
    const store = { list: async () => ({ objects: [], truncated: false }), get: async () => null };
    const left = [{ path: "1-projects/held.md", audiences: ["private"] }];
    await touchNodes(store as never, sink, { paths: ["1-projects/held.md"], left });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]!.gone).toEqual(["1-projects/held.md"]);
    expect(seen[0]!.left).toEqual(left);
  });

  test("the gateway's touch carries `left` into the scheduled re-check, and a malformed one is refused", async () => {
    const { t, ws } = await fixture();
    const workspaceId = ws as Id<"workspaces">;
    for (const left of ["x", [{ path: "a.md" }], [{ path: "a.md", audiences: "private" }], [{ path: 4, audiences: [] }]]) {
      const bad = await gatewayPost(t, "/gateway/tree/touch", { workspaceId, paths: ["a.md"], files: [], left });
      expect(bad.status, JSON.stringify(left)).toBe(400);
    }
    const left = [{ path: "1-projects/held.md", audiences: ["private"] }];
    const response = await gatewayPost(t, "/gateway/tree/touch", {
      workspaceId,
      paths: ["1-projects/held.md", "2-areas/held.md"],
      files: [],
      left,
    });
    expect(response.status).toBe(200);
    const touches = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((job) => job.name.includes("runFileOperation")),
    );
    expect(touches.map((job) => job.args[0].operation)).toContainEqual({
      kind: "nodesTouch",
      paths: ["1-projects/held.md", "2-areas/held.md"],
      files: [],
      left,
    });
  });
});
