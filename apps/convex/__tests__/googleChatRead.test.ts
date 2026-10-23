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
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { createWorkspace, gatewayPost, seedGoogleConnection, seedStorageBinding } from "./fixtures.helpers";
import { encryptSecret, requireKeyset } from "../functions/lib/crypto";
import { ACCESS_A, ACCESS_B, bodyOf, twoConnectedTenants } from "./controlPlane/fixtures.helpers";
import { CHAT_READ_SCOPE, CHAT_SEND_SCOPES, TESTER_WRITE_SCOPES } from "../functions/lib/googleOAuth";
import { CHAT_READ_HOURLY_LIMIT } from "../functions/googleChatSend";

const realFetch = globalThis.fetch;
const ME = "users/111";
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

const MESSAGES: Record<string, unknown[]> = {
  "spaces/DM1": [
    { name: "spaces/DM1/messages/m2", sender: { name: ME, type: "HUMAN" }, createTime: "2026-10-23T12:01:00Z", text: "on it" },
    { name: "spaces/DM1/messages/m1", sender: { name: "users/222", type: "HUMAN", displayName: "Amy" }, createTime: "2026-10-23T12:00:00Z", text: "Any luck on the venue search?" },
  ],
  "spaces/AAA": [
    { name: "spaces/AAA/messages/a2", sender: { name: "users/333", type: "HUMAN" }, createTime: "2026-10-23T11:00:00Z", text: "lunch?" },
    {
      name: "spaces/AAA/messages/a1",
      sender: { name: "users/333", type: "HUMAN" },
      createTime: "2026-10-23T10:30:00Z",
      text: "@Alice can you confirm the date?",
      annotations: [{ type: "USER_MENTION", userMention: { user: { name: ME }, type: "MENTION" } }],
    },
    { name: "spaces/AAA/messages/a0", sender: { name: "users/999", type: "BOT" }, createTime: "2026-10-23T10:20:00Z", text: "build passed" },
  ],
};

function chatApi() {
  const calls: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!url.startsWith("https://chat.googleapis.com/")) return await realFetch(input, init);
    calls.push(url);
    const { pathname } = new URL(url);
    if (pathname === "/v1/spaces") return Response.json({ spaces: SPACES });
    if (pathname.includes("/members/")) return Response.json({ name: "spaces/DM1/members/111", member: { name: ME, type: "HUMAN" } });
    const space = pathname.slice(4).replace(/\/messages$/, "");
    return Response.json({ messages: MESSAGES[space] ?? [] });
  });
  return calls;
}

type Tenants = Awaited<ReturnType<typeof twoConnectedTenants>>;

async function connected({ read = true } = {}) {
  const tenants = await twoConnectedTenants();
  const id = await seedGoogleConnection(tenants.t, { workspaceId: tenants.aliceWs, boundBy: tenants.alice, address: "alice@work.example" });
  const encryptedAccessToken = await encryptSecret("ya29.fake-access-token", requireKeyset(), { workspaceId: tenants.aliceWs });
  const gmail = "https://www.googleapis.com/auth/gmail.readonly";
  await tenants.t.run((ctx) =>
    ctx.db.patch(id, {
      products: ["gmail"],
      scopes: read ? [gmail, ...CHAT_SEND_SCOPES, CHAT_READ_SCOPE] : [gmail, ...CHAT_SEND_SCOPES],
      encryptedAccessToken,
      accessTokenExpiresAt: Date.now() + 60 * 60 * 1000,
    }),
  );
  return tenants;
}

async function recent(t: Tenants["t"], accessToken: string, workspaceId: string) {
  return await bodyOf(await gatewayPost(t, "/gateway/chat/recent", { accessToken, expectedWorkspaceId: workspaceId, since: SINCE }));
}

describe("reading the Google Chat written to the person, for check-ins", () => {
  test("only what others wrote to them: their DMs, and mentions of them in spaces, newest first", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-23T13:00:00Z"));
    try {
      const calls = chatApi();
      const { t, aliceWs } = await connected();
      const answer = (await recent(t, ACCESS_A, aliceWs)) as { ok: boolean; messages: Array<Record<string, string>> };
      expect(answer.ok).toBe(true);
      expect(answer.messages.map((message) => message.id)).toEqual(["spaces/DM1/messages/m1", "spaces/AAA/messages/a1"]);
      expect(answer.messages[0]).toMatchObject({ type: "DIRECT_MESSAGE", from: "Amy", text: "Any luck on the venue search?" });
      expect(answer.messages[1]).toMatchObject({ space: "Venue planning", type: "SPACE" });
      // The quiet space was never read, and the read asked only for messages after `since`.
      expect(calls.some((url) => url.includes("spaces/OLD"))).toBe(false);
      const read = calls.find((url) => url.includes("spaces/AAA/messages"))!;
      expect(new URL(read).searchParams.get("filter")).toBe('createTime > "2026-10-23T10:00:00.000Z"');
      expect(calls.find((url) => url.includes("/members/"))).toContain("members/alice%40work.example");
    } finally {
      vi.useRealTimers();
    }
  });

  test("an account that never granted Chat reading reads nothing", async () => {
    const calls = chatApi();
    const { t, aliceWs } = await connected({ read: false });
    expect(await recent(t, ACCESS_A, aliceWs)).toEqual({ ok: false, refused: "no_chat" });
    expect(calls).toHaveLength(0);
  });

  test("another tenant's token, or a grant on a shared workspace, never reaches it", async () => {
    const calls = chatApi();
    const { t, alice, aliceWs } = await connected();
    expect(await recent(t, ACCESS_B, aliceWs)).toEqual({ ok: false, refused: "not_allowed" });
    const shared = await createWorkspace(t, alice, "alfa-team", { kind: "shared" });
    await seedStorageBinding(t, { workspaceId: shared, boundBy: alice, bucket: "tenant-a-team" });
    expect(await recent(t, ACCESS_A, shared)).toEqual({ ok: false, refused: "not_allowed" });
    expect(calls).toHaveLength(0);
  });

  test("an hour holds a bounded number of reads", async () => {
    chatApi();
    const { t, aliceWs } = await connected();
    for (let i = 0; i < CHAT_READ_HOURLY_LIMIT; i++) expect(((await recent(t, ACCESS_A, aliceWs)) as { ok: boolean }).ok).toBe(true);
    expect(await recent(t, ACCESS_A, aliceWs)).toEqual({ ok: false, refused: "hourly_limit" });
  });

  test("reading is asked of testers with the Gmail connect, never of anyone else", () => {
    expect(TESTER_WRITE_SCOPES.gmail).toContain(CHAT_READ_SCOPE);
  });
});
