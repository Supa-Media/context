/**
 * Moving out of managed storage, then switching back within the week, with an
 * encrypted bucket.
 *
 * A move out keeps Context's copy for a week (`managed-storage.md`), sealed
 * files and all, and a switch back re-adopts that same bucket and copies the
 * owner's (plain) files into it. So after the switch the bucket holds both
 * kinds, and the one thing that must never happen is a plain store over it:
 * sealed bytes served as note text, or saved over.
 *
 * These drive the real cutover mutation in both directions.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted; counts are across this file.
 *  - `managedBucketBound` treating an existing row as new (enrol only): 1
 *    failure (the switched-back workspace reads plain over sealed files).
 *  - The to_customer cutover deleting the row again: 3 failures.
 *  - `tick` counting a moved-out workspace's row as an active walk: 1 failure.
 *  - `keptBucketMode` answering from the current binding (plain): 1 failure.
 *  - `forgetKeptBucket` deleting the row while back on managed storage: 1
 *    failure.
 *  - The deletion forgetting the row before the bucket is gone: 1 failure.
 */

import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { managedBucketName } from "../functions/lib/managedStorage";
import { storeForBinding } from "../../mcp/src/store/factory.js";
import { asUser, createWorkspace, drainScheduled, type TestConvex } from "./fixtures.helpers";
import {
  MANAGED_ENDPOINT,
  bindingOf,
  cancelLaterJobs,
  encryptedThenMovedOut,
  isSealed,
  readyMigration,
  resetAfterEach,
  row,
} from "./managedEncryption.helpers";
import { configured } from "./managedProvisioning/fixtures.helpers";

resetAfterEach();

describe("moving out keeps what the kept bucket needs", () => {
  test("the row stays, the customer's bucket gets no mode, and nothing walks it", async () => {
    const { t, ours } = await encryptedThenMovedOut();
    expect((await bindingOf(t, ours))?.bucket).toBe("customer-owned-context");
    expect(await row(t, ours)).toMatchObject({ state: "encrypted" });
    expect(await t.query(internal.functions.managedEncryption.gatewayMode, { workspaceId: ours })).toBeNull();
  });

  test("a moved-out workspace mid-walk does not hold a walk slot", async () => {
    const { t, owner, ours } = await encryptedThenMovedOut();
    await t.run(async (ctx) => {
      const r = await ctx.db
        .query("managedEncryptionWorkspaces")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", ours))
        .unique();
      await ctx.db.patch(r!._id, { state: "encrypting", phase: "seal" });
      const rollout = await ctx.db.query("managedEncryptionRollout").first();
      await ctx.db.patch(rollout!._id, { state: "running" });
    });
    const waiting: Id<"workspaces">[] = [];
    for (const slug of ["slot-one", "slot-two"]) {
      const id = await createWorkspace(t, owner, slug);
      waiting.push(id);
      await t.run((ctx) =>
        ctx.db.insert("managedEncryptionWorkspaces", {
          workspaceId: id,
          state: "waiting",
          filesDone: 0,
          runId: 0,
          updatedAt: Date.now(),
        }),
      );
    }
    await t.mutation(internal.functions.managedEncryption.tick, { restartActive: false });
    for (const id of waiting) expect((await row(t, id))?.runId).toBe(1);
    await drainScheduled(t);
  });
});

describe("switching back within the week", () => {
  test("re-adopts the sealed bucket, reads both kinds at once, and walks it back to encrypted", async () => {
    const { t, staff, ours, backend } = await encryptedThenMovedOut();
    const sealedBefore = backend.bytesOf("index.md");
    expect(isSealed(sealedBefore)).toBe(true);

    // The copy back into the kept bucket: a note edited while away arrives
    // plain over its sealed copy, a new note arrives plain, and a note they
    // never touched is still the sealed copy from before.
    backend.seed("1-projects/plan.md", "# Plan\n\nEdited in their own bucket.\n");
    backend.seed("1-projects/while-away.md", "# Written while away\n");
    await readyMigration(t, ours, staff, {
      direction: "to_managed",
      bucket: managedBucketName(ours),
      endpoint: MANAGED_ENDPOINT,
    });
    await expect(
      t.mutation(internal.functions.managedProvisioning.finishManagedStorageMigration, { workspaceId: ours }),
    ).resolves.toEqual({ cutover: true });
    await cancelLaterJobs(t);

    // The same transaction as the cutover: never a moment in plain mode.
    expect(await t.query(internal.functions.managedEncryption.gatewayMode, { workspaceId: ours })).toBe("migrating");
    expect(await row(t, ours)).toMatchObject({ state: "encrypting", phase: "count", filesDone: 0 });

    const read = async (path: string) =>
      (await asUser(t, staff).action(api.functions.files.readNote, { workspaceId: ours, path })).text;
    expect(await read("index.md")).toBe("# Ours\n");
    expect(await read("1-projects/plan.md")).toBe("# Plan\n\nEdited in their own bucket.\n");
    expect(await read("1-projects/while-away.md")).toBe("# Written while away\n");

    await drainScheduled(t);
    expect(await row(t, ours)).toMatchObject({ state: "encrypted" });
    for (const [key] of backend.objects) expect(isSealed(backend.bytesOf(key)), key).toBe(true);
    // The untouched note was already sealed and was left as it was.
    expect(backend.bytesOf("index.md")).toEqual(sealedBefore);
    expect(await read("1-projects/plan.md")).toBe("# Plan\n\nEdited in their own bucket.\n");
  });
});

describe("the kept bucket after a move out", () => {
  test("is read in its own mode, so a late pass copies plain text, not ciphertext", async () => {
    const { t, ours, backend } = await encryptedThenMovedOut();
    expect(await t.query(internal.functions.managedEncryption.keptBucketMode, { workspaceId: ours })).toBe("encrypted");
    // What a catch-up pass does with `keptManagedBucketOption`: the kept
    // bucket's credential, in the kept bucket's mode, with the workspace key.
    const key = await t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, { workspaceId: ours });
    const kept = storeForBinding(
      {
        provider: "r2",
        endpoint: MANAGED_ENDPOINT,
        region: "auto",
        bucket: managedBucketName(ours),
        accessKeyId: "managed-token-id",
        secretAccessKey: "managed-secret-not-real",
        workspaceId: ours,
      },
      undefined,
      {
        rawObjects: true,
        managedEncryption: { workspaceId: String(ours), mode: "encrypted", current: key!.current, keys: key!.keys },
      },
    );
    expect(isSealed(backend.bytesOf("1-projects/plan.md"))).toBe(true);
    expect(await (await kept.get("1-projects/plan.md"))!.text()).toBe("# Plan\n\nThe words people typed.\n");
  });

  test("its row goes once the bucket is deleted, and not while it is in use again", async () => {
    const { t, staff, ours } = await encryptedThenMovedOut();
    // Back inside the week: the row is live again and must stay.
    await readyMigration(t, ours, staff, {
      direction: "to_managed",
      bucket: managedBucketName(ours),
      endpoint: MANAGED_ENDPOINT,
    });
    await t.mutation(internal.functions.managedProvisioning.finishManagedStorageMigration, { workspaceId: ours });
    await cancelLaterJobs(t);
    await t.mutation(internal.functions.managedEncryption.forgetKeptBucket, { workspaceId: ours });
    expect(await row(t, ours)).not.toBeNull();
    await drainScheduled(t);
  });

  test("a deleted kept bucket takes its row with it; the workspace keys stay", async () => {
    const { t, ours } = await encryptedThenMovedOut();
    await t.mutation(internal.functions.managedEncryption.forgetKeptBucket, { workspaceId: ours });
    expect(await row(t, ours)).toBeNull();
    expect(await t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, { workspaceId: ours })).not.toBeNull();
  });

  test("the week-later deletion forgets the row only after the bucket is gone", async () => {
    const { t, ours } = await encryptedThenMovedOut();
    await configured(t);
    let refuse = true;
    vi.stubGlobal("fetch", async () =>
      refuse
        ? { ok: false, status: 500, text: async () => "{}", json: async () => ({}), headers: new Headers() }
        : {
            ok: true,
            status: 200,
            // An empty listing, then every delete and revoke answers success.
            text: async () => '{"success":true,"result":[]}',
            json: async () => ({ success: true, result: [] }),
            headers: new Headers(),
          },
    );
    const deletion = () =>
      t.action(internal.functions.managedProvisioning.deleteManagedStorageAfterHandoff, {
        workspaceId: ours,
        bucket: managedBucketName(ours),
        tokenId: "managed-token-id",
      });
    // Cloudflare refused: the bucket and its sealed files are still there.
    await expect(deletion()).rejects.toThrow();
    expect(await row(t, ours)).not.toBeNull();
    refuse = false;
    await deletion();
    expect(await row(t, ours)).toBeNull();
  });
});
