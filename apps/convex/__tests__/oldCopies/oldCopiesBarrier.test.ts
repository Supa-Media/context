/**
 * Old copies hidden through the real path production runs: `hideWorkspace`
 * calling `runFileOperation` against a bound bucket, not the pass function
 * handed a store (`oldCopies.test.ts`).
 */

import { afterEach, expect, test, vi } from "vitest";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { OLD_COPIES_ROOT } from "../../functions/lib/fileOps/store";
import { PRIVACY_KEY } from "../../functions/lib/privacy";
import { renderPrivacyManifest } from "../../functions/lib/scaffold";
import { FAKE_STORAGE, createUser, createWorkspace, seedStorageBinding, setupTest, type TestConvex } from "../fixtures.helpers";
import { memoryS3 } from "../storeStub.helpers";
import { CHANNEL_FOLDERS } from "../../functions/lib/oldCopies/folders";
import { COPIES, OWN, SEEDED } from "./oldCopies.helpers";

const deployments: TestConvex[] = [];

afterEach(async () => {
  for (const t of deployments.splice(0)) {
    await t.run(async (ctx) => {
      for (const job of await ctx.db.system.query("_scheduled_functions").collect()) {
        if (job.state.kind === "pending") await ctx.scheduler.cancel(job._id);
      }
    });
  }
  vi.unstubAllGlobals();
});

async function boundWorkspace() {
  const t = setupTest();
  deployments.push(t);
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "copies-owner");
  const bucket = memoryS3(FAKE_STORAGE.bucket);
  bucket.seed(PRIVACY_KEY, renderPrivacyManifest("para"));
  for (const [path, text] of Object.entries(SEEDED)) bucket.seed(path, text);
  vi.stubGlobal("fetch", bucket.fetchImpl);
  await seedStorageBinding(t, { workspaceId, boundBy: owner });
  await t.action(internal.functions.files.runFileOperation, { workspaceId, scope: "private", operation: { kind: "nodesSweep" } });
  // Keyed, as every production workspace is: each note's bytes at its id key.
  const keys = await t.run(async (ctx) => {
    await ctx.db.insert("noteIdLayout", { paused: false, mode: "keys", updatedAt: 1 });
    await ctx.db.insert("noteIdCopies", { workspaceId, status: "done", runId: 1, files: 0, copied: 0, failed: 0, failures: [], updatedAt: 1, keyedAt: 1 });
    const found: Record<string, string> = {};
    for (const row of await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId)).collect()) {
      if (row.kind !== "file" || row.noteId === undefined || !(row.path in SEEDED)) continue;
      const dot = row.path.lastIndexOf(".");
      const key = row.path.endsWith(".md") ? `notes/${row.noteId}.md` : `files/${row.noteId}${row.path.slice(dot)}`;
      await ctx.db.patch(row._id, { storageKey: key });
      found[row.path] = key;
    }
    return found;
  });
  for (const [path, key] of Object.entries(keys)) bucket.seed(key, SEEDED[path]);
  return { t, workspaceId, keys };
}

async function livePaths(t: TestConvex, workspaceId: Id<"workspaces">): Promise<string[]> {
  return await t.run(async (ctx) =>
    (await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId)).collect())
      .filter((row) => row.goneAt === undefined)
      .map((row) => row.path),
  );
}

test("the job hides every copy through the bucket it is bound to", async () => {
  const { t, workspaceId } = await boundWorkspace();

  const ran = await t.action(internal.functions.oldCopies.hideWorkspace, { workspaceId });

  expect(ran.done).toBe(true);
  const live = await livePaths(t, workspaceId);
  // The Inbox's channel folders go whole, everything in them (owner, 2026-10-22: nothing in them is theirs).
  const inChannels = Object.keys(SEEDED).filter((path) => CHANNEL_FOLDERS.some((name) => path.startsWith(`0-inbox/${name}/`)));
  for (const path of [...COPIES.days, ...COPIES.contacts, ...COPIES.files, ...inChannels]) {
    expect(live).not.toContain(path);
    expect(live).toContain(`${OLD_COPIES_ROOT}/${path}`);
  }
  for (const folder of CHANNEL_FOLDERS.filter((name) => name !== "google-chat")) expect(live).not.toContain(`0-inbox/${folder}`);
  for (const path of OWN.filter((own) => !inChannels.includes(own))) expect(live).toContain(path);
  const record = await t.run(async (ctx) => await ctx.db.query("oldCopyHides").first());
  expect(record).toMatchObject({ state: "hidden", days: 5, contacts: 2, files: 1, firstDay: "2026-09-01", lastDay: "2026-10-20" });
  expect(record?.foldersAt).toBeDefined();
  expect(record?.passAt).toBeUndefined();
  // Finished: nothing handed on.
  const next = (await t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect())).filter(
    (job) => job.name.includes("hideWorkspace") && job.state.kind === "pending",
  );
  expect(next).toEqual([]);
});

test("a workspace another move is still carrying waits, and its Settings row says why", async () => {
  const { t, workspaceId } = await boundWorkspace();
  await t.run(async (ctx) => {
    await ctx.db.insert("moveQueue", {
      workspaceId,
      from: "1-projects/a",
      to: "1-projects/b",
      kind: "folder",
      state: "moving",
      scope: "private",
      grantedNames: [],
      total: 1,
      moved: 0,
      added: { folders: [], notes: [] },
      attempts: 0,
      nextAt: Date.now() + 60_000,
      createdAt: 1,
      updatedAt: 1,
    });
  });

  const ran = await t.action(internal.functions.oldCopies.hideWorkspace, { workspaceId });

  expect(ran.done).toBe(false);
  const live = await livePaths(t, workspaceId);
  for (const path of COPIES.days) expect(live).toContain(path);
  expect(await t.run(async (ctx) => await ctx.db.query("oldCopyHides").first())).toMatchObject({ state: "hiding", problem: "busy" });
  expect((await t.run(async (ctx) => await ctx.db.query("oldCopyHides").first()))?.passAt).toBeUndefined();
});

test("copies still read at their path, left under 0-inbox by a rename of the Inbox, are hidden too", async () => {
  const { t, workspaceId } = await boundWorkspace();
  // The rename moved the Inbox's own row to `inbox`; what it could not carry stayed under `0-inbox`, unkeyed.
  await t.run(async (ctx) => {
    const rows = await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId)).collect();
    for (const row of rows) {
      if (row.path === "0-inbox") await ctx.db.insert("nodes", { ...row, _id: undefined, _creationTime: undefined, path: "inbox", name: "inbox" } as never);
      if (row.kind === "file" && row.path.startsWith("0-inbox/")) await ctx.db.patch(row._id, { storageKey: undefined });
    }
  });

  await t.action(internal.functions.oldCopies.hideWorkspace, { workspaceId });

  const live = await livePaths(t, workspaceId);
  for (const path of [...COPIES.days, ...COPIES.contacts]) {
    expect(live).not.toContain(path);
    expect(live).toContain(`${OLD_COPIES_ROOT}/${path}`);
  }
  // Pinned where its bytes are, so the owner's Download still reads it.
  const day = await t.run(async (ctx) =>
    await ctx.db.query("nodes").withIndex("by_workspace_path", (q) => q.eq("workspaceId", workspaceId).eq("path", `${OLD_COPIES_ROOT}/${COPIES.days[0]}`)).unique(),
  );
  expect(day?.storageKey).toBe(COPIES.days[0]);
  const read = await t.action(internal.functions.files.runFileOperation, {
    workspaceId,
    scope: "private",
    operation: { kind: "readOldCopies", paths: [COPIES.days[0]] },
  });
  expect(read).toMatchObject({ kind: "oldCopyTexts", results: [{ outcome: "read", note: { text: SEEDED[COPIES.days[0]] } }] });
});

test("a workspace an older folder step already looked at is looked at again", async () => {
  const { t, workspaceId } = await boundWorkspace();
  await t.run(async (ctx) => {
    await ctx.db.insert("oldCopyHides", { workspaceId, state: "hidden", days: 0, contacts: 0, files: 0, startedAt: 1, foldersAt: 1, hiddenAt: 1 });
  });
  await t.mutation(internal.functions.oldCopies.catchUp, {});
  const queued = (await t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect())).filter(
    (job) => job.name.includes("hideWorkspace") && job.state.kind === "pending",
  );
  expect(queued).toHaveLength(1);

  await t.action(internal.functions.oldCopies.hideWorkspace, { workspaceId });
  expect(await livePaths(t, workspaceId)).not.toContain(COPIES.days[0]);
  expect(await t.run(async (ctx) => await ctx.db.query("oldCopyHides").first())).toMatchObject({ foldersVersion: 2, days: 5 });
});
