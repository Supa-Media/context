import { describe, expect, it } from "vitest";
import type { Fetch } from "./clients";
import { runDueHousekeeping, runHousekeeping, type DueHousekeeping } from "./housekeeping";

const due = (runId: string, over: Partial<DueHousekeeping> = {}): DueHousekeeping => ({
  runId,
  accessToken: `grant_${runId}`,
  timeZone: "Europe/London",
  ...over,
});

function harness(opts: { runs: unknown; gateway?: (token: string, body: any) => Response; configured?: boolean }) {
  const calls: { path: string; auth: string | null; body: any }[] = [];
  const results: { runId: string; outcome: string }[] = [];
  const logs: Record<string, unknown>[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body));
    const auth = new Headers(init.headers).get("authorization");
    calls.push({ path, auth, body });
    if (path === "/agent-texts/housekeeping/due") return Response.json({ runs: opts.runs });
    if (path === "/agent-texts/housekeeping/result") {
      results.push(body);
      return Response.json({ status: "recorded" });
    }
    if (path === "/agent") {
      const token = (auth ?? "").replace(/^Bearer /, "");
      return (opts.gateway ?? (() => Response.json({ outcome: "tidied", changes: 1 })))(token, body);
    }
    throw new Error(`unexpected ${path}`);
  }) as unknown as Fetch;
  const configured = opts.configured !== false;
  const run = () =>
    runDueHousekeeping({
      fetch: fetcher,
      controlPlaneOrigin: configured ? "https://cp.example.invalid" : undefined,
      workerSecret: "worker-secret",
      gatewayOrigin: "https://gw.example.invalid",
      log: (entry) => logs.push(entry),
    });
  return { run, calls, results, logs };
}

describe("a tick of housekeeping", () => {
  it("runs each one with its own grant, and reports the code the gateway gave", async () => {
    const h = harness({
      runs: [due("a"), due("b")],
      gateway: (token) => Response.json({ outcome: token === "grant_a" ? "tidied" : "unchanged", changes: 0 }),
    });
    await h.run();
    const asked = h.calls.filter((call) => call.path === "/agent");
    expect(asked.map((call) => call.auth).sort()).toEqual(["Bearer grant_a", "Bearer grant_b"]);
    expect(asked[0]!.body).toEqual({ housekeeping: { timeZone: "Europe/London" } });
    expect(h.results.sort((x, y) => x.runId.localeCompare(y.runId))).toEqual([
      { runId: "a", outcome: "tidied" },
      { runId: "b", outcome: "unchanged" },
    ]);
    // The control plane's calls carry the Worker's secret, never a run's grant.
    for (const call of h.calls.filter((c) => c.path !== "/agent")) expect(call.auth).toBe("Bearer worker-secret");
  });

  it("a malformed run is dropped, and nothing runs unconfigured", async () => {
    const h = harness({ runs: [{ runId: "x" }, due("ok")] });
    await h.run();
    expect(h.results).toEqual([{ runId: "ok", outcome: "tidied" }]);
    const quiet = harness({ runs: [due("a")], configured: false });
    await quiet.run();
    expect(quiet.calls).toEqual([]);
  });

  it("logs ids, outcomes and counts, never a grant or what changed", async () => {
    const h = harness({
      runs: [due("a")],
      gateway: () => Response.json({ outcome: "tidied", changes: 1, line: "Archived the secret plan.", log: "tex/housekeeping/secret.md" }),
    });
    await h.run();
    const logged = JSON.stringify(h.logs);
    expect(logged).not.toContain("grant_a");
    expect(logged).not.toContain("secret");
    expect(h.logs).toContainEqual(expect.objectContaining({ event: "housekeeping_run", outcome: "tidied", changes: 1 }));
  });
});

describe("one run", () => {
  const fetchAnswering = (response: Response | Error) =>
    (async () => {
      if (response instanceof Error) throw response;
      return response;
    }) as unknown as Fetch;
  const outcomeOf = async (response: Response | Error) => (await runHousekeeping(fetchAnswering(response), "https://gw", due("a"))).outcome;

  it("reads the gateway's refusals as codes, and anything else as failed", async () => {
    expect(await outcomeOf(Response.json({ outcome: "unchanged" }))).toBe("unchanged");
    expect(await outcomeOf(Response.json({ outcome: "failed" }))).toBe("failed");
    expect(await outcomeOf(Response.json({ outcome: "something else" }))).toBe("failed");
    expect(await outcomeOf(Response.json({}, { status: 409 }))).toBe("no_provider");
    expect(await outcomeOf(Response.json({}, { status: 429 }))).toBe("daily_limit");
    expect(await outcomeOf(Response.json({ outcome: "failed" }, { status: 502 }))).toBe("failed");
    expect(await outcomeOf(new Error("down"))).toBe("failed");
  });
});
