/**
 * Phase 4 B2 of `docs/decisions/app-and-console/convex-tree.md`: the walks
 * inside moves, copies and deletes list the tree's names, and pins and
 * recents follow a move for everyone who may see where it went.
 *
 * Runs the real Convex functions (`convex-test`) over an in-memory R2, with a
 * tree swept and proved so it serves (`moveFixture.helpers.ts`).
 *
 * Sabotage, each confirmed to fail a case here (and `places.test.ts` for the
 * barrier's follower):
 *  - make `attachTreeListing` attach nothing, or have `isFolder` or
 *    `keysUnder` list the store, and the delete-while-moving case leaves the
 *    uncopied files to land at the new name, and the copy case lists the bucket;
 *  - drop the renames from the link rewrite's inventory, or list the bucket
 *    there, and the inventory case fails;
 *  - skip `followMovesForMembers` in `activate` and the member's pin stays at
 *    the old name; skip it in `undo` and the pins stay at the new one;
 *  - skip the per-place `canSee` and the member is handed the private name;
 *  - drop `followPlacesAfter` from `nodesTouch` and an agent's move leaves
 *    the member's pin behind; drop `followPlaces()` from the barrier and the
 *    app rename in `places.test.ts` does.
 *
 * Not covered here: that the barrier attaches the listing at all (the
 * function is, its one call site in `fileOperationBarrier.ts` is not).
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { ADMIN_EMAILS_ENV_VAR } from "../../functions/lib/admin";
import { DELETE_CONFIRMATION } from "../../functions/lib/fileOps/deleting";
import { rewriteReferences } from "../../functions/lib/fileOps/references";
import type { FileStore } from "../../functions/lib/fileOps";
import { executeOperation } from "../../functions/lib/filesFns/executeOperation";
import { attachPlacesFollower } from "../../functions/lib/nodes/followPlaces";
import { storeWithMoves } from "../../functions/lib/nodes/moveBarrier";
import { runNodesOperation } from "../../functions/lib/nodes/run";
import { attachTreeListing } from "../../functions/lib/nodes/treeNames";
import { memoryStore } from "../storeStub.helpers";
import { ADMIN, type Fixture, OWNER, type Store, bucketKeys, drain, fixture, start } from "./moveFixture.helpers";

let previousAdmins: string | undefined;
beforeEach(() => {
  previousAdmins = process.env[ADMIN_EMAILS_ENV_VAR];
  process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
});
afterEach(() => {
  if (previousAdmins === undefined) delete process.env[ADMIN_EMAILS_ENV_VAR];
  else process.env[ADMIN_EMAILS_ENV_VAR] = previousAdmins;
});

/** The store an operation gets inside the barrier: through pending moves, with the tree's names attached. */
async function barrierStore(f: Fixture, kind: string): Promise<FileStore> {
  const moves = await f.t.query(internal.functions.nodeMoves.active, { workspaceId: f.ws });
  const view = await storeWithMoves(f.ctx, { workspaceId: f.ws, scope: "private", operation: { kind } }, f.store, moves);
  attachTreeListing(f.ctx, f.ws, view);
  return view;
}

/** Prefixes the bucket was asked to list while `work` ran. */
async function bucketListings(f: Fixture, work: () => Promise<unknown>): Promise<string[]> {
  const asked: string[] = [];
  const list = f.store.list.bind(f.store);
  f.store.list = async (options) => {
    asked.push(options?.prefix ?? "");
    return await list(options);
  };
  try {
    await work();
  } finally {
    f.store.list = list;
  }
  return asked;
}

/** One-go note moves need a conditional delete, which the measured R2 stub lacks; S3 has it. */
function allowNoteMoves(f: Fixture): void {
  Object.assign(f.store, { capabilities: { ...f.store.capabilities, conditionalDelete: true } });
}

async function pinsOf(f: Fixture, who: Fixture["owner"]): Promise<string[]> {
  return (await who.query(api.functions.places.listPins, { workspaceId: f.ws })).map((pin: { path: string }) => pin.path);
}

describe("the walks inside an operation list the tree", () => {
  test("deleting a folder at its new name while it is still moving reaches the files not yet copied", async () => {
    const f = await fixture();
    allowNoteMoves(f);
    await start(f, "1-projects/launch", "3-resources/launch");
    const store = await barrierStore(f, "delete");
    await executeOperation(store, OWNER, { kind: "delete", path: "3-resources/launch", confirmation: DELETE_CONFIRMATION }, Date.now());
    await drain(f);
    const left = bucketKeys(f.store);
    expect(left.filter((key) => key.includes("/launch/"))).toEqual([]);
  });

  test("copying a folder asks the bucket for no listing of it", async () => {
    const f = await fixture();
    const store = await barrierStore(f, "copy");
    const asked = await bucketListings(f, () =>
      executeOperation(store, OWNER, { kind: "copy", from: "1-projects/launch", to: "3-resources/launch-copy" }, Date.now()),
    );
    expect(asked.filter((prefix) => prefix.startsWith("1-projects/launch"))).toEqual([]);
    expect(bucketKeys(f.store)).toContain("3-resources/launch-copy/plan.md");
  });
});

describe("the link rewrite's note inventory", () => {
  test("lists the tree, with this move applied, so the moved note's own links are mended", async () => {
    const store = memoryStore() as Store;
    // The bucket has moved the note; the tree has not heard yet.
    store.seed("3-resources/plan.md", "# Plan\n\nSee [the brief](./brief.md).\n");
    store.seed("1-projects/launch/brief.md", "# Brief\n");
    const rows = ["1-projects/launch/brief.md", "1-projects/launch/plan.md"];
    Object.defineProperty(store, "treeListing", {
      value: { list: async () => ({ objects: rows.map((key) => ({ key })), truncated: false }) },
    });
    let bucketListed = false;
    const list = store.list.bind(store);
    store.list = async (options) => {
      bucketListed = true;
      return await list(options);
    };
    await rewriteReferences(store, {
      clearance: OWNER,
      state: { rules: [], overrides: new Map(), text: null, etag: null, invalid: false },
      renames: new Map([["1-projects/launch/plan.md", "3-resources/plan.md"]]),
    });
    expect(store.snapshot()["3-resources/plan.md"]).toContain("](../1-projects/launch/brief.md)");
    expect(bucketListed).toBe(false);
  });
});

describe("pins and recents follow a move", () => {
  test("a queued move carries a member's pin when they may see the new name, and undo brings it back", async () => {
    const f = await fixture();
    await f.member.mutation(api.functions.places.pin, { workspaceId: f.ws, path: "1-projects/launch", kind: "folder" });
    await f.owner.mutation(api.functions.places.pin, { workspaceId: f.ws, path: "1-projects/launch/plan.md", kind: "note" });
    await start(f, "1-projects/launch", "3-resources/launch");
    expect(await pinsOf(f, f.member)).toEqual(["3-resources/launch"]);
    expect(await pinsOf(f, f.owner)).toEqual(["3-resources/launch/plan.md"]);

    const [row] = await f.t.run((ctx) => ctx.db.query("moveQueue").collect());
    await f.staff.mutation(api.functions.nodeMovesAdmin.undo, { id: row!._id });
    expect(await pinsOf(f, f.member)).toEqual(["1-projects/launch"]);
    expect(await pinsOf(f, f.owner)).toEqual(["1-projects/launch/plan.md"]);
  });

  test("a member is never handed a name they may not see; the owner's pin follows", async () => {
    const f = await fixture();
    await f.member.mutation(api.functions.places.pin, { workspaceId: f.ws, path: "1-projects/launch", kind: "folder" });
    await f.member.mutation(api.functions.places.recordRecent, { workspaceId: f.ws, path: "1-projects/launch/plan.md" });
    await f.owner.mutation(api.functions.places.pin, { workspaceId: f.ws, path: "1-projects/launch", kind: "folder" });
    await start(f, "1-projects/launch", "1-projects/secret/launch");
    expect(await pinsOf(f, f.member)).toEqual(["1-projects/launch"]);
    const recents = await f.member.query(api.functions.places.recentNotes, { workspaceId: f.ws });
    expect(recents.map((row: { path: string }) => row.path)).toEqual(["1-projects/launch/plan.md"]);
    expect(await pinsOf(f, f.owner)).toEqual(["1-projects/secret/launch"]);
  });

  test("a move made in one go through the barrier carries every member's pin", async () => {
    const f = await fixture();
    await f.member.mutation(api.functions.places.pin, { workspaceId: f.ws, path: "1-projects/keep.md", kind: "note" });
    allowNoteMoves(f);
    const store = await barrierStore(f, "move");
    const follow = attachPlacesFollower(f.ctx, f.ws, store);
    await executeOperation(store, OWNER, { kind: "move", from: "1-projects/keep.md", to: "3-resources/keep.md" }, Date.now());
    await follow();
    expect(await pinsOf(f, f.member)).toEqual(["3-resources/keep.md"]);
  });

  test("an agent's move, told to the tree, carries every member's pin", async () => {
    const f = await fixture();
    await f.member.mutation(api.functions.places.pin, { workspaceId: f.ws, path: "1-projects/keep.md", kind: "note" });
    // The gateway moved it, then told the tree what it touched and what it moved.
    f.store.seed("3-resources/keep.md", "# Keep\n");
    await f.store.delete("1-projects/keep.md");
    await runNodesOperation(
      f.ctx,
      {
        workspaceId: f.ws as Id<"workspaces">,
        scope: "private",
        operation: {
          kind: "nodesTouch",
          paths: ["1-projects/keep.md", "3-resources/keep.md"],
          files: [],
          moves: [{ from: "1-projects/keep.md", to: "3-resources/keep.md" }],
        },
      },
      f.store,
    );
    expect(await pinsOf(f, f.member)).toEqual(["3-resources/keep.md"]);
  });
});
