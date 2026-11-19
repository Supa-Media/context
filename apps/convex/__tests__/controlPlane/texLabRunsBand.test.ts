/**
 * Lab runs with repeats and a noise band (`functions/texLabRuns.ts`; `packages/shared/src/texRunBand.cjs`; Dev2,
 * 2026-11-19: "repeat each Front door test N times ... a draft wins only if it clears the band vs its base"). Pinned:
 * what a report keeps of a score, its repeats, its fidelity and each row's runs and passes (and drops the junk); how
 * many repeats a run may ask for (1 to 5, 3 by default, a run from before repeats ran once); and that a draft's Dev
 * run is read against main's newest Dev run on the same models and set, never against a run it is not comparable to.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { bandOf } from "@context/shared/src/texRunBand.cjs";
import { PINNED_CONTEXT_SLUG } from "@context/shared";
import { api, internal } from "../../_generated/api";
import { hashToken } from "../../functions/lib/crypto";
import { cleanResults, vsBase } from "../../functions/texLabRuns";
import { addMember, createUser, createWorkspace, drainScheduled } from "../fixtures.helpers";
import { ACCESS_A, twoConnectedTenants } from "./fixtures.helpers";
import { withSession } from "../session.helpers";

vi.setConfig({ testTimeout: 30_000 });

const STAFF = "staff@example.invalid";
const RUN_URL = "https://github.com/example/repo/actions/runs/123";
const TOTAL = 30;

beforeEach(() => {
  vi.stubEnv("ADMIN_EMAILS", `${STAFF},alice@example.invalid`);
  vi.stubEnv("GH_ADMIN_TOKEN", "ghp_fake_for_tests");
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ html_url: RUN_URL }), { status: 200 }));
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type RunLike = Parameters<typeof vsBase>[0];

/** A finished run as `shown` lists it, with the score of the given per-repeat pass counts. */
function run(id: string, o: { versionId?: string; kind?: string; set?: string | null; models?: string; stage?: string; passes?: number[] }): RunLike {
  const passes = o.passes ?? [13];
  const score = bandOf(passes, TOTAL);
  return {
    id,
    versionId: o.versionId ?? "vdraft1",
    kind: o.kind ?? "dev",
    set: o.set === undefined ? "dev" : o.set,
    models: o.models ?? "gw",
    stage: o.stage ?? "done",
    startedAt: Number(id.replace(/\D/g, "")) || 0,
    results: { pass: score.mean, total: TOTAL, score, repeats: passes.length },
  };
}

describe("cleanResults keeps a band and drops the junk", () => {
  test("a report keeps its score, repeats, fidelity, each entry's min and max, and each row's runs and passes", () => {
    const out = cleanResults({
      pass: 13.67,
      total: TOTAL,
      repeats: 3,
      score: { mean: 13.67, min: 11, max: 15, lo: 9.1, hi: 18.2, repeats: 3, total: TOTAL, extra: "dropped" },
      fidelity: "model family only",
      fidelityWhy: "x".repeat(400),
      perNode: [{ node: "decide", pass: 4.5, total: 10, min: 4, max: 5 }],
      perConv: [{ id: "a", pass: 2, total: 3 }],
      rows: [
        { convId: "a", msgIndex: 0, node: "decide", ok: true, got: "", want: "", runs: 3, passes: 0 },
        { convId: "b", msgIndex: 1, node: "decide", ok: false, got: "", want: "", runs: 0, passes: 5 },
      ],
    });
    expect(out.pass).toBe(13.67);
    expect(out.repeats).toBe(3);
    expect(out.score).toEqual({ mean: 13.67, min: 11, max: 15, lo: 9.1, hi: 18.2, repeats: 3, total: TOTAL });
    expect(out.fidelity).toBe("model family only");
    expect(out.fidelityWhy).toHaveLength(300);
    expect(out.perNode[0]).toEqual({ node: "decide", pass: 4.5, total: 10, min: 4, max: 5 });
    expect(out.perConv[0]).not.toHaveProperty("min");
    // A row that failed every repeat keeps passes 0; a row with no runs carries neither.
    expect(out.rows[0]).toMatchObject({ runs: 3, passes: 0 });
    expect(out.rows[1]).not.toHaveProperty("runs");
    expect(out.rows[1]).not.toHaveProperty("passes");
  });

  test("a report from before repeats has none of the new fields, and a bad score, repeat count or label is left out", () => {
    const old = cleanResults({ pass: 12, total: TOTAL, rows: [] });
    expect(old).not.toHaveProperty("score");
    expect(old).not.toHaveProperty("repeats");
    expect(old).not.toHaveProperty("fidelity");
    const junk = cleanResults({ score: { mean: "13", min: 1 }, repeats: "3", fidelity: 42, perNode: [{ node: "x", min: "4" }] });
    expect(junk).not.toHaveProperty("score");
    expect(junk).not.toHaveProperty("repeats");
    expect(junk).not.toHaveProperty("fidelity");
    expect(junk.perNode[0]).not.toHaveProperty("min");
    expect(cleanResults(null)).not.toHaveProperty("score");
    expect(cleanResults({ fidelity: "y".repeat(100) }).fidelity).toHaveLength(40);
  });
});

describe("vsBase: a draft's run against main's newest Dev run", () => {
  const main = [run("r100", { versionId: "main", passes: [11, 15, 13] })];

  test("a draft wins only when its worst repeat beats main's best", () => {
    const v = vsBase(run("r200", { passes: [16, 17, 18] }), main);
    expect(v).toMatchObject({ verdict: "wins", baseRunId: "r100" });
    expect(v?.why).toContain("above");
  });

  test("overlapping bands are within noise, and a draft below main's worst repeat loses", () => {
    expect(vsBase(run("r200", { passes: [12, 13, 14] }), main)).toMatchObject({ verdict: "within noise", baseRunId: "r100" });
    expect(vsBase(run("r200", { passes: [8, 9, 10] }), main)).toMatchObject({ verdict: "loses", baseRunId: "r100" });
  });

  test("a single repeat has no band; a run with no main run to read is no base", () => {
    expect(vsBase(run("r200", { passes: [20] }), main)).toMatchObject({ verdict: "no band" });
    expect(vsBase(run("r200", { passes: [20, 21, 22] }), [])).toEqual({ verdict: "no base", why: expect.any(String), baseRunId: null });
  });

  test("different models or a different set are not compared, and main's newest finished run is the base", () => {
    expect(vsBase(run("r200", { passes: [16, 17, 18], models: "cc" }), main)).toMatchObject({ verdict: "no base", baseRunId: null });
    expect(vsBase(run("r200", { passes: [16, 17, 18], set: "training" }), main)).toMatchObject({ verdict: "no base", baseRunId: null });
    const training = [run("r150", { versionId: "main", set: "training", passes: [1, 1, 1] })];
    expect(vsBase(run("r200", { passes: [16, 17, 18] }), training)).toMatchObject({ verdict: "no base" });
    const older = run("r90", { versionId: "main", passes: [1, 1, 1] });
    const newer = run("r100", { versionId: "main", passes: [11, 15, 13] });
    expect(vsBase(run("r200", { passes: [16, 17, 18] }), [older, newer])).toMatchObject({ verdict: "wins", baseRunId: "r100" });
  });

  test("main's runs, chat and node runs, and unfinished runs are never compared with main", () => {
    expect(vsBase(run("r200", { versionId: "main", passes: [16, 17, 18] }), main)).toBeNull();
    expect(vsBase(run("r200", { kind: "chat", passes: [16, 17, 18] }), main)).toBeNull();
    expect(vsBase(run("r200", { kind: "node", passes: [16, 17, 18] }), main)).toBeNull();
    expect(vsBase(run("r200", { stage: "running", passes: [16, 17, 18] }), main)).toBeNull();
  });
});

describe("a run's repeats", () => {
  async function world() {
    const tenants = await twoConnectedTenants();
    const staff = await createUser(tenants.t, STAFF);
    const pinned = await createWorkspace(tenants.t, staff, PINNED_CONTEXT_SLUG, { kind: "shared", displayName: "Context" });
    await addMember(tenants.t, pinned, tenants.alice, "editor", staff);
    const door = async (action: string, args: Record<string, unknown> = {}, token = ACCESS_A): Promise<Record<string, any>> =>
      (await tenants.t.mutation(internal.functions.texLabDrafts.forGateway, { hashedAccessToken: await hashToken(token), action, args })) as Record<string, any>;
    return { ...tenants, staff, door, lab: withSession(tenants.t, staff) };
  }

  test("the Lab asks for 1 to 5 repeats (3 by default) and a run records its own; anything else is refused and nothing is stored", async () => {
    const w = await world();
    await expect(w.lab.mutation(api.functions.texLabRuns.start, { versionId: "main", kind: "dev", repeats: 6 })).rejects.toThrow(/repeats is 1 to 5/);
    await expect(w.lab.mutation(api.functions.texLabRuns.start, { versionId: "main", kind: "dev", repeats: 0 })).rejects.toThrow(/repeats is 1 to 5/);
    expect(await w.door("run", { draft: "main", kind: "dev", repeats: 2.5 })).toMatchObject({ status: "bad_request" });
    const five = await w.lab.mutation(api.functions.texLabRuns.start, { versionId: "main", kind: "dev", repeats: 5 });
    const dflt = await w.lab.mutation(api.functions.texLabRuns.start, { versionId: "main", kind: "dev" });
    expect(await w.lab.query(api.functions.texLabRuns.get, { id: five.runId })).toMatchObject({ repeats: 5, fidelity: null });
    expect(await w.lab.query(api.functions.texLabRuns.get, { id: dflt.runId })).toMatchObject({ repeats: 3 });
    await drainScheduled(w.t);
  });

  test("a cc run is labelled model family only; a run from before repeats shows one repeat, and the workflow reads 3", async () => {
    const w = await world();
    const cc = await w.lab.mutation(api.functions.texLabRuns.start, { versionId: "main", kind: "dev", models: "cc" });
    expect(await w.lab.query(api.functions.texLabRuns.get, { id: cc.runId })).toMatchObject({ fidelity: "model family only" });
    const old = await w.t.run(async (ctx) =>
      await ctx.db.insert("texLabRuns", { versionId: "main", kind: "dev", models: "gw", stage: "done", by: w.staff, via: "lab", startedAt: Date.now() }),
    );
    expect(await w.lab.query(api.functions.texLabRuns.get, { id: old })).toMatchObject({ repeats: 1 });
    expect(await w.t.query(internal.functions.texLabRuns.job, { runId: old })).toMatchObject({ repeats: 3 });
    await drainScheduled(w.t);
  });

  test("runs of a draft say whether each clears main's band (vsMain), and a finished Dev run is the only kind compared", async () => {
    const w = await world();
    const insert = (row: Record<string, unknown>) => w.t.run(async (ctx) => await ctx.db.insert("texLabRuns", { by: w.staff, via: "lab", startedAt: Date.now(), ...row } as never));
    const scored = (passes: number[]) => ({ pass: bandOf(passes, TOTAL).mean, total: TOTAL, score: bandOf(passes, TOTAL), repeats: passes.length });
    const mainRun = await insert({ versionId: "main", kind: "dev", models: "gw", stage: "done", startedAt: 1, results: scored([11, 15, 13]) });
    const win = await insert({ versionId: "vdraft1", kind: "dev", models: "gw", stage: "done", startedAt: 2, results: scored([16, 17, 18]) });
    const tie = await insert({ versionId: "vdraft1", kind: "dev", models: "gw", stage: "done", startedAt: 3, results: scored([12, 13, 14]) });
    const onCc = await insert({ versionId: "vdraft1", kind: "dev", models: "cc", stage: "done", startedAt: 4, results: scored([16, 17, 18]) });
    const chat = await insert({ versionId: "vdraft1", kind: "chat", convId: "maya-and-tex", models: "gw", stage: "done", startedAt: 5, results: scored([16, 17, 18]) });
    const listed = (await w.door("runs", { draft: "vdraft1" })).runs as Array<{ id: string; vsMain: { verdict: string; baseRunId: string | null } | null; fidelity: string | null; repeats: number }>;
    expect(listed.find((r) => r.id === win)?.vsMain).toMatchObject({ verdict: "wins", baseRunId: mainRun });
    expect(listed.find((r) => r.id === tie)?.vsMain).toMatchObject({ verdict: "within noise", baseRunId: mainRun });
    expect(listed.find((r) => r.id === onCc)?.vsMain).toMatchObject({ verdict: "no base", baseRunId: null });
    expect(listed.find((r) => r.id === chat)?.vsMain).toBeNull();
    expect(listed.find((r) => r.id === win)).toMatchObject({ repeats: 1, fidelity: null });
    // Main's own runs are not compared with main.
    expect((await w.door("runs", { draft: "main" })).runs.find((r: { id: string }) => r.id === mainRun)?.vsMain).toBeNull();
  });
});
