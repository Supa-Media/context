import { describe, expect, it } from "vitest";
import { runRoutine, type Fetch } from "./clients";
import { accept, CHAT_KEY } from "./inbox";
import { MemoryStorage } from "./memoryStorage.testing";
import type { Message } from "./reply";
import { runDueRoutines, textRoutine, type PhoneTexted, type RoutineDeps } from "./routines";

const ANSWER = "Your **plan** for today\n\nsecond paragraph";
const PHONE_A = "+15555550100";
const PHONE_B = "+15555550101";

type DueRun = {
  runId: string;
  accessToken: string;
  path: string;
  timeZone: string;
  send: "text" | "note" | "both";
  phones: string[];
};

const due = (runId: string, over: Partial<DueRun> = {}): DueRun => ({
  runId,
  accessToken: `grant_${runId}`,
  path: `routines/daily/${runId}.md`,
  timeZone: "Europe/London",
  send: "text",
  phones: [PHONE_A],
  ...over,
});

type Gateway = (token: string) => Response | Promise<Response>;

function harness(opts: {
  runs: DueRun[] | (() => Response);
  gateway?: Gateway;
  textPhone?: RoutineDeps["textPhone"];
  configured?: boolean;
}) {
  const calls: { path: string; auth: string | null; body: any }[] = [];
  const results: { runId: string; outcome: string; texted: number }[] = [];
  const texts: { phone: string; text: string; key: string }[] = [];
  const logs: Record<string, unknown>[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body));
    const auth = new Headers(init.headers).get("authorization");
    calls.push({ path, auth, body });
    if (path === "/agent-texts/routines/due") {
      return typeof opts.runs === "function" ? opts.runs() : Response.json({ runs: opts.runs });
    }
    if (path === "/agent-texts/routines/result") {
      results.push(body);
      return Response.json({ ok: true });
    }
    if (path === "/agent") {
      const token = (auth ?? "").replace(/^Bearer /, "");
      return (opts.gateway ?? (() => Response.json({ outcome: "answered", answer: ANSWER, send: "text" })))(token);
    }
    throw new Error(`unexpected ${path}`);
  }) as unknown as Fetch;
  const configured = opts.configured ?? true;
  const deps: RoutineDeps = {
    fetch: fetcher,
    controlPlaneOrigin: configured ? "https://cp.example" : "",
    workerSecret: configured ? "worker-secret" : undefined,
    gatewayOrigin: "https://gw.example",
    textPhone:
      opts.textPhone ??
      (async (phone, text, key) => {
        texts.push({ phone, text, key });
        return "texted";
      }),
    log: (entry) => logs.push(entry),
  };
  return { deps, calls, results, texts, logs };
}

describe("runDueRoutines", () => {
  it("pulls due runs, runs each with its own grant, texts the answer and reports a count", async () => {
    const h = harness({ runs: [due("r1", { phones: [PHONE_A, PHONE_B] })] });
    await runDueRoutines(h.deps);

    const pull = h.calls.find((c) => c.path === "/agent-texts/routines/due");
    expect(pull?.auth).toBe("Bearer worker-secret");
    expect(pull?.body).toEqual({});

    const ran = h.calls.find((c) => c.path === "/agent");
    expect(ran?.auth).toBe("Bearer grant_r1");
    expect(ran?.body).toEqual({ routine: { path: "routines/daily/r1.md", timeZone: "Europe/London" } });

    expect(h.texts).toEqual([
      { phone: PHONE_A, text: ANSWER, key: `routine:r1:${PHONE_A}` },
      { phone: PHONE_B, text: ANSWER, key: `routine:r1:${PHONE_B}` },
    ]);
    expect(h.results).toEqual([{ runId: "r1", outcome: "answered", texted: 2 }]);
    const report = h.calls.find((c) => c.path === "/agent-texts/routines/result");
    expect(report?.auth).toBe("Bearer worker-secret");
  });

  it("texts a finished routine's last answer too", async () => {
    const h = harness({
      runs: [due("r1")],
      gateway: () => Response.json({ outcome: "finished", answer: "It shipped.", send: "text" }),
    });
    await runDueRoutines(h.deps);
    expect(h.texts.map((t) => t.text)).toEqual(["It shipped."]);
    expect(h.results).toEqual([{ runId: "r1", outcome: "finished", texted: 1 }]);
  });

  it("texts nobody when the run skipped or was paused", async () => {
    const h = harness({
      runs: [due("skip"), due("pause")],
      gateway: (token) =>
        token === "grant_skip"
          ? Response.json({ outcome: "skipped", answer: "", skipped: true, send: "text" })
          : Response.json({ outcome: "paused", skipped: true }),
    });
    await runDueRoutines(h.deps);
    expect(h.texts).toEqual([]);
    expect(h.results.sort((a, b) => a.runId.localeCompare(b.runId))).toEqual([
      { runId: "pause", outcome: "paused", texted: 0 },
      { runId: "skip", outcome: "skipped", texted: 0 },
    ]);
  });

  it("texts nobody when the routine says send: note, whichever side says it", async () => {
    const h = harness({
      runs: [due("cp", { send: "note" }), due("gw", { send: "text" })],
      gateway: (token) =>
        Response.json({ outcome: "answered", answer: ANSWER, send: token === "grant_gw" ? "note" : undefined }),
    });
    await runDueRoutines(h.deps);
    expect(h.texts).toEqual([]);
    expect(h.results.map((r) => [r.outcome, r.texted])).toEqual([
      ["answered", 0],
      ["answered", 0],
    ]);
  });

  it("texts for send: both", async () => {
    const h = harness({
      runs: [due("r1", { send: "both" })],
      gateway: () => Response.json({ outcome: "answered", answer: ANSWER, send: "both" }),
    });
    await runDueRoutines(h.deps);
    expect(h.results).toEqual([{ runId: "r1", outcome: "answered", texted: 1 }]);
  });

  it("reports no_chat when the answer needed a text and no phone had texted first", async () => {
    const h = harness({ runs: [due("r1", { phones: [PHONE_A, PHONE_B] })], textPhone: async () => "no_chat" });
    await runDueRoutines(h.deps);
    expect(h.results).toEqual([{ runId: "r1", outcome: "no_chat", texted: 0 }]);

    const none = harness({ runs: [due("r2", { phones: [] })] });
    await runDueRoutines(none.deps);
    expect(none.results).toEqual([{ runId: "r2", outcome: "no_chat", texted: 0 }]);
  });

  it("counts only the phones it reached", async () => {
    const reached: Record<string, PhoneTexted> = { [PHONE_A]: "no_chat", [PHONE_B]: "texted" };
    const h = harness({ runs: [due("r1", { phones: [PHONE_A, PHONE_B] })], textPhone: async (p) => reached[p] });
    await runDueRoutines(h.deps);
    expect(h.results).toEqual([{ runId: "r1", outcome: "answered", texted: 1 }]);
  });

  it("maps every gateway refusal to its code", async () => {
    const replies: Record<string, () => Response> = {
      gone: () => Response.json({ error: "routine_gone" }, { status: 404 }),
      notone: () => Response.json({ error: "not_a_routine" }, { status: 400 }),
      invalid: () => Response.json({ error: "invalid_request" }, { status: 400 }),
      provider: () => Response.json({ error: "no_provider" }, { status: 409 }),
      limit: () => Response.json({ error: "daily_limit" }, { status: 429 }),
      model: () => Response.json({ error: "model_unavailable" }, { status: 502 }),
      down: () => Response.json({ error: "model_unavailable" }, { status: 503 }),
      garbled: () => new Response("<html>", { status: 200 }),
      odd: () => Response.json({ outcome: "something_else", answer: "x" }),
      failed: () => Response.json({ outcome: "failed", answer: "" }),
    };
    const h = harness({
      runs: Object.keys(replies).map((id) => due(id)),
      gateway: (token) => replies[token.replace("grant_", "")](),
    });
    await runDueRoutines(h.deps);
    const by = Object.fromEntries(h.results.map((r) => [r.runId, r.outcome]));
    expect(by).toEqual({
      gone: "routine_gone",
      notone: "not_a_routine",
      invalid: "failed",
      provider: "no_provider",
      limit: "daily_limit",
      model: "failed",
      down: "failed",
      garbled: "failed",
      odd: "failed",
      failed: "failed",
    });
    expect(h.texts).toEqual([]);
  });

  it("maps a gateway it cannot reach to failed", async () => {
    const throwing = (async () => {
      throw new Error("network down");
    }) as unknown as Fetch;
    expect(await runRoutine(throwing, "https://gw.example", "t", { path: "p", timeZone: "UTC" })).toEqual({
      outcome: "failed",
      answer: "",
      send: null,
    });
  });

  it("keeps going when one run fails in a way nobody planned for", async () => {
    const h = harness({
      runs: [due("r1"), due("r2"), due("r3"), due("r4"), due("r5"), due("r6")],
      textPhone: async (phone, text, key) => {
        if (key.startsWith("routine:r2:")) throw new Error("inbox exploded");
        h.texts.push({ phone, text, key });
        return "texted";
      },
    });
    await runDueRoutines(h.deps);
    const by = Object.fromEntries(h.results.map((r) => [r.runId, r.outcome]));
    expect(by).toEqual({
      r1: "answered",
      r2: "failed",
      r3: "answered",
      r4: "answered",
      r5: "answered",
      r6: "answered",
    });
    expect(h.texts).toHaveLength(5);
  });

  it("keeps going when a report or the gateway throws for one run", async () => {
    let reports = 0;
    const h = harness({ runs: [due("r1"), due("r2")] });
    const inner = h.deps.fetch;
    h.deps.fetch = (async (url: string, init: RequestInit) => {
      if (new URL(url).pathname === "/agent-texts/routines/result" && reports++ === 0) {
        throw new Error("control plane down");
      }
      return inner(url, init);
    }) as unknown as Fetch;
    await runDueRoutines(h.deps);
    expect(h.texts).toHaveLength(2);
    expect(h.results).toHaveLength(1);
    expect(h.logs.some((l) => l.event === "routine_result" && l.error === "unreachable")).toBe(true);
  });

  it("runs no more than four at once", async () => {
    let running = 0;
    let most = 0;
    const h = harness({
      runs: Array.from({ length: 10 }, (_, i) => due(`r${i}`)),
      gateway: async () => {
        running++;
        most = Math.max(most, running);
        await new Promise((resolve) => setTimeout(resolve, 2));
        running--;
        return Response.json({ outcome: "skipped", answer: "" });
      },
    });
    await runDueRoutines(h.deps);
    expect(h.results).toHaveLength(10);
    expect(most).toBe(4);
  });

  it("does nothing, quietly, without a control plane to ask", async () => {
    const h = harness({ runs: [due("r1")], configured: false });
    await runDueRoutines(h.deps);
    expect(h.calls).toEqual([]);
    expect(h.logs).toEqual([{ event: "routines_due", skipped: "unconfigured" }]);
  });

  it("does nothing when the control plane cannot be reached or answers nonsense", async () => {
    for (const reply of [
      () => new Response(null, { status: 503 }),
      () => Response.json({ nope: true }),
    ]) {
      const h = harness({ runs: reply });
      await runDueRoutines(h.deps);
      expect(h.calls.map((c) => c.path)).toEqual(["/agent-texts/routines/due"]);
      expect(h.logs[0]).toMatchObject({ event: "routines_due", error: "unreachable" });
    }
  });

  it("drops a malformed run and a phone that is not a number", async () => {
    const h = harness({
      runs: [
        { runId: "bad" } as DueRun,
        due("r1", { send: "loud" as DueRun["send"] }),
        due("r2", { phones: [PHONE_A, "chat_1/../x", PHONE_A] }),
      ],
    });
    await runDueRoutines(h.deps);
    expect(h.results.map((r) => r.runId)).toEqual(["r2"]);
    expect(h.texts.map((t) => t.phone)).toEqual([PHONE_A]);
  });

  it("never logs or reports the answer, the grant, the path or a phone", async () => {
    const h = harness({ runs: [due("r1", { phones: [PHONE_A, PHONE_B] }), due("r2")] });
    await runDueRoutines(h.deps);
    const said = JSON.stringify(h.logs) + JSON.stringify(h.results);
    for (const secret of ["plan", "paragraph", "grant_r1", "routines/daily", PHONE_A, PHONE_B, "worker-secret"]) {
      expect(said).not.toContain(secret);
    }
    const reports = h.calls.filter((c) => c.path === "/agent-texts/routines/result");
    for (const report of reports) expect(Object.keys(report.body).sort()).toEqual(["outcome", "runId", "texted"]);
  });
});

// ── The inbox's side ──────────────────────────────────────────────────────

const msg = (over: Partial<Message> = {}): Message => ({
  kind: "message",
  eventId: "e1",
  chatId: "chat_1",
  from: PHONE_A,
  messageId: "m1",
  text: "a secret question",
  ...over,
});

type Sent = { url: string; text: string; key: string };

function linq(sent: Sent[], status: (n: number) => number = () => 200): Fetch {
  let n = 0;
  return (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    const code = status(n++);
    if (code < 300) sent.push({ url, text: body.message.parts[0].value, key: body.message.idempotency_key });
    return new Response("{}", { status: code });
  }) as unknown as Fetch;
}

describe("the chat a routine texts", () => {
  it("is remembered when a text is accepted, without the text", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg(), 1_000);
    expect(storage.data.get(CHAT_KEY)).toEqual({ chatId: "chat_1", at: 1_000 });
    await accept(storage, msg({ eventId: "e2", chatId: "chat_2" }), 2_000);
    expect(storage.data.get(CHAT_KEY)).toEqual({ chatId: "chat_2", at: 2_000 });
    expect(JSON.stringify(storage.data.get(CHAT_KEY))).not.toContain("secret");
  });

  it("is not changed by a redelivered webhook", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg(), 1_000);
    await accept(storage, msg({ chatId: "chat_other" }), 2_000);
    expect(storage.data.get(CHAT_KEY)).toEqual({ chatId: "chat_1", at: 1_000 });
  });

  it("gets the answer as texts, split like a reply, with keys of their own", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg(), 1_000);
    const sent: Sent[] = [];
    const status = await textRoutine(
      storage,
      { text: ANSWER, idempotencyKey: "routine:r1:+15555550100" },
      { fetch: linq(sent), linqApiKey: "k", now: () => 2_000, simulator: false },
    );
    expect(status).toBe("texted");
    expect(sent).toEqual([
      { url: expect.stringContaining("/chats/chat_1/messages"), text: "Your plan for today", key: "routine:r1:+15555550100" },
      { url: expect.stringContaining("/chats/chat_1/messages"), text: "second paragraph", key: "routine:r1:+15555550100:1" },
    ]);
    // Nothing of the answer is kept.
    expect(JSON.stringify([...storage.data.values()])).not.toContain("plan");
  });

  it("is no_chat for a phone that never texted", async () => {
    const sent: Sent[] = [];
    const status = await textRoutine(
      new MemoryStorage(),
      { text: ANSWER, idempotencyKey: "k" },
      { fetch: linq(sent), linqApiKey: "k", now: () => 1, simulator: false },
    );
    expect(status).toBe("no_chat");
    expect(sent).toEqual([]);
  });

  it("is failed when Linq refuses the first text", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg(), 1_000);
    const status = await textRoutine(
      storage,
      { text: ANSWER, idempotencyKey: "k" },
      { fetch: linq([], () => 503), linqApiKey: "k", now: () => 1, simulator: false },
    );
    expect(status).toBe("failed");
  });

  it("lands in the simulator's log for a simulated chat, and only while the simulator is on", async () => {
    const storage = new MemoryStorage();
    await accept(storage, msg({ channel: "simulator", chatId: "sim:+15555550100" }), 1_000);
    const sent: Sent[] = [];
    const deps = { fetch: linq(sent), linqApiKey: "k", now: () => 2_000, simulator: false };
    expect(await textRoutine(storage, { text: "hello", idempotencyKey: "k" }, deps)).toBe("no_chat");
    expect(await textRoutine(storage, { text: "hello", idempotencyKey: "k" }, { ...deps, simulator: true })).toBe("texted");
    expect(sent).toEqual([]);
    const log = [...(await storage.list<{ text: string }>({ prefix: "sim:log:" })).values()];
    expect(log.map((e) => e.text)).toEqual(["hello"]);
  });
});
