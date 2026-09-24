import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import {
  addMember,
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
} from "../fixtures.helpers";
import { encryptSecret, requireKeyset } from "../../functions/lib/crypto";
import {
  APP,
  REDIRECT,
  GMAIL_SCOPE,
  CHAT_MESSAGES_SCOPE,
  CHAT_SPACES_SCOPE,
  enableMailConnect,
  personalScenario,
  chatBindingArgs,
  gmailArgs,
} from "./fixtures";

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

