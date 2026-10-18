/**
 * The Trash page and the 30-day emptying (`functions/trash.ts`,
 * `lib/trash/bin.ts`, `lib/trash/erase.ts`; decided by the owner, 2026-10-17).
 *
 * Runs the real functions through `convex-test` over a keyed workspace whose
 * notes' bytes are at their id keys (`keyedFixture`), trashing through
 * `executeOperation` as the console does.
 *
 * Sabotage, each confirmed to fail a case here:
 *  - drop the `canSee` check in `listTrash` and a member is listed the private note;
 *  - drop `rulesAsTrashed` and a note private by its own row reads as its folder's;
 *  - drop the date check in `claimErasure` and a fresh trash is erased;
 *  - drop the keyed check in `claimErasure` and an unkeyed workspace's rows are erased;
 *  - delete the keys before recording them and a failed bucket leaves bytes nobody remembers;
 *  - drop the history erase and the trashed note's editing history stays in the bucket;
 *  - drop `finishErasure` and an erasure is retried forever.
 */

import { readDocument } from "@context/collaboration";
import { describe, expect, test } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { executeOperation } from "../../functions/lib/filesFns/executeOperation";
import { attachQueueMove } from "../../functions/lib/nodes/moveBarrier";
import { eraseWorkspaceTrash } from "../../functions/lib/trash/erase";
import { TRASH_KEEP_MS } from "../../functions/lib/trash/bin";
import { OWNER, fixture, type Fixture } from "../nodes/moveFixture.helpers";
import { keyedFixture, liveAt, rowOf } from "../nodes/keyedFixture.helpers";

const DAY = 24 * 60 * 60 * 1000;
type Moved = { kind: "moved"; from: string; to: string };

/** Trash `path` as the console does, at `now`, with the trail the console writes. */
async function trash(f: Fixture, path: string, now = Date.now(), actorUserId: Id<"users"> = f.ownerId): Promise<string> {
  const args = { workspaceId: f.ws, scope: OWNER.scope, operation: { kind: "trash" } };
  attachQueueMove(f.ctx, args, f.store, f.store);
  const moved = (await executeOperation(f.store, OWNER, { kind: "trash", path }, now)) as Moved;
  await f.t.run(async (ctx) => {
    await ctx.db.insert("auditEvents", {
      workspaceId: f.ws,
      actorUserId,
      action: "file.archive",
      paths: [path, moved.to],
      at: now + 50,
      details: { files: 1, recoverable: true, trash: true },
    });
  });
  return moved.to;
}

const list = (who: Fixture["owner"], f: Fixture) => who.query(api.functions.trash.listTrash, { workspaceId: f.ws });

/** Every collaboration key in the bucket. */
const historyKeys = (f: Fixture) => Object.keys(f.store.snapshot()).filter((key) => key.startsWith(".context/collaboration/"));

async function erasures(f: Fixture) {
  return await f.t.run(async (ctx) => await ctx.db.query("trashErasures").collect());
}

describe("the Trash page lists what is in the trash", () => {
  test("a trashed note, where it was, who moved it, and when it is erased", async () => {
    const f = await keyedFixture();
    const at = Date.now() - 3 * DAY;
    const key = await trash(f, "1-projects/keep.md", at);

    const { items, keepDays } = await list(f.owner, f);

    expect(keepDays).toBe(30);
    expect(items).toEqual([
      { trash: key, path: "1-projects/keep.md", kind: "file", at, eraseAt: at + TRASH_KEEP_MS, byYou: true, byName: null, notes: 1 },
    ]);
    expect((await list(f.member, f)).items).toMatchObject([{ path: "1-projects/keep.md", byYou: false }]);
  });

  test("a trashed folder is one item, with the notes in it counted, soonest erased first", async () => {
    const f = await keyedFixture();
    await trash(f, "1-projects/keep.md", Date.now() - 1 * DAY);
    await trash(f, "1-projects/launch", Date.now() - 20 * DAY);

    const { items } = await list(f.owner, f);

    expect(items.map((item) => [item.path, item.kind, item.notes])).toEqual([
      ["1-projects/launch", "folder", 4],
      ["1-projects/keep.md", "file", 1],
    ]);
  });

  test("a member is not shown a trashed note they could not see", async () => {
    const f = await keyedFixture();
    await trash(f, "1-projects/secret/codes.md");

    expect((await list(f.owner, f)).items.map((item) => item.path)).toEqual(["1-projects/secret/codes.md"]);
    expect((await list(f.member, f)).items).toEqual([]);
  });

  test("with privacy on rows, a note private by its own row stays hidden once its row is in the trash", async () => {
    const f = await keyedFixture();
    await f.t.run(async (ctx) => {
      await ctx.db.insert("nodeMigration", { paused: false, accessSource: "rows", updatedAt: 1 });
      const folder = await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", f.ws).eq("path", "1-projects")).unique();
      await ctx.db.patch(folder!._id, { access: { base: "team" } });
      const keep = await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", f.ws).eq("path", "1-projects/keep.md")).unique();
      await ctx.db.patch(keep!._id, { access: { base: "private" } });
    });
    await trash(f, "1-projects/keep.md");

    expect((await list(f.member, f)).items).toEqual([]);
    expect(await f.member.query(api.functions.trashedNotes.trashedNote, { workspaceId: f.ws, path: "1-projects/keep.md" })).toBeNull();
    expect((await list(f.owner, f)).items.map((item) => item.path)).toEqual(["1-projects/keep.md"]);
  });

  test("an open trashed note is told when it is erased", async () => {
    const f = await keyedFixture();
    const at = Date.now() - 2 * DAY;
    await trash(f, "1-projects/keep.md", at);
    const answer = await f.owner.query(api.functions.trashedNotes.trashedNote, { workspaceId: f.ws, path: "1-projects/keep.md" });
    expect(answer).toMatchObject({ eraseAt: at + TRASH_KEEP_MS });
  });

  test("a workspace that is not keyed lists nothing: its trash is bytes this does not erase", async () => {
    const f = await fixture("s3");
    expect(await list(f.owner, f)).toEqual({ items: [], more: false, keepDays: 30 });
  });

  test("a stranger is refused", async () => {
    const f = await keyedFixture();
    const stranger = await f.t.run(async (ctx) => await ctx.db.insert("users", { email: "x@example.test" } as never));
    await expect(f.t.withIdentity({ subject: stranger }).query(api.functions.trash.listTrash, { workspaceId: f.ws })).rejects.toThrow();
  });
});

describe("emptying the trash after 30 days", () => {
  test("a trash younger than 30 days is not erased", async () => {
    const f = await keyedFixture();
    const key = await trash(f, "1-projects/keep.md", Date.now() - 29 * DAY);

    expect(await f.t.mutation(internal.functions.trash.claimErasure, { workspaceId: f.ws })).toBeNull();
    expect(await liveAt(f, key)).toBe(true);
  });

  test("an old trash is erased: its rows, its grants, its bytes and its editing history", async () => {
    const f = await keyedFixture();
    const opened = await readDocument(f.store, "1-projects/keep.md");
    const before = await rowOf(f, "1-projects/keep.md");
    await f.t.run(async (ctx) => {
      await ctx.db.insert("nodeAccess", { workspaceId: f.ws, nodeId: before._id, granteeKind: "email", granteeEmail: "a@example.test", role: "view", at: 1, source: "share" });
    });
    const key = await trash(f, "1-projects/keep.md", Date.now() - 31 * DAY);
    expect(historyKeys(f).some((name) => name.includes(opened.documentId))).toBe(true);

    const outcome = await eraseWorkspaceTrash(f.ctx, f.ws, async () => f.store);

    expect(outcome).toEqual({ claimed: 1, finished: 1, failed: 0 });
    expect(await f.t.run(async (ctx) => await ctx.db.get(before._id))).toBeNull();
    expect(await f.t.run(async (ctx) => await ctx.db.query("nodeAccess").withIndex("by_node", (q) => q.eq("nodeId", before._id)).collect())).toEqual([]);
    expect(f.store.snapshot()[before.storageKey!]).toBeUndefined();
    expect(historyKeys(f).filter((name) => name.includes(opened.documentId) && !name.includes("/heads/"))).toEqual([]);
    expect((await list(f.owner, f)).items).toEqual([]);
    expect(await erasures(f)).toEqual([]);
    // Restore finds nothing to bring back.
    const args = { workspaceId: f.ws, scope: OWNER.scope, operation: { kind: "restoreTrash" } };
    attachQueueMove(f.ctx, args, f.store, f.store);
    await expect(executeOperation(f.store, OWNER, { kind: "restoreTrash", from: key, to: "1-projects/keep.md" }, Date.now())).rejects.toThrow();
    // The audit says what was erased, and that it was the trash's emptying.
    const audit = await f.t.run(async (ctx) => await ctx.db.query("auditEvents").collect());
    expect(audit).toContainEqual(expect.objectContaining({ action: "file.delete", paths: ["1-projects/keep.md"], details: expect.objectContaining({ erasedFromTrash: true }) }));
  });

  test("only what is due goes: a newer trash and the live notes stay", async () => {
    const f = await keyedFixture();
    await trash(f, "1-projects/launch", Date.now() - 40 * DAY);
    const fresh = await trash(f, "1-projects/keep.md", Date.now() - 1 * DAY);
    const keepBytes = f.store.snapshot()[(await rowOf(f, fresh)).storageKey!];

    await eraseWorkspaceTrash(f.ctx, f.ws, async () => f.store);

    expect((await list(f.owner, f)).items.map((item) => item.path)).toEqual(["1-projects/keep.md"]);
    expect(f.store.snapshot()[(await rowOf(f, fresh)).storageKey!]).toBe(keepBytes);
    expect(await liveAt(f, "1-projects/secret/codes.md")).toBe(true);
  });

  test("a bucket that fails keeps the erasure, and the next pass finishes it", async () => {
    const f = await keyedFixture();
    const key = await trash(f, "1-projects/keep.md", Date.now() - 31 * DAY);
    const storageKey = (await rowOf(f, key)).storageKey!;

    const failed = await eraseWorkspaceTrash(f.ctx, f.ws, async () => {
      throw Object.assign(new Error("down"), { code: "STORAGE_UNAVAILABLE" });
    });

    expect(failed).toEqual({ claimed: 1, finished: 0, failed: 1 });
    expect(await liveAt(f, key)).toBe(false);
    expect(await erasures(f)).toMatchObject([{ keys: [storageKey], attempts: 1, error: "STORAGE_UNAVAILABLE" }]);
    expect(f.store.snapshot()[storageKey]).toBeDefined();

    expect(await eraseWorkspaceTrash(f.ctx, f.ws, async () => f.store)).toEqual({ claimed: 0, finished: 1, failed: 0 });
    expect(f.store.snapshot()[storageKey]).toBeUndefined();
    expect(await erasures(f)).toEqual([]);
  });

  test("a workspace that is not keyed has nothing erased", async () => {
    const f = await keyedFixture();
    const key = await trash(f, "1-projects/keep.md", Date.now() - 31 * DAY);
    await f.t.run(async (ctx) => {
      const layout = await ctx.db.query("noteIdLayout").first();
      await ctx.db.patch(layout!._id, { mode: "ids" });
    });

    expect(await f.t.mutation(internal.functions.trash.claimErasure, { workspaceId: f.ws })).toBeNull();
    expect(await liveAt(f, key)).toBe(true);
  });

  test("the daily pass hands a workspace on only when it is owed an erasure", async () => {
    const f = await keyedFixture();
    const scheduled = async () =>
      (await f.t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect())).filter((job) => job.name.includes("trashEmptying"));
    await trash(f, "1-projects/keep.md", Date.now() - 2 * DAY);
    await f.t.mutation(internal.functions.trash.emptyDue, {});
    expect(await scheduled()).toHaveLength(0);

    await trash(f, "1-projects/launch", Date.now() - 31 * DAY);
    await f.t.mutation(internal.functions.trash.emptyDue, {});
    expect(await scheduled()).toMatchObject([{ args: [{ workspaceId: f.ws }] }]);
  });
});
