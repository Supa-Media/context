/**
 * Old copies hidden, never deleted for the person (owner, 2026-10-21;
 * `functions/oldCopies.ts`, `lib/oldCopies/`). Runs the real functions
 * through `convex-test` over a keyed personal workspace (`oldCopies.helpers.ts`).
 *
 * Sabotage, each confirmed to fail a case here:
 *  - classify every Markdown row as a copy and the person's own notes are hidden;
 *  - drop the `## Notes` check and a contact page they wrote on is hidden;
 *  - let `underHiddenRoot` answer only the trash and nothing moves (`invalid`);
 *  - drop the owner check in `listForExport` and a member is told the hidden names;
 *  - drop the `held` check in `readOldCopyTexts` and a name outside the folder is read;
 *  - let `deleteCopies` run while hiding and the counts the page showed are not what goes;
 *  - drop the `passAt` check in `catchUp` and a second pass starts beside one under way.
 */

import { describe, expect, test } from "vitest";
import { api, internal } from "../../_generated/api";
import { OLD_COPIES_ROOT } from "../../functions/lib/fileOps/store";
import { readOldCopyTexts } from "../../functions/lib/oldCopies/hiding";
import { eraseWorkspaceTrash } from "../../functions/lib/trash/erase";
import { listed } from "../nodes/moveFixture.helpers";
import { liveAt, rowOf } from "../nodes/keyedFixture.helpers";
import { COPIES, OWN, SEEDED, copiesFixture, hideAll } from "./oldCopies.helpers";

const ALL_COPIES = [...COPIES.days, ...COPIES.contacts, ...COPIES.files];
const hidden = (path: string) => `${OLD_COPIES_ROOT}/${path}`;

describe("hiding old copies", () => {
  test("every copy moves to its hidden name with its id and bytes; the person's own notes stay", async () => {
    const f = await copiesFixture();
    const before = Object.fromEntries(await Promise.all(ALL_COPIES.map(async (path) => [path, await rowOf(f, path)] as const)));
    const bytes = f.store.snapshot();

    const counted = await hideAll(f);

    expect(counted).toEqual({ days: 4, contacts: 1, files: 1 });
    for (const path of ALL_COPIES) {
      expect(await liveAt(f, path)).toBe(false);
      const moved = await rowOf(f, hidden(path));
      expect(moved.goneAt).toBeUndefined();
      expect(moved.noteId).toBe(before[path].noteId);
      expect(moved.storageKey).toBe(before[path].storageKey);
    }
    for (const path of OWN) expect(await liveAt(f, path)).toBe(true);
    // Nothing in the bucket was written or removed: a hide is rows only.
    for (const [key, value] of Object.entries(bytes)) {
      if (!key.startsWith(".context/")) expect(f.store.snapshot()[key]).toEqual(value);
    }
  });

  test("the tree no longer lists them, and lists the person's notes where they were", async () => {
    const f = await copiesFixture();
    await hideAll(f);

    expect(await listed(f.owner, f.ws, "0-inbox/email/me")).toEqual(["0-inbox/email/me/my-own-filing.md"]);
    expect(await listed(f.owner, f.ws, "0-inbox/contacts")).toEqual(["0-inbox/contacts/b"]);
    // A folder emptied of copies goes, as any emptied folder does.
    expect(await liveAt(f, "0-inbox/imessage")).toBe(false);
    expect(await liveAt(f, "0-inbox/calendar/me/2026/09")).toBe(false);
  });

  test("the page counts what was hidden, and says the days it spans", async () => {
    const f = await copiesFixture();
    await hideAll(f);

    expect(await f.owner.query(api.functions.oldCopies.summary, { workspaceId: f.ws })).toMatchObject({
      state: "hidden",
      days: 4,
      contacts: 1,
      files: 1,
      firstDay: "2026-09-01",
      lastDay: "2026-10-20",
    });
    expect(await f.member.query(api.functions.oldCopies.summary, { workspaceId: f.ws })).toBeNull();
  });

  test("Keep them hidden is the owner's answer: the row goes and the copies stay", async () => {
    const f = await copiesFixture();
    await hideAll(f);
    await expect(f.member.mutation(api.functions.oldCopies.keepCopies, { workspaceId: f.ws })).rejects.toThrow();
    await f.owner.mutation(api.functions.oldCopies.keepCopies, { workspaceId: f.ws });

    expect(await f.owner.query(api.functions.oldCopies.summary, { workspaceId: f.ws })).toBeNull();
    for (const path of ALL_COPIES) expect(await liveAt(f, hidden(path))).toBe(true);
    expect(await f.owner.action(api.functions.oldCopies.listForExport, { workspaceId: f.ws })).toHaveLength(5);
  });

  test("a workspace is looked through once: a second run moves nothing and counts nothing again", async () => {
    const f = await copiesFixture();
    await hideAll(f);
    expect(await hideAll(f)).toEqual({ days: 0, contacts: 0, files: 0 });
    expect(await f.owner.query(api.functions.oldCopies.summary, { workspaceId: f.ws })).toMatchObject({ days: 4 });
  });

  test("a workspace that is not keyed is left alone until it is", async () => {
    const f = await copiesFixture();
    await f.t.run(async (ctx) => {
      const layout = await ctx.db.query("noteIdLayout").first();
      await ctx.db.patch(layout!._id, { mode: "ids" });
    });
    expect(await hideAll(f)).toEqual({ days: 0, contacts: 0, files: 0 });
    for (const path of ALL_COPIES) expect(await liveAt(f, path)).toBe(true);
  });

  test("the hourly pass hands on keyed personal workspaces not yet looked through, and no others", async () => {
    const f = await copiesFixture();
    const scheduled = async () =>
      (await f.t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect())).filter((job) => job.name.includes("hideWorkspace"));
    await f.t.mutation(internal.functions.oldCopies.catchUp, {});
    expect(await scheduled()).toMatchObject([{ args: [{ workspaceId: f.ws }] }]);

    await f.t.mutation(internal.functions.oldCopies.hideFolders, { workspaceId: f.ws, now: Date.now() });
    await hideAll(f);
    await f.t.run(async (ctx) => {
      for (const job of await ctx.db.system.query("_scheduled_functions").collect()) await ctx.scheduler.cancel(job._id);
    });
    await f.t.mutation(internal.functions.oldCopies.catchUp, {});
    expect((await scheduled()).filter((job) => job.state.kind === "pending")).toEqual([]);
  });
});

test("a pass under way is not started twice beside itself, and one that died is picked up again", async () => {
  const f = await copiesFixture();
  const pending = async () =>
    (await f.t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect())).filter(
      (job) => job.name.includes("hideWorkspace") && job.state.kind === "pending",
    );
  await f.t.mutation(internal.functions.oldCopies.beginPass, { workspaceId: f.ws, now: Date.now() });
  await f.t.mutation(internal.functions.oldCopies.catchUp, {});
  expect(await pending()).toEqual([]);

  // A run that never came back leaves its claim behind; after a while the next look starts it again.
  await f.t.run(async (ctx) => {
    const record = await ctx.db.query("oldCopyHides").first();
    await ctx.db.patch(record!._id, { passAt: Date.now() - 16 * 60_000 });
  });
  await f.t.mutation(internal.functions.oldCopies.catchUp, {});
  expect(await pending()).toHaveLength(1);
});

describe("Download as folders keeps them", () => {
  test("the owner is given every hidden note's name and text", async () => {
    const f = await copiesFixture();
    await hideAll(f);

    const paths = await f.owner.action(api.functions.oldCopies.listForExport, { workspaceId: f.ws });
    expect([...(paths ?? [])].sort()).toEqual([...COPIES.days, ...COPIES.contacts].sort());
    const read = await readOldCopyTexts(f.ctx, f.ws, f.store, paths ?? []);
    for (const result of read) {
      expect(result).toEqual({ path: result.path, outcome: "read", note: { text: SEEDED[result.path] } });
    }
  });

  test("a member is told nothing", async () => {
    const f = await copiesFixture();
    await hideAll(f);
    expect(await f.member.action(api.functions.oldCopies.listForExport, { workspaceId: f.ws })).toEqual([]);
    await expect(f.member.action(api.functions.oldCopies.readForExport, { workspaceId: f.ws, paths: [COPIES.days[0]] })).rejects.toThrow();
  });

  test("only names the folder holds are read: a live note, a climb out and a non-note are not", async () => {
    const f = await copiesFixture();
    await hideAll(f);
    const read = await readOldCopyTexts(f.ctx, f.ws, f.store, [
      OWN[0],
      `../${OWN[0]}`,
      "../../1-projects/keep.md",
      COPIES.files[0],
    ]);
    expect(read.map((result) => result.outcome)).toEqual(["error", "error", "error", "error"]);
  });
});

describe("deleting them is the owner's own step", () => {
  test("Delete removes the rows, then the bytes and editing history, and the page says they are deleted", async () => {
    const f = await copiesFixture();
    await hideAll(f);
    const keys = await Promise.all(ALL_COPIES.map(async (path) => (await rowOf(f, hidden(path))).storageKey as string));

    await f.owner.mutation(api.functions.oldCopies.deleteCopies, { workspaceId: f.ws });
    await f.t.mutation(internal.functions.oldCopies.erasePage, { workspaceId: f.ws });

    for (const path of ALL_COPIES) await expect(rowOf(f, hidden(path))).rejects.toThrow();
    expect(await f.owner.query(api.functions.oldCopies.summary, { workspaceId: f.ws })).toBeNull();
    expect(await f.t.run(async (ctx) => await ctx.db.query("oldCopyHides").first())).toMatchObject({ state: "deleted" });
    expect(await f.owner.action(api.functions.oldCopies.listForExport, { workspaceId: f.ws })).toEqual([]);

    await eraseWorkspaceTrash(f.ctx, f.ws, async () => f.store);
    for (const key of keys) expect(f.store.snapshot()[key]).toBeUndefined();
    for (const path of OWN) expect(await liveAt(f, path)).toBe(true);
    const audit = await f.t.run(async (ctx) => await ctx.db.query("auditEvents").collect());
    expect(audit).toContainEqual(expect.objectContaining({ action: "file.delete", actorUserId: f.ownerId, details: expect.objectContaining({ oldCopies: true, days: 4 }) }));
  });

  test("a member cannot delete them", async () => {
    const f = await copiesFixture();
    await hideAll(f);
    await expect(f.member.mutation(api.functions.oldCopies.deleteCopies, { workspaceId: f.ws })).rejects.toThrow();
    for (const path of ALL_COPIES) expect(await liveAt(f, hidden(path))).toBe(true);
  });

  test("nothing is deleted while the copies are still being hidden", async () => {
    const f = await copiesFixture();
    await f.t.mutation(internal.functions.oldCopies.beginPass, { workspaceId: f.ws, now: Date.now() });
    await expect(f.owner.mutation(api.functions.oldCopies.deleteCopies, { workspaceId: f.ws })).rejects.toThrow(/no hidden copies/);
  });

  test("no timer deletes them: the trash's daily emptying leaves them where they are", async () => {
    const f = await copiesFixture();
    await hideAll(f);
    expect(await f.t.mutation(internal.functions.trash.claimErasure, { workspaceId: f.ws })).toBeNull();
    await eraseWorkspaceTrash(f.ctx, f.ws, async () => f.store);
    for (const path of ALL_COPIES) expect(await liveAt(f, hidden(path))).toBe(true);
  });
});
