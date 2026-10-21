import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { addMember, asUser, captureError, createUser, createWorkspace, errorCode, setupTest, type TestConvex } from "../fixtures.helpers";
import { hashToken } from "../../functions/lib/crypto";

/**
 * CONNECTORS: a link only its person can finish, a consent only the browser
 * that started it can land, a token sealed to the workspace that asked, and a
 * group chat that never reaches anyone's own Slack (`docs/decisions/connectors.md`).
 */

const APP = "https://app.context.invalid";
const USER_TOKEN = "xoxp-0000-fake-user-token";
const BOT_TOKEN = "xoxb-0000-fake-bot-token";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

function enableSlack() {
  vi.stubEnv("APP_ORIGIN", APP);
  vi.stubEnv("SLACK_CLIENT_ID", "1234.5678");
  vi.stubEnv("SLACK_CLIENT_SECRET", "fake-slack-secret");
}

/** Slack's `oauth.v2.access` answer for one team, with both halves; the scope decides which is kept. */
function stubSlack(calls: Array<{ url: string; body: string; auth: string | null }> = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      calls.push({ url, body: String(init?.body ?? ""), auth: headers.get("Authorization") });
      if (url.endsWith("/oauth.v2.access")) {
        return Response.json({
          ok: true,
          access_token: BOT_TOKEN,
          scope: "chat:write,channels:read",
          bot_user_id: "UBOT",
          team: { id: "T1", name: "Acme" },
          authed_user: { id: "U1", access_token: USER_TOKEN, scope: "search:read,chat:write" },
        });
      }
      if (url.endsWith("/auth.revoke")) return Response.json({ ok: true });
      if (url.endsWith("/conversations.list")) return Response.json({ ok: true, channels: [{ id: "C1", name: "general" }] });
      if (url.endsWith("/chat.postMessage")) return Response.json({ ok: false, error: "token_revoked" });
      return Response.json({ ok: false, error: "unknown_method" });
    }),
  );
  return calls;
}

async function world(t: TestConvex) {
  const seyi = await createUser(t, "seyi@example.invalid");
  const sayo = await createUser(t, "sayo@example.invalid");
  const reader = await createUser(t, "reader@example.invalid");
  const personal = await createWorkspace(t, seyi, "seyi-slack", { kind: "personal" });
  const team = await createWorkspace(t, seyi, "team-slack", { kind: "shared" });
  await addMember(t, team, sayo, "editor", seyi);
  await addMember(t, team, reader, "member", seyi);
  return { seyi, sayo, reader, personal, team };
}

async function issue(
  t: TestConvex,
  args: { workspaceId: Id<"workspaces">; userId: Id<"users">; clientId?: string },
  token = `tok-${Math.random().toString(36).slice(2)}-padding`,
) {
  const status = await t.mutation(internal.functions.connections.issueConnectLink, {
    provider: "slack",
    workspaceId: args.workspaceId,
    userId: args.userId,
    clientId: args.clientId ?? "context_texts",
    hashedToken: await hashToken(token),
  });
  return { status, token };
}

async function connect(t: TestConvex, userId: Id<"users">, token: string) {
  const started = await asUser(t, userId).action(api.functions.connections.startProviderConnect, { token });
  const state = new URL(started.authorizeUrl).searchParams.get("state")!;
  const done = await asUser(t, userId).action(api.functions.connections.completeProviderConnect, {
    provider: "slack",
    state,
    code: "code-1",
    completionSecret: started.completionSecret,
  });
  return { started, state, done };
}

describe("asking for a connect link", () => {
  test("a group chat can only ask for a shared workspace's connection, never someone's own", async () => {
    const t = setupTest();
    const w = await world(t);
    expect((await issue(t, { workspaceId: w.personal, userId: w.seyi, clientId: "context_texts_group" })).status).toBe("refused");
    expect((await issue(t, { workspaceId: w.team, userId: w.sayo, clientId: "context_texts_group" })).status).toBe("issued");
  });

  test("a member who can only read, or a stranger, gets no link", async () => {
    const t = setupTest();
    const w = await world(t);
    const stranger = await createUser(t, "stranger@example.invalid");
    expect((await issue(t, { workspaceId: w.team, userId: w.reader })).status).toBe("refused");
    expect((await issue(t, { workspaceId: w.team, userId: stranger })).status).toBe("refused");
    expect((await issue(t, { workspaceId: w.personal, userId: w.sayo })).status).toBe("refused");
  });

  test("only the person whose grant asked can open it; anyone else is told it is not theirs", async () => {
    enableSlack();
    const t = setupTest();
    const w = await world(t);
    const { token } = await issue(t, { workspaceId: w.team, userId: w.seyi });
    const mine = await asUser(t, w.seyi).query(api.functions.connections.connectLinkInfo, { token });
    expect(mine).toMatchObject({ state: "ready", scope: "workspace", workspaceName: expect.any(String), available: true });
    expect(await asUser(t, w.sayo).query(api.functions.connections.connectLinkInfo, { token })).toEqual({ state: "not_yours" });
    expect(await asUser(t, w.seyi).query(api.functions.connections.connectLinkInfo, { token: "never-issued-token-xx" })).toEqual({
      state: "expired",
    });
    const err = await captureError(() => asUser(t, w.sayo).action(api.functions.connections.startProviderConnect, { token }));
    expect(errorCode(err)).toBe("CONNECT_LINK_EXPIRED");
  });
});

describe("the consent round trip", () => {
  test("a personal workspace asks Slack for the person's own scopes, a shared one for the bot's", async () => {
    enableSlack();
    const t = setupTest();
    const w = await world(t);
    const mine = await issue(t, { workspaceId: w.personal, userId: w.seyi });
    const ours = await issue(t, { workspaceId: w.team, userId: w.seyi });
    const personal = new URL((await asUser(t, w.seyi).action(api.functions.connections.startProviderConnect, { token: mine.token })).authorizeUrl);
    const shared = new URL((await asUser(t, w.seyi).action(api.functions.connections.startProviderConnect, { token: ours.token })).authorizeUrl);
    expect(personal.origin + personal.pathname).toBe("https://slack.com/oauth/v2/authorize");
    expect(personal.searchParams.get("user_scope")).toContain("search:read");
    expect(personal.searchParams.get("scope")).toBe(null);
    expect(shared.searchParams.get("scope")).toContain("chat:write");
    expect(shared.searchParams.get("user_scope")).toBe(null);
    expect(personal.searchParams.get("redirect_uri")).toBe(`${APP}/connect/slack`);
  });

  test("the token is sealed to the workspace, the link is spent, and a second answer is refused", async () => {
    enableSlack();
    const calls = stubSlack();
    const t = setupTest();
    const w = await world(t);
    const { token } = await issue(t, { workspaceId: w.personal, userId: w.seyi });
    const { state, started, done } = await connect(t, w.seyi, token);
    expect(done).toEqual({ teamName: "Acme", workspaceName: expect.any(String), scope: "personal" });
    expect(calls[0].body).toContain("client_secret=fake-slack-secret");

    const rows = await t.run((ctx) => ctx.db.query("providerConnections").collect());
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ workspaceId: w.personal, scope: "personal", externalAccountId: "U1", externalTeamName: "Acme" });
    // The user half, never the bot's, and never in the clear.
    expect(JSON.stringify(rows)).not.toContain(USER_TOKEN);
    expect(JSON.stringify(rows)).not.toContain(BOT_TOKEN);

    expect(await asUser(t, w.seyi).query(api.functions.connections.connectLinkInfo, { token })).toEqual({ state: "expired" });
    const replay = await captureError(() =>
      asUser(t, w.seyi).action(api.functions.connections.completeProviderConnect, {
        provider: "slack",
        state,
        code: "code-1",
        completionSecret: started.completionSecret,
      }),
    );
    expect(errorCode(replay)).toBe("CONNECT_LINK_EXPIRED");
  });

  /** Sabotage: drop the `hashedCompletion` comparison in `consumeConnectAttempt`. */
  test("a consent answered without the starting browser's secret lands nowhere", async () => {
    enableSlack();
    stubSlack();
    const t = setupTest();
    const w = await world(t);
    const { token } = await issue(t, { workspaceId: w.personal, userId: w.seyi });
    const started = await asUser(t, w.seyi).action(api.functions.connections.startProviderConnect, { token });
    const state = new URL(started.authorizeUrl).searchParams.get("state")!;
    const err = await captureError(() =>
      asUser(t, w.seyi).action(api.functions.connections.completeProviderConnect, {
        provider: "slack",
        state,
        code: "code-1",
        completionSecret: "somebody-elses-secret-value",
      }),
    );
    expect(errorCode(err)).toBe("CONNECT_LINK_EXPIRED");
    expect(await t.run((ctx) => ctx.db.query("providerConnections").collect())).toHaveLength(0);
  });

  test("with no Slack app configured the page says so and nothing is parked", async () => {
    vi.stubEnv("APP_ORIGIN", APP);
    const t = setupTest();
    const w = await world(t);
    const { token } = await issue(t, { workspaceId: w.personal, userId: w.seyi });
    expect(await asUser(t, w.seyi).query(api.functions.connections.connectLinkInfo, { token })).toMatchObject({ available: false });
    const err = await captureError(() => asUser(t, w.seyi).action(api.functions.connections.startProviderConnect, { token }));
    expect(errorCode(err)).toBe("CONNECTOR_UNAVAILABLE");
  });
});

describe("calling Slack through a connection", () => {
  async function connected() {
    enableSlack();
    const calls = stubSlack();
    const t = setupTest();
    const w = await world(t);
    await connect(t, w.seyi, (await issue(t, { workspaceId: w.personal, userId: w.seyi })).token);
    await connect(t, w.seyi, (await issue(t, { workspaceId: w.team, userId: w.seyi })).token);
    calls.length = 0;
    return { t, w, calls };
  }

  function call(t: TestConvex, args: { workspaceId: Id<"workspaces">; actorUserId: Id<"users">; clientId?: string; method: string }) {
    return t.action(internal.functions.connections.callProvider, {
      provider: "slack",
      clientId: args.clientId ?? "context_texts",
      args: {},
      workspaceId: args.workspaceId,
      actorUserId: args.actorUserId,
      method: args.method,
    });
  }

  test("a call carries the workspace's own token, and the answer is Slack's", async () => {
    const { t, w, calls } = await connected();
    const mine = await call(t, { workspaceId: w.personal, actorUserId: w.seyi, method: "conversations.list" });
    expect(mine).toMatchObject({ ok: true, team: "Acme", body: { ok: true } });
    expect(calls[0].auth).toBe(`Bearer ${USER_TOKEN}`);
    await call(t, { workspaceId: w.team, actorUserId: w.sayo, clientId: "context_texts_group", method: "conversations.list" });
    expect(calls[1].auth).toBe(`Bearer ${BOT_TOKEN}`);
  });

  /** Sabotage: drop the personal-scope filter in `connectionsForCall`. */
  test("a group chat, or another person, never reaches someone's own Slack", async () => {
    const { t, w, calls } = await connected();
    expect(await call(t, { workspaceId: w.personal, actorUserId: w.seyi, clientId: "context_texts_group", method: "conversations.list" })).toEqual({
      ok: false,
      refused: "not_connected",
    });
    expect(await call(t, { workspaceId: w.personal, actorUserId: w.sayo, method: "conversations.list" })).toEqual({
      ok: false,
      refused: "not_connected",
    });
    expect(calls).toHaveLength(0);
  });

  test("a method off the list never leaves", async () => {
    const { t, w, calls } = await connected();
    expect(await call(t, { workspaceId: w.personal, actorUserId: w.seyi, method: "admin.users.remove" })).toEqual({
      ok: false,
      refused: "method_not_allowed",
    });
    expect(calls).toHaveLength(0);
  });

  test("a revoked token marks the connection for reconnecting, and a write is audited without its words", async () => {
    const { t, w } = await connected();
    const posted = await call(t, { workspaceId: w.personal, actorUserId: w.seyi, method: "chat.postMessage" });
    expect(posted).toEqual({ ok: false, refused: "reconnect_required" });
    const listed = await asUser(t, w.seyi).query(api.functions.connections.listConnections, { workspaceId: w.personal });
    expect(listed[0]).toMatchObject({ reconnectRequired: true, teamName: "Acme" });
    const audit = await t.run((ctx) => ctx.db.query("auditEvents").collect());
    expect(audit.some((row) => row.action === "connection.called" && row.details?.method === "chat.postMessage")).toBe(true);
  });
});

describe("Settings", () => {
  test("a member sees the workspace's connections without a token; a stranger sees none and cannot disconnect", async () => {
    enableSlack();
    const calls = stubSlack();
    const t = setupTest();
    const w = await world(t);
    await connect(t, w.seyi, (await issue(t, { workspaceId: w.team, userId: w.seyi })).token);
    const seen = await asUser(t, w.reader).query(api.functions.connections.listConnections, { workspaceId: w.team });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ scope: "workspace", canDisconnect: false });
    expect(JSON.stringify(seen)).not.toContain("xox");

    const stranger = await createUser(t, "stranger@example.invalid");
    expect(await asUser(t, stranger).query(api.functions.connections.listConnections, { workspaceId: w.team })).toEqual([]);
    const refused = await captureError(() =>
      asUser(t, stranger).mutation(api.functions.connections.disconnectConnection, { connectionId: seen[0].id }),
    );
    expect(errorCode(refused)).toBe("CONNECTION_NOT_FOUND");
    const notAllowed = await captureError(() =>
      asUser(t, w.reader).mutation(api.functions.connections.disconnectConnection, { connectionId: seen[0].id }),
    );
    expect(errorCode(notAllowed)).toBe("INSUFFICIENT_ROLE");

    calls.length = 0;
    await asUser(t, w.sayo).mutation(api.functions.connections.disconnectConnection, { connectionId: seen[0].id });
    await t.finishAllScheduledFunctions(() => {}, 200);
    expect(await t.run((ctx) => ctx.db.query("providerConnections").collect())).toHaveLength(0);
    expect(calls.some((c) => c.url.endsWith("/auth.revoke") && c.auth === `Bearer ${BOT_TOKEN}`)).toBe(true);
  });
});
