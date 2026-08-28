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
   * THE ANTI-CSRF BINDING, and the sabotage is one line: delete
   * `if (attempt.startedBy !== args.userId) return null;`.
   *
   * Without it the attacker parks their own attempt, hands the victim the
   * callback URL, and the victim's browser completes it — silently rebinding
   * the victim's context to the attacker's Dropbox. Every note written
   * afterwards lands in the attacker's account.
   */
  test("a callback answered by somebody else is refused", async () => {
    const { t, owner, workspaceId } = await scenario();
    const stranger = await createUser(t, "stranger@example.invalid");
    const state = await parkedAttempt(t, workspaceId, owner);

    const consumed = await t.mutation(
      internal.functions.dropboxConnect.consumeAttemptAndExchange,
      { hashedState: await hashToken(state), userId: stranger, code: "code-1" },
    );
    expect(consumed).toBe(null);
  });

  /**
   * Sabotage: move the `ctx.db.delete` after the exchange, or drop it.
   * Deleting before it is used means a code that fails at the exchange has
   * still spent its attempt — otherwise one intercepted callback URL becomes
   * unlimited attempts at the same state.
   */
  test("an attempt is spent by being answered, whoever answers it", async () => {
    const { t, owner, workspaceId } = await scenario();
    const stranger = await createUser(t, "stranger@example.invalid");
    const state = await parkedAttempt(t, workspaceId, owner);
    const hashedState = await hashToken(state);

    // Refused — but spent.
    await t.mutation(internal.functions.dropboxConnect.consumeAttemptAndExchange, {
      hashedState,
      userId: stranger,
      code: "code-1",
    });
    const remaining = await t.run(async (ctx) =>
      ctx.db.query("dropboxConnectAttempts").collect(),
    );
    expect(remaining).toHaveLength(0);

    // And the rightful owner replaying the same state finds nothing, which is
    // the same absence a forged state gets.
    const replay = await t.mutation(
      internal.functions.dropboxConnect.consumeAttemptAndExchange,
      { hashedState, userId: owner, code: "code-1" },
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
      { hashedState: await hashToken(state), userId: owner, code: "code-1" },
    );
    expect(consumed).toBe(null);
  });

  /**
   * Every refusal is the same refusal.
   *
   * Never-issued, not-yours, already-answered and expired must be one answer,
   * for the reason `invitationNotFound()` gives one file over: a refusal that
   * distinguishes them tells the caller which of those four things is true
   * about somebody else's flow.
   */
  test("never-issued, not-yours, spent and expired are one answer", async () => {
    const { t, owner, workspaceId } = await scenario();
    const stranger = await createUser(t, "stranger@example.invalid");

    const answers: unknown[] = [];
    answers.push(
      await t.mutation(internal.functions.dropboxConnect.consumeAttemptAndExchange, {
        hashedState: await hashToken("never-issued-at-all"),
        userId: owner,
        code: "c",
      }),
    );
    const notYours = await parkedAttempt(t, workspaceId, owner);
    answers.push(
      await t.mutation(internal.functions.dropboxConnect.consumeAttemptAndExchange, {
        hashedState: await hashToken(notYours),
        userId: stranger,
        code: "c",
      }),
    );
    const expired = await parkedAttempt(t, workspaceId, owner, { expiresAt: Date.now() - 1 });
    answers.push(
      await t.mutation(internal.functions.dropboxConnect.consumeAttemptAndExchange, {
        hashedState: await hashToken(expired),
        userId: owner,
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
});
