/**
 * Sabotage record (run 2026-11-14, reverted before this file was committed):
 *   1. jobStub's non-spawn branch skips the `/job-here` check: `if (await gatewayHolds(binding, name))` replaced by
 *      `if (true)`. Failing (6): "here:false sends the call to the SenderInbox", "here must be exactly true", "a failed
 *      here check keeps the call in the SenderInbox", "here:true ... passes its answer back" (the here check's own
 *      request was never sent, so the call order differed), and the two JOBS=gateway / JOBS-off rows above.
 *   2. the spawn fallback is removed: `if (started?.ok)` replaced by `if (true)`, so a gateway answer that is not ok,
 *      or a throw, is returned as is. Failing (3): "falls back ... 500", "... 404 (TexJob not deployed there)" and
 *      "... call throws".
 *   Both reverted; this file is the green state.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { jobPlace, jobStub, type JobStubEnv } from "./jobPlace";
import type { TextsBinding } from "./gatewaySession";

const JOB = "abcdefgh1234";
const NAME = `job:${JOB}`;

type SenderHit = { id: string; url: string; method: string; name: string | null; body: string | null };
type GatewayHit = { url: string; method: string; name: string | null; body: string | null };

/** A SenderInbox namespace that records every call and answers with `reply`. Ids are the names, as `objectByName` makes them. */
function senderInbox(reply: () => Response = () => Response.json({ taken: true })): { ns: DurableObjectNamespace; hits: SenderHit[] } {
  const hits: SenderHit[] = [];
  const ns = {
    idFromName: (name: string) => name,
    get: (id: string) => ({
      fetch: async (input: string | URL, init?: RequestInit) => {
        hits.push({ id, url: String(input), method: init?.method ?? "GET", name: new Headers(init?.headers).get("x-inbox-name"), body: (init?.body as string | undefined) ?? null });
        return reply();
      },
    }),
  };
  return { ns: ns as unknown as DurableObjectNamespace, hits };
}

/** The gateway's `TexTexts` binding, recording every call and answering with `answer`. */
function gateway(answer: (url: string) => Response | Promise<Response>): { binding: TextsBinding; hits: GatewayHit[] } {
  const hits: GatewayHit[] = [];
  return {
    hits,
    binding: {
      fetch: async (url: string, init?: RequestInit) => {
        hits.push({ url, method: init?.method ?? "GET", name: new Headers(init?.headers).get("x-inbox-name"), body: (init?.body as string | undefined) ?? null });
        return answer(url);
      },
    },
  };
}

/** The gateway's answers: `/job-here` says `here`, a job call is taken. */
const holds = (here: boolean) => (url: string) => (url.endsWith("/job-here") ? Response.json({ here }) : Response.json({ taken: true }));

const START = { id: JOB, title: "a title", brief: "a brief" };
const STEER = { id: JOB, text: "a later text" };

/** One line per call the Worker logs; the tests read them back to check no id or text is among them. */
function logged(spy: { mock: { calls: unknown[][] } }): string[] {
  return spy.mock.calls.map((args: unknown[]) => String(args[0]));
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("jobPlace", () => {
  it("is gateway only for exactly that string, trimmed", () => {
    expect(jobPlace("gateway")).toBe("gateway");
    expect(jobPlace(" gateway\n")).toBe("gateway");
  });

  it("is worker for unset, empty, and anything else", () => {
    expect(jobPlace(undefined)).toBe("worker");
    expect(jobPlace("")).toBe("worker");
    expect(jobPlace("worker")).toBe("worker");
    expect(jobPlace("Gateway")).toBe("worker");
    expect(jobPlace("gateway-ish")).toBe("worker");
  });
});

describe("jobStub spawn (/job-start)", () => {
  it("JOBS unset sends the start to the SenderInbox and never asks the gateway", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const sender = senderInbox();
    const gw = gateway(holds(true));
    const env: JobStubEnv = { SENDER_INBOX: sender.ns, GATEWAY_TEXTS: gw.binding };
    const response = await jobStub(env, JOB, { spawn: true }).fetch("https://inbox/job-start", { method: "POST", body: JSON.stringify(START) });
    expect(response.status).toBe(200);
    expect(sender.hits).toEqual([{ id: `enam:${NAME}`, url: "https://inbox/job-start", method: "POST", name: NAME, body: JSON.stringify(START) }]);
    expect(gw.hits).toEqual([]);
  });

  it("JOBS=worker behaves the same as unset", async () => {
    const sender = senderInbox();
    const gw = gateway(holds(true));
    await jobStub({ SENDER_INBOX: sender.ns, JOBS: "worker", GATEWAY_TEXTS: gw.binding }, JOB, { spawn: true }).fetch("https://inbox/job-start", { method: "POST", body: "{}" });
    expect(sender.hits).toHaveLength(1);
    expect(gw.hits).toEqual([]);
  });

  it("JOBS=gateway sends the start to the gateway's job route with the job's name, and never touches the SenderInbox", async () => {
    const sender = senderInbox();
    const gw = gateway(() => Response.json({ taken: true }));
    const response = await jobStub({ SENDER_INBOX: sender.ns, JOBS: "gateway", GATEWAY_TEXTS: gw.binding }, JOB, { spawn: true }).fetch("https://inbox/job-start", {
      method: "POST",
      body: JSON.stringify(START),
    });
    expect(response.status).toBe(200);
    expect(gw.hits).toEqual([{ url: "https://gateway/texts/job-call/job-start", method: "POST", name: NAME, body: JSON.stringify(START) }]);
    expect(sender.hits).toEqual([]);
  });

  it("JOBS=gateway logs one job_place line that names the operation and outcome, and no id", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const gw = gateway(() => Response.json({ taken: true }));
    await jobStub({ SENDER_INBOX: senderInbox().ns, JOBS: "gateway", GATEWAY_TEXTS: gw.binding }, JOB, { spawn: true }).fetch("https://inbox/job-start", { method: "POST", body: "{}" });
    const lines = logged(spy);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toEqual({ event: "job_place", op: "job-start", place: "gateway", outcome: "ok" });
    expect(lines.join("\n")).not.toContain(JOB);
  });

  it("falls back to the SenderInbox when the gateway answers 500", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const sender = senderInbox();
    const gw = gateway(() => new Response(null, { status: 500 }));
    const response = await jobStub({ SENDER_INBOX: sender.ns, JOBS: "gateway", GATEWAY_TEXTS: gw.binding }, JOB, { spawn: true }).fetch("https://inbox/job-start", {
      method: "POST",
      body: JSON.stringify(START),
    });
    expect(response.status).toBe(200);
    expect(gw.hits).toHaveLength(2); // the start, then whether it was born there anyway
    expect(sender.hits).toEqual([{ id: `enam:${NAME}`, url: "https://inbox/job-start", method: "POST", name: NAME, body: JSON.stringify(START) }]);
    expect(JSON.parse(logged(spy)[0])).toEqual({ event: "job_place", op: "job-start", place: "worker", outcome: "fallback" });
  });

  it("a start the gateway took but answered badly stays in the gateway, never runs twice", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const sender = senderInbox();
    const gw = gateway((url) => (url.endsWith("/job-here") ? Response.json({ here: true }) : new Response(null, { status: 502 })));
    const response = await jobStub({ SENDER_INBOX: sender.ns, JOBS: "gateway", GATEWAY_TEXTS: gw.binding }, JOB, { spawn: true }).fetch("https://inbox/job-start", { method: "POST", body: "{}" });
    expect(response.status).toBe(200);
    expect(sender.hits).toHaveLength(0);
  });

  it("falls back to the SenderInbox when the gateway answers 404 (TexJob not deployed there)", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const sender = senderInbox();
    const gw = gateway(() => new Response(null, { status: 404 }));
    await jobStub({ SENDER_INBOX: sender.ns, JOBS: "gateway", GATEWAY_TEXTS: gw.binding }, JOB, { spawn: true }).fetch("https://inbox/job-start", { method: "POST", body: "{}" });
    expect(sender.hits).toHaveLength(1);
  });

  it("falls back to the SenderInbox when the gateway call throws", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const sender = senderInbox();
    const gw = gateway(() => {
      throw new Error("binding down");
    });
    const response = await jobStub({ SENDER_INBOX: sender.ns, JOBS: "gateway", GATEWAY_TEXTS: gw.binding }, JOB, { spawn: true }).fetch("https://inbox/job-start", {
      method: "POST",
      body: JSON.stringify(START),
    });
    expect(response.status).toBe(200);
    expect(sender.hits).toHaveLength(1);
    expect(sender.hits[0].body).toBe(JSON.stringify(START));
  });
});

describe("jobStub other calls (steer, mail, pass, failed)", () => {
  it("here:true sends the call to the gateway, and passes its answer back", async () => {
    const sender = senderInbox();
    const gw = gateway(holds(true));
    const response = await jobStub({ SENDER_INBOX: sender.ns, GATEWAY_TEXTS: gw.binding }, JOB, { spawn: false }).fetch("https://inbox/job-steer", {
      method: "POST",
      body: JSON.stringify(STEER),
    });
    expect(await response.json()).toEqual({ taken: true });
    expect(gw.hits).toEqual([
      { url: "https://gateway/texts/job-call/job-here", method: "GET", name: NAME, body: null },
      { url: "https://gateway/texts/job-call/job-steer", method: "POST", name: NAME, body: JSON.stringify(STEER) },
    ]);
    expect(sender.hits).toEqual([]);
  });

  it("here:false sends the call to the SenderInbox exactly as before", async () => {
    const sender = senderInbox();
    const gw = gateway(holds(false));
    await jobStub({ SENDER_INBOX: sender.ns, GATEWAY_TEXTS: gw.binding }, JOB, { spawn: false }).fetch("https://inbox/job-steer", { method: "POST", body: JSON.stringify(STEER) });
    expect(sender.hits).toEqual([{ id: `enam:${NAME}`, url: "https://inbox/job-steer", method: "POST", name: NAME, body: JSON.stringify(STEER) }]);
    expect(gw.hits.map((hit) => hit.url)).toEqual(["https://gateway/texts/job-call/job-here"]);
  });

  it("here must be exactly true: any other answer keeps the call in the SenderInbox", async () => {
    const answers: Array<() => Response> = [
      () => Response.json({ here: "true" }),
      () => Response.json({ here: 1 }),
      () => Response.json({}),
      () => new Response("not json", { status: 200 }),
    ];
    for (const answer of answers) {
      const sender = senderInbox();
      const gw = gateway(answer);
      await jobStub({ SENDER_INBOX: sender.ns, GATEWAY_TEXTS: gw.binding }, JOB, { spawn: false }).fetch("https://inbox/job-mail", { method: "POST", body: "{}" });
      expect(sender.hits.map((hit) => hit.url)).toEqual(["https://inbox/job-mail"]);
      expect(gw.hits.map((hit) => hit.url)).toEqual(["https://gateway/texts/job-call/job-here"]);
    }
  });

  it("a failed here check (500, or a throw) keeps the call in the SenderInbox", async () => {
    for (const answer of [() => new Response(null, { status: 500 }), () => Promise.reject(new Error("down"))]) {
      const sender = senderInbox();
      await jobStub({ SENDER_INBOX: sender.ns, GATEWAY_TEXTS: gateway(answer).binding }, JOB, { spawn: false }).fetch("https://inbox/job-pass", { method: "POST" });
      expect(sender.hits.map((hit) => hit.url)).toEqual(["https://inbox/job-pass"]);
    }
  });

  it("JOBS=gateway does not change a non-start call: the gateway's say-so decides", async () => {
    const sender = senderInbox();
    const gw = gateway(holds(false));
    await jobStub({ SENDER_INBOX: sender.ns, JOBS: "gateway", GATEWAY_TEXTS: gw.binding }, JOB, { spawn: false }).fetch("https://inbox/job-steer", { method: "POST", body: "{}" });
    expect(sender.hits).toHaveLength(1);
    expect(gw.hits.some((hit) => hit.url.endsWith("/job-start"))).toBe(false);
  });

  it("a job the gateway holds keeps receiving calls there when JOBS is turned off", async () => {
    const sender = senderInbox();
    const gw = gateway(holds(true));
    await jobStub({ SENDER_INBOX: sender.ns, JOBS: "worker", GATEWAY_TEXTS: gw.binding }, JOB, { spawn: false }).fetch("https://inbox/job-mail", { method: "POST", body: "{}" });
    expect(gw.hits.map((hit) => hit.url)).toEqual(["https://gateway/texts/job-call/job-here", "https://gateway/texts/job-call/job-mail"]);
    expect(sender.hits).toEqual([]);
  });
});

describe("jobStub with no gateway binding", () => {
  it("sends every call to the SenderInbox, start and steer alike, whatever JOBS says", async () => {
    for (const JOBS of [undefined, "gateway"]) {
      const sender = senderInbox();
      const stub = jobStub({ SENDER_INBOX: sender.ns, JOBS }, JOB, { spawn: true });
      await stub.fetch("https://inbox/job-start", { method: "POST", body: "{}" });
      await jobStub({ SENDER_INBOX: sender.ns, JOBS }, JOB, { spawn: false }).fetch("https://inbox/job-steer", { method: "POST", body: "{}" });
      expect(sender.hits.map((hit) => hit.url)).toEqual(["https://inbox/job-start", "https://inbox/job-steer"]);
    }
  });
});
