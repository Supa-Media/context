import { describe, expect, it } from "vitest";
import { SESSION_LIFETIME_S } from "./browserbase";
import { browseOnBrowserbase } from "./browserbaseRoute";
import { READ_WORLD, STORAGE_WORLD } from "./jar";

const ISOLATED = 7;
const SHOP_DB = { name: "firebaseLocalStorageDb", version: 1, stores: [{ name: "firebaseLocalStorage", keyPath: "fbase_key", autoIncrement: false, indexes: [], records: [{ value: { fbase_key: "k", value: { uid: "u1" } } }] }] };

const ENV = { BROWSERBASE_API_KEY: "bb_test_key", BROWSERBASE_PROJECT_ID: "proj-test" };
const OWNER = "a".repeat(64);
const OTHER = "b".repeat(64);

/** A CDP socket that answers just enough for one reading of one page. */
const socketOptions = { failSetCookies: false };

function fakeSocket(log: string[]) {
  const listeners: Record<string, Array<(e: { data: string }) => void>> = {};
  return {
    accept() {},
    addEventListener(type: string, fn: (e: { data: string }) => void) {
      (listeners[type] ??= []).push(fn);
    },
    send(raw: string) {
      const { id, method, params } = JSON.parse(raw);
      log.push(method === "Input.insertText" ? `${method} ${params.text}` : /^(Storage\.setCookies|Page\.addScriptToEvaluateOnNewDocument)$/.test(method) ? `${method} ${JSON.stringify(params)}` : method);
      let result: unknown = {};
      let error: unknown = undefined;
      if (method === "Storage.setCookies" && socketOptions.failSetCookies) error = { message: "nope" };
      if (method === "Storage.getCookies") {
        result = { cookies: [
          { name: "sid", value: "s3cret", domain: ".shop.example.com", path: "/", expires: 1900000000, httpOnly: true, secure: true, session: false, sameSite: "Lax" },
          { name: "part", value: "x", domain: "embed.example", path: "/", expires: -1, session: true, partitionKey: { topLevelSite: "https://a.example" } },
        ] };
      }
      if (method === "Target.getTargets") result = { targetInfos: [{ targetId: "t1", type: "page" }] };
      if (method === "Target.attachToTarget") result = { sessionId: "s1" };
      if (method === "Page.getFrameTree") result = { frameTree: { frame: { id: "f1" } } };
      if (method === "Page.createIsolatedWorld") result = { executionContextId: params.frameId === "f1" && params.worldName === READ_WORLD ? ISOLATED : 0 };
      if (method === "Runtime.evaluate") {
        const expr: string = params.expression;
        // The page's own world answers a jar read with another site's data, as a page that replaced Promise could.
        const apart = params.contextId === ISOLATED;
        if (expr.includes("localStorage.key(i)")) result = { result: { value: apart ? { origin: "https://shop.example.com", items: { token: "jwt-abc" } } : { origin: "https://bank.example", items: { forged: "1" } } } };
        else if (expr.includes("indexedDB.databases")) result = { result: { value: apart ? { origin: "https://shop.example.com", dbs: [SHOP_DB] } : { origin: "https://bank.example", dbs: [] } } };
        else if (expr.includes("location.hostname")) result = { result: { value: { href: "https://shop.example.com/", host: "shop.example.com", origin: "https://shop.example.com" } } };
        else if (expr.includes("data-tex-ref") && expr.includes("elements")) {
          result = { result: { value: { url: "https://shop.example.com/", title: "Shop", text: "Hi", elements: [{ ref: 1, kind: "input text", label: "Search", filled: true }] } } };
        } else if (expr.startsWith("!!document")) result = { result: { value: true } };
        else if (expr === "document.readyState") result = { result: { value: "complete" } };
        else result = { result: { value: true } };
      }
      queueMicrotask(() => listeners.message?.forEach((fn) => fn({ data: JSON.stringify(error ? { id, error } : { id, result }) })));
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

  it("never asks Browserbase for its live-view link, even when a handoff is asked for", async () => {
    const result = await call(ENV, { owner: OWNER, steps: [{ do: "read" }], handoff: true });
    expect(result.body.liveUrl).toBeUndefined();
    expect(result.api.calls.some((c) => c.url.endsWith("/debug"))).toBe(false);
    expect(JSON.stringify(result.body)).not.toContain("live.example");
  });

  it("says when Browserbase refuses for billing, so the gateway can use Cloudflare's browser", async () => {
    const api = fakeApi();
    const refusing = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/sessions") && init?.method === "POST") return new Response("{\"error\":\"usage limit\"}", { status: 402 });
      return await api.fetcher(input, init);
    }) as typeof fetch;
    const response = await browseOnBrowserbase(ENV, "/browse", { owner: OWNER, steps: [{ do: "read" }] }, refusing);
    expect(response.status).toBe(402);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.session).toBeUndefined();
    // The vendor's own words never travel on.
    expect(JSON.stringify(body)).not.toContain("usage limit");
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

describe("sign-ins kept between browsers", () => {
  const jar = {
    cookies: [{ name: "sid", value: "old", domain: ".shop.example.com", path: "/", secure: true, httpOnly: true, sameSite: "Lax", expires: 1900000000 }],
    storage: { "https://shop.example.com": { token: "jwt-old" } },
  };

  it("gives a new browser the jar's cookies and each site's storage, then reads the jar back out", async () => {
    socketOptions.failSetCookies = false;
    const result = await call(ENV, { owner: OWNER, steps: [{ do: "read" }], keep: true, jar });
    const set = result.api.cdp.find((line) => line.startsWith("Storage.setCookies "));
    expect(JSON.parse(set!.slice("Storage.setCookies ".length))).toEqual({ cookies: jar.cookies });
    const script = result.api.cdp.find((line) => line.startsWith("Page.addScriptToEvaluateOnNewDocument "));
    // In a world of its own: no site's scripts read what it carries.
    expect(JSON.parse(script!.slice("Page.addScriptToEvaluateOnNewDocument ".length)).worldName).toBe(STORAGE_WORLD);
    expect(result.body.jar).toEqual({
      // A partitioned cookie stays with its browser.
      cookies: [{ name: "sid", value: "s3cret", domain: ".shop.example.com", path: "/", secure: true, httpOnly: true, sameSite: "Lax", expires: 1900000000 }],
      storage: { "https://shop.example.com": { token: "jwt-abc" } },
      // Read in an isolated world, so the page's own scripts could not answer for another site.
      idb: { "https://shop.example.com": [SHOP_DB] },
    });
  });

  it("never gives a running browser the jar's older cookies", async () => {
    const api = fakeApi({ running: [{ id: "mine", connectUrl: "wss://connect.example/mine", userMetadata: { owner: OWNER } }] });
    const result = await call(ENV, { owner: OWNER, steps: [{ do: "read" }], keep: true, jar }, api);
    expect(result.api.cdp.some((line) => line.startsWith("Storage.setCookies"))).toBe(false);
    expect(result.api.cdp.some((line) => line.startsWith("Page.addScriptToEvaluateOnNewDocument"))).toBe(true);
    expect(result.body.jar).toBeDefined();
  });

  it("reads nothing out unless asked, and nothing after a restore that failed", async () => {
    const plain = await call(ENV, { owner: OWNER, steps: [{ do: "read" }] });
    expect(plain.body.jar).toBeUndefined();
    expect(plain.api.cdp).not.toContain("Storage.getCookies");
    socketOptions.failSetCookies = true;
    try {
      const failed = await call(ENV, { owner: OWNER, steps: [{ do: "read" }], keep: true, jar });
      expect(failed.status).toBe(200);
      // A jar read from a browser that never got the old one would read as a sign-out.
      expect(failed.body.jar).toBeUndefined();
    } finally {
      socketOptions.failSetCookies = false;
    }
  });
});
