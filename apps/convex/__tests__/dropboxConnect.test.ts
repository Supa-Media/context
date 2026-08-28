/**
 * The connect flow's security half, which had no test at all.
 *
 * `dropboxConnect.ts` shipped 428 lines carrying three controls — an owner
 * check, single-use consumption of the attempt, and the binding of an attempt
 * to the person who started it — and every one of them could be deleted with
 * the whole suite green. The file's own docstring calls `state` "the security
 * half this feature's original plan simply missed", which is exactly the kind
 * of claim that needs a check behind it rather than a sentence.
 *
 * Each test below names the sabotage it catches. That is the contract: revert
 * the control and this file goes red, or the control is not guarded.
 */

import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import {
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
} from "./fixtures.helpers";
import { encryptSecret, hashToken, requireKeyset } from "../functions/lib/crypto";
import { dropboxRedirectAllowed } from "../functions/lib/dropboxOAuth";
import {
  DROPBOX_CALLBACK_PATH,
  DROPBOX_REDIRECT_ORIGINS,
} from "../../mobile/features/console/storage/dropbox";

// Must match `vitest.config.ts`'s `APP_ORIGIN`. It did not, and the two tests
// below that go through the real action were passing for the wrong reason:
// every non-loopback URI was refused in that environment, so a working
// allow-list and a blanket refusal were indistinguishable.
const APP = "https://app.context.invalid";

async function scenario() {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas");
  return { t, owner, workspaceId };
}

/** An attempt row, parked as `startDropboxConnect` would park it. */
async function parkedAttempt(
  t: Awaited<ReturnType<typeof scenario>>["t"],
  workspaceId: Parameters<typeof createWorkspace> extends never ? never : any,
  startedBy: any,
  overrides: Record<string, unknown> = {},
) {
  const state = "state-token-0123456789";
  const keyset = requireKeyset();
  const now = Date.now();
  await t.run(async (ctx) =>
    ctx.db.insert("dropboxConnectAttempts", {
      workspaceId,
      startedBy,
      hashedState: await hashToken(state),
      encryptedVerifier: await encryptSecret("verifier-abc", keyset, {
        workspaceId: workspaceId as string,
      }),
      redirectUri: `${APP}/storage/dropbox/callback`,
      expiresAt: now + 600_000,
      createdAt: now,
      ...overrides,
    }),
  );
  return state;
}

describe("who may start a connect", () => {
  /**
   * Sabotage: neuter the `if (!isOwner)` refusal. Repointing a context's
   * storage is the most consequential act available to an owner — every note
   * written afterwards lands somewhere else — and a member must not have it.
   */
  test("a member who is not the owner cannot start one", async () => {
    const { t, workspaceId } = await scenario();
    const outsider = await createUser(t, "outsider@example.invalid");
    const error = await captureError(() =>
      asUser(t, outsider).action(api.functions.dropboxConnect.startDropboxConnect, {
        workspaceId,
        redirectUri: `${APP}/storage/dropbox/callback`,
      }),
    );
    expect(errorCode(error)).toBe("NOT_OWNER");
  });

  /**
   * Sabotage: drop the `dropboxRedirectAllowed` refusal.
   *
   * An arbitrary redirect makes this a confused deputy with our consent screen
   * on the front of it. The attacker starts a connect against their OWN
   * workspace pointing at their own callback, sends the victim the authorize
   * URL — a genuine `www.dropbox.com` screen for the real Context app — and
   * completes the flow as themselves. Their workspace binds to the victim's
   * Dropbox. The `startedBy` check cannot catch it: the attacker really did
   * start their own attempt.
   */
  test("a redirect URI off this deployment's origin is refused", async () => {
    const { t, owner, workspaceId } = await scenario();
    const error = await captureError(() =>
      asUser(t, owner).action(api.functions.dropboxConnect.startDropboxConnect, {
        workspaceId,
        redirectUri: "https://attacker.example/cb",
      }),
    );
    expect(errorCode(error)).toBe("REDIRECT_URI_NOT_ALLOWED");
  });

  test("a permitted redirect gets through the refusal", async () => {
    // Without this, the refusal test above cannot tell a working allow-list
    // from a blanket refusal — and the environment really did refuse
    // everything, so it was proving nothing. `startDropboxConnect` still fails
    // afterwards for want of a Dropbox app key; what matters is that it fails
    // somewhere OTHER than the redirect check.
    const { t, owner, workspaceId } = await scenario();
    const error = await captureError(() =>
      asUser(t, owner).action(api.functions.dropboxConnect.startDropboxConnect, {
        workspaceId,
        redirectUri: `${APP}/storage/dropbox/callback`,
      }),
    );
    expect(errorCode(error)).not.toBe("REDIRECT_URI_NOT_ALLOWED");
  });

  test("and nothing is parked when it is refused", async () => {
    const { t, owner, workspaceId } = await scenario();
    await captureError(() =>
      asUser(t, owner).action(api.functions.dropboxConnect.startDropboxConnect, {
        workspaceId,
        redirectUri: "https://attacker.example/cb",
      }),
    );
    const parked = await t.run(async (ctx) => ctx.db.query("dropboxConnectAttempts").collect());
    // A refused attempt must not leave a PKCE verifier behind. The schema's own
    // comment calls a parked verifier "a live half-credential".
    expect(parked).toHaveLength(0);
  });
});

describe("which redirect URIs this deployment answers on", () => {
  const env = { APP_ORIGIN: APP };

  test("its own origin, exactly", () => {
    expect(dropboxRedirectAllowed(`${APP}/storage/dropbox/callback`, env)).toBe(true);
    expect(dropboxRedirectAllowed(APP, env)).toBe(true);
  });

  test("and nothing that merely looks like it", () => {
    for (const hostile of [
      "https://attacker.example/cb",
      // Suffix, prefix, and port confusion — the three ways an inexact match is
      // defeated, and the list has to actually contain all three. It named
      // three and covered two: the shape an `endsWith` bug produces is an
      // attacker prefix on OUR domain, and `evilapp.context.invalid` is a
      // domain anybody can register.
      "https://evilapp.context.invalid/cb",
      "https://app.context.invalid.evil.example/cb",
      "https://evil.example/app.context.invalid",
      "https://app.context.invalid:8443/cb",
      "http://app.context.invalid/cb",
      // The loopback branch is an exact set, not a substring test. Both of
      // these are hosts an attacker controls.
      "https://localhost.evil.example/cb",
      "http://127.0.0.1.evil.example/cb",
      "javascript:alert(1)",
      "",
    ]) {
      expect(dropboxRedirectAllowed(hostile, env), hostile).toBe(false);
    }
  });

  test("and nothing `redirectUriIsAcceptable` would refuse on its own", () => {
    // That precheck does three jobs — refuse a fragment (RFC 6749 §3.1.2), cap
    // the length, refuse plaintext http off loopback — and all three were
    // unguarded here: it could be deleted outright with the suite green. The
    // `javascript:` case above does not cover it, because that fails on the
    // origin comparison rather than on the precheck.
    expect(dropboxRedirectAllowed(`${APP}/cb#fragment`, env)).toBe(false);
    expect(dropboxRedirectAllowed(`${APP}/${"A".repeat(4000)}`, env)).toBe(false);
  });

  test("the origins the console actually sends are accepted by the pin", () => {
    // Two sources of truth for one fact, with nothing binding them: the client
    // sends a frozen list, the server pins to APP_ORIGIN, and `.env.example`
    // documents APP_ORIGIN with an `app.` subdomain while the client's list is
    // the apex. If they disagree, every production connect fails closed with
    // REDIRECT_URI_NOT_ALLOWED and no test would say so.
    for (const origin of DROPBOX_REDIRECT_ORIGINS) {
      expect(
        dropboxRedirectAllowed(`${origin}${DROPBOX_CALLBACK_PATH}`, {
          APP_ORIGIN: "https://context.lc",
        }),
        origin,
      ).toBe(true);
    }
  });

  test("loopback always, so `convex dev` works with no APP_ORIGIN", () => {
    expect(dropboxRedirectAllowed("http://127.0.0.1:5173/cb", {})).toBe(true);
    expect(dropboxRedirectAllowed("http://localhost:5173/cb", {})).toBe(true);
  });

  test("an unset APP_ORIGIN means loopback only, which is fail-closed", () => {
    expect(dropboxRedirectAllowed(`${APP}/cb`, {})).toBe(false);
    expect(dropboxRedirectAllowed(`${APP}/cb`, { APP_ORIGIN: "" })).toBe(false);
    expect(dropboxRedirectAllowed(`${APP}/cb`, { APP_ORIGIN: "not-a-url" })).toBe(false);
    // An http APP_ORIGIN does not authorize an https redirect, or anything.
    expect(dropboxRedirectAllowed("http://console.example.invalid/cb", {
      APP_ORIGIN: "http://console.example.invalid",
    })).toBe(false);
  });
});

describe("who may answer a connect", () => {
  /**
   * `#76` removed the `startedBy` check on the callback, deliberately, and the
   * reasoning above `completeDropboxConnect` holds: an interceptor of the full
   * callback URL can complete — or, by failing the exchange, burn — the
   * victim's *own* connect, which was the victim's intent anyway. Availability,
   * not access. The check cost the flow one more way to fail for its owner, and
   * on the first real run it was the only thing that did.
   *
   * What makes that safe is what this block pins instead: the binding goes to
   * the workspace the ATTEMPT names, with the starter as `boundBy`, and a
   * caller supplies neither. The attack the check appeared to stop — an
   * attacker's workspace binding to the victim's Dropbox — was never stopped by
   * it (the attacker really did start their own attempt); it is stopped by the
   * redirect pin above.
   */
  test("the workspace and the actor come from the attempt, never from the caller", async () => {
    const { t, owner, workspaceId } = await scenario();
    const state = await parkedAttempt(t, workspaceId, owner);

    const consumed = await t.mutation(
      internal.functions.dropboxConnect.consumeAttemptAndExchange,
      { hashedState: await hashToken(state), code: "code-1" },
    );
    expect(consumed?.workspaceId).toBe(workspaceId);
  });

  /**
   * Sabotage: move the `ctx.db.delete` after the exchange, or drop it.
   * Deleting before it is used means a code that fails at the exchange has
   * still spent its attempt — otherwise one intercepted callback URL becomes
   * unlimited attempts at the same state. This matters MORE since `#76`, not
   * less: it is now the only thing bounding what an interceptor can do.
   */
  test("an attempt is spent by being answered", async () => {
    const { t, owner, workspaceId } = await scenario();
    const state = await parkedAttempt(t, workspaceId, owner);
    const hashedState = await hashToken(state);

    await t.mutation(internal.functions.dropboxConnect.consumeAttemptAndExchange, {
      hashedState,
      code: "code-1",
    });
    const remaining = await t.run(async (ctx) =>
      ctx.db.query("dropboxConnectAttempts").collect(),
    );
    expect(remaining).toHaveLength(0);

    const replay = await t.mutation(
      internal.functions.dropboxConnect.consumeAttemptAndExchange,
      { hashedState, code: "code-1" },
    );
    expect(replay).toBe(null);
  });

  /** Sabotage: drop the `attempt.expiresAt < Date.now()` check. */
  test("an expired attempt is refused", async () => {
    const { t, owner, workspaceId } = await scenario();
    const state = await parkedAttempt(t, workspaceId, owner, {
      expiresAt: Date.now() - 1,
    });
    const consumed = await t.mutation(
      internal.functions.dropboxConnect.consumeAttemptAndExchange,
      { hashedState: await hashToken(state), code: "code-1" },
    );
    expect(consumed).toBe(null);
  });

  /**
   * Every refusal is the same refusal — never-issued, already-answered and
   * expired are one absence, for the reason `invitationNotFound()` gives one
   * file over.
   */
  test("never-issued, spent and expired are one answer", async () => {
    const { t, owner, workspaceId } = await scenario();
    const answers: unknown[] = [];

    answers.push(
      await t.mutation(internal.functions.dropboxConnect.consumeAttemptAndExchange, {
        hashedState: await hashToken("never-issued-at-all"),
        code: "c",
      }),
    );
    const spent = await parkedAttempt(t, workspaceId, owner);
    const spentHash = await hashToken(spent);
    await t.mutation(internal.functions.dropboxConnect.consumeAttemptAndExchange, {
      hashedState: spentHash,
      code: "c",
    });
    answers.push(
      await t.mutation(internal.functions.dropboxConnect.consumeAttemptAndExchange, {
        hashedState: spentHash,
        code: "c",
      }),
    );
    const expired = await parkedAttempt(t, workspaceId, owner, { expiresAt: Date.now() - 1 });
    answers.push(
      await t.mutation(internal.functions.dropboxConnect.consumeAttemptAndExchange, {
        hashedState: await hashToken(expired),
        code: "c",
      }),
    );
    expect(answers).toEqual([null, null, null]);
  });
});

describe("what a rebind leaves behind", () => {
  /**
   * THE ONE THAT IS INVISIBLE AFTERWARDS.
   *
   * `applyDropboxBinding` clears every S3 field on the way in, and says why:
   * "what is true of the old storage is not true of the new." The reverse
   * direction was never written. So a customer who moved off Dropbox onto
   * their own bucket saw an S3 binding in the console — `getStorageBinding`
   * returns no Dropbox field at all, not even `dropboxAccountId` — while the
   * control plane still held a live refresh token for their Dropbox, kept
   * alive indefinitely because key rotation walks `ENVELOPE_FIELDS` every pass.
   *
   * That is the inverse of "a customer can revoke our storage credential
   * without asking us first": they did the thing that ends the relationship,
   * the product agreed, and the credential stayed.
   *
   * Sabotage: remove the four `undefined` lines from `applyBinding`'s reset.
   */
  test("rebinding a Dropbox context to a bucket drops the Dropbox grant", async () => {
    const { t, owner, workspaceId } = await scenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    const now = Date.now();
    await t.run(async (ctx) =>
      ctx.db.insert("storageBindings", {
        workspaceId,
        provider: "dropbox" as const,
        rootPrefix: "Context/",
        encryptedRefreshToken: await encryptSecret("refresh-abc", keyset, context),
        encryptedAccessToken: await encryptSecret("access-xyz", keyset, context),
        accessTokenExpiresAt: now + 3_600_000,
        dropboxAccountId: "dbid:AAA",
        capabilities: { conditionalWrite: true },
        status: "connected" as const,
        boundBy: owner,
        createdAt: now,
        updatedAt: now,
      }),
    );

    await t.mutation(internal.functions.storage.applyBinding, {
      actorUserId: owner,
      workspaceId,
      provider: "s3" as const,
      endpoint: "https://s3.example.invalid",
      region: "us-east-1",
      bucket: "my-own-bucket",
      accessKeyId: "AKIAFAKEFAKEFAKE",
      encryptedSecretAccessKey: await encryptSecret("s3-secret", keyset, context),
    });

    const row = await t.run(async (ctx) =>
      ctx.db
        .query("storageBindings")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
    );
    expect(row?.provider).toBe("s3");
    expect(row?.encryptedRefreshToken).toBeUndefined();
    expect(row?.encryptedAccessToken).toBeUndefined();
    expect(row?.accessTokenExpiresAt).toBeUndefined();
    expect(row?.dropboxAccountId).toBeUndefined();
  });

  /**
   * Forgetting our copy is only half of it.
   *
   * `disconnectStorage` schedules `revokeDropboxGrant` and says why: without
   * it "we forget our copy of the credential while the authorization lives on
   * in the person's account, and their next connect silently auto-approves
   * instead of asking". A rebind from Dropbox to a bucket ends the Dropbox
   * relationship exactly as definitively — the customer moved their context
   * somewhere else — and it took the other half of the fix and not this one.
   *
   * Sabotage: drop the scheduler call from `applyBinding`.
   */
  test("rebinding away from Dropbox also revokes the grant at Dropbox", async () => {
    const { t, owner, workspaceId } = await scenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    const now = Date.now();
    const dropboxEnvelope = await encryptSecret("refresh-abc", keyset, context);
    const bucketEnvelope = await encryptSecret("s3-secret", keyset, context);
    await t.run(async (ctx) =>
      ctx.db.insert("storageBindings", {
        workspaceId,
        provider: "dropbox" as const,
        rootPrefix: "Context/",
        encryptedRefreshToken: dropboxEnvelope,
        encryptedAccessToken: await encryptSecret("access-xyz", keyset, context),
        accessTokenExpiresAt: now + 3_600_000,
        dropboxAccountId: "dbid:AAA",
        capabilities: { conditionalWrite: true },
        status: "connected" as const,
        boundBy: owner,
        createdAt: now,
        updatedAt: now,
      }),
    );

    await t.mutation(internal.functions.storage.applyBinding, {
      actorUserId: owner,
      workspaceId,
      provider: "s3" as const,
      endpoint: "https://s3.example.invalid",
      region: "us-east-1",
      bucket: "my-own-bucket",
      accessKeyId: "AKIAFAKEFAKEFAKE",
      encryptedSecretAccessKey: bucketEnvelope,
    });

    const scheduled = await t.run(async (ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const revokes = scheduled.filter((job) =>
      String(job.name).includes("revokeDropboxGrant"),
    );
    expect(revokes).toHaveLength(1);
    // WHICH envelope, not just how many jobs. Counting alone lets
    // `existing.encryptedRefreshToken` become `args.encryptedSecretAccessKey`
    // — one token's difference — with the whole suite green, and that would
    // hand a bucket secret to Dropbox's revoke endpoint. `storage.test.ts`'s
    // disconnect test already asserts the payload; these dropped the one line
    // that made it evidence.
    const args = JSON.stringify(revokes[0]!.args);
    expect(args).toContain(dropboxEnvelope);
    expect(args).not.toContain(bucketEnvelope);
  });

  /**
   * The same gap, one path over: reconnecting to a DIFFERENT Dropbox account.
   *
   * `applyDropboxBinding` overwrites the envelope with the new account's, so
   * the old account's authorization is orphaned — still live in a Dropbox
   * nobody is pointing at any more. The schema's own comment says this case is
   * expected and worth telling apart: `dropboxAccountId` exists so a reconnect
   * can "notice that a *different* account just arrived, which is the
   * difference between 'you signed in again' and 'your context now points
   * somewhere else'".
   *
   * Scoped to a differing account on purpose. Revoking on a same-account
   * reconnect would mean revoking a token from the same authorization the new
   * one came from, and Dropbox's semantics there are not something to guess at
   * from a comment.
   */
  test("reconnecting to a different Dropbox account revokes the old one", async () => {
    const { t, owner, workspaceId } = await scenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    const now = Date.now();
    const oldEnvelope = await encryptSecret("old-refresh", keyset, context);
    await t.run(async (ctx) =>
      ctx.db.insert("storageBindings", {
        workspaceId,
        provider: "dropbox" as const,
        encryptedRefreshToken: oldEnvelope,
        encryptedAccessToken: await encryptSecret("old-access", keyset, context),
        accessTokenExpiresAt: now + 3_600_000,
        dropboxAccountId: "dbid:OLD",
        capabilities: { conditionalWrite: true },
        status: "connected" as const,
        boundBy: owner,
        createdAt: now,
        updatedAt: now,
      }),
    );

    const newEnvelope = await encryptSecret("new-refresh", keyset, context);
    await t.mutation(internal.functions.dropboxConnect.applyDropboxBinding, {
      workspaceId,
      boundBy: owner,
      rootPrefix: undefined,
      encryptedRefreshToken: newEnvelope,
      encryptedAccessToken: await encryptSecret("new-access", keyset, context),
      accessTokenExpiresAt: now + 3_600_000,
      dropboxAccountId: "dbid:NEW",
    });

    const scheduled = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    const revokes = scheduled.filter((job) =>
      String(job.name).includes("revokeDropboxGrant"),
    );
    expect(revokes).toHaveLength(1);
    // THE OLD one, and provably not the new one. Both envelopes are in scope
    // here and the difference is `existing.` versus `args.` — a single token.
    // Getting it wrong revokes the grant this reconnect just minted: the app
    // vanishes from the person's connected-apps list, the verification
    // scheduled right after fails, and the orphan this exists to kill lives on.
    const args = JSON.stringify(revokes[0]!.args);
    expect(args).toContain(oldEnvelope);
    expect(args).not.toContain(newEnvelope);
  });

  test("but reconnecting the same account does not revoke it", async () => {
    const { t, owner, workspaceId } = await scenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    const now = Date.now();
    await t.run(async (ctx) =>
      ctx.db.insert("storageBindings", {
        workspaceId,
        provider: "dropbox" as const,
        encryptedRefreshToken: await encryptSecret("old-refresh", keyset, context),
        accessTokenExpiresAt: now + 3_600_000,
        dropboxAccountId: "dbid:SAME",
        capabilities: { conditionalWrite: true },
        status: "connected" as const,
        boundBy: owner,
        createdAt: now,
        updatedAt: now,
      }),
    );

    await t.mutation(internal.functions.dropboxConnect.applyDropboxBinding, {
      workspaceId,
      boundBy: owner,
      rootPrefix: undefined,
      encryptedRefreshToken: await encryptSecret("new-refresh", keyset, context),
      encryptedAccessToken: await encryptSecret("new-access", keyset, context),
      accessTokenExpiresAt: now + 3_600_000,
      dropboxAccountId: "dbid:SAME",
    });

    const scheduled = await t.run(async (ctx) =>
      ctx.db.system.query("_scheduled_functions").collect(),
    );
    expect(
      scheduled.filter((job) => String(job.name).includes("revokeDropboxGrant")),
    ).toHaveLength(0);
  });
});
