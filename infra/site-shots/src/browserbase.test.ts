import { describe, expect, it } from "vitest";
import { SESSION_LIFETIME_S } from "./browserbase";
import { browseOnBrowserbase } from "./browserbaseRoute";

const ENV = { BROWSERBASE_API_KEY: "bb_test_key", BROWSERBASE_PROJECT_ID: "proj-test" };
const OWNER = "a".repeat(64);
const OTHER = "b".repeat(64);

/** A CDP socket that answers just enough for one reading of one page. */
function fakeSocket(log: string[]) {
  const listeners: Record<string, Array<(e: { data: string }) => void>> = {};
  return {
    accept() {},
    addEventListener(type: string, fn: (e: { data: string }) => void) {
      (listeners[type] ??= []).push(fn);
    },
    send(raw: string) {
      const { id, method, params } = JSON.parse(raw);
      log.push(method === "Input.insertText" ? `${method} ${params.text}` : method);
      let result: unknown = {};
      if (method === "Target.getTargets") result = { targetInfos: [{ targetId: "t1", type: "page" }] };
      if (method === "Target.attachToTarget") result = { sessionId: "s1" };
      if (method === "Runtime.evaluate") {
        const expr: string = params.expression;
        if (expr.includes("location.hostname")) result = { result: { value: { href: "https://shop.example.com/", host: "shop.example.com", origin: "https://shop.example.com" } } };
        else if (expr.includes("data-tex-ref") && expr.includes("elements")) {
          result = { result: { value: { url: "https://shop.example.com/", title: "Shop", text: "Hi", elements: [{ ref: 1, kind: "input text", label: "Search", filled: true }] } } };
        } else if (expr.startsWith("!!document")) result = { result: { value: true } };
        else if (expr === "document.readyState") result = { result: { value: "complete" } };
        else result = { result: { value: true } };
      }
      queueMicrotask(() => listeners.message?.forEach((fn) => fn({ data: JSON.stringify({ id, result }) })));
    },
    close() {},
  };
}

function fakeApi({ running = [] as Array<Record<string, unknown>> } = {}) {
  const calls: Array<{ method: string; url: string; body: unknown; key: string | null }> = [];
  const cdp: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (headers.get("Upgrade") === "websocket") {
      cdp.push(`connect ${url}`);
      return Object.assign(new Response(null), { webSocket: fakeSocket(cdp) });
    }
    calls.push({ method: init?.method ?? "GET", url, body: init?.body ? JSON.parse(String(init.body)) : null, key: headers.get("X-BB-API-Key") });
    if (url.endsWith("/sessions?status=RUNNING")) return Response.json(running);
    if (url.endsWith("/sessions") && init?.method === "POST") return Response.json({ id: "new-1", connectUrl: "wss://connect.example/new-1" });
    if (url.endsWith("/debug")) return Response.json({ debuggerFullscreenUrl: "https://live.example/new-1" });
    return Response.json({});
  }) as typeof fetch;
  return { calls, cdp, fetcher };
}

async function call(env: Record<string, string>, body: unknown, api = fakeApi(), path = "/browse") {
  const response = await browseOnBrowserbase(env, path, body, api.fetcher);
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, api };
}

describe("browseOnBrowserbase", () => {
  it("answers 501 with no key, so the gateway keeps Cloudflare's browser", async () => {
    const result = await call({}, { owner: OWNER, steps: [{ do: "read" }] });
    expect(result.status).toBe(501);
    expect(result.api.calls).toEqual([]);
  });

  it("starts a stateless, unrecorded browser tagged with the owner, which ends itself", async () => {
    const result = await call(ENV, { owner: OWNER, steps: [{ do: "goto", url: "https://shop.example.com/" }] });
    expect(result.status).toBe(200);
    const created = result.api.calls.find((c) => c.method === "POST" && c.url.endsWith("/sessions"));
    expect(created?.key).toBe("bb_test_key");
    expect(created?.body).toEqual({
      projectId: "proj-test",
      keepAlive: true,
      timeout: SESSION_LIFETIME_S,
      userMetadata: { owner: OWNER },
      browserSettings: { recordSession: false, viewport: { width: 1280, height: 860 } },
    });
    expect(JSON.stringify(created?.body)).not.toContain("context");
    expect(result.body.page).toMatchObject({ url: "https://shop.example.com/" });
    expect(result.body.liveUrl).toBeUndefined();
  });

  it("carries on in the owner's running browser and never in someone else's", async () => {
    const api = fakeApi({
      running: [
        { id: "theirs", connectUrl: "wss://connect.example/theirs", userMetadata: { owner: OTHER } },
        { id: "mine", connectUrl: "wss://connect.example/mine", userMetadata: { owner: OWNER } },
      ],
    });
    const result = await call(ENV, { owner: OWNER, steps: [{ do: "read" }] }, api);
    expect(result.body.session).toBe("mine");
    expect(api.cdp[0]).toBe("connect https://connect.example/mine");
    expect(api.calls.some((c) => c.method === "POST" && c.url.endsWith("/sessions"))).toBe(false);
  });

  it("gives the live-view link only when a handoff asks for it", async () => {
    const result = await call(ENV, { owner: OWNER, steps: [{ do: "read" }], handoff: true });
    expect(result.body.liveUrl).toBe("https://live.example/new-1");
  });

  it("refuses an owner that is not a tag", async () => {
    expect((await call(ENV, { owner: "user_123", steps: [{ do: "read" }] })).status).toBe(400);
  });

  it("types through CDP and never returns what a field holds", async () => {
    const api = fakeApi();
    const result = await call(ENV, { owner: OWNER, steps: [{ do: "type", ref: 1, text: "wool socks" }] }, api);
    expect(api.cdp).toContain("Input.insertText wool socks");
    expect(JSON.stringify(result.body)).not.toContain("wool socks");
  });

  it("releases only the owner's browser on close", async () => {
    const api = fakeApi({ running: [{ id: "mine", connectUrl: "wss://c/mine", userMetadata: { owner: OWNER } }] });
    await call(ENV, { owner: OWNER }, api, "/browse/close");
    expect(api.calls.at(-1)).toMatchObject({ method: "POST", url: "https://api.browserbase.com/v1/sessions/mine", body: { status: "REQUEST_RELEASE" } });
  });
});
