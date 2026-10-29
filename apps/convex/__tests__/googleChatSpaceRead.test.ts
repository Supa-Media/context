/**
 * The person's own AI reads one Google Chat conversation they named
 * (`functions/lib/gatewayRoutes/googleChatSpaceRead.ts`): only the one named,
 * only from their own account, only for the owner of their personal
 * workspace with private access, and never by starting a conversation.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted (2026-10-29).
 *
 *  1. `claimChatSpaceRead` clearing with `ownAccountClearance` (a send's).
 *     → "a grant without private access reads nothing" fails.
 *  2. Dropping the `canReadProduct` check. → "an account whose AI grant does
 *     not read Chat reads nothing" fails.
 *  3. `conversationOf` taking any text for a space. → "only a conversation
 *     named exactly" fails, and so does "an invalid conversation is refused
 *     before anything is asked of Google".
 *  4. Dropping the cap on how many are asked for. → "the page asked of
 *     Google is never larger than the cap" fails.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { gatewayPost, seedGoogleConnection } from "./fixtures.helpers";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { ACCESS_A, ACCESS_B, bodyOf, twoConnectedTenants } from "./controlPlane/fixtures.helpers";
import { CHAT_READ_SCOPE, CHAT_SEND_SCOPES, scopesForConnect } from "../functions/lib/googleOAuth";
import { CHAT_SPACE_READ_HOURLY_LIMIT } from "../functions/googleChatSend";
import { MAX_SPACE_MESSAGES, conversationOf } from "../functions/lib/gatewayRoutes/googleChatSpaceRead";
import { chatCallAllowed } from "./googleChatDiscovery.helpers";

const realFetch = globalThis.fetch;
const ME = "users/111";
const ADDRESS = "alice@work.example";
const GMAIL = "https://www.googleapis.com/auth/gmail.readonly";
const READ_SCOPES = [GMAIL, ...CHAT_SEND_SCOPES, CHAT_READ_SCOPE];

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const MESSAGES: Record<string, unknown[]> = {
  "spaces/DM1": [
    { name: "spaces/DM1/messages/m2", sender: { name: ME, type: "HUMAN", email: "Alice@Work.example" }, createTime: "2026-10-23T12:01:00Z", text: "on it" },
    {
      name: "spaces/DM1/messages/m1",
      sender: { name: "users/222", type: "HUMAN", displayName: "Amy", email: "amy@work.example" },
      createTime: "2026-10-23T12:00:00Z",
      text: "Any luck on\nthe venue search?",
    },
  ],
  "spaces/AAA": [{ name: "spaces/AAA/messages/a1", sender: { name: "users/333", type: "HUMAN", displayName: "Bo" }, createTime: "2026-10-23T10:30:00Z", text: "lunch?" }],
};

function chatApi(granted: readonly string[]) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://chat.googleapis.com/")) return await realFetch(input, init);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (!chatCallAllowed(url, method, granted)) {
      return Response.json({ error: { code: 403, status: "PERMISSION_DENIED", message: "Request had insufficient authentication scopes." } }, { status: 403 });
    }
    const { pathname, searchParams } = new URL(url);
    if (pathname === "/v1/spaces:findDirectMessage") {
      return searchParams.get("name") === "users/amy@work.example"
        ? Response.json({ name: "spaces/DM1", spaceType: "DIRECT_MESSAGE" })
        : Response.json({ error: { code: 404, status: "NOT_FOUND" } }, { status: 404 });
    }
    if (pathname === "/v1/spaces/AAA") return Response.json({ name: "spaces/AAA", displayName: "Venue planning", spaceType: "SPACE" });
    if (pathname === "/v1/spaces/DM1") return Response.json({ name: "spaces/DM1", spaceType: "DIRECT_MESSAGE" });
    if (/^\/v1\/spaces\/[^/]+$/.test(pathname)) return Response.json({ error: { code: 404, status: "NOT_FOUND" } }, { status: 404 });
    const space = pathname.slice(4).replace(/\/messages$/, "");
    return Response.json({ messages: MESSAGES[space] ?? [] });
  });
  return calls;
}

type Tenants = Awaited<ReturnType<typeof twoConnectedTenants>>;

async function connected({ scopes = READ_SCOPES, privateAccess = true } = {}) {
  const tenants = await twoConnectedTenants();
  const id = await seedGoogleConnection(tenants.t, { workspaceId: tenants.aliceWs, boundBy: tenants.alice, address: ADDRESS });
  const encryptedAccessToken = await encryptSecret("ya29.fake-access-token", requireKeyset(), { workspaceId: tenants.aliceWs });
  await tenants.t.run(async (ctx) => {
    await ctx.db.patch(id, { products: ["gmail"], scopes, encryptedAccessToken, accessTokenExpiresAt: Date.now() + 60 * 60 * 1000 });
    if (privateAccess) await ctx.db.patch(tenants.grantA, { scopes: ["context:read", "context:write", "context:private"] });
  });
  return tenants;
}

async function read(t: Tenants["t"], accessToken: string, workspaceId: string, conversation: Record<string, unknown>) {
  return (await bodyOf(await gatewayPost(t, "/gateway/chat/recent", { accessToken, expectedWorkspaceId: workspaceId, ...conversation }))) as {
    ok: boolean;
    refused?: string;
    from?: string;
    place?: Record<string, string>;
    messages?: Array<Record<string, unknown>>;
  };
}

describe("reading one Google Chat conversation the person named", () => {
  test("a space by its id: its newest messages, oldest first, their own marked as theirs", async () => {
    const calls = chatApi(READ_SCOPES);
    const { t, aliceWs } = await connected();
    const answer = await read(t, ACCESS_A, aliceWs, { space: "spaces/AAA" });
    expect(answer).toMatchObject({ ok: true, from: ADDRESS, place: { space: "Venue planning" } });
    expect(answer.messages).toEqual([{ id: "spaces/AAA/messages/a1", from: "Bo", mine: false, at: "2026-10-23T10:30:00Z", text: "lunch?" }]);
    // One space looked at, never the list of every space.
    expect(calls.some(({ url }) => new URL(url).pathname === "/v1/spaces")).toBe(false);
  });

  test("the direct message with one person, by their email, both sides of it", async () => {
    chatApi(READ_SCOPES);
    const { t, aliceWs } = await connected();
    const answer = await read(t, ACCESS_A, aliceWs, { to: "Amy@work.example" });
    expect(answer).toMatchObject({ ok: true, place: { person: "amy@work.example" } });
    expect(answer.messages).toEqual([
      { id: "spaces/DM1/messages/m1", from: "Amy", mine: false, at: "2026-10-23T12:00:00Z", text: "Any luck on\nthe venue search?" },
      { id: "spaces/DM1/messages/m2", from: "you", mine: true, at: "2026-10-23T12:01:00Z", text: "on it" },
    ]);
  });

  test("a person with no direct message yet is not one to start", async () => {
    const calls = chatApi(READ_SCOPES);
    const { t, aliceWs } = await connected();
    const answer = await read(t, ACCESS_A, aliceWs, { to: "nobody@work.example" });
    expect(answer).toEqual({ ok: false, refused: "person_not_found" });
    expect(calls.every(({ method }) => method === "GET")).toBe(true);
  });

  test("a space they are not in, or none by that id, is not found", async () => {
    chatApi(READ_SCOPES);
    const { t, aliceWs } = await connected();
    expect(await read(t, ACCESS_A, aliceWs, { space: "spaces/ZZZ" })).toEqual({ ok: false, refused: "space_not_found" });
  });

  test("only a conversation named exactly: an id or one address, never a display name, never both", () => {
    expect(conversationOf({ space: "Venue planning" })).toBeNull();
    expect(conversationOf({ space: "spaces/AAA", to: "amy@work.example" })).toBeNull();
    expect(conversationOf({})).toBeNull();
    expect(conversationOf({ to: "not an address" })).toBeNull();
    expect(conversationOf({ space: "spaces/AAA/messages/a1" })).toBeNull();
    expect(conversationOf({ space: "spaces/AAA", limit: 10_000 })).toMatchObject({ limit: MAX_SPACE_MESSAGES });
    expect(conversationOf({ space: "spaces/AAA" })).toMatchObject({ limit: 20 });
  });

  test("the page asked of Google is never larger than the cap", async () => {
    const calls = chatApi(READ_SCOPES);
    const { t, aliceWs } = await connected();
    await read(t, ACCESS_A, aliceWs, { space: "spaces/AAA", limit: 500 });
    const listed = calls.find(({ url }) => url.includes("/messages"))!;
    expect(new URL(listed.url).searchParams.get("pageSize")).toBe(String(MAX_SPACE_MESSAGES));
  });

  test("every Chat call it makes is one Google accepts with the scopes the connect asks for", async () => {
    const granted = scopesForConnect(["gmail"], {});
    const calls = chatApi(granted);
    const { t, aliceWs } = await connected({ scopes: granted });
    expect((await read(t, ACCESS_A, aliceWs, { space: "spaces/AAA" })).ok).toBe(true);
    expect((await read(t, ACCESS_A, aliceWs, { to: "amy@work.example" })).ok).toBe(true);
    for (const { url, method } of calls) expect({ url, allowed: chatCallAllowed(url, method, granted) }).toEqual({ url, allowed: true });
  });

  test("a grant without private access reads nothing", async () => {
    const calls = chatApi(READ_SCOPES);
    const { t, aliceWs } = await connected({ privateAccess: false });
    expect(await read(t, ACCESS_A, aliceWs, { space: "spaces/AAA" })).toEqual({ ok: false, refused: "not_allowed" });
    expect(calls).toEqual([]);
  });

  test("another tenant's token never reaches the person's Chat", async () => {
    const calls = chatApi(READ_SCOPES);
    const { t, aliceWs, bobWs } = await connected();
    expect(await read(t, ACCESS_B, aliceWs, { space: "spaces/AAA" })).toEqual({ ok: false, refused: "not_allowed" });
    expect((await read(t, ACCESS_B, bobWs, { space: "spaces/AAA" })).ok).toBe(false);
    expect(calls).toEqual([]);
  });

  test("an account whose AI grant does not read Chat reads nothing", async () => {
    const calls = chatApi(READ_SCOPES);
    const { t, aliceWs } = await connected({ scopes: [GMAIL, ...CHAT_SEND_SCOPES] });
    expect(await read(t, ACCESS_A, aliceWs, { space: "spaces/AAA" })).toEqual({ ok: false, refused: "no_chat" });
    expect(calls).toEqual([]);
  });

  test("an invalid conversation is refused before anything is asked of Google", async () => {
    const calls = chatApi(READ_SCOPES);
    const { t, aliceWs } = await connected();
    expect(await read(t, ACCESS_A, aliceWs, { space: "Venue planning" })).toEqual({ ok: false, refused: "invalid" });
    expect(calls).toEqual([]);
  });

  test("reads stop at the hour's limit", async () => {
    chatApi(READ_SCOPES);
    const { t, aliceWs } = await connected();
    for (let i = 0; i < CHAT_SPACE_READ_HOURLY_LIMIT; i += 1) expect((await read(t, ACCESS_A, aliceWs, { space: "spaces/AAA" })).ok).toBe(true);
    expect(await read(t, ACCESS_A, aliceWs, { space: "spaces/AAA" })).toEqual({ ok: false, refused: "hourly_limit" });
  });
});
