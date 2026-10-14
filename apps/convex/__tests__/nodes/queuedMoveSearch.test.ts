/**
 * Fast search follows a queued folder move when its copy lands.
 *
 * While the copy runs, search folds the folder's rows to the new name
 * (`atTreeNames`). Once the move leaves the queue nothing folds them, and the
 * worker had never told the database: every note in the folder came back at
 * its old name, which opens nothing, and not at the new one, for as long as a
 * ready database keeps a row (for good, before the daily check). The worker now
 * renames the rows when it finishes, under the rules it has just settled, and
 * asks search by meaning to catch up.
 *
 * ## Sabotage record
 *
 * Temporary local edits, reverted, counts as measured over this file:
 *
 *   `finishMove` not following the move into the database                  2
 *   `nodeMoves.complete` not freshening search by meaning                   1
 */

import { describe, expect, test } from "vitest";
import { runMoveWork } from "../../functions/lib/nodes/moveWork";
import { internal } from "../../_generated/api";
import { sqliteProjection } from "../sqliteProjection.helpers";
import { type Fixture, fixture, start } from "./moveFixture.helpers";

async function drainInto(f: Fixture, client: ReturnType<typeof sqliteProjection>["client"]): Promise<void> {
  for (let pass = 0; pass < 20; pass += 1) {
    const queue = await f.t.query(internal.functions.nodeMoves.active, { workspaceId: f.ws });
    if (queue.length === 0) return;
    await runMoveWork(f.ctx, f.ws, f.store, client);
  }
  throw new Error("moves did not drain");
}

function seeded() {
  const database = sqliteProjection();
  database.seed("1-projects/launch/brief.md", "# Brief\n", "team");
  database.seed("1-projects/launch/plan.md", "# Plan\n", "team");
  database.seed("1-projects/launch/sub/deep.md", "# Deep\n", "team");
  database.seed("1-projects/keep.md", "# Keep\n", "team");
  return database;
}

describe("a queued folder move in fast search", () => {
  test("is found at the new name once the copy lands, and not at the old one", async () => {
    const f = await fixture();
    const database = seeded();
    await start(f, "1-projects/launch", "1-projects/renamed");
    // Still copying: the rows stay where the bucket still holds the notes.
    expect(database.paths()).toContain("1-projects/launch/brief.md");

    await drainInto(f, database.client);

    expect(database.paths()).toEqual([
      "1-projects/keep.md",
      "1-projects/renamed/brief.md",
      "1-projects/renamed/plan.md",
      "1-projects/renamed/sub/deep.md",
    ]);
  });

  test("moved somewhere private, its notes leave the team tier", async () => {
    const f = await fixture();
    const database = seeded();
    await start(f, "1-projects/launch", "1-projects/secret/launch");

    await drainInto(f, database.client);

    expect(database.tiers()).toEqual({
      "1-projects/keep.md": "team",
      "1-projects/secret/launch/brief.md": "private",
      "1-projects/secret/launch/plan.md": "private",
      "1-projects/secret/launch/sub/deep.md": "private",
    });
  });

  test("search by meaning is asked to catch up when the move finishes", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      await ctx.db.insert("meaningIndexes", {
        workspaceId: f.ws,
        enabled: true,
        enabledAt: 1,
        status: "ready",
        indexName: `context-meaning-${f.ws}`,
        createdAt: 1,
        updatedAt: 1,
      });
    });
    await start(f, "1-projects/launch", "1-projects/renamed");

    await drainInto(f, seeded().client);

    const freshenAt = await f.t.run(async (ctx) =>
      (await ctx.db.query("meaningIndexes").withIndex("by_workspace", (q) => q.eq("workspaceId", f.ws)).unique())?.freshenAt,
    );
    expect(freshenAt).toBeGreaterThan(Date.now());
  });
});
