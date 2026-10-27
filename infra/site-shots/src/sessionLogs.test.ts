import { describe, expect, it } from "vitest";
import { browseOnBrowserbase } from "./browserbaseRoute";
import { DIGEST_LIMIT, digestLogs, hostOf, reportFailedRun } from "./sessionLogs";

const ENV = { BROWSERBASE_API_KEY: "bb_test_key", BROWSERBASE_PROJECT_ID: "proj-test" };
const OWNER = "a".repeat(64);

/** Words a page or the person could have put in a log, none of which may reach ours. */
const SECRET = ["hunter2", "my-private-note", "dana@example.com", "Bank balance 4,210", "q=wool+socks"];

const event = (method: string, params: Record<string, unknown>) => ({ method, pageId: 1, sessionId: "bb-1", timestamp: 1, request: { timestamp: 1, params, rawBody: "" } });

const LOGS = [
  event("Page.frameNavigated", { frame: { id: "f1", url: "https://bank.example.com/accounts/my-private-note?email=dana@example.com" } }),
  event("Page.frameNavigated", { frame: { id: "f2", parentId: "f1", url: "https://ads.example/frame" } }),
  event("Page.frameNavigated", { frame: { id: "f3", url: "data:text/html,Bank balance 4,210" } }),
  event("Network.responseReceived", { response: { url: "https://bank.example.com/login?q=wool+socks", status: 403, statusText: "hunter2" } }),
  event("Network.responseReceived", { response: { url: "https://bank.example.com/api/session", status: 403 } }),
  event("Network.responseReceived", { response: { url: "https://cdn.example.com/app.js", status: 200 } }),
  event("Network.loadingFailed", { errorText: "net::ERR_BLOCKED_BY_CLIENT" }),
  event("Network.loadingFailed", { errorText: "hunter2" }),
  event("Runtime.consoleAPICalled", { type: "error", args: [{ value: "Bank balance 4,210" }] }),
  event("Runtime.consoleAPICalled", { type: "log", args: [{ value: "hunter2" }] }),
  event("Runtime.exceptionThrown", { exceptionDetails: { text: "my-private-note is undefined" } }),
  { method: "Input.insertText hunter2", request: { params: { text: "hunter2" } } },
  // Some entries keep their parameters only as a raw JSON body.
  { method: "Network.responseReceived", response: { rawBody: JSON.stringify({ params: { response: { url: "https://bank.example.com/x", status: 500 } } }) } },
];

describe("digestLogs", () => {
  it("keeps hosts, statuses, error codes and counts, and never a path, query, console text or typed word", () => {
    const digest = digestLogs(LOGS);
    expect(digest.hosts).toEqual(["bank.example.com"]);
    expect(digest.failed).toEqual([
      { host: "bank.example.com", status: 403, n: 2 },
      { host: "bank.example.com", status: 500, n: 1 },
    ]);
    expect(digest.unreachable).toEqual({ "net::ERR_BLOCKED_BY_CLIENT": 1, other: 1 });
    expect(digest.consoleErrors).toBe(1);
    expect(digest.exceptions).toBe(1);
    expect(digest.events).toBe(LOGS.length);
    expect(digest.methods["Network.responseReceived"]).toBe(4);
    const text = JSON.stringify(digest);
    for (const secret of SECRET) expect(text).not.toContain(secret);
    expect(text).not.toContain("/accounts");
    expect(text).not.toContain("Input.insertText");
  });

  it("is bounded however noisy the page", () => {
    const noisy = Array.from({ length: 500 }, (_, i) => event("Network.responseReceived", { response: { url: `https://h${i}.example/`, status: 404 } }));
    noisy.push(...Array.from({ length: 50 }, (_, i) => event("Page.frameNavigated", { frame: { url: `https://p${i}.example/` } })));
    const digest = digestLogs(noisy);
    expect(digest.failed).toHaveLength(DIGEST_LIMIT);
    expect(digest.hosts).toHaveLength(DIGEST_LIMIT);
  });

  it("takes anything that is not a log without throwing", () => {
    for (const junk of [null, "x", {}, [null, 1, "a", { method: 5 }]]) expect(digestLogs(junk).failed).toEqual([]);
  });

  it("reads a host only off a web address", () => {
    expect(hostOf("https://a.example/p?q=1")).toBe("a.example");
    expect(hostOf("blob:https://a.example/123")).toBeNull();
    expect(hostOf("data:text/html,hi")).toBeNull();
    expect(hostOf("javascript:alert(1)")).toBeNull();
  });
});

describe("reportFailedRun", () => {
  it("logs the session id with the digest, asking Browserbase for its log with the key", async () => {
    const seen: Array<{ url: string; key: string | null }> = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push({ url: String(input), key: new Headers(init?.headers).get("X-BB-API-Key") });
      return Response.json(LOGS);
    }) as typeof fetch;
    const lines: string[] = [];
    await reportFailedRun(ENV, { session: "bb-1", stage: "steps", steps: ["goto", "click"], ms: 5 }, fetcher, (l) => lines.push(l));
    expect(seen).toEqual([{ url: "https://api.browserbase.com/v1/sessions/bb-1/logs", key: "bb_test_key" }]);
    const logged = JSON.parse(lines[0]);
    expect(logged).toMatchObject({ event: "site_shots_browse_failed", session: "bb-1", stage: "steps", logs: { hosts: ["bank.example.com"] } });
    for (const secret of SECRET) expect(lines[0]).not.toContain(secret);
    expect(lines[0]).not.toContain("bb_test_key");
  });

  it("still logs the failure when Browserbase gives no log", async () => {
    const lines: string[] = [];
    const fetcher = (async () => new Response("{\"error\":\"account 123\"}", { status: 500 })) as unknown as typeof fetch;
    await reportFailedRun(ENV, { session: "bb-1", stage: "run", steps: ["read"], ms: 1 }, fetcher, (l) => lines.push(l));
    expect(JSON.parse(lines[0]).logs).toBeNull();
    expect(lines[0]).not.toContain("account 123");
  });
});

describe("browseOnBrowserbase on a failed run", () => {
  function api() {
    const calls: string[] = [];
    let release = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (new Headers(init?.headers).get("Upgrade") === "websocket") throw new Error("gone");
      if (url.endsWith("/sessions?status=RUNNING")) return Response.json([]);
      if (url.endsWith("/sessions") && init?.method === "POST") return Response.json({ id: "new-1", connectUrl: "wss://connect.example/new-1" });
      // The log answers only once the test lets it: the answer must not be waiting on it.
      if (url.endsWith("/logs")) return gate.then(() => Response.json(LOGS));
      return Response.json({});
    }) as typeof fetch;
    return { calls, fetcher, release };
  }

  it("hands the log read to `later`, so the answer never waits on it, and never asks for the live-view link", async () => {
    const { calls, fetcher, release } = api();
    const pending: Array<Promise<unknown>> = [];
    const response = await browseOnBrowserbase(ENV, "/browse", { owner: OWNER, steps: [{ do: "read" }] }, fetcher, (work) => pending.push(work));
    expect(response.status).toBe(410);
    expect(pending).toHaveLength(1);
    release();
    await Promise.all(pending);
    expect(calls.filter((u) => u.endsWith("/logs"))).toEqual(["https://api.browserbase.com/v1/sessions/new-1/logs"]);
    expect(calls.some((u) => u.endsWith("/debug"))).toBe(false);
    const body = JSON.stringify(await response.json());
    for (const secret of SECRET) expect(body).not.toContain(secret);
    expect(body).not.toContain("bank.example.com");
  });
});
