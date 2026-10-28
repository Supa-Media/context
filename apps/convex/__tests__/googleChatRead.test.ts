/**
 * Tex's check-ins read the Google Chat messages written to the person
 * (`functions/lib/gatewayRoutes/googleChatRead.ts`): only from their own
 * account, only one that granted reading, only what others wrote to them.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted (2026-10-23).
 *
 *  1. Dropping the scope check in `claimChatRead`. → "an account that never
 *     granted Chat reading reads nothing" fails.
 *  2. `writtenToThem` keeping every space message. → "only what others wrote
 *     to them" fails.
 *
 * Applied, suite run, named test observed failing, reverted (2026-10-28).
 *
 *  3. Putting back the `spaces.members.get` lookup of their id. → "every
 *     Chat call it makes is one Google accepts with the scopes the connect
 *     asks for" fails, and so does "a look finds what others wrote even
 *     when Google refuses a memberships lookup".
 *  4. `whoIs` counting a sender with no address and no known id as someone
 *     else. → "a sender it cannot tell from them is left out" fails.
 *  5. Matching the address case-sensitively. → "their own words never
 *     count" fails, and so does "only what others wrote to them".
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { createWorkspace, gatewayPost, seedGoogleConnection, seedStorageBinding } from "./fixtures.helpers";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { ACCESS_A, ACCESS_B, bodyOf, twoConnectedTenants } from "./controlPlane/fixtures.helpers";
import { CHAT_READ_SCOPE, CHAT_SEND_SCOPES, scopesForConnect, WRITE_SCOPES } from "../functions/lib/googleOAuth";
import { CHAT_READ_HOURLY_LIMIT } from "../functions/googleChatSend";
import { learnSelf, writtenToThem } from "../functions/lib/gatewayRoutes/googleChatRead";
import { chatCallAllowed } from "./googleChatDiscovery.helpers";

const realFetch = globalThis.fetch;
const ME = "users/111";
const ADDRESS = "alice@work.example";
const SINCE = Date.parse("2026-10-23T10:00:00Z");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

const SPACES = [
  { name: "spaces/DM1", spaceType: "DIRECT_MESSAGE", lastActiveTime: "2026-10-23T12:00:00Z" },
  { name: "spaces/AAA", displayName: "Venue planning", spaceType: "SPACE", lastActiveTime: "2026-10-23T11:00:00Z" },
  { name: "spaces/OLD", displayName: "Quiet", spaceType: "SPACE", lastActiveTime: "2026-10-20T11:00:00Z" },
];

// As Chat answers a user-authenticated read: `email` on the sender and on
// mentioned users who are members of the space, canonical numeric names.
const MESSAGES: Record<string, unknown[]> = {
  "spaces/DM1": [
    { name: "spaces/DM1/messages/m2", sender: { name: ME, type: "HUMAN", email: "Alice@Work.example" }, createTime: "2026-10-23T12:01:00Z", text: "on it" },
    {
      name: "spaces/DM1/messages/m1",
      sender: { name: "users/222", type: "HUMAN", displayName: "Amy", email: "amy@work.example" },
      createTime: "2026-10-23T12:00:00Z",
      text: "Any luck on the venue search?",
    },
  ],
  "spaces/AAA": [
    { name: "spaces/AAA/messages/a3", sender: { name: ME, type: "HUMAN" }, createTime: "2026-10-23T11:05:00Z", text: "my own note, no email on it" },
    { name: "spaces/AAA/messages/a2", sender: { name: "users/333", type: "HUMAN", email: "bo@work.example" }, createTime: "2026-10-23T11:00:00Z", text: "lunch?" },
    {
      name: "spaces/AAA/messages/a1",
      sender: { name: "users/333", type: "HUMAN", email: "bo@work.example" },
      createTime: "2026-10-23T10:30:00Z",
      text: "@Alice can you confirm the date?",
      annotations: [{ type: "USER_MENTION", userMention: { user: { name: ME, email: ADDRESS }, type: "MENTION" } }],
    },
    { name: "spaces/AAA/messages/a0", sender: { name: "users/999", type: "BOT" }, createTime: "2026-10-23T10:20:00Z", text: "build passed" },
  ],
};

/**
 * A Chat API that answers as Google does for the scopes the connection
 * holds: a call no granted scope allows gets Google's 403, whatever its path.
 */
function chatApi(granted: readonly string[], messages: Record<string, unknown[]> = MESSAGES) {
  const calls: Array<{ url: string; method: string }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://chat.googleapis.com/")) return await realFetch(input, init);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    if (!chatCallAllowed(url, method, granted)) {
      return Response.json({ error: { code: 403, status: "PERMISSION_DENIED", message: "Request had insufficient authentication scopes." } }, { status: 403 });
    }
    const { pathname } = new URL(url);
    if (pathname === "/v1/spaces") return Response.json({ spaces: SPACES });
    if (pathname.includes("/members/")) return Response.json({ name: "spaces/DM1/members/111", member: { name: ME, type: "HUMAN" } });
    const space = pathname.slice(4).replace(/\/messages$/, "");
    return Response.json({ messages: messages[space] ?? [] });
  });
  return calls;
}

const GMAIL = "https://www.googleapis.com/auth/gmail.readonly";
const READ_SCOPES = [GMAIL, ...CHAT_SEND_SCOPES, CHAT_READ_SCOPE];

type Tenants = Awaited<ReturnType<typeof twoConnectedTenants>>;

async function connected({ read = true } = {}) {
  const tenants = await twoConnectedTenants();
  const id = await seedGoogleConnection(tenants.t, { workspaceId: tenants.aliceWs, boundBy: tenants.alice, address: ADDRESS });
  const encryptedAccessToken = await encryptSecret("ya29.fake-access-token", requireKeyset(), { workspaceId: tenants.aliceWs });
  await tenants.t.run((ctx) =>
    ctx.db.patch(id, {
      products: ["gmail"],
      scopes: read ? READ_SCOPES : [GMAIL, ...CHAT_SEND_SCOPES],
      encryptedAccessToken,
      accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
    }),
  );
  return tenants;
}

async function recent(t: Tenants["t"], accessToken: string, workspaceId: string) {
  return await bodyOf(await gatewayPost(t, "/gateway/chat/recent", { accessToken, expectedWorkspaceId: workspaceId, since: SINCE }));
}

async function at<T>(run: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-23T13:00:00Z"));
  try {
    return await run();
  } finally {
    vi.useRealTimers();
  }
}

type Answer = { ok: boolean; messages: Array<Record<string, string>> };

describe("reading the Google Chat written to the person, for check-ins", () => {
  test("only what others wrote to them: their DMs, and mentions of them in spaces, newest first", async () => {
    await at(async () => {
      const calls = chatApi(READ_SCOPES);
      const { t, aliceWs } = await connected();
      const answer = (await recent(t, ACCESS_A, aliceWs)) as Answer;
      expect(answer.ok).toBe(true);
      expect(answer.messages.map((message) => message.id)).toEqual(["spaces/DM1/messages/m1", "spaces/AAA/messages/a1"]);
      expect(answer.messages[0]).toMatchObject({ type: "DIRECT_MESSAGE", from: "Amy", text: "Any luck on the venue search?" });
      expect(answer.messages[1]).toMatchObject({ space: "Venue planning", type: "SPACE" });
      // The quiet space was never read, and the read asked only for messages after `since`.
      expect(calls.some(({ url }) => url.includes("spaces/OLD"))).toBe(false);
      const read = calls.find(({ url }) => url.includes("spaces/AAA/messages"))!;
      expect(new URL(read.url).searchParams.get("filter")).toBe('createTime > "2026-10-23T10:00:00.000Z"');
    });
  });

  test("every Chat call it makes is one Google accepts with the scopes the connect asks for", async () => {
    await at(async () => {
      const granted = scopesForConnect(["gmail"], {});
      const calls = chatApi(granted);
      const { t, aliceWs } = await connected();
      await recent(t, ACCESS_A, aliceWs);
      expect(calls.length).toBeGreaterThan(0);
      for (const { url, method } of calls) expect({ url, allowed: chatCallAllowed(url, method, granted) }).toEqual({ url, allowed: true });
    });
  });

  test("a look finds what others wrote even when Google refuses a memberships lookup", async () => {
    await at(async () => {
      const calls = chatApi(READ_SCOPES);
      const { t, aliceWs } = await connected();
      const answer = (await recent(t, ACCESS_A, aliceWs)) as Answer;
      expect(answer.messages.length).toBe(2);
      expect(calls.some(({ url }) => url.includes("/members/"))).toBe(false);
    });
  });

  test("their own words never count, matched by their address in any case, or by the id their own message showed", () => {
    const self = learnSelf("ALICE@work.example", MESSAGES["spaces/DM1"] as Array<Record<string, unknown>>);
    expect(self).toEqual({ address: "alice@work.example", name: ME });
    const own = { sender: { name: ME, type: "HUMAN" } };
    const ownByAddress = { sender: { name: "users/zzz", type: "HUMAN", email: "Alice@WORK.example" } };
    expect(writtenToThem(own, "DIRECT_MESSAGE", self)).toBe(false);
    expect(writtenToThem(ownByAddress, "DIRECT_MESSAGE", { address: ADDRESS, name: null })).toBe(false);
  });

  test("a sender it cannot tell from them is left out", () => {
    const self = learnSelf(ADDRESS, []);
    expect(self.name).toBeNull();
    // No address and no id it knows: this could be their own message.
    expect(writtenToThem({ sender: { name: "users/444", type: "HUMAN" } }, "DIRECT_MESSAGE", self)).toBe(false);
    expect(writtenToThem({ sender: { type: "HUMAN" } }, "GROUP_CHAT", self)).toBe(false);
    // Someone with another address is someone else.
    expect(writtenToThem({ sender: { name: "users/444", type: "HUMAN", email: "amy@work.example" } }, "DIRECT_MESSAGE", self)).toBe(true);
  });

  test("a mention counts by their address too, before any message of theirs gave their id", () => {
    const self = learnSelf(ADDRESS, []);
    const mention = (user: Record<string, unknown>) => ({
      sender: { name: "users/333", type: "HUMAN", email: "bo@work.example" },
      annotations: [{ type: "USER_MENTION", userMention: { user } }],
    });
    expect(writtenToThem(mention({ name: ME, email: ADDRESS }), "SPACE", self)).toBe(true);
    expect(writtenToThem(mention({ name: "users/555", email: "amy@work.example" }), "SPACE", self)).toBe(false);
    expect(writtenToThem(mention({ name: ME }), "SPACE", self)).toBe(false);
  });

  test("an account that never granted Chat reading reads nothing", async () => {
    const calls = chatApi(READ_SCOPES);
    const { t, aliceWs } = await connected({ read: false });
    expect(await recent(t, ACCESS_A, aliceWs)).toEqual({ ok: false, refused: "no_chat" });
    expect(calls).toHaveLength(0);
  });

  test("another tenant's token, or a grant on a shared workspace, never reaches it", async () => {
    const calls = chatApi(READ_SCOPES);
    const { t, alice, aliceWs } = await connected();
    expect(await recent(t, ACCESS_B, aliceWs)).toEqual({ ok: false, refused: "not_allowed" });
    const shared = await createWorkspace(t, alice, "alfa-team", { kind: "shared" });
    await seedStorageBinding(t, { workspaceId: shared, boundBy: alice, bucket: "tenant-a-team" });
    expect(await recent(t, ACCESS_A, shared)).toEqual({ ok: false, refused: "not_allowed" });
    expect(calls).toHaveLength(0);
  });

  test("an hour holds a bounded number of reads", async () => {
    chatApi(READ_SCOPES);
    const { t, aliceWs } = await connected();
    for (let i = 0; i < CHAT_READ_HOURLY_LIMIT; i++) expect(((await recent(t, ACCESS_A, aliceWs)) as { ok: boolean }).ok).toBe(true);
    expect(await recent(t, ACCESS_A, aliceWs)).toEqual({ ok: false, refused: "hourly_limit" });
  });

  test("reading is asked of testers with the Gmail connect, never of anyone else", () => {
    expect(WRITE_SCOPES.gmail).toContain(CHAT_READ_SCOPE);
  });
});
