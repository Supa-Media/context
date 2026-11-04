// A text's session from the person object over the gateway's binding, Convex only on a miss
// (docs/decisions/texting-assistant/texting-in-objects.md).
import { describe, expect, it } from "vitest";
import { replyTo, type Message, type ReplyDeps, type TextsSessionDeps } from "./reply";
import { openGatewaySession, type Fetch, type TextsBinding } from "./clients";

const PHONE = "+15555550100";
const message = (text: string): Message => ({ kind: "message", eventId: "evt_1", chatId: "chat_1", from: PHONE, messageId: "msg_1", text });

type Route = (body: Record<string, unknown>, auth: string | null) => [number, unknown];

function deps(routes: Record<string, Route>, seen: string[], texts?: TextsSessionDeps): ReplyDeps {
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    seen.push(path);
    const route = routes[path];
    if (!route) throw new Error(`unexpected call to ${path}`);
    const [status, body] = route(JSON.parse(String(init.body)), new Headers(init.headers).get("authorization"));
    return new Response(JSON.stringify(body), { status });
  }) as unknown as Fetch;
  return { fetch: fetcher, controlPlaneOrigin: "https://cp.example", workerSecret: "worker-secret", gatewayOrigin: "https://gw.example", ...(texts ? { texts } : {}) };
}

function binding(answer: (body: Record<string, unknown>) => [number, unknown] | Error, asked: Record<string, unknown>[]): TextsBinding {
  return {
    fetch: async (_input: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      asked.push(body);
      const out = answer(body);
      if (out instanceof Error) throw out;
      return new Response(JSON.stringify(out[1]), { status: out[0] });
    },
  };
}

const answered = (token: string): Route => (_body, auth) => {
  expect(auth).toBe(`Bearer ${token}`);
  return [200, { answer: "Three things." }];
};

describe("a text's session", () => {
  it("comes from the person object when the inbox knows whose phone it is, and Convex is never asked", async () => {
    const seen: string[] = [];
    const asked: Record<string, unknown>[] = [];
    const kept: (string | null)[] = [];
    const texts = { binding: binding(() => [200, { status: "linked", accessToken: "cat1.ws_dev.object-token", timeZone: "America/New_York" }], asked), workspaceId: async () => "ws_dev", remember: async (id: string | null) => void kept.push(id) };
    const reply = await replyTo(message("what's on my list?"), deps({ "/agent": answered("cat1.ws_dev.object-token") }, seen, texts));
    expect(reply).toEqual(["Three things."]);
    expect(seen).toEqual(["/agent"]);
    expect(asked).toEqual([{ phone: PHONE, personalWorkspaceId: "ws_dev" }]);
    expect(kept).toEqual([]);
  });

  it("falls back to Convex on a miss, and a stale id the object refused is cleared", async () => {
    const seen: string[] = [];
    const kept: (string | null)[] = [];
    const texts = { binding: binding(() => [200, { status: "unlinked" }], []), workspaceId: async () => "ws_stale", remember: async (id: string | null) => void kept.push(id) };
    const reply = await replyTo(
      message("what's on my list?"),
      deps({ "/agent-texts/session": () => [200, { status: "linked", accessToken: "cat_convex" }], "/agent": answered("cat_convex") }, seen, texts),
    );
    expect(reply).toEqual(["Three things."]);
    expect(seen).toEqual(["/agent-texts/session", "/agent"]);
    expect(kept).toEqual([null]);
  });

  it("remembers the personal workspace Convex names, so the next text skips Convex", async () => {
    const seen: string[] = [];
    const asked: Record<string, unknown>[] = [];
    const kept: (string | null)[] = [];
    const texts = { binding: binding(() => [200, { status: "unlinked" }], asked), workspaceId: async () => undefined, remember: async (id: string | null) => void kept.push(id) };
    await replyTo(
      message("hi"),
      deps({ "/agent-texts/session": () => [200, { status: "linked", accessToken: "cat_convex", personalWorkspaceId: "ws_dev" }], "/agent": answered("cat_convex") }, seen, texts),
    );
    expect(asked).toEqual([]); // no id yet, so the object is not asked
    expect(kept).toEqual(["ws_dev"]);
  });

  it("ATTACK: a malformed workspace id from Convex is never kept, and a gateway that fails is a miss, not an error", async () => {
    const kept: (string | null)[] = [];
    const texts = { binding: binding(() => new Error("binding down"), []), workspaceId: async () => "ws_dev", remember: async (id: string | null) => void kept.push(id) };
    const reply = await replyTo(
      message("hi"),
      deps({ "/agent-texts/session": () => [200, { status: "linked", accessToken: "cat_convex", personalWorkspaceId: "../ws_other" }], "/agent": answered("cat_convex") }, [], texts),
    );
    expect(reply).toEqual(["Three things."]);
    expect(kept).toEqual([null]);
  });

  it("an unlinked phone is still unlinked when both say so, and nothing is kept", async () => {
    const kept: (string | null)[] = [];
    const texts = { binding: binding(() => [200, { status: "unlinked" }], []), workspaceId: async () => undefined, remember: async (id: string | null) => void kept.push(id) };
    const seen: string[] = [];
    await replyTo(
      message("hello"),
      deps({ "/agent-texts/session": () => [200, { status: "unlinked" }], "/agent-texts/setup": () => [200, { status: "not_eligible" }], "/agent-texts/invite": () => [200, { status: "issued", url: "https://app.example/t/x" }] }, seen, texts),
    );
    expect(seen.includes("/agent")).toBe(false);
    expect(kept).toEqual([]);
  });
});

describe("openGatewaySession", () => {
  it("sends the phone and the id and nothing else, and reads only a linked answer with a token", async () => {
    const asked: Record<string, unknown>[] = [];
    expect(await openGatewaySession(binding(() => [200, { status: "linked" }], asked), PHONE, "ws_dev")).toBeNull();
    expect(await openGatewaySession(binding(() => [500, { status: "linked", accessToken: "t" }], asked), PHONE, "ws_dev")).toBeNull();
    expect(await openGatewaySession(binding(() => [200, { status: "linked", accessToken: "t", personalWorkspaceId: "ws_other" }], asked), PHONE, "ws_dev")).toEqual({ status: "linked", accessToken: "t", personalWorkspaceId: "ws_dev" });
    expect(asked[0]).toEqual({ phone: PHONE, personalWorkspaceId: "ws_dev" });
  });
});
