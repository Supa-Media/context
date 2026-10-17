import { describe, expect, it } from "vitest";
import type { Fetch } from "./clients";
import { runDueHeartbeats, runHeartbeat, type DueHeartbeat } from "./heartbeats";
import type { PhoneTexted } from "./routines";

const beat = (runId: string, over: Partial<DueHeartbeat> = {}): DueHeartbeat => ({
  runId,
  accessToken: `grant_${runId}`,
  timeZone: "Europe/London",
  since: null,
  phones: [`+1555000${runId.length}`],
  ...over,
});

function harness(opts: {
  heartbeats: unknown;
  gateway?: (token: string, body: any) => Response;
  texted?: (phone: string) => PhoneTexted;
  configured?: boolean;
}) {
  const calls: { path: string; auth: string | null; body: any }[] = [];
  const results: { runId: string; outcome: string }[] = [];
  const texts: { phone: string; text: string; key: string }[] = [];
  const logs: Record<string, unknown>[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body));
    const auth = new Headers(init.headers).get("authorization");
    calls.push({ path, auth, body });
    if (path === "/agent-texts/heartbeats/due") return Response.json({ heartbeats: opts.heartbeats });
    if (path === "/agent-texts/heartbeats/result") {
      results.push(body);
      return Response.json({ status: "recorded" });
    }
    if (path === "/agent") {
      const token = (auth ?? "").replace(/^Bearer /, "");
      return (opts.gateway ?? (() => Response.json({ outcome: "quiet" })))(token, body);
    }
    throw new Error(`unexpected ${path}`);
  }) as unknown as Fetch;
  const configured = opts.configured !== false;
  const run = () =>
    runDueHeartbeats({
      fetch: fetcher,
      controlPlaneOrigin: configured ? "https://cp.example.invalid" : undefined,
      workerSecret: "worker-secret",
      gatewayOrigin: "https://gw.example.invalid",
      textPhone: async (phone, text, key) => {
        texts.push({ phone, text, key });
        return opts.texted ? opts.texted(phone) : "texted";
      },
      log: (entry) => logs.push(entry),
    });
  return { run, calls, results, texts, logs };
}

const byRun = (list: { runId: string; outcome: string }[]) => [...list].sort((x, y) => x.runId.localeCompare(y.runId));

describe("a tick of check-ins", () => {
  it("looks for each with its own grant, texts only what the gateway said, and reports a code", async () => {
    const h = harness({
      heartbeats: [beat("a", { since: 1700000000000, phones: ["+15550001", "+15550002"] }), beat("bb")],
      gateway: (token) =>
        token === "grant_a" ? Response.json({ outcome: "speak", answer: "Found the image you asked for." }) : Response.json({ outcome: "quiet" }),
    });
    await h.run();
    const asked = h.calls.filter((call) => call.path === "/agent");
    expect(asked.map((call) => call.auth).sort()).toEqual(["Bearer grant_a", "Bearer grant_bb"]);
    expect(asked.find((call) => call.auth === "Bearer grant_a")!.body).toEqual({
      heartbeat: { timeZone: "Europe/London", since: 1700000000000 },
    });
    expect(h.texts).toEqual([
      { phone: "+15550001", text: "Found the image you asked for.", key: "heartbeat:a:+15550001" },
      { phone: "+15550002", text: "Found the image you asked for.", key: "heartbeat:a:+15550002" },
    ]);
    expect(byRun(h.results)).toEqual([
      { runId: "a", outcome: "texted" },
      { runId: "bb", outcome: "quiet" },
    ]);
    // The control plane's calls carry the Worker's secret, never a check-in's grant.
    for (const call of h.calls.filter((c) => c.path !== "/agent")) expect(call.auth).toBe("Bearer worker-secret");
  });

  it("something to say and no chat to say it in is no_chat; a refused send is failed", async () => {
    const noChat = harness({
      heartbeats: [beat("a")],
      gateway: () => Response.json({ outcome: "speak", answer: "hi" }),
      texted: () => "no_chat",
    });
    await noChat.run();
    expect(noChat.results).toEqual([{ runId: "a", outcome: "no_chat" }]);
    const refused = harness({
      heartbeats: [beat("a")],
      gateway: () => Response.json({ outcome: "speak", answer: "hi" }),
      texted: () => "failed",
    });
    await refused.run();
    expect(refused.results).toEqual([{ runId: "a", outcome: "failed" }]);
  });

  it("a malformed check-in is dropped, and nothing runs unconfigured", async () => {
    const h = harness({ heartbeats: [{ runId: "x" }, beat("ok")] });
    await h.run();
    expect(h.results).toEqual([{ runId: "ok", outcome: "quiet" }]);
    const quiet = harness({ heartbeats: [beat("a")], configured: false });
    await quiet.run();
    expect(quiet.calls).toEqual([]);
  });

  it("logs ids, outcomes and times, never a grant, a phone or the text", async () => {
    const h = harness({
      heartbeats: [beat("a", { phones: ["+15550009"] })],
      gateway: () => Response.json({ outcome: "speak", answer: "your secret plan" }),
    });
    await h.run();
    const logged = JSON.stringify(h.logs);
    expect(logged).not.toContain("grant_a");
    expect(logged).not.toContain("+15550009");
    expect(logged).not.toContain("secret plan");
  });
});

describe("one look", () => {
  const fetchAnswering = (response: Response | Error) =>
    (async () => {
      if (response instanceof Error) throw response;
      return response;
    }) as unknown as Fetch;

  it("reads the gateway's answers and refusals as codes, and anything else as failed", async () => {
    const look = (response: Response | Error) => runHeartbeat(fetchAnswering(response), "https://gw", beat("a"));
    expect(await look(Response.json({ outcome: "speak", answer: "x" }))).toEqual({ outcome: "speak", answer: "x" });
    expect(await look(Response.json({ outcome: "speak", answer: "  " }))).toEqual({ outcome: "failed" });
    expect(await look(Response.json({ outcome: "nothing_new" }))).toEqual({ outcome: "nothing_new" });
    expect(await look(Response.json({ outcome: "paused" }))).toEqual({ outcome: "paused" });
    expect(await look(Response.json({ outcome: "texted" }))).toEqual({ outcome: "failed" });
    expect(await look(Response.json({}, { status: 409 }))).toEqual({ outcome: "no_provider" });
    expect(await look(Response.json({}, { status: 429 }))).toEqual({ outcome: "daily_limit" });
    expect(await look(Response.json({}, { status: 503 }))).toEqual({ outcome: "failed" });
    expect(await look(new Error("down"))).toEqual({ outcome: "failed" });
  });
});
