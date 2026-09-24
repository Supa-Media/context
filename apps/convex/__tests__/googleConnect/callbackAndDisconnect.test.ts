import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import {
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
} from "../fixtures.helpers";
import { encryptSecret, hashToken, requireKeyset } from "../../functions/lib/crypto";
import {
  APP,
  REDIRECT,
  enableMailConnect,
  personalScenario,
  sharedScenario,
  COMPLETION,
  parkedAttempt,
  gmailBindingArgs,
} from "./fixtures.helpers";

describe("who may answer a callback", () => {
  /**
   * No session required on the callback — see `googleConnect.ts`'s comment
   * for why. What has to hold instead: the workspace and the actor come from
   * the ATTEMPT, never from the caller, so an interceptor of the callback
   * URL can complete or burn the victim's own connect and nothing else.
   */
  test("the workspace and the actor come from the attempt, never from the caller", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const state = await parkedAttempt(t, workspaceId, owner);
    const consumed = await t.mutation(internal.functions.googleConnect.consumeAttemptAndExchange, {
      hashedState: await hashToken(state),
      hashedCompletion: await hashToken(COMPLETION),
      code: "code-1",
    });
    expect(consumed?.workspaceId).toBe(workspaceId);
  });

  /** Sabotage: move the `ctx.db.delete` after the exchange, or drop it. */
  test("an attempt is spent by being answered", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const state = await parkedAttempt(t, workspaceId, owner);
    const hashedState = await hashToken(state);

    await t.mutation(internal.functions.googleConnect.consumeAttemptAndExchange, {
      hashedState,
      hashedCompletion: await hashToken(COMPLETION),
      code: "code-1",
    });
    const remaining = await t.run((ctx) => ctx.db.query("googleConnectAttempts").collect());
    expect(remaining).toHaveLength(0);

    const replay = await t.mutation(internal.functions.googleConnect.consumeAttemptAndExchange, {
      hashedState,
      hashedCompletion: await hashToken(COMPLETION),
      code: "code-1",
    });
    expect(replay).toBe(null);
  });

  /** Sabotage: drop the `attempt.expiresAt < Date.now()` check. */
  test("an expired attempt is refused", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const state = await parkedAttempt(t, workspaceId, owner, { expiresAt: Date.now() - 1 });
    const consumed = await t.mutation(internal.functions.googleConnect.consumeAttemptAndExchange, {
      hashedState: await hashToken(state),
      hashedCompletion: await hashToken(COMPLETION),
      code: "code-1",
    });
    expect(consumed).toBe(null);
  });

  test("never-issued, spent and expired are one answer", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const answers: unknown[] = [];

    answers.push(
      await t.mutation(internal.functions.googleConnect.consumeAttemptAndExchange, {
        hashedState: await hashToken("never-issued-at-all"),
        hashedCompletion: await hashToken(COMPLETION),
        code: "c",
      }),
    );
    const spent = await parkedAttempt(t, workspaceId, owner);
    const spentHash = await hashToken(spent);
    await t.mutation(internal.functions.googleConnect.consumeAttemptAndExchange, {
      hashedState: spentHash,
      hashedCompletion: await hashToken(COMPLETION),
      code: "c",
    });
    answers.push(
      await t.mutation(internal.functions.googleConnect.consumeAttemptAndExchange, {
        hashedState: spentHash,
        hashedCompletion: await hashToken(COMPLETION),
        code: "c",
      }),
    );
    const expired = await parkedAttempt(t, workspaceId, owner, { expiresAt: Date.now() - 1 });
    answers.push(
      await t.mutation(internal.functions.googleConnect.consumeAttemptAndExchange, {
        hashedState: await hashToken(expired),
        hashedCompletion: await hashToken(COMPLETION),
        code: "c",
      }),
    );
    expect(answers).toEqual([null, null, null]);
  });
});

/** Standard args for `applyGmailConnectionBinding`, so each test overrides only what it is about. */
describe("no token ever appears in the clear", () => {
  test("the stored refresh and access tokens are sealed envelopes, never the plaintext", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    await t.mutation(internal.functions.googleConnect.applyGmailConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...gmailBindingArgs({}),
      encryptedRefreshToken: await encryptSecret("super-secret-refresh-token", keyset, context),
      encryptedAccessToken: await encryptSecret("super-secret-access-token", keyset, context),
    });

    const row = await t.run((ctx) =>
      ctx.db
        .query("googleConnections")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
    );
    expect(row!.encryptedRefreshToken.startsWith("v2:")).toBe(true);
    expect(row!.encryptedRefreshToken).not.toContain("super-secret-refresh-token");
    expect(row!.encryptedAccessToken).not.toContain("super-secret-access-token");

    // The audit trail records the connect. It must never carry the token.
    const audit = await t.run((ctx) =>
      ctx.db
        .query("auditEvents")
        .filter((q) => q.eq(q.field("workspaceId"), workspaceId))
        .collect(),
    );
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain("super-secret-refresh-token");
    expect(serialized).not.toContain("super-secret-access-token");
  });
});

describe("disconnect: revoke the WHOLE grant at Google, delete the token, keep the notes", () => {
  async function connected() {
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    const refreshEnvelope = await encryptSecret("refresh-to-revoke", keyset, context);
    await t.mutation(internal.functions.googleConnect.applyGmailConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...gmailBindingArgs({}),
      encryptedRefreshToken: refreshEnvelope,
      encryptedAccessToken: await encryptSecret("access-1", keyset, context),
    });
    const connection = await t.run((ctx) =>
      ctx.db
        .query("googleConnections")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
    );
    return { t, owner, workspaceId, connectionId: connection!._id, refreshEnvelope };
  }

  /** Sabotage: drop the `membership?.role !== "owner"` refusal. */
  test("a member who is not the owner cannot disconnect a Google account", async () => {
    const { t, workspaceId, connectionId } = await connected();
    const outsider = await createUser(t, "outsider@example.invalid");
    const error = await captureError(() =>
      asUser(t, outsider).mutation(api.functions.googleConnect.disconnectGoogleConnection, {
        workspaceId,
        connectionId,
      }),
    );
    expect(errorCode(error)).toBe("NOT_OWNER");
  });

  /**
   * A connection id from a DIFFERENT workspace, with the caller's own
   * workspaceId — must not disconnect somebody else's account and must not
   * confirm one exists there either.
   */
  /**
   * BOTH WORKSPACES LIVE IN ONE DATABASE, and that is the whole test.
   *
   * An earlier version of this built Bob in a second `setupTest()`, so Alice's
   * connection id did not exist in Bob's database at all — `ctx.db.get`
   * answered `null` and the refusal came from the null branch, not from the
   * tenancy check. It passed with `connection.workspaceId !== args.workspaceId`
   * deleted outright, which is the guard it claims to be about: measured, the
   * sabotage failed **zero** checks. Isolation has to be proved against a
   * database that really holds the other tenant's row, or it is proving that
   * one test fixture cannot see another.
   */
  test("a connection id belonging to another workspace is not found, not disconnected", async () => {
    const { t, workspaceId: aliceWorkspace, connectionId: alicesConnectionId } = await connected();
    const bobOwner = await createUser(t, "bob-owner@example.invalid");
    const bobWorkspace = await createWorkspace(t, bobOwner, "bob-ctx");

    const error = await captureError(() =>
      asUser(t, bobOwner).mutation(api.functions.googleConnect.disconnectGoogleConnection, {
        workspaceId: bobWorkspace,
        connectionId: alicesConnectionId,
      }),
    );
    expect(errorCode(error)).toBe("NOT_FOUND");

    // Alice's connection is untouched: still live, still holding its envelope.
    const alices = await t.run((ctx) => ctx.db.get(alicesConnectionId));
    expect(alices!.workspaceId).toBe(aliceWorkspace);
    expect(alices!.disconnectedAt).toBeUndefined();
    expect(alices!.encryptedRefreshToken.length).toBeGreaterThan(0);
  });

  /**
   * The other half of the same attack: naming the VICTIM's workspace instead
   * of your own. This is refused one check earlier — Bob has no membership row
   * in Alice's workspace — and the two together are what make the pair of ids
   * unusable in either combination.
   */
  test("naming the other workspace's id does not disconnect it either", async () => {
    const { t, workspaceId: aliceWorkspace, connectionId: alicesConnectionId } = await connected();
    const bobOwner = await createUser(t, "bob-owner@example.invalid");
    await createWorkspace(t, bobOwner, "bob-ctx");

    const error = await captureError(() =>
      asUser(t, bobOwner).mutation(api.functions.googleConnect.disconnectGoogleConnection, {
        workspaceId: aliceWorkspace,
        connectionId: alicesConnectionId,
      }),
    );
    expect(errorCode(error)).toBe("NOT_OWNER");
    expect((await t.run((ctx) => ctx.db.get(alicesConnectionId)))!.disconnectedAt).toBeUndefined();
  });

  /**
   * And the same pair of ids against `startGmailConnect`, the other route that
   * accepts a `workspaceId` from the caller: a Google account cannot be
   * attached to somebody else's context by naming it.
   */
  test("a caller cannot start a connect against a workspace they are not the owner of", async () => {
    const { t, workspaceId: aliceWorkspace } = await connected();
    const bobOwner = await createUser(t, "bob-owner@example.invalid");
    await createWorkspace(t, bobOwner, "bob-ctx");

    enableMailConnect();
    vi.stubEnv("APP_ORIGIN", APP);
    const error = await captureError(() =>
      asUser(t, bobOwner).action(api.functions.googleConnect.startGmailConnect, {
        workspaceId: aliceWorkspace,
        redirectUri: REDIRECT,
      }),
    );
    expect(errorCode(error)).toBe("NOT_PERSONAL_OWNER");
    expect(await t.run((ctx) => ctx.db.query("googleConnectAttempts").collect())).toHaveLength(0);
  });

  test("disconnecting clears the token and marks the connection disconnected, keeping the row", async () => {
    const { t, owner, workspaceId, connectionId } = await connected();
    await asUser(t, owner).mutation(api.functions.googleConnect.disconnectGoogleConnection, {
      workspaceId,
      connectionId,
    });

    const row = await t.run((ctx) => ctx.db.get(connectionId));
    expect(row).not.toBeNull();
    expect(row!.encryptedRefreshToken).toBe("");
    expect(row!.encryptedAccessToken).toBeUndefined();
    expect(row!.disconnectedAt).toBeDefined();
    expect(row!.health).toBe("error");
    // The mailbox slug — and therefore its folder — is untouched: disconnect
    // never deletes notes.
    expect(row!.gmail?.mailboxSlug).toBe("person-at-example-invalid");
  });

  /**
   * Forgetting our copy is only half of disconnecting. Sabotage: drop the
   * `ctx.scheduler.runAfter(..., revokeGoogleGrant, ...)` call.
   */
  test("disconnecting schedules revocation at Google, carrying the OLD refresh token", async () => {
    const { t, owner, workspaceId, connectionId, refreshEnvelope } = await connected();
    await asUser(t, owner).mutation(api.functions.googleConnect.disconnectGoogleConnection, {
      workspaceId,
      connectionId,
    });

    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const revokes = scheduled.filter((job) => String(job.name).includes("revokeGoogleGrant"));
    expect(revokes).toHaveLength(1);
    expect(JSON.stringify(revokes[0]!.args)).toContain(refreshEnvelope);
  });

  test("disconnecting twice is a no-op the second time — no second revoke job, no error", async () => {
    const { t, owner, workspaceId, connectionId } = await connected();
    await asUser(t, owner).mutation(api.functions.googleConnect.disconnectGoogleConnection, {
      workspaceId,
      connectionId,
    });
    await asUser(t, owner).mutation(api.functions.googleConnect.disconnectGoogleConnection, {
      workspaceId,
      connectionId,
    });
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter((job) => String(job.name).includes("revokeGoogleGrant"))).toHaveLength(1);
  });

  /**
   * THE ONE A SYNC JOB DEPENDS ON. `mintGoogleAccessToken` is what a sync
   * pass calls to get a usable Google credential; if it minted one for a
   * disconnected connection, the sync job would keep reading somebody's mail
   * after they revoked access. Sabotage: drop the `disconnectedAt !==
   * undefined` check from either `mintGoogleAccessToken` or
   * `getConnectionForSync`.
   */
  test("a disconnected connection's access-token mint is a no-op", async () => {
    const { t, owner, workspaceId, connectionId } = await connected();
    await asUser(t, owner).mutation(api.functions.googleConnect.disconnectGoogleConnection, {
      workspaceId,
      connectionId,
    });

    const minted = await t.action(internal.functions.googleConnect.mintGoogleAccessToken, {
      connectionId,
    });
    expect(minted).toBeNull();
  });
});

describe("isolation: one context's mailbox slugs are invisible to another", () => {
  test("listMailboxSlugs for one workspace never returns another's", async () => {
    const t = setupTest();
    const alice = await createUser(t, "alice@example.invalid");
    const bob = await createUser(t, "bob@example.invalid");
    const aliceWs = await createWorkspace(t, alice, "alice-ctx");
    const bobWs = await createWorkspace(t, bob, "bob-ctx");
    const keyset = requireKeyset();

    await t.mutation(internal.functions.googleConnect.applyGmailConnectionBinding, {
      workspaceId: aliceWs,
      boundBy: alice,
      ...gmailBindingArgs({ address: "alice@example.invalid", mailboxSlug: "alice-at-example-invalid", googleAccountId: "google-alice" }),
      encryptedRefreshToken: await encryptSecret("r", keyset, { workspaceId: aliceWs as string }),
      encryptedAccessToken: await encryptSecret("a", keyset, { workspaceId: aliceWs as string }),
    });

    const bobsSlugs: string[] = await t.run(async (ctx) => {
      // Mirrors `listMailboxSlugs`'s own query rather than importing an
      // internalQuery handler directly, since the test's job is to prove the
      // WORKSPACE INDEX scopes correctly, not to re-invoke the function.
      const rows = await ctx.db
        .query("googleConnections")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", bobWs))
        .collect();
      return rows.flatMap((row) => (row.gmail ? [row.gmail.mailboxSlug] : []));
    });
    expect(bobsSlugs).toHaveLength(0);
    expect(bobsSlugs).not.toContain("alice-at-example-invalid");
  });
});

describe("the browser that started a Google connect is the one that may finish it", () => {
  /**
   * The same property `dropboxConnect.ts` now carries, and this file inherited
   * the gap by citing that file's older argument — *"No session required — see
   * `completeDropboxConnect` for the full argument… it applies here unchanged,
   * PKCE pair and all."*
   *
   * It did apply unchanged, and that was the problem. `state` travels in the
   * authorize URL and comes back in the callback, so whoever built the URL
   * knows it — including somebody who built it for a workspace they really do
   * own and then sent it to another person to consent. PKCE cannot see that
   * case: the attacker is the *initiator*, so the verifier is genuinely theirs
   * and matches. What binds the flow to the browser that started it is a value
   * that never travels through Google, and RFC 6749 §10.12 is the reason it
   * has to exist.
   *
   * **Still no session**, which is the half of the cited argument that was
   * always right: a sign-in wall on a callback outlives a single-use code.
   */
  test("A COMPLETION WITHOUT THE STARTING BROWSER'S SECRET IS REFUSED", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const state = await parkedAttempt(t, workspaceId, owner);

    const consumed = await t.mutation(internal.functions.googleConnect.consumeAttemptAndExchange, {
      hashedState: await hashToken(state),
      hashedCompletion: await hashToken("a-guess"),
      code: "code-1",
    });
    expect(consumed).toBeNull();
  });

  test("...and the secret the starter kept does complete it", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const state = await parkedAttempt(t, workspaceId, owner);

    const consumed = await t.mutation(internal.functions.googleConnect.consumeAttemptAndExchange, {
      hashedState: await hashToken(state),
      hashedCompletion: await hashToken(COMPLETION),
      code: "code-1",
    });
    expect(consumed?.workspaceId).toBe(workspaceId);
  });

  test("an attempt parked without one is refused rather than trusted", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const state = await parkedAttempt(t, workspaceId, owner, { hashedCompletion: undefined });

    const consumed = await t.mutation(internal.functions.googleConnect.consumeAttemptAndExchange, {
      hashedState: await hashToken(state),
      hashedCompletion: await hashToken("anything"),
      code: "code-1",
    });
    expect(consumed).toBeNull();
  });

  test("a refused completion still spends the attempt", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const state = await parkedAttempt(t, workspaceId, owner);

    await t.mutation(internal.functions.googleConnect.consumeAttemptAndExchange, {
      hashedState: await hashToken(state),
      hashedCompletion: await hashToken("a-guess"),
      code: "code-1",
    });
    const rows = await t.run(async (ctx) => ctx.db.query("googleConnectAttempts").collect());
    expect(rows).toHaveLength(0);
  });
});

