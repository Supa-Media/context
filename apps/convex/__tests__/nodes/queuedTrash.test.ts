/**
 * Moving to the trash as a queued move (`lib/nodes/trashStart.ts`): Delete
 * answers once the tree draws the note gone, and the bucket moves it into
 * `.context/trash/` behind. Restore while it is still queued turns it around.
 *
 * Runs the real Convex functions (`convex-test`) and the real start and
 * worker over an in-memory R2, as `queuedMoves.test.ts` does.
 *
 * Sabotage, each confirmed to fail a case here:
 *  - drop the trash seam from `trashPath` and the first case finds the note
 *    already in the bucket's trash before any pass ran;
 *  - list the old name as a folder (`from/`) for a single note and the worker
 *    never moves it ("did not drain");
 *  - run the folder finish (rules released, links rewritten) for a trash and
 *    the note's own rule is gone after it lands;
 *  - drop the `.` filter in `foldRows` and the device walk lists the trash key;
 *  - skip `restoreQueued` in `restoreTrashedPath` and Restore right after
 *    Delete is "not found".
 */

import { describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import { executeOperation } from "../../functions/lib/filesFns/executeOperation";
import { setVisibility } from "../../functions/lib/fileOps";
import { attachQueueMove } from "../../functions/lib/nodes/moveBarrier";
import { foldRows } from "../../functions/lib/nodes/moveOverlay";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { OWNER, TEAM, bucketKeys, drain, fixture, listed, type Fixture } from "./moveFixture.helpers";

type Moved = { kind: "moved"; from: string; to: string; paths: string[]; queued?: number };

function operate(f: Fixture, operation: { kind: "trash"; path: string } | { kind: "restoreTrash"; from: string; to: string }, clearance = OWNER) {
  const args = { workspaceId: f.ws, scope: clearance.scope, operation: { kind: operation.kind } };
  attachQueueMove(f.ctx, args, f.store, f.store);
  return executeOperation(f.store, clearance, operation, Date.now()) as Promise<Moved>;
}

const trashKeys = (f: Fixture) => Object.keys(f.store.snapshot()).filter((key) => key.startsWith(".context/trash/")).sort();

describe("moving a note to the trash", () => {
  test("is drawn gone at once, before the bucket has moved anything", async () => {
    const f = await fixture("s3");
    const result = await operate(f, { kind: "trash", path: "1-projects/launch/brief.md" });
    expect(result).toMatchObject({ kind: "moved", from: "1-projects/launch/brief.md", queued: 1 });
    expect(result.to).toMatch(/^\.context\/trash\/[^/]+\/1-projects\/launch\/brief\.md$/);
    expect(bucketKeys(f.store)).toContain("1-projects/launch/brief.md");
    expect(trashKeys(f)).toEqual([]);

    expect(await listed(f.owner, f.ws, "1-projects/launch")).not.toContain("1-projects/launch/brief.md");
    expect(await listed(f.member, f.ws, "1-projects/launch")).not.toContain("1-projects/launch/brief.md");
    // Its neighbours stay exactly where they were.
    expect(await listed(f.owner, f.ws, "1-projects/launch")).toContain("1-projects/launch/plan.md");
  });

  test("the bucket catches up behind it, into the trash, and only that note moves", async () => {
    const f = await fixture("s3");
    f.store.seed("1-projects/launch/brief.md.notes.md", "# Beside\n");
    const result = await operate(f, { kind: "trash", path: "1-projects/launch/brief.md" });
    await drain(f);

    expect(bucketKeys(f.store)).not.toContain("1-projects/launch/brief.md");
    expect(bucketKeys(f.store)).toContain("1-projects/launch/brief.md.notes.md");
    expect(f.store.snapshot()[result.to]).toContain("# Brief");
    expect(await listed(f.owner, f.ws, "1-projects/launch")).not.toContain("1-projects/launch/brief.md");
    expect(await f.t.query(internal.functions.nodeMoves.active, { workspaceId: f.ws })).toEqual([]);
  });

  test("keeps the note's own rule and its links, as a trash made in one go does", async () => {
    const f = await fixture("s3");
    await setVisibility(f.store, { path: "1-projects/launch/brief.md", visibility: "private", clearance: OWNER });
    const before = f.store.snapshot()[PRIVACY_KEY];
    const plan = f.store.snapshot()["1-projects/launch/plan.md"];
    await operate(f, { kind: "trash", path: "1-projects/launch/brief.md" });
    await drain(f);

    expect(f.store.snapshot()[PRIVACY_KEY]).toBe(before);
    expect(f.store.snapshot()["1-projects/launch/plan.md"]).toBe(plan);
    expect(f.store.snapshot()[".context/forwarding.json"] ?? "").not.toContain("trash");
  });

  test("a folder is drawn gone at once and carried into the trash whole", async () => {
    const f = await fixture("s3");
    const result = await operate(f, { kind: "trash", path: "1-projects/launch" });
    expect(result).toMatchObject({ queued: 4 });
    expect(await listed(f.owner, f.ws, "1-projects")).not.toContain("1-projects/launch");
    await drain(f);
    expect(bucketKeys(f.store).some((key) => key.startsWith("1-projects/launch/"))).toBe(false);
    expect(trashKeys(f).filter((key) => key.startsWith(`${result.to}/`)).map((key) => key.slice(result.to.length))).toEqual([
      "/brief.md",
      "/pic.png",
      "/plan.md",
      "/sub/deep.md",
    ]);
  });

  test("a folder holding notes the caller cannot see goes the old way, which leaves them", async () => {
    const f = await fixture("s3");
    const result = await operate(f, { kind: "trash", path: "1-projects" }, TEAM).catch((error) => error);
    // The old way: nothing queued for it.
    expect(await f.t.query(internal.functions.nodeMoves.active, { workspaceId: f.ws })).toEqual([]);
    expect((result as Moved).queued).toBeUndefined();
    expect(bucketKeys(f.store)).toContain("1-projects/secret/codes.md");
  });

  test("a note the caller cannot see is not found, and nothing is held", async () => {
    const f = await fixture("s3");
    await expect(operate(f, { kind: "trash", path: "1-projects/secret/codes.md" }, TEAM)).rejects.toThrow();
    expect(await f.t.query(internal.functions.nodeMoves.active, { workspaceId: f.ws })).toEqual([]);
    expect(await f.t.run(async (ctx) => await ctx.db.query("moveQueue").collect())).toEqual([]);
  });
});

describe("restoring a note whose trash is still queued", () => {
  test("turns the move around: drawn back at once, and the bucket never loses it", async () => {
    const f = await fixture("s3");
    const trashed = await operate(f, { kind: "trash", path: "1-projects/launch/brief.md" });
    const restored = await operate(f, { kind: "restoreTrash", from: trashed.to, to: "1-projects/launch/brief.md" });
    expect(restored).toMatchObject({ kind: "moved", to: "1-projects/launch/brief.md" });
    expect(await listed(f.owner, f.ws, "1-projects/launch")).toContain("1-projects/launch/brief.md");
    await drain(f);
    expect(f.store.snapshot()["1-projects/launch/brief.md"]).toContain("# Brief");
    expect(trashKeys(f)).toEqual([]);
    expect(await listed(f.owner, f.ws, "1-projects/launch")).toContain("1-projects/launch/brief.md");
  });

  test("after the bucket caught up, restores from the trash the usual way", async () => {
    const f = await fixture("s3");
    const trashed = await operate(f, { kind: "trash", path: "1-projects/launch/brief.md" });
    await drain(f);
    await operate(f, { kind: "restoreTrash", from: trashed.to, to: "1-projects/launch/brief.md" });
    expect(f.store.snapshot()["1-projects/launch/brief.md"]).toContain("# Brief");
    expect(trashKeys(f)).toEqual([]);
  });

  test("a restore to a name the trash did not come from is refused", async () => {
    const f = await fixture("s3");
    const trashed = await operate(f, { kind: "trash", path: "1-projects/launch/brief.md" });
    await expect(operate(f, { kind: "restoreTrash", from: trashed.to, to: "3-resources/brief.md" })).rejects.toThrow();
    expect(await listed(f.owner, f.ws, "1-projects/launch")).not.toContain("1-projects/launch/brief.md");
  });
});

describe("storage that cannot restore a collaboratively edited note", () => {
  test("trashes the old way, so nothing lands in a trash it could not come back from", async () => {
    const f = await fixture("r2");
    await operate(f, { kind: "trash", path: "1-projects/launch/pic.png" });
    expect(await f.t.query(internal.functions.nodeMoves.active, { workspaceId: f.ws })).toEqual([]);
    expect(bucketKeys(f.store)).not.toContain("1-projects/launch/pic.png");
  });
});

describe("a whole-tree walk while a trash is queued", () => {
  test("never lists the trash name the note folds to", () => {
    const moves = [{ from: "a/n.md", to: ".context/trash/2026/a/n.md" }];
    expect(foldRows([{ path: "a/n.md" }, { path: "a/m.md" }], moves, new Set()).map((row) => row.path)).toEqual(["a/m.md"]);
  });
});
