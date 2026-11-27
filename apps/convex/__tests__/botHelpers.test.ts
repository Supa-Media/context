/**
 * A bot's helpers (`functions/botHelpers.ts`, `lib/controlPlane/helperGrants.ts`): a bot's own grant starts one, the
 * ticket is spent once into a token of its own, the token acts as the bot's grant shown as "<name> via <bot>", and it
 * ends with the helper, with its time, or with the bot's grant. Every value here is fake.
 *
 * ## Sabotage record
 *
 * Reading the parent as active whatever its status in `resolveHelperGrant` failed "revoking the bot's grant ends its
 * helpers".
 */

import { describe, expect, test } from "vitest";
import { internal } from "../_generated/api";
import { hashToken } from "../functions/lib/crypto";
import { createUser, createWorkspace, gatewayPost, seedGrant, setupTest, addMember, type TestConvex } from "./fixtures.helpers";

const BOT_TOKEN = `cat_${"g".repeat(40)}`;
const HOUR = 60 * 60 * 1000;
const FIELDS = { helperId: "hlp_0123456789abcdef", bot: "grok-bot", botName: "Grok Bot", name: "Claude", mail: "grok-bot-claude-0123", note: "bots/grok-bot/helpers/2026-11-27-fix-search.md" };

async function json(response: Response): Promise<Record<string, unknown>> {
  return JSON.parse(await response.text()) as Record<string, unknown>;
}

async function aBot(role: "owner" | "editor" | "member" = "owner") {
  const t = setupTest();
  const seyi = await createUser(t, "seyi@example.invalid");
  const supa = await createWorkspace(t, seyi, "supa", { kind: "shared" });
  let person = seyi;
  if (role !== "owner") {
    person = await createUser(t, "kim@example.invalid");
    await addMember(t, supa, person, role);
  }
  const grantId = await seedGrant(t, supa, person, "grok-client", await hashToken(`${BOT_TOKEN}-refresh`), Date.now() + HOUR);
  await t.run(async (ctx) => {
    await ctx.db.insert("oauthClients", { clientId: "grok-client", clientName: "Cursor", redirectUris: [], hashedClientSecret: null, tokenEndpointAuthMethod: "none", grantTypes: [], responseTypes: [], createdAt: Date.now() });
    await ctx.db.patch(grantId, { hashedAccessToken: await hashToken(BOT_TOKEN), scopes: ["context:read", "context:write"] });
  });
  return { t, supa, grantId };
}

async function start(t: TestConvex, supa: string, body: Record<string, unknown> = {}) {
  return await json(await gatewayPost(t, "/gateway/bots/helper/start", { accessToken: BOT_TOKEN, expectedWorkspaceId: supa, ...FIELDS, ...body }));
}

async function claim(t: TestConvex, ticket: unknown) {
  return await json(await gatewayPost(t, "/gateway/bots/helper/claim", { ticket }));
}

async function sessionFor(t: TestConvex, accessToken: string) {
  return await t.query(internal.functions.controlPlane.resolveGrantByAccessToken, { hashedAccessToken: await hashToken(accessToken) });
}

describe("a bot's helpers", () => {
  test("a bot's grant starts a helper; its ticket is spent once into a token that acts as the bot, shown as its helper", async () => {
    const { t, supa, grantId } = await aBot();
    const started = await start(t, supa);
    expect(started.ticket).toEqual(expect.any(String));
    const claimed = await claim(t, started.ticket);
    expect(claimed.accessToken).toMatch(/^cxh_/);
    expect(await claim(t, started.ticket)).toMatchObject({ error: expect.stringMatching(/already used/) });
    const rows = await t.run((ctx) => ctx.db.query("botHelpers").collect());
    expect(JSON.stringify(rows)).not.toContain(claimed.accessToken as string);
    expect(JSON.stringify(rows)).not.toContain(started.ticket as string);
    const session = await sessionFor(t, claimed.accessToken as string);
    expect(session).toMatchObject({ grantId, clientName: "Claude via Grok Bot", helper: { ...FIELDS, workspaceId: supa } });
  });

  test("a helper's token clears as no editor, so it starts no helper and sets no webhook", async () => {
    const { t, supa } = await aBot();
    const claimed = await claim(t, (await start(t, supa)).ticket);
    const nested = await json(await gatewayPost(t, "/gateway/bots/helper/start", { accessToken: claimed.accessToken, expectedWorkspaceId: supa, ...FIELDS, helperId: "hlp_fedcba9876543210" }));
    expect(nested).toMatchObject({ error: expect.any(String) });
    const hook = await json(await gatewayPost(t, "/gateway/bots/hook", { accessToken: claimed.accessToken, expectedWorkspaceId: supa, action: "list" }));
    expect(hook).toMatchObject({ error: expect.any(String) });
  });

  test("only an owner's or an editor's bot starts helpers", async () => {
    const { t, supa } = await aBot("member");
    expect(await start(t, supa)).toMatchObject({ error: expect.any(String) });
    expect(await t.run((ctx) => ctx.db.query("botHelpers").collect())).toEqual([]);
  });

  test("revoking the bot's grant ends its helpers, and an unspent ticket starts nothing", async () => {
    const { t, supa, grantId } = await aBot();
    const first = await claim(t, (await start(t, supa)).ticket);
    const unspent = await start(t, supa, { helperId: "hlp_1111111111111111", mail: "grok-bot-claude-1111" });
    await t.run((ctx) => ctx.db.patch(grantId, { status: "revoked" }));
    expect(await sessionFor(t, first.accessToken as string)).toBeNull();
    expect(await claim(t, unspent.ticket)).toMatchObject({ error: expect.any(String) });
  });

  test("a helper ends by its own token or its bot's, never by anyone else's", async () => {
    const { t, supa } = await aBot();
    const claimed = await claim(t, (await start(t, supa)).ticket);
    const stranger = await json(await gatewayPost(t, "/gateway/bots/helper/end", { accessToken: `cat_${"z".repeat(40)}`, helperId: FIELDS.helperId }));
    expect(stranger).toMatchObject({ error: expect.any(String) });
    const ended = await json(await gatewayPost(t, "/gateway/bots/helper/end", { accessToken: claimed.accessToken, helperId: FIELDS.helperId }));
    expect(ended).toMatchObject({ ended: true, note: FIELDS.note });
    expect(await sessionFor(t, claimed.accessToken as string)).toBeNull();
    const second = await claim(t, (await start(t, supa, { helperId: "hlp_2222222222222222" })).ticket);
    const byBot = await json(await gatewayPost(t, "/gateway/bots/helper/end", { accessToken: BOT_TOKEN, helperId: "hlp_2222222222222222" }));
    expect(byBot).toMatchObject({ ended: true });
    expect(await sessionFor(t, second.accessToken as string)).toBeNull();
  });

  test("a helper's time runs out, and the hourly sweep takes its row", async () => {
    const { t, supa } = await aBot();
    const claimed = await claim(t, (await start(t, supa, { hours: 1 })).ticket);
    await t.run(async (ctx) => {
      const row = (await ctx.db.query("botHelpers").collect())[0];
      await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
    });
    expect(await sessionFor(t, claimed.accessToken as string)).toBeNull();
    expect(await t.mutation(internal.functions.botHelpers.purgeExpiredBotHelpers, {})).toEqual({ deleted: 1 });
  });
});
