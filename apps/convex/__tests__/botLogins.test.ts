import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { addMember, asUser, createUser, createWorkspace, gatewayPost, setupTest } from "./fixtures.helpers";
import { registerClient, seedConnectedClient, token } from "./controlPlane/fixtures.helpers";
import { BOT_CHECK_MS, healthOf } from "../functions/botLogins";

/**
 * A bot's login bound to its card (`functions/botLogins.ts`; Dev, 2026-11-26: "bind the bot's connector login to its
 * bot card" and "marks the connection healthy only when the reply comes from the bot's own identity within a few
 * minutes"). The binding lives on the grant and comes back on every session; only that grant marks the bot answering.
 *
 * Sabotage: letting `answered` move health for any grant failed "only the bound login marks its bot answering".
 */

afterEach(() => {
  vi.useRealTimers();
});

async function world() {
  const t = setupTest();
  const seyi = await createUser(t, "seyi@example.invalid");
  const kim = await createUser(t, "kim@example.invalid");
  const ana = await createUser(t, "ana@example.invalid");
  const supa = await createWorkspace(t, seyi, "supa-logins", { kind: "shared" });
  await addMember(t, supa, kim, "member");
  await addMember(t, supa, ana, "editor");
  await registerClient(t, "mcp_client_cursor");
  const GROK = token("grok_login");
  const KIM = token("kim_login");
  const ANA = token("ana_login");
  await seedConnectedClient(t, { workspaceId: supa, userId: seyi, clientId: "mcp_client_cursor", accessToken: GROK });
  await seedConnectedClient(t, { workspaceId: supa, userId: kim, clientId: "mcp_client_cursor", accessToken: KIM });
  await seedConnectedClient(t, { workspaceId: supa, userId: ana, clientId: "mcp_client_cursor", accessToken: ANA });
  const door = async (accessToken: string, body: Record<string, unknown>) =>
    await (await gatewayPost(t, "/gateway/bots/hook", { accessToken, expectedWorkspaceId: String(supa), ...body })).json();
  return { t, seyi, supa, GROK, KIM, ANA, door };
}

describe("a bot's login", () => {
  test("health: checking, then not answering after the window, answering once an answer comes after the check", () => {
    expect(healthOf(null, 0)).toBeNull();
    expect(healthOf({ checkSentAt: 1000 }, 1000 + BOT_CHECK_MS - 1)).toBe("checking");
    expect(healthOf({ checkSentAt: 1000 }, 1000 + BOT_CHECK_MS)).toBe("not answering");
    expect(healthOf({ checkSentAt: 1000, answeredAt: 999 }, 1000 + BOT_CHECK_MS)).toBe("not answering");
    expect(healthOf({ checkSentAt: 1000, answeredAt: 1500 }, 1000 + BOT_CHECK_MS * 10)).toBe("answering");
  });

  test("an owner's or editor's own connection binds as a bot, and every session says so", async () => {
    const { t, supa, GROK, KIM, door } = await world();
    expect(await door(KIM, { action: "bind", bot: "Grok Bot", name: "Grok Bot" })).toEqual({ error: expect.stringContaining("owner or editor") });
    expect(await door(GROK, { action: "bind", bot: "Grok Bot", name: "Grok Bot" })).toEqual({ ok: true, workspaceId: supa, bot: "grok-bot" });
    const session = await (await gatewayPost(t, "/gateway/session", { accessToken: GROK })).json();
    expect(session.session.bots).toEqual([{ workspaceId: supa, bot: "grok-bot", name: "Grok Bot" }]);
    const other = await (await gatewayPost(t, "/gateway/session", { accessToken: KIM })).json();
    expect(other.session.bots).toBeUndefined();
    // Binding again keeps one entry for the workspace.
    await door(GROK, { action: "bind", bot: "Grok Bot", name: "Grok" });
    const again = await (await gatewayPost(t, "/gateway/session", { accessToken: GROK })).json();
    expect(again.session.bots).toEqual([{ workspaceId: supa, bot: "grok-bot", name: "Grok" }]);
  });

  test("only the bound login marks its bot answering", async () => {
    const { t, supa, seyi, GROK, ANA, door } = await world();
    await door(GROK, { action: "bind", bot: "Grok Bot", name: "Grok Bot" });
    const health = async () => (await t.run((ctx) => ctx.db.query("botHealth").collect()))[0]!;
    expect((await health()).answeredAt).toBeUndefined();
    await door(ANA, { action: "answered" });
    expect((await health()).answeredAt).toBeUndefined();
    await door(GROK, { action: "answered" });
    const row = await health();
    expect(healthOf(row, Date.now())).toBe("answering");
    // The webhook list carries it, for the app's bot page.
    await t.run(async (ctx) => {
      await ctx.db.insert("botHooks", { workspaceId: supa, bot: "grok-bot", host: "bot.example.com", encryptedUrl: "x", encryptedSigningKey: "x", setBy: seyi, setAt: 1 });
    });
    const listed = await asUser(t, seyi).query(api.functions.botHooks.botHookList, { workspaceId: supa });
    expect(listed[0]).toMatchObject({ bot: "grok-bot", health: "answering" });
  });
});
