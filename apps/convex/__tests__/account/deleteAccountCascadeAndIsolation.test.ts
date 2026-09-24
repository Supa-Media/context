import { describe, expect, test, vi } from "vitest";
import { api } from "../../_generated/api";
import {
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  drainScheduled,
  errorCode,
  seedGoogleConnection,
  seedGrant,
  seedStorageBinding,
  setupTest,
} from "../fixtures.helpers";
import {
  onboardedAccount,
} from "./fixtures.helpers";

describe("deleteAccount", () => {
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

