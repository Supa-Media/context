/**
 * A queued folder move end to end (phase 4 of
 * `docs/decisions/app-and-console/convex-tree.md`): one step draws it on
 * every listing, the worker catches the bucket up behind it, and nothing is
 * ever wider for anybody while it does.
 *
 * Runs the real Convex functions (`convex-test`) and the real start and
 * worker over an in-memory R2 (conditional create and write, `If-Match` on
 * DELETE ignored, as measured).
 *
 * Sabotage, each confirmed to fail a case here:
 *  - skip `carryPrivacy` in `startQueuedMove` and the private-folder case
 *    shows a team member the moved notes;
 *  - activate without the mirror etag check and the stale-mirror case draws
 *    the move;
 *  - drop the moving-row clash in `reserve` and the reserved-name cases queue;
 *  - fold the worker's destination through this move alone and the chain
 *    case copies to the middle name;
 *  - skip `releasePrivacy` at the finish and the old name's rules stay;
 *  - let `undo` run while a pass holds the lease and the undo case moves the
 *    folder the wrong way.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getFunctionName } from "convex/server";
import { api, internal } from "../../_generated/api";
import type { ActionCtx } from "../../_generated/server";
import { ADMIN_EMAILS_ENV_VAR } from "../../functions/lib/admin";
import { executeOperation } from "../../functions/lib/filesFns/executeOperation";
import { attachQueueMove, runMoveOperation, storeWithMoves } from "../../functions/lib/nodes/moveBarrier";
import { startQueuedMove } from "../../functions/lib/nodes/moveStart";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { ADMIN, OWNER, TEAM, type Call, bucketKeys, drain, fixture, listed, start } from "./moveFixture.helpers";

let previousAdmins: string | undefined;
beforeEach(() => {
  previousAdmins = process.env[ADMIN_EMAILS_ENV_VAR];
  process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
});
afterEach(() => {
  if (previousAdmins === undefined) delete process.env[ADMIN_EMAILS_ENV_VAR];
  else process.env[ADMIN_EMAILS_ENV_VAR] = previousAdmins;
});


describe("a queued folder move", () => {
  test("is drawn everywhere at once, before the bucket has moved anything", async () => {
    const f = await fixture();
    const moved = await start(f, "1-projects/launch", "3-resources/launch");
    expect(moved).toMatchObject({ from: "1-projects/launch", to: "3-resources/launch", queued: 4 });
    expect(bucketKeys(f.store)).toContain("1-projects/launch/brief.md");

    expect(await listed(f.owner, f.ws, "1-projects")).not.toContain("1-projects/launch");
    expect(await listed(f.owner, f.ws, "3-resources")).toContain("3-resources/launch");
    expect(await listed(f.owner, f.ws, "3-resources/launch")).toEqual([
      "3-resources/launch/brief.md",
      "3-resources/launch/pic.png",
      "3-resources/launch/plan.md",
      "3-resources/launch/sub",
    ]);
    expect(await listed(f.member, f.ws, "3-resources/launch")).toContain("3-resources/launch/brief.md");
  });

  test("the bucket catches up behind it, and the old name's rules go when it is done", async () => {
    const f = await fixture();
    await start(f, "1-projects/launch", "3-resources/launch");
    const drawn = await listed(f.owner, f.ws, "3-resources/launch");
    await drain(f);

    expect(bucketKeys(f.store).filter((key) => key.includes("launch"))).toEqual([
      "3-resources/launch/brief.md",
      "3-resources/launch/pic.png",
      "3-resources/launch/plan.md",
      "3-resources/launch/sub/deep.md",
    ]);
    expect(await listed(f.owner, f.ws, "3-resources/launch")).toEqual(drawn);
    expect(f.store.snapshot()["3-resources/launch/plan.md"]).toContain("brief");
    expect(await f.t.query(internal.functions.nodeMoves.active, { workspaceId: f.ws })).toEqual([]);
    expect(f.store.snapshot()[".context/forwarding.json"] ?? "").toContain("3-resources/launch");
  });

  test("a private folder moved into a team folder is never shown to the team, drawn or copied", async () => {
    const f = await fixture();
    expect(await listed(f.member, f.ws, "1-projects")).not.toContain("1-projects/secret");
    await start(f, "1-projects/secret", "3-resources/secret");
    expect(await listed(f.member, f.ws, "3-resources")).not.toContain("3-resources/secret");
    expect(await listed(f.owner, f.ws, "3-resources")).toContain("3-resources/secret");
    await drain(f);
    expect(await listed(f.member, f.ws, "3-resources")).not.toContain("3-resources/secret");
    expect(f.store.snapshot()[PRIVACY_KEY]).toContain("3-resources/secret");
    expect(f.store.snapshot()[PRIVACY_KEY]).not.toContain("1-projects/secret");
  });

  test("is not drawn when the tree's copy of the rules is not the privacy.md just written", async () => {
    const f = await fixture();
    // A move that writes a rule, whose re-read into the tree is lost, as when a touch fails.
    const ctx = {
      ...f.ctx,
      runMutation: (ref: never, args: unknown) =>
        getFunctionName(ref).endsWith("nodes:savePrivacy") ? Promise.resolve(null) : (f.t.mutation as unknown as Call)(ref, args),
    } as unknown as ActionCtx;
    const moved = await startQueuedMove(ctx, {
      workspaceId: f.ws,
      store: f.store,
      from: "1-projects/secret",
      to: "3-resources/secret",
      clearance: OWNER,
      now: Date.now(),
    });
    expect(moved).toBeNull();
    expect(await f.t.query(internal.functions.nodeMoves.active, { workspaceId: f.ws })).toEqual([]);
    // The carried rule was taken back with it.
    expect(f.store.snapshot()[PRIVACY_KEY]).not.toContain("3-resources/secret");
  });
});

describe("names a running move holds", () => {
  test("its old name cannot be moved, moved onto, or written into while it runs", async () => {
    const f = await fixture();
    await start(f, "1-projects/launch", "3-resources/launch");
    await expect(start(f, "1-projects/launch", "2-areas/launch")).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(start(f, "3-resources", "1-projects/launch")).rejects.toMatchObject({ code: "CONFLICT" });
    const view = await storeWithMoves(f.ctx, { workspaceId: f.ws, scope: "private", operation: { kind: "write" } }, f.store, [
      { from: "1-projects/launch", to: "3-resources/launch" },
    ]);
    await view.get("3-resources/launch/brief.md");
    await expect(view.put("1-projects/launch/brief.md", "# New\n")).rejects.toMatchObject({ code: "MOVED" });
  });

  test("its new name can be moved on, and each object is copied once, straight to the end", async () => {
    const f = await fixture();
    await start(f, "1-projects/launch", "3-resources/launch");
    expect(await start(f, "3-resources/launch/sub", "2-areas/sub")).toMatchObject({ queued: 1 });
    expect(await listed(f.owner, f.ws, "2-areas/sub")).toEqual(["2-areas/sub/deep.md"]);
    const written: string[] = [];
    const put = f.store.put.bind(f.store);
    f.store.put = async (key, value, options) => {
      written.push(key);
      return await put(key, value, options);
    };
    await drain(f);
    expect(written).not.toContain("3-resources/launch/sub/deep.md");
    expect(bucketKeys(f.store)).toContain("2-areas/sub/deep.md");
    expect(bucketKeys(f.store).some((key) => key.startsWith("3-resources/launch/sub"))).toBe(false);
  });
});

describe("when a move is not queued", () => {
  test("paused by staff: the caller moves the old way, and nothing is held", async () => {
    const f = await fixture();
    await f.t.run(async (ctx) => {
      await ctx.db.insert("nodeMigration", { paused: true, updatedAt: 1 });
    });
    expect(await start(f, "1-projects/launch", "3-resources/launch")).toBeNull();
    expect(await f.t.run(async (ctx) => await ctx.db.query("moveQueue").collect())).toEqual([]);
  });

  test("a folder holding a note the caller cannot see moves the old way, which leaves it behind", async () => {
    const f = await fixture();
    expect(await start(f, "1-projects", "2-areas/projects", TEAM)).toBeNull();
  });

  test("a single note moves in one step as it always has", async () => {
    const f = await fixture();
    expect(await start(f, "1-projects/keep.md", "3-resources/keep.md")).toBeNull();
  });

  test("an existing destination is refused, and one the caller cannot see is not found", async () => {
    const f = await fixture();
    await expect(start(f, "1-projects/launch", "3-resources")).rejects.toMatchObject({ code: "DESTINATION_EXISTS" });
    await expect(start(f, "3-resources", "1-projects/secret", TEAM)).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
  });
});

describe("through the console and the gateway's start", () => {
  test("the console's move queues through movePath's seam", async () => {
    const f = await fixture();
    const args = { workspaceId: f.ws, scope: "private" as const, operation: { kind: "move" } };
    attachQueueMove(f.ctx, args, f.store, f.store);
    const result = await executeOperation(f.store, OWNER, { kind: "move", from: "1-projects/launch", to: "3-resources/launch" }, Date.now());
    expect(result).toMatchObject({ kind: "moved", paths: ["3-resources/launch"], queued: 4 });
    expect(bucketKeys(f.store)).toContain("1-projects/launch/brief.md");
  });

  test("the gateway's start refuses an unchecked path before anything is held", async () => {
    const f = await fixture();
    const answer = await runMoveOperation(
      f.ctx,
      { workspaceId: f.ws, scope: "private", operation: { kind: "nodesMoveStart", from: "1-projects", to: "../x" } },
      f.store,
    );
    expect(answer).toMatchObject({ kind: "moveQueued", queued: false, error: "PATH_INVALID" });
    const main = await runMoveOperation(
      f.ctx,
      { workspaceId: f.ws, scope: "private", operation: { kind: "nodesMoveStart", from: "1-projects", to: "2-areas/p" } },
      f.store,
    );
    expect(main).toMatchObject({ queued: false, error: "PATH_INVALID" });
  });

  test("opening a note at its old name moves it on first", async () => {
    const f = await fixture();
    await start(f, "1-projects/launch", "3-resources/launch");
    const moves = await f.t.query(internal.functions.nodeMoves.active, { workspaceId: f.ws });
    await storeWithMoves(
      f.ctx,
      { workspaceId: f.ws, scope: "private", operation: { kind: "read", path: "1-projects/launch/brief.md" } as never },
      f.store,
      moves,
    );
    expect(bucketKeys(f.store)).toContain("3-resources/launch/brief.md");
    expect(bucketKeys(f.store)).not.toContain("1-projects/launch/brief.md");
  });
});

describe("staff Retry and Undo", () => {
  test("a stranger cannot see or touch the queue", async () => {
    const f = await fixture();
    await expect(f.owner.query(api.functions.nodeMovesAdmin.report, {})).rejects.toThrow();
  });

  test("Undo carries a half-copied folder back, and takes back exactly the rules it added", async () => {
    const f = await fixture();
    const before = f.store.snapshot()[PRIVACY_KEY];
    await start(f, "1-projects/secret", "3-resources/secret");
    const report = await f.staff.query(api.functions.nodeMovesAdmin.report, {});
    expect(report.rows).toHaveLength(1);
    expect(JSON.stringify(report)).not.toContain("secret");
    // One object has moved already.
    await storeWithMoves(
      f.ctx,
      { workspaceId: f.ws, scope: "private", operation: { kind: "read", path: "1-projects/secret/codes.md" } as never },
      f.store,
      await f.t.query(internal.functions.nodeMoves.active, { workspaceId: f.ws }),
    );
    expect(bucketKeys(f.store)).toContain("3-resources/secret/codes.md");

    await f.staff.mutation(api.functions.nodeMovesAdmin.undo, { id: report.rows[0]!.id });
    expect(await listed(f.owner, f.ws, "1-projects")).toContain("1-projects/secret");
    expect(await listed(f.owner, f.ws, "3-resources")).not.toContain("3-resources/secret");
    await drain(f);
    expect(bucketKeys(f.store)).toContain("1-projects/secret/codes.md");
    expect(bucketKeys(f.store).some((key) => key.startsWith("3-resources/secret"))).toBe(false);
    expect(f.store.snapshot()[PRIVACY_KEY]).toBe(before);
  });

  test("Undo waits while a pass holds the move", async () => {
    const f = await fixture();
    await start(f, "1-projects/launch", "3-resources/launch");
    await f.t.mutation(internal.functions.nodeMoves.claim, { workspaceId: f.ws, now: Date.now() });
    const [row] = (await f.staff.query(api.functions.nodeMovesAdmin.report, {})).rows;
    await expect(f.staff.mutation(api.functions.nodeMovesAdmin.undo, { id: row!.id })).rejects.toThrow(/copying right now/);
  });
});
