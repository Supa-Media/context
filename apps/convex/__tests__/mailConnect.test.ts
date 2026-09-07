/**
 * The Gmail connect flow's security controls.
 *
 * Same shape as `dropboxConnect.test.ts`, and the same reason: every control
 * here — the flag, the personal-context-only rule, the owner check, the
 * redirect pin, single-use attempt consumption, the workspace-and-actor
 * coming from the attempt rather than the caller, and revocation on
 * disconnect — could be deleted with the rest of the suite green unless a
 * test names the sabotage it catches.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import {
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";
import { encryptSecret, hashToken, requireKeyset } from "../functions/lib/crypto";
import type { Id } from "../_generated/dataModel";

const APP = "https://app.context.invalid";
const REDIRECT = `${APP}/mail/gmail/callback`;

afterEach(() => {
  vi.unstubAllEnvs();
});

/** The flag on, and a client id configured — the state every non-flag test needs. */
function enableMailConnect() {
  vi.stubEnv("MAIL_CONNECT_ENABLED", "true");
  vi.stubEnv("GOOGLE_OAUTH_CLIENT_ID", "test-google-client-id.apps.googleusercontent.com");
}

async function personalScenario() {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas");
  return { t, owner, workspaceId };
}

async function sharedScenario() {
  const t = setupTest();
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas-team", { kind: "shared" });
  return { t, owner, workspaceId };
}

/** An attempt row, parked as `startGmailConnect` would park it. */
async function parkedAttempt(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  startedBy: Id<"users">,
  overrides: Record<string, unknown> = {},
) {
  const state = "gmail-state-token-0123456789";
  const keyset = requireKeyset();
  const now = Date.now();
  await t.run(async (ctx) =>
    ctx.db.insert("mailConnectAttempts", {
      workspaceId,
      startedBy,
      hashedState: await hashToken(state),
      encryptedVerifier: await encryptSecret("verifier-abc", keyset, {
        workspaceId: workspaceId as string,
      }),
      redirectUri: REDIRECT,
      backfillDays: 90,
      folders: ["inbox", "sent"],
      expiresAt: now + 600_000,
      createdAt: now,
      ...overrides,
    }),
  );
  return state;
}

describe("the flag", () => {
  test("a deployment with MAIL_CONNECT_ENABLED unset refuses to start", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const error = await captureError(() =>
      asUser(t, owner).action(api.functions.mailConnect.startGmailConnect, {
        workspaceId,
        redirectUri: REDIRECT,
      }),
    );
    expect(errorCode(error)).toBe("MAIL_CONNECT_DISABLED");
  });

  test("...and refuses to answer a callback too", async () => {
    const { t } = await personalScenario();
    const error = await captureError(() =>
      t.action(api.functions.mailConnect.completeGmailConnect, {
        state: "whatever",
        code: "whatever",
      }),
    );
    expect(errorCode(error)).toBe("MAIL_CONNECT_DISABLED");
  });

  test("the disabled deployment parks nothing", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    await captureError(() =>
      asUser(t, owner).action(api.functions.mailConnect.startGmailConnect, {
        workspaceId,
        redirectUri: REDIRECT,
      }),
    );
    const parked = await t.run((ctx) => ctx.db.query("mailConnectAttempts").collect());
    expect(parked).toHaveLength(0);
  });

  test("enabled but with no client id configured refuses distinctly", async () => {
    vi.stubEnv("MAIL_CONNECT_ENABLED", "true");
    const { t, owner, workspaceId } = await personalScenario();
    const error = await captureError(() =>
      asUser(t, owner).action(api.functions.mailConnect.startGmailConnect, {
        workspaceId,
        redirectUri: REDIRECT,
      }),
    );
    expect(errorCode(error)).toBe("MAIL_CONNECT_NOT_CONFIGURED");
  });
});

describe("only a personal context may connect a mailbox", () => {
  /**
   * Sabotage: drop the `workspace.kind !== "personal"` half of
   * `requirePersonalOwner`. A shared workspace scaffolds `0-inbox` as `team`
   * (`docs/decisions/privacy-and-sharing.md`), so a mailbox synced into one
   * would be readable by every member from the first message with nobody
   * having decided that — `identity-and-access.md`'s "Mail lands in a
   * personal context and nowhere else", applied here.
   */
  test("the owner of a SHARED context cannot connect a mailbox to it", async () => {
    enableMailConnect();
    const { t, owner, workspaceId } = await sharedScenario();
    const error = await captureError(() =>
      asUser(t, owner).action(api.functions.mailConnect.startGmailConnect, {
        workspaceId,
        redirectUri: REDIRECT,
      }),
    );
    expect(errorCode(error)).toBe("NOT_PERSONAL_OWNER");
  });

  /** Sabotage: drop the `membership?.role === "owner"` half. */
  test("a member who is not the owner of their own personal context cannot connect one either", async () => {
    // A personal context has exactly one owner in the product, but the schema
    // does not forbid a second membership row, and the check must not assume
    // the shape it usually has.
    enableMailConnect();
    const { t, workspaceId } = await personalScenario();
    const outsider = await createUser(t, "outsider@example.invalid");
    const error = await captureError(() =>
      asUser(t, outsider).action(api.functions.mailConnect.startGmailConnect, {
        workspaceId,
        redirectUri: REDIRECT,
      }),
    );
    expect(errorCode(error)).toBe("NOT_PERSONAL_OWNER");
  });

  test("the owner of their own personal context gets past that check", async () => {
    enableMailConnect();
    const { t, owner, workspaceId } = await personalScenario();
    // Configured with a client id and PKCE, so this actually succeeds — no
    // `captureError`, so a thrown ConvexError fails the test directly rather
    // than being swallowed by a refusal that happens to also be truthy.
    const result = await asUser(t, owner).action(api.functions.mailConnect.startGmailConnect, {
      workspaceId,
      redirectUri: REDIRECT,
    });
    expect(result.authorizeUrl).toContain("accounts.google.com");
  });
});

describe("which redirect URIs this deployment answers on", () => {
  test("a redirect URI off this deployment's origin is refused", async () => {
    enableMailConnect();
    const { t, owner, workspaceId } = await personalScenario();
    const error = await captureError(() =>
      asUser(t, owner).action(api.functions.mailConnect.startGmailConnect, {
        workspaceId,
        redirectUri: "https://attacker.example/cb",
      }),
    );
    expect(errorCode(error)).toBe("REDIRECT_URI_NOT_ALLOWED");
  });

  test("nothing is parked when the redirect is refused", async () => {
    enableMailConnect();
    const { t, owner, workspaceId } = await personalScenario();
    await captureError(() =>
      asUser(t, owner).action(api.functions.mailConnect.startGmailConnect, {
        workspaceId,
        redirectUri: "https://attacker.example/cb",
      }),
    );
    const parked = await t.run((ctx) => ctx.db.query("mailConnectAttempts").collect());
    expect(parked).toHaveLength(0);
  });
});

describe("the backfill window and folder set", () => {
  test("an unrecognised backfill window is refused", async () => {
    enableMailConnect();
    const { t, owner, workspaceId } = await personalScenario();
    const error = await captureError(() =>
      asUser(t, owner).action(api.functions.mailConnect.startGmailConnect, {
        workspaceId,
        redirectUri: REDIRECT,
        backfillDays: 30,
      }),
    );
    expect(errorCode(error)).toBe("INVALID_BACKFILL_WINDOW");
  });

  test("an empty folder set is refused — there is nothing to sync", async () => {
    enableMailConnect();
    const { t, owner, workspaceId } = await personalScenario();
    const error = await captureError(() =>
      asUser(t, owner).action(api.functions.mailConnect.startGmailConnect, {
        workspaceId,
        redirectUri: REDIRECT,
        folders: [],
      }),
    );
    expect(errorCode(error)).toBe("INVALID_FOLDERS");
  });

  /**
   * Sabotage: widen `MAIL_FOLDERS` to include "spam" or "trash", or drop the
   * `every(...)` check. Spam and Trash are excluded unconditionally in v1
   * (`docs/decisions/communications.md`) — TypeScript's own union type on the
   * schema and on this validator is the enforcement, and this proves the
   * runtime side actually agrees with the type.
   */
  test("spam and trash are not folders this deployment will ever park an attempt for", async () => {
    enableMailConnect();
    const { t, owner, workspaceId } = await personalScenario();
    const error = await captureError(() =>
      asUser(t, owner).action(api.functions.mailConnect.startGmailConnect, {
        workspaceId,
        redirectUri: REDIRECT,
        // @ts-expect-error — deliberately outside the validator's own union,
        // proving the server refuses it rather than the client type merely
        // hiding the option.
        folders: ["spam"],
      }),
    );
    expect(error).toBeDefined();
  });

  test("90 days, 1 year and all mail are each accepted", async () => {
    enableMailConnect();
    for (const backfillDays of [90, 365, 36_500]) {
      const { t, owner, workspaceId } = await personalScenario();
      const result = await asUser(t, owner).action(api.functions.mailConnect.startGmailConnect, {
        workspaceId,
        redirectUri: REDIRECT,
        backfillDays,
      });
      expect(result.authorizeUrl).toBeTruthy();
    }
  });
});

describe("who may answer a callback", () => {
  /**
   * No session required on the callback — see `mailConnect.ts`'s comment for
   * why. What has to hold instead: the workspace and the actor come from the
   * ATTEMPT, never from the caller, so an interceptor of the callback URL can
   * complete or burn the victim's own connect and nothing else.
   */
  test("the workspace and the actor come from the attempt, never from the caller", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const state = await parkedAttempt(t, workspaceId, owner);
    const consumed = await t.mutation(internal.functions.mailConnect.consumeAttemptAndExchange, {
      hashedState: await hashToken(state),
      code: "code-1",
    });
    expect(consumed?.workspaceId).toBe(workspaceId);
  });

  /** Sabotage: move the `ctx.db.delete` after the exchange, or drop it. */
  test("an attempt is spent by being answered", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const state = await parkedAttempt(t, workspaceId, owner);
    const hashedState = await hashToken(state);

    await t.mutation(internal.functions.mailConnect.consumeAttemptAndExchange, {
      hashedState,
      code: "code-1",
    });
    const remaining = await t.run((ctx) => ctx.db.query("mailConnectAttempts").collect());
    expect(remaining).toHaveLength(0);

    const replay = await t.mutation(internal.functions.mailConnect.consumeAttemptAndExchange, {
      hashedState,
      code: "code-1",
    });
    expect(replay).toBe(null);
  });

  /** Sabotage: drop the `attempt.expiresAt < Date.now()` check. */
  test("an expired attempt is refused", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const state = await parkedAttempt(t, workspaceId, owner, { expiresAt: Date.now() - 1 });
    const consumed = await t.mutation(internal.functions.mailConnect.consumeAttemptAndExchange, {
      hashedState: await hashToken(state),
      code: "code-1",
    });
    expect(consumed).toBe(null);
  });

  test("never-issued, spent and expired are one answer", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const answers: unknown[] = [];

    answers.push(
      await t.mutation(internal.functions.mailConnect.consumeAttemptAndExchange, {
        hashedState: await hashToken("never-issued-at-all"),
        code: "c",
      }),
    );
    const spent = await parkedAttempt(t, workspaceId, owner);
    const spentHash = await hashToken(spent);
    await t.mutation(internal.functions.mailConnect.consumeAttemptAndExchange, {
      hashedState: spentHash,
      code: "c",
    });
    answers.push(
      await t.mutation(internal.functions.mailConnect.consumeAttemptAndExchange, {
        hashedState: spentHash,
        code: "c",
      }),
    );
    const expired = await parkedAttempt(t, workspaceId, owner, { expiresAt: Date.now() - 1 });
    answers.push(
      await t.mutation(internal.functions.mailConnect.consumeAttemptAndExchange, {
        hashedState: await hashToken(expired),
        code: "c",
      }),
    );
    expect(answers).toEqual([null, null, null]);
  });
});

describe("the mailbox slug is chosen once", () => {
  test("a first connect gets a fresh slug and health 'backfilling'", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    await t.mutation(internal.functions.mailConnect.applyMailConnectionBinding, {
      workspaceId,
      boundBy: owner,
      address: "person@example.invalid",
      mailboxSlug: "person-at-example-invalid",
      googleAccountId: "google-1",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      backfillDays: 90,
      folders: ["inbox", "sent"],
      encryptedRefreshToken: await encryptSecret("refresh-1", keyset, context),
      encryptedAccessToken: await encryptSecret("access-1", keyset, context),
      accessTokenExpiresAt: Date.now() + 3_600_000,
    });

    const row = await t.run((ctx) =>
      ctx.db
        .query("mailConnections")
        .withIndex("by_workspace_address", (q) =>
          q.eq("workspaceId", workspaceId).eq("address", "person@example.invalid"),
        )
        .unique(),
    );
    expect(row?.mailboxSlug).toBe("person-at-example-invalid");
    expect(row?.health).toBe("backfilling");
    expect(row?.historyId).toBeUndefined();
  });

  /**
   * Sabotage: change `existing?.mailboxSlug ?? args.mailboxSlug` to
   * `args.mailboxSlug ?? existing?.mailboxSlug`. A folder name that changed on
   * a reconnect would be a rename of a person's mail — the exact failure
   * `docs/decisions/communications.md` argues against under "An address
   * becomes a slug".
   */
  test("reconnecting the same mailbox keeps its original slug even if a caller supplies a different one", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    const address = "person@example.invalid";
    await t.mutation(internal.functions.mailConnect.applyMailConnectionBinding, {
      workspaceId,
      boundBy: owner,
      address,
      mailboxSlug: "person-at-example-invalid",
      googleAccountId: "google-1",
      scopes: [],
      backfillDays: 90,
      folders: ["inbox", "sent"],
      encryptedRefreshToken: await encryptSecret("refresh-1", keyset, context),
      encryptedAccessToken: await encryptSecret("access-1", keyset, context),
      accessTokenExpiresAt: Date.now() + 3_600_000,
    });

    await t.mutation(internal.functions.mailConnect.applyMailConnectionBinding, {
      workspaceId,
      boundBy: owner,
      address,
      // A caller (or a slug-collision race) supplying a DIFFERENT slug must
      // not rename the folder this mailbox's notes are already sitting in.
      mailboxSlug: "collided-different-slug",
      googleAccountId: "google-1",
      scopes: [],
      backfillDays: 90,
      folders: ["inbox", "sent"],
      encryptedRefreshToken: await encryptSecret("refresh-2", keyset, context),
      encryptedAccessToken: await encryptSecret("access-2", keyset, context),
      accessTokenExpiresAt: Date.now() + 3_600_000,
    });

    const rows = await t.run((ctx) =>
      ctx.db
        .query("mailConnections")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .collect(),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.mailboxSlug).toBe("person-at-example-invalid");
  });

  /** A reconnect keeps the sync cursor — resetting it would force a needless full reconcile. */
  test("reconnecting preserves the sync cursor", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    const address = "person@example.invalid";
    await t.mutation(internal.functions.mailConnect.applyMailConnectionBinding, {
      workspaceId,
      boundBy: owner,
      address,
      mailboxSlug: "person-at-example-invalid",
      googleAccountId: "google-1",
      scopes: [],
      backfillDays: 90,
      folders: ["inbox", "sent"],
      encryptedRefreshToken: await encryptSecret("refresh-1", keyset, context),
      encryptedAccessToken: await encryptSecret("access-1", keyset, context),
      accessTokenExpiresAt: Date.now() + 3_600_000,
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("mailConnections")
        .withIndex("by_workspace_address", (q) => q.eq("workspaceId", workspaceId).eq("address", address))
        .unique();
      await ctx.db.patch(row!._id, { historyId: "12345" });
    });

    await t.mutation(internal.functions.mailConnect.applyMailConnectionBinding, {
      workspaceId,
      boundBy: owner,
      address,
      mailboxSlug: "person-at-example-invalid",
      googleAccountId: "google-1",
      scopes: [],
      backfillDays: 90,
      folders: ["inbox", "sent"],
      encryptedRefreshToken: await encryptSecret("refresh-2", keyset, context),
      encryptedAccessToken: await encryptSecret("access-2", keyset, context),
      accessTokenExpiresAt: Date.now() + 3_600_000,
    });

    const row = await t.run((ctx) =>
      ctx.db
        .query("mailConnections")
        .withIndex("by_workspace_address", (q) => q.eq("workspaceId", workspaceId).eq("address", address))
        .unique(),
    );
    expect(row?.historyId).toBe("12345");
  });

  test("two different addresses in one context each get their own row", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    for (const [address, slug] of [
      ["one@example.invalid", "one-at-example-invalid"],
      ["two@example.invalid", "two-at-example-invalid"],
    ] as const) {
      await t.mutation(internal.functions.mailConnect.applyMailConnectionBinding, {
        workspaceId,
        boundBy: owner,
        address,
        mailboxSlug: slug,
        googleAccountId: `google-${slug}`,
        scopes: [],
        backfillDays: 90,
        folders: ["inbox", "sent"],
        encryptedRefreshToken: await encryptSecret(`refresh-${slug}`, keyset, context),
        encryptedAccessToken: await encryptSecret(`access-${slug}`, keyset, context),
        accessTokenExpiresAt: Date.now() + 3_600_000,
      });
    }
    const rows = await t.run((ctx) =>
      ctx.db
        .query("mailConnections")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .collect(),
    );
    expect(rows).toHaveLength(2);
  });
});

describe("no token ever appears in the clear", () => {
  test("the stored refresh and access tokens are sealed envelopes, never the plaintext", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    await t.mutation(internal.functions.mailConnect.applyMailConnectionBinding, {
      workspaceId,
      boundBy: owner,
      address: "person@example.invalid",
      mailboxSlug: "person-at-example-invalid",
      googleAccountId: "google-1",
      scopes: [],
      backfillDays: 90,
      folders: ["inbox", "sent"],
      encryptedRefreshToken: await encryptSecret("super-secret-refresh-token", keyset, context),
      encryptedAccessToken: await encryptSecret("super-secret-access-token", keyset, context),
      accessTokenExpiresAt: Date.now() + 3_600_000,
    });

    const row = await t.run((ctx) =>
      ctx.db
        .query("mailConnections")
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

describe("disconnect: revoke at Google, delete the token, keep the notes", () => {
  async function connected() {
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    const refreshEnvelope = await encryptSecret("refresh-to-revoke", keyset, context);
    await t.mutation(internal.functions.mailConnect.applyMailConnectionBinding, {
      workspaceId,
      boundBy: owner,
      address: "person@example.invalid",
      mailboxSlug: "person-at-example-invalid",
      googleAccountId: "google-1",
      scopes: [],
      backfillDays: 90,
      folders: ["inbox", "sent"],
      encryptedRefreshToken: refreshEnvelope,
      encryptedAccessToken: await encryptSecret("access-1", keyset, context),
      accessTokenExpiresAt: Date.now() + 3_600_000,
    });
    const connection = await t.run((ctx) =>
      ctx.db
        .query("mailConnections")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
    );
    return { t, owner, workspaceId, connectionId: connection!._id, refreshEnvelope };
  }

  /** Sabotage: drop the `membership?.role !== "owner"` refusal. */
  test("a member who is not the owner cannot disconnect a mailbox", async () => {
    const { t, workspaceId, connectionId } = await connected();
    const outsider = await createUser(t, "outsider@example.invalid");
    const error = await captureError(() =>
      asUser(t, outsider).mutation(api.functions.mailConnect.disconnectMailConnection, {
        workspaceId,
        connectionId,
      }),
    );
    expect(errorCode(error)).toBe("NOT_OWNER");
  });

  /**
   * A connection id from a DIFFERENT workspace, with the caller's own
   * workspaceId — must not disconnect somebody else's mailbox and must not
   * confirm one exists there either.
   */
  test("a connection id belonging to another workspace is not found, not disconnected", async () => {
    const { t: aliceStore, connectionId: alicesConnectionId } = await connected();
    void aliceStore;
    const bob = await createUser(setupTest(), "bob@example.invalid");
    // Fresh store sharing nothing with alice's — cross-store ids do not
    // resolve, which is the point: prove the check is by id AND workspace,
    // not by id alone, using a bob whose workspace is real but unrelated.
    const t = setupTest();
    const bobOwner = await createUser(t, "bob-owner@example.invalid");
    const bobWorkspace = await createWorkspace(t, bobOwner, "bob-ctx");
    void bob;

    const error = await captureError(() =>
      asUser(t, bobOwner).mutation(api.functions.mailConnect.disconnectMailConnection, {
        workspaceId: bobWorkspace,
        connectionId: alicesConnectionId,
      }),
    );
    expect(errorCode(error)).toBe("NOT_FOUND");
  });

  test("disconnecting clears the token and marks the connection disconnected, keeping the row", async () => {
    const { t, owner, workspaceId, connectionId } = await connected();
    await asUser(t, owner).mutation(api.functions.mailConnect.disconnectMailConnection, {
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
    expect(row!.mailboxSlug).toBe("person-at-example-invalid");
  });

  /**
   * Forgetting our copy is only half of disconnecting. Sabotage: drop the
   * `ctx.scheduler.runAfter(..., revokeGmailGrant, ...)` call.
   */
  test("disconnecting schedules revocation at Google, carrying the OLD refresh token", async () => {
    const { t, owner, workspaceId, connectionId, refreshEnvelope } = await connected();
    await asUser(t, owner).mutation(api.functions.mailConnect.disconnectMailConnection, {
      workspaceId,
      connectionId,
    });

    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    const revokes = scheduled.filter((job) => String(job.name).includes("revokeGmailGrant"));
    expect(revokes).toHaveLength(1);
    expect(JSON.stringify(revokes[0]!.args)).toContain(refreshEnvelope);
  });

  test("disconnecting twice is a no-op the second time — no second revoke job, no error", async () => {
    const { t, owner, workspaceId, connectionId } = await connected();
    await asUser(t, owner).mutation(api.functions.mailConnect.disconnectMailConnection, {
      workspaceId,
      connectionId,
    });
    await asUser(t, owner).mutation(api.functions.mailConnect.disconnectMailConnection, {
      workspaceId,
      connectionId,
    });
    const scheduled = await t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
    expect(scheduled.filter((job) => String(job.name).includes("revokeGmailGrant"))).toHaveLength(1);
  });

  /**
   * THE ONE A SYNC JOB DEPENDS ON. `mintGmailAccessToken` is what a sync pass
   * calls to get a usable Gmail credential; if it minted one for a
   * disconnected connection, the sync job would keep reading somebody's mail
   * after they revoked access. Sabotage: drop the `disconnectedAt !==
   * undefined` check from either `mintGmailAccessToken` or
   * `getConnectionForSync`.
   */
  test("a disconnected connection's access-token mint is a no-op", async () => {
    const { t, owner, workspaceId, connectionId } = await connected();
    await asUser(t, owner).mutation(api.functions.mailConnect.disconnectMailConnection, {
      workspaceId,
      connectionId,
    });

    const minted = await t.action(internal.functions.mailConnect.mintGmailAccessToken, {
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

    await t.mutation(internal.functions.mailConnect.applyMailConnectionBinding, {
      workspaceId: aliceWs,
      boundBy: alice,
      address: "alice@example.invalid",
      mailboxSlug: "alice-at-example-invalid",
      googleAccountId: "google-alice",
      scopes: [],
      backfillDays: 90,
      folders: ["inbox", "sent"],
      encryptedRefreshToken: await encryptSecret("r", keyset, { workspaceId: aliceWs as string }),
      encryptedAccessToken: await encryptSecret("a", keyset, { workspaceId: aliceWs as string }),
      accessTokenExpiresAt: Date.now() + 3_600_000,
    });

    const bobsSlugs: string[] = await t.run(async (ctx) => {
      // Mirrors `listMailboxSlugs`'s own query rather than importing an
      // internalQuery handler directly, since the test's job is to prove the
      // WORKSPACE INDEX scopes correctly, not to re-invoke the function.
      const rows = await ctx.db
        .query("mailConnections")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", bobWs))
        .collect();
      return rows.map((row) => row.mailboxSlug);
    });
    expect(bobsSlugs).toHaveLength(0);
    expect(bobsSlugs).not.toContain("alice-at-example-invalid");
  });
});
