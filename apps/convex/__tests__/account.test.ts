/**
 * Account deletion.
 *
 * The two things that must hold no matter what changes here:
 *  - deleting yourself removes every row that is *yours* — the user row, your
 *    auth material, your memberships, your name claims, and any workspace only
 *    you own, including its storage binding and its slug, so the person can
 *    re-onboard under the same name; and
 *  - deleting yourself removes nothing that is *somebody else's* — a workspace
 *    with another owner survives untouched, and so does everyone else's
 *    membership of it.
 *
 * The cascade assertions below deliberately check the *pre*-state first. An
 * "is empty afterwards" assertion over a table the fixture never populated is
 * vacuously green, and a cascade that silently stopped touching a table would
 * sail through it.
 *
 * A third property, added alongside the Google connection cascade: deleting
 * workspace A must never touch workspace B's rows, in any of the tables this
 * file sweeps, when both live in the *same* database — a separate
 * `setupTest()` per workspace would prove nothing here, since two databases
 * cannot collide by construction. See "tenant isolation" below.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted. Counts are failing vitest tests
 * (in this file unless noted).
 *
 *   the `workspaceKeyRotations` sweep removed from the cascade             1
 *   the `CONNECT_ATTEMPT_TABLES` loop deleted from the cascade             1
 *   the Google connection sweep deleted from the cascade                   2
 *   `workspaceId` filter dropped from the connect-attempt sweep            1
 *   `encryptedVerifier` typo'd in `connectAttemptTables`'s predicate       3
 *     (1 here + 2 in `connectAttempts.test.ts` — the derivation returns an
 *     empty set, so both its own self-tests and this file's cascade test
 *     fail together)
 *
 * Re-measured on review, with three more rows and one correction — the
 * Google-connection row is now 5, because this file grew three tests that
 * depend on that sweep and `cascadeCoverage.test.ts` catches it as an
 * unaccounted-for credential table:
 *
 *   the Google connection sweep deleted from the cascade                   5
 *     (4 here + 1 in `cascadeCoverage.test.ts`)
 *   the `searchIndexes` release deleted from the cascade                   2
 *   the Google sweep left unscoped (`query(...).collect()`, no index)      1
 *     — the two-workspace isolation test, specifically
 *   `workspaceDataKeys` deleted by the cascade (the kept half)             1
 *   the failed-revoke log line removed from `revokeGoogleGrant`            1
 *
 * The encryption tables are the one place this file asserts an *asymmetry*
 * rather than an emptiness — the rotation rows go, the key generations stay.
 * Both directions are asserted, because the second is an open product
 * decision (`docs/decisions/encryption.md`, "What a teardown deletes, and
 * what it keeps") and an open decision with no test in front of it is a
 * decision that gets taken by accident.
 */

import { describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  type TestConvex,
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  drainScheduled,
  errorCode,
  seedGoogleConnection,
  seedGrant,
  seedAppSecret,
  seedStorageBinding,
  setupTest,
} from "./fixtures.helpers";
import { TEST_ACCOUNT_EMAIL } from "../functions/lib/testAccount";
import { managedBucketName } from "../functions/lib/managedStorage";
import {
  MANAGED_R2_ACCOUNT_ID_ENV_VAR,
  MANAGED_R2_API_TOKEN_SECRET,
} from "../functions/lib/managedStorage";

/**
 * A user with a personal workspace and a storage binding — the ordinary shape
 * of an account that has finished onboarding.
 *
 * `seedStorageBinding` rather than `bindFakeStorage`, for the reason the
 * fixture itself gives: the real action schedules a verification probe that
 * races the test, and what is under test here is the deletion, not the
 * connect.
 */
async function onboardedAccount(slug = "atlas") {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, slug);
  await seedStorageBinding(t, { workspaceId, boundBy: owner });
  return { t, owner, workspaceId };
}

/** Auth rows as @convex-dev/auth lays them down for a signed-in account. */
async function seedAuthRows(t: TestConvex, userId: Id<"users">) {
  const accountId = await t.run((ctx) =>
    ctx.db.insert("authAccounts", {
      userId,
      provider: "email-otp",
      providerAccountId: "owner@example.invalid",
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("authVerificationCodes", {
      accountId,
      provider: "email-otp",
      code: "fake-hashed-code-not-real",
      expirationTime: Date.now() + 86_400_000,
    }),
  );
  const sessionId = await t.run((ctx) =>
    ctx.db.insert("authSessions", {
      userId,
      expirationTime: Date.now() + 86_400_000,
    }),
  );
  await t.run((ctx) =>
    ctx.db.insert("authRefreshTokens", {
      sessionId,
      expirationTime: Date.now() + 86_400_000,
    }),
  );
  return { accountId, sessionId };
}

describe("deleteAccount", () => {
  test("only the dedicated test account schedules deletion of its managed bucket", async () => {
    const t = setupTest();
    const owner = await createUser(t, TEST_ACCOUNT_EMAIL);
    const workspaceId = await createWorkspace(t, owner, "cuj-cleanup");
    await seedStorageBinding(t, {
      workspaceId,
      boundBy: owner,
      bucket: managedBucketName(workspaceId),
      accessKeyId: "fake-managed-token-id",
    });
    vi.stubEnv(MANAGED_R2_ACCOUNT_ID_ENV_VAR, "0123456789abcdef0123456789abcdef");
    await seedAppSecret(t, MANAGED_R2_API_TOKEN_SECRET, "fake-managed-api-token");
    vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) =>
      new Response(JSON.stringify({
        success: true,
        result: (init?.method ?? "GET") === "GET" && String(input).endsWith("/objects") ? [] : {},
      })),
    );

    try {
      await asUser(t, owner).mutation(api.functions.account.deleteAccount, {});
      const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
      const cleanup = scheduled.filter((job) => job.name.includes("deleteManagedTestResources"));
      expect(cleanup).toHaveLength(1);
      expect(cleanup[0]?.args[0]).toMatchObject({
        workspaceId,
        bucket: managedBucketName(workspaceId),
        tokenId: "fake-managed-token-id",
      });
      await drainScheduled(t);
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });

  test("ordinary accounts never schedule managed bucket deletion", async () => {
    const { t, owner, workspaceId } = await onboardedAccount("ordinary-cleanup");
    await t.run(async (ctx) => {
      const binding = await ctx.db.query("storageBindings").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).unique();
      await ctx.db.patch(binding!._id, { bucket: managedBucketName(workspaceId) });
    });
    await asUser(t, owner).mutation(api.functions.account.deleteAccount, {});
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.some((job) => job.name.includes("deleteManagedTestResources"))).toBe(false);
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
      await ctx.db.insert("dropboxConnectAttempts", {
        hashedState: "fake-hashed-state-not-real",
        encryptedVerifier: "v2:current:FAKE:VERIFIER",
        workspaceId,
        startedBy: owner,
        redirectUri: "https://console.example/callback",
        expiresAt: Date.now() + 600_000,
        createdAt: Date.now(),
      });
      // The named gap this file exists to close: a parked Google connect,
      // same shape as the Dropbox one above, previously left out of the
      // cascade entirely.
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
      expect(await ctx.db.query("names").collect()).toHaveLength(1);
      expect(await ctx.db.query("oauthGrants").collect()).toHaveLength(1);
      expect(await ctx.db.query("authAccounts").collect()).toHaveLength(1);
      expect(await ctx.db.query("authSessions").collect()).toHaveLength(1);
      expect(await ctx.db.query("workspaceDataKeys").collect()).toHaveLength(2);
      expect(await ctx.db.query("workspaceKeyRotations").collect()).toHaveLength(1);
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
      expect(await ctx.db.query("workspaceInvitations").collect()).toHaveLength(0);
      expect(await ctx.db.query("auditEvents").collect()).toHaveLength(0);
      expect(await ctx.db.query("dropboxConnectAttempts").collect()).toHaveLength(0);
      expect(await ctx.db.query("googleConnectAttempts").collect()).toHaveLength(0);
      expect(await ctx.db.query("googleConnections").collect()).toHaveLength(0);
      expect(await ctx.db.query("ingestionTickets").collect()).toHaveLength(0);
      expect(await ctx.db.query("cloudflareProvisioning").collect()).toHaveLength(0);
      expect(await ctx.db.query("oauthGrants").collect()).toHaveLength(0);

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

  test("deleting a Dropbox-backed account schedules the grant revocation", async () => {
    const { t, owner } = await onboardedAccount();

    // Reshape the fixture's bucket binding into a Dropbox one. Direct db
    // writes, exactly as storage.test.ts does for `disconnectStorage`: what is
    // under test is the deletion, not the connect flow.
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

    await asUser(t, owner).mutation(api.functions.account.deleteAccount, {});

    // The row is gone AND the revoke is on the schedule, carrying the envelope
    // it can no longer read from the row. Without this, we forget our copy of
    // the credential while the grant lives on in the person's Dropbox — the
    // same trap `disconnectStorage` closes, and an account deletion must not
    // reopen it.
    const rows = await t.run((ctx) => ctx.db.query("storageBindings").collect());
    expect(rows).toHaveLength(0);
    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    const revokes = scheduled.filter((job) =>
      job.name.includes("revokeDropboxGrant"),
    );
    expect(revokes).toHaveLength(1);
    expect(JSON.stringify(revokes[0].args)).toContain("v2:current:FAKE:ENVELOPE");
  });

  test("deleting a Google-backed account schedules a revoke per live connection, and none for a disconnected one", async () => {
    const { t, owner, workspaceId } = await onboardedAccount();

    // Two live connections (a workspace can have several addresses) and one
    // already disconnected — `disconnectGoogleConnection` leaves the row with
    // an empty `encryptedRefreshToken` rather than deleting it, and the
    // cascade must not schedule a revoke for a token that is already gone.
    await seedGoogleConnection(t, {
      workspaceId,
      boundBy: owner,
      address: "one@example.invalid",
      refreshToken: "refresh-token-one",
    });
    await seedGoogleConnection(t, {
      workspaceId,
      boundBy: owner,
      address: "two@example.invalid",
      refreshToken: "refresh-token-two",
    });
    await seedGoogleConnection(t, {
      workspaceId,
      boundBy: owner,
      address: "three@example.invalid",
      disconnected: true,
    });

    await asUser(t, owner).mutation(api.functions.account.deleteAccount, {});

    // Every row is gone, disconnected one included — a stale row pointed at a
    // deleted workspace is not a place to leave anything.
    expect(await t.run((ctx) => ctx.db.query("googleConnections").collect())).toHaveLength(0);

    // Exactly two revokes scheduled — one per live connection — each carrying
    // the sealed refresh token it can no longer read off a deleted row.
    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    const revokes = scheduled.filter((job) => job.name.includes("revokeGoogleGrant"));
    expect(revokes).toHaveLength(2);
    const revokedEnvelopes = revokes.map((job) => JSON.stringify(job.args));
    // Both live tokens are represented, sealed (never the plaintext).
    expect(revokedEnvelopes.some((args) => args.includes(workspaceId))).toBe(true);
    for (const args of revokedEnvelopes) {
      expect(args).not.toContain("refresh-token-one");
      expect(args).not.toContain("refresh-token-two");
    }
  });

  /**
   * REVOCATION IS BEST-EFFORT, AND THE ROW GOES EITHER WAY. Both directions
   * are asserted because only the pair says what actually happens to somebody
   * else's Google account when we forget our copy of the credential.
   *
   * The success direction proves the scheduled job really reaches Google's
   * revoke endpoint carrying the token it opened out of the envelope the
   * cascade put in its args — that the row's deletion is not what ends the
   * grant, the call is.
   */
  test("the scheduled revoke reaches Google with the token, after the row is gone", async () => {
    const { t, owner, workspaceId } = await onboardedAccount();
    await seedGoogleConnection(t, {
      workspaceId,
      boundBy: owner,
      refreshToken: "refresh-token-to-revoke",
    });

    const calls: Array<{ url: string; body: string }> = [];
    vi.stubGlobal("fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
      calls.push({ url: String(input), body: String(init?.body ?? "") });
      return new Response("", { status: 200 });
    });

    await asUser(t, owner).mutation(api.functions.account.deleteAccount, {});
    // The row is already gone when the revoke runs — the envelope travelled in
    // the scheduler args precisely so it does not need the row.
    expect(await t.run((ctx) => ctx.db.query("googleConnections").collect())).toHaveLength(0);
    await drainScheduled(t);

    // Matched on THIS test's token rather than on a call count: convex-test's
    // scheduler runs on real timers, so a job another test in this file left
    // pending can fire against the stub while this one is installed.
    const revokes = calls.filter(
      (call) =>
        call.url.includes("oauth2.googleapis.com/revoke") &&
        call.body.includes(encodeURIComponent("refresh-token-to-revoke")),
    );
    expect(revokes).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  /**
   * The failure direction: Google unreachable. Nothing may be resurrected,
   * nothing else in the cascade may be abandoned — the revoke is scheduled
   * *after* the transaction commits, so it structurally cannot roll anything
   * back — and the failure has to be recorded somewhere, because the audit
   * trail this would otherwise be written to was deleted by this very
   * cascade. Today that record is the structured log line
   * `mail.grant_revoke_skipped`, and this pins it: silently swallowing a
   * failed revoke would leave a live grant on somebody's Google account with
   * no trace anywhere that we stopped being able to end it.
   */
  test("a revoke that cannot reach Google is recorded, and the cascade still completes", async () => {
    const { t, owner, workspaceId } = await onboardedAccount();
    await seedGoogleConnection(t, {
      workspaceId,
      boundBy: owner,
      refreshToken: "refresh-token-never-revoked",
    });
    await seedGrant(t, workspaceId, owner, "client-claude", "fake-hash-unreachable");

    vi.stubGlobal("fetch", () => Promise.reject(new Error("ECONNREFUSED")));
    const logged: string[] = [];
    const logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });

    await asUser(t, owner).mutation(api.functions.account.deleteAccount, {});
    await drainScheduled(t);

    logSpy.mockRestore();
    vi.unstubAllGlobals();

    // Recorded, with the workspace it belonged to and no credential in it.
    // `toBeGreaterThanOrEqual` rather than an exact count, deliberately:
    // convex-test schedules on real timers, so a revoke another test in this
    // file left pending can also fire — and fail — while this stub is up.
    // What this asserts is that a revoke that could not reach Google leaves a
    // trace at all, which is the property, and that the trace is safe.
    const skipped = logged.filter((line) => line.includes("mail.grant_revoke_skipped"));
    expect(skipped.length).toBeGreaterThanOrEqual(1);
    expect(skipped.some((line) => line.includes(workspaceId))).toBe(true);
    for (const line of skipped) {
      expect(line).not.toContain("refresh-token-never-revoked");
    }

    // And the rest of the teardown happened regardless: an unreachable
    // provider must never leave a half-deleted workspace behind.
    await t.run(async (ctx) => {
      expect(await ctx.db.get(workspaceId)).toBeNull();
      expect(await ctx.db.get(owner)).toBeNull();
      expect(await ctx.db.query("googleConnections").collect()).toHaveLength(0);
      expect(await ctx.db.query("oauthGrants").collect()).toHaveLength(0);
      expect(await ctx.db.query("names").collect()).toHaveLength(0);
    });
  });

  /**
   * THE SEARCH INDEX IS RELEASED, NOT DELETED, AND NOT LEFT EITHER.
   *
   * A `searchIndexes` row with a `databaseId` names a live Cloudflare D1
   * database holding a projection of this context's notes — body chunks
   * included. Deleting the row strands it with nothing pointing at it;
   * leaving the row `ready` strands it too, because after this transaction
   * there is no owner left to press "turn it off". So the cascade presses it:
   * the row goes to `releasing` and `releaseIndex` is scheduled, which is the
   * only path that actually deletes the remote database.
   */
  test("a live fast-search index is marked releasing and its release is scheduled", async () => {
    const { t, owner, workspaceId } = await onboardedAccount();
    await t.run((ctx) =>
      ctx.db.insert("searchIndexes", {
        workspaceId,
        optedIn: true,
        optedInBy: owner,
        optedInAt: Date.now(),
        status: "ready" as const,
        databaseId: "fake-d1-database-id-not-real",
        databaseName: "fake-d1-database-name",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    await asUser(t, owner).mutation(api.functions.account.deleteAccount, {});

    const rows = await t.run((ctx) => ctx.db.query("searchIndexes").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]!.optedIn).toBe(false);
    expect(rows[0]!.status).toBe("releasing");
    // Still holding the id the release needs: a row that loses this before
    // the remote database is gone is a database nothing will ever clean up.
    expect(rows[0]!.databaseId).toBe("fake-d1-database-id-not-real");

    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled.filter((job) => job.name.includes("releaseIndex"))).toHaveLength(1);

    // And the release, run with no Cloudflare credential configured in this
    // deployment, leaves the row exactly where a retry can find it rather
    // than forgetting a database it never deleted.
    await drainScheduled(t);
    const after = await t.run((ctx) => ctx.db.query("searchIndexes").collect());
    expect(after).toHaveLength(1);
    expect(after[0]!.status).toBe("releasing");
  });

  test("an index row that never got a database is deleted outright, with no release scheduled", async () => {
    const { t, owner, workspaceId } = await onboardedAccount();
    await t.run((ctx) =>
      ctx.db.insert("searchIndexes", {
        workspaceId,
        optedIn: true,
        optedInBy: owner,
        optedInAt: Date.now(),
        status: "failed" as const,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      }),
    );

    await asUser(t, owner).mutation(api.functions.account.deleteAccount, {});

    expect(await t.run((ctx) => ctx.db.query("searchIndexes").collect())).toHaveLength(0);
    const scheduled = await t.run((ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(scheduled.filter((job) => job.name.includes("releaseIndex"))).toHaveLength(0);
  });

  test("a member's deletion removes only their own membership, never the workspace", async () => {
    const { t, owner, workspaceId } = await onboardedAccount();
    const member = await createUser(t, "member@example.invalid");
    await addMember(t, workspaceId, member, "member", owner);

    await asUser(t, member).mutation(api.functions.account.deleteAccount, {});

    await t.run(async (ctx) => {
      // The member is gone, membership included.
      expect(await ctx.db.get(member)).toBeNull();
      const memberships = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .collect();
      expect(memberships.map((m) => m.userId)).toEqual([owner]);

      // The workspace, its owner, and its storage are untouched. This is the
      // half of the contract that protects everybody else.
      expect(await ctx.db.get(workspaceId)).not.toBeNull();
      expect(await ctx.db.get(owner)).not.toBeNull();
      expect(await ctx.db.query("storageBindings").collect()).toHaveLength(1);
      expect(await ctx.db.query("names").collect()).toHaveLength(1);
    });
  });

  test("a co-owner's deletion leaves the workspace with the surviving owner", async () => {
    const { t, owner, workspaceId } = await onboardedAccount();
    const coOwner = await createUser(t, "co-owner@example.invalid");
    await addMember(t, workspaceId, coOwner, "owner", owner);

    await asUser(t, coOwner).mutation(api.functions.account.deleteAccount, {});

    await t.run(async (ctx) => {
      expect(await ctx.db.get(coOwner)).toBeNull();
      // Another owner remains, so nothing of theirs may cascade: the
      // workspace, the surviving owner's membership, and the binding all
      // stand.
      expect(await ctx.db.get(workspaceId)).not.toBeNull();
      const memberships = await ctx.db
        .query("workspaceMembers")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .collect();
      expect(memberships).toHaveLength(1);
      expect(memberships[0]).toMatchObject({ userId: owner, role: "owner" });
      expect(await ctx.db.query("storageBindings").collect()).toHaveLength(1);
    });
  });

  test("requires authentication", async () => {
    const t = setupTest();
    const error = await captureError(() =>
      t.mutation(api.functions.account.deleteAccount, {}),
    );
    expect(errorCode(error)).toBe("NOT_AUTHENTICATED");
  });

  /**
   * Tenant isolation, proved in the one shape that actually proves it: two
   * workspaces, ONE `setupTest()`, ONE database. `docs/decisions/testing.md`
   * names the exact failure this guards: "the separate-database mistake has
   * produced [guards] tonight that passed for the wrong reason" — a second
   * `setupTest()` per workspace cannot collide by construction, so a cascade
   * that forgot its `workspaceId` filter entirely would still pass a test
   * shaped that way. Here both workspaces' rows sit in the same tables the
   * cascade queries, so a dropped filter has somewhere real to leak into.
   */
  test("deleting workspace A's owner never touches workspace B's rows, in the same database", async () => {
    const { t, owner: ownerA, workspaceId: workspaceA } = await onboardedAccount("workspace-a");
    const ownerB = await createUser(t, "owner-b@example.invalid");
    const workspaceB = await createWorkspace(t, ownerB, "workspace-b");
    await seedStorageBinding(t, { workspaceId: workspaceB, boundBy: ownerB });
    await seedGoogleConnection(t, { workspaceId: workspaceB, boundBy: ownerB });
    await seedGrant(t, workspaceB, ownerB, "client-claude", "fake-hash-b");

    await t.run(async (ctx) => {
      await ctx.db.insert("dropboxConnectAttempts", {
        hashedState: "fake-hashed-state-b",
        encryptedVerifier: "v2:current:FAKE:VERIFIER-B",
        workspaceId: workspaceB,
        startedBy: ownerB,
        redirectUri: "https://console.example/callback",
        expiresAt: Date.now() + 600_000,
        createdAt: Date.now(),
      });
      await ctx.db.insert("googleConnectAttempts", {
        hashedState: "fake-hashed-google-state-b",
        encryptedVerifier: "v2:current:FAKE:GOOGLE-VERIFIER-B",
        workspaceId: workspaceB,
        startedBy: ownerB,
        redirectUri: "https://console.example/mail/gmail/callback",
        products: ["gmail"],
        expiresAt: Date.now() + 600_000,
        createdAt: Date.now(),
      });
      await ctx.db.insert("auditEvents", {
        workspaceId: workspaceB,
        actorUserId: ownerB,
        action: "storage.bound",
        paths: [],
        at: Date.now(),
      });
    });

    await asUser(t, ownerA).mutation(api.functions.account.deleteAccount, {});

    await t.run(async (ctx) => {
      // A is gone.
      expect(await ctx.db.get(workspaceA)).toBeNull();
      expect(await ctx.db.get(ownerA)).toBeNull();

      // B — same tables, same database, different workspace — stands
      // untouched, row for row.
      expect(await ctx.db.get(workspaceB)).not.toBeNull();
      expect(await ctx.db.get(ownerB)).not.toBeNull();
      expect(
        await ctx.db
          .query("storageBindings")
          .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceB))
          .collect(),
      ).toHaveLength(1);
      expect(
        await ctx.db
          .query("googleConnections")
          .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceB))
          .collect(),
      ).toHaveLength(1);
      expect(
        await ctx.db
          .query("dropboxConnectAttempts")
          .filter((q) => q.eq(q.field("workspaceId"), workspaceB))
          .collect(),
      ).toHaveLength(1);
      expect(
        await ctx.db
          .query("googleConnectAttempts")
          .filter((q) => q.eq(q.field("workspaceId"), workspaceB))
          .collect(),
      ).toHaveLength(1);
      expect(
        await ctx.db
          .query("oauthGrants")
          .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceB))
          .collect(),
      ).toHaveLength(1);
      expect(
        await ctx.db
          .query("auditEvents")
          .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceB))
          .collect(),
      ).toHaveLength(1);
      expect(
        await ctx.db
          .query("workspaceMembers")
          .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceB))
          .collect(),
      ).toHaveLength(1);

      // Nothing scheduled for B's still-live Google connection — only A's
      // deletion ran, and A's cascade must not reach B's credential.
      const scheduled = await ctx.db.system.query("_scheduled_functions").collect();
      const revokes = scheduled.filter((job) => job.name.includes("revokeGoogleGrant"));
      expect(revokes).toHaveLength(0);
    });
  });
});

describe("a freed name inherits nothing", () => {
  /**
   * The invitation model resolves an addressee only at accept time — which is
   * right for email and for the enumeration defence, and is exactly why a
   * freed name is dangerous: a pending invitation to `@atlas` in somebody
   * else's workspace would be acceptable by the name's NEXT owner. Deletion
   * therefore voids pending invitations addressed to every name it releases.
   */
  test("pending invitations to the deleted name die with the account", async () => {
    const { t, owner } = await onboardedAccount("atlas");
    const friend = await createUser(t, "friend@example.invalid");
    const friendWorkspace = await createWorkspace(t, friend, "friends-place", {
      kind: "shared",
      displayName: "Friend's Place",
    });
    await asUser(t, friend).mutation(api.functions.invitations.inviteMember, {
      workspaceId: friendWorkspace,
      invitee: "@atlas",
      role: "editor",
    });

    await asUser(t, owner).mutation(api.functions.account.deleteAccount, {});

    // The row is gone outright — not expired, not declined: those are the
    // inviter's history, and this was never accepted by anybody.
    const leftover = await t.run((ctx) =>
      ctx.db
        .query("workspaceInvitations")
        .withIndex("by_invitee", (q) => q.eq("inviteeKind", "name").eq("invitee", "atlas"))
        .collect(),
    );
    expect(leftover).toEqual([]);

    // And the successor who claims the freed name starts with exactly one
    // context: their own.
    const successor = await createUser(t, "successor@example.invalid");
    await createWorkspace(t, successor, "atlas");
    const reachable = await asUser(t, successor).query(
      api.functions.workspaces.listMyWorkspaces,
      {},
    );
    expect(reachable.map((w) => w.slug)).toEqual(["atlas"]);
  });

  test("the inviter's history in OTHER states survives — only pending is a live key", async () => {
    const { t, owner } = await onboardedAccount("atlas");
    const friend = await createUser(t, "friend@example.invalid");
    const friendWorkspace = await createWorkspace(t, friend, "friends-place", {
      kind: "shared",
      displayName: "Friend's Place",
    });
    await asUser(t, friend).mutation(api.functions.invitations.inviteMember, {
      workspaceId: friendWorkspace,
      invitee: "@atlas",
      role: "editor",
    });
    // Mark it declined by hand: what matters is the status, not the journey.
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("workspaceInvitations")
        .withIndex("by_invitee", (q) => q.eq("inviteeKind", "name").eq("invitee", "atlas"))
        .unique();
      await ctx.db.patch(row!._id, { status: "declined" });
    });

    await asUser(t, owner).mutation(api.functions.account.deleteAccount, {});

    const kept = await t.run((ctx) =>
      ctx.db
        .query("workspaceInvitations")
        .withIndex("by_invitee", (q) => q.eq("inviteeKind", "name").eq("invitee", "atlas"))
        .collect(),
    );
    expect(kept.map((row) => row.status)).toEqual(["declined"]);
  });
});
