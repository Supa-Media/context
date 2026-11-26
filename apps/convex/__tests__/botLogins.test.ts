import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { addMember, asUser, createUser, createWorkspace, gatewayPost, setupTest } from "./fixtures.helpers";
import { registerClient, seedConnectedClient, token } from "./controlPlane/fixtures.helpers";
import { BOT_CHECK_MS, healthOf } from "../functions/botLogins";

/**
 * A bot's login bound to its card (`functions/botLogins.ts`; Dev, 2026-11-26: "bind the bot's connector login to its
 * bot card" and "marks the connection healthy only when the reply comes from the bot's own identity within a few
 * minutes"). The binding is its own row by grant, never on the grant (an access row a person's object takes first);
 * the connection asks which bot it is, and only that grant marks the bot answering.
 *
 * Sabotage: letting `answered` move health for any grant failed "only the bound login marks its bot answering";
 * writing the binding on the grant again failed "binds when the person's connections live in their object".
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

  test("an owner's or editor's own connection binds as a bot, and asks which bot it is", async () => {
    const { t, supa, GROK, KIM, door } = await world();
    expect(await door(KIM, { action: "bind", bot: "Grok Bot", name: "Grok Bot" })).toEqual({ error: expect.stringContaining("owner or editor") });
    expect(await door(GROK, { action: "bound" })).toEqual({ bot: null });
    expect(await door(GROK, { action: "bind", bot: "Grok Bot", name: "Grok Bot" })).toEqual({ ok: true, workspaceId: supa, bot: "grok-bot" });
    expect(await door(GROK, { action: "bound" })).toEqual({ bot: "grok-bot", name: "Grok Bot" });
    expect(await door(KIM, { action: "bound" })).toEqual({ bot: null });
    // Binding again keeps one row for the workspace.
    await door(GROK, { action: "bind", bot: "Grok Bot", name: "Grok" });
    expect(await door(GROK, { action: "bound" })).toEqual({ bot: "grok-bot", name: "Grok" });
    expect(await t.run((ctx) => ctx.db.query("botLogins").collect())).toHaveLength(1);
  });

  test("binds when the person's connections live in their object", async () => {
    // Production, 2026-11-26: every bot's bind came back "the control plane could not be reached", because the binding
    // was patched onto the grant, which a person whose connections are in their object refuses here.
    const { t, seyi, supa, GROK, door } = await world();
    const personal = await createWorkspace(t, seyi, "seyi-logins-home");
    await t.run(async (ctx) => {
      await ctx.db.insert("workspaceObjectHomes", { workspaceId: personal, home: "bucket", since: 0, access: "object", personAccess: "object" });
    });
    expect(await door(GROK, { action: "bind", bot: "Grok Bot", name: "Grok Bot" })).toEqual({ ok: true, workspaceId: supa, bot: "grok-bot" });
    expect(await door(GROK, { action: "bound" })).toEqual({ bot: "grok-bot", name: "Grok Bot" });
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
