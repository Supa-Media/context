import { describe, expect, test } from "vitest";
import { api, internal } from "../../_generated/api";
import {
  asUser,
  captureError,
  createUser,
  createWorkspace,
  errorCode,
} from "../fixtures.helpers";
import { encryptSecret, requireKeyset } from "../../functions/lib/crypto";
import {
  GMAIL_SCOPE,
  CHAT_MESSAGES_SCOPE,
  CHAT_SPACES_SCOPE,
  CALENDAR_SCOPE,
  personalScenario,
  chatBindingArgs,
  gmailArgs,
} from "./fixtures.helpers";

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

  test("reconnecting preserves spaceSettings, cursors, the destination, and the nonce seed", async () => {
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
          destinationFolder: "2-areas/communications/daily",
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
    expect(row?.chat?.destinationFolder).toBe("2-areas/communications/daily");
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

  test("a chat connection nobody has configured files its days in the Inbox", async () => {
    /*
      The console reads the destination off `listGoogleConnections`, which
      resolves `chat.destinationFolder ?? defaultGoogleDestinationFolder`. A
      first connect stores no folder — `applyChatConnectionBinding` carries
      `existing?.chat?.destinationFolder` forward and there is no existing —
      so this query IS the answer a customer gets, and it read
      `2-areas/communications/daily/YYYY-MM-DD.md` for every Chat connection
      that had never had the field opened. `0-inbox/google-chat` is the folder
      `docs/decisions/communications.md` decided and the one the console's own
      channel view routes; a day written anywhere else is a day that shows up
      as a plain file in a folder browser.
    */
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

    const [view] = await asUser(t, owner).query(api.functions.googleConnect.listGoogleConnections, {
      workspaceId,
    });
    expect(view?.chat?.destinationFolder).toBe("0-inbox/google-chat/person-at-example-invalid");
    expect(view?.chat?.destinationPath).toBe(
      "0-inbox/google-chat/person-at-example-invalid/YYYY/MM/YYYY-MM-DD.md",
    );
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

