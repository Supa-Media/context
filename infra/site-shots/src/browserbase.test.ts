import { beforeEach, describe, expect, it } from "vitest";
import { SESSION_LIFETIME_S, createSession, forgetRefusedTiers, sessionRequests } from "./browserbase";
import { browseOnBrowserbase } from "./browserbaseRoute";
import { READ_WORLD, STORAGE_WORLD } from "./jar";
import { PASSKEYS_OFF_SOURCE } from "./passkeys";

const ISOLATED = 7;
const SHOP_DB = { name: "firebaseLocalStorageDb", version: 1, stores: [{ name: "firebaseLocalStorage", keyPath: "fbase_key", autoIncrement: false, indexes: [], records: [{ value: { fbase_key: "k", value: { uid: "u1" } } }] }] };

const ENV = { BROWSERBASE_API_KEY: "bb_test_key", BROWSERBASE_PROJECT_ID: "proj-test" };
const OWNER = "a".repeat(64);
const OTHER = "b".repeat(64);
const PROFILE = "0b6c0e3e-7a43-4b1e-9d0a-2f5a1c9e8d71";

/** A CDP socket that answers just enough for one reading of one page. */
const socketOptions = { failSetCookies: false, uploadedSize: 9 };

function fakeSocket(log: string[]) {
  const listeners: Record<string, Array<(e: { data: string }) => void>> = {};
  return {
    accept() {},
    addEventListener(type: string, fn: (e: { data: string }) => void) {
      (listeners[type] ??= []).push(fn);
    },
    send(raw: string) {
      const { id, method, params } = JSON.parse(raw);
      log.push(
        method === "Input.insertText" ? `${method} ${params.text}`
        : /^(Storage\.setCookies|Page\.addScriptToEvaluateOnNewDocument|DOM\.setFileInputFiles)$/.test(method) ? `${method} ${JSON.stringify(params)}`
        : method === "Runtime.evaluate" && String(params.expression).includes("new DataTransfer()") ? "page DataTransfer"
        : method,
      );
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
        else if (expr.startsWith("document.querySelector(")) result = { result: { type: "object", subtype: "node", objectId: "box-1" } };
        else if (expr.includes("box.files.length === 1")) result = { result: { value: socketOptions.uploadedSize } };
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
    calls.push({ method: init?.method ?? "GET", url, body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body ?? null, key: headers.get("X-BB-API-Key") });
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

beforeEach(() => forgetRefusedTiers());

describe("browseOnBrowserbase", () => {
  it("answers 501 with no key, so the gateway keeps Cloudflare's browser", async () => {
    const result = await call({}, { owner: OWNER, steps: [{ do: "read" }] });
    expect(result.status).toBe(501);
    expect(result.api.calls).toEqual([]);
  });

  it("starts an unrecorded browser tagged with the owner, which ends itself, with no profile unless one is given", async () => {
    const result = await call(ENV, { owner: OWNER, steps: [{ do: "goto", url: "https://shop.example.com/" }] });
    expect(result.status).toBe(200);
    const created = result.api.calls.find((c) => c.method === "POST" && c.url.endsWith("/sessions"));
    expect(created?.key).toBe("bb_test_key");
    expect(created?.body).toEqual({
      projectId: "proj-test",
      keepAlive: true,
      timeout: SESSION_LIFETIME_S,
      userMetadata: { owner: OWNER },
      proxies: true,
      browserSettings: { recordSession: false, blockAds: true, viewport: { width: 1280, height: 860 }, advancedStealth: true },
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

  it("drops the owner's running browser and starts a new one when a fresh browser is asked for", async () => {
    const api = fakeApi({ running: [{ id: "mine", connectUrl: "wss://connect.example/mine", userMetadata: { owner: OWNER } }] });
    const result = await call(ENV, { owner: OWNER, steps: [{ do: "read" }], fresh: true }, api);
    expect(result.body.session).toBe("new-1");
    const released = api.calls.find((c) => c.url.endsWith("/sessions/mine"));
    expect(released?.body).toMatchObject({ status: "REQUEST_RELEASE" });
    expect(api.cdp[0]).toBe("connect https://connect.example/new-1");
  });

  it("names no captcha when the page shows none", async () => {
    const result = await call(ENV, { owner: OWNER, steps: [{ do: "read" }] });
    expect(result.body.captcha).toBeUndefined();
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

describe("uploads on Browserbase", () => {
  const file = { name: "receipt.pdf", type: "application/pdf", data: "JVBERi0xLjQK" };

  it("sends the file to the session's uploads and has the browser set it, with no file written into the page", async () => {
    const result = await call(ENV, { owner: OWNER, steps: [{ do: "upload", file }] });
    expect(result.body.ran).toEqual([{ do: "upload", ok: true }]);
    const upload = result.api.calls.find((c) => c.url.endsWith("/uploads"));
    expect(upload).toMatchObject({ method: "POST", url: "https://api.browserbase.com/v1/sessions/new-1/uploads", key: "bb_test_key" });
    expect(((upload!.body as FormData).get("file") as File).name).toBe("receipt.pdf");
    expect(result.api.cdp).toContain(`DOM.setFileInputFiles ${JSON.stringify({ files: ["/tmp/.uploads/receipt.pdf"], objectId: "box-1" })}`);
    expect(result.api.cdp).not.toContain("page DataTransfer");
  });

  it("falls back to putting the file in from the page when the browser's copy did not arrive", async () => {
    socketOptions.uploadedSize = 0;
    try {
      const result = await call(ENV, { owner: OWNER, steps: [{ do: "upload", file }] });
      expect(result.body.ran).toEqual([{ do: "upload", ok: true }]);
      expect(result.api.cdp).toContain("page DataTransfer");
    } finally {
      socketOptions.uploadedSize = 9;
    }
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
    const scripts = result.api.cdp.filter((line) => line.startsWith("Page.addScriptToEvaluateOnNewDocument "));
    const parsed = scripts.map((line) => JSON.parse(line.slice("Page.addScriptToEvaluateOnNewDocument ".length)));
    // Passkeys off first, in the page's own world, where its scripts ask (./passkeys.ts).
    expect(parsed[0]).toEqual({ source: PASSKEYS_OFF_SOURCE, runImmediately: true });
    const script = scripts.find((line) => !line.includes(JSON.stringify(PASSKEYS_OFF_SOURCE)));
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

  it("opens the profile in a new browser and leaves its cookies alone: a profile in use holds newer ones", async () => {
    const result = await call(ENV, { owner: OWNER, steps: [{ do: "read" }], keep: true, jar, profile: PROFILE });
    const created = result.api.calls.find((c) => c.method === "POST" && c.url.endsWith("/sessions"));
    expect((created?.body as { browserSettings: Record<string, unknown> }).browserSettings.context).toEqual({ id: PROFILE, persist: true });
    expect(result.api.cdp.some((line) => line.startsWith("Storage.setCookies"))).toBe(false);
    // Still read back: the jar is the fallback and the copy the person leaves with.
    expect(result.body.jar).toBeDefined();
    expect(result.body.profileGone).toBeUndefined();
  });

  it("gives a new profile the jar's cookies, so sign-ins kept before it carry over", async () => {
    const result = await call(ENV, { owner: OWNER, steps: [{ do: "read" }], keep: true, jar, profile: PROFILE, profileNew: true });
    expect(result.api.cdp.some((line) => line.startsWith("Storage.setCookies"))).toBe(true);
  });

  it("starts from the jar and says the profile is gone when Browserbase will not open it", async () => {
    const api = fakeApi();
    const bodies: Array<Record<string, unknown>> = [];
    const refusing = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/sessions") && init?.method === "POST") {
        const body = JSON.parse(String(init.body));
        bodies.push(body);
        if (body.browserSettings.context) return new Response("{}", { status: 404 });
      }
      return await api.fetcher(input, init);
    }) as typeof fetch;
    const response = await browseOnBrowserbase(ENV, "/browse", { owner: OWNER, steps: [{ do: "read" }], keep: true, jar, profile: PROFILE }, refusing);
    const body = (await response.json()) as Record<string, unknown>;
    expect(response.status).toBe(200);
    expect(body.profileGone).toBe(true);
    expect(bodies.at(-1)!.browserSettings).not.toHaveProperty("context");
    expect(api.cdp.some((line) => line.startsWith("Storage.setCookies"))).toBe(true);
  });

  it("never takes a refusal for billing as a lost profile", async () => {
    const api = fakeApi();
    const refusing = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/sessions") && init?.method === "POST") return new Response("{}", { status: 402 });
      return await api.fetcher(input, init);
    }) as typeof fetch;
    const response = await browseOnBrowserbase(ENV, "/browse", { owner: OWNER, steps: [{ do: "read" }], profile: PROFILE }, refusing);
    expect(response.status).toBe(402);
  });

  it("ignores a profile that is not an id", async () => {
    const result = await call(ENV, { owner: OWNER, steps: [{ do: "read" }], profile: "../../contexts" });
    const created = result.api.calls.find((c) => c.method === "POST" && c.url.endsWith("/sessions"));
    expect(JSON.stringify(created?.body)).not.toContain("context");
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

describe("what a new browser is asked for", () => {
  const plain = {
    projectId: "proj-test",
    keepAlive: true,
    timeout: SESSION_LIFETIME_S,
    userMetadata: { owner: OWNER },
    browserSettings: { recordSession: false, blockAds: true, viewport: { width: 1280, height: 860 } },
  };

  it("asks for proxies, stealth and the region first, and ends with the plain browser", () => {
    const tiers = sessionRequests({ ...ENV, BROWSERBASE_REGION: "us-east-1" }, OWNER);
    expect(tiers[0]).toMatchObject({ proxies: true, region: "us-east-1", browserSettings: { advancedStealth: true, recordSession: false } });
    expect(tiers[1]).toMatchObject({ proxies: true, region: "us-east-1" });
    expect((tiers[1]!.browserSettings as Record<string, unknown>).advancedStealth).toBeUndefined();
    expect(tiers.at(-1)).toEqual(plain);
    // Every tier stays unrecorded, and names no profile unless given one.
    for (const tier of tiers) {
      expect((tier.browserSettings as Record<string, unknown>).recordSession).toBe(false);
      expect(JSON.stringify(tier)).not.toContain("context");
    }
  });

  it("opens the owner's saved profile, and saves back into it, on every tier", () => {
    const tiers = sessionRequests({ ...ENV, BROWSERBASE_REGION: "us-east-1" }, OWNER, PROFILE);
    for (const tier of tiers) {
      expect((tier.browserSettings as Record<string, unknown>).context).toEqual({ id: PROFILE, persist: true });
      expect((tier.browserSettings as Record<string, unknown>).recordSession).toBe(false);
    }
  });

  it("leaves out what is turned off, and a region it does not know", () => {
    expect(sessionRequests({ ...ENV, BROWSERBASE_PROXIES: "off", BROWSERBASE_STEALTH: "off", BROWSERBASE_REGION: "mars-1" }, OWNER)).toEqual([plain]);
    const noProxies = sessionRequests({ ...ENV, BROWSERBASE_PROXIES: "off" }, OWNER);
    expect(noProxies.some((tier) => "proxies" in tier)).toBe(false);
    expect(noProxies[0]).toMatchObject({ browserSettings: { advancedStealth: true } });
  });

  function vendor(statuses: number[]) {
    const bodies: Array<Record<string, unknown>> = [];
    const fetcher = (async (_url: string, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      const status = statuses.shift() ?? 200;
      return status === 200 ? Response.json({ id: "s-1", connectUrl: "wss://connect.example/s-1" }) : new Response("{}", { status });
    }) as unknown as typeof fetch;
    return { bodies, fetcher };
  }

  it("steps down to a plainer browser when the plan refuses an extra", async () => {
    const { bodies, fetcher } = vendor([400, 403]);
    expect(await createSession(ENV, OWNER, fetcher)).toEqual({ id: "s-1", connectUrl: "wss://connect.example/s-1" });
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toMatchObject({ proxies: true, browserSettings: { advancedStealth: true } });
    expect(bodies[1]).toMatchObject({ proxies: true });
    expect(bodies[2]).toEqual(plain);
  });

  it("starts the next browser at the extras the plan took, without asking again for the ones it refused", async () => {
    await createSession(ENV, OWNER, vendor([400, 403]).fetcher);
    const next = vendor([]);
    await createSession(ENV, OWNER, next.fetcher);
    expect(next.bodies).toEqual([plain]);
  });

  it("never steps down for billing, too many browsers or an outage", async () => {
    for (const status of [402, 429, 500]) {
      const { bodies, fetcher } = vendor([status]);
      await expect(createSession(ENV, OWNER, fetcher)).rejects.toThrow(`browserbase ${status}`);
      expect(bodies).toHaveLength(1);
    }
  });

  it("gives up when even the plain browser is refused", async () => {
    const { bodies, fetcher } = vendor([400, 400, 400]);
    await expect(createSession(ENV, OWNER, fetcher)).rejects.toThrow("browserbase 400");
    expect(bodies).toHaveLength(3);
  });
});
