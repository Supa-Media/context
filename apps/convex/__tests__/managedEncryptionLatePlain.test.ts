/**
 * A plain file saved into a managed bucket after its walk declared it sealed.
 *
 * A store built while the workspace was still `waiting` writes plain. When
 * the walk ran over the new bucket at the same moment as the layout step,
 * the last files laid landed after the walk's check and stayed plain under
 * encrypted-only reads: @segunawe's `3-resources/about.md` and
 * `4-archive/about.md` could not be opened, indexed, or read for their links,
 * and admin sat on "Indexing 4 of 6" for good (2026-10-14). These tests seed
 * exactly that state: an encrypted bucket holding one late plain file.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted; counts are across this file.
 *  - `afterPlainWritesHandler` returning before the walk (no rewalk): 1
 *    failure (the late file stays plain).
 *  - `afterPlainWritesHandler` walking a `waiting` row too: 1 failure.
 *  - `resealWorkspaceHandler` without `requireAdmin`: 2 failures (the
 *    refusal, and the audit row naming nobody).
 */

import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { asUser, drainScheduled } from "./fixtures.helpers";
import { fixture, isSealed, managedPlan, resetAfterEach, row } from "./managedEncryption.helpers";

resetAfterEach();

const LATE = "4-archive/about.md";

/** Ours, sealed by the walk, then one plain layout file landing after it. */
async function sealedWithLatePlainFile() {
  const f = await fixture();
  await managedPlan(f.t, f.ours);
  await asUser(f.t, f.staff).mutation(api.functions.managedEncryption.startRollout, { scope: "ours" });
  await drainScheduled(f.t);
  expect(await row(f.t, f.ours)).toMatchObject({ state: "encrypted" });
  f.backend.seed(LATE, "# Archive\n");
  expect(isSealed(f.backend.bytesOf(LATE))).toBe(false);
  return f;
}

describe("a plain file that landed after the walk", () => {
  test("a writer that began plain walks the bucket again when it finishes", async () => {
    const { t, ours, backend } = await sealedWithLatePlainFile();
    await expect(t.mutation(internal.functions.managedEncryption.afterPlainWrites, { workspaceId: ours })).resolves.toBe(true);
    // Reads accept both kinds while it walks, so the file opens at once.
    expect(await row(t, ours)).toMatchObject({ state: "encrypting" });
    await drainScheduled(t);
    expect(await row(t, ours)).toMatchObject({ state: "encrypted" });
    for (const [key] of backend.objects) expect(isSealed(backend.bytesOf(key)), key).toBe(true);
  });

  test("a walk that has not started yet is left to find the files itself", async () => {
    const { t, ours, backend } = await (async () => {
      const f = await fixture();
      await f.t.run((ctx) =>
        ctx.db.insert("managedEncryptionWorkspaces", { workspaceId: f.ours, state: "waiting", filesDone: 0, runId: 0, updatedAt: Date.now() }),
      );
      return f;
    })();
    await expect(t.mutation(internal.functions.managedEncryption.afterPlainWrites, { workspaceId: ours })).resolves.toBe(false);
    expect(await row(t, ours)).toMatchObject({ state: "waiting", runId: 0 });
    expect(isSealed(backend.bytesOf("index.md"))).toBe(false);
  });

  test("a workspace on its owner's own bucket is never walked", async () => {
    const { t, theirs } = await fixture();
    await t.run(async (ctx) => {
      const binding = await ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", theirs))
        .unique();
      await ctx.db.patch(binding!._id, { bucket: "customer-owned-context" });
      await ctx.db.insert("managedEncryptionWorkspaces", { workspaceId: theirs, state: "encrypted", filesDone: 0, runId: 0, updatedAt: Date.now() });
    });
    await expect(t.mutation(internal.functions.managedEncryption.afterPlainWrites, { workspaceId: theirs })).resolves.toBe(false);
    expect(await row(t, theirs)).toMatchObject({ state: "encrypted", runId: 0 });
  });

  test("staff's Seal again repairs a workspace already left like that, and is audited", async () => {
    const { t, staff, ours, backend } = await sealedWithLatePlainFile();
    await asUser(t, staff).mutation(api.functions.managedEncryption.resealWorkspace, { workspaceId: ours });
    await drainScheduled(t);
    expect(await row(t, ours)).toMatchObject({ state: "encrypted" });
    expect(isSealed(backend.bytesOf(LATE))).toBe(true);
    const audit = await t.run((ctx) => ctx.db.query("auditEvents").collect());
    expect(audit.some((event) => event.action === "managed_encryption.reseal" && event.actorUserId === staff)).toBe(true);
  });

  test("only staff may seal again, and only a sealed workspace", async () => {
    const { t, owner, staff, ours, theirs } = await sealedWithLatePlainFile();
    await expect(
      asUser(t, owner).mutation(api.functions.managedEncryption.resealWorkspace, { workspaceId: ours }),
    ).rejects.toThrow();
    expect(await row(t, ours)).toMatchObject({ state: "encrypted" });
    await expect(
      asUser(t, staff).mutation(api.functions.managedEncryption.resealWorkspace, { workspaceId: theirs }),
    ).rejects.toThrow(/sealed managed workspace/);
  });
});
