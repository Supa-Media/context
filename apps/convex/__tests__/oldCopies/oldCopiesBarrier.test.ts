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
  for (const path of [...COPIES.days, ...COPIES.contacts, ...COPIES.files]) {
    expect(live).not.toContain(path);
    expect(live).toContain(`${OLD_COPIES_ROOT}/${path}`);
  }
  for (const path of OWN) expect(live).toContain(path);
  const record = await t.run(async (ctx) => await ctx.db.query("oldCopyHides").first());
  expect(record).toMatchObject({ state: "hidden", days: 4, contacts: 1, files: 1 });
  expect(record?.passAt).toBeUndefined();
  // Finished: nothing handed on.
  const next = (await t.run(async (ctx) => await ctx.db.system.query("_scheduled_functions").collect())).filter(
    (job) => job.name.includes("hideWorkspace") && job.state.kind === "pending",
  );
  expect(next).toEqual([]);
});
