/**
 * A job's progress saved between parts, and a typed end cause per part (Dev2's "jobs as config" plan, part B,
 * 2026-11-17). The incident: a timecards job's parts each died in their answer checks' loop, and ten parts redid the
 * same email search, sign-in, picture and email draft, then failed with nothing.
 *
 * Sabotage record (applied, suite run, named test observed failing, reverted):
 *  1. `onStep` not writing `PROGRESS_KEY` → "every return is saved the moment it streams back".
 *  2. `runJob` not reading a dead pass's `PROGRESS_KEY` → "a pass whose object died mid-part hands on what it saved".
 *  3. `DETERMINISTIC` empty → "an answer-check loop that ran out delivers its last draft, in one part".
 *  4. `outcomeOf` treating `model_down` as broken → "a model that was down tries the same part again".
 *  5. `readOutside` ignored → "a saved call that read from outside marks the next part".
 */

import { describe, expect, it, vi } from "vitest";
import type { Fetch } from "./clients";
import { acceptJob, runJob, type JobDeps } from "./jobRun";
import { MAX_SAVED_CALLS, MAX_SAVED_CHARS, mergeSaved, PROGRESS_KEY, type JobSaved } from "./jobProgress";
import { readEnds, readJobUpdate, RUN_KEY, type JobRun, type JobUpdate } from "./jobs";
import { MemoryStorage } from "./memoryStorage.testing";

const NOW = 1_000_000;
const PHONE = "+15555550100";
const RUN: JobRun = {
  id: "job-1234-abcd",
  inbox: PHONE,
  title: "Timecards",
  brief: "Check this week's timecards and email the summary.",
  origin: { kind: "phone", phone: PHONE, question: "check the timecards" },
  attempt: 1,
  tries: 0,
  startedAt: NOW,
};

/** A gateway streaming each `/agent` call's lines as given; `during` runs after each line is read, mid-turn. */
function jobDeps(parts: unknown[][], storage?: MemoryStorage, during?: (storage: MemoryStorage) => Promise<void>) {
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
        const encoder = new TextEncoder();
        const body = new ReadableStream<Uint8Array>({
          async start(controller) {
            for (const line of lines) {
              controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
              await new Promise((resolve) => setTimeout(resolve, 0));
              if (during && storage) await during(storage);
            }
            controller.close();
          },
        });
        return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
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

const CHECK_LIMIT = { status: 500, body: { error: "server_error", cause: "check_limit" } };

describe("a job's progress, saved as it returns", () => {
  it("every return is saved the moment it streams back", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const storage = new MemoryStorage();
    await acceptJob(storage, RUN, NOW);
    const seen: Array<JobSaved | undefined> = [];
    const { deps } = jobDeps(
      [[{ step: "Searched mail for timecards", result: "2 emails from payroll" }, { step: "Sent an email to boss@example.com", held: true, result: "Held for their yes: email to boss@example.com" }, { tick: 1 }]],
      storage,
      async (kept) => void seen.push(await kept.get<JobSaved>(PROGRESS_KEY)),
    );
    await runJob(storage, deps);
    // Saved mid-turn, before the part ended: a pass killed here would have lost nothing.
    expect(seen.some((saved) => saved?.calls.length === 1 && saved.calls[0].result === "2 emails from payroll")).toBe(true);
    expect(seen.some((saved) => saved?.calls.some((call) => call.held === true))).toBe(true);
    // Folded into the run once the pass ended, and the key cleared.
    expect(await storage.get(PROGRESS_KEY)).toBeUndefined();
    expect((await storage.get<JobRun>(RUN_KEY))?.saved?.calls).toEqual([
      { part: 1, step: "Searched mail for timecards", result: "2 emails from payroll" },
      { part: 1, step: "Sent an email to boss@example.com", held: true, result: "Held for their yes: email to boss@example.com" },
    ]);
  });

  it("a pass whose object died mid-part hands on what it saved", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const storage = new MemoryStorage();
    await acceptJob(storage, RUN, NOW);
    await storage.put<JobSaved>(PROGRESS_KEY, { calls: [{ part: 1, step: "Signed in to the timecard site", result: "Signed in" }], draft: "Zero rows this week.", draftPart: 1 });
    const { deps, asked } = jobDeps([[{ status: 200, body: { answer: "Zero rows this week; the sign-in works." } }]]);
    await runJob(storage, deps);
    expect(asked[0].job).toMatchObject({ saved: { calls: [{ step: "Signed in to the timecard site", result: "Signed in" }], draft: "Zero rows this week." } });
  });

  it("a saved call that read from outside marks the next part", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const storage = new MemoryStorage();
    await acceptJob(storage, RUN, NOW);
    const { deps, asked } = jobDeps([[{ step: "Opened example.com", result: "page text", outside: true }, { tick: 1 }], [{ status: 200, body: { answer: "Done." } }]]);
    await runJob(storage, deps);
    await runJob(storage, deps);
    expect(asked[1].job).toMatchObject({ tainted: true });
  });
});

describe("each part's end cause", () => {
  it("an answer-check loop that ran out delivers its last draft, in one part", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const storage = new MemoryStorage();
    await acceptJob(storage, RUN, NOW);
    const { deps, asked, reports } = jobDeps([[{ step: "Searched mail", result: "2 emails" }, { draft: "No timecard rows this week; the sign-in works." }, CHECK_LIMIT]]);
    await runJob(storage, deps);
    expect(asked).toHaveLength(1);
    expect(reports.at(-1)).toMatchObject({ state: "done", texts: ["No timecard rows this week; the sign-in works."], part: 1, ends: [{ part: 1, cause: "check_limit" }] });
    expect(reports.at(-1)?.status).toMatch(/answer-check rounds/);
  });

  it("an answer-check loop that ran out before any draft carries on, from what it saved", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const storage = new MemoryStorage();
    await acceptJob(storage, RUN, NOW);
    const { deps, asked, reports } = jobDeps([[{ step: "Searched mail", result: "2 emails" }, CHECK_LIMIT], [{ status: 200, body: { answer: "Done." } }]]);
    await runJob(storage, deps);
    await runJob(storage, deps);
    expect(asked[1].job).toMatchObject({ attempt: 2, saved: { calls: [{ step: "Searched mail", result: "2 emails" }] } });
    expect(reports.at(-1)).toMatchObject({ state: "done", part: 2, ends: [{ part: 1, cause: "check_limit" }, { part: 2, cause: "done" }] });
  });

  it("a model that was down tries the same part again, and says so", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const storage = new MemoryStorage();
    await acceptJob(storage, RUN, NOW);
    const { deps, asked, reports } = jobDeps([[{ step: "Searched mail", result: "2 emails" }, { status: 502, body: { error: "model_unavailable" } }], [{ status: 200, body: { answer: "Done." } }]]);
    expect(await runJob(storage, deps)).toMatchObject({ kind: "after" });
    expect((await storage.get<JobRun>(RUN_KEY))).toMatchObject({ attempt: 1, tries: 1, ends: [{ part: 1, cause: "model_down" }] });
    await runJob(storage, deps);
    expect(asked[1].job).toMatchObject({ attempt: 1, saved: { calls: [{ step: "Searched mail" }] } });
    expect(reports.at(-1)).toMatchObject({ state: "done", ends: [{ part: 1, cause: "model_down" }, { part: 1, cause: "done" }] });
  });

  it("a last part that crashed delivers its draft rather than nothing", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const storage = new MemoryStorage();
    await acceptJob(storage, { ...RUN, attempt: 10 }, NOW);
    const { deps, reports } = jobDeps([[{ draft: "Half the timecards checked: 3 of 6 fine." }]]);
    await runJob(storage, deps);
    expect(reports.at(-1)).toMatchObject({ state: "stuck", texts: ["Half the timecards checked: 3 of 6 fine."], ends: [{ part: 10, cause: "crash" }] });
  });

  it("the inbox reads a part's ends strictly", () => {
    expect(readEnds([{ part: 1, cause: "check_limit" }, { part: 0, cause: "done" }, { part: 2, cause: "nope" }, "x"])).toEqual([{ part: 1, cause: "check_limit" }]);
    expect(readJobUpdate({ id: "job-1234-abcd", state: "running", part: 3, ends: [{ part: 2, cause: "timeout" }] })).toMatchObject({ part: 3, ends: [{ part: 2, cause: "timeout" }] });
    expect(readJobUpdate({ id: "job-1234-abcd", state: "running", part: -1 })).not.toHaveProperty("part");
  });
});

describe("what is kept", () => {
  it("keeps the newest calls, and gives up older results' text first, held ones last", () => {
    const calls = Array.from({ length: MAX_SAVED_CALLS + 5 }, (_, i) => ({ part: 1, step: `Step ${i}`, result: "x".repeat(1_500), ...(i === 6 ? { held: true as const } : {}) }));
    const saved = mergeSaved({ calls: calls.slice(0, 10) }, { calls: calls.slice(10), draft: "d", draftPart: 2 })!;
    expect(saved.calls).toHaveLength(MAX_SAVED_CALLS);
    expect(saved.calls[0].step).toBe("Step 5");
    expect(saved.calls.find((call) => call.held)?.result).toBeDefined();
    expect(saved.calls.at(-1)?.result).toBeDefined();
    expect(saved.calls.reduce((sum, call) => sum + (call.result?.length ?? 0), 0)).toBeLessThanOrEqual(MAX_SAVED_CHARS);
    expect(saved).toMatchObject({ draft: "d", draftPart: 2 });
    expect(mergeSaved(undefined, { calls: [] })).toBeUndefined();
  });
});
