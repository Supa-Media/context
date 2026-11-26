/**
 * Where a job's report starts its new run is config (Dev2, 2026-11-26: the wire "report to intake" was drawn, and
 * nothing read it). Run step `reportRun` (`texRunNodes.cjs`) wires to input step `jobReport`, or to nothing; a config
 * without the step (as before it was promoted) starts `jobReport` as before.
 *
 * Sabotage record (applied, suite run, named test observed failing, reverted):
 *  1. `jobUpdate` not asking `reportStartsAt` → "a report run step wired to nothing queues nothing".
 *  2. `runTarget` ignoring the wire's step being off → "a report wired to an input step that is off queues nothing".
 */

import { describe, expect, it } from "vitest";
import { TEX_CONFIG } from "../../../packages/tex/src/texConfig.cjs";
import { configProblems } from "../../../packages/tex/src/texConfigSchema.cjs";
import { startJobs, type JobEntry, type JobUpdate } from "./jobs";
import { jobUpdate, reportStartsAt } from "./jobTexts";
import { MemoryStorage } from "./memoryStorage.testing";
import type { JobTextDeps } from "./jobTexts";

const NOW = 3_000_000;
const PHONE = "+15555550100";

type Config = { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> };
/** The bundled config without the run step, as it was before the step was promoted. */
function withoutRun(): Config {
  const c: Config = JSON.parse(JSON.stringify(TEX_CONFIG));
  c.nodes = c.nodes.filter((n) => n.id !== "reportRun");
  c.edges = c.edges.filter((e) => e.from !== "reportRun" && e.to !== "reportRun");
  c.edges.push({ from: "job", to: "jobReport", mode: "generator", when: ["*"] });
  return c;
}
const RUN = { id: "reportRun", label: "New run", on: true, model: "code", kind: "run", group: "jobs" };
/** The config with the run step, wired (or not) to `jobReport`. */
function withRun(wired: boolean, edit: (c: Config) => void = () => {}): Config {
  const c = withoutRun();
  c.nodes.push({ ...RUN });
  c.edges = c.edges.filter((e) => !(e.from === "job" && e.to === "jobReport"));
  c.edges.push({ from: "job", to: "reportRun", mode: "wait", when: ["job"] });
  if (wired) c.edges.push({ from: "reportRun", to: "jobReport", mode: "generator", when: ["*"] });
  edit(c);
  return c;
}

async function queued(texGraph?: unknown): Promise<number> {
  const storage = new MemoryStorage();
  await startJobs(storage, [{ title: "Benchmarks", brief: "b" }], { now: NOW, inbox: PHONE, origin: { kind: "phone", phone: PHONE, question: "q" }, place: { chatId: "chat_1", messageId: "m" }, spawn: async () => {} });
  const id = [...(await storage.list<JobEntry>({ prefix: "job:" })).values()][0].id;
  const update: JobUpdate = { id, pass: "p", state: "done", status: "Done.", texts: ["Done."], first: 0, asked: { from: PHONE, text: "q" } };
  const deps = { now: () => NOW, ...(texGraph !== undefined ? { texGraph } : {}) } as unknown as JobTextDeps;
  expect(await jobUpdate(storage, deps, update)).toBe(true);
  return [...(await storage.list({ prefix: "" })).keys()].filter((k) => k.includes("job-report:")).length;
}

describe("a job's report starts its new run where the config says", () => {
  it("a config without the run step starts jobReport, as before, and the bundled config wires it there", () => {
    expect(reportStartsAt(withoutRun())).toBe("jobReport");
    expect(reportStartsAt()).toBe("jobReport");
  });

  it("a run step wired to jobReport starts it, and its config is sound", () => {
    const c = withRun(true);
    expect(reportStartsAt(c)).toBe("jobReport");
    expect(configProblems(c)).toEqual([]);
  });

  it("a report run step wired to nothing queues nothing", async () => {
    expect(reportStartsAt(withRun(false))).toBeNull();
    const before = await queued(withRun(true));
    expect(before).toBeGreaterThan(0);
    expect(await queued(withRun(false))).toBe(0);
  });

  it("a report wired to an input step that is off, or a run step that is off, queues nothing", () => {
    expect(reportStartsAt(withRun(true, (c) => (c.nodes.find((n) => n.id === "jobReport")!.on = false)))).toBeNull();
    expect(reportStartsAt(withRun(true, (c) => (c.nodes.find((n) => n.id === "reportRun")!.on = false)))).toBeNull();
  });

  it("the config refuses a run step wired anywhere its code cannot start, or by a wire that is not a generator", () => {
    const elsewhere = withRun(false, (c) => c.edges.push({ from: "reportRun", to: "fd", mode: "generator", when: ["*"] }));
    expect(configProblems(elsewhere)).toContain('reportRun cannot start fd');
    const waits = withRun(false, (c) => c.edges.push({ from: "reportRun", to: "jobReport", mode: "wait", when: ["*"] }));
    expect(configProblems(waits).some((p: string) => p.includes("needs generator"))).toBe(true);
    const stray = withRun(true, (c) => c.nodes.push({ id: "otherRun", label: "x", on: true, model: "code", kind: "run" }));
    expect(configProblems(stray).some((p: string) => p.includes('otherRun: unknown run step'))).toBe(true);
  });
});
