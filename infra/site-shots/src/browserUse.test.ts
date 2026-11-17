/**
 * The Browser Use fallback: caps, the balance call failing closed, and the
 * session stop. A Verified-tier 403 is not a site block; that classification
 * lives in the gateway (`apps/mcp/src/agent/browserUseFallback.js`).
 */

import { describe, expect, it } from "vitest";
import { BrowseLedger, type LedgerKv } from "./browserUseLedger";
import { browseOnBrowserUse, type DriveResult } from "./browserUseRoute";
import { browserUseAllowed, createBrowser } from "./browserUse";
import { BROWSER_USE_CEILING, capRefusal, effectiveCaps, nyPeriod, summarizeBrowseLog, type BrowseLogRow } from "./browserUsePolicy";
import { documentForbidden, digestLogs } from "./sessionLogs";

const OWNER = "a".repeat(64);
const SESSION = "11111111-1111-1111-1111-111111111111";

function kv(seed: Record<string, unknown> = {}): LedgerKv {
  const map = new Map<string, unknown>(Object.entries(seed));
  return {
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

function ledgerEnv(book: BrowseLedger, key = "bu_test_key") {
  return {
    BROWSER_USE_API_KEY: key,
    BROWSER_USE_LEDGER: {
      idFromName: () => ({ toString: () => "browser-use" }) as unknown as DurableObjectId,
      get: () => book,
    },
  };
}

function vendor(balance: number | "down" = 10) {
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    calls.push({ method, url, body });
    if (url.endsWith("/api/v2/billing/account")) {
      if (balance === "down") return new Response("down", { status: 503 });
      return Response.json({ totalCreditsBalanceUsd: balance });
    }
    if (method === "POST" && url.endsWith("/api/v4/browsers")) {
      return Response.json({ id: SESSION, cdpUrl: `wss://cdp.example/${SESSION}`, liveUrl: "https://live.browser-use.example/secret-view" }, { status: 201 });
    }
    if (method === "PATCH") return Response.json({ ok: true });
    if (url.endsWith("/cost")) return Response.json({ totalCostUsd: "0.012000", proxyUsedMb: "2.5" });
    return new Response("missing", { status: 404 });
  }) as typeof fetch;
  return { calls, fetcher };
}

const page: DriveResult = {
  ran: [{ do: "goto", ok: true }],
  page: { url: "https://wwws.airfrance.com/check-in" },
  captcha: null,
  captchaKind: null,
  invisibleCaptcha: false,
  jar: null,
};

const driveOk = async () => page;
const driveThrows = async () => {
  throw new Error("the page threw");
};

describe("caps", () => {
  const caps = { ...BROWSER_USE_CEILING };

  it("refuses a day already at $1", () => {
    expect(capRefusal({ dayUsd: 1, monthUsd: 0 }, 10, false, caps)).toBe("browser-use day cap reached ($1)");
  });

  it("refuses a month already at $5", () => {
    expect(capRefusal({ dayUsd: 0, monthUsd: 5 }, 10, false, caps)).toBe("browser-use month cap reached ($5)");
  });

  it("refuses a balance under $0.50", () => {
    expect(capRefusal({ dayUsd: 0, monthUsd: 0 }, 0.49, false, caps)).toBe("browser-use balance is under $0.5");
  });

  it("refuses when the balance call failed", () => {
    expect(capRefusal({ dayUsd: 0, monthUsd: 0 }, null, true, caps)).toBe("browser-use balance could not be read");
  });

  it("refuses when spend cannot be read", () => {
    expect(capRefusal({ dayUsd: Number.NaN, monthUsd: 0 }, 10, false, caps)).toBe("browser-use spend could not be read");
  });

  it("allows a balance of $0.50 and spend under the caps", () => {
    expect(capRefusal({ dayUsd: 0.99, monthUsd: 4.99 }, 0.5, false, caps)).toBeNull();
  });

  it("will not raise a cap a caller asks for, and will not lower the balance floor", () => {
    expect(effectiveCaps({ jobMinutes: 90, dayUsd: 40, monthUsd: 9, minBalanceUsd: 0.01 })).toEqual(BROWSER_USE_CEILING);
    expect(effectiveCaps({ jobMinutes: 5, dayUsd: 0.25, monthUsd: 2, minBalanceUsd: 1 })).toEqual({ jobMinutes: 5, dayUsd: 0.25, monthUsd: 2, minBalanceUsd: 1 });
  });

  it("counts a New York day, including across midnight", () => {
    // 04:30Z in November is still the previous evening in New York (EST, UTC-5).
    expect(nyPeriod(new Date("2026-11-17T04:30:00.000Z"))).toEqual({ day: "2026-11-16", month: "2026-11" });
    expect(nyPeriod(new Date("2026-11-17T05:30:00.000Z"))).toEqual({ day: "2026-11-17", month: "2026-11" });
    expect(nyPeriod(new Date("2026-12-01T04:30:00.000Z"))).toEqual({ day: "2026-11-30", month: "2026-11" });
    expect(nyPeriod(new Date("2026-12-01T05:30:00.000Z"))).toEqual({ day: "2026-12-01", month: "2026-12" });
  });
});

describe("the vendor client", () => {
  it("never allows a credit purchase, auto-recharge, or an agent task", () => {
    expect(browserUseAllowed("GET", "/api/v2/billing/account")).toBe(true);
    expect(browserUseAllowed("POST", "/api/v4/browsers")).toBe(true);
    expect(browserUseAllowed("PATCH", `/api/v4/browsers/${SESSION}`)).toBe(true);
    expect(browserUseAllowed("GET", `/api/v4/sessions/${SESSION}/cost`)).toBe(true);
    for (const path of ["/api/v2/billing/credits", "/api/v2/billing/auto-recharge", "/api/v4/tasks", "/api/v4/runs", "/api/v4/agents"]) {
      expect(browserUseAllowed("POST", path)).toBe(false);
    }
  });

  it("creates a CDP browser with the job cap and no profile", async () => {
    const api = vendor();
    const session = await createBrowser({ BROWSER_USE_API_KEY: "bu_test_key" }, 15, OWNER, api.fetcher);
    expect(session).toEqual({ id: SESSION, cdpUrl: `wss://cdp.example/${SESSION}` });
    expect(api.calls[0]).toMatchObject({
      method: "POST",
      url: "https://api.browser-use.com/api/v4/browsers",
      body: { timeout: 15, proxyCountryCode: "us", metadata: { owner: OWNER } },
    });
    expect(JSON.stringify(api.calls[0].body)).not.toContain("profile");
    expect(JSON.stringify(api.calls[0].body)).not.toContain("liveUrl");
  });
});

describe("browseOnBrowserUse", () => {
  it("refuses on a low balance and does not create a session", async () => {
    const book = new BrowseLedger(kv());
    const api = vendor(0.2);
    const response = await browseOnBrowserUse(ledgerEnv(book), "/browse", { owner: OWNER, steps: [{ do: "goto", url: "https://wwws.airfrance.com/check-in" }] }, api.fetcher, driveOk);
    expect(response.status).toBe(200);
    const body = await response.json() as { fallbackRefused?: boolean; reason?: string };
    expect(body.fallbackRefused).toBe(true);
    expect(body.reason).toMatch(/under \$0\.5/);
    expect(api.calls.some((call) => call.url.endsWith("/api/v4/browsers"))).toBe(false);
  });

  it("refuses when the balance API errors and does not create a session", async () => {
    const book = new BrowseLedger(kv());
    const api = vendor("down");
    const response = await browseOnBrowserUse(ledgerEnv(book), "/browse", { owner: OWNER, steps: [{ do: "read" }] }, api.fetcher, driveOk);
    const body = await response.json() as { reason?: string };
    expect(body.reason).toBe("browser-use balance could not be read");
    expect(api.calls.map((call) => call.url)).toEqual(["https://api.browser-use.com/api/v2/billing/account"]);
  });

  it("refuses when the day or the month is already spent", async () => {
    for (const spend of [{ dayUsd: 1, monthUsd: 0 }, { dayUsd: 0, monthUsd: 5 }]) {
      const book = new BrowseLedger(kv({ spend: { day: nyPeriod(new Date()).day, month: nyPeriod(new Date()).month, ...spend } }));
      const api = vendor();
      const response = await browseOnBrowserUse(ledgerEnv(book), "/browse", { owner: OWNER, steps: [{ do: "read" }] }, api.fetcher, driveOk);
      const body = await response.json() as { reason?: string };
      expect(body.reason).toMatch(/cap reached/);
      expect(api.calls).toEqual([]);
    }
  });

  it("refuses when the spend ledger is missing", async () => {
    const api = vendor();
    const response = await browseOnBrowserUse({ BROWSER_USE_API_KEY: "bu_test_key" }, "/browse", { owner: OWNER, steps: [{ do: "read" }] }, api.fetcher, driveOk);
    const body = await response.json() as { reason?: string };
    expect(body.reason).toBe("browser-use spend could not be read");
    expect(api.calls).toEqual([]);
  });

  it("stops the session when the drive throws", async () => {
    const book = new BrowseLedger(kv());
    const api = vendor();
    const response = await browseOnBrowserUse(ledgerEnv(book), "/browse", { owner: OWNER, steps: [{ do: "goto", url: "https://wwws.airfrance.com/check-in" }], keep: true }, api.fetcher, driveThrows);
    expect(response.status).toBe(502);
    expect(api.calls.some((call) => call.method === "PATCH" && call.body && (call.body as { action?: string }).action === "stop")).toBe(true);
    const text = JSON.stringify(await response.json());
    expect(text).not.toContain("live.browser-use");
    expect(text).not.toContain("wss://");
  });

  it("stops a kept session on close, and not before", async () => {
    const book = new BrowseLedger(kv());
    const api = vendor();
    const env = ledgerEnv(book);
    const response = await browseOnBrowserUse(env, "/browse", { owner: OWNER, steps: [{ do: "goto", url: "https://wwws.airfrance.com/check-in" }], keep: true }, api.fetcher, driveOk);
    expect(response.status).toBe(200);
    const body = JSON.stringify(await response.json());
    expect(body).not.toContain("liveUrl");
    expect(body).not.toContain("live.browser-use");
    expect(body).not.toContain("wss://");
    expect(api.calls.some((call) => call.method === "PATCH")).toBe(false);
    await browseOnBrowserUse(env, "/browse/close", { owner: OWNER }, api.fetcher, driveOk);
    const stops = api.calls.filter((call) => call.method === "PATCH");
    expect(stops).toHaveLength(1);
    expect(stops[0].body).toEqual({ action: "stop" });
    expect((await book.spent()).dayUsd).toBeCloseTo(0.012);
  });

  it("stops when the caller does not keep the session", async () => {
    const book = new BrowseLedger(kv());
    const api = vendor();
    await browseOnBrowserUse(ledgerEnv(book), "/browse", { owner: OWNER, steps: [{ do: "read" }], keep: false }, api.fetcher, driveOk);
    expect(api.calls.filter((call) => call.method === "PATCH")).toHaveLength(1);
  });

  it("charges a full day when the cost cannot be read, so the next job is refused", async () => {
    const book = new BrowseLedger(kv());
    const api = vendor();
    const blind = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith("/cost")) return new Response("no", { status: 404 });
      return api.fetcher(input, init);
    }) as typeof fetch;
    await browseOnBrowserUse(ledgerEnv(book), "/browse", { owner: OWNER, steps: [{ do: "read" }], keep: false }, blind, driveOk);
    expect((await book.spent()).dayUsd).toBe(1);
    const again = vendor();
    const response = await browseOnBrowserUse(ledgerEnv(book), "/browse", { owner: OWNER, steps: [{ do: "read" }] }, again.fetcher, driveOk);
    expect((await response.json() as { reason?: string }).reason).toMatch(/day cap/);
  });
});

describe("the block log", () => {
  it("counts site blocks and Browser Use sessions, and drops a path", () => {
    const rows: BrowseLogRow[] = [
      { at: 1, kind: "job", provider: "browserbase", host: "wwws.airfrance.com", outcome: "site_blocked", reason: "403", trigger: "403", durationMs: 1000, fallback: { ran: true, outcome: "ok", costUsd: 0.01 } },
      { at: 2, kind: "call", provider: "browser-use", host: "wwws.airfrance.com", outcome: "ok", durationMs: 8000, costUsd: 0.012, proxyMb: 2.5 },
      { at: 3, kind: "call", provider: "browserbase", host: "", outcome: "vendor_refused", durationMs: 40 },
      { at: 4, kind: "job", provider: "browserbase", host: "shop.example", outcome: "ok", durationMs: 500, fallback: { ran: false } },
    ];
    expect(summarizeBrowseLog(rows)).toMatchObject({ jobs: 2, blocks: 1, byReason: { "403": 1 }, fallbacks: 1, vendorRefused: 1, fallbackCostUsd: 0.012 });
    const after = summarizeBrowseLog([...rows, { at: 5, kind: "call", provider: "browserbase", host: "wwws.airfrance.com", outcome: "site_blocked", reason: "403", durationMs: 200 }]);
    expect(after.blocks).toBe(2);
    expect(after.byReason["403"]).toBe(2);
  });
});

describe("documentForbidden", () => {
  it("is a 403 on the document host only", () => {
    const entries = [
      { method: "Page.frameNavigated", request: { params: { frame: { url: "https://wwws.airfrance.com/check-in" } } } },
      { method: "Network.responseReceived", request: { params: { response: { url: "https://wwws.airfrance.com/check-in", status: 403 } } } },
      { method: "Network.responseReceived", request: { params: { response: { url: "https://cdn.example/app.js", status: 403 } } } },
    ];
    expect(documentForbidden(digestLogs(entries))).toEqual({ reason: "403", host: "wwws.airfrance.com" });
    const thirdParty = [
      { method: "Page.frameNavigated", request: { params: { frame: { url: "https://shop.example/" } } } },
      { method: "Network.responseReceived", request: { params: { response: { url: "https://cdn.example/app.js", status: 403 } } } },
    ];
    expect(documentForbidden(digestLogs(thirdParty))).toBeNull();
  });
});
