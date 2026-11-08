/**
 * A job's part that the gateway lost partway (2026-11-08, "Messaging comparison": the gateway ran out of memory in
 * the advisor's check, after the part had written its page, and the next part did everything again).
 *
 * - The part's answer travels before the check (`answered`), so a stream that dies after it still answered.
 * - A part cut off before any answer hands its steps to the next part (`cutOff`), which reads them back first.
 * - Why a part carried on is logged (`carry_on` and its reason).
 *
 * Sabotage record (applied, suite run, named test observed failing, reverted):
 *  1. `askAgentStream` ignoring `answered` lines → "a stream that dies after its answer line still answered" and
 *     "a part whose stream dies after its answer is reported, not run again".
 *  2. `askAgentStream` letting a failed final line win over `answered` → "a failed final line after the answer
 *     line keeps the answer".
 *  3. `runJob` not keeping `cutOff` → "a part cut off before it answered hands its steps to the next part".
 *  4. `runJob` logging `carry_on` with no reason → both `carry_on` expectations fail.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { askAgent, type Fetch } from "./clients";
import { acceptJob, MAX_CUT_OFF_STEPS, runJob, type JobDeps } from "./jobRun";
import { jobTag, RUN_KEY, type JobRun, type JobUpdate } from "./jobs";
import { MemoryStorage } from "./memoryStorage.testing";

const NOW = 1_000_000;
const PHONE = "+15555550100";

const RUN: JobRun = {
  id: "job-1234-abcd",
  inbox: PHONE,
  title: "Messaging comparison",
  brief: "Compare messaging providers on a page.",
  origin: { kind: "phone", phone: PHONE, question: "compare messaging providers" },
  attempt: 1,
  tries: 0,
  startedAt: NOW,
};

/** A gateway streaming each `/agent` call's lines as given: no final `status` line is a stream that died. */
function jobDeps(parts: unknown[][]) {
  const asked: Array<Record<string, unknown>> = [];
  const reports: JobUpdate[] = [];
  const deps: JobDeps = {
    fetch: (async (url: string, init: RequestInit) => {
      const path = new URL(url).pathname;
      if (path === "/agent-texts/session") return Response.json({ status: "linked", accessToken: "job_token" });
      if (path === "/agent/job/note") return Response.json({ ok: false, code: "no_note" });
      if (path === "/agent") {
        asked.push(JSON.parse(String(init.body)));
        const lines = parts.shift();
        if (!lines) throw new Error("no answer left");
        return new Response(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, { headers: { "content-type": "application/x-ndjson" } });
      }
      throw new Error(`unexpected ${path}`);
    }) as unknown as Fetch,
    controlPlaneOrigin: "https://cp.example",
    workerSecret: "s",
    gatewayOrigin: "https://gw.example",
    now: () => NOW,
    report: async (_inbox, update) => (reports.push(update), true),
  };
  return { deps, asked, reports };
}

const stream = (lines: unknown[]): Fetch =>
  (async () => new Response(`${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, { headers: { "content-type": "application/x-ndjson" } })) as unknown as Fetch;

function jobLogs(spy: { mock: { calls: unknown[][] } }): Array<Record<string, unknown> | null> {
  return spy.mock.calls
    .flat()
    .map((line: unknown) => {
      try {
        return JSON.parse(String(line));
      } catch {
        return null;
      }
    })
    .filter((line: Record<string, unknown> | null) => line?.event === "background_job");
}

afterEach(() => vi.restoreAllMocks());

describe("a stream that dies after its answer", () => {
  it("a stream that dies after its answer line still answered", async () => {
    const answer = await askAgent(stream([{ step: "Wrote the page" }, { answered: { answer: "The page is up." } }, { tick: 1 }]), "g", "t", "q", async () => {});
    expect(answer).toMatchObject({ kind: "answer", text: "The page is up." });
  });

  it("a failed final line after the answer line keeps the answer", async () => {
    const answer = await askAgent(stream([{ answered: { answer: "The page is up." } }, { status: 500, body: { error: "server_error" } }]), "g", "t", "q", async () => {});
    expect(answer).toMatchObject({ kind: "answer", text: "The page is up." });
  });

  it("the final line wins when it comes, and a refusal is never covered over", async () => {
    expect(await askAgent(stream([{ answered: { answer: "Early." } }, { status: 200, body: { answer: "Checked.", verdict: "done" } }]), "g", "t", "q", async () => {})).toMatchObject({ kind: "answer", text: "Checked." });
    expect(await askAgent(stream([{ answered: { answer: "Early." } }, { status: 429, body: {} }]), "g", "t", "q", async () => {})).toEqual({ kind: "daily_limit" });
    // An empty early answer is no answer: the stream is as dead as before.
    expect(await askAgent(stream([{ answered: { answer: "  " } }]), "g", "t", "q", async () => {})).toEqual({ kind: "unavailable" });
  });
});

describe("a job's part the gateway lost", () => {
  it("a part whose stream dies after its answer is reported, not run again", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const storage = new MemoryStorage();
    await acceptJob(storage, RUN, NOW);
    const { deps, asked, reports } = jobDeps([[{ step: "Wrote projects/compare.page.md" }, { answered: { answer: "The comparison is on its page." } }]]);
    await runJob(storage, deps);
    expect(asked).toHaveLength(1);
    expect(reports.at(-1)).toMatchObject({ state: "done", texts: ["The comparison is on its page."] });
  });

  it("a part cut off before it answered hands its steps to the next part, and says why it carried on", async () => {
    const logs = vi.spyOn(console, "log").mockImplementation(() => {});
    const storage = new MemoryStorage();
    await acceptJob(storage, RUN, NOW);
    const many = Array.from({ length: MAX_CUT_OFF_STEPS + 5 }, (_, i) => ({ step: `Step ${i + 1}` }));
    const { deps, asked, reports } = jobDeps([
      [{ step: "Searched the web" }, { step: "Read a pricing page", failed: true }, { step: "Wrote projects/compare.page.md" }, { tick: 1 }],
      [{ status: 200, body: { answer: "Checked the page; it was all there." } }],
    ]);
    await runJob(storage, deps);
    expect((await storage.get<JobRun>(RUN_KEY))?.cutOff).toEqual(["Searched the web", "Read a pricing page (failed)", "Wrote projects/compare.page.md"]);
    await runJob(storage, deps);
    expect(asked[0].job).not.toHaveProperty("cutOff");
    expect(asked[1].job).toMatchObject({ attempt: 2, cutOff: ["Searched the web", "Read a pricing page (failed)", "Wrote projects/compare.page.md"] });
    expect(reports.at(-1)).toMatchObject({ state: "done", texts: ["Checked the page; it was all there."] });
    expect(jobLogs(logs)).toContainEqual({ event: "background_job", outcome: "carry_on", job: jobTag(RUN.id), reason: "broken" });

    // Kept to the newest part only, and to its first steps.
    const second = new MemoryStorage();
    await acceptJob(second, RUN, NOW);
    const more = jobDeps([many, [{ status: 200, body: { answer: "Done.", unfinished: true } }]]);
    await runJob(second, more.deps);
    expect((await second.get<JobRun>(RUN_KEY))?.cutOff).toHaveLength(MAX_CUT_OFF_STEPS);
    await runJob(second, more.deps);
    expect((await second.get<JobRun>(RUN_KEY))?.cutOff).toBeUndefined();
    expect(jobLogs(logs)).toContainEqual({ event: "background_job", outcome: "carry_on", job: jobTag(RUN.id), reason: "unfinished" });
  });
});
