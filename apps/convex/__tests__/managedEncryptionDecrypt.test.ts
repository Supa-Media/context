/**
 * The way back: staff decrypt one managed workspace, and its bucket returns
 * to plain bytes.
 *
 * What must hold, each a test: the moment staff press Decrypt, reads accept
 * both kinds and new saves land plain; the walk ends with every object plain
 * and the workspace in plain mode; a failure stops only this workspace and
 * never pauses (or restarts) the rollout; nothing re-encrypts a decrypted
 * workspace unless staff pick it again; and only staff can start it.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted; counts are across this file.
 *  - `gatewayModeFor("decrypting")` answering `migrating` (writes sealed): 2
 *    failures.
 *  - `gatewayModeFor("decrypted")` answering `decrypting`: 3 failures.
 *  - The confirm phase skipping its re-read: 1 failure.
 *  - `failWalkHandler` treating a decrypt failure like an encrypt failure
 *    (row to `failed`, rollout paused): 1 failure.
 *  - `walkPlanHandler` stopping a decrypt walk unless the rollout is running:
 *    7 failures.
 *  - `enroll` re-enrolling a decrypted workspace whatever the scope: 1 failure.
 *  - `managedBucketBound` sending a decrypted row back to `encrypting`: 2
 *    failures.
 *  - `decryptWorkspaceHandler` without `requireAdmin`: 1 failure.
 */

import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { managedBucketBound } from "../functions/lib/managedEncryptionFns/rollout";
import { asUser, drainScheduled, type TestConvex } from "./fixtures.helpers";
import { fixture, isSealed, resetAfterEach, row } from "./managedEncryption.helpers";

resetAfterEach();

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function encrypted(options: Parameters<typeof fixture>[0] = {}): Promise<Fixture> {
  const f = await fixture(options);
  await asUser(f.t, f.staff).mutation(api.functions.managedEncryption.startRollout, { scope: "ours" });
  await drainScheduled(f.t);
  expect(await row(f.t, f.ours)).toMatchObject({ state: "encrypted" });
  for (const [key] of f.backend.objects) expect(isSealed(f.backend.bytesOf(key)), key).toBe(true);
  return f;
}

const mode = (t: TestConvex, workspaceId: Id<"workspaces">) =>
  t.query(internal.functions.managedEncryption.gatewayMode, { workspaceId });

async function read(t: TestConvex, as: Id<"users">, workspaceId: Id<"workspaces">, path: string) {
  return (await asUser(t, as).action(api.functions.files.readNote, { workspaceId, path })).text;
}

async function decrypt(f: Fixture) {
  await asUser(f.t, f.staff).mutation(api.functions.managedEncryption.decryptWorkspace, { workspaceId: f.ours });
}

describe("decrypting a workspace", () => {
  test("reads both kinds at once, saves land plain, and the walk ends with every object plain", async () => {
    const f = await encrypted();
    const { t, staff, ours, backend } = f;
    await decrypt(f);
    expect(await row(t, ours)).toMatchObject({ state: "decrypting" });
    // Before the walk has run at all: the undo of strict reads is immediate.
    expect(await mode(t, ours)).toBe("decrypting");
    expect(await read(t, staff, ours, "1-projects/plan.md")).toContain("The words people typed.");
    await asUser(t, staff).action(api.functions.files.writeNote, {
      workspaceId: ours,
      path: "1-projects/new.md",
      text: "# New\n\nWritten on the way back.\n",
    });
    expect(isSealed(backend.bytesOf("1-projects/new.md"))).toBe(false);

    await drainScheduled(t);
    expect(await row(t, ours)).toMatchObject({ state: "decrypted" });
    expect(await mode(t, ours)).toBeNull();
    for (const [key] of backend.objects) expect(isSealed(backend.bytesOf(key)), key).toBe(false);
    expect(new TextDecoder().decode(backend.bytesOf("1-projects/plan.md")!)).toBe(
      "# Plan\n\nThe words people typed.\n",
    );
    expect(await read(t, staff, ours, "index.md")).toBe("# Ours\n");
  });

  test("an object still sealed at the confirm pass is opened there, not left behind", async () => {
    const f = await encrypted();
    const { t, ours, backend } = f;
    // A sealed body from before the walk back. The path is not bound, so a
    // copy under another key opens too.
    const sealed = backend.bytesOf("index.md")!;
    await decrypt(f);
    for (let i = 0; i < 20 && (await row(t, ours))?.phase !== "confirm"; i += 1) {
      const current = await row(t, ours);
      await t.action(internal.functions.managedEncryption.runWalk, { workspaceId: ours, runId: current!.runId });
    }
    expect(await row(t, ours)).toMatchObject({ state: "decrypting", phase: "confirm" });
    // As a request built before the switch would have written it.
    backend.seed("0-inbox/late.md", sealed);
    await drainScheduled(t);
    expect(await row(t, ours)).toMatchObject({ state: "decrypted" });
    expect(isSealed(backend.bytesOf("0-inbox/late.md"))).toBe(false);
    expect(new TextDecoder().decode(backend.bytesOf("0-inbox/late.md")!)).toBe("# Ours\n");
  });

  test("a failure stops this workspace only: still decrypting, rollout untouched, Decrypt again finishes", async () => {
    let refuse = false;
    const f = await encrypted({ refuseWrite: (key) => refuse && key === "index.md" });
    const { t, staff, ours, backend } = f;
    refuse = true;
    await decrypt(f);
    await drainScheduled(t);
    const stopped = await row(t, ours);
    expect(stopped).toMatchObject({ state: "decrypting" });
    expect(stopped?.errorCode).toMatch(/^[A-Z_]+$/);
    // Never `failed`: that would read as mid-encryption and seal new saves.
    expect(await mode(t, ours)).toBe("decrypting");
    const rollout = await t.run((ctx) => ctx.db.query("managedEncryptionRollout").first());
    expect(rollout?.state).toBe("complete");
    expect(await read(t, staff, ours, "index.md")).toBe("# Ours\n");

    refuse = false;
    await decrypt(f);
    await drainScheduled(t);
    expect(await row(t, ours)).toMatchObject({ state: "decrypted" });
    expect((await row(t, ours))?.errorCode).toBeUndefined();
    for (const [key] of backend.objects) expect(isSealed(backend.bytesOf(key)), key).toBe(false);
  });

  test("runs while the rollout is paused, since that is when it is needed", async () => {
    const f = await encrypted();
    const { t, staff, ours } = f;
    await t.run(async (ctx) => {
      const rollout = await ctx.db.query("managedEncryptionRollout").first();
      await ctx.db.patch(rollout!._id, { state: "failed" });
    });
    await decrypt(f);
    await drainScheduled(t);
    expect(await row(t, ours)).toMatchObject({ state: "decrypted" });
    expect(await read(t, staff, ours, "1-projects/plan.md")).toContain("The words people typed.");
  });

  test("takes a half-walked workspace back too", async () => {
    let refuse = true;
    const f = await fixture({ refuseWrite: (key) => refuse && key === "index.md" });
    const { t, staff, ours, backend } = f;
    await asUser(t, staff).mutation(api.functions.managedEncryption.startRollout, { scope: "ours" });
    await drainScheduled(t);
    expect(await row(t, ours)).toMatchObject({ state: "failed" });
    refuse = false;
    await decrypt(f);
    await drainScheduled(t);
    expect(await row(t, ours)).toMatchObject({ state: "decrypted" });
    for (const [key] of backend.objects) expect(isSealed(backend.bytesOf(key)), key).toBe(false);
  });

  test("a waiting workspace has nothing sealed, and is simply taken out", async () => {
    const { t, staff, ours } = await fixture();
    await t.run((ctx) =>
      ctx.db.insert("managedEncryptionWorkspaces", { workspaceId: ours, state: "waiting", filesDone: 0, runId: 0, updatedAt: Date.now() }),
    );
    await asUser(t, staff).mutation(api.functions.managedEncryption.decryptWorkspace, { workspaceId: ours });
    expect(await row(t, ours)).toMatchObject({ state: "decrypted" });
    expect(await mode(t, ours)).toBeNull();
  });
});

describe("after decrypting", () => {
  test("a rollout over our workspaces does not take it again; picking it does", async () => {
    const f = await encrypted();
    const { t, staff, ours } = f;
    await decrypt(f);
    await drainScheduled(t);
    await asUser(t, staff).mutation(api.functions.managedEncryption.startRollout, { scope: "ours" });
    await drainScheduled(t);
    expect(await row(t, ours)).toMatchObject({ state: "decrypted" });

    await asUser(t, staff).mutation(api.functions.managedEncryption.startRollout, {
      scope: "picked",
      workspaceIds: [ours],
    });
    await drainScheduled(t);
    expect(await row(t, ours)).toMatchObject({ state: "encrypted" });
  });

  test("binding the managed bucket again leaves it plain", async () => {
    const f = await encrypted();
    const { t, ours } = f;
    await decrypt(f);
    await drainScheduled(t);
    await t.run((ctx) => managedBucketBound(ctx as never, ours));
    expect(await row(t, ours)).toMatchObject({ state: "decrypted" });
    expect(await mode(t, ours)).toBeNull();
  });

  test("owners see no encryption row once it is going back or gone", async () => {
    const f = await encrypted();
    const { t, staff, ours } = f;
    await decrypt(f);
    const during = await asUser(t, staff).query(api.functions.storage.getStorageBinding, { workspaceId: ours });
    expect(during?.encryption ?? null).toBeNull();
    await drainScheduled(t);
    const after = await asUser(t, staff).query(api.functions.storage.getStorageBinding, { workspaceId: ours });
    expect(after?.encryption ?? null).toBeNull();
  });
});

describe("who may decrypt", () => {
  test("staff only, and only a workspace on managed storage with a row", async () => {
    const f = await encrypted();
    const { t, owner, staff, theirs, ours } = f;
    await expect(
      asUser(t, owner).mutation(api.functions.managedEncryption.decryptWorkspace, { workspaceId: ours }),
    ).rejects.toThrow();
    expect(await row(t, ours)).toMatchObject({ state: "encrypted" });
    await expect(
      asUser(t, staff).mutation(api.functions.managedEncryption.decryptWorkspace, { workspaceId: theirs }),
    ).rejects.toThrow(/NOT_ENCRYPTED|never/i);
  });
});
