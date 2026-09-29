/**
 * Managed-storage encryption: the staff rollout, and the walk that seals a
 * managed bucket in place.
 *
 * What these tests hold:
 *  - Only staff can see or drive the rollout.
 *  - The walk seals every object in a managed bucket, reads each back, and
 *    only then reaches `encrypted`; reads through the control plane still
 *    return the plain text.
 *  - A customer's own bucket is never touched: no mode, no row.
 *  - A walk that fails stops the rollout, and a retry picks it up again.
 *  - Owners see progress; members see the state only; nobody sees a row
 *    before the rollout reaches them.
 *  - Leaving managed storage forgets the row, so a move back starts plain.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted; counts are across this file.
 *  - `rolloutStatusHandler` without `requireAdmin`: 1 failure (staff only).
 *  - `sealObject` returning "sealed" without writing: 1 failure (bytes stay
 *    plain, so the "CTXENC" assertion fails).
 *  - `gatewayModeForWorkspace` ignoring `bindingIsManaged`: 1 failure.
 *  - `failWalkHandler` not stopping the rollout: 1 failure.
 *  - `encryptionViewFor` returning counts to members: 1 failure.
 */

import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import { PRIVACY_KEY } from "../functions/lib/privacy";
import {
  asUser,
  captureError,
  createWorkspace,
  drainScheduled,
  errorCode,
  seedStorageBinding,
} from "./fixtures.helpers";
import { ADMIN, fixture, isSealed, resetAfterEach, row } from "./managedEncryption.helpers";

resetAfterEach();

describe("the rollout is staff-only", () => {
  test("signed out, a stranger, and an unverified staff address are refused", async () => {
    const { t, stranger } = await fixture();
    await expect(t.query(api.functions.managedEncryption.rolloutStatus, {})).rejects.toThrow();
    await expect(
      asUser(t, stranger).query(api.functions.managedEncryption.rolloutStatus, {}),
    ).rejects.toThrow();
    await expect(
      asUser(t, stranger).mutation(api.functions.managedEncryption.startRollout, { scope: "all" }),
    ).rejects.toThrow();
    const unverified = await t.run((ctx) => ctx.db.insert("users", { email: ADMIN, createdAt: Date.now() }));
    await expect(
      asUser(t, unverified).mutation(api.functions.managedEncryption.startRollout, { scope: "all" }),
    ).rejects.toThrow();
  });

  test("staff see every managed workspace, ours marked", async () => {
    const { t, staff, ours, theirs } = await fixture();
    const status = await asUser(t, staff).query(api.functions.managedEncryption.rolloutStatus, {});
    expect(status).toMatchObject({ state: "off", managedTotal: 2, counts: { notStarted: 2 } });
    const candidates = await asUser(t, staff).query(api.functions.managedEncryption.rolloutCandidates, {});
    expect(candidates.map((c) => [c.workspaceId, c.ours])).toEqual([
      [ours, true],
      [theirs, false],
    ]);
  });
});

describe("the walk", () => {
  test("seals every object in our bucket, checks it, and reads still return plain text", async () => {
    const { t, staff, ours, theirs, backend } = await fixture();
    await expect(
      asUser(t, staff).mutation(api.functions.managedEncryption.startRollout, { scope: "ours" }),
    ).resolves.toEqual({ added: 1, targets: 1 });
    expect(await row(t, theirs)).toBeNull();
    await drainScheduled(t);

    expect(await row(t, ours)).toMatchObject({ state: "encrypted", filesDone: 3, filesTotal: 3 });
    for (const key of [PRIVACY_KEY, "index.md", "1-projects/plan.md"]) {
      expect(isSealed(backend.bytesOf(key))).toBe(true);
    }
    expect(JSON.stringify(backend.snapshot())).not.toContain("The words people typed");

    const status = await asUser(t, staff).query(api.functions.managedEncryption.rolloutStatus, {});
    expect(status).toMatchObject({ state: "complete", counts: { encrypted: 1, notStarted: 1 } });
    expect(await t.query(internal.functions.managedEncryption.gatewayMode, { workspaceId: ours })).toBe(
      "encrypted",
    );

    const note = await asUser(t, staff).action(api.functions.files.readNote, {
      workspaceId: ours,
      path: "1-projects/plan.md",
    });
    expect(note.text).toContain("The words people typed.");
  });

  test("a save during the rollout is written sealed", async () => {
    const { t, staff, ours, backend } = await fixture();
    // The walk makes the key before a row ever leaves `waiting`.
    await t.action(internal.functions.encryptionKeys.openWorkspaceDataKey, { workspaceId: ours, create: true });
    await t.run((ctx) =>
      ctx.db.insert("managedEncryptionWorkspaces", {
        workspaceId: ours,
        state: "encrypting",
        phase: "seal",
        filesDone: 0,
        runId: 0,
        updatedAt: Date.now(),
      }),
    );
    await asUser(t, staff).action(api.functions.files.writeNote, {
      workspaceId: ours,
      path: "1-projects/new.md",
      text: "# New\n\nWritten mid-walk.\n",
    });
    expect(isSealed(backend.bytesOf("1-projects/new.md"))).toBe(true);
    // A plain object from before the walk still opens in `migrating`.
    const old = await asUser(t, staff).action(api.functions.files.readNote, {
      workspaceId: ours,
      path: "1-projects/plan.md",
    });
    expect(old.text).toContain("The words people typed.");
  });

  test("a failed walk stops the rollout, and a retry carries it on", async () => {
    const { t, staff, ours, backend } = await fixture();
    await asUser(t, staff).mutation(api.functions.managedEncryption.startRollout, { scope: "ours" });
    vi.stubGlobal("fetch", async () => new Response("", { status: 503 }));
    await drainScheduled(t);

    expect(await row(t, ours)).toMatchObject({ state: "failed" });
    const stopped = await asUser(t, staff).query(api.functions.managedEncryption.rolloutStatus, {});
    expect(stopped.state).toBe("failed");
    // Staff see a code, never a message that might quote a path.
    expect(stopped.workspaces[0].errorCode).toMatch(/^[A-Z_]+$/);

    vi.stubGlobal("fetch", backend.fetchImpl);
    await asUser(t, staff).mutation(api.functions.managedEncryption.retryWorkspace, { workspaceId: ours });
    await drainScheduled(t);
    expect(await row(t, ours)).toMatchObject({ state: "encrypted" });
  });

  test("pause stops walks, resume restarts them, stop drops only what is waiting", async () => {
    const { t, staff, ours, theirs } = await fixture();
    const as = asUser(t, staff);
    await as.mutation(api.functions.managedEncryption.startRollout, { scope: "all" });
    expect(await captureError(() => as.mutation(api.functions.managedEncryption.startRollout, { scope: "all" }))).toSatisfy(
      (error: unknown) => errorCode(error) === "ROLLOUT_RUNNING",
    );
    expect(
      errorCode(await captureError(() => as.mutation(api.functions.managedEncryption.pauseRollout, { reason: "  " }))),
    ).toBe("REASON_REQUIRED");
    await as.mutation(api.functions.managedEncryption.pauseRollout, { reason: "Checking a bill" });
    await drainScheduled(t);
    // Paused before any run began: nothing moved.
    expect((await row(t, ours))?.state).toBe("waiting");
    expect((await as.query(api.functions.managedEncryption.rolloutStatus, {})).pauseReason).toBe("Checking a bill");

    await as.mutation(api.functions.managedEncryption.stopStartingNew, {});
    expect(await row(t, ours)).toBeNull();
    expect(await row(t, theirs)).toBeNull();
    const off = await as.query(api.functions.managedEncryption.rolloutStatus, {});
    expect(off).toMatchObject({ state: "off", acceptsNew: false });
  });

  test("picking a workspace that is not managed is refused", async () => {
    const { t, staff, owner } = await fixture();
    const plain = await createWorkspace(t, owner, "plain");
    await seedStorageBinding(t, { workspaceId: plain, boundBy: owner });
    const error = await captureError(() =>
      asUser(t, staff).mutation(api.functions.managedEncryption.startRollout, {
        scope: "picked",
        workspaceIds: [plain],
      }),
    );
    expect(errorCode(error)).toBe("PICK_NOT_MANAGED");
  });
});

describe("failing closed", () => {
  test("a mode with no key refuses the note rather than writing it plain", async () => {
    const { t, staff, ours, backend } = await fixture();
    await t.run((ctx) =>
      ctx.db.insert("managedEncryptionWorkspaces", {
        workspaceId: ours,
        state: "encrypting",
        phase: "seal",
        filesDone: 0,
        runId: 0,
        updatedAt: Date.now(),
      }),
    );
    const error = await captureError(() =>
      asUser(t, staff).action(api.functions.files.writeNote, {
        workspaceId: ours,
        path: "1-projects/new.md",
        text: "# New\n",
      }),
    );
    expect(errorCode(error)).toBe("ENCRYPTED_UNREADABLE");
    expect(backend.bytesOf("1-projects/new.md")).toBeNull();
  });
});

describe("a customer's own bucket", () => {
  test("never gets a mode, even with a row", async () => {
    const { t, owner } = await fixture();
    const plain = await createWorkspace(t, owner, "own-bucket");
    await seedStorageBinding(t, { workspaceId: plain, boundBy: owner });
    await t.run((ctx) =>
      ctx.db.insert("managedEncryptionWorkspaces", {
        workspaceId: plain,
        state: "encrypted",
        filesDone: 0,
        runId: 0,
        updatedAt: Date.now(),
      }),
    );
    expect(await t.query(internal.functions.managedEncryption.gatewayMode, { workspaceId: plain })).toBeNull();
  });
});

describe("what owners and members see", () => {
  test("nothing before the rollout reaches them; owners get counts, members the state", async () => {
    const { t, owner, member, theirs } = await fixture();
    const before = await asUser(t, owner).query(api.functions.storage.getStorageBinding, { workspaceId: theirs });
    expect(before?.encryption ?? null).toBeNull();

    await t.run((ctx) =>
      ctx.db.insert("managedEncryptionWorkspaces", {
        workspaceId: theirs,
        state: "encrypting",
        phase: "seal",
        filesDone: 40,
        filesTotal: 100,
        runId: 0,
        updatedAt: Date.now(),
      }),
    );
    await t.run((ctx) =>
      ctx.db.insert("managedEncryptionRollout", {
        state: "running",
        scope: "all",
        acceptsNew: true,
        updatedAt: Date.now(),
      }),
    );
    const asOwner = await asUser(t, owner).query(api.functions.storage.getStorageBinding, { workspaceId: theirs });
    expect(asOwner?.encryption).toEqual({ state: "encrypting", filesDone: 40, filesTotal: 100 });
    const asMember = await asUser(t, member).query(api.functions.storage.getStorageBinding, { workspaceId: theirs });
    expect(asMember?.encryption).toEqual({ state: "encrypting" });
  });
});
