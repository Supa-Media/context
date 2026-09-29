/**
 * The way back: one managed workspace decrypted, from production access, and its bucket returns
 * to plain bytes.
 *
 * What must hold, each a test: the moment staff press Decrypt, reads accept
 * both kinds and new saves land plain; the walk ends with every object plain
 * and the workspace in plain mode; a failure stops only this workspace and
 * never pauses (or restarts) the rollout; nothing re-encrypts a decrypted
 * workspace unless staff pick it again; and nothing in the app can start it.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted; counts are across this file.
 *  - `gatewayModeFor("decrypting")` answering `migrating` (writes sealed): 2
 *    failures.
 *  - `gatewayModeFor("decrypted")` answering plain: 1 failure (a late sealed
 *    save is served as ciphertext).
 *  - The confirm phase skipping its re-read: 1 failure.
 *  - `failWalkHandler` treating a decrypt failure like an encrypt failure
 *    (row to `failed`, rollout paused): 1 failure.
 *  - `walkPlanHandler` stopping a decrypt walk unless the rollout is running:
 *    7 failures.
 *  - `enroll` re-enrolling a decrypted workspace whatever the scope: 1 failure.
 *  - `managedBucketBound` sending a decrypted row back to `encrypting`: 2
 *    failures.
 *  - `decryptWorkspace` as a public mutation: 1 failure.
 *  - `decryptWorkspaceHandler` accepting a blank operator: 1 failure.
 */

import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { managedBucketBound } from "../functions/lib/managedEncryptionFns/rollout";
import { decryptWorkspace } from "../functions/managedEncryption";
import { asUser, drainScheduled, type TestConvex } from "./fixtures.helpers";
import { ADMIN, fixture, isSealed, resetAfterEach, row } from "./managedEncryption.helpers";

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
  await f.t.mutation(internal.functions.managedEncryption.decryptWorkspace, { workspaceId: f.ours, operator: ADMIN });
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
    for (const [key] of backend.objects) expect(isSealed(backend.bytesOf(key)), key).toBe(false);
    expect(new TextDecoder().decode(backend.bytesOf("1-projects/plan.md")!)).toBe(
      "# Plan\n\nThe words people typed.\n",
    );
    expect(await read(t, staff, ours, "index.md")).toBe("# Ours\n");
  });

  test("once decrypted, a sealed save that lands late still opens rather than showing ciphertext", async () => {
    const f = await encrypted();
    const { t, staff, ours, backend } = f;
    const sealed = backend.bytesOf("index.md")!;
    await decrypt(f);
    await drainScheduled(t);
    expect(await row(t, ours)).toMatchObject({ state: "decrypted" });
    // A store built before Decrypt (an editing room, a request in flight)
    // writes one more sealed object after the last check.
    backend.seed("0-inbox/straggler.md", sealed);
    expect(await mode(t, ours)).toBe("decrypting");
    expect(await read(t, staff, ours, "0-inbox/straggler.md")).toBe("# Ours\n");
    await asUser(t, staff).action(api.functions.files.writeNote, {
      workspaceId: ours,
      path: "1-projects/after.md",
      text: "# After\n",
    });
    expect(isSealed(backend.bytesOf("1-projects/after.md"))).toBe(false);
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
    await t.mutation(internal.functions.managedEncryption.decryptWorkspace, { workspaceId: ours, operator: ADMIN });
    expect(await row(t, ours)).toMatchObject({ state: "decrypted" });
    expect(await mode(t, ours)).toBe("decrypting");
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
    expect(await mode(t, ours)).toBe("decrypting");
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
  test("nobody through the app: it is internal, names its operator, and needs something encrypted", async () => {
    const f = await encrypted();
    const { t, theirs, ours } = f;
    // Not a console button: plain bytes in our R2 account are what
    // encryption protects against, so only production access runs it.
    const registered = decryptWorkspace as unknown as { isInternal?: boolean; isPublic?: boolean };
    expect(registered.isInternal).toBe(true);
    expect(registered.isPublic).not.toBe(true);
    await expect(
      t.mutation(internal.functions.managedEncryption.decryptWorkspace, { workspaceId: ours, operator: "  " }),
    ).rejects.toThrow(/OPERATOR_REQUIRED/);
    expect(await row(t, ours)).toMatchObject({ state: "encrypted" });
    await expect(
      t.mutation(internal.functions.managedEncryption.decryptWorkspace, { workspaceId: theirs, operator: ADMIN }),
    ).rejects.toThrow(/NOT_ENCRYPTED/);
    await decrypt(f);
    expect(await row(t, ours)).toMatchObject({ state: "decrypting", changedBy: ADMIN });
  });
});
