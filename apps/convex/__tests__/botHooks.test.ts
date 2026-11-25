import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { addMember, asUser, captureError, createUser, createWorkspace, gatewayPost, setupTest } from "./fixtures.helpers";
import { signHook } from "@context/shared/src/botHooks.cjs";
import { registerClient, seedConnectedClient, token } from "./controlPlane/fixtures.helpers";

/**
 * A bot's webhook (`functions/botHooks.ts`): sealed where nobody reads it
 * back, replaced only by whoever set it or an owner, called signed, and
 * never sent to a private address or with the message itself.
 */

const KEY = `ctxbot_${"ab".repeat(32)}`;
const HOOK = "https://bot.example.com/context?token=s3cret-path";

type Seen = { url: string; headers: Headers; body: string };

/** DNS answers public for every host but `inside.example.com`; the bot answers `status`. */
function stubNet(status = 200, opts: { privateHost?: string } = {}) {
  const seen: Seen[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("https://cloudflare-dns.com/")) {
        const name = new URL(url).searchParams.get("name");
        const type = new URL(url).searchParams.get("type");
        if (type === "AAAA") return Response.json({ Answer: [] });
        return Response.json({ Answer: [{ name, type: 1, data: name === opts.privateHost ? "10.0.0.7" : "93.184.216.34" }] });
      }
      seen.push({ url, headers: new Headers(init?.headers), body: String(init?.body ?? "") });
      return new Response("ok", { status });
    }),
  );
  return seen;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function world() {
  const t = setupTest();
  const seyi = await createUser(t, "seyi@example.invalid");
  const ana = await createUser(t, "ana@example.invalid");
  const kim = await createUser(t, "kim@example.invalid");
  const outsider = await createUser(t, "out@example.invalid");
  const supa = await createWorkspace(t, seyi, "supa-bots", { kind: "shared" });
  await addMember(t, supa, ana, "editor");
  await addMember(t, supa, kim, "member");
  return { t, seyi, ana, kim, outsider, supa };
}

describe("a bot's webhook", () => {
  test("saved sealed: the list shows the host and the header's end, never the address or a secret", async () => {
    stubNet();
    const { t, ana, kim, supa } = await world();
    await asUser(t, ana).action(api.functions.botHooks.setBotHook, {
      workspaceId: supa,
      bot: "Finance",
      address: HOOK,
      headerLine: "Authorization: Bearer grok-abc-1234",
      signingKey: KEY,
    });
    const rows = await t.run((ctx) => ctx.db.query("botHooks").collect());
    expect(rows).toHaveLength(1);
    const stored = JSON.stringify(rows);
    for (const secret of ["s3cret-path", "grok-abc", KEY]) expect(stored).not.toContain(secret);
    const listed = await asUser(t, kim).query(api.functions.botHooks.botHookList, { workspaceId: supa });
    expect(listed).toEqual([expect.objectContaining({ bot: "finance", host: "bot.example.com", headerEnds: "1234", canReplace: false })]);
    expect(JSON.stringify(listed)).not.toMatch(/s3cret|grok-abc|ctxbot_/);
  });

  test("only an owner or editor sets one, and only the setter or an owner replaces it", async () => {
    stubNet();
    const { t, seyi, ana, kim, outsider, supa } = await world();
    const set = (who: typeof seyi, address = HOOK) =>
      asUser(t, who).action(api.functions.botHooks.setBotHook, { workspaceId: supa, bot: "finance", address, signingKey: KEY });
    expect(await captureError(() => set(kim))).not.toBeNull();
    expect(await captureError(() => set(outsider))).not.toBeNull();
    await set(seyi);
    expect(await captureError(() => set(ana, "https://evil.example.com/hook"))).not.toBeNull();
    await set(seyi, "https://bot2.example.com/hook");
    expect((await asUser(t, seyi).query(api.functions.botHooks.botHookList, { workspaceId: supa }))[0]!.host).toBe("bot2.example.com");
    expect(await asUser(t, outsider).query(api.functions.botHooks.botHookList, { workspaceId: supa })).toEqual([]);
  });

  test("a private, plain-http or odd address is refused before anything is saved", async () => {
    stubNet(200, { privateHost: "inside.example.com" });
    const { t, ana, supa } = await world();
    for (const address of ["http://bot.example.com/x", "https://10.0.0.1/x", "https://localhost/x", "https://inside.example.com/x", "https://bot.example.com:8443/x"]) {
      const error = await captureError(() => asUser(t, ana).action(api.functions.botHooks.setBotHook, { workspaceId: supa, bot: "finance", address, signingKey: KEY }));
      expect(error, address).not.toBeNull();
    }
    for (const headerLine of ["Host: evil.example.com", "x-context-signature: v1=00", "not a header"]) {
      const error = await captureError(() => asUser(t, ana).action(api.functions.botHooks.setBotHook, { workspaceId: supa, bot: "finance", address: HOOK, headerLine, signingKey: KEY }));
      expect(error, headerLine).not.toBeNull();
    }
    expect(await captureError(() => asUser(t, ana).action(api.functions.botHooks.setBotHook, { workspaceId: supa, bot: "finance", address: HOOK, signingKey: "short" }))).not.toBeNull();
    expect(await t.run((ctx) => ctx.db.query("botHooks").collect())).toHaveLength(0);
  });

  /** Sabotage: drop the signature header or sign another string, and the check here fails. */
  test("mail the workspace noticed is a signed call that says where and who, never the message", async () => {
    const seen = stubNet();
    const { t, ana, supa } = await world();
    await asUser(t, ana).action(api.functions.botHooks.setBotHook, {
      workspaceId: supa, bot: "Finance", address: HOOK, headerLine: "Authorization: Bearer grok-abc-1234", signingKey: KEY,
    });
    const mail = { workspaceId: supa, bot: "finance", area: "areas/finance", note: "areas/finance/mail/kim.md", from: "@kim" };
    const response = await gatewayPost(t, "/gateway/bots/mail", mail);
    expect(await response.json()).toEqual({ ok: true, status: 200 });
    expect(seen).toHaveLength(1);
    const call = seen[0]!;
    expect(call.url).toBe(HOOK);
    expect(call.headers.get("authorization")).toBe("Bearer grok-abc-1234");
    const at = call.headers.get("x-context-timestamp")!;
    expect(call.headers.get("x-context-signature")).toBe(`v1=${await signHook(KEY, at, call.body)}`);
    const body = JSON.parse(call.body);
    expect(Object.keys(body).sort()).toEqual(["area", "at", "bot", "from", "note", "type", "workspace"]);
    expect(body).toMatchObject({ type: "mail", workspace: "@supa-bots", bot: "finance", from: "@kim", area: "areas/finance", note: "areas/finance/mail/kim.md" });
    const audit = await t.run((ctx) => ctx.db.query("auditEvents").collect());
    expect(audit.some((event) => event.action === "bot_hook.called")).toBe(true);
    expect(JSON.stringify(audit)).not.toContain("s3cret-path");
  });

  test("the mail door needs the gateway's secret, a bot with a webhook, and a path in that area's mail", async () => {
    const seen = stubNet();
    const { t, ana, supa } = await world();
    await asUser(t, ana).action(api.functions.botHooks.setBotHook, { workspaceId: supa, bot: "finance", address: HOOK, signingKey: KEY });
    const mail = { workspaceId: supa, bot: "finance", area: "areas/finance", note: "areas/finance/mail/kim.md", from: "@kim" };
    expect((await gatewayPost(t, "/gateway/bots/mail", mail, { secret: "wrong-secret-0000000000" })).status).toBe(401);
    for (const odd of [{ bot: "payroll" }, { note: "areas/other/mail/kim.md" }, { note: "areas/finance/budget.md" }, { workspaceId: "nope" }]) {
      expect(await (await gatewayPost(t, "/gateway/bots/mail", { ...mail, ...odd })).json(), JSON.stringify(odd)).toEqual({ ok: false, status: 0 });
    }
    expect(seen).toHaveLength(0);
  });

  test("a bot that fails is retried once and its status shown; an outsider's test reaches nobody", async () => {
    const seen = stubNet(503);
    const { t, ana, outsider, supa } = await world();
    await asUser(t, ana).action(api.functions.botHooks.setBotHook, { workspaceId: supa, bot: "finance", address: HOOK, signingKey: KEY });
    expect(await asUser(t, ana).action(api.functions.botHooks.testBotHook, { workspaceId: supa, bot: "finance" })).toEqual({ ok: false, status: 503 });
    expect(seen).toHaveLength(2);
    expect((await asUser(t, ana).query(api.functions.botHooks.botHookList, { workspaceId: supa }))[0]).toMatchObject({ lastCallOk: false, lastCallStatus: 503 });
    expect(await asUser(t, outsider).action(api.functions.botHooks.testBotHook, { workspaceId: supa, bot: "finance" })).toEqual({ ok: false, status: 0 });
    expect(seen).toHaveLength(2);
  });

  test("a member may not send a test", async () => {
    const seen = stubNet();
    const { t, ana, kim, supa } = await world();
    await asUser(t, ana).action(api.functions.botHooks.setBotHook, { workspaceId: supa, bot: "finance", address: HOOK, signingKey: KEY });
    expect(await asUser(t, kim).action(api.functions.botHooks.testBotHook, { workspaceId: supa, bot: "finance" })).toEqual({ ok: false, status: 0 });
    expect(seen).toHaveLength(0);
  });

  /** `manage area` from an AI client or Tex: both proofs, an editor's grant, and never a secret in the answer. */
  test("the agents' door sets, lists and tests a webhook for an editor's grant, and answers no secret", async () => {
    const seen = stubNet();
    const { t, ana, kim, supa } = await world();
    await registerClient(t, "mcp_client_bots");
    const ANA = token("bots_ana");
    const KIM = token("bots_kim");
    await seedConnectedClient(t, { workspaceId: supa, userId: ana, clientId: "mcp_client_bots", accessToken: ANA });
    await seedConnectedClient(t, { workspaceId: supa, userId: kim, clientId: "mcp_client_bots", accessToken: KIM });
    const door = async (accessToken: string, body: Record<string, unknown>, secret?: string) =>
      await gatewayPost(t, "/gateway/bots/hook", { accessToken, expectedWorkspaceId: String(supa), ...body }, secret === undefined ? {} : { secret });
    const set = { action: "set", bot: "Finance", address: HOOK, header: "Authorization: Bearer grok-abc-1234" };

    expect((await door(ANA, set, "wrong-secret-0000000000")).status).toBe(401);
    expect(await (await door(KIM, set)).json()).toEqual({ error: expect.stringContaining("owner or editor") });
    expect(await (await door(token("bots_nobody"), set)).json()).toEqual({ error: expect.any(String) });
    expect(await t.run((ctx) => ctx.db.query("botHooks").collect())).toHaveLength(0);

    const saved = await (await door(ANA, set)).json();
    expect(saved).toEqual({ host: "bot.example.com", headerEnds: "1234", keyMade: true });
    const listed = await (await door(ANA, { action: "list" })).json();
    expect(listed.hooks).toEqual([expect.objectContaining({ bot: "finance", host: "bot.example.com" })]);
    for (const bot of ["Finance", "Pipeline"]) {
      expect(await (await door(ANA, { action: "set", bot, address: "https://10.0.0.1/x" })).json(), bot).toEqual({ error: expect.any(String) });
    }
    expect(await t.run((ctx) => ctx.db.query("botHooks").collect())).toEqual([expect.objectContaining({ host: "bot.example.com" })]);
    expect(await (await door(ANA, { action: "test", bot: "Finance" })).json()).toEqual({ ok: true, status: 200 });
    expect(seen).toHaveLength(1);
    const body = JSON.parse(seen[0]!.body);
    expect(body).toMatchObject({ type: "test", bot: "finance", workspace: "@supa-bots" });

    const answers = JSON.stringify([saved, listed]);
    expect(answers).not.toMatch(/s3cret|grok-abc|ctxbot_/);
    // The key Context made is sealed like one typed in the app: the call is signed with something.
    expect(seen[0]!.headers.get("x-context-signature")).toMatch(/^v1=[0-9a-f]{64}$/);
  });

  test("a bot hands over its header from its shell: one ticket, once, for the webhook it names, as the person who minted it", async () => {
    // The owner, 2026-11-25: a Grok bot holds its secret in an environment variable and may not see it.
    const seen = stubNet();
    const { t, ana, kim, supa } = await world();
    await registerClient(t, "mcp_client_bots");
    const ANA = token("bots_ana2");
    const KIM = token("bots_kim2");
    await seedConnectedClient(t, { workspaceId: supa, userId: ana, clientId: "mcp_client_bots", accessToken: ANA });
    await seedConnectedClient(t, { workspaceId: supa, userId: kim, clientId: "mcp_client_bots", accessToken: KIM });
    const door = async (accessToken: string, body: Record<string, unknown>) =>
      await (await gatewayPost(t, "/gateway/bots/hook", { accessToken, expectedWorkspaceId: String(supa), ...body })).json();
    const spend = async (body: Record<string, unknown>, secret?: string) =>
      await gatewayPost(t, "/gateway/bots/hook-ticket", body, secret === undefined ? {} : { secret });
    const ask = { action: "ticket", bot: "Pipeline", address: HOOK, headerName: "Authorization" };

    // A member can't mint one; a bad address or header name is refused before any ticket exists.
    expect(await door(KIM, ask)).toEqual({ error: expect.stringContaining("owner or editor") });
    expect(await door(ANA, { ...ask, address: "http://bot.example.com/x" })).toEqual({ error: expect.any(String) });
    expect(await door(ANA, { ...ask, headerName: "Authorization: Bearer x" })).toEqual({ error: expect.any(String) });
    expect(await t.run((ctx) => ctx.db.query("botHookTickets").collect())).toHaveLength(0);

    const minted = await door(ANA, ask);
    expect(minted).toEqual({ ticket: expect.stringMatching(/^[A-Za-z0-9_-]{16,256}$/), minutes: 10 });
    // Only its hash is kept.
    expect(JSON.stringify(await t.run((ctx) => ctx.db.query("botHookTickets").collect()))).not.toContain(minted.ticket);

    expect((await spend({ ticket: minted.ticket, value: "Bearer grok-secret-fbb2" }, "wrong-secret-0000000000")).status).toBe(401);
    expect(await (await spend({ ticket: "not-a-ticket-at-all-0000", value: "Bearer x" })).json()).toEqual({ error: expect.any(String) });
    const saved = await (await spend({ ticket: minted.ticket, value: "Bearer grok-secret-fbb2" })).json();
    expect(saved).toEqual({ host: "bot.example.com", headerEnds: "fbb2" });
    // Once only.
    expect(await (await spend({ ticket: minted.ticket, value: "Bearer other" })).json()).toEqual({ error: expect.stringContaining("already used") });
    const [row] = await t.run((ctx) => ctx.db.query("botHooks").collect());
    expect(row).toMatchObject({ bot: "pipeline", host: "bot.example.com", headerEnds: "fbb2", setBy: ana });
    expect(JSON.stringify(row)).not.toContain("grok-secret");

    // The header goes on the call, and the call is signed with a key nobody saw.
    expect(await door(ANA, { action: "test", bot: "Pipeline" })).toEqual({ ok: true, status: 200 });
    expect(seen.at(-1)!.headers.get("authorization")).toBe("Bearer grok-secret-fbb2");
    expect(seen.at(-1)!.headers.get("x-context-signature")).toMatch(/^v1=[0-9a-f]{64}$/);

    // A ticket whose grant was revoked spends nothing, nor one whose person lost the role.
    const revoked = await door(ANA, ask);
    const grants = await t.run((ctx) => ctx.db.query("oauthGrants").collect());
    await t.run(async (ctx) => {
      for (const grant of grants.filter((each) => each.userId === ana)) await ctx.db.patch(grant._id, { status: "revoked" });
    });
    expect(await (await spend({ ticket: revoked.ticket, value: "Bearer revoked" })).json()).toEqual({ error: expect.any(String) });
    await t.run(async (ctx) => {
      for (const grant of grants.filter((each) => each.userId === ana)) await ctx.db.patch(grant._id, { status: "active" });
    });
    const again = await door(ANA, ask);
    await t.run(async (ctx) => {
      const member = await ctx.db.query("workspaceMembers").withIndex("by_workspace_user", (q) => q.eq("workspaceId", supa).eq("userId", ana)).unique();
      await ctx.db.patch(member!._id, { role: "member" });
    });
    expect(await (await spend({ ticket: again.ticket, value: "Bearer later" })).json()).toEqual({ error: expect.any(String) });
    expect((await t.run((ctx) => ctx.db.query("botHooks").collect()))[0]).toMatchObject({ headerEnds: "fbb2" });
  });
});
