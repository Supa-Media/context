import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import {
  asUser,
  captureError,
  errorCode,
} from "../fixtures.helpers";
import { encryptSecret, hashToken, requireKeyset } from "../../functions/lib/crypto";
import {
  APP,
  REDIRECT,
  CHAT_MESSAGES_SCOPE,
  CHAT_SPACES_SCOPE,
  enableMailConnect,
  personalScenario,
  chatBindingArgs,
  COMPLETION,
  parkedAttempt,
} from "./fixtures.helpers";

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

/**
 * The third consumer of one shared attempt table, closed after Chat landed.
 *
 * `googleConnectAttempts` is shared by Gmail's, Calendar's and Chat's connect
 * flows, and each `complete*` used to look an attempt up by `hashedState`
 * alone. Not attacker-reachable — the state is the person's own secret and
 * the workspace still comes from the attempt, never from the caller — but a
 * state parked by one flow and answered by another attaches a product to the
 * row out of a consent screen that never mentioned it, which is a claim about
 * what somebody agreed to rather than a sync that merely fails. All three
 * consumers now check `products`, identically.
 */
describe("an attempt is for the products it parked (chat's third of the rule)", () => {
  test("a Gmail-only attempt cannot be completed as a Chat connect", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const state = await parkedAttempt(t, workspaceId, owner, { products: ["gmail"] });

    const consumed = await t.mutation(internal.functions.chatProduct.consumeChatAttemptAndExchange, {
      hashedState: await hashToken(state),
      hashedCompletion: await hashToken(COMPLETION),
      code: "code-1",
    });
    expect(consumed).toBeNull();
    // Spent either way — a refused attempt is still a burned one.
    expect(await t.run((ctx) => ctx.db.query("googleConnectAttempts").collect())).toHaveLength(0);
    expect(await t.run((ctx) => ctx.db.query("googleConnections").collect())).toHaveLength(0);
  });

  test("a Calendar-only attempt cannot be completed as a Chat connect either", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const state = await parkedAttempt(t, workspaceId, owner, { products: ["calendar"] });

    expect(
      await t.mutation(internal.functions.chatProduct.consumeChatAttemptAndExchange, {
        hashedState: await hashToken(state),
        hashedCompletion: await hashToken(COMPLETION),
        code: "code-1",
      }),
    ).toBeNull();
  });

  test("an attempt naming chat alongside another product is still answerable here — the union case is not collateral damage", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const state = await parkedAttempt(t, workspaceId, owner, { products: ["gmail", "chat"] });

    const consumed = await t.mutation(internal.functions.chatProduct.consumeChatAttemptAndExchange, {
      hashedState: await hashToken(state),
      hashedCompletion: await hashToken(COMPLETION),
      code: "code-1",
    });
    expect(consumed?.workspaceId).toBe(workspaceId);
  });
});

describe("the browser that started a Chat connect is the one that may finish it", () => {
  /**
   * **THE FLOW THAT WAS LEFT OUT, and the demonstration that it mattered.**
   *
   * The change that bound Dropbox, Gmail and Calendar left this one completing
   * on `{state, code}` alone. Constructed against it, the attack ran to
   * completion: an attacker starts a Chat connect for a workspace they really own,
   * sends the authorize URL to somebody else, that person consents on Google's
   * own screen, and the callback binds THEIR Google account — the grant that
   * reads every space they are in — to the attacker's context.
   *
   * The product check this file already makes cannot see it: a Chat attempt
   * really is for Chat. PKCE cannot see it either: the attacker is the
   * initiator, so the verifier is genuinely theirs. What separates the two is
   * a value that never travels through Google.
   *
   * Still no session, for `#76`'s reason: a sign-in wall on a callback
   * outlives a provider's single-use code.
   */
  test("A COMPLETION WITHOUT THE STARTING BROWSER'S SECRET IS REFUSED", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const state = await parkedAttempt(t, workspaceId, owner);

    const consumed = await t.mutation(internal.functions.chatProduct.consumeChatAttemptAndExchange, {
      hashedState: await hashToken(state),
      hashedCompletion: await hashToken("a-guess"),
      code: "code-1",
    });
    expect(consumed).toBeNull();
  });

  test("...and the secret the starter kept does complete it", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const state = await parkedAttempt(t, workspaceId, owner);

    const consumed = await t.mutation(internal.functions.chatProduct.consumeChatAttemptAndExchange, {
      hashedState: await hashToken(state),
      hashedCompletion: await hashToken(COMPLETION),
      code: "code-1",
    });
    expect(consumed?.workspaceId).toBe(workspaceId);
  });

  test("an attempt parked without one is refused rather than trusted", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const state = await parkedAttempt(t, workspaceId, owner, { hashedCompletion: undefined });

    const consumed = await t.mutation(internal.functions.chatProduct.consumeChatAttemptAndExchange, {
      hashedState: await hashToken(state),
      hashedCompletion: await hashToken("anything"),
      code: "code-1",
    });
    expect(consumed).toBeNull();
  });

  /** Spent either way: a wrong secret does not leave the attempt for a retry. */
  test("a refused completion still spends the attempt", async () => {
    const { t, owner, workspaceId } = await personalScenario();
    const state = await parkedAttempt(t, workspaceId, owner);

    await t.mutation(internal.functions.chatProduct.consumeChatAttemptAndExchange, {
      hashedState: await hashToken(state),
      hashedCompletion: await hashToken("a-guess"),
      code: "code-1",
    });
    const rows = await t.run((ctx) => ctx.db.query("googleConnectAttempts").collect());
    expect(rows).toHaveLength(0);
  });

  /**
   * **The link between the two halves**: the secret the start action HANDS OUT
   * is the one the attempt was parked under. Park the hash of a different
   * token and every real connect breaks while every test above still passes,
   * which is the sabotage this one exists to catch.
   */
  test("A CONNECT STARTED FOR REAL COMPLETES WITH THE SECRET IT WAS HANDED", async () => {
    enableMailConnect();
    const { t, owner, workspaceId } = await personalScenario();
    const { authorizeUrl, completionSecret } = await asUser(t, owner).action(
      api.functions.chatProduct.startChatConnect,
      { workspaceId, redirectUri: REDIRECT },
    );

    // The state is in the URL — it travels through Google. The secret is not,
    // and that is the whole property.
    const state = new URL(authorizeUrl).searchParams.get("state") as string;
    expect(state).toBeTruthy();
    expect(authorizeUrl).not.toContain(completionSecret);

    const consumed = await t.mutation(internal.functions.chatProduct.consumeChatAttemptAndExchange, {
      hashedState: await hashToken(state),
      hashedCompletion: await hashToken(completionSecret),
      code: "code-1",
    });
    expect(consumed?.workspaceId).toBe(workspaceId);
  });

  /**
   * The whole attack, through the PUBLIC action rather than the internal
   * mutation: a caller with no session, holding only what the URL carried, is
   * refused — and refused with the same answer an unknown state gets.
   */
  test("THE PUBLIC CALLBACK REFUSES A CALLER HOLDING ONLY THE URL", async () => {
    enableMailConnect();
    const { t, owner, workspaceId } = await personalScenario();
    const { authorizeUrl } = await asUser(t, owner).action(
      api.functions.chatProduct.startChatConnect,
      { workspaceId, redirectUri: REDIRECT },
    );
    const state = new URL(authorizeUrl).searchParams.get("state") as string;

    const refusal = await captureError(() =>
      t.action(api.functions.chatProduct.completeChatConnect, { state, code: "victims-code" }),
    );
    const unknown = await captureError(() =>
      t.action(api.functions.chatProduct.completeChatConnect, {
        state: "never-issued-at-all",
        code: "victims-code",
      }),
    );
    expect(errorCode(refusal)).toBe("CONNECT_ATTEMPT_INVALID");
    expect(JSON.stringify((refusal as { data?: unknown }).data)).toBe(
      JSON.stringify((unknown as { data?: unknown }).data),
    );
  });
});

describe("a connection records the folder it files into, rather than re-deriving it every pass", () => {
  /*
    THE FOLDER A CUSTOMER'S CONTENT IS WRITTEN INTO IS A FACT ABOUT THE
    CONNECTION, NOT A VALUE A DEPLOY RECOMPUTES.

    Gmail has always pinned it: `applyGmailConnectionBinding` writes
    `destinationFolder: existing ?? defaultGoogleDestinationFolder(...)`, so
    the answer is recorded at connect and the row keeps it. Chat and Calendar
    carried `existing?.chat?.destinationFolder` forward and stored nothing on
    a first connect, which left the folder to be re-resolved from a source
    constant on every single pass.

    That is not a cosmetic difference, because a Chat pass re-renders every
    day the contribution store still holds — up to a year of them. Changing
    the constant therefore rewrites a year of somebody's already-captured
    conversations at NEW KEYS, with no action by them and no notice. It
    happened: the constant moved from `2-areas/communications/daily` to
    `0-inbox/google-chat`.

    Relocating content is a privacy operation in this product, which is why
    `remapPrivacy` and `copyPrivacy` in `lib/fileOps.ts` exist — a move and
    even a copy carry the note's `note_overrides` exception with them, because
    an override names one exact path and a note that arrives at a new path
    arrives with none. A sync that re-renders to a new folder goes through
    neither, so a day the owner had marked `private` reappears at a path
    covered only by its new folder's default. Where that default is `team`,
    an exception the owner set by hand has been silently dropped.

    Pinning at connect is the half that stops it recurring; `sweepDueGoogleSyncs`
    records the resolved folder for rows written before this, which is the half
    that stops the ones already out there from floating.
  */
  test("a first chat connect records its destination folder on the row", async () => {
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
    // Recorded, not absent: an absent folder is one a later edit to
    // `defaultGoogleDestinationFolder` would answer differently — which is
    // exactly what happened on 2026-09-18, when Chat gained an account level.
    // A connection bound before that keeps what its row says; one bound after
    // it gets this account's own folder.
    expect(row?.chat?.destinationFolder).toBe("0-inbox/google-chat/person-at-example-invalid");
  });

  test("a reconnect keeps the folder the connection already had", async () => {
    // The pin must not overwrite a destination the owner chose. Same rule the
    // cursor and the nonce seed already follow.
    const { t, owner, workspaceId } = await personalScenario();
    const keyset = requireKeyset();
    const context = { workspaceId: workspaceId as string };
    const args = {
      workspaceId,
      boundBy: owner,
      ...chatBindingArgs({}),
      encryptedRefreshToken: await encryptSecret("refresh-1", keyset, context),
      encryptedAccessToken: await encryptSecret("access-1", keyset, context),
    };
    await t.mutation(internal.functions.chatProduct.applyChatConnectionBinding, args);
    const connection = await t.run((ctx) =>
      ctx.db
        .query("googleConnections")
        .withIndex("by_workspace_address", (q) =>
          q.eq("workspaceId", workspaceId).eq("address", "person@example.invalid"),
        )
        .unique(),
    );
    await asUser(t, owner).mutation(api.functions.googleConnect.updateGoogleSyncDestination, {
      workspaceId,
      connectionId: connection!._id,
      service: "chat",
      destinationPath: "2-areas/chat",
    });
    await t.mutation(internal.functions.chatProduct.applyChatConnectionBinding, args);

    const row = await t.run((ctx) => ctx.db.get(connection!._id));
    expect(row?.chat?.destinationFolder).toBe("2-areas/chat");
  });
});
