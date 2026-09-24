import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import {
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
} from "../fixtures.helpers";
import { encryptSecret, hashToken, requireKeyset } from "../../functions/lib/crypto";
import {
  APP,
  REDIRECT,
  GMAIL_SCOPE,
  CHAT_MESSAGES_SCOPE,
  CHAT_SPACES_SCOPE,
  enableMailConnect,
  personalScenario,
  sharedScenario,
  COMPLETION,
  parkedAttempt,
  chatBindingArgs,
  gmailArgs,
} from "./fixtures";

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

    await t.mutation(internal.functions.chatProduct.consumeChatAttemptAndExchange, {
      hashedState,
      hashedCompletion: await hashToken(COMPLETION),
      code: "code-1",
    });
    const remaining = await t.run((ctx) => ctx.db.query("googleConnectAttempts").collect());
    expect(remaining).toHaveLength(0);

    const replay = await t.mutation(internal.functions.chatProduct.consumeChatAttemptAndExchange, {
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
    const consumed = await t.mutation(internal.functions.chatProduct.consumeChatAttemptAndExchange, {
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
      await t.mutation(internal.functions.chatProduct.consumeChatAttemptAndExchange, {
        hashedState: await hashToken("never-issued-at-all"),
        hashedCompletion: await hashToken(COMPLETION),
        code: "c",
      }),
    );
    const spent = await parkedAttempt(t, workspaceId, owner);
    const spentHash = await hashToken(spent);
    await t.mutation(internal.functions.chatProduct.consumeChatAttemptAndExchange, {
      hashedState: spentHash,
      hashedCompletion: await hashToken(COMPLETION),
      code: "c",
    });
    answers.push(
      await t.mutation(internal.functions.chatProduct.consumeChatAttemptAndExchange, {
        hashedState: spentHash,
        hashedCompletion: await hashToken(COMPLETION),
        code: "c",
      }),
    );
    const expired = await parkedAttempt(t, workspaceId, owner, { expiresAt: Date.now() - 1 });
    answers.push(
      await t.mutation(internal.functions.chatProduct.consumeChatAttemptAndExchange, {
        hashedState: await hashToken(expired),
        hashedCompletion: await hashToken(COMPLETION),
        code: "c",
      }),
    );
    expect(answers).toEqual([null, null, null]);
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

