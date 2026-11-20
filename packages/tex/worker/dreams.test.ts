import { describe, expect, it } from "vitest";
import type { Fetch } from "./clients";
import { runDueDreams, runDream, type DueDream } from "./dreams";

const dream = (runId: string, over: Partial<DueDream> = {}): DueDream => ({
  runId,
  accessToken: `grant_${runId}`,
  timeZone: "Europe/London",
  since: null,
  ...over,
});

function harness(opts: { dreams: unknown; gateway?: (token: string, body: any) => Response; configured?: boolean }) {
  const calls: { path: string; auth: string | null; body: any }[] = [];
  const results: { runId: string; outcome: string }[] = [];
  const logs: Record<string, unknown>[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body));
    const auth = new Headers(init.headers).get("authorization");
    calls.push({ path, auth, body });
    if (path === "/agent-texts/dreams/due") return Response.json({ dreams: opts.dreams });
    if (path === "/agent-texts/dreams/result") {
      results.push(body);
      return Response.json({ status: "recorded" });
    }
    if (path === "/agent") {
      const token = (auth ?? "").replace(/^Bearer /, "");
      return (opts.gateway ?? (() => Response.json({ outcome: "dreamed" })))(token, body);
    }
    throw new Error(`unexpected ${path}`);
  }) as unknown as Fetch;
  const configured = opts.configured !== false;
  const run = () =>
    runDueDreams({
      fetch: fetcher,
      controlPlaneOrigin: configured ? "https://cp.example.invalid" : undefined,
      workerSecret: "worker-secret",
      gatewayOrigin: "https://gw.example.invalid",
      log: (entry) => logs.push(entry),
    });
  return { run, calls, results, logs };
}

describe("a tick of dreams", () => {
  it("dreams each one with its own grant, and reports the code the gateway gave", async () => {
    const h = harness({
      dreams: [dream("a", { since: 1700000000000 }), dream("b")],
      gateway: (token) => Response.json({ outcome: token === "grant_a" ? "dreamed" : "nothing_new" }),
    });
    await h.run();
    const asked = h.calls.filter((call) => call.path === "/agent");
    expect(asked.map((call) => call.auth).sort()).toEqual(["Bearer grant_a", "Bearer grant_b"]);
    expect(asked.find((call) => call.auth === "Bearer grant_a")!.body).toEqual({
      dream: { timeZone: "Europe/London", since: 1700000000000 },
    });
    expect(h.results.sort((x, y) => x.runId.localeCompare(y.runId))).toEqual([
      { runId: "a", outcome: "dreamed" },
      { runId: "b", outcome: "nothing_new" },
    ]);
    // The control plane's calls carry the Worker's secret, never a dream's grant.
    for (const call of h.calls.filter((c) => c.path !== "/agent")) expect(call.auth).toBe("Bearer worker-secret");
  });

  it("a malformed dream is dropped, and nothing runs unconfigured", async () => {
    const h = harness({ dreams: [{ runId: "x" }, dream("ok")] });
    await h.run();
    expect(h.results).toEqual([{ runId: "ok", outcome: "dreamed" }]);
    const quiet = harness({ dreams: [dream("a")], configured: false });
    await quiet.run();
    expect(quiet.calls).toEqual([]);
  });

  it("logs ids, outcomes and times, never a grant", async () => {
    const h = harness({ dreams: [dream("a")] });
    await h.run();
    expect(JSON.stringify(h.logs)).not.toContain("grant_a");
  });
});

describe("one dream", () => {
  const fetchAnswering = (response: Response | Error) =>
    (async () => {
      if (response instanceof Error) throw response;
      return response;
    }) as unknown as Fetch;

  it("reads the gateway's refusals as codes, and anything else as failed", async () => {
    expect(await runDream(fetchAnswering(Response.json({ outcome: "unchanged" })), "https://gw", dream("a"))).toBe("unchanged");
    expect(await runDream(fetchAnswering(Response.json({ outcome: "something else" })), "https://gw", dream("a"))).toBe("failed");
    expect(await runDream(fetchAnswering(Response.json({}, { status: 409 })), "https://gw", dream("a"))).toBe("no_provider");
    expect(await runDream(fetchAnswering(Response.json({}, { status: 429 })), "https://gw", dream("a"))).toBe("daily_limit");
    expect(await runDream(fetchAnswering(Response.json({}, { status: 500 })), "https://gw", dream("a"))).toBe("failed");
    expect(await runDream(fetchAnswering(new Error("down")), "https://gw", dream("a"))).toBe("failed");
  });
});
