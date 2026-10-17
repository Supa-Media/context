import { withoutFixtureSessions } from "../fixtures.helpers";
import { describe, expect, test } from "vitest";
import { api } from "../../_generated/api";
import {
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  seedGoogleConnection,
  seedGrant,
  setupTest,
} from "../fixtures.helpers";
import { TEST_ACCOUNT_EMAIL } from "../../functions/lib/testAccount";
import { managedBucketName } from "../../functions/lib/managedStorage";
import {
  onboardedAccount,
  seedAuthRows,
} from "./fixtures.helpers";

describe("deleteAccount", () => {
  test("the dedicated account can delete one unshared test workspace without deleting its account", async () => {
    const t = setupTest();
    const owner = await createUser(t, TEST_ACCOUNT_EMAIL);
    const workspaceId = await createWorkspace(t, owner, "one-cuj-only");

    await expect(
      asUser(t, owner).mutation(api.functions.account.deleteTestWorkspace, {
        workspaceId,
      }),
    ).resolves.toEqual({ deleted: true });

    await t.run(async (ctx) => {
      expect(await ctx.db.get(owner)).not.toBeNull();
      expect(await ctx.db.get(workspaceId)).toBeNull();
    });
  });

  test("individual CUJ cleanup refuses ordinary accounts and shared workspaces", async () => {
    const ordinary = setupTest();
    const ordinaryOwner = await createUser(ordinary, "ordinary@example.invalid");
    const ordinaryWorkspace = await createWorkspace(ordinary, ordinaryOwner, "ordinary-one");
    const ordinaryError = await captureError(() =>
      asUser(ordinary, ordinaryOwner).mutation(
        api.functions.account.deleteTestWorkspace,
        { workspaceId: ordinaryWorkspace },
      ),
    );
    expect(errorCode(ordinaryError)).toBe("FORBIDDEN");

    const shared = setupTest();
    const testOwner = await createUser(shared, TEST_ACCOUNT_EMAIL);
    const member = await createUser(shared, "member@example.invalid");
    const sharedWorkspace = await createWorkspace(shared, testOwner, "shared-cuj");
    await addMember(shared, sharedWorkspace, member, "member", testOwner);
    const sharedError = await captureError(() =>
      asUser(shared, testOwner).mutation(
        api.functions.account.deleteTestWorkspace,
        { workspaceId: sharedWorkspace },
      ),
    );
    expect(errorCode(sharedError)).toBe("FORBIDDEN");
  });

  test("an ordinary sole owner's managed bucket is queued for erasure, not forgotten", async () => {
    const { t, owner, workspaceId } = await onboardedAccount("ordinary-cleanup");
    await t.run(async (ctx) => {
      const binding = await ctx.db.query("storageBindings").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).unique();
      await ctx.db.patch(binding!._id, { bucket: managedBucketName(workspaceId), accessKeyId: "fake-managed-token-id" });
    });
    await asUser(t, owner).mutation(api.functions.account.deleteAccount, {});
    const queued = await t.run((ctx) => ctx.db.query("managedErasures").collect());
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ workspaceId, bucket: managedBucketName(workspaceId), tokenId: "fake-managed-token-id" });
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter((job) => job.name.includes("runManagedErasure"))).toHaveLength(1);
  });

  test("a sole owner's deletion cascades through the whole workspace and frees its slug", async () => {
    const { t, owner, workspaceId } = await onboardedAccount("atlas");
    await seedAuthRows(t, owner);
    await seedGrant(t, workspaceId, owner, "client-claude", "fake-hash-1");
    await seedGoogleConnection(t, { workspaceId, boundBy: owner });

    // Rows the cascade must reach that the fixture does not create on its own.
    // Inserted directly — each is a shape the product writes through its own
    // flow, and the test is about the deletion, not those flows.
    await t.run(async (ctx) => {
      await ctx.db.insert("auditEvents", {
        workspaceId,
        actorUserId: owner,
        action: "storage.bound",
        paths: [],
        at: Date.now(),
      });
      await ctx.db.insert("workspaceInvitations", {
        workspaceId,
        inviteeKind: "email",
        invitee: "friend@example.invalid",
        role: "member",
        invitedBy: owner,
        token: "fake-invitation-token-not-real",
        status: "pending",
        expiresAt: Date.now() + 86_400_000,
        createdAt: Date.now(),
      });
      // The named gap this file exists to close: a parked Google connect,
      // previously left out of the cascade entirely.
      await ctx.db.insert("googleConnectAttempts", {
        hashedState: "fake-hashed-google-state-not-real",
        encryptedVerifier: "v2:current:FAKE:GOOGLE-VERIFIER",
        workspaceId,
        startedBy: owner,
        redirectUri: "https://console.example/mail/gmail/callback",
        products: ["gmail"],
        expiresAt: Date.now() + 600_000,
        createdAt: Date.now(),
      });
      /*
        THE PLUGIN TABLES, ALL FIVE OF THEM.

        `listPluginGrants` calls a grant row "private workspace metadata" in
        its own docstring — which software somebody ran, and which hosts it was
        allowed to reach. A runtime state row carries free text reported about
        their plugin's failures, and a session row is a hashed bearer binding.
        None of it is credential material, so `cascadeCoverage.test.ts` does
        not claim it: that guard derives an `encrypted…` field and says in its
        own header which shapes escape it. This is one of them, so it is
        asserted by hand here.

        `obsidianPluginRuntimeRequests` is keyed by `tokenHash` alone and has
        no `workspaceId`, so it can only be reached through the session it
        belongs to — the same shape the connect-attempt sweep already handles,
        and the reason a sweep of the four indexed tables would still leave a
        row behind.
      */
      const runtimeTokenHash = "fake-runtime-token-hash-not-real";
      await ctx.db.insert("obsidianPluginGrants", {
        workspaceId,
        pluginId: "fake-plugin",
        bundleFingerprint: "v2:fake-manifest-etag:fake-main-etag:absent",
        capabilities: ["vault:read"],
        networkHosts: [],
        status: "active",
        grantedBy: owner,
        grantedAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.insert("obsidianPluginLifecycles", {
        workspaceId,
        pluginId: "fake-plugin",
        generation: 1,
        busy: false,
        operation: "installing",
        updatedAt: Date.now(),
      });
      await ctx.db.insert("obsidianPluginRuntimeSessions", {
        workspaceId,
        pluginId: "fake-plugin",
        bundleFingerprint: "v2:fake-manifest-etag:fake-main-etag:absent",
        tokenHash: runtimeTokenHash,
        createdBy: owner,
        createdAt: Date.now(),
        expiresAt: Date.now() + 900_000,
      });
      await ctx.db.insert("obsidianPluginRuntimeRequests", {
        tokenHash: runtimeTokenHash,
        requestId: "fake-request-id",
        operation: "vault.read",
        claimedAt: Date.now(),
      });
      await ctx.db.insert("obsidianPluginRuntimeStates", {
        workspaceId,
        pluginId: "fake-plugin",
        bundleFingerprint: "v2:fake-manifest-etag:fake-main-etag:absent",
        status: "crash-looped",
        attempts: 3,
        errorCode: "PLUGIN_LOAD_FAILED",
        errorMessage: "could not read 1-projects/whatever.md",
        reportedBy: owner,
        updatedAt: Date.now(),
      });
      await ctx.db.insert("ingestionTickets", {
        hashedTicket: "fake-hashed-ticket-not-real",
        workspaceId,
        sizeBytes: 1_000,
        createdAt: Date.now(),
        expiresAt: Date.now() + 600_000,
      });
      await ctx.db.insert("cloudflareProvisioning", {
        workspaceId,
        requestedBy: owner,
        credentialSource: "api-token",
        accountId: "fake-cf-account-id",
        bucket: "example-context-bucket",
        jurisdiction: "default",
        status: "failed",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      await ctx.db.insert("vaultImportJobs", {
        workspaceId,
        actorUserId: owner,
        strategy: "merge",
        sourceFingerprint: "vault-account-delete",
        totalFiles: 2,
        totalBytes: 12,
        totalBatches: 2,
        completedBatches: [0],
        completedFiles: 1,
        createdFiles: 1,
        skippedFiles: 0,
        status: "paused",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      });
      // A rotated workspace: one retired generation, one live one, and the
      // rotation row that recorded the move. Asserted on BOTH sides below —
      // see "the two encryption tables part company at a teardown".
      await ctx.db.insert("workspaceDataKeys", {
        workspaceId,
        generation: "k1",
        encryptedDataKey: "v2:current:FAKE:RETIRED-GENERATION",
        retiredAt: Date.now() - 1_000,
        createdAt: Date.now() - 2_000,
      });
      await ctx.db.insert("workspaceDataKeys", {
        workspaceId,
        generation: "k2",
        encryptedDataKey: "v2:current:FAKE:LIVE-GENERATION",
        createdAt: Date.now() - 1_000,
      });
      await ctx.db.insert("workspaceKeyRotations", {
        workspaceId,
        fromGeneration: "k1",
        toGeneration: "k2",
        status: "done",
        startedAt: Date.now() - 2_000,
        completedAt: Date.now() - 1_000,
      });
    });

    // The pre-state: every table the cascade claims to touch really has a row
    // pointed at this workspace or this user. Without this, the emptiness
    // assertions below cannot fail.
    await t.run(async (ctx) => {
      expect(await ctx.db.get(workspaceId)).not.toBeNull();
      expect(await ctx.db.query("storageBindings").collect()).toHaveLength(1);
      expect(await ctx.db.query("googleConnections").collect()).toHaveLength(1);
      expect(await ctx.db.query("googleConnectAttempts").collect()).toHaveLength(1);
      expect(await ctx.db.query("workspaceMembers").collect()).toHaveLength(1);
      expect(await ctx.db.query("ingestionSettings").collect()).toHaveLength(1);
      expect(await ctx.db.query("vaultImportJobs").collect()).toHaveLength(1);
      expect(await ctx.db.query("names").collect()).toHaveLength(1);
      expect(await ctx.db.query("oauthGrants").collect()).toHaveLength(1);
      expect(await ctx.db.query("authAccounts").collect()).toHaveLength(1);
      expect(withoutFixtureSessions(await ctx.db.query("authSessions").collect())).toHaveLength(1);
      expect(await ctx.db.query("workspaceDataKeys").collect()).toHaveLength(2);
      expect(await ctx.db.query("workspaceKeyRotations").collect()).toHaveLength(1);
      expect(await ctx.db.query("obsidianPluginGrants").collect()).toHaveLength(1);
      expect(await ctx.db.query("obsidianPluginLifecycles").collect()).toHaveLength(1);
      expect(await ctx.db.query("obsidianPluginRuntimeSessions").collect()).toHaveLength(1);
      expect(await ctx.db.query("obsidianPluginRuntimeRequests").collect()).toHaveLength(1);
      expect(await ctx.db.query("obsidianPluginRuntimeStates").collect()).toHaveLength(1);
    });

    const result = await asUser(t, owner).mutation(
      api.functions.account.deleteAccount,
      {},
    );
    expect(result).toEqual({ deleted: true });

    await t.run(async (ctx) => {
      // The person, and everything that authenticated them.
      expect(await ctx.db.get(owner)).toBeNull();
      expect(await ctx.db.query("authAccounts").collect()).toHaveLength(0);
      expect(await ctx.db.query("authVerificationCodes").collect()).toHaveLength(0);
      expect(await ctx.db.query("authSessions").collect()).toHaveLength(0);
      expect(await ctx.db.query("authRefreshTokens").collect()).toHaveLength(0);

      // The workspace and everything hanging off it.
      expect(await ctx.db.get(workspaceId)).toBeNull();
      expect(await ctx.db.query("workspaceMembers").collect()).toHaveLength(0);
      expect(await ctx.db.query("storageBindings").collect()).toHaveLength(0);
      expect(await ctx.db.query("ingestionSettings").collect()).toHaveLength(0);
      expect(await ctx.db.query("vaultImportJobs").collect()).toHaveLength(0);
      expect(await ctx.db.query("workspaceInvitations").collect()).toHaveLength(0);
      expect(await ctx.db.query("auditEvents").collect()).toHaveLength(0);
      expect(await ctx.db.query("googleConnectAttempts").collect()).toHaveLength(0);
      expect(await ctx.db.query("googleConnections").collect()).toHaveLength(0);
      expect(await ctx.db.query("ingestionTickets").collect()).toHaveLength(0);
      expect(await ctx.db.query("cloudflareProvisioning").collect()).toHaveLength(0);
      expect(await ctx.db.query("oauthGrants").collect()).toHaveLength(0);
      // Everything the Obsidian plugin subsystem recorded about this context.
      // A grant is authority over a bundle, a session is a hashed bearer
      // binding, and a runtime state carries text about somebody's own notes;
      // none of the three has anything left to be true about.
      expect(await ctx.db.query("obsidianPluginGrants").collect()).toHaveLength(0);
      expect(await ctx.db.query("obsidianPluginLifecycles").collect()).toHaveLength(0);
      expect(await ctx.db.query("obsidianPluginRuntimeSessions").collect()).toHaveLength(0);
      expect(await ctx.db.query("obsidianPluginRuntimeRequests").collect()).toHaveLength(0);
      expect(await ctx.db.query("obsidianPluginRuntimeStates").collect()).toHaveLength(0);

      /*
        THE TWO ENCRYPTION TABLES PART COMPANY AT A TEARDOWN, DELIBERATELY.

        `workspaceKeyRotations` goes: it is a boolean about a workspace that no
        longer exists, and it holds no key material.

        `workspaceDataKeys` STAYS, both generations of it, and this assertion
        is here to make that visible rather than to bless it. Two things are
        true at once and neither is an oversight:

          - Nothing in this codebase deletes a generation. That is the
            grace-period policy in `docs/decisions/encryption.md`, and this is
            the strongest test of it available — the largest destructive
            operation the product has, run over a workspace with a retired
            generation, and the row survives. Notes wrapped under `k1` in a
            bucket the customer still owns are still openable with an export.
          - It is also the one place we keep a credential for a context we
            have just finished deleting everything else about. `deleteAccount`
            is where a person is told our copy of their data is gone; the key
            that opens their notes is our copy of something.

        Which way that resolves is a product decision — it turns on whether
        the console makes an owner export before it lets them delete — and it
        is written up as open in `docs/decisions/encryption.md` under "What a
        teardown deletes, and what it keeps". Whichever way it goes, it goes
        deliberately: this line fails on the day somebody changes it.
      */
      expect(await ctx.db.query("workspaceKeyRotations").collect()).toHaveLength(0);
      const survivingKeys = await ctx.db.query("workspaceDataKeys").collect();
      expect(survivingKeys.map((row) => row.generation).sort()).toEqual(["k1", "k2"]);

      // The slug: no row left in the shared namespace. This is the point of
      // the cascade — deletion must not squat the name forever.
      expect(await ctx.db.query("names").collect()).toHaveLength(0);
    });

    // And prove it, the way a real person would notice: somebody else can now
    // claim the same name and re-onboard.
    const successor = await createUser(t, "successor@example.invalid");
    const reclaimed = await createWorkspace(t, successor, "atlas");
    expect(reclaimed).toBeDefined();
  });

});
