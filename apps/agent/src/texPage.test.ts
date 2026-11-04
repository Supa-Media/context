/**
 * The Tex page's view of a chat's jobs (`texPage.ts`): what it shows, what it
 * refuses as a chat, and which job a page may steer.
 */

import { describe, expect, it } from "vitest";
import { JOB_KEPT_MS, JOB_PREFIX, JOB_SHOWN_MS, JOB_STALE_MS, MACHINE_JOB_STALE_MS, WAIT_ENDED_STATUS, type JobEntry } from "./jobs";
import { MemoryStorage } from "./memoryStorage.testing";
import { MAX_PAGE_JOBS, pageJobsOf, pageSteer, readPageChat, readPageSteer } from "./texPage";

const NOW = 1_000_000;
const PHONE = "+15555550100";
const GROUP_KEY = "a".repeat(64);

const entry = (id: string, overrides: Partial<JobEntry> = {}): JobEntry => ({
  id,
  title: `Job ${id}`,
  state: "running",
  startedAt: NOW - 1_000,
  ...overrides,
});

describe("pageJobsOf", () => {
  it("shows running and finished jobs with their steps, newest first", async () => {
    const storage = new MemoryStorage();
    const steps = [{ at: NOW - 500, text: "Searched the web" }, { at: NOW - 400, text: "Saved a page", failed: true as const, why: "timed out" }];
    await storage.put(`${JOB_PREFIX}old`, entry("old", { state: "done", startedAt: NOW - 5_000, finishedAt: NOW - 4_000, result: "Old report", steps: [steps[0]!] }));
    await storage.put(`${JOB_PREFIX}new`, entry("new", { steps, status: "Working on it" }));
    await storage.put(`${JOB_PREFIX}finished`, entry("finished", { state: "done", startedAt: NOW - 2_000, finishedAt: NOW - 100, result: "Done report", steps }));

    const page = await pageJobsOf(storage, NOW);

    expect(page.now).toBe(NOW);
    expect(page.jobs.map((job) => job.id)).toEqual(["new", "finished", "old"]);
    expect(page.jobs[0]).toEqual({ id: "new", title: "Job new", state: "running", startedAt: NOW - 1_000, status: "Working on it", steps });
    expect(page.jobs[1]).toMatchObject({ state: "done", finishedAt: NOW - 100, result: "Done report", steps });
    expect(page.jobs[1]).not.toHaveProperty("for");
  });

  it("shows a running job no result, and never a phone number", async () => {
    const storage = new MemoryStorage();
    await storage.put(`${JOB_PREFIX}run`, entry("run", { result: "stale words" }));
    const [job] = (await pageJobsOf(storage, NOW)).jobs;
    expect(job).not.toHaveProperty("result");
    expect(JSON.stringify(job)).not.toContain(PHONE);
  });

  it("names a group's people hash, which its browser is tagged by, and none for a 1:1 inbox", async () => {
    const storage = new MemoryStorage();
    expect((await pageJobsOf(storage, NOW)).people).toBeUndefined();
    const full = "a".repeat(64);
    await storage.put("gpeople", { webhook: "b".repeat(64), full });
    expect((await pageJobsOf(storage, NOW)).people).toBe(full);
    await storage.put("gpeople", { webhook: "b".repeat(64), full: "not a hash" });
    expect((await pageJobsOf(storage, NOW)).people).toBeUndefined();
  });

  it("keeps at most the newest forty, and prunes what has expired", async () => {
    const storage = new MemoryStorage();
    for (let index = 0; index < MAX_PAGE_JOBS + 5; index += 1) {
      await storage.put(`${JOB_PREFIX}j${index}`, entry(`j${index}`, { startedAt: NOW - 1_000 - index, state: "done", finishedAt: NOW - 500 }));
    }
    await storage.put(`${JOB_PREFIX}gone`, entry("gone", { state: "done", startedAt: NOW - JOB_KEPT_MS - 10_000, finishedAt: NOW - JOB_KEPT_MS - 5_000 }));
    await storage.put(`${JOB_PREFIX}lost`, entry("lost", { startedAt: NOW - JOB_STALE_MS - 1 }));

    const page = await pageJobsOf(storage, NOW);

    expect(page.jobs).toHaveLength(MAX_PAGE_JOBS);
    expect(page.jobs[0]!.id).toBe("j0");
    expect(storage.data.has(`${JOB_PREFIX}gone`)).toBe(false);
    expect(page.jobs.find((job) => job.id === "lost")).toBeUndefined();
    expect(storage.data.get(`${JOB_PREFIX}lost`)).toMatchObject({ state: "failed" });
  });
  it("shows a job waiting on them only while their answer can still pick it up, then as stuck", async () => {
    const storage = new MemoryStorage();
    await storage.put(`${JOB_PREFIX}fresh`, entry("fresh", { state: "waiting", startedAt: NOW - 2_000, finishedAt: NOW - 1_000, status: "Needs a code" }));
    await storage.put(`${JOB_PREFIX}lapsed`, entry("lapsed", { state: "waiting", startedAt: NOW - JOB_SHOWN_MS - 5_000, finishedAt: NOW - JOB_SHOWN_MS - 1, status: "Needs a yes" }));
    const jobs = (await pageJobsOf(storage, NOW)).jobs;
    expect(jobs.find((job) => job.id === "fresh")).toMatchObject({ state: "waiting", status: "Needs a code" });
    expect(jobs.find((job) => job.id === "lapsed")).toMatchObject({ state: "stuck", status: WAIT_ENDED_STATUS });
  });
  it("says which of the person's computers a job runs on, and nothing for Tex's cloud", async () => {
    const storage = new MemoryStorage();
    await storage.put(`${JOB_PREFIX}vm`, entry("vm", { machine: true, on: "mch_1", onName: "Cloud VM", onTool: "claude" }));
    await storage.put(`${JOB_PREFIX}old`, entry("old", { startedAt: NOW - 2_000, machine: true }));
    await storage.put(`${JOB_PREFIX}cloud`, entry("cloud", { startedAt: NOW - 3_000 }));
    const jobs = (await pageJobsOf(storage, NOW)).jobs;
    expect(jobs.find((job) => job.id === "vm")!.on).toEqual({ id: "mch_1", name: "Cloud VM", tool: "claude" });
    // An entry from before names were kept.
    expect(jobs.find((job) => job.id === "old")!.on).toEqual({ id: "machine", name: "your computer" });
    expect(jobs.find((job) => job.id === "cloud")).not.toHaveProperty("on");
  });

  it("leaves a computer's job running past a cloud job's limit, up to the computer's own", async () => {
    const storage = new MemoryStorage();
    await storage.put(`${JOB_PREFIX}long`, entry("long", { startedAt: NOW - JOB_STALE_MS - 1, machine: true, on: "mch_1" }));
    await storage.put(`${JOB_PREFIX}gone`, entry("gone", { startedAt: NOW - MACHINE_JOB_STALE_MS - 1, machine: true, on: "mch_1" }));
    const jobs = (await pageJobsOf(storage, NOW)).jobs;
    expect(jobs.find((job) => job.id === "long")!.state).toBe("running");
    expect(jobs.find((job) => job.id === "gone")!.state).toBe("failed");
  });
});

describe("readPageChat", () => {
  it("accepts a phone or a group key, in their own shapes", () => {
    expect(readPageChat({ phone: PHONE })).toEqual({ phone: PHONE });
    expect(readPageChat({ groupKey: GROUP_KEY })).toEqual({ groupKey: GROUP_KEY });
  });

  it("refuses every other shape", () => {
    for (const bad of [
      null,
      undefined,
      "+15555550100",
      [],
      {},
      { phone: "15555550100" },
      { phone: "+0555550100" },
      { phone: "+1555" },
      { phone: 15555550100 },
      { phone: PHONE, groupKey: GROUP_KEY },
      { groupKey: "A".repeat(64) },
      { groupKey: "a".repeat(63) },
      { groupKey: GROUP_KEY + "0" },
    ]) {
      expect(readPageChat(bad)).toBeNull();
    }
  });
});

describe("readPageSteer and pageSteer", () => {
  it("reads a steer strictly, defaulting a stop's text to Stop.", () => {
    expect(readPageSteer({ id: "job-1", text: "  make it yellow " })).toEqual({ id: "job-1", text: "make it yellow" });
    expect(readPageSteer({ id: "job-1", stop: true })).toEqual({ id: "job-1", text: "Stop.", stop: true });
    expect(readPageSteer({ id: "job 1", text: "x" })).toBeNull();
    expect(readPageSteer({ id: "job-1" })).toBeNull();
    expect(readPageSteer({ id: "job-1", text: 5 })).toBeNull();
  });

  it("refuses a job the chat does not list, without calling the job's object", async () => {
    const storage = new MemoryStorage();
    await storage.put(`${JOB_PREFIX}mine`, entry("mine"));
    const sent: string[] = [];
    const send = async (id: string) => {
      sent.push(id);
      return true;
    };

    expect(await pageSteer(storage, { id: "theirs", text: "stop" }, send)).toBe(false);
    expect(sent).toEqual([]);
  });

  it("forwards a steer for a job the chat lists, with its stop flag", async () => {
    const storage = new MemoryStorage();
    await storage.put(`${JOB_PREFIX}mine`, entry("mine"));
    const sent: Array<{ id: string; steer: unknown }> = [];
    const send = async (id: string, steer: unknown) => {
      sent.push({ id, steer });
      return true;
    };

    expect(await pageSteer(storage, { id: "mine", text: "Stop.", stop: true }, send)).toBe(true);
    expect(await pageSteer(storage, { id: "mine", text: "make it yellow" }, send)).toBe(true);
    expect(sent).toEqual([
      { id: "mine", steer: { id: "mine", text: "Stop.", stop: true } },
      { id: "mine", steer: { id: "mine", text: "make it yellow" } },
    ]);
  });

  it("answers false when the job's object cannot be reached", async () => {
    const storage = new MemoryStorage();
    await storage.put(`${JOB_PREFIX}mine`, entry("mine"));
    expect(await pageSteer(storage, { id: "mine", text: "hi" }, async () => Promise.reject(new Error("down")))).toBe(false);
  });
});
