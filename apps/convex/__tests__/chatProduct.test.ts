/**
 * Attaching Google Chat as a product on the shared `googleConnections` row.
 *
 * Same shape as `googleConnect.test.ts`, restated rather than imported for the
 * same reason its own header gives: every control here — the flag, the
 * personal-context-only rule, the redirect pin, single-use attempt
 * consumption, the owner check on `setChatSpaceState`, and the row-shape
 * invariants — could be deleted with the rest of the suite green unless a
 * test names the sabotage it catches.
 *
 * The one control that is NEW here, not restated: adding Chat to an account
 * that already has Gmail must never leave Gmail's recorded scopes empty. See
 * "adding chat to a gmail-connected account" below.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import {
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
  setupTest,
  type TestConvex,
} from "./fixtures.helpers";
import { encryptSecret, hashToken, requireKeyset } from "../functions/lib/crypto";
import { CALENDAR_SCOPES, CHAT_SCOPES, GMAIL_SCOPES } from "../functions/lib/googleOAuth";
import type { Id } from "../_generated/dataModel";

const APP = "https://app.context.invalid";
const REDIRECT = `${APP}/chat/google/callback`;
const GMAIL_SCOPE = GMAIL_SCOPES[0];
const CHAT_MESSAGES_SCOPE = CHAT_SCOPES[0];
const CHAT_SPACES_SCOPE = CHAT_SCOPES[1];
const CALENDAR_SCOPE = CALENDAR_SCOPES[0];

afterEach(() => {
  vi.unstubAllEnvs();
});

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

/** An attempt row, parked as `startChatConnect` would park it. */
async function parkedAttempt(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  startedBy: Id<"users">,
  overrides: Record<string, unknown> = {},
) {
  const state = "chat-state-token-0123456789";
  const keyset = requireKeyset();
  const now = Date.now();
  await t.run(async (ctx) =>
    ctx.db.insert("googleConnectAttempts", {
      workspaceId,
      startedBy,
      hashedState: await hashToken(state),
      encryptedVerifier: await encryptSecret("verifier-abc", keyset, {
        workspaceId: workspaceId as string,
      }),
      redirectUri: REDIRECT,
      products: ["chat"],
      expiresAt: now + 600_000,
      createdAt: now,
      ...overrides,
    }),
  );
  return state;
}

/** Standard args for `applyChatConnectionBinding`, so each test overrides only what it is about. */
function chatBindingArgs(
  overrides: Partial<{
    workspaceId: Id<"workspaces">;
    boundBy: Id<"users">;
    address: string;
    googleAccountId: string;
    scopes: string[];
    encryptedRefreshToken: string;
    encryptedAccessToken: string;
    accessTokenExpiresAt: number;
  }>,
) {
  return {
    address: "person@example.invalid",
    googleAccountId: "google-1",
    scopes: [CHAT_MESSAGES_SCOPE, CHAT_SPACES_SCOPE],
    accessTokenExpiresAt: Date.now() + 3_600_000,
    ...overrides,
  };
}

async function gmailArgs(
  t: TestConvex,
  workspaceId: Id<"workspaces">,
  owner: Id<"users">,
  overrides: Partial<{ address: string; scopes: string[] }> = {},
) {
  const keyset = requireKeyset();
  const context = { workspaceId: workspaceId as string };
  const address = overrides.address ?? "person@example.invalid";
  await t.mutation(internal.functions.googleConnect.applyGmailConnectionBinding, {
    workspaceId,
    boundBy: owner,
    address,
    mailboxSlug: "person-at-example-invalid",
    googleAccountId: "google-1",
    scopes: overrides.scopes ?? [GMAIL_SCOPE],
    backfillDays: 90,
    folders: ["inbox", "sent"],
    attachmentMode: "store",
    attachmentRetentionDays: 90,
    accessTokenExpiresAt: Date.now() + 3_600_000,
    encryptedRefreshToken: await encryptSecret("gmail-refresh", keyset, context),
    encryptedAccessToken: await encryptSecret("gmail-access", keyset, context),
  });
  return address;
}

describe("the flag", () => {
  test("a deployment with MAIL_CONNECT_ENABLED unset refuses to start", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const error = await captureError(() =>
      asUser(t, owner).action(api.functions.chatProduct.startChatConnect, {
        workspaceId,
        redirectUri: REDIRECT,
      }),
    );
    expect(errorCode(error)).toBe("CHAT_CONNECT_DISABLED");
  });

  test("...and refuses to answer a callback too", async () => {
    const { t } = await personalScenario();
    const error = await captureError(() =>
      t.action(api.functions.chatProduct.completeChatConnect, { state: "whatever", code: "whatever" }),
    );
    expect(errorCode(error)).toBe("CHAT_CONNECT_DISABLED");
  });

  test("the disabled deployment parks nothing", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    await captureError(() =>
      asUser(t, owner).action(api.functions.chatProduct.startChatConnect, {
        workspaceId,
        redirectUri: REDIRECT,
      }),
    );
    expect(await t.run((ctx) => ctx.db.query("googleConnectAttempts").collect())).toHaveLength(0);
  });

  test("enabled but with no client id configured refuses distinctly", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    vi.stubEnv("MAIL_CONNECT_ENABLED", "true");
    const error = await captureError(() =>
      asUser(t, owner).action(api.functions.chatProduct.startChatConnect, {
        workspaceId,
        redirectUri: REDIRECT,
      }),
    );
    expect(errorCode(error)).toBe("CHAT_CONNECT_NOT_CONFIGURED");
  });
});

describe("only a personal context may connect Google Chat", () => {
  test("the owner of a SHARED context cannot connect Google Chat to it", async () => {
    enableMailConnect();
    const { t, owner, workspaceId } = await sharedScenario();
    const error = await captureError(() =>
      asUser(t, owner).action(api.functions.chatProduct.startChatConnect, {
        workspaceId,
        redirectUri: REDIRECT,
      }),
    );
    expect(errorCode(error)).toBe("NOT_PERSONAL_OWNER");
  });

  test("somebody with no membership in a personal context cannot connect one", async () => {
    enableMailConnect();
    const { t, workspaceId } = await personalScenario();
    const outsider = await createUser(t, "outsider@example.invalid");
    const error = await captureError(() =>
      asUser(t, outsider).action(api.functions.chatProduct.startChatConnect, {
        workspaceId,
        redirectUri: REDIRECT,
      }),
    );
    expect(errorCode(error)).toBe("NOT_PERSONAL_OWNER");
  });

  test("the owner of their own personal context gets past that check", async () => {
    enableMailConnect();
    vi.stubEnv("APP_ORIGIN", APP);
    const { t, owner, workspaceId } = await personalScenario();
    const { authorizeUrl } = await asUser(t, owner).action(api.functions.chatProduct.startChatConnect, {
      workspaceId,
      redirectUri: REDIRECT,
    });
    expect(authorizeUrl).toContain("accounts.google.com");
  });
});

describe("which redirect URIs this deployment answers on", () => {
  test("a redirect URI off this deployment's origin is refused", async () => {
    enableMailConnect();
    vi.stubEnv("APP_ORIGIN", APP);
    const { t, owner, workspaceId } = await personalScenario();
    const error = await captureError(() =>
      asUser(t, owner).action(api.functions.chatProduct.startChatConnect, {
        workspaceId,
        redirectUri: "https://attacker.invalid/callback",
      }),
    );
    expect(errorCode(error)).toBe("REDIRECT_URI_NOT_ALLOWED");
  });

  test("nothing is parked when the redirect is refused", async () => {
    enableMailConnect();
    vi.stubEnv("APP_ORIGIN", APP);
    const { t, owner, workspaceId } = await personalScenario();
    await captureError(() =>
      asUser(t, owner).action(api.functions.chatProduct.startChatConnect, {
        workspaceId,
        redirectUri: "https://attacker.invalid/callback",
      }),
    );
    expect(await t.run((ctx) => ctx.db.query("googleConnectAttempts").collect())).toHaveLength(0);
  });
});

describe("who may answer a callback", () => {
  /**
   * No session required on the callback — see `googleConnect.ts`'s comment
   * for why. What has to hold instead: the workspace and the actor come from
   * the ATTEMPT, never from the caller, so an interceptor of the callback URL
   * can complete or burn the victim's own connect and nothing else.
   */
  test("the workspace and the actor come from the attempt, never from the caller", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const state = await parkedAttempt(t, workspaceId, owner);
    const consumed = await t.mutation(internal.functions.chatProduct.consumeChatAttemptAndExchange, {
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

    await t.mutation(internal.functions.chatProduct.consumeChatAttemptAndExchange, {
      hashedState,
      code: "code-1",
    });
    const remaining = await t.run((ctx) => ctx.db.query("googleConnectAttempts").collect());
    expect(remaining).toHaveLength(0);

    const replay = await t.mutation(internal.functions.chatProduct.consumeChatAttemptAndExchange, {
      hashedState,
      code: "code-1",
    });
    expect(replay).toBe(null);
  });

  /** Sabotage: drop the `attempt.expiresAt < Date.now()` check. */
  test("an expired attempt is refused", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const state = await parkedAttempt(t, workspaceId, owner, { expiresAt: Date.now() - 1 });
    const consumed = await t.mutation(internal.functions.chatProduct.consumeChatAttemptAndExchange, {
      hashedState: await hashToken(state),
      code: "code-1",
    });
    expect(consumed).toBe(null);
  });

  test("never-issued, spent and expired are one answer", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const answers: unknown[] = [];

    answers.push(
      await t.mutation(internal.functions.chatProduct.consumeChatAttemptAndExchange, {
        hashedState: await hashToken("never-issued-at-all"),
        code: "c",
      }),
    );
    const spent = await parkedAttempt(t, workspaceId, owner);
    const spentHash = await hashToken(spent);
    await t.mutation(internal.functions.chatProduct.consumeChatAttemptAndExchange, {
      hashedState: spentHash,
      code: "c",
    });
    answers.push(
      await t.mutation(internal.functions.chatProduct.consumeChatAttemptAndExchange, {
        hashedState: spentHash,
        code: "c",
      }),
    );
    const expired = await parkedAttempt(t, workspaceId, owner, { expiresAt: Date.now() - 1 });
    answers.push(
      await t.mutation(internal.functions.chatProduct.consumeChatAttemptAndExchange, {
        hashedState: await hashToken(expired),
        code: "c",
      }),
    );
    expect(answers).toEqual([null, null, null]);
  });
});

describe("the row shape: attaching chat to the shared googleConnections row", () => {
  test("a first connect writes products: ['chat'] and a full chat settings object", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    await t.mutation(internal.functions.chatProduct.applyChatConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...chatBindingArgs({}),
      encryptedRefreshToken: await encryptSecret("refresh-1", keyset, context),
      encryptedAccessToken: await encryptSecret("access-1", keyset, context),
    });

    const row = await t.run((ctx) =>
      ctx.db
        .query("googleConnections")
        .withIndex("by_workspace_address", (q) =>
          q.eq("workspaceId", workspaceId).eq("address", "person@example.invalid"),
        )
        .unique(),
    );
    expect(row?.provider).toBe("google");
    expect(row?.products).toEqual(["chat"]);
    expect(row?.health).toBe("backfilling");
    expect(row?.chat?.nonceSeed.length).toBeGreaterThan(0);
    expect(row?.chat?.spaceSettings).toBeUndefined();
    expect(row?.chat?.cursors).toBeUndefined();
    // The account's own scopes, verbatim, AND the per-product slice.
    expect(row?.scopes.sort()).toEqual([CHAT_MESSAGES_SCOPE, CHAT_SPACES_SCOPE].sort());
    expect(row?.chat?.scopes.sort()).toEqual([CHAT_MESSAGES_SCOPE, CHAT_SPACES_SCOPE].sort());
  });

  test("reconnecting preserves spaceSettings, cursors and the nonce seed", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    await t.mutation(internal.functions.chatProduct.applyChatConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...chatBindingArgs({}),
      encryptedRefreshToken: await encryptSecret("refresh-1", keyset, context),
      encryptedAccessToken: await encryptSecret("access-1", keyset, context),
    });
    const first = await t.run((ctx) =>
      ctx.db
        .query("googleConnections")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
    );
    const originalSeed = first!.chat!.nonceSeed;
    await t.run(async (ctx) => {
      await ctx.db.patch(first!._id, {
        chat: {
          ...first!.chat!,
          spaceSettings: { "spaces/noisy": "excluded" },
          cursors: { "spaces/general": "2026-09-01T00:00:00Z" },
        },
      });
    });

    // The person re-consents (e.g. re-authorizing after a scope change).
    await t.mutation(internal.functions.chatProduct.applyChatConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...chatBindingArgs({}),
      encryptedRefreshToken: await encryptSecret("refresh-2", keyset, context),
      encryptedAccessToken: await encryptSecret("access-2", keyset, context),
    });

    const row = await t.run((ctx) =>
      ctx.db
        .query("googleConnections")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
    );
    expect(row?.chat?.spaceSettings).toEqual({ "spaces/noisy": "excluded" });
    expect(row?.chat?.cursors).toEqual({ "spaces/general": "2026-09-01T00:00:00Z" });
    // Sabotage: change `existing?.chat?.nonceSeed ?? generateNonceSeed()` to
    // regenerate unconditionally, and this assertion fails — every future
    // day's fence nonce for spaces already synced would silently change.
    expect(row?.chat?.nonceSeed).toBe(originalSeed);
  });

  /**
   * THE CRITICAL FIX. Adding Chat to an account that already has Gmail must
   * request (and this test asserts the row records) BOTH products' scopes —
   * simulating exactly what a correctly-configured `include_granted_scopes=
   * true` grant hands back. `applyChatConnectionBinding`'s own recomputation
   * rule ("two views of one fact, never two facts") means the row is only
   * ever as honest as the grant it is given; this proves that when the grant
   * is complete, Gmail is NOT reported as disconnected.
   *
   * Sabotage: change the granted `scopes` this test binds with to Chat's
   * scopes alone (what a request WITHOUT `include_granted_scopes=true` and
   * without the union-of-products fix would actually receive back from
   * Google) and `row.gmail.scopes` goes empty — Gmail silently breaks. That
   * broken case is asserted explicitly right after, so the fix is measured
   * against its own failure mode, not just its success.
   */
  test("adding chat to a gmail-connected account leaves gmail's scopes intact, given the union grant include_granted_scopes=true produces", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const address = await gmailArgs(t, workspaceId, owner);
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };

    const before = await t.run((ctx) =>
      ctx.db
        .query("googleConnections")
        .withIndex("by_workspace_address", (q) => q.eq("workspaceId", workspaceId).eq("address", address))
        .unique(),
    );
    expect(before?.gmail?.scopes).toEqual([GMAIL_SCOPE]);

    // The grant Google hands back with `include_granted_scopes=true`: every
    // scope the client already held for this account, unioned with the new
    // Chat scopes just requested.
    await t.mutation(internal.functions.chatProduct.applyChatConnectionBinding, {
      workspaceId,
      boundBy: owner,
      address,
      googleAccountId: "google-1",
      scopes: [GMAIL_SCOPE, CHAT_MESSAGES_SCOPE, CHAT_SPACES_SCOPE],
      accessTokenExpiresAt: Date.now() + 3_600_000,
      encryptedRefreshToken: await encryptSecret("refresh-union", keyset, context),
      encryptedAccessToken: await encryptSecret("access-union", keyset, context),
    });

    const after = await t.run((ctx) =>
      ctx.db
        .query("googleConnections")
        .withIndex("by_workspace_address", (q) => q.eq("workspaceId", workspaceId).eq("address", address))
        .unique(),
    );
    expect(after?.products.sort()).toEqual(["chat", "gmail"]);
    expect(after?.gmail?.scopes).toEqual([GMAIL_SCOPE]);
    expect(after?.chat?.scopes.sort()).toEqual([CHAT_MESSAGES_SCOPE, CHAT_SPACES_SCOPE].sort());
    // Gmail's own settings (mailbox slug) are untouched by a Chat connect.
    expect(after?.gmail?.mailboxSlug).toBe("person-at-example-invalid");
  });

  /**
   * THE BROKEN CASE, asserted directly — this is what would happen if either
   * fix were absent (no `include_granted_scopes=true`, and no
   * `connectionId`-informed union request): Google would grant Chat's scopes
   * alone, and the honest recomputation rule then (correctly, given a
   * narrower grant) reports Gmail as scope-less. This test exists so a
   * regression that reintroduces the bug shows up as "the fixed test above
   * starts failing", not as a silent behavior change nobody wrote a test for.
   */
  test("SABOTAGE CASE: a chat-only grant (the bug's own symptom) reports gmail as scope-less — proving the fix matters", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const address = await gmailArgs(t, workspaceId, owner);
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };

    await t.mutation(internal.functions.chatProduct.applyChatConnectionBinding, {
      workspaceId,
      boundBy: owner,
      address,
      googleAccountId: "google-1",
      // The scope this SAME account would get back if the request had asked
      // for chat's scopes alone — the exact bug `include_granted_scopes=true`
      // and the union-of-products request exist to prevent.
      scopes: [CHAT_MESSAGES_SCOPE, CHAT_SPACES_SCOPE],
      accessTokenExpiresAt: Date.now() + 3_600_000,
      encryptedRefreshToken: await encryptSecret("refresh-narrow", keyset, context),
      encryptedAccessToken: await encryptSecret("access-narrow", keyset, context),
    });

    const after = await t.run((ctx) =>
      ctx.db
        .query("googleConnections")
        .withIndex("by_workspace_address", (q) => q.eq("workspaceId", workspaceId).eq("address", address))
        .unique(),
    );
    // This is the row correctly telling the truth about a narrow grant — the
    // bug is not in this recomputation, it is in ever PRODUCING this grant.
    expect(after?.gmail?.scopes).toEqual([]);
    expect(after?.scopes).toEqual([CHAT_MESSAGES_SCOPE, CHAT_SPACES_SCOPE]);
  });

  test("a reconnect never touches an already-enabled calendar product", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    const address = "person@example.invalid";
    await t.mutation(internal.functions.chatProduct.applyChatConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...chatBindingArgs({ address }),
      encryptedRefreshToken: await encryptSecret("refresh-1", keyset, context),
      encryptedAccessToken: await encryptSecret("access-1", keyset, context),
    });
    await t.run(async (ctx) => {
      const row = await ctx.db
        .query("googleConnections")
        .withIndex("by_workspace_address", (q) => q.eq("workspaceId", workspaceId).eq("address", address))
        .unique();
      await ctx.db.patch(row!._id, {
        products: [...row!.products, "calendar"],
        calendar: { scopes: [CALENDAR_SCOPE], syncToken: "cal-token" },
      });
    });

    await t.mutation(internal.functions.chatProduct.applyChatConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...chatBindingArgs({ address, scopes: [CHAT_MESSAGES_SCOPE, CHAT_SPACES_SCOPE] }),
      encryptedRefreshToken: await encryptSecret("refresh-2", keyset, context),
      encryptedAccessToken: await encryptSecret("access-2", keyset, context),
    });

    const row = await t.run((ctx) =>
      ctx.db
        .query("googleConnections")
        .withIndex("by_workspace_address", (q) => q.eq("workspaceId", workspaceId).eq("address", address))
        .unique(),
    );
    expect(row?.products.sort()).toEqual(["calendar", "chat"]);
    expect(row?.calendar?.syncToken).toBe("cal-token");
    // Calendar's own grant was not part of THIS request, so its slice is
    // honestly recomputed to empty — same rule as Gmail's, not a special case.
    expect(row?.calendar?.scopes).toEqual([]);
  });
});

describe("startChatConnect requests the union of an existing connection's products", () => {
  /**
   * Belt and suspenders alongside `include_granted_scopes=true`: when the
   * caller supplies the `connectionId` of a row that already has Gmail, the
   * request ITSELF already asks for Gmail's scopes too, rather than relying
   * solely on Google's incremental-authorization behavior.
   *
   * Sabotage: change `[...existingProducts, "chat"]` to `["chat"]` and the
   * requested scope list stops containing `GMAIL_SCOPE`.
   */
  test("naming a connectionId with an existing gmail product asks for gmail's scopes too", async () => {
    enableMailConnect();
    vi.stubEnv("APP_ORIGIN", APP);
    const { t, owner, workspaceId } = await personalScenario();
    const address = await gmailArgs(t, workspaceId, owner);
    const connection = await t.run((ctx) =>
      ctx.db
        .query("googleConnections")
        .withIndex("by_workspace_address", (q) => q.eq("workspaceId", workspaceId).eq("address", address))
        .unique(),
    );

    const { authorizeUrl } = await asUser(t, owner).action(api.functions.chatProduct.startChatConnect, {
      workspaceId,
      redirectUri: REDIRECT,
      connectionId: connection!._id,
    });

    const scope = new URL(authorizeUrl).searchParams.get("scope") ?? "";
    expect(scope).toContain(GMAIL_SCOPE);
    expect(scope).toContain(CHAT_MESSAGES_SCOPE);
    expect(scope).toContain(CHAT_SPACES_SCOPE);
  });

  test("a connectionId belonging to another workspace contributes nothing — no cross-tenant existence signal", async () => {
    enableMailConnect();
    vi.stubEnv("APP_ORIGIN", APP);
    const { t, owner: aliceOwner, workspaceId: aliceWs } = await personalScenario();
    const aliceAddress = await gmailArgs(t, aliceWs, aliceOwner);
    const aliceConnection = await t.run((ctx) =>
      ctx.db
        .query("googleConnections")
        .withIndex("by_workspace_address", (q) => q.eq("workspaceId", aliceWs).eq("address", aliceAddress))
        .unique(),
    );

    const bobOwner = await createUser(t, "bob-owner@example.invalid");
    const bobWs = await createWorkspace(t, bobOwner, "bob-ctx");

    const { authorizeUrl } = await asUser(t, bobOwner).action(api.functions.chatProduct.startChatConnect, {
      workspaceId: bobWs,
      redirectUri: REDIRECT,
      connectionId: aliceConnection!._id,
    });
    const scope = new URL(authorizeUrl).searchParams.get("scope") ?? "";
    expect(scope).not.toContain(GMAIL_SCOPE);
  });

  test("always requests include_granted_scopes=true, even without a connectionId", async () => {
    enableMailConnect();
    vi.stubEnv("APP_ORIGIN", APP);
    const { t, owner, workspaceId } = await personalScenario();
    const { authorizeUrl } = await asUser(t, owner).action(api.functions.chatProduct.startChatConnect, {
      workspaceId,
      redirectUri: REDIRECT,
    });
    expect(new URL(authorizeUrl).searchParams.get("include_granted_scopes")).toBe("true");
  });
});

describe("no token ever appears in the clear", () => {
  test("the stored refresh and access tokens are sealed envelopes, never the plaintext", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    await t.mutation(internal.functions.chatProduct.applyChatConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...chatBindingArgs({}),
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

describe("disconnect is reused verbatim, and never touches chat's own state", () => {
  test("disconnecting a chat connection preserves spaceSettings and cursors", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    await t.mutation(internal.functions.chatProduct.applyChatConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...chatBindingArgs({}),
      encryptedRefreshToken: await encryptSecret("refresh-1", keyset, context),
      encryptedAccessToken: await encryptSecret("access-1", keyset, context),
    });
    const connection = await t.run((ctx) =>
      ctx.db
        .query("googleConnections")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
    );
    await t.run(async (ctx) => {
      await ctx.db.patch(connection!._id, {
        chat: { ...connection!.chat!, spaceSettings: { "spaces/x": "paused" }, cursors: { "spaces/x": "t1" } },
      });
    });

    await asUser(t, owner).mutation(api.functions.googleConnect.disconnectGoogleConnection, {
      workspaceId,
      connectionId: connection!._id,
    });

    const row = await t.run((ctx) => ctx.db.get(connection!._id));
    expect(row!.encryptedRefreshToken).toBe("");
    expect(row!.disconnectedAt).toBeDefined();
    expect(row!.chat?.spaceSettings).toEqual({ "spaces/x": "paused" });
    expect(row!.chat?.cursors).toEqual({ "spaces/x": "t1" });
  });
});

describe("setChatSpaceState: only the owner may change what a connection syncs", () => {
  async function connectedChat() {
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    await t.mutation(internal.functions.chatProduct.applyChatConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...chatBindingArgs({}),
      encryptedRefreshToken: await encryptSecret("refresh-1", keyset, context),
      encryptedAccessToken: await encryptSecret("access-1", keyset, context),
    });
    const connection = await t.run((ctx) =>
      ctx.db
        .query("googleConnections")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
    );
    return { t, owner, workspaceId, connectionId: connection!._id };
  }

  /** Sabotage: drop the `membership?.role !== "owner"` refusal. */
  test("a member who is not the owner cannot change a space's sync state", async () => {
    const { t, workspaceId, connectionId } = await connectedChat();
    const outsider = await createUser(t, "outsider@example.invalid");
    const error = await captureError(() =>
      asUser(t, outsider).mutation(api.functions.chatProduct.setChatSpaceState, {
        workspaceId,
        connectionId,
        spaceKey: "spaces/noisy",
        state: "excluded",
      }),
    );
    expect(errorCode(error)).toBe("NOT_OWNER");
  });

  test("the owner can exclude, pause, and then re-include a space", async () => {
    const { t, owner, workspaceId, connectionId } = await connectedChat();
    await asUser(t, owner).mutation(api.functions.chatProduct.setChatSpaceState, {
      workspaceId,
      connectionId,
      spaceKey: "spaces/noisy",
      state: "excluded",
    });
    let row = await t.run((ctx) => ctx.db.get(connectionId));
    expect(row!.chat?.spaceSettings).toEqual({ "spaces/noisy": "excluded" });

    await asUser(t, owner).mutation(api.functions.chatProduct.setChatSpaceState, {
      workspaceId,
      connectionId,
      spaceKey: "spaces/noisy",
      state: "paused",
    });
    row = await t.run((ctx) => ctx.db.get(connectionId));
    expect(row!.chat?.spaceSettings).toEqual({ "spaces/noisy": "paused" });

    // Absent means the default — "included" deletes the entry rather than
    // writing it explicitly.
    await asUser(t, owner).mutation(api.functions.chatProduct.setChatSpaceState, {
      workspaceId,
      connectionId,
      spaceKey: "spaces/noisy",
      state: "included",
    });
    row = await t.run((ctx) => ctx.db.get(connectionId));
    expect(row!.chat?.spaceSettings).toEqual({});
  });

  /**
   * A connection id from a DIFFERENT workspace, with the caller's own
   * workspaceId — must not be found, and must not confirm one exists there.
   * Both workspaces live in one database — see `googleConnect.test.ts`'s own
   * comment on why that is the whole test.
   */
  test("a connection id belonging to another workspace is not found, not changed", async () => {
    const { t, workspaceId: aliceWorkspace, connectionId: alicesConnectionId } = await connectedChat();
    const bobOwner = await createUser(t, "bob-owner@example.invalid");
    const bobWorkspace = await createWorkspace(t, bobOwner, "bob-ctx");

    const error = await captureError(() =>
      asUser(t, bobOwner).mutation(api.functions.chatProduct.setChatSpaceState, {
        workspaceId: bobWorkspace,
        connectionId: alicesConnectionId,
        spaceKey: "spaces/noisy",
        state: "excluded",
      }),
    );
    expect(errorCode(error)).toBe("NOT_FOUND");
    const alices = await t.run((ctx) => ctx.db.get(alicesConnectionId));
    expect(alices!.chat?.spaceSettings).toBeUndefined();
  });
});

describe("recordChatCursors: merges rather than replaces, and is a no-op once disconnected", () => {
  test("recording a cursor for one space never clobbers another space's cursor from a concurrent pass", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    await t.mutation(internal.functions.chatProduct.applyChatConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...chatBindingArgs({}),
      encryptedRefreshToken: await encryptSecret("refresh-1", keyset, context),
      encryptedAccessToken: await encryptSecret("access-1", keyset, context),
    });
    const connection = await t.run((ctx) =>
      ctx.db
        .query("googleConnections")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
    );

    await t.mutation(internal.functions.chatProduct.recordChatCursors, {
      connectionId: connection!._id,
      cursors: { "spaces/a": "cursor-a-1" },
    });
    await t.mutation(internal.functions.chatProduct.recordChatCursors, {
      connectionId: connection!._id,
      cursors: { "spaces/b": "cursor-b-1" },
    });

    const row = await t.run((ctx) => ctx.db.get(connection!._id));
    expect(row!.chat?.cursors).toEqual({ "spaces/a": "cursor-a-1", "spaces/b": "cursor-b-1" });
    expect(row!.health).toBe("active");
    expect(row!.chat?.lastSyncedAt).toBeDefined();
  });

  /**
   * Sabotage: drop the `connection.disconnectedAt !== undefined` check. A
   * sync job racing a disconnect must never resurrect a cursor for an account
   * whose access has been revoked.
   */
  test("a disconnected connection's cursor record is a no-op", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    await t.mutation(internal.functions.chatProduct.applyChatConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...chatBindingArgs({}),
      encryptedRefreshToken: await encryptSecret("refresh-1", keyset, context),
      encryptedAccessToken: await encryptSecret("access-1", keyset, context),
    });
    const connection = await t.run((ctx) =>
      ctx.db
        .query("googleConnections")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
    );
    await asUser(t, owner).mutation(api.functions.googleConnect.disconnectGoogleConnection, {
      workspaceId,
      connectionId: connection!._id,
    });

    await t.mutation(internal.functions.chatProduct.recordChatCursors, {
      connectionId: connection!._id,
      cursors: { "spaces/a": "cursor-a-1" },
    });

    const row = await t.run((ctx) => ctx.db.get(connection!._id));
    expect(row!.chat?.cursors).toBeUndefined();
    expect(row!.health).toBe("error");
  });
});

describe("isolation: one context's chat connections are invisible to another", () => {
  test("productsForConnection for a connection id from another workspace returns nothing", async () => {
    const { t, owner: aliceOwner, workspaceId: aliceWs } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: aliceWs as string };
    await t.mutation(internal.functions.chatProduct.applyChatConnectionBinding, {
      workspaceId: aliceWs,
      boundBy: aliceOwner,
      ...chatBindingArgs({}),
      encryptedRefreshToken: await encryptSecret("refresh-1", keyset, context),
      encryptedAccessToken: await encryptSecret("access-1", keyset, context),
    });
    const aliceConnection = await t.run((ctx) =>
      ctx.db
        .query("googleConnections")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", aliceWs))
        .unique(),
    );

    const bobOwner = await createUser(t, "bob-owner@example.invalid");
    const bobWs = await createWorkspace(t, bobOwner, "bob-ctx");

    const products = await t.query(internal.functions.chatProduct.productsForConnection, {
      workspaceId: bobWs,
      connectionId: aliceConnection!._id,
    });
    expect(products).toEqual([]);
  });
});

/* ==========================================================================
 * Adversarial review, 2026-09-08. Everything below was added by the review of
 * this change rather than by the change itself, and each block names the
 * attack it runs rather than the feature it exercises.
 * ========================================================================== */

describe("a disconnect is not undone by adding a different product", () => {
  /**
   * THE ATTACK, and it needs no attacker — the person does it to themselves.
   *
   * `disconnectGoogleConnection` revokes the whole grant and deliberately
   * LEAVES `products` behind as a record of what the connection used to sync.
   * A console screen that then offers "Add Chat" against that same row would,
   * unfixed, fold `["gmail"]` into the scope request — so the person who
   * explicitly ended our access to their mail is shown a Google consent screen
   * asking for `gmail.readonly` again, and the row comes back with Gmail
   * enabled, because they added Chat.
   *
   * Sabotage: drop the `disconnectedAt !== undefined` line in
   * `productsForConnection` and this test fails on the scope string.
   */
  test("a disconnected connection's products are never folded into a new scope request", async () => {
    enableMailConnect();
    vi.stubEnv("APP_ORIGIN", APP);
    const { t, owner, workspaceId } = await personalScenario();
    const address = await gmailArgs(t, workspaceId, owner);
    const connection = await t.run((ctx) =>
      ctx.db
        .query("googleConnections")
        .withIndex("by_workspace_address", (q) => q.eq("workspaceId", workspaceId).eq("address", address))
        .unique(),
    );

    await asUser(t, owner).mutation(api.functions.googleConnect.disconnectGoogleConnection, {
      workspaceId,
      connectionId: connection!._id,
    });
    // The record of what it used to sync is still there — that is the trap.
    expect((await t.run((ctx) => ctx.db.get(connection!._id)))!.products).toEqual(["gmail"]);

    expect(
      await t.query(internal.functions.chatProduct.productsForConnection, {
        workspaceId,
        connectionId: connection!._id,
      }),
    ).toEqual([]);

    const { authorizeUrl } = await asUser(t, owner).action(api.functions.chatProduct.startChatConnect, {
      workspaceId,
      redirectUri: REDIRECT,
      connectionId: connection!._id,
    });
    const scope = new URL(authorizeUrl).searchParams.get("scope") ?? "";
    expect(scope).not.toContain(GMAIL_SCOPE);
    expect(scope).toContain(CHAT_MESSAGES_SCOPE);
  });

  /**
   * The second half: even when Google hands back a grant that DOES still
   * cover Gmail (`include_granted_scopes=true` unions whatever the client
   * still holds, and a revoke that failed silently would leave it holding
   * mail), reviving the row for a Chat connect must not put Gmail back on the
   * live `products` set. The settings object survives — a mailbox slug is a
   * folder somebody's mail is already sitting in, and renaming it is a
   * migration nobody asked for.
   *
   * Sabotage: drop `revived ? [] : …` in `applyChatConnectionBinding` and
   * `products` comes back `["gmail", "chat"]`.
   */
  test("reviving a disconnected row for chat enables chat alone, keeping gmail's settings for a deliberate reconnect", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    const address = await gmailArgs(t, workspaceId, owner);
    const connection = await t.run((ctx) =>
      ctx.db
        .query("googleConnections")
        .withIndex("by_workspace_address", (q) => q.eq("workspaceId", workspaceId).eq("address", address))
        .unique(),
    );
    await asUser(t, owner).mutation(api.functions.googleConnect.disconnectGoogleConnection, {
      workspaceId,
      connectionId: connection!._id,
    });

    await t.mutation(internal.functions.chatProduct.applyChatConnectionBinding, {
      workspaceId,
      boundBy: owner,
      address,
      googleAccountId: "google-1",
      scopes: [GMAIL_SCOPE, CHAT_MESSAGES_SCOPE, CHAT_SPACES_SCOPE],
      accessTokenExpiresAt: Date.now() + 3_600_000,
      encryptedRefreshToken: await encryptSecret("refresh-revived", keyset, context),
      encryptedAccessToken: await encryptSecret("access-revived", keyset, context),
    });

    const row = await t.run((ctx) => ctx.db.get(connection!._id));
    expect(row!.products).toEqual(["chat"]);
    expect(row!.disconnectedAt).toBeUndefined();
    // Kept, so a later deliberate Gmail reconnect lands in the same folder.
    expect(row!.gmail?.mailboxSlug).toBe("person-at-example-invalid");
    // ...and a Gmail reconnect is what puts it back, deliberately.
    await t.mutation(internal.functions.googleConnect.applyGmailConnectionBinding, {
      workspaceId,
      boundBy: owner,
      address,
      mailboxSlug: "person-at-example-invalid",
      googleAccountId: "google-1",
      scopes: [GMAIL_SCOPE, CHAT_MESSAGES_SCOPE, CHAT_SPACES_SCOPE],
      backfillDays: 90,
      folders: ["inbox", "sent"],
      attachmentMode: "store",
      attachmentRetentionDays: 90,
      accessTokenExpiresAt: Date.now() + 3_600_000,
      encryptedRefreshToken: await encryptSecret("refresh-again", keyset, context),
      encryptedAccessToken: await encryptSecret("access-again", keyset, context),
    });
    expect((await t.run((ctx) => ctx.db.get(connection!._id)))!.products.sort()).toEqual(["chat", "gmail"]);
  });
});

describe("a grant narrower than the row's products is reported, not just recorded", () => {
  /**
   * The half of the scope-union gap this change did not name: BOTH fixes can
   * be in place and Google can still hand back less than was asked for (the
   * person unticks a box on the consent screen; an admin policy refuses a
   * restricted scope). The grant is recorded verbatim and the slice honestly
   * recomputed to `[]` — that rule is right and is untouched — but until this,
   * NOTHING anywhere read that empty slice. The row went on to say
   * `health: "backfilling"` beside a `products` still listing Gmail, and the
   * first thing to notice would have been a 403 from Google inside a mail
   * sync that is not built yet.
   *
   * Sabotage: restore the unconditional `health: "backfilling"` and both
   * assertions below fail.
   */
  test("adding chat with a grant that dropped gmail marks the row reconnect_required", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    const address = await gmailArgs(t, workspaceId, owner);

    await t.mutation(internal.functions.chatProduct.applyChatConnectionBinding, {
      workspaceId,
      boundBy: owner,
      address,
      googleAccountId: "google-1",
      scopes: [CHAT_MESSAGES_SCOPE, CHAT_SPACES_SCOPE],
      accessTokenExpiresAt: Date.now() + 3_600_000,
      encryptedRefreshToken: await encryptSecret("refresh-narrow", keyset, context),
      encryptedAccessToken: await encryptSecret("access-narrow", keyset, context),
    });

    const row = await t.run((ctx) =>
      ctx.db
        .query("googleConnections")
        .withIndex("by_workspace_address", (q) => q.eq("workspaceId", workspaceId).eq("address", address))
        .unique(),
    );
    // Unchanged: the record is still honest about the narrow grant.
    expect(row!.gmail?.scopes).toEqual([]);
    // New: and it says so, rather than reporting a healthy backfill.
    expect(row!.health).toBe("reconnect_required");
    expect(row!.errorCode).toBe("SCOPES_INCOMPLETE");
    expect(row!.lastError).toContain("gmail");
    // No provider prose, no token, no address in the message.
    expect(row!.lastError).not.toContain(address);
  });

  test("a complete union grant is still an ordinary backfill with no error", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    const address = await gmailArgs(t, workspaceId, owner);

    await t.mutation(internal.functions.chatProduct.applyChatConnectionBinding, {
      workspaceId,
      boundBy: owner,
      address,
      googleAccountId: "google-1",
      scopes: [GMAIL_SCOPE, CHAT_MESSAGES_SCOPE, CHAT_SPACES_SCOPE],
      accessTokenExpiresAt: Date.now() + 3_600_000,
      encryptedRefreshToken: await encryptSecret("refresh-union", keyset, context),
      encryptedAccessToken: await encryptSecret("access-union", keyset, context),
    });

    const row = await t.run((ctx) =>
      ctx.db
        .query("googleConnections")
        .withIndex("by_workspace_address", (q) => q.eq("workspaceId", workspaceId).eq("address", address))
        .unique(),
    );
    expect(row!.health).toBe("backfilling");
    expect(row!.errorCode).toBeUndefined();
    expect(row!.lastError).toBeUndefined();
  });

  /** A grant that does not even cover Chat is the same answer, not a special case. */
  test("a grant that covers neither product is reconnect_required too", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    await t.mutation(internal.functions.chatProduct.applyChatConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...chatBindingArgs({ scopes: ["openid"] }),
      encryptedRefreshToken: await encryptSecret("refresh-empty", keyset, context),
      encryptedAccessToken: await encryptSecret("access-empty", keyset, context),
    });
    const row = await t.run((ctx) =>
      ctx.db
        .query("googleConnections")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
    );
    expect(row!.health).toBe("reconnect_required");
    expect(row!.chat?.scopes).toEqual([]);
  });
});

describe("a stale connection id is 'starting fresh', never an error and never a signal", () => {
  test("a connectionId whose row has been deleted contributes nothing and does not throw", async () => {
    enableMailConnect();
    vi.stubEnv("APP_ORIGIN", APP);
    const { t, owner, workspaceId } = await personalScenario();
    const address = await gmailArgs(t, workspaceId, owner);
    const connection = await t.run((ctx) =>
      ctx.db
        .query("googleConnections")
        .withIndex("by_workspace_address", (q) => q.eq("workspaceId", workspaceId).eq("address", address))
        .unique(),
    );
    const staleId = connection!._id;
    await t.run((ctx) => ctx.db.delete(staleId));

    const { authorizeUrl } = await asUser(t, owner).action(api.functions.chatProduct.startChatConnect, {
      workspaceId,
      redirectUri: REDIRECT,
      connectionId: staleId,
    });
    const scope = new URL(authorizeUrl).searchParams.get("scope") ?? "";
    expect(scope).not.toContain(GMAIL_SCOPE);
    expect(scope).toContain(CHAT_MESSAGES_SCOPE);
  });
});

describe("write access to somebody's context is never implied by read", () => {
  /**
   * The existing non-owner tests use somebody with NO membership at all, so
   * `membership?.role !== "owner"` refuses them on `membership === null` and
   * would refuse them just as well if the role half were dropped. An EDITOR is
   * the case that tells the two apart, and it is the one CLAUDE.md names:
   * "write access to someone else's context is never implied by read".
   */
  test("an editor of somebody's personal context cannot start a Chat connect on it", async () => {
    enableMailConnect();
    vi.stubEnv("APP_ORIGIN", APP);
    const { t, owner, workspaceId } = await personalScenario();
    const editor = await createUser(t, "editor@example.invalid");
    await addMember(t, workspaceId, editor, "editor", owner);

    const error = await captureError(() =>
      asUser(t, editor).action(api.functions.chatProduct.startChatConnect, {
        workspaceId,
        redirectUri: REDIRECT,
      }),
    );
    expect(errorCode(error)).toBe("NOT_PERSONAL_OWNER");
    expect(await t.run((ctx) => ctx.db.query("googleConnectAttempts").collect())).toHaveLength(0);
  });

  /** Sabotage: relax `membership?.role !== "owner"` to `membership === null`. */
  test("an editor cannot change what somebody else's connection syncs", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    await t.mutation(internal.functions.chatProduct.applyChatConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...chatBindingArgs({}),
      encryptedRefreshToken: await encryptSecret("refresh-1", keyset, context),
      encryptedAccessToken: await encryptSecret("access-1", keyset, context),
    });
    const connection = await t.run((ctx) =>
      ctx.db
        .query("googleConnections")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
    );
    const editor = await createUser(t, "editor@example.invalid");
    await addMember(t, workspaceId, editor, "editor", owner);

    const error = await captureError(() =>
      asUser(t, editor).mutation(api.functions.chatProduct.setChatSpaceState, {
        workspaceId,
        connectionId: connection!._id,
        spaceKey: "spaces/noisy",
        state: "excluded",
      }),
    );
    expect(errorCode(error)).toBe("NOT_OWNER");
    expect((await t.run((ctx) => ctx.db.get(connection!._id)))!.chat?.spaceSettings).toBeUndefined();
  });
});

describe("a space key is a bounded field name, not a caller's string", () => {
  async function connected() {
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    await t.mutation(internal.functions.chatProduct.applyChatConnectionBinding, {
      workspaceId,
      boundBy: owner,
      ...chatBindingArgs({}),
      encryptedRefreshToken: await encryptSecret("refresh-1", keyset, context),
      encryptedAccessToken: await encryptSecret("access-1", keyset, context),
    });
    const connection = await t.run((ctx) =>
      ctx.db
        .query("googleConnections")
        .withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId))
        .unique(),
    );
    return { t, owner, workspaceId, connectionId: connection!._id };
  }

  /**
   * `spaceSettings` is a `v.record`, so this string becomes a FIELD NAME on a
   * stored document. Reserved prefixes, control characters and unbounded
   * length are each refused with a code rather than reaching the write — an
   * owner can only do this to their own row, which is why it is a bound and
   * not an alarm, but a refusal with a code beats an unhandled write failure.
   */
  test.each([
    ["a reserved underscore prefix", "_id"],
    ["a reserved dollar prefix", "$where"],
    ["an empty key", ""],
    ["a control character", "spaces/a\u0007b"],
    ["an unbounded key", `spaces/${"a".repeat(400)}`],
  ])("%s is refused, and the row is untouched", async (_label, spaceKey) => {
    const { t, owner, workspaceId, connectionId } = await connected();
    const error = await captureError(() =>
      asUser(t, owner).mutation(api.functions.chatProduct.setChatSpaceState, {
        workspaceId,
        connectionId,
        spaceKey,
        state: "excluded",
      }),
    );
    expect(errorCode(error)).toBe("SPACE_KEY_INVALID");
    expect((await t.run((ctx) => ctx.db.get(connectionId)))!.chat?.spaceSettings).toBeUndefined();
  });

  test("a real Chat space resource name still works", async () => {
    const { t, owner, workspaceId, connectionId } = await connected();
    await asUser(t, owner).mutation(api.functions.chatProduct.setChatSpaceState, {
      workspaceId,
      connectionId,
      spaceKey: "spaces/AAAA_bBcC-1",
      state: "paused",
    });
    expect((await t.run((ctx) => ctx.db.get(connectionId)))!.chat?.spaceSettings).toEqual({
      "spaces/AAAA_bBcC-1": "paused",
    });
  });
});

describe("the PKCE verifier never leaves this server, and the request asks for nothing broader", () => {
  test("the authorize URL carries the challenge and never the verifier, and the parked attempt seals it", async () => {
    enableMailConnect();
    vi.stubEnv("APP_ORIGIN", APP);
    const { t, owner, workspaceId } = await personalScenario();
    const { authorizeUrl } = await asUser(t, owner).action(api.functions.chatProduct.startChatConnect, {
      workspaceId,
      redirectUri: REDIRECT,
    });

    const url = new URL(authorizeUrl);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.searchParams.get("code_verifier")).toBe(null);
    expect(authorizeUrl).not.toContain("verifier");

    const attempt = await t.run((ctx) => ctx.db.query("googleConnectAttempts").unique());
    expect(attempt!.encryptedVerifier.startsWith("v2:")).toBe(true);
    // The challenge is the browser's half; nothing on the parked row repeats it.
    expect(JSON.stringify(attempt)).not.toContain(url.searchParams.get("code_challenge"));
  });

  /**
   * Chat's two scopes and the identity pair, and nothing else — in particular
   * nothing that can WRITE. `chat.messages.readonly` is restricted (the same
   * class as `gmail.readonly`), so a broader scope creeping into this request
   * is a change to what the CASA assessment has to cover.
   */
  test("a chat-only connect requests exactly the two read-only chat scopes plus identity", async () => {
    enableMailConnect();
    vi.stubEnv("APP_ORIGIN", APP);
    const { t, owner, workspaceId } = await personalScenario();
    const { authorizeUrl } = await asUser(t, owner).action(api.functions.chatProduct.startChatConnect, {
      workspaceId,
      redirectUri: REDIRECT,
    });
    const scopes = (new URL(authorizeUrl).searchParams.get("scope") ?? "").split(" ").filter(Boolean);
    expect(scopes.sort()).toEqual(
      ["openid", "https://www.googleapis.com/auth/userinfo.email", CHAT_MESSAGES_SCOPE, CHAT_SPACES_SCOPE].sort(),
    );
    for (const scope of scopes) expect(scope).not.toMatch(/\.(send|write|create|delete|modify)$/);
  });
});
