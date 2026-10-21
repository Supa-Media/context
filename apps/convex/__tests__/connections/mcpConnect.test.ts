import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { asUser, captureError, createUser, createWorkspace, setupTest, type TestConvex } from "../fixtures.helpers";
import { hashToken } from "../../functions/lib/crypto";

/**
 * Apps connected through their own MCP server (`lib/providers/mcpApps.ts`,
 * `docs/decisions/connectors.md`): discovered and registered without keys of
 * ours, consent bound to the browser that started it, the token exchanged by
 * a scheduled finish and never by the public action, and every tool the app
 * does not mark read-only refused unless the call is a change.
 */

const APP = "https://app.context.invalid";
const SERVER = "https://mcp.linear.app/mcp";
const ACCESS = "lin-access-0000-fake";
const REFRESHED = "lin-access-1111-fake";
const REFRESH = "lin-refresh-0000-fake";

type Seen = { url: string; method: string; body: string; auth: string | null };

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** Linear's MCP server and its authorization server, as their metadata and JSON-RPC answer. */
function stubLinear(options: { expiredToken?: string } = {}) {
  const seen: Seen[] = [];
  vi.stubEnv("APP_ORIGIN", APP);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = String(init?.body ?? "");
      const auth = new Headers(init?.headers).get("Authorization");
      seen.push({ url, method, body, auth });
      if (url === "https://mcp.linear.app/.well-known/oauth-protected-resource/mcp") {
        return Response.json({ resource: SERVER, authorization_servers: ["https://mcp.linear.app"] });
      }
      if (url === "https://mcp.linear.app/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: "https://mcp.linear.app",
          authorization_endpoint: "https://mcp.linear.app/authorize",
          token_endpoint: "https://mcp.linear.app/token",
          registration_endpoint: "https://mcp.linear.app/register",
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url === "https://mcp.linear.app/register") return Response.json({ client_id: "dcr-client-1" }, { status: 201 });
      if (url === "https://mcp.linear.app/token") {
        const form = new URLSearchParams(body);
        if (form.get("grant_type") === "refresh_token") {
          return Response.json({ access_token: REFRESHED, refresh_token: REFRESH, expires_in: 3600, token_type: "Bearer" });
        }
        if (form.get("code") !== "code-1") return Response.json({ error: "invalid_grant" }, { status: 400 });
        return Response.json({ access_token: ACCESS, refresh_token: REFRESH, expires_in: 3600, token_type: "Bearer" });
      }
      if (url === SERVER) {
        if (auth === `Bearer ${options.expiredToken}`) return new Response("", { status: 401 });
        const rpc = JSON.parse(body) as { id?: number; method: string; params?: { name?: string } };
        if (rpc.id === undefined) return new Response(null, { status: 202 });
        const answer = (result: unknown) => Response.json({ jsonrpc: "2.0", id: rpc.id, result }, { headers: { "Mcp-Session-Id": "s1" } });
        if (rpc.method === "initialize") return answer({ protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "linear" } });
        if (rpc.method === "tools/list") {
          return answer({
            tools: [
              { name: "list_issues", description: "List issues.", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
              { name: "create_issue", description: "Create an issue.", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
              { name: "unmarked", description: "Says nothing about itself.", inputSchema: { type: "object" } },
            ],
          });
        }
        if (rpc.method === "tools/call") return answer({ content: [{ type: "text", text: `ran ${rpc.params?.name}` }] });
      }
      return new Response("not found", { status: 404 });
    }),
  );
  return seen;
}

async function issue(t: TestConvex, workspaceId: Id<"workspaces">, userId: Id<"users">) {
  const token = `tok-${Math.random().toString(36).slice(2)}-padding`;
  const status = await t.mutation(internal.functions.connections.issueConnectLink, {
    provider: "linear",
    workspaceId,
    userId,
    clientId: "context_texts",
    hashedToken: await hashToken(token),
  });
  return { status, token };
}

async function world(t: TestConvex) {
  const seyi = await createUser(t, "seyi@example.invalid");
  const personal = await createWorkspace(t, seyi, "seyi-linear", { kind: "personal" });
  return { seyi, personal };
}

async function connect(t: TestConvex, w: { seyi: Id<"users">; personal: Id<"workspaces"> }) {
  const { token } = await issue(t, w.personal, w.seyi);
  const started = await asUser(t, w.seyi).action(api.functions.connections.startProviderConnect, { token });
  const state = new URL(started.authorizeUrl).searchParams.get("state")!;
  const done = await asUser(t, w.seyi).action(api.functions.connections.completeProviderConnect, {
    provider: "linear",
    state,
    code: "code-1",
    completionSecret: started.completionSecret,
  });
  await t.finishAllScheduledFunctions(() => {}, 20);
  return { started, done };
}

function call(t: TestConvex, w: { seyi: Id<"users">; personal: Id<"workspaces"> }, method: string, args: Record<string, unknown>, clientId = "context_texts") {
  return t.action(internal.functions.connectionApps.callApp, {
    provider: "linear",
    workspaceId: w.personal,
    actorUserId: w.seyi,
    clientId,
    method,
    args,
  });
}

describe("connecting an app through its MCP server", () => {
  test("discovery and registration need no keys of ours; consent carries PKCE, the resource and our callback", async () => {
    const t = setupTest();
    const seen = stubLinear();
    const w = await world(t);
    const { token } = await issue(t, w.personal, w.seyi);
    const started = await asUser(t, w.seyi).action(api.functions.connections.startProviderConnect, { token });
    const url = new URL(started.authorizeUrl);
    expect(url.origin + url.pathname).toBe("https://mcp.linear.app/authorize");
    expect(url.searchParams.get("client_id")).toBe("dcr-client-1");
    expect(url.searchParams.get("redirect_uri")).toBe(`${APP}/connect/linear`);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(url.searchParams.get("resource")).toBe(SERVER);
    const registration = seen.find((s) => s.url === "https://mcp.linear.app/register")!;
    expect(JSON.parse(registration.body)).toMatchObject({ redirect_uris: [`${APP}/connect/linear`], token_endpoint_auth_method: "none" });

    // A second person's start reuses the one registration.
    await asUser(t, w.seyi).action(api.functions.connections.startProviderConnect, { token: (await issue(t, w.personal, w.seyi)).token });
    expect(seen.filter((s) => s.url === "https://mcp.linear.app/register")).toHaveLength(1);
  });

  test("the public action only schedules the exchange, and the page sees it land", async () => {
    const t = setupTest();
    const seen = stubLinear();
    const w = await world(t);
    const { done } = await connect(t, w);
    expect(typeof done.pending).toBe("number");
    const exchange = seen.find((s) => s.url === "https://mcp.linear.app/token")!;
    const form = new URLSearchParams(exchange.body);
    expect(form.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(form.get("resource")).toBe(SERVER);
    const state = await asUser(t, w.seyi).query(api.functions.connections.connectionState, { provider: "linear", since: done.pending! });
    expect(state).toBe("connected");
    // Sealed at rest: the token never sits in the row as itself.
    const rows = await t.run((ctx) => ctx.db.query("providerConnections").collect());
    expect(JSON.stringify(rows)).not.toContain(ACCESS);
    expect(JSON.stringify(rows)).not.toContain(REFRESH);
  });

  /** Sabotage: drop the `hashedCompletion` check in `sealAttemptVerifier`. */
  test("a callback without the starting browser's secret is refused", async () => {
    const t = setupTest();
    stubLinear();
    const w = await world(t);
    const { token } = await issue(t, w.personal, w.seyi);
    const started = await asUser(t, w.seyi).action(api.functions.connections.startProviderConnect, { token });
    const state = new URL(started.authorizeUrl).searchParams.get("state")!;
    const error = await captureError(() =>
      asUser(t, w.seyi).action(api.functions.connections.completeProviderConnect, {
        provider: "linear",
        state,
        code: "code-1",
        completionSecret: "not-the-secret-not-the-secret-0000",
      }),
    );
    expect(error).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.query("providerConnections").collect())).toHaveLength(0);
  });
});

describe("calling a connected app", () => {
  /** Sabotage: let `callApp` run a tool that is not marked read-only without `change`. */
  test("a read runs; a tool not marked read-only, or not marked at all, needs a change", async () => {
    const t = setupTest();
    stubLinear();
    const w = await world(t);
    await connect(t, w);
    expect(await call(t, w, "tools.call", { name: "list_issues", arguments: {} })).toMatchObject({ ok: true, body: { content: [{ text: "ran list_issues" }] } });
    expect(await call(t, w, "tools.call", { name: "create_issue", arguments: {} })).toEqual({ ok: false, refused: "needs_yes" });
    expect(await call(t, w, "tools.call", { name: "unmarked", arguments: {} })).toEqual({ ok: false, refused: "needs_yes" });
    expect(await call(t, w, "tools.call", { name: "create_issue", arguments: {}, change: true })).toMatchObject({ ok: true });
    expect(await call(t, w, "tools.call", { name: "nope", arguments: {} })).toEqual({ ok: false, refused: "unknown_tool" });
    expect(await call(t, w, "resources.read", {})).toEqual({ ok: false, refused: "method_not_allowed" });
  });

  test("a group chat never reaches the person's own connection", async () => {
    const t = setupTest();
    stubLinear();
    const w = await world(t);
    await connect(t, w);
    expect(await call(t, w, "tools.list", {}, "context_texts_group")).toEqual({ ok: false, refused: "not_connected" });
  });

  test("a token the app stops honouring is refreshed once and the call retried", async () => {
    const t = setupTest();
    const seen = stubLinear({ expiredToken: ACCESS });
    const w = await world(t);
    await connect(t, w);
    expect(await call(t, w, "tools.list", {})).toMatchObject({ ok: true });
    expect(seen.some((s) => s.url === "https://mcp.linear.app/token" && s.body.includes("grant_type=refresh_token"))).toBe(true);
    expect(seen.filter((s) => s.url === SERVER).at(-1)!.auth).toBe(`Bearer ${REFRESHED}`);
  });

  test("the catalog names every app and the person's state in each, and a group chat can use none", async () => {
    const t = setupTest();
    stubLinear();
    const w = await world(t);
    await connect(t, w);
    const apps = await t.query(internal.functions.connectionApps.appsForPerson, { workspaceId: w.personal, actorUserId: w.seyi, clientId: "context_texts" });
    expect(apps.find((a) => a.app === "linear")).toMatchObject({ state: "connected", via: "mcp" });
    expect(apps.find((a) => a.app === "planning-center")).toMatchObject({ state: "not_connected" });
    const group = await t.query(internal.functions.connectionApps.appsForPerson, { workspaceId: w.personal, actorUserId: w.seyi, clientId: "context_texts_group" });
    expect(group.every((a) => a.state === "not_available")).toBe(true);
  });
});
