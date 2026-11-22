/**
 * A job's object is the gateway's (part C of the runtime simplification, 2026-11-22): no born-where probe, no `JOBS`
 * switch. A 501 (no job home: a Lab test chat, self-hosting) or no `GATEWAY_TEXTS` binding reaches it by name here.
 *
 * Sabotage checked (reverted): dropping the `x-inbox-name` header fails "names the job"; returning the 501 as it is
 * fails "a gateway with no job home".
 */
import { describe, expect, it } from "vitest";
import { jobObject } from "./jobObject";

function namespace(hits: string[]): DurableObjectNamespace {
  return {
    idFromName: (name: string) => ({ name }),
    get: (id: { name: string }) => ({
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => (hits.push(`${id.name} ${new URL(new Request(input, init).url).pathname}`), Response.json({ here: "worker" })),
    }),
  } as unknown as DurableObjectNamespace;
}

function gateway(status = 200) {
  const seen: { url: string; name: string | null; method: string; body: string }[] = [];
  return {
    seen,
    binding: {
      fetch: async (url: string, init?: RequestInit) => {
        seen.push({ url, name: new Headers(init?.headers).get("x-inbox-name"), method: String(init?.method), body: String(init?.body ?? "") });
        return Response.json({ here: "gateway" }, { status });
      },
    },
  };
}

describe("jobObject", () => {
  it("names the job and passes every call, its start included, to the gateway's job-call door, never the Worker", async () => {
    const worker: string[] = [];
    const gw = gateway();
    const job = jobObject({ SENDER_INBOX: namespace(worker), GATEWAY_TEXTS: gw.binding }, "j1");
    expect(await (await job.fetch("https://inbox/job-start", { method: "POST", body: "{}" })).json()).toEqual({ here: "gateway" });
    await job.fetch("https://inbox/job-steer", { method: "POST", body: '{"id":"s"}' });
    expect(gw.seen).toEqual([
      { url: "https://gateway/texts/job-call/job-start", name: "job:j1", method: "POST", body: "{}" },
      { url: "https://gateway/texts/job-call/job-steer", name: "job:j1", method: "POST", body: '{"id":"s"}' },
    ]);
    expect(worker).toEqual([]);
  });

  it("passes the gateway's other answers on, errors included", async () => {
    const worker: string[] = [];
    const answer = await jobObject({ SENDER_INBOX: namespace(worker), GATEWAY_TEXTS: gateway(404).binding }, "j1").fetch("https://inbox/job-mail", { method: "POST" });
    expect(answer.status).toBe(404);
    expect(worker).toEqual([]);
  });

  it("a gateway with no job home (501) reaches the job by name here", async () => {
    const worker: string[] = [];
    const answer = await jobObject({ SENDER_INBOX: namespace(worker), GATEWAY_TEXTS: gateway(501).binding }, "j1").fetch("https://inbox/job-start", { method: "POST" });
    expect(await answer.json()).toEqual({ here: "worker" });
    expect(worker).toEqual(["enam:job:j1 /job-start"]);
  });

  it("is the job by name here without the gateway binding", async () => {
    const worker: string[] = [];
    await jobObject({ SENDER_INBOX: namespace(worker) }, "j1").fetch("https://inbox/job-steer", { method: "POST" });
    expect(worker).toEqual(["enam:job:j1 /job-steer"]);
  });
});
