import { afterEach, describe, expect, test, vi } from "vitest";
import { api } from "../_generated/api";
import { addMember, asUser, captureError, createUser, createWorkspace, setupTest } from "./fixtures.helpers";
import { signHook } from "@context/shared/src/botHooks.cjs";

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
  test("a ping is signed, says where mail arrived and who wrote, and never carries the message", async () => {
    const seen = stubNet();
    const { t, ana, kim, supa } = await world();
    await asUser(t, ana).action(api.functions.botHooks.setBotHook, {
      workspaceId: supa, bot: "Finance", address: HOOK, headerLine: "Authorization: Bearer grok-abc-1234", signingKey: KEY,
    });
    const result = await asUser(t, kim).action(api.functions.botHooks.pingBot, {
      workspaceId: supa, bot: "Finance", area: "areas/finance", note: "areas/finance/mail/kim.md",
    });
    expect(result).toEqual({ ok: true, status: 200 });
    expect(seen).toHaveLength(1);
    const call = seen[0]!;
    expect(call.url).toBe(HOOK);
    expect(call.headers.get("authorization")).toBe("Bearer grok-abc-1234");
    const at = call.headers.get("x-context-timestamp")!;
    expect(call.headers.get("x-context-signature")).toBe(`v1=${await signHook(KEY, at, call.body)}`);
    const body = JSON.parse(call.body);
    expect(Object.keys(body).sort()).toEqual(["area", "at", "bot", "from", "note", "type", "workspace"]);
    expect(body).toMatchObject({ type: "mail", workspace: "@supa-bots", bot: "finance", area: "areas/finance", note: "areas/finance/mail/kim.md" });
    const audit = await t.run((ctx) => ctx.db.query("auditEvents").collect());
    const called = audit.find((event) => event.action === "bot_hook.called");
    expect(called?.actorUserId).toBe(kim);
    expect(JSON.stringify(audit)).not.toContain("s3cret-path");
  });

  test("a bot that fails is retried once and its status shown; an outsider's ping reaches nobody", async () => {
    const seen = stubNet(503);
    const { t, ana, outsider, supa } = await world();
    await asUser(t, ana).action(api.functions.botHooks.setBotHook, { workspaceId: supa, bot: "finance", address: HOOK, signingKey: KEY });
    expect(await asUser(t, ana).action(api.functions.botHooks.testBotHook, { workspaceId: supa, bot: "finance" })).toEqual({ ok: false, status: 503 });
    expect(seen).toHaveLength(2);
    expect((await asUser(t, ana).query(api.functions.botHooks.botHookList, { workspaceId: supa }))[0]).toMatchObject({ lastCallOk: false, lastCallStatus: 503 });
    expect(await asUser(t, outsider).action(api.functions.botHooks.pingBot, { workspaceId: supa, bot: "finance", area: "areas/finance", note: "areas/finance/mail/x.md" })).toEqual({ ok: false, status: 0 });
    expect(seen).toHaveLength(2);
  });

  test("a member may ping but not send a test", async () => {
    const seen = stubNet();
    const { t, ana, kim, supa } = await world();
    await asUser(t, ana).action(api.functions.botHooks.setBotHook, { workspaceId: supa, bot: "finance", address: HOOK, signingKey: KEY });
    expect(await asUser(t, kim).action(api.functions.botHooks.testBotHook, { workspaceId: supa, bot: "finance" })).toEqual({ ok: false, status: 0 });
    expect(seen).toHaveLength(0);
  });
});
