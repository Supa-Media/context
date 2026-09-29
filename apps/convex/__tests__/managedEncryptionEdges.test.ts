/**
 * Managed-storage encryption at its edges: the cases a clean run never meets.
 *
 * Each test is one way the walk could lose, corrupt or expose somebody's
 * notes if it were written carelessly: a page that fails halfway, a key that
 * rotates under it, a run that outlives a pause, a workspace that leaves
 * managed storage mid-walk, a save that lands during the final check, an
 * object that merely looks sealed, and more workspaces than walk slots.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted; counts are across this file.
 *  - `sealObject` skipping the envelope check (sealing sealed bytes again):
 *    2 failures (the retry reads ciphertext, the forged object is sealed over).
 *  - `walkPlanHandler` ignoring `runId`: 1 failure (the stale run writes).
 *  - `walkPlanHandler` ignoring `bindingIsManaged`: 1 failure (the walk
 *    reaches for the customer's bucket after a hand-off).
 *  - The check phase skipping its re-read: 1 failure.
 *  - `walkPlanHandler` and `beginWalkHandler` ignoring a hand-off under way:
 *    1 failure (the bucket is sealed while it is being copied out).
 *  - `WALK_CONCURRENCY` ignored in `tick`: 1 failure.
 *  - `recordPageHandler` keeping the total at the count: 1 failure (the bar
 *    reads more than full).
 */

import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { enrollNewManagedWorkspace } from "../functions/lib/managedEncryptionFns/rollout";
import { SEAL_PAGE } from "../functions/lib/managedEncryptionFns/walk";
import { asUser, createWorkspace, drainScheduled, type TestConvex } from "./fixtures.helpers";
import { fixture, generationOf, isSealed, resetAfterEach, row } from "./managedEncryption.helpers";

resetAfterEach();

async function makeKey(t: TestConvex, workspaceId: Id<"workspaces">) {
  await t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, { workspaceId, create: true });
}

async function read(t: TestConvex, as: Id<"users">, workspaceId: Id<"workspaces">, path: string) {
  const note = await asUser(t, as).action(api.functions.files.readNote, { workspaceId, path });
  return note.text;
}

async function setRow(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  fields: { state: "waiting" | "encrypting" | "checking" | "encrypted" | "failed"; phase?: "count" | "seal" | "check"; runId?: number },
) {
  await t.run(async (ctx) => {
    const existing = await ctx.db
      .query("managedEncryptionWorkspaces")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
      .unique();
    if (existing !== null) await ctx.db.delete(existing._id);
    await ctx.db.insert("managedEncryptionWorkspaces", {
      workspaceId,
      filesDone: 0,
      runId: 0,
      updatedAt: Date.now(),
      ...fields,
    });
  });
}

async function setRollout(t: TestConvex, state: "running" | "paused" | "off", acceptsNew = false) {
  await t.run(async (ctx) => {
    const existing = await ctx.db.query("managedEncryptionRollout").first();
    if (existing !== null) await ctx.db.delete(existing._id);
    await ctx.db.insert("managedEncryptionRollout", { state, scope: "all", acceptsNew, updatedAt: Date.now() });
  });
}

describe("a bucket bigger than one page", () => {
  test("walks every page, and the totals add up", async () => {
    const { t, staff, ours, backend } = await fixture();
    const extra = SEAL_PAGE * 2 + 17;
    for (let i = 0; i < extra; i += 1) backend.seed(`3-resources/n${String(i).padStart(4, "0")}.md`, `# Note ${i}\n`);
    await asUser(t, staff).mutation(api.functions.managedEncryption.startRollout, { scope: "ours" });
    await drainScheduled(t);

    expect(await row(t, ours)).toMatchObject({ state: "encrypted", filesDone: extra + 3, filesTotal: extra + 3 });
    for (const [key] of backend.objects) expect(isSealed(backend.bytesOf(key)), key).toBe(true);
    expect(await read(t, staff, ours, "3-resources/n0200.md")).toBe("# Note 200\n");
  });
});

describe("a page that fails halfway", () => {
  test("stops the workspace, and a retry finishes without sealing anything twice", async () => {
    let refuse = true;
    const { t, staff, ours, backend } = await fixture({ refuseWrite: (key) => refuse && key === "index.md" });
    for (let i = 0; i < 20; i += 1) backend.seed(`2-areas/a${i}.md`, `# Area ${i}\n`);
    await asUser(t, staff).mutation(api.functions.managedEncryption.startRollout, { scope: "ours" });
    await drainScheduled(t);

    expect(await row(t, ours)).toMatchObject({ state: "failed" });
    expect(isSealed(backend.bytesOf("index.md"))).toBe(false);
    // Some of the page was sealed before the failure. Nothing is unreadable
    // meanwhile: a failed workspace reads both kinds.
    expect(await read(t, staff, ours, "index.md")).toBe("# Ours\n");

    refuse = false;
    await asUser(t, staff).mutation(api.functions.managedEncryption.retryWorkspace, { workspaceId: ours });
    await drainScheduled(t);
    expect(await row(t, ours)).toMatchObject({ state: "encrypted" });
    for (let i = 0; i < 20; i += 1) expect(await read(t, staff, ours, `2-areas/a${i}.md`)).toBe(`# Area ${i}\n`);
    expect(await read(t, staff, ours, "index.md")).toBe("# Ours\n");
  });
});

describe("the workspace key rotates", () => {
  test("mid-walk: old and new generations both open, and new saves use the new one", async () => {
    const { t, staff, ours, backend } = await fixture();
    await makeKey(t, ours);
    await setRollout(t, "running");
    await setRow(t, ours, { state: "encrypting", phase: "seal" });
    await asUser(t, staff).action(api.functions.files.writeNote, {
      workspaceId: ours,
      path: "1-projects/before.md",
      text: "# Before\n",
    });
    expect(generationOf(backend.bytesOf("1-projects/before.md"))).toBe("k1");

    await t.action(internal.functions.encryptionKeys.startWorkspaceKeyRotation, { workspaceId: ours });
    await asUser(t, staff).action(api.functions.files.writeNote, {
      workspaceId: ours,
      path: "1-projects/after.md",
      text: "# After\n",
    });
    expect(generationOf(backend.bytesOf("1-projects/after.md"))).toBe("k2");

    await t.mutation(internal.functions.managedEncryption.tick, { restartActive: true });
    await drainScheduled(t);
    // No count ran (the row joined at `seal`), so the total grows with the
    // work rather than the bar reading more than full.
    const done = backend.objects.size;
    expect(await row(t, ours)).toMatchObject({ state: "encrypted", filesDone: done, filesTotal: done });
    expect(generationOf(backend.bytesOf("index.md"))).toBe("k2");
    expect(await read(t, staff, ours, "1-projects/before.md")).toBe("# Before\n");
    expect(await read(t, staff, ours, "1-projects/after.md")).toBe("# After\n");
  });
});

describe("runs that should no longer be running", () => {
  test("a run from before a pause or retry touches nothing", async () => {
    const { t, ours, backend } = await fixture();
    await makeKey(t, ours);
    await setRollout(t, "running");
    await setRow(t, ours, { state: "encrypting", phase: "seal", runId: 5 });
    const before = backend.requests.length;
    await t.action(internal.functions.managedEncryption.runWalk, { workspaceId: ours, runId: 4 });
    expect(backend.requests.length).toBe(before);
    expect(await row(t, ours)).toMatchObject({ state: "encrypting", runId: 5, filesDone: 0 });
  });

  test("a paused rollout stops the walk at its next page", async () => {
    const { t, ours, backend } = await fixture();
    await makeKey(t, ours);
    await setRollout(t, "paused");
    await setRow(t, ours, { state: "encrypting", phase: "seal", runId: 1 });
    await t.action(internal.functions.managedEncryption.runWalk, { workspaceId: ours, runId: 1 });
    expect(isSealed(backend.bytesOf("index.md"))).toBe(false);
  });

  test("a workspace that left managed storage mid-walk is never walked again", async () => {
    const { t, ours, backend } = await fixture();
    await makeKey(t, ours);
    await setRollout(t, "running");
    await setRow(t, ours, { state: "encrypting", phase: "seal", runId: 1 });
    // The hand-off cut over: the binding now points at the customer's bucket.
    await t.run(async (ctx) => {
      const binding = await ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", ours))
        .unique();
      await ctx.db.patch(binding!._id, { bucket: "customer-owned-context" });
    });
    const before = backend.requests.length;
    await t.action(internal.functions.managedEncryption.runWalk, { workspaceId: ours, runId: 1 });
    expect(backend.requests.length).toBe(before);
    // Stopped without writing, rather than failing on (or sealing) the
    // customer's bucket.
    expect(await row(t, ours)).toMatchObject({ state: "encrypting", filesDone: 0 });
    expect(await t.query(internal.functions.managedEncryption.gatewayMode, { workspaceId: ours })).toBeNull();
  });
});

describe("a hand-off to the customer's own bucket", () => {
  test("the walk stands down while one is copying, so no ciphertext is copied out", async () => {
    const { t, staff, ours, backend } = await fixture();
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
    await asUser(t, staff).mutation(api.functions.managedEncryption.startRollout, { scope: "ours" });
    await drainScheduled(t);
    for (const [key] of backend.objects) expect(isSealed(backend.bytesOf(key)), key).toBe(false);
    expect((await row(t, ours))?.state).not.toBe("encrypted");
  });
});

describe("the final check", () => {
  test("seals a plain object that arrived after its page was walked", async () => {
    const { t, ours, backend } = await fixture();
    await makeKey(t, ours);
    await setRollout(t, "running");
    await setRow(t, ours, { state: "checking", phase: "check", runId: 1 });
    // A save from a request that began before the walk did, still plain.
    backend.seed("1-projects/late.md", "# Late\n");
    await t.action(internal.functions.managedEncryption.runWalk, { workspaceId: ours, runId: 1 });
    await drainScheduled(t);
    expect(await row(t, ours)).toMatchObject({ state: "encrypted" });
    expect(isSealed(backend.bytesOf("1-projects/late.md"))).toBe(true);
  });

  test("an object that only looks sealed stops the workspace instead of being served", async () => {
    const { t, staff, ours, backend } = await fixture();
    const forged = new Uint8Array([...new TextEncoder().encode("CTXENC"), 1, 2, 107, 49, ...new Array(90).fill(7)]);
    backend.seed("4-archive/looks-sealed.bin", forged);
    await asUser(t, staff).mutation(api.functions.managedEncryption.startRollout, { scope: "ours" });
    await drainScheduled(t);
    const failed = await row(t, ours);
    expect(failed?.state).toBe("failed");
    expect(failed?.errorCode).toMatch(/^[A-Z_]+$/);
    expect(failed?.errorCode).not.toBe("WALK_FAILED");
    // Left exactly as it was: never sealed over, never deleted.
    expect(backend.bytesOf("4-archive/looks-sealed.bin")).toEqual(forged);
  });
});

describe("scheduling", () => {
  test("walks at most two workspaces at once and queues the rest", async () => {
    const { t, owner } = await fixture();
    await setRollout(t, "running");
    const ids: Id<"workspaces">[] = [];
    for (const slug of ["q-one", "q-two", "q-three"]) {
      const id = await createWorkspace(t, owner, slug);
      ids.push(id);
      await setRow(t, id, { state: "waiting" });
    }
    await t.mutation(internal.functions.managedEncryption.tick, { restartActive: false });
    const runIds = await Promise.all(ids.map(async (id) => (await row(t, id))?.runId));
    expect(runIds.filter((runId) => runId === 1)).toHaveLength(2);
    expect(runIds.filter((runId) => runId === 0)).toHaveLength(1);
  });

  test("a new managed workspace joins only a rollout that covers everyone", async () => {
    const { t, owner } = await fixture();
    const joining = await createWorkspace(t, owner, "joining");
    await setRollout(t, "running", false);
    await t.run((ctx) => enrollNewManagedWorkspace(ctx, joining));
    expect(await row(t, joining)).toBeNull();

    await setRollout(t, "running", true);
    await t.run((ctx) => enrollNewManagedWorkspace(ctx, joining));
    expect(await row(t, joining)).toMatchObject({ state: "waiting" });
  });

  test("stopping keeps every encrypted workspace encrypted", async () => {
    const { t, staff, ours } = await fixture();
    await asUser(t, staff).mutation(api.functions.managedEncryption.startRollout, { scope: "ours" });
    await drainScheduled(t);
    await asUser(t, staff).mutation(api.functions.managedEncryption.stopStartingNew, {});
    expect(await row(t, ours)).toMatchObject({ state: "encrypted" });
    expect(await t.query(internal.functions.managedEncryption.gatewayMode, { workspaceId: ours })).toBe("encrypted");
    vi.unstubAllGlobals();
  });
});
