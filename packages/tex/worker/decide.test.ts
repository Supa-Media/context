/**
 * Why decide was unavailable, and how long it took, reach the logs as codes
 * (2026-10-27: every group decide read "unavailable" and nothing said why).
 */
import { describe, expect, it } from "vitest";
import { decide, type DecideAsk } from "./decide";
import type { Fetch } from "./clients";

const ASK: DecideAsk = { chat: "g1", line: "+15555550199", style: "helpful", transcript: "", candidates: ["e1"], running: false, waitingAsks: [], newest: "e1" };
const deps = (fetch: Fetch) => ({ fetch, controlPlaneOrigin: "https://control.example.test", workerSecret: "s" });
const answering = (status: number, body: unknown) => (async () => Response.json(body, { status })) as unknown as Fetch;

describe("decide's outcome for the logs", () => {
  it("names each way it can be unavailable", async () => {
    expect(await decide(deps(answering(502, {})), ASK)).toMatchObject({ ok: false, reason: "unavailable", cause: "http_502" });
    expect(await decide(deps(answering(200, { ok: false, reason: "unavailable" })), ASK)).toMatchObject({ ok: false, cause: "unavailable" });
    expect(await decide(deps(answering(200, { ok: false, reason: "capped" })), ASK)).toMatchObject({ ok: false, reason: "capped", cause: "capped" });
    expect(await decide(deps(answering(200, { ok: false, reason: "unavailable", cause: "no_group" })), ASK)).toMatchObject({ ok: false, reason: "unavailable", cause: "no_group" });
    expect(await decide(deps(answering(200, { ok: true, act: "shout" })), ASK)).toMatchObject({ ok: false, cause: "bad_answer" });
    const refused = (async () => {
      throw new Error("refused");
    }) as unknown as Fetch;
    expect(await decide(deps(refused), ASK, 1_000)).toMatchObject({ ok: false, cause: "unreachable" });
  });

  it("says timeout when the limit ran out, and times every answer", async () => {
    const hung = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as Fetch;
    const late = await decide(deps(hung), ASK, 60);
    expect(late).toMatchObject({ ok: false, cause: "timeout" });
    expect(late.ms).toBeGreaterThanOrEqual(50);
    const answered = await decide(deps(answering(200, { ok: true, act: "answer", covers: ["e1"], stale: [], movedOn: false, confidence: 0.9 })), ASK);
    expect(answered).toMatchObject({ ok: true, act: "answer", covers: ["e1"] });
    expect(typeof answered.ms).toBe("number");
  });
});
