/**
 * The walk's watchdog: a run that dies without recording anything is started
 * again, instead of leaving the workspace stuck on "Encrypting" for good.
 *
 * A run dies silently when its action times out (an R2 request that never
 * answers holds it until then), runs out of memory, or throws after its page
 * (recording the page itself failing). None of those reach `failWalk`, and
 * nothing schedules the next page, so the row just stops moving; the first
 * production rollout stalled this way. The watchdog restarts a row that has
 * not moved for longer than any run can live, and marks it failed after a few
 * restarts that made no progress, so a page that kills every run stops the
 * rollout visibly rather than looping in silence.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted; counts are across this file.
 *  - Restarting rows however recently they moved: 3 failures.
 *  - Ignoring a paused rollout: 1 failure.
 *  - Ignoring a hand-off under way: 1 failure.
 *  - No stall limit (restarting forever): 3 failures.
 *  - `recordPage` not clearing the stall count: 2 failures.
 *  - Restarting a stopped decrypt (one with an `errorCode`): 1 failure.
 *  - Retry keeping the stall count: 1 failure.
 */

import { afterEach, describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Doc, Id } from "../_generated/dataModel";
import { STALL_AFTER_MS, STALL_LIMIT } from "../functions/lib/managedEncryptionFns/watchdog";
import { asUser, drainScheduled, type TestConvex } from "./fixtures.helpers";
import { ADMIN, fixture, isSealed, resetAfterEach, row } from "./managedEncryption.helpers";

resetAfterEach();

// Runs a restart scheduled and a test left undrained (a failed assertion)
// would otherwise fire into the next test's bucket. Registered after
// `resetAfterEach`, so it runs first, while this test's bucket is still stubbed.
let current: TestConvex | null = null;
afterEach(async () => {
  if (current !== null) await drainScheduled(current).catch(() => {});
  current = null;
});

type Patch = Partial<Doc<"managedEncryptionWorkspaces">>;

async function setRow(t: TestConvex, workspaceId: Id<"workspaces">, patch: Patch) {
  await t.run(async (ctx) => {
    const current = await ctx.db
      .query("managedEncryptionWorkspaces")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    await ctx.db.patch(current!._id, patch);
  });
}

async function setRollout(t: TestConvex, state: Doc<"managedEncryptionRollout">["state"]) {
  await t.run(async (ctx) => {
    const rollout = await ctx.db.query("managedEncryptionRollout").first();
    await ctx.db.patch(rollout!._id, { state });
  });
}

/** A walk that sealed its first page and then died: its next run never came. */
async function stalledMidWalk() {
  const f = await fixture();
  const { t, staff, ours, backend } = f;
  current = t;
  for (let i = 0; i < 20; i += 1) backend.seed(`1-projects/n${i}.md`, `# Note ${i}\n`);
  await asUser(t, staff).mutation(api.functions.managedEncryption.startRollout, { scope: "ours" });
  await drainScheduled(t);
  expect(await row(t, ours)).toMatchObject({ state: "encrypted" });
  // Put it back to mid-walk, as it would read after a run died: encrypting,
  // no run scheduled, not touched for longer than any run can live.
  await setRollout(t, "running");
  await setRow(t, ours, {
    state: "encrypting",
    phase: "seal",
    cursor: undefined,
    completedAt: undefined,
    updatedAt: Date.now() - STALL_AFTER_MS - 1000,
  });
  return f;
}

const restart = (t: TestConvex) => t.mutation(internal.functions.managedEncryption.restartStalledWalks, {});
const age = (t: TestConvex, ours: Id<"workspaces">) => setRow(t, ours, { updatedAt: Date.now() - STALL_AFTER_MS - 1000 });

describe("restarting a stalled walk", () => {
  test("a walk nobody has moved for too long is started again and finishes", async () => {
    const { t, ours, backend } = await stalledMidWalk();
    const before = (await row(t, ours))!.runId;
    await restart(t);
    expect((await row(t, ours))!.runId).toBe(before + 1);
    await drainScheduled(t);
    expect(await row(t, ours)).toMatchObject({ state: "encrypted" });
    for (const [key] of backend.objects) expect(isSealed(backend.bytesOf(key)), key).toBe(true);
  });

  test("a walk that moved recently is left alone", async () => {
    const { t, ours } = await stalledMidWalk();
    await setRow(t, ours, { updatedAt: Date.now() });
    const before = (await row(t, ours))!.runId;
    await restart(t);
    expect((await row(t, ours))!.runId).toBe(before);
  });

  test("a paused rollout stays paused", async () => {
    const { t, ours } = await stalledMidWalk();
    await setRollout(t, "paused");
    const before = (await row(t, ours))!.runId;
    await restart(t);
    expect((await row(t, ours))!.runId).toBe(before);
  });

  test("a walk standing down for a hand-off is not restarted, and never counted as stalled", async () => {
    const { t, staff, ours } = await stalledMidWalk();
    const sourceBindingId = await t.run(async (ctx) =>
      (await ctx.db.query("storageBindings").withIndex("by_workspace", (q) => q.eq("workspaceId", ours)).unique())!._id,
    );
    await t.run((ctx) =>
      ctx.db.insert("managedStorageMigrations", {
        workspaceId: ours,
        sourceBindingId,
        direction: "to_customer",
        targetEndpoint: "https://customer.example.invalid",
        targetBucket: "customer-owned-context",
        targetAccessKeyId: "target-key",
        encryptedTargetSecretAccessKey: "sealed-target",
        status: "copying",
        phase: "copy",
        objectsCopied: 0,
        changesInPass: 0,
        readyToCutover: false,
        startedBy: staff,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );
    for (let i = 0; i <= STALL_LIMIT; i += 1) {
      await restart(t);
      await age(t, ours);
    }
    expect(await row(t, ours)).toMatchObject({ state: "encrypting" });
    expect((await row(t, ours))?.errorCode).toBeUndefined();
    await drainScheduled(t);
  });

  test("restarts that make no progress stop the rollout visibly instead of looping", async () => {
    const f = await stalledMidWalk();
    const { t, ours } = f;
    // Each restart's run dies too: nothing drains, nothing records.
    for (let i = 0; i < STALL_LIMIT; i += 1) {
      await restart(t);
      expect((await row(t, ours))?.state).toBe("encrypting");
      await age(t, ours);
    }
    await restart(t);
    expect(await row(t, ours)).toMatchObject({ state: "failed", errorCode: "STALLED" });
    const rollout = await t.run((ctx) => ctx.db.query("managedEncryptionRollout").first());
    expect(rollout?.state).toBe("failed");
    // Retry is a person choosing to go again: the count starts over.
    await asUser(t, f.staff).mutation(api.functions.managedEncryption.retryWorkspace, { workspaceId: ours });
    expect((await row(t, ours))?.stalls).toBeUndefined();
    // Let the runs the restarts scheduled finish here (they stop at walkPlan)
    // rather than firing into the next test's bucket.
    await drainScheduled(t);
  });

  test("a page recorded after a restart clears the stall count", async () => {
    const { t, ours } = await stalledMidWalk();
    await restart(t);
    const restarted = (await row(t, ours))!;
    expect(restarted.stalls).toBe(1);
    // The restarted run gets through a page.
    await t.mutation(internal.functions.managedEncryption.recordPage, {
      workspaceId: ours,
      runId: restarted.runId,
      phase: "seal",
      nextCursor: "next",
      counted: 0,
      done: 1,
    });
    expect((await row(t, ours))?.stalls).toBeUndefined();
    await drainScheduled(t);
  });
});

describe("the way back", () => {
  test("a stalled decrypt is restarted; a stopped one waits for Decrypt again", async () => {
    const { t, ours } = await stalledMidWalk();
    await setRow(t, ours, { state: "encrypted", phase: undefined });
    await t.mutation(internal.functions.managedEncryption.decryptWorkspace, { workspaceId: ours, operator: ADMIN });
    await age(t, ours);
    await setRollout(t, "paused");
    const before = (await row(t, ours))!.runId;
    await restart(t);
    expect((await row(t, ours))!.runId).toBe(before + 1);
    await drainScheduled(t);
    expect(await row(t, ours)).toMatchObject({ state: "decrypted" });

    await setRow(t, ours, { state: "decrypting", phase: "unseal", errorCode: "VERIFY_FAILED" });
    await age(t, ours);
    const stopped = (await row(t, ours))!.runId;
    await restart(t);
    expect((await row(t, ours))!.runId).toBe(stopped);
  });
});
