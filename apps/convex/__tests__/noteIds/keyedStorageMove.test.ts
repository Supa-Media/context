/**
 * A keyed workspace whose storage moves to another bucket keeps its tree.
 *
 * In a keyed workspace the rows are the only record of every note's name,
 * folder and access: the bucket holds `notes/<noteId>.md`, which names no
 * path. A storage move copies those keys as they are, so the rows still
 * describe the new bucket. Forgetting them (what a move did while rows were
 * copies of the bucket's names) would leave the workspace with no names at
 * all, and no sweep of the new bucket could bring them back.
 *
 * Sabotage: call `forgetWorkspaceTree` in `applyBinding` again and both cases
 * fail with every row gone.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { ADMIN_EMAILS_ENV_VAR } from "../../functions/lib/admin";
import { keyedFixture, rowOf, treeOf } from "../nodes/keyedFixture.helpers";
import { fixture, type Fixture } from "../nodes/moveFixture.helpers";

let previous: string | undefined;
beforeEach(() => {
  previous = process.env[ADMIN_EMAILS_ENV_VAR];
  process.env[ADMIN_EMAILS_ENV_VAR] = "staff@example.test";
});
afterEach(() => {
  if (previous === undefined) delete process.env[ADMIN_EMAILS_ENV_VAR];
  else process.env[ADMIN_EMAILS_ENV_VAR] = previous;
});

async function bind(f: Fixture, bucket: string): Promise<void> {
  await f.t.run(async (ctx) => {
    const now = Date.now();
    await ctx.db.insert("storageBindings", {
      workspaceId: f.ws,
      provider: "r2",
      bucket,
      endpoint: "https://storage.example.test",
      region: "auto",
      accessKeyId: "fake",
      encryptedSecretAccessKey: "fake",
      capabilities: { conditionalWrite: true },
      status: "connected",
      boundBy: f.ownerId,
      createdAt: now,
      updatedAt: now,
    } as never);
  });
}

async function moveStorage(f: Fixture, bucket: string): Promise<void> {
  await f.t.mutation(internal.functions.storage.applyBinding, {
    actorUserId: f.ownerId as Id<"users">,
    workspaceId: f.ws,
    provider: "r2",
    endpoint: "https://storage.example.test",
    region: "auto",
    bucket,
    accessKeyId: "fake-2",
    encryptedSecretAccessKey: "fake-2",
    cutover: true,
  });
}

const liveRows = async (f: Fixture) => (await treeOf(f)).filter((row) => row.live && !row.path.startsWith("."));

describe("a storage move", () => {
  test("in a keyed workspace keeps every row: names, folders, ids and keys", async () => {
    const f = await keyedFixture();
    await bind(f, "bucket-old");
    const before = await liveRows(f);
    const brief = await rowOf(f, "1-projects/launch/brief.md");
    expect(before.length).toBeGreaterThan(0);

    await moveStorage(f, "bucket-new");

    expect(await liveRows(f)).toEqual(before);
    const after = await rowOf(f, "1-projects/launch/brief.md");
    expect(after._id).toBe(brief._id);
    expect(after.storageKey).toBe(brief.storageKey);
  });

  test("in a keyed workspace checks every key in the new bucket, so rows take its versions", async () => {
    const f = await keyedFixture();
    await bind(f, "bucket-old");
    await moveStorage(f, "bucket-new");
    const scheduled = await f.t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).map((job) => job.name),
    );
    expect(scheduled).toContain("functions/noteIdsCopy:runCheck");
  });

  test("keeps the rows of a workspace whose copy row was never flipped too: every workspace is keyed", async () => {
    const f = await fixture();
    await bind(f, "bucket-old");
    const before = await liveRows(f);
    expect(before.length).toBeGreaterThan(0);
    await moveStorage(f, "bucket-new");
    expect(await liveRows(f)).toEqual(before);
  });
});
