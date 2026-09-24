import { describe, expect, test } from "vitest";
import { api, internal } from "../../_generated/api";
import { managedBucketName } from "../../functions/lib/managedStorage";
import {
  FAKE_STORAGE,
  addMember,
  asUser,
  bindFakeStorage,
  createUser,
  createWorkspace,
  setupTest,
} from "../fixtures.helpers";
import {
  boundWorkspace,
} from "./fixtures";

describe("recordVerification (internal)", () => {
  test("marks a binding connected and records probed capabilities", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();

    await t.mutation(internal.functions.storage.recordVerification, {
      workspaceId,
      ok: true,
      capabilities: { conditionalWrite: true },
    });

    const binding = await asUser(t, owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    expect(binding).toMatchObject({
      status: "connected",
      capabilities: { conditionalWrite: true },
    });
    expect(binding?.lastVerifiedAt).toBeGreaterThan(0);
    expect(binding?.lastError).toBeUndefined();
  });

  test("records a failure without pretending the bucket works", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();

    await t.mutation(internal.functions.storage.recordVerification, {
      workspaceId,
      ok: false,
      error: "AccessDenied listing the bucket",
    });

    const binding = await asUser(t, owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    expect(binding?.status).toBe("error");
    expect(binding?.lastError).toContain("AccessDenied");
  });

  /**
   * `lastError` is an untrusted string on a member-readable surface.
   *
   * The schema claimed it "never contains the secret" with nothing enforcing
   * it, and nothing bounded its length either — so whatever ran the probe
   * could store an arbitrarily large provider response, verbatim, for every
   * member of the workspace to read.
   */
  test("caps a huge provider error rather than storing it verbatim", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();

    await t.mutation(internal.functions.storage.recordVerification, {
      workspaceId,
      ok: false,
      error: "x".repeat(50_000),
    });

    const binding = await asUser(t, owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    expect(binding?.lastError!.length).toBeLessThanOrEqual(300);
    expect(binding?.lastError!.endsWith("…")).toBe(true);
  });

  test("redacts the credential-shaped fragments it can recognize", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    const envelope = await t.run(async (ctx) => {
      const row = await ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique();
      return row!.encryptedSecretAccessKey;
    });

    await t.mutation(internal.functions.storage.recordVerification, {
      workspaceId,
      ok: false,
      error: `SignatureDoesNotMatch for ${FAKE_STORAGE.accessKeyId}: Credential=${FAKE_STORAGE.accessKeyId}/20260101/auto/s3, Signature=deadbeefcafe stored=${envelope}`,
    });

    const binding = await asUser(t, owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    const stored = binding?.lastError ?? "";

    expect(stored).not.toContain(FAKE_STORAGE.accessKeyId);
    expect(stored).not.toContain(envelope);
    expect(stored).not.toContain("deadbeefcafe");
    // ...and it is still a usable diagnostic, which is the point of keeping it.
    expect(stored).toContain("SignatureDoesNotMatch");
  });

  test("a later success clears the stale error", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();

    await t.mutation(internal.functions.storage.recordVerification, {
      workspaceId,
      ok: false,
      error: "AccessDenied listing the bucket",
    });
    await t.mutation(internal.functions.storage.recordVerification, {
      workspaceId,
      ok: true,
      capabilities: { conditionalWrite: false },
    });

    const binding = await asUser(t, owner).query(
      api.functions.storage.getStorageBinding,
      { workspaceId },
    );
    expect(binding?.status).toBe("connected");
    expect(binding?.lastError).toBeUndefined();
  });
});

describe("disconnectStorage", () => {
  test("refuses to strand a managed bucket behind an active plan", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    await t.run(async (ctx) => {
      const binding = await ctx.db.query("storageBindings").unique();
      await ctx.db.patch(binding!._id, { bucket: managedBucketName(workspaceId) });
      await ctx.db.insert("workspacePlans", {
        workspaceId,
        managedStorage: true,
        fastSearch: false,
        status: "active",
        managedProvisioning: "ready",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
    });

    await expect(
      asUser(t, owner).mutation(api.functions.storage.disconnectStorage, {
        workspaceId,
      }),
    ).rejects.toThrow(/managed storage/i);
    expect(await t.run((ctx) => ctx.db.query("storageBindings").unique())).not.toBeNull();
  });
  test("deletes the credential outright rather than flagging it", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();

    const result = await asUser(t, owner).mutation(
      api.functions.storage.disconnectStorage,
      { workspaceId },
    );
    expect(result.disconnected).toBe(true);

    const rows = await t.run((ctx) => ctx.db.query("storageBindings").collect());
    expect(rows).toHaveLength(0);

    // And the gateway can no longer get a credential for it.
    expect(
      await t.action(internal.functions.storage.getBindingForGateway, {
        workspaceId,
      }),
    ).toBeNull();
  });

  test("is idempotent", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    await asUser(t, owner).mutation(api.functions.storage.disconnectStorage, {
      workspaceId,
    });
    const second = await asUser(t, owner).mutation(
      api.functions.storage.disconnectStorage,
      { workspaceId },
    );
    expect(second.disconnected).toBe(false);
  });

  test("a Dropbox disconnect also schedules the grant revocation", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    // Reshape the fixture's bucket binding into a Dropbox one. Direct db
    // writes, because what is under test is the disconnect, not the connect.
    await t.run(async (ctx) => {
      const row = await ctx.db.query("storageBindings").unique();
      await ctx.db.patch(row!._id, {
        provider: "dropbox",
        encryptedRefreshToken: "v2:current:FAKE:ENVELOPE",
        endpoint: undefined,
        region: undefined,
        bucket: undefined,
        accessKeyId: undefined,
        encryptedSecretAccessKey: undefined,
      });
    });

    await asUser(t, owner).mutation(api.functions.storage.disconnectStorage, {
      workspaceId,
    });

    // The row is gone AND the revoke is on the schedule, carrying the
    // envelope it can no longer read from the row. Without the revoke, we
    // forget the credential while the grant lives on in the person's
    // Dropbox — and their next connect silently auto-approves the same
    // account, which is the "stuck in a cycle" Seyi hit live.
    const rows = await t.run((ctx) => ctx.db.query("storageBindings").collect());
    expect(rows).toHaveLength(0);
    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    const revokes = scheduled.filter((job) => job.name.includes("revokeDropboxGrant"));
    expect(revokes).toHaveLength(1);
    expect(JSON.stringify(revokes[0].args)).toContain("v2:current:FAKE:ENVELOPE");
  });

  test("a bucket disconnect schedules nothing — there is no grant to revoke", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    await asUser(t, owner).mutation(api.functions.storage.disconnectStorage, {
      workspaceId,
    });
    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(
      scheduled.filter((job) => job.name.includes("revokeDropboxGrant")),
    ).toHaveLength(0);
  });

  test("leaves an audit trail that carries no credential", async () => {
    const { t, owner, workspaceId } = await boundWorkspace();
    await asUser(t, owner).mutation(api.functions.storage.disconnectStorage, {
      workspaceId,
    });

    const events = await asUser(t, owner).query(api.functions.audit.listEvents, {
      workspaceId,
    });
    const actions = events.map((e) => e.action);
    expect(actions).toContain("storage.disconnected");
    expect(actions).toContain("storage.bound");

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain(FAKE_STORAGE.secretAccessKey);
    expect(serialized).not.toContain(FAKE_STORAGE.accessKeyId);
  });
});

describe("audit of storage changes names the acting identity", () => {
  test("a rebind by a second owner is attributed to that owner, not to a scope", async () => {
    const t = setupTest();
    const alice = await createUser(t, "alice@example.invalid");
    const bob = await createUser(t, "bob@example.invalid");
    const workspaceId = await createWorkspace(t, alice, "shared-context", {
      kind: "shared",
    });
    await addMember(t, workspaceId, bob, "owner", alice);

    await bindFakeStorage(t, alice, workspaceId);
    await bindFakeStorage(t, bob, workspaceId, { bucket: "bobs-choice" });

    const events = await asUser(t, alice).query(api.functions.audit.listEvents, {
      workspaceId,
    });
    const rebind = events.find((e) => e.action === "storage.rebound");
    expect(rebind?.actorUserId).toBe(bob);
    expect(rebind?.actorEmail).toBe("bob@example.invalid");
  });
});

