/**
 * The Tex page tile's browser check (./viewStatus.ts), against a fake
 * Browserbase API.
 *
 * Sabotage record (applied, run, named test seen failing, reverted):
 *  1. Matching the first running session instead of the owner's
 *     → "reports only the owner's browser" fails.
 *  2. Calling `touchIdle` (a page load keeping the browser awake)
 *     → "never connects, never takes a picture, never keeps the browser awake" fails.
 *  3. Returning the debug listing's `debuggerFullscreenUrl`
 *     → "never returns a session id, connect address or debugger link" fails.
 */

import { describe, expect, it } from "vitest";
import { viewStatus } from "./viewStatus";

const ENV = { BROWSERBASE_API_KEY: "bb_test_key", BROWSERBASE_PROJECT_ID: "proj-test" };
const OWNER = "a".repeat(64);
const OTHER = "b".repeat(64);
const MINE = { id: "mine", connectUrl: "wss://connect.example/mine", userMetadata: { owner: OWNER } };
const THEIRS = { id: "theirs", connectUrl: "wss://connect.example/theirs", userMetadata: { owner: OTHER } };
const DEBUG = {
  debuggerFullscreenUrl: "https://debugger.example/full",
  pages: [{ id: "p1", url: "https://www.opentable.com/r/somewhere", title: "Book", debuggerUrl: "https://debugger.example/p1" }],
};

function fakeApi({ running = [THEIRS, MINE] as unknown[], debug = DEBUG as unknown, debugStatus = 200 } = {}) {
  const calls: Array<{ method: string; url: string; upgrade: boolean }> = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ method: init?.method ?? "GET", url, upgrade: new Headers(init?.headers).get("Upgrade") === "websocket" });
    if (url.endsWith("/sessions?status=RUNNING")) return Response.json(running);
    if (url.endsWith("/debug")) return Response.json(debug, { status: debugStatus });
    return Response.json({ id: "new-1", connectUrl: "wss://connect.example/new-1" });
  }) as typeof fetch;
  return { calls, fetcher };
}

async function ask(body: unknown, api = fakeApi(), env: Record<string, unknown> = ENV) {
  const response = await viewStatus(env, body, api.fetcher);
  return { status: response.status, body: (await response.json()) as Record<string, unknown>, api };
}

describe("viewStatus", () => {
  it("answers not running without Browserbase, and asks nobody", async () => {
    const result = await ask({ owner: OWNER }, undefined, {});
    expect(result.body).toEqual({ running: false });
    expect(result.api.calls).toEqual([]);
  });

  it("refuses an owner that is not a tag, before any call", async () => {
    const result = await ask({ owner: "user_alice" });
    expect(result.status).toBe(400);
    expect(result.api.calls).toEqual([]);
  });

  it("reports only the owner's browser", async () => {
    expect((await ask({ owner: OWNER }, fakeApi({ running: [THEIRS] }))).body).toEqual({ running: false });
    const mine = await ask({ owner: OWNER });
    expect(mine.body).toEqual({ running: true, url: "https://www.opentable.com/r/somewhere" });
    expect(mine.api.calls.map((c) => c.url)).toContain("https://api.browserbase.com/v1/sessions/mine/debug");
    expect(mine.api.calls.some((c) => c.url.includes("/sessions/theirs"))).toBe(false);
  });

  it("never connects, never takes a picture, never keeps the browser awake", async () => {
    const touched: string[] = [];
    const idle = { idFromName: (name: string) => (touched.push(name), name), get: () => ({ touch: async () => undefined }) };
    const result = await ask({ owner: OWNER }, undefined, { ...ENV, BROWSER_IDLE: idle });
    expect(result.body.running).toBe(true);
    expect(touched).toEqual([]);
    expect(result.api.calls.every((c) => c.method === "GET" && !c.upgrade)).toBe(true);
    expect(result.api.calls).toHaveLength(2);
  });

  it("never returns a session id, connect address or debugger link", async () => {
    const text = JSON.stringify((await ask({ owner: OWNER })).body);
    expect(text).not.toContain("mine");
    expect(text).not.toContain("connect.example");
    expect(text).not.toContain("debugger.example");
  });

  it("still answers running when the page address cannot be read", async () => {
    expect((await ask({ owner: OWNER }, fakeApi({ debugStatus: 500 }))).body).toEqual({ running: true });
    expect((await ask({ owner: OWNER }, fakeApi({ debug: { pages: [{ url: "javascript:alert(1)" }] } }))).body).toEqual({ running: true });
  });

  it("answers not running when Browserbase cannot be asked", async () => {
    const failing = { calls: [], fetcher: (async () => new Response("no", { status: 503 })) as typeof fetch };
    expect((await ask({ owner: OWNER }, failing)).body).toEqual({ running: false });
  });
});
