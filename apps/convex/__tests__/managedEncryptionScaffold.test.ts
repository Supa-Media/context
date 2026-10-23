/**
 * SCAFFOLDING INTO A SEALED BUCKET — the layout a person picks is written
 * through the same encryption every reader uses.
 *
 * A managed workspace is enrolled when its bucket is bound, and an empty
 * bucket reaches `encrypted` in one walk. The layout is chosen later, so the
 * scaffolder is a writer that arrives *after* the mode is set — and it builds
 * its own store rather than the gateway's. Written plain, its `index.md` and
 * `privacy.md` are refused on every read that follows, and the walk does not
 * come back for them.
 *
 * The probe keeps the bare store deliberately: it writes and deletes its own
 * object under `.context/probes/` with that same store, and nothing reads a
 * probe object through the gateway.
 *
 * ## Sabotage record
 *
 * Applied as local edits, suite re-run, failing tests counted.
 *
 *   scaffold store built without `managedEncryption`                 1
 *   `probeCapabilities` returning before the encryption wrapper      1
 *   the option passed for a workspace with no encryption row         1
 *   no `afterPlainWrites` once a plain layout has landed             1
 */

import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import { asUser, drainScheduled } from "./fixtures.helpers";
import { fixture, isSealed, resetAfterEach, row } from "./managedEncryption.helpers";
import { emptyKeyedFixture, keyOf } from "./keyedFixture.encrypt.helpers";

resetAfterEach();

const PARA = { template: "para" as const, folders: [], kind: "personal" as const };

/** Everything the scaffolder wrote, which is every key that is not a probe. */
function scaffolded(backend: { objects: Map<string, unknown> }): string[] {
  return [...backend.objects.keys()].filter((key) => !key.startsWith(".context/probes/"));
}

describe("a layout applied to a sealed bucket", () => {
  test("is written sealed, and reads back through the product", async () => {
    const { t, staff, ours, backend } = await emptyKeyedFixture();
    await asUser(t, staff).mutation(api.functions.managedEncryption.startRollout, { scope: "ours" });
    await drainScheduled(t);
    expect(await row(t, ours)).toMatchObject({ state: "encrypted" });

    // The bucket a newly provisioned workspace starts with: empty, and already
    // through the walk, because a walk over nothing finishes in one pass.

    await t.action(internal.functions.provisioning.verifyStorageBinding, {
      workspaceId: ours,
      actorUserId: staff,
      structure: PARA,
    });

    const written = scaffolded(backend);
    expect(written).toContain(PRIVACY_KEY);
    // The layout's index note lands at its id key, named by its row.
    expect(written).toContain(await keyOf({ t, workspaceId: ours, backend }, "index.md"));
    for (const key of written) {
      expect(isSealed(backend.bytesOf(key)), `${key} was written in the clear`).toBe(true);
    }

    const note = await asUser(t, staff).action(api.functions.files.readNote, {
      workspaceId: ours,
      path: "index.md",
    });
    expect(note.text.length).toBeGreaterThan(0);
  });

  test("a walk that finishes while the layout is laid plain walks again, and seals it", async () => {
    // @segunawe, 2026-10-14: the layout began while the row was `waiting`, so
    // its store wrote plain; the walk ran over the new bucket at the same
    // moment and was `encrypted` before the last files landed.
    const { t, staff, ours, backend } = await emptyKeyedFixture();
    await t.run(async (ctx) => {
      await ctx.db.insert("managedEncryptionRollout", { state: "running", scope: "ours", acceptsNew: false, updatedAt: Date.now() });
      await ctx.db.insert("managedEncryptionWorkspaces", { workspaceId: ours, state: "waiting", filesDone: 0, runId: 0, updatedAt: Date.now() });
    });
    let raced = false;
    vi.stubGlobal("fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
      const response = await backend.fetchImpl(input, init);
      const url = String(input instanceof Request ? input.url : input);
      // The first layout write that lands: its index note is keyed, so the race is set on the privacy manifest's write.
      if (!raced && init?.method === "PUT" && url.includes(PRIVACY_KEY)) {
        raced = true;
        // The walk, elsewhere, reaching `encrypted` between two layout writes.
        await t.run(async (ctx) => {
          const walked = await ctx.db
            .query("managedEncryptionWorkspaces")
            .withIndex("by_workspace", (q) => q.eq("workspaceId", ours))
            .unique();
          await ctx.db.patch(walked!._id, { state: "encrypted", completedAt: Date.now() });
        });
      }
      return response;
    });

    await t.action(internal.functions.provisioning.verifyStorageBinding, {
      workspaceId: ours,
      actorUserId: staff,
      structure: PARA,
    });
    expect(raced).toBe(true);
    // Walked again under a new run (it may already be under way).
    expect((await row(t, ours))!.runId).toBe(1);
    vi.stubGlobal("fetch", backend.fetchImpl);
    await drainScheduled(t);

    expect(await row(t, ours)).toMatchObject({ state: "encrypted" });
    const written = scaffolded(backend);
    expect(written.length).toBeGreaterThan(2);
    for (const key of written) expect(isSealed(backend.bytesOf(key)), `${key} was left in the clear`).toBe(true);
  });

  test("a bucket nobody enrolled is still written plain", async () => {
    // Same workspace, same bucket — but no rollout, so no encryption row. The
    // fix must not start sealing buckets that were never enrolled.
    const { t, staff, ours, backend } = await emptyKeyedFixture();
    expect(await row(t, ours)).toBeNull();

    await t.action(internal.functions.provisioning.verifyStorageBinding, {
      workspaceId: ours,
      actorUserId: staff,
      structure: PARA,
    });

    const written = scaffolded(backend);
    expect(written.length).toBeGreaterThan(0);
    for (const key of written) {
      expect(isSealed(backend.bytesOf(key)), `${key} was sealed without a rollout`).toBe(false);
    }
  });
});
