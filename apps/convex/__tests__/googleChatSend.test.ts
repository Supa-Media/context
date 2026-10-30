/**
 * A Google Chat message a person's AI sends goes from that person's own
 * Google account, only one that granted every Chat send scope, to exactly the
 * person or space named, and the limits hold whatever the gateway asks
 * (`functions/lib/gatewayRoutes/googleChat.ts`).
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. Dropping the scope check in `claimChatSend`. → "an account that never
 *     granted Chat sending sends nothing" fails.
 *  2. Taking the first of several same-named spaces. → "a space name two
 *     spaces share sends to neither" fails.
 *  3. Spending on a check. → "a check sends nothing and spends nothing; an
 *     hour holds ten" fails.
 *  4. Answering ok on any 2xx from messages.create, name or none. → "a send
 *     Google does not confirm is never called sent" fails.
 *  5. Taking any space spaces.setup answers. → "a first direct message goes
 *     only into the direct message Google made" fails.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { createWorkspace, gatewayPost, seedGoogleConnection, seedStorageBinding } from "./fixtures.helpers";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { ACCESS_A, ACCESS_B, bodyOf, twoConnectedTenants } from "./controlPlane/fixtures.helpers";
import { CHAT_SEND_HOURLY_LIMIT, CHAT_SEND_SCOPES, chatFailure, readChatMessage } from "../functions/lib/googleChatSend";
import { agentScopesFor } from "../functions/lib/googleConnect/aiScopes";

const realFetch = globalThis.fetch;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

type Space = { name: string; displayName?: string; spaceType: string };

/** Google Chat, answered here. `dm` is the direct message findDirectMessage finds (null: none yet). Each request, recorded. */
function chatApi({
  dm = "spaces/DM1" as string | null,
  spaces = [] as Space[],
  status = 200,
  setup = { name: "spaces/NEWDM", spaceType: "DIRECT_MESSAGE" } as Record<string, unknown>,
  created = undefined as ((space: string) => unknown) | undefined,
} = {}) {
  const calls: Array<{ method: string; url: string; auth: string | null; body: unknown }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://chat.googleapis.com/")) return await realFetch(input, init);
    const method = init?.method ?? "GET";
    calls.push({ method, url, auth: new Headers(init?.headers).get("Authorization"), body: init?.body ? JSON.parse(String(init.body)) : null });
    const path = new URL(url).pathname;
    if (path === "/v1/spaces:findDirectMessage") {
      return dm ? Response.json({ name: dm, spaceType: "DIRECT_MESSAGE" }) : Response.json({ error: { code: 404, status: "NOT_FOUND" } }, { status: 404 });
    }
    if (path === "/v1/spaces:setup") return Response.json(setup);
    if (path === "/v1/spaces" && method === "GET") return Response.json({ spaces });
    if (path.endsWith("/messages")) {
      const space = path.slice(4, -"/messages".length);
      if (status !== 200) return Response.json({ error: { code: status } }, { status });
      return Response.json(created ? created(space) : { name: `${space}/messages/m1` });
    }
    const found = spaces.find((space) => `/v1/${space.name}` === path);
    return found ? Response.json(found) : Response.json({ error: { code: 404 } }, { status: 404 });
  });
  return calls;
}

type Tenants = Awaited<ReturnType<typeof twoConnectedTenants>>;

async function connectChat(t: Tenants["t"], workspaceId: Tenants["aliceWs"], boundBy: Tenants["alice"], { send = true } = {}) {
  const id = await seedGoogleConnection(t, { workspaceId, boundBy, address: "alice@work.example" });
  const encryptedAccessToken = await encryptSecret("ya29.fake-access-token", requireKeyset(), { workspaceId });
  const read = "https://www.googleapis.com/auth/gmail.readonly";
  await t.run((ctx) =>
    ctx.db.patch(id, {
      products: ["gmail"],
      scopes: send ? [read, ...CHAT_SEND_SCOPES] : [read],
      encryptedAccessToken,
      accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
    }),
  );
}

async function connected(options: { send?: boolean } = {}) {
  const tenants = await twoConnectedTenants();
  await connectChat(tenants.t, tenants.aliceWs, tenants.alice, options);
  return tenants;
}

const DM = { to: "Jo@Example.com", text: "Hi Jo, running five minutes late." };
const SPACE = { space: "Portal team", text: "Shipping tonight." };

async function send(t: Tenants["t"], accessToken: string, workspaceId: string, message: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return await bodyOf(await gatewayPost(t, "/gateway/chat/send", { accessToken, expectedWorkspaceId: workspaceId, message, ...extra }));
}

const posts = (calls: ReturnType<typeof chatApi>) => calls.filter((call) => call.method === "POST" && call.url.endsWith("/messages"));

describe("sending a Google Chat message as the person", () => {
  test("a direct message goes to the one person named, from their own account, nothing of it kept", async () => {
    const calls = chatApi();
    const { t, aliceWs } = await connected();
    expect(await send(t, ACCESS_A, aliceWs, DM)).toEqual({
      ok: true,
      from: "alice@work.example",
      place: { person: "jo@example.com" },
      space: "spaces/DM1",
      message: "spaces/DM1/messages/m1",
      started: false,
    });
    expect(calls[0]!.url).toBe("https://chat.googleapis.com/v1/spaces:findDirectMessage?name=users%2Fjo%40example.com");
    expect(posts(calls)).toHaveLength(1);
    expect(posts(calls)[0]!.url).toBe("https://chat.googleapis.com/v1/spaces/DM1/messages");
    expect(posts(calls)[0]!.auth).toBe("Bearer ya29.fake-access-token");
    expect(posts(calls)[0]!.body).toEqual({ text: DM.text });
    const kept = JSON.stringify(await t.run(async (ctx) => ({ limits: await ctx.db.query("rateLimits").collect(), audit: await ctx.db.query("auditEvents").collect() })));
    expect(kept).not.toContain("running five minutes");
    expect(kept).not.toContain("jo@example.com");
    expect(kept).toContain('"to":"person"');
  });

  test("with no direct message yet, sending starts one; a check does not", async () => {
    const calls = chatApi({ dm: null });
    const { t, aliceWs } = await connected();
    expect(await send(t, ACCESS_A, aliceWs, DM, { check: true })).toEqual({ ok: true, from: "alice@work.example", place: { person: "jo@example.com" } });
    expect(calls.some((call) => call.url.includes("spaces:setup"))).toBe(false);
    expect(await send(t, ACCESS_A, aliceWs, DM)).toMatchObject({ ok: true, space: "spaces/NEWDM", message: "spaces/NEWDM/messages/m1", started: true });
    const setup = calls.find((call) => call.url.endsWith("/v1/spaces:setup"))!;
    expect(setup.body).toEqual({ space: { spaceType: "DIRECT_MESSAGE" }, memberships: [{ member: { name: "users/jo@example.com", type: "HUMAN" } }] });
    expect(posts(calls)[0]!.url).toBe("https://chat.googleapis.com/v1/spaces/NEWDM/messages");
  });

  test("a space is found by its name in Chat and named as Chat names it", async () => {
    const calls = chatApi({ spaces: [{ name: "spaces/AAA", displayName: "Portal Team", spaceType: "SPACE" }, { name: "spaces/BBB", displayName: "Other", spaceType: "SPACE" }] });
    const { t, aliceWs } = await connected();
    expect(await send(t, ACCESS_A, aliceWs, { ...SPACE, space: "portal team" })).toEqual({
      ok: true,
      from: "alice@work.example",
      place: { space: "Portal Team" },
      space: "spaces/AAA",
      message: "spaces/AAA/messages/m1",
      started: false,
    });
    expect(posts(calls)[0]!.url).toBe("https://chat.googleapis.com/v1/spaces/AAA/messages");
  });

  test("a space name two spaces share sends to neither; one nobody has is not found", async () => {
    const twin = { displayName: "Portal team", spaceType: "SPACE" };
    const calls = chatApi({ spaces: [{ name: "spaces/AAA", ...twin }, { name: "spaces/BBB", ...twin }] });
    const { t, aliceWs } = await connected();
    expect(await send(t, ACCESS_A, aliceWs, SPACE)).toEqual({ ok: false, refused: "ambiguous" });
    expect(await send(t, ACCESS_A, aliceWs, { ...SPACE, space: "Nope" })).toEqual({ ok: false, refused: "space_not_found" });
    expect(posts(calls)).toHaveLength(0);
    const limits = await t.run((ctx) => ctx.db.query("rateLimits").collect());
    expect(limits.filter((row) => row.key.startsWith("chat_send."))).toHaveLength(0);
  });

  test("an account that never granted Chat sending sends nothing", async () => {
    const calls = chatApi();
    const { t, aliceWs } = await connected({ send: false });
    expect(await send(t, ACCESS_A, aliceWs, DM)).toEqual({ ok: false, refused: "no_chat" });
    expect(await send(t, ACCESS_A, aliceWs, DM, { check: true })).toEqual({ ok: false, refused: "no_chat" });
    expect(calls).toHaveLength(0);
  });

  test("another tenant's token, or a grant on a shared workspace, never reaches it", async () => {
    const calls = chatApi();
    const { t, alice, aliceWs } = await connected();
    expect(await send(t, ACCESS_B, aliceWs, DM)).toEqual({ ok: false, refused: "not_allowed" });
    const shared = await createWorkspace(t, alice, "alfa-team", { kind: "shared" });
    await seedStorageBinding(t, { workspaceId: shared, boundBy: alice, bucket: "tenant-a-team" });
    expect(await send(t, ACCESS_A, shared, DM)).toEqual({ ok: false, refused: "not_allowed" });
    expect(await bodyOf(await gatewayPost(t, "/gateway/chat/spaces", { accessToken: ACCESS_B, expectedWorkspaceId: aliceWs }))).toEqual({ ok: false, refused: "not_allowed" });
    expect(calls).toHaveLength(0);
  });

  test("a check sends nothing and spends nothing; an hour holds ten", async () => {
    const calls = chatApi();
    const { t, aliceWs } = await connected();
    for (let i = 0; i < CHAT_SEND_HOURLY_LIMIT + 2; i++) expect((await send(t, ACCESS_A, aliceWs, DM, { check: true })).ok).toBe(true);
    expect(posts(calls)).toHaveLength(0);
    for (let i = 0; i < CHAT_SEND_HOURLY_LIMIT; i++) expect((await send(t, ACCESS_A, aliceWs, DM)).ok).toBe(true);
    expect(await send(t, ACCESS_A, aliceWs, DM)).toEqual({ ok: false, refused: "hourly_limit" });
    expect(posts(calls)).toHaveLength(CHAT_SEND_HOURLY_LIMIT);
  });

  test("a Google failure is reported, not called done", async () => {
    chatApi({ status: 500 });
    const { t, aliceWs } = await connected();
    expect(await send(t, ACCESS_A, aliceWs, DM)).toEqual({ ok: false, refused: "unavailable" });
  });

  test("a send Google does not confirm is never called sent", async () => {
    // A 2xx with no message, or one naming another conversation, says nothing about where these words went.
    for (const created of [() => ({}), () => ({ name: "spaces/OTHER/messages/m1" }), (space: string) => ({ name: space })]) {
      chatApi({ created });
      const { t, aliceWs } = await connected();
      expect(await send(t, ACCESS_A, aliceWs, DM)).toEqual({ ok: false, refused: "unconfirmed" });
    }
  });

  test("a first direct message goes only into the direct message Google made", async () => {
    for (const setup of [{ name: "spaces/GROUP", spaceType: "SPACE" }, { spaceType: "DIRECT_MESSAGE" }, { name: "not-a-space", spaceType: "DIRECT_MESSAGE" }]) {
      const calls = chatApi({ dm: null, setup });
      const { t, aliceWs } = await connected();
      expect((await send(t, ACCESS_A, aliceWs, DM)).ok).toBe(false);
      expect(posts(calls)).toHaveLength(0);
    }
  });

  test("their spaces are listed by name, direct messages marked as such", async () => {
    chatApi({ spaces: [{ name: "spaces/AAA", displayName: "Portal team", spaceType: "SPACE" }, { name: "spaces/DM1", spaceType: "DIRECT_MESSAGE" }] });
    const { t, aliceWs } = await connected();
    expect(await bodyOf(await gatewayPost(t, "/gateway/chat/spaces", { accessToken: ACCESS_A, expectedWorkspaceId: aliceWs }))).toEqual({
      ok: true,
      from: "alice@work.example",
      spaces: [
        { name: "spaces/AAA", displayName: "Portal team", type: "SPACE" },
        { name: "spaces/DM1", displayName: "", type: "DIRECT_MESSAGE" },
      ],
    });
  });
});

describe("what a message may be, and who is asked for it", () => {
  test("one person or one space, and words with no hidden controls", () => {
    expect(readChatMessage(DM)).toEqual({ to: "jo@example.com", space: null, text: DM.text });
    expect(readChatMessage(SPACE)).not.toBeNull();
    expect(readChatMessage({ ...DM, space: "Portal" })).toBeNull();
    expect(readChatMessage({ text: "hi" })).toBeNull();
    expect(readChatMessage({ to: "Jo <jo@example.com>", text: "hi" })).toBeNull();
    expect(readChatMessage({ ...DM, text: "a \u202e b" })).toBeNull();
    expect(readChatMessage({ ...DM, text: " " })).toBeNull();
    expect(readChatMessage({ ...SPACE, space: "a\nb" })).toBeNull();
  });

  test("a Chat API that is off in the project is the deployment's to fix", () => {
    expect(chatFailure(403, { error: { status: "PERMISSION_DENIED", details: [{ reason: "SERVICE_DISABLED" }] } })).toBe("chat_not_enabled");
    expect(chatFailure(404, { error: { message: "Google Chat app not found. To create a Chat app, you must turn on the Chat API" } })).toBe("chat_not_enabled");
    expect(chatFailure(401, null)).toBe("reconnect_required");
  });

  test("AI is asked for Chat sending with Chat, starting a direct message included, and never with Gmail or Calendar alone", () => {
    // `chat.spaces.create` is what `spaces.setup` takes: the first message to somebody new.
    expect(agentScopesFor(["chat"])).toEqual(expect.arrayContaining([...CHAT_SEND_SCOPES]));
    expect(agentScopesFor(["gmail"]).some((scope) => scope.includes("/chat."))).toBe(false);
    expect(agentScopesFor(["calendar"]).some((scope) => scope.includes("/chat."))).toBe(false);
  });
});
