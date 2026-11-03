/**
 * THE TEX PAGE'S ROUTES (`functions/texPage.ts`, `lib/gatewayRoutes/texPage.ts`).
 *
 * The Context app's Tex page makes one call to learn what its person may see and one to change a setting. The
 * person comes off the console's own live grant, never from the request, so the page shows that person's chats
 * and no one else's, and a settings call on a chat they are not in answers exactly as a missing chat does.
 *
 * Sabotage (run by hand, each must fail a test here):
 *  - take the person from the request body instead of the grant: "a body naming another person changes nothing" fails;
 *  - list every textGroups row instead of those whose homeUsers hold the person: "another person's chat is absent" fails;
 *  - accept any client's grant (drop the CONSOLE_CLIENT_ID check): "a grant from another client is refused" fails;
 *  - answer a chat the person is not in with its settings: "a chat not theirs answers as a missing one" fails;
 *  - write the instructions before the rate-limit check in a chat change: "a limited call changes neither setting" fails.
 */

import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { asUser, createUser, createWorkspace, gatewayPost, setupTest } from "./fixtures.helpers";
import { hashToken } from "../functions/lib/crypto";
import { groupName } from "../functions/texPage";

const ADA_CHAT = "ab".repeat(32);
const BO_CHAT = "cd".repeat(32);
const MISSING = "ef".repeat(32);

type T = ReturnType<typeof setupTest>;

const post = async (t: T, path: string, body: unknown) =>
  (await (await gatewayPost(t, path, body)).json()) as Record<string, unknown>;

/** Ada owns @ada's personal workspace, Bo owns @bo's, and each has a token from the console. */
async function world(t: T) {
  const adaId = await createUser(t, "ada@example.invalid");
  const boId = await createUser(t, "bo@example.invalid");
  const adaWorkspace = await createWorkspace(t, adaId, "ada", { kind: "personal" });
  await createWorkspace(t, boId, "bo", { kind: "personal" });
  const studio = await createWorkspace(t, adaId, "studio", { kind: "shared" });
  const adaToken = (await asUser(t, adaId).action(api.functions.agentGrant.mintConsoleGrant, { workspaceId: adaWorkspace })).accessToken;
  const boWorkspace = await t.run(async (ctx) => (await ctx.db.query("workspaces").withIndex("by_slug", (q) => q.eq("slug", "bo")).unique())!._id);
  const boToken = (await asUser(t, boId).action(api.functions.agentGrant.mintConsoleGrant, { workspaceId: boWorkspace })).accessToken;
  await t.run(async (ctx) => {
    await ctx.db.insert("textGroups", {
      groupKey: ADA_CHAT,
      homeWords: "team-night-owls",
      homeUsers: [adaId, boId],
      boundBy: adaId,
      engagement: "followAlong",
      lastSeenAt: 2_000,
    });
    await ctx.db.insert("textGroups", { groupKey: BO_CHAT, homeWords: "bo-only", homeUsers: [boId], lastSeenAt: 3_000 });
    const routine = {
      writerUserId: adaId,
      writerSource: "signal" as const,
      cadence: { unit: "day" as const, every: 1 },
      at: { hour: 8, minute: 30 },
      paused: false,
      send: "text" as const,
      to: [],
      nextRunAt: 5_000,
      updatedAt: 1_000,
    };
    await ctx.db.insert("routines", { ...routine, workspaceId: adaWorkspace, path: "tex/routines/daily/standup.md" });
    await ctx.db.insert("routines", { ...routine, workspaceId: adaWorkspace, path: "projects/not-a-tex-routine.md" });
    await ctx.db.insert("routines", { ...routine, workspaceId: studio, path: "routines/daily/chat.md", chat: ADA_CHAT.slice(0, 16) });
  });
  return { adaId, boId, adaWorkspace, adaToken, boToken };
}

describe("the Tex page's data", () => {
  test("the console grant sees its own person's chats and routines, and no one else's", async () => {
    const t = setupTest();
    const { adaToken } = await world(t);
    const page = await post(t, "/gateway/tex/page", { accessToken: adaToken });
    expect(page).toMatchObject({ status: "ok", handle: "ada" });
    const chats = page.chats as Array<Record<string, unknown>>;
    expect(chats.map((chat) => chat.key)).toEqual([ADA_CHAT]);
    expect(chats[0]).toMatchObject({
      name: "@bo",
      people: 2,
      peopleNames: ["You", "bo"],
      homeWords: "team-night-owls",
      muted: false,
      engagement: "followAlong",
      sponsor: "ada",
    });
    expect(chats[0]!.routines).toMatchObject([{ slug: "studio", path: "routines/daily/chat.md", unit: "day", every: 1, at: { hour: 8, minute: 30 } }]);
    // Only the two Tex roots, and never a routine of some other path.
    expect((page.routines as Array<{ path: string }>).map((routine) => routine.path).sort()).toEqual(["tex/routines/daily/standup.md"]);
  });

  test("another person's chat is absent, and their token shows theirs", async () => {
    const t = setupTest();
    const { boToken } = await world(t);
    const page = await post(t, "/gateway/tex/page", { accessToken: boToken });
    expect(page).toMatchObject({ status: "ok", handle: "bo" });
    expect(((page.chats as Array<{ key: string }>).map((chat) => chat.key)).sort()).toEqual([BO_CHAT, ADA_CHAT].sort());
  });

  test("a body that names another person changes nothing about whose page it is", async () => {
    const t = setupTest();
    const { adaToken, boId } = await world(t);
    const page = await post(t, "/gateway/tex/page", { accessToken: adaToken, userId: boId, workspaceId: "other" });
    expect(page).toMatchObject({ status: "ok", handle: "ada" });
  });

  test("a grant from another client, a dead grant and an unknown token are all refused alike", async () => {
    const t = setupTest();
    const { adaId, adaToken, adaWorkspace } = await world(t);
    const refused = { status: "refused" };
    expect(await post(t, "/gateway/tex/page", { accessToken: "cat_not_a_token" })).toEqual(refused);

    const otherToken = "cat_claude_client_token";
    await t.run(async (ctx) => {
      await ctx.db.insert("oauthClients", {
        clientId: "claude",
        clientName: "Claude",
        redirectUris: [],
        hashedClientSecret: null,
        tokenEndpointAuthMethod: "none",
        grantTypes: [],
        responseTypes: [],
        createdAt: Date.now(),
      });
      await ctx.db.insert("oauthGrants", {
        workspaceId: adaWorkspace,
        userId: adaId,
        clientId: "claude",
        scopes: ["context.read"],
        hashedRefreshToken: await hashToken("refresh_claude"),
        hashedAccessToken: await hashToken(otherToken),
        accessTokenExpiresAt: Date.now() + 60_000,
        status: "active",
        createdAt: Date.now(),
      });
    });
    expect(await post(t, "/gateway/tex/page", { accessToken: otherToken })).toEqual(refused);

    // The console's own grant, expired: the same token, now dead.
    const adaHash = await hashToken(adaToken);
    await t.run(async (ctx) => {
      const grant = (await ctx.db.query("oauthGrants").collect()).find((row) => row.hashedAccessToken === adaHash);
      await ctx.db.patch(grant!._id, { accessTokenExpiresAt: Date.now() - 1 });
    });
    expect(await post(t, "/gateway/tex/page", { accessToken: adaToken })).toEqual(refused);
  });

  test("the internal page query answers refused for a token it cannot resolve", async () => {
    const t = setupTest();
    await world(t);
    const answer = await t.query(internal.functions.texPage.pageFor, { hashedAccessToken: await hashToken("cat_nobody") });
    expect(answer).toEqual({ status: "refused" });
  });
});

describe("the Tex page's settings", () => {
  // Since 2026-11-01 the page edits the person's own words and adds quick picks (`lib/texInstructions.ts`), no dials.
  test("a person's own instructions are written and read back on the page, with the quick picks", async () => {
    const t = setupTest();
    const { adaToken } = await world(t);
    expect(await post(t, "/gateway/tex/page/settings", { accessToken: adaToken, chat: "me", values: { instructions: "Answer in French." } })).toEqual({ status: "done", instructions: "Answer in French." });
    const picked = await post(t, "/gateway/tex/page/settings", { accessToken: adaToken, chat: "me", values: { pick: "emoji_none" } });
    expect(picked).toEqual({ status: "done", instructions: "Answer in French.\nUse no emoji." });
    const page = await post(t, "/gateway/tex/page", { accessToken: adaToken });
    expect(page.instructions).toBe("Answer in French.\nUse no emoji.");
    expect(page.picks).toContainEqual({ id: "emoji_none", label: "No emoji" });
  });

  test("a chat's instructions and when Tex speaks up are written, and the page reads them back", async () => {
    const t = setupTest();
    const { adaToken } = await world(t);
    const written = await post(t, "/gateway/tex/page/settings", { accessToken: adaToken, chat: ADA_CHAT, values: { pick: "quirky", answers: "named" } });
    expect(written).toMatchObject({ status: "done", instructions: expect.stringMatching(/^Be quirky\./), engagement: "attentive" });
    const chat = ((await post(t, "/gateway/tex/page", { accessToken: adaToken })).chats as Array<Record<string, unknown>>)[0]!;
    expect(chat).toMatchObject({ instructions: expect.stringMatching(/^Be quirky\./), engagement: "attentive" });
    expect(await post(t, "/gateway/tex/page/settings", { accessToken: adaToken, chat: ADA_CHAT, values: { answers: "every" } })).toMatchObject({
      status: "done",
      engagement: "helpful",
    });
  });

  test("a chat the person is not in answers exactly as a missing key does", async () => {
    const t = setupTest();
    const { adaToken } = await world(t);
    const notMine = await post(t, "/gateway/tex/page/settings", { accessToken: adaToken, chat: BO_CHAT, values: { pick: "candid" } });
    const missing = await post(t, "/gateway/tex/page/settings", { accessToken: adaToken, chat: MISSING, values: { pick: "candid" } });
    expect(notMine).toEqual({ status: "not_found" });
    expect(notMine).toEqual(missing);
  });

  test("a pick nobody made, a dial, a text past the limit, and an unknown answer are refused whole", async () => {
    const t = setupTest();
    const { adaToken } = await world(t);
    const bad = { status: "bad_request" };
    expect(await post(t, "/gateway/tex/page/settings", { accessToken: adaToken, chat: "me", values: { pick: "snarky" } })).toEqual(bad);
    expect(await post(t, "/gateway/tex/page/settings", { accessToken: adaToken, chat: "me", values: { tone: "candid" } })).toEqual(bad);
    expect(await post(t, "/gateway/tex/page/settings", { accessToken: adaToken, chat: "me", values: { instructions: "x".repeat(1_501) } })).toEqual(bad);
    expect(await post(t, "/gateway/tex/page/settings", { accessToken: adaToken, chat: "me", values: { answers: "named" } })).toEqual(bad);
    expect(await post(t, "/gateway/tex/page/settings", { accessToken: adaToken, chat: ADA_CHAT, values: { answers: "loud" } })).toEqual(bad);
    expect(await post(t, "/gateway/tex/page/settings", { accessToken: adaToken, chat: "not-a-key", values: {} })).toEqual(bad);
    expect((await post(t, "/gateway/tex/page", { accessToken: adaToken })).instructions).toBeNull();
  });

  test("a limited chat change changes neither setting", async () => {
    const t = setupTest();
    const { adaToken } = await world(t);
    // The hourly budget for one chat's settings (`lib/texChatRules.ts`), spent in full.
    for (let i = 0; i < 120; i += 1) {
      const pick = i % 2 === 0 ? "candid" : "quirky";
      expect((await post(t, "/gateway/tex/page/settings", { accessToken: adaToken, chat: ADA_CHAT, values: { pick } })).status).toBe("done");
    }
    expect(await post(t, "/gateway/tex/page/settings", { accessToken: adaToken, chat: ADA_CHAT, values: { pick: "nerdy", answers: "every" } })).toEqual({
      status: "rate_limited",
    });
    const chat = ((await post(t, "/gateway/tex/page", { accessToken: adaToken })).chats as Array<Record<string, unknown>>)[0]!;
    expect(chat).toMatchObject({ engagement: "followAlong", instructions: expect.stringMatching(/^Be quirky\./) });
  });

  test("a dead or foreign grant changes nothing", async () => {
    const t = setupTest();
    await world(t);
    expect(await post(t, "/gateway/tex/page/settings", { accessToken: "cat_nobody", chat: "me", values: { pick: "candid" } })).toEqual({
      status: "refused",
    });
  });
});

describe("a group chat's name on the page", () => {
  test("is the people in it, never the chat home's random folder words", () => {
    expect(groupName(["You", "bo"])).toBe("@bo");
    expect(groupName(["You", "bo", "cy"])).toBe("@bo, @cy");
    expect(groupName(["You", "bo", "cy", "dee", "Someone"])).toBe("@bo, @cy +2");
    expect(groupName(["You"])).toBe("Group chat");
  });
});
