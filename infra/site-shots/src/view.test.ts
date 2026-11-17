/**
 * The person's view of Tex's browser (./view.ts), against a fake Browserbase
 * API and a fake CDP socket.
 *
 * Sabotage record (applied, run, named test seen failing, reverted):
 *  1. `findSession` matched by the first running session, not the owner tag
 *     → "shows only the owner's browser, never someone else's" fails.
 *  2. `/view/frame` creating a session when none is running
 *     → "finds a browser and never starts one" fails.
 *  3. `parseViewAction` accepting any key name
 *     → "refuses anything but the listed keys" fails.
 *  4. The log line carrying the typed text
 *     → "types into the page and never logs or returns the text" fails.
 *  5. `move` dispatching `mousePressed` as well (a hover that clicks)
 *     → "moves the pointer without clicking, so hover works" fails.
 *  6. `button` passed through unread (any string reaching CDP)
 *     → "refuses unbounded numbers, empty or long text, and unknown kinds"
 *       fails on `button: "right"`.
 *  7. The wheel dispatched at the old fixed (10, 10)
 *     → "scrolls where the cursor is" fails.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowseLedger } from "./browserUseLedger";
import { browseOnBrowserUse, type DriveResult } from "./browserUseRoute";
import { FRAME_SCALE, MAX_COORDINATE, MAX_SCROLL, MAX_VIEW_TEXT, parseViewAction, viewOnBrowserbase, windowSizes } from "./view";

const ENV = { BROWSERBASE_API_KEY: "bb_test_key", BROWSERBASE_PROJECT_ID: "proj-test" };
const OWNER = "a".repeat(64);
const OTHER = "b".repeat(64);
const SECRET_WORDS = "correct horse battery";

type Sent = { method: string; params: Record<string, unknown> };

function fakeSocket(sent: Sent[]) {
  const listeners: Record<string, Array<(e: { data: string }) => void>> = {};
  return {
    accept() {},
    addEventListener(type: string, fn: (e: { data: string }) => void) {
      (listeners[type] ??= []).push(fn);
    },
    send(raw: string) {
      const { id, method, params } = JSON.parse(raw);
      sent.push({ method, params });
      let result: unknown = {};
      if (method === "Target.getTargets") result = { targetInfos: [{ targetId: "t1", type: "page" }] };
      if (method === "Target.attachToTarget") result = { sessionId: "s1" };
      if (method === "Page.captureScreenshot") result = { data: "SkZJRg==" };
      if (method === "Runtime.evaluate") {
        const expr: string = params.expression;
        if (expr.includes("location.href")) result = { result: { value: { url: "https://chatgpt.com/auth/login", title: "Log in", width: 1280, height: 860 } } };
        else if (expr === "document.readyState") result = { result: { value: "complete" } };
        else result = { result: { value: undefined } };
      }
      queueMicrotask(() => listeners.message?.forEach((fn) => fn({ data: JSON.stringify({ id, result }) })));
    },
    close() {},
  };
}

function fakeApi({ running = [] as Array<Record<string, unknown>> } = {}) {
  const calls: Array<{ method: string; url: string }> = [];
  const connected: string[] = [];
  const sent: Sent[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (new Headers(init?.headers).get("Upgrade") === "websocket") {
      connected.push(url);
      return Object.assign(new Response(null), { webSocket: fakeSocket(sent) });
    }
    calls.push({ method: init?.method ?? "GET", url });
    if (url.endsWith("/sessions?status=RUNNING")) return Response.json(running);
    return Response.json({ id: "new-1", connectUrl: "wss://connect.example/new-1" });
  }) as typeof fetch;
  return { calls, connected, sent, fetcher };
}

const MINE = { id: "mine", connectUrl: "wss://connect.example/mine", userMetadata: { owner: OWNER } };
const THEIRS = { id: "theirs", connectUrl: "wss://connect.example/theirs", userMetadata: { owner: OTHER } };
const USE_SESSION = "11111111-1111-1111-1111-111111111111";
const USE_CDP = `wss://cdp.example/${USE_SESSION}`;

function ledgerEnv(book: BrowseLedger) {
  return {
    ...ENV,
    BROWSER_USE_API_KEY: "bu_test_key",
    BROWSER_USE_LEDGER: {
      idFromName: () => ({ toString: () => "browser-use" }) as unknown as DurableObjectId,
      get: () => book,
    },
  };
}

/** Browser Use's API, the CDP socket the view attaches to, and Browserbase's session list. */
function viewVendor() {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const connected: string[] = [];
  const sent: Sent[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (new Headers(init?.headers).get("Upgrade") === "websocket") {
      connected.push(url);
      return Object.assign(new Response(null), { webSocket: fakeSocket(sent) });
    }
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ method, url, body });
    if (url.endsWith("/api/v2/billing/account")) return Response.json({ totalCreditsBalanceUsd: 10 });
    if (method === "POST" && url.endsWith("/api/v4/browsers")) {
      return Response.json({ id: USE_SESSION, cdpUrl: USE_CDP, liveUrl: "https://live.browser-use.example/secret-view" }, { status: 201 });
    }
    if (method === "GET" && url.includes(`/api/v4/browsers/${USE_SESSION}`)) {
      return Response.json({ id: USE_SESSION, status: "stopped", browserCost: "0.010000", proxyCost: "0.002000", proxyUsedMb: "2.5" });
    }
    if (method === "PATCH") return Response.json({ ok: true });
    if (url.endsWith("/sessions?status=RUNNING")) return Response.json([MINE]);
    return Response.json({ id: "new-1", connectUrl: "wss://connect.example/new-1" });
  }) as typeof fetch;
  return { calls, connected, fetcher };
}

const clearedRun: DriveResult = {
  ran: [{ do: "goto", ok: true }],
  page: { url: "https://wwws.airfrance.com/check-in" },
  captcha: null,
  captchaKind: null,
  invisibleCaptcha: false,
  jar: null,
};

function stops(calls: Array<{ method: string; body: unknown }>) {
  return calls.filter((entry) => entry.method === "PATCH" && entry.body !== null && (entry.body as { action?: string }).action === "stop");
}

async function browseKept(env: ReturnType<typeof ledgerEnv>, fetcher: typeof fetch, result: DriveResult) {
  const response = await browseOnBrowserUse(
    env,
    "/browse",
    { owner: OWNER, steps: [{ do: "goto", url: "https://wwws.airfrance.com/check-in" }], keep: true },
    fetcher,
    async () => result,
  );
  expect(response.status).toBe(200);
}

function ledgerKv() {
  const map = new Map<string, unknown>();
  return {
    map,
    async get<T>(key: string) {
      return map.get(key) as T | undefined;
    },
    async put(key: string, value: unknown) {
      map.set(key, value);
    },
    async delete(key: string) {
      return map.delete(key);
    },
  };
}

async function call(path: string, body: unknown, api = fakeApi({ running: [THEIRS, MINE] }), env: Record<string, string> = ENV) {
  const response = await viewOnBrowserbase(env, path, body, api.fetcher);
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, api };
}

afterEach(() => vi.restoreAllMocks());

describe("parseViewAction", () => {
  it("reads each action field by field", () => {
    expect(parseViewAction({ kind: "tap", x: 10, y: 20, extra: "x" })).toEqual({ kind: "tap", x: 10, y: 20, button: "left" });
    expect(parseViewAction({ kind: "tap", x: 10, y: 20, button: "left" })).toEqual({ kind: "tap", x: 10, y: 20, button: "left" });
    expect(parseViewAction({ kind: "move", x: 5.5, y: 6, button: "left" })).toEqual({ kind: "move", x: 5.5, y: 6 });
    expect(parseViewAction({ kind: "scroll", x: 300, y: 200, dx: 40, dy: -120 })).toEqual({ kind: "scroll", x: 300, y: 200, dx: 40, dy: -120 });
    expect(parseViewAction({ kind: "scroll", x: 300, y: 200, dx: 40 })).toEqual({ kind: "scroll", x: 300, y: 200, dx: 40, dy: 0 });
    expect(parseViewAction({ kind: "type", text: "hi" })).toEqual({ kind: "type", text: "hi" });
    expect(parseViewAction({ kind: "key", name: "Backspace" })).toEqual({ kind: "key", name: "Backspace" });
    // The shape PR #1528 shipped, still read: no position is the page's corner.
    expect(parseViewAction({ kind: "scroll", dy: -400 })).toEqual({ kind: "scroll", x: 10, y: 10, dx: 0, dy: -400 });
    expect(parseViewAction({ kind: "back" })).toEqual({ kind: "back" });
  });

  it("refuses anything but the listed keys", () => {
    for (const name of ["Escape", "F12", "Meta", "toString", "__proto__", "", 13]) {
      expect(parseViewAction({ kind: "key", name })).toBeNull();
    }
  });

  it("refuses unbounded numbers, empty or long text, and unknown kinds", () => {
    for (const bad of [
      { kind: "tap", x: -1, y: 0 },
      { kind: "tap", x: 1e9, y: 0 },
      { kind: "tap", x: Number.NaN, y: 0 },
      { kind: "tap", x: "5", y: 0 },
      { kind: "tap", x: 5 },
      { kind: "type", text: "" },
      { kind: "type", text: "x".repeat(MAX_VIEW_TEXT + 1) },
      { kind: "type", text: 42 },
      { kind: "scroll", dy: MAX_SCROLL + 1 },
      { kind: "scroll", dy: 0 },
      { kind: "scroll", dx: 0, dy: 0, x: 5, y: 5 },
      { kind: "scroll", dx: MAX_SCROLL + 1, dy: 1 },
      { kind: "scroll", dx: "10", dy: 1 },
      { kind: "scroll", dy: 10, x: 5 },
      { kind: "scroll", dy: 10, x: -1, y: 5 },
      { kind: "scroll", dy: 10, x: 5, y: MAX_COORDINATE + 1 },
      { kind: "tap", x: 5, y: 5, button: "right" },
      { kind: "tap", x: 5, y: 5, button: "middle" },
      { kind: "tap", x: 5, y: 5, button: 0 },
      { kind: "move", x: 5 },
      { kind: "move", x: -5, y: 5 },
      { kind: "move", x: 5, y: Number.POSITIVE_INFINITY },
      { kind: "goto", url: "https://example.com/" },
      { kind: "evaluate", source: "alert(1)" },
      null,
      [],
      "tap",
    ]) {
      expect(parseViewAction(bad)).toBeNull();
    }
  });
});

describe("viewOnBrowserbase", () => {
  it("answers not running when Browserbase is not configured, and asks nobody", async () => {
    const result = await call("/view/frame", { owner: OWNER }, undefined, {});
    expect(result.body).toEqual({ running: false });
    expect(result.api.calls).toEqual([]);
  });

  it("refuses an owner that is not a tag, before any call", async () => {
    const result = await call("/view/frame", { owner: "user_alice" });
    expect(result.status).toBe(400);
    expect(result.api.calls).toEqual([]);
  });

  it("finds a browser and never starts one", async () => {
    const result = await call("/view/frame", { owner: OWNER }, fakeApi({ running: [THEIRS] }));
    expect(result.body).toEqual({ running: false });
    expect(result.api.calls.every((c) => c.method === "GET")).toBe(true);
    expect(result.api.connected).toEqual([]);
  });

  it("shows only the owner's browser, never someone else's", async () => {
    const result = await call("/view/frame", { owner: OWNER });
    expect(result.status).toBe(200);
    expect(result.api.connected).toEqual(["https://connect.example/mine"]);
    expect(result.body).toEqual({
      running: true,
      url: "https://chatgpt.com/auth/login",
      title: "Log in",
      width: 1280,
      height: 860,
      scale: FRAME_SCALE,
      frame: "SkZJRg==",
    });
    const shot = result.api.sent.find((s) => s.method === "Page.captureScreenshot");
    expect(shot?.params).toMatchObject({ format: "jpeg" });
  });

  it("never returns the session id or a connect address", async () => {
    const result = await call("/view/frame", { owner: OWNER });
    const text = JSON.stringify(result.body);
    expect(text).not.toContain("mine");
    expect(text).not.toContain("connect.example");
  });

  it("taps at the page coordinate it was given", async () => {
    const result = await call("/view/input", { owner: OWNER, action: { kind: "tap", x: 640.5, y: 300 } });
    expect(result.status).toBe(200);
    const mouse = result.api.sent.filter((s) => s.method === "Input.dispatchMouseEvent");
    expect(mouse.map((m) => m.params.type)).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
    expect(mouse.every((m) => m.params.x === 640.5 && m.params.y === 300)).toBe(true);
    expect(result.body.running).toBe(true);
  });

  it("moves the pointer without clicking, so hover works", async () => {
    const result = await call("/view/input", { owner: OWNER, action: { kind: "move", x: 200, y: 120.5 } });
    expect(result.status).toBe(200);
    const mouse = result.api.sent.filter((s) => s.method === "Input.dispatchMouseEvent");
    expect(mouse).toEqual([{ method: "Input.dispatchMouseEvent", params: { type: "mouseMoved", x: 200, y: 120.5 } }]);
    expect(result.body.running).toBe(true);
  });

  it("scrolls where the cursor is", async () => {
    const result = await call("/view/input", { owner: OWNER, action: { kind: "scroll", x: 640, y: 400, dx: -30, dy: 250 } });
    const wheel = result.api.sent.find((s) => s.method === "Input.dispatchMouseEvent");
    expect(wheel?.params).toEqual({ type: "mouseWheel", x: 640, y: 400, deltaX: -30, deltaY: 250 });
  });

  it("types into the page and never logs or returns the text", async () => {
    const logs: string[] = [];
    vi.spyOn(console, "log").mockImplementation((line: unknown) => void logs.push(String(line)));
    vi.spyOn(console, "error").mockImplementation((line: unknown) => void logs.push(String(line)));
    const result = await call("/view/input", { owner: OWNER, action: { kind: "type", text: SECRET_WORDS } });
    expect(result.api.sent).toContainEqual({ method: "Input.insertText", params: { text: SECRET_WORDS } });
    expect(JSON.stringify(result.body)).not.toContain(SECRET_WORDS);
    expect(logs.length).toBeGreaterThan(0);
    expect(logs.join("\n")).not.toContain(SECRET_WORDS);
  });

  it("presses the listed keys as a keyboard does", async () => {
    const back = await call("/view/input", { owner: OWNER, action: { kind: "key", name: "Backspace" } });
    const keys = back.api.sent.filter((s) => s.method === "Input.dispatchKeyEvent");
    expect(keys.map((k) => [k.params.type, k.params.key, k.params.windowsVirtualKeyCode])).toEqual([
      ["rawKeyDown", "Backspace", 8],
      ["keyUp", "Backspace", 8],
    ]);
    const enter = await call("/view/input", { owner: OWNER, action: { kind: "key", name: "Enter" } });
    expect(enter.api.sent.find((s) => s.method === "Input.dispatchKeyEvent")?.params).toMatchObject({ type: "keyDown", text: "\r" });
  });

  it("scrolls by the distance given and goes back through history", async () => {
    const scrolled = await call("/view/input", { owner: OWNER, action: { kind: "scroll", dy: 600 } });
    expect(scrolled.api.sent.find((s) => s.method === "Input.dispatchMouseEvent")?.params).toMatchObject({ type: "mouseWheel", deltaY: 600 });
    const back = await call("/view/input", { owner: OWNER, action: { kind: "back" } });
    expect(back.api.sent.some((s) => s.method === "Runtime.evaluate" && s.params.expression === "history.back()")).toBe(true);
  });

  it("refuses a malformed action before touching the browser", async () => {
    const result = await call("/view/input", { owner: OWNER, action: { kind: "key", name: "F12" } });
    expect(result.status).toBe(400);
    expect(result.api.calls).toEqual([]);
    expect(result.api.connected).toEqual([]);
  });

  it("does nothing to someone else's browser when the owner has none", async () => {
    const result = await call("/view/input", { owner: OWNER, action: { kind: "type", text: "hi" } }, fakeApi({ running: [THEIRS] }));
    expect(result.body).toEqual({ running: false });
    expect(result.api.sent).toEqual([]);
  });

  it("keeps the live view on Browserbase when the Browser Use fallback did not clear", async () => {
    const book = new BrowseLedger(ledgerKv());
    await book.remember(OWNER, {
      id: USE_SESSION,
      cdpUrl: "wss://cdp.example/browser-use",
      host: "wwws.airfrance.com",
      started: Date.now(),
      outcome: "error",
      charged: false,
    });
    const api = fakeApi({ running: [MINE] });
    const env = {
      ...ENV,
      BROWSER_USE_API_KEY: "bu_test_key",
      BROWSER_USE_LEDGER: {
        idFromName: () => ({ toString: () => "browser-use" }) as unknown as DurableObjectId,
        get: () => book,
      },
    };
    const response = await viewOnBrowserbase(env, "/view/frame", { owner: OWNER }, api.fetcher);
    expect(response.status).toBe(200);
    expect(api.connected).toEqual(["https://connect.example/mine"]);
    expect(api.connected.join(" ")).not.toContain("cdp.example");
    expect(await book.recall(OWNER)).toBeNull();
    expect(api.calls.some((entry) => entry.method === "PATCH" && entry.url.includes(USE_SESSION))).toBe(true);
  });

  it("shows a Browser Use browser the question moved to", async () => {
    const book = new BrowseLedger(ledgerKv());
    await book.remember(OWNER, {
      id: USE_SESSION,
      cdpUrl: "wss://cdp.example/browser-use",
      host: "wwws.airfrance.com",
      started: Date.now(),
      outcome: "ok",
      charged: false,
    });
    const api = fakeApi({ running: [MINE] });
    const env = {
      ...ENV,
      BROWSER_USE_API_KEY: "bu_test_key",
      BROWSER_USE_LEDGER: {
        idFromName: () => ({ toString: () => "browser-use" }) as unknown as DurableObjectId,
        get: () => book,
      },
    };
    const response = await viewOnBrowserbase(env, "/view/frame", { owner: OWNER }, api.fetcher);
    expect(response.status).toBe(200);
    expect(api.connected).toEqual(["https://cdp.example/browser-use"]);
    expect(await book.recall(OWNER)).not.toBeNull();
  });

  it("keeps a cleared Browser Use browser when a later step fails", async () => {
    const store = ledgerKv();
    const book = new BrowseLedger(store);
    const api = viewVendor();
    const env = ledgerEnv(book);
    await browseKept(env, api.fetcher, clearedRun);
    await browseKept(env, api.fetcher, { ...clearedRun, ran: [{ do: "click", ok: false, reason: "nothing there" }] });
    expect((await book.recall(OWNER))?.outcome).toBe("error");
    const response = await viewOnBrowserbase(env, "/view/frame", { owner: OWNER }, api.fetcher);
    expect(stops(api.calls)).toEqual([]);
    expect(await book.recall(OWNER)).toMatchObject({ id: USE_SESSION, outcome: "error", cleared: true });
    expect(response.status).toBe(200);
    expect(api.connected).toEqual([USE_CDP.replace(/^wss:/, "https:")]);
    await browseOnBrowserUse(env, "/browse/close", { owner: OWNER }, api.fetcher);
    const logs = store.map.get("logs") as Array<{ kind: string; outcome: string }>;
    expect(logs.at(-1)).toMatchObject({ kind: "call", provider: "browser-use", outcome: "error" });
  });

  it("keeps a cleared Browser Use browser when a later captcha is unsolved", async () => {
    const book = new BrowseLedger(ledgerKv());
    const api = viewVendor();
    const env = ledgerEnv(book);
    await browseKept(env, api.fetcher, clearedRun);
    await browseKept(env, api.fetcher, { ...clearedRun, captcha: "unsolved" });
    expect(await book.recall(OWNER)).toMatchObject({ outcome: "site_blocked", reason: "captcha" });
    const response = await viewOnBrowserbase(env, "/view/frame", { owner: OWNER }, api.fetcher);
    expect(stops(api.calls)).toEqual([]);
    expect(await book.recall(OWNER)).toMatchObject({ id: USE_SESSION, outcome: "site_blocked", cleared: true });
    expect(response.status).toBe(200);
    expect(api.connected).toEqual([USE_CDP.replace(/^wss:/, "https:")]);
  });

  it("releases a trial whose only browse failed", async () => {
    const book = new BrowseLedger(ledgerKv());
    const api = viewVendor();
    const env = ledgerEnv(book);
    await browseKept(env, api.fetcher, { ...clearedRun, ran: [{ do: "click", ok: false, reason: "nothing there" }] });
    expect(await book.recall(OWNER)).toMatchObject({ outcome: "error", cleared: false });
    const response = await viewOnBrowserbase(env, "/view/frame", { owner: OWNER }, api.fetcher);
    expect(response.status).toBe(200);
    expect(stops(api.calls)).toHaveLength(1);
    expect(await book.recall(OWNER)).toBeNull();
    expect(api.connected).toEqual(["https://connect.example/mine"]);
  });

  it("keeps a session that cleared before this flag when a later step fails", async () => {
    const book = new BrowseLedger(ledgerKv());
    await book.remember(OWNER, {
      id: USE_SESSION,
      cdpUrl: USE_CDP,
      host: "wwws.airfrance.com",
      started: Date.now(),
      outcome: "ok",
      charged: false,
    });
    const api = viewVendor();
    const env = ledgerEnv(book);
    await browseKept(env, api.fetcher, { ...clearedRun, ran: [{ do: "click", ok: false, reason: "nothing there" }] });
    expect(api.calls.some((entry) => entry.method === "POST" && entry.url.endsWith("/api/v4/browsers"))).toBe(false);
    expect((await book.recall(OWNER))?.outcome).toBe("error");
    const response = await viewOnBrowserbase(env, "/view/frame", { owner: OWNER }, api.fetcher);
    expect(stops(api.calls)).toEqual([]);
    expect(await book.recall(OWNER)).toMatchObject({ id: USE_SESSION, outcome: "error", cleared: true });
    expect(response.status).toBe(200);
    expect(api.connected).toEqual([USE_CDP.replace(/^wss:/, "https:")]);
  });
});

describe("the window's sizes in the view's log", () => {
  it("keeps numbers only, so nothing the page says reaches the log", async () => {
    const page = { evaluate: async <T,>() => ({ inner: 1280, innerH: 860, ratio: 1.25, zoom: 1, outer: "a page's words", screen: Number.NaN }) as T };
    expect(await windowSizes(page)).toEqual({ inner: 1280, innerH: 860, ratio: 1.25, zoom: 1 });
    expect(await windowSizes({ evaluate: async () => Promise.reject(new Error("gone")) })).toEqual({});
  });
});
