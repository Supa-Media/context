/**
 * The queued move's worker never stops short and never sticks on one object
 * (project file `move-engine/plan.md`, step A): whatever the bucket does, the
 * bucket ends up where the tree draws it, with nothing lost.
 *
 * The real Convex functions (`convex-test`), the real start and worker, over
 * an in-memory R2 that the cases below make misbehave on purpose.
 *
 * Sabotage, each confirmed to fail a case here:
 *  - list "again until empty" instead of following the cursor, and the
 *    deleted-markers case finishes the move with a file left behind;
 *  - throw a clash instead of settling it, and the clash case never drains;
 *  - drop the visibility check in `settleClash`, and the held-back clash is
 *    moved to a name nobody held back;
 *  - fail the whole pass on one object, and the one-bad-file case moves
 *    nothing else;
 *  - drop the in-place retries, and the flaky-storage case needs more passes
 *    than it is given.
 */

import { describe, expect, test } from "vitest";
import { getFunctionName } from "convex/server";
import { internal } from "../../_generated/api";
import type { ActionCtx } from "../../_generated/server";
import { isLogicalDeleteMarker, withLogicalDelete } from "../../../mcp/src/store/logicalDelete.js";
import { setExactVisibility } from "../../functions/lib/fileOps";
import { runMoveWork } from "../../functions/lib/nodes/moveWork";
import { BUFFERED_MAX_BYTES, MOVE_FAILED_CONFLICT, MOVE_FAILED_STORAGE, MOVE_FAILED_TOO_LARGE } from "../../functions/lib/nodes/moveWork";
import { clashName } from "../../functions/lib/nodes/moveSteps";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { type Call, type Fixture, type Store, bucketKeys, fixture, start } from "./moveFixture.helpers";

const noWait = async () => {};

type Queue = { _id: string; attempts: number; lastError?: string; moved: number }[];

async function queueRows(f: Fixture): Promise<Queue> {
  return (await f.t.run(async (ctx) =>
    await ctx.db.query("moveQueue").withIndex("by_workspace", (q) => q.eq("workspaceId", f.ws)).collect())) as unknown as Queue;
}

/** Run passes over `store` until the queue is empty, skipping back-offs. Answers how many passes it took. */
async function drainWith(f: Fixture, store: Store, maxPasses = 20, ctx: ActionCtx = f.ctx): Promise<number> {
  for (let pass = 1; pass <= maxPasses; pass += 1) {
    if ((await queueRows(f)).length === 0) return pass - 1;
    await f.t.run(async (db) => {
      for (const row of await db.db.query("moveQueue").collect()) await db.db.patch(row._id, { nextAt: 0, leaseAt: undefined });
    });
    await runMoveWork(ctx, f.ws, store, null, { wait: noWait });
  }
  if ((await queueRows(f)).length === 0) return maxPasses;
  throw new Error("moves did not drain");
}

/** `store` with some calls failing, decided per call. */
function faulty(store: Store, fails: (method: string, key: string) => boolean): Store {
  return new Proxy(store, {
    get(target, property, receiver) {
      const value = Reflect.get(target, property, receiver);
      if (typeof value !== "function" || !["get", "put", "delete", "list"].includes(String(property))) return value;
      return async (...args: unknown[]) => {
        const key = property === "list" ? String((args[0] as { prefix?: string })?.prefix ?? "") : String(args[0]);
        if (fails(String(property), key)) throw new Error(`InternalError: ${String(property)} failed`);
        return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
      };
    },
  }) as Store;
}

describe("the old name is walked to its end", () => {
  test("a run of deleted notes ahead of a real file does not finish the move early", async () => {
    const f = await fixture();
    const view = withLogicalDelete(f.store) as unknown as Store;
    // More hidden markers than one page lists, all sorting ahead of the real notes.
    for (let index = 0; index < 230; index += 1) {
      const key = `1-projects/launch/a${String(index).padStart(3, "0")}.md`;
      await view.put(key, "# gone\n", { contentType: "text/markdown; charset=utf-8" });
      await view.delete(key);
    }
    await start(f, "1-projects/launch", "3-resources/launch");
    await drainWith(f, view);

    // Moving leaves deleted-note markers at the old names, as every delete here does; only live files count.
    const live = bucketKeys(f.store).filter((key) => !isLogicalDeleteMarker(f.store.snapshot()[key] ?? "") && f.store.snapshot()[key] !== "");
    const keys = live.filter((key) => key.includes("launch") && !/\/a\d{3}\.md$/.test(key));
    expect(keys).toEqual([
      "3-resources/launch/brief.md",
      "3-resources/launch/pic.png",
      "3-resources/launch/plan.md",
      "3-resources/launch/sub/deep.md",
    ]);
  });
});

describe("a different file already at the destination", () => {
  test("is kept, and the moving file lands beside it as (moved)", async () => {
    const f = await fixture();
    await start(f, "1-projects/launch", "3-resources/launch");
    // Written straight into the bucket after the move was drawn, as an S3 client would.
    f.store.seed("3-resources/launch/pic.png", "someone else's png");
    await drainWith(f, f.store);

    const snapshot = f.store.snapshot();
    expect(snapshot["3-resources/launch/pic.png"]).toBe("someone else's png");
    expect(snapshot["3-resources/launch/pic (moved).png"]).toBe("png");
    expect(snapshot["1-projects/launch/pic.png"]).toBeUndefined();
    expect(await queueRows(f)).toEqual([]);
  });

  test("a second clash takes the next free name", async () => {
    expect(clashName("a/pic.png", 1)).toBe("a/pic (moved).png");
    expect(clashName("a/pic.png", 2)).toBe("a/pic (moved 2).png");
    expect(clashName("a/README", 1)).toBe("a/README (moved)");
    expect(clashName("a/.hidden", 1)).toBe("a/.hidden (moved)");
    const f = await fixture();
    await start(f, "1-projects/launch", "3-resources/launch");
    f.store.seed("3-resources/launch/pic.png", "theirs");
    f.store.seed("3-resources/launch/pic (moved).png", "also theirs");
    await drainWith(f, f.store);
    expect(f.store.snapshot()["3-resources/launch/pic (moved 2).png"]).toBe("png");
  });

  test("is not settled under a name that could be seen by different people, and nothing is lost", async () => {
    const f = await fixture();
    // The destination name is held back on its own: a sibling name would not be.
    await setExactVisibility(f.store, "3-resources/launch/brief.md", "private");
    await start(f, "1-projects/launch", "3-resources/launch");
    f.store.seed("3-resources/launch/brief.md", "# Someone else's brief\n");
    await expect(drainWith(f, f.store, 4)).rejects.toThrow("did not drain");

    const snapshot = f.store.snapshot();
    expect(snapshot["1-projects/launch/brief.md"]).toBe("# Brief\n");
    expect(snapshot["3-resources/launch/brief.md"]).toBe("# Someone else's brief\n");
    expect(Object.keys(snapshot).some((key) => key.includes("(moved)"))).toBe(false);
    // Everything else moved; the move shows why it is waiting.
    expect(snapshot["3-resources/launch/pic.png"]).toBe("png");
    const [row] = await queueRows(f);
    expect(row!.attempts).toBeGreaterThan(0);
    expect(row!.lastError).toBe(MOVE_FAILED_CONFLICT);
  });

  test("a deleted file's marker holding the name is a clash too, not a failure for ever", async () => {
    const f = await fixture();
    const view = withLogicalDelete(f.store) as unknown as Store;
    await view.put("3-resources/launch/pic.png", "old png", { contentType: "image/png" });
    await view.delete("3-resources/launch/pic.png");
    await start(f, "1-projects/launch", "3-resources/launch");
    await drainWith(f, view);
    expect(f.store.snapshot()["3-resources/launch/pic (moved).png"]).toBe("png");
    expect(await queueRows(f)).toEqual([]);
  });

  test("a note clashing under a team folder is kept beside it", async () => {
    const f = await fixture();
    await start(f, "1-projects/launch", "3-resources/launch");
    f.store.seed("3-resources/launch/brief.md", "# Someone else's brief\n");
    await drainWith(f, f.store);
    const snapshot = f.store.snapshot();
    expect(snapshot["3-resources/launch/brief.md"]).toBe("# Someone else's brief\n");
    expect(snapshot["3-resources/launch/brief (moved).md"]).toContain("# Brief");
  });
});

describe("a file that fails", () => {
  test("a few times is retried in place and the move finishes in one pass", async () => {
    const f = await fixture();
    let left = 2;
    const store = faulty(f.store, (method, key) => method === "put" && key === "3-resources/launch/pic.png" && left-- > 0);
    await start(f, "1-projects/launch", "3-resources/launch");
    expect(await drainWith(f, store)).toBe(1);
    expect(f.store.snapshot()["3-resources/launch/pic.png"]).toBe("png");
  });

  test("every time does not hold up the rest, shows as failing, and moves once storage takes it", async () => {
    const f = await fixture();
    let broken = true;
    const store = faulty(f.store, (method, key) => broken && method === "put" && key === "3-resources/launch/pic.png");
    await start(f, "1-projects/launch", "3-resources/launch");
    await expect(drainWith(f, store, 3)).rejects.toThrow("did not drain");

    const stuck = bucketKeys(f.store).filter((key) => key.includes("launch"));
    expect(stuck).toEqual([
      "1-projects/launch/pic.png",
      "3-resources/launch/brief.md",
      "3-resources/launch/plan.md",
      "3-resources/launch/sub/deep.md",
    ]);
    const [row] = await queueRows(f);
    expect(row!.lastError).toBe(MOVE_FAILED_STORAGE);
    expect(row!.attempts).toBe(2);

    broken = false;
    await drainWith(f, store);
    expect(f.store.snapshot()["3-resources/launch/pic.png"]).toBe("png");
  });
});

describe("a file too large to read through here", () => {
  test("on a bucket that cannot copy it itself is reported, not attempted, and the rest still move", async () => {
    const f = await fixture();
    f.store.seed("1-projects/launch/huge.mov", new Uint8Array(BUFFERED_MAX_BYTES + 1));
    let touched = false;
    const store = faulty(f.store, (method, key) => {
      if (key === "1-projects/launch/huge.mov" && method !== "list") touched = true;
      return false;
    });
    await start(f, "1-projects/launch", "3-resources/launch");
    await expect(drainWith(f, store, 3)).rejects.toThrow("did not drain");
    expect(touched).toBe(false);
    expect(f.store.snapshot()["3-resources/launch/brief.md"]).toBe("# Brief\n");
    const [row] = await queueRows(f);
    expect(row!.lastError).toBe(MOVE_FAILED_TOO_LARGE);
  });
});

describe("a pass that dies", () => {
  test("after copying a page loses nothing, and the next pass finishes the move", async () => {
    const f = await fixture();
    let dieOnce = true;
    const ctx = {
      ...f.ctx,
      runMutation: (ref: never, args: unknown) => {
        if (dieOnce && getFunctionName(ref).endsWith("nodes:observe")) {
          dieOnce = false;
          return Promise.reject(new Error("action died"));
        }
        return (f.t.mutation as unknown as Call)(ref, args);
      },
    } as unknown as ActionCtx;
    await start(f, "1-projects/launch", "3-resources/launch");
    await drainWith(f, f.store, 5, ctx);
    expect(bucketKeys(f.store).filter((key) => key.includes("launch"))).toEqual([
      "3-resources/launch/brief.md",
      "3-resources/launch/pic.png",
      "3-resources/launch/plan.md",
      "3-resources/launch/sub/deep.md",
    ]);
  });
});

describe("converges whatever storage does", () => {
  async function bulkMove(rate: number, chaosPasses: number) {
    const f = await fixture();
    for (let index = 0; index < 60; index += 1) {
      f.store.seed(`1-projects/launch/bulk/n${String(index).padStart(2, "0")}.bin`, `bytes ${index}`);
    }
    await start(f, "1-projects/launch", "3-resources/launch");
    let seed = 7;
    const random = () => {
      seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648;
      return seed / 2_147_483_648;
    };
    let chaos = true;
    const store = faulty(f.store, (method, key) => chaos && key !== PRIVACY_KEY && method !== "list" && random() < rate);
    const drained = await drainWith(f, store, chaosPasses).then(() => true, () => false);
    chaos = false;
    if (!drained) await drainWith(f, store, 10);
    return { f, drained };
  }

  function expectLanded(f: Fixture) {
    const snapshot = f.store.snapshot();
    for (let index = 0; index < 60; index += 1) {
      expect(snapshot[`3-resources/launch/bulk/n${String(index).padStart(2, "0")}.bin`]).toBe(`bytes ${index}`);
    }
    expect(snapshot["3-resources/launch/brief.md"]).toBe("# Brief\n");
    expect(snapshot["3-resources/launch/pic.png"]).toBe("png");
    expect(Object.keys(snapshot).filter((key) => key.startsWith("1-projects/launch/") && snapshot[key] !== "")).toEqual([]);
    expect(Object.keys(snapshot).some((key) => key.includes("(moved)"))).toBe(false);
  }

  test("with one call in ten failing at random, the move finishes and every file lands intact", async () => {
    const { f, drained } = await bulkMove(0.1, 100);
    expect(drained).toBe(true);
    expectLanded(f);
  });

  test("with a third of all calls failing, nothing is lost or doubled, and it finishes once storage calms", async () => {
    const { f } = await bulkMove(0.33, 30);
    expectLanded(f);
  });
});

void internal;
