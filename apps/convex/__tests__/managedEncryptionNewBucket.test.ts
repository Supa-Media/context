/**
 * A workspace that gets its managed bucket while the rollout covers every
 * workspace: the walk waits for the bucket's new credential to settle.
 *
 * Provisioning mints a bucket and a key scoped to it, binds them, and joins
 * the rollout in the same transaction. R2 makes a new key usable at the S3
 * endpoint only eventually (`R2_CREDENTIAL_SETTLE_MS`), which is why the
 * binding stays `unverified` until a probe retried across that window has
 * answered. The walk used to start at once, met the refusal on its first
 * listing, and failed the workspace (pausing the whole rollout), and staff's
 * Retry minutes later then worked without anything changing. Every new
 * workspace read "Failed check" on the Estate tab.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted; counts are across this file.
 *  - `walkPlanHandler` ignoring an unverified binding (the old behaviour):
 *    2 failures (the new workspace fails on the refused listing).
 *  - No limit on the wait: 1 failure (a binding stuck unverified waits
 *    forever instead of stopping visibly).
 *  - The settle check ahead of the rollout's pause: 1 failure (a paused
 *    rollout keeps a waiting walk alive).
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { enrollNewManagedWorkspace } from "../functions/lib/managedEncryptionFns/rollout";
import { WALK_SETTLE_LIMIT_MS, WALK_SETTLE_POLL_MS } from "../functions/lib/managedEncryptionFns/walk";
import { asUser, type TestConvex } from "./fixtures.helpers";
import { fixture, isSealed, resetAfterEach, row } from "./managedEncryption.helpers";

resetAfterEach();
afterEach(() => {
  vi.useRealTimers();
});

/** Advance by `ms`, then let every run that follows from it finish. */
async function step(t: TestConvex, ms: number) {
  vi.advanceTimersByTime(ms);
  await t.finishInProgressScheduledFunctions();
  for (let i = 0; i < 40; i += 1) {
    vi.advanceTimersByTime(0);
    await t.finishInProgressScheduledFunctions();
  }
}

async function setBinding(t: TestConvex, workspaceId: Id<"workspaces">, status: "unverified" | "connected" | "error") {
  await t.run(async (ctx) => {
    const binding = await ctx.db
      .query("storageBindings")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    await ctx.db.patch(binding!._id, { status, updatedAt: Date.now() });
  });
}

/**
 * Our bucket, as R2 answers a key minted moments ago: every request is
 * refused until `settled` is set.
 */
async function newlyProvisioned() {
  vi.useFakeTimers();
  const f = await fixture();
  const state = { settled: false };
  vi.stubGlobal("fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    if (!state.settled) {
      return new Response(
        '<?xml version="1.0" encoding="UTF-8"?><Error><Code>AccessDenied</Code><Message>Access Denied</Message></Error>',
        { status: 403, headers: { "content-type": "application/xml" } },
      );
    }
    return await f.backend.fetchImpl(input, init);
  });
  await setBinding(f.t, f.ours, "unverified");
  await f.t.run(async (ctx) => {
    await ctx.db.insert("managedEncryptionRollout", {
      state: "running",
      scope: "all",
      acceptsNew: true,
      updatedAt: Date.now(),
    });
  });
  // What `completeManagedProvisioning` does, through `managedBucketBound`.
  await f.t.run((ctx) => enrollNewManagedWorkspace(ctx, f.ours));
  return { ...f, state };
}

async function rolloutState(t: TestConvex) {
  return await t.run(async (ctx) => (await ctx.db.query("managedEncryptionRollout").first())?.state);
}

describe("a workspace whose managed bucket was just provisioned", () => {
  test("waits for the bucket to answer, then encrypts without anyone pressing Retry", async () => {
    const { t, ours, backend, state } = await newlyProvisioned();
    await step(t, 0);
    expect(await row(t, ours)).toMatchObject({ state: "waiting" });
    expect(await rolloutState(t)).toBe("running");

    // Still settling a poll later: still waiting, still nothing failed.
    await step(t, WALK_SETTLE_POLL_MS);
    expect(await row(t, ours)).toMatchObject({ state: "waiting" });

    // The verifier's probe gets through and marks the binding connected.
    state.settled = true;
    await setBinding(t, ours, "connected");
    await step(t, WALK_SETTLE_POLL_MS);

    expect(await row(t, ours)).toMatchObject({ state: "encrypted", filesDone: 3, filesTotal: 3 });
    for (const [key] of backend.objects) expect(isSealed(backend.bytesOf(key)), key).toBe(true);
    expect(await rolloutState(t)).not.toBe("failed");
  });

  test("a bucket that never answers still stops visibly, rather than waiting forever", async () => {
    const { t, ours } = await newlyProvisioned();
    await step(t, 0);
    for (let waited = 0; waited <= WALK_SETTLE_LIMIT_MS; waited += WALK_SETTLE_POLL_MS) {
      await step(t, WALK_SETTLE_POLL_MS);
    }
    expect(await row(t, ours)).toMatchObject({ state: "failed" });
    expect(await rolloutState(t)).toBe("failed");
  });

  test("a verification that failed is an answer: the walk does not wait on it", async () => {
    const { t, ours } = await newlyProvisioned();
    await setBinding(t, ours, "error");
    await step(t, 0);
    expect(await row(t, ours)).toMatchObject({ state: "failed" });
  });

  test("a pause stops the wait too", async () => {
    const { t, staff, ours } = await newlyProvisioned();
    await step(t, 0);
    await asUser(t, staff).mutation(api.functions.managedEncryption.pauseRollout, { reason: "Looking at it" });
    // Still settling, but paused: the wait stops at its next look.
    await step(t, WALK_SETTLE_POLL_MS);
    // Nothing more is scheduled, and the row was never started.
    expect(await row(t, ours)).toMatchObject({ state: "waiting" });
    const pending = await t.run(async (ctx) =>
      (await ctx.db.system.query("_scheduled_functions").collect()).filter((job) => job.state.kind === "pending"),
    );
    expect(pending).toEqual([]);
  });
});
