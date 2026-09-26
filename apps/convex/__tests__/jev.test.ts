/**
 * Jev smarts: one gate, one meter, one set of switches, and nobody around them.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   `withJev` skipping the gate (session always opened)                 1
 *   `withJev` not flushing usage on a throw                             1
 *   `featureIsOn` ignoring the "*" switch                               2
 *   a `fetch(".../decide")` pasted into functions/organizer.ts          1
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { type JevCtx, withJev } from "../functions/lib/jev/client";
import { JEV_FEATURES } from "../functions/lib/jev/features";
import { DEFAULT_USD_PER_MTOK, costMicroUsd, disabledByEnv, utcDay } from "../functions/lib/jev/meter";
import type { JevTransport } from "../functions/lib/jev/worker";
import { type TestConvex, addMember, asUser, createUser, createWorkspace, setupTest } from "./fixtures.helpers";

const FUNCTIONS_ROOT = join(__dirname, "..", "functions");
const JEV_DIR = join(FUNCTIONS_ROOT, "lib", "jev");
/** What only `lib/jev/` may say: the route and the model. */
const JEV_MARKERS = [/["'`/]decide["'`]/, /\/decide\b/, /typesafe\/jev/];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.(ts|js|mjs)$/.test(name)) out.push(path);
  }
  return out;
}

function reachesJevDirectly(text: string): boolean {
  return JEV_MARKERS.some((marker) => marker.test(text));
}

const ADMIN = "staff@example.invalid";
const REQUEST = { state: "Shipped the fix on Tuesday.", questions: { shipped: { type: "noul", instructions: "Did it ship?", criteria: { true: "yes", false: "no" } } } };

function fakeTransport(answer: Record<string, unknown> | null = { shipped: { type: "noul", noul: 0.9 } }) {
  const sent: unknown[] = [];
  const transport: JevTransport = {
    async send(request) {
      sent.push(request);
      return answer;
    },
  };
  return { transport, sent };
}

function jevCtx(t: TestConvex): JevCtx {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runQuery: ((ref: any, args: any) => t.query(ref, args)) as JevCtx["runQuery"],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    runMutation: ((ref: any, args: any) => t.mutation(ref, args)) as JevCtx["runMutation"],
  };
}

async function payingWorkspace(t: TestConvex, slug = "acme") {
  const owner = await createUser(t, `${slug}-owner@example.invalid`);
  const workspaceId = await createWorkspace(t, owner, slug, { kind: "shared" });
  const now = Date.now();
  await t.run((ctx) =>
    ctx.db.insert("workspacePlans", { workspaceId, managedStorage: false, fastSearch: true, status: "active", createdAt: now, updatedAt: now }),
  );
  return { owner, workspaceId };
}

async function switchOn(t: TestConvex, feature: string, off = false) {
  await t.run((ctx) => ctx.db.insert("jevSwitches", { feature, off, updatedAt: Date.now() }));
}

async function usage(t: TestConvex, workspaceId: Id<"workspaces">) {
  return await t.run((ctx) =>
    ctx.db
      .query("jevUsage")
      .withIndex("by_day_feature_workspace", (q) => q.eq("day", utcDay(Date.now())).eq("feature", "organizer").eq("workspaceId", workspaceId))
      .unique(),
  );
}

afterEach(() => {
  delete process.env.JEV_DISABLED;
  delete process.env.JEV_USD_PER_MTOK;
});

describe("nothing reaches Jev except through lib/jev", () => {
  test("no other file in the control plane names the route or the model", () => {
    const offenders = sourceFiles(FUNCTIONS_ROOT)
      .filter((path) => !path.startsWith(JEV_DIR))
      .filter((path) => reachesJevDirectly(readFileSync(path, "utf8")))
      .map((path) => relative(FUNCTIONS_ROOT, path));
    expect(offenders).toEqual([]);
  });

  test("the scan is live: it catches a direct call and the worker file itself", () => {
    expect(reachesJevDirectly('await fetch(`${url}/decide`, { method: "POST" })')).toBe(true);
    expect(reachesJevDirectly('env.AI.run("typesafe/jev", input)')).toBe(true);
    expect(reachesJevDirectly(readFileSync(join(JEV_DIR, "worker.ts"), "utf8"))).toBe(true);
    expect(reachesJevDirectly("const decided = decide(request);")).toBe(false);
  });

  test("every feature is registered with a cap and a default", () => {
    for (const feature of Object.values(JEV_FEATURES)) {
      expect(feature.dailyCallsPerWorkspace).toBeGreaterThan(0);
      expect(typeof feature.onByDefault).toBe("boolean");
    }
  });
});

describe("the gate", () => {
  test("a feature that ships off stays off until switched on", async () => {
    const t = setupTest();
    const { workspaceId } = await payingWorkspace(t);
    expect(JEV_FEATURES.organizer.onByDefault).toBe(false);
    expect(await t.query(internal.functions.jev.gate, { feature: "organizer", workspaceId })).toEqual({ allowed: false, reason: "switched_off" });
    await switchOn(t, "organizer");
    expect(await t.query(internal.functions.jev.gate, { feature: "organizer", workspaceId })).toMatchObject({ allowed: true });
  });

  test("the all-features switch beats a feature switched on", async () => {
    const t = setupTest();
    const { workspaceId } = await payingWorkspace(t);
    await switchOn(t, "organizer");
    await switchOn(t, "*", true);
    expect(await t.query(internal.functions.jev.gate, { feature: "organizer", workspaceId })).toEqual({ allowed: false, reason: "switched_off" });
  });

  test("JEV_DISABLED stops a feature without touching the database", async () => {
    const t = setupTest();
    const { workspaceId } = await payingWorkspace(t);
    await switchOn(t, "organizer");
    process.env.JEV_DISABLED = "organizer";
    expect(await t.query(internal.functions.jev.gate, { feature: "organizer", workspaceId })).toEqual({ allowed: false, reason: "disabled" });
    expect(disabledByEnv("organizer", { JEV_DISABLED: "all" })).toBe(true);
    expect(disabledByEnv("organizer", { JEV_DISABLED: "search,other" })).toBe(false);
  });

  test("a free workspace is refused", async () => {
    const t = setupTest();
    const owner = await createUser(t, "nopay@example.invalid");
    const workspaceId = await createWorkspace(t, owner, "nopay-team", { kind: "shared" });
    await switchOn(t, "organizer");
    expect(await t.query(internal.functions.jev.gate, { feature: "organizer", workspaceId })).toEqual({ allowed: false, reason: "not_premium" });
  });

  test("the daily cap is enforced from the meter", async () => {
    const t = setupTest();
    const { workspaceId } = await payingWorkspace(t);
    await switchOn(t, "organizer");
    const cap = JEV_FEATURES.organizer.dailyCallsPerWorkspace;
    await t.mutation(internal.functions.jev.recordUsage, { feature: "organizer", workspaceId, calls: cap - 1, failed: 1, refused: 0, questions: 0, tokens: 0, ms: 0 });
    expect(await t.query(internal.functions.jev.gate, { feature: "organizer", workspaceId })).toEqual({ allowed: false, reason: "daily_cap" });
  });
});

describe("withJev", () => {
  test("switched off, the feature gets no session and nothing is sent", async () => {
    const t = setupTest();
    const { workspaceId } = await payingWorkspace(t);
    const { transport, sent } = fakeTransport();
    const refusal = await withJev(jevCtx(t), { feature: "organizer", workspaceId, transport }, async (jev, why) => {
      expect(jev).toBeNull();
      return why;
    });
    expect(refusal).toBe("switched_off");
    expect(sent).toHaveLength(0);
    expect((await usage(t, workspaceId))?.refused).toBe(1);
  });

  test("every answer is counted, with tokens and cost", async () => {
    const t = setupTest();
    const { workspaceId } = await payingWorkspace(t);
    await switchOn(t, "organizer");
    const { transport, sent } = fakeTransport();
    await withJev(jevCtx(t), { feature: "organizer", workspaceId, transport }, async (jev) => {
      expect(await jev!.decide(REQUEST)).not.toBeNull();
      expect(await jev!.decide(REQUEST)).not.toBeNull();
    });
    expect(sent).toHaveLength(2);
    const row = await usage(t, workspaceId);
    expect(row).toMatchObject({ calls: 2, failed: 0, refused: 0, questions: 2 });
    expect(row!.tokens).toBeGreaterThan(0);
    expect(row!.costMicroUsd).toBe(costMicroUsd(row!.tokens));
  });

  test("a failure is counted as failed and read as no answer", async () => {
    const t = setupTest();
    const { workspaceId } = await payingWorkspace(t);
    await switchOn(t, "organizer");
    const { transport } = fakeTransport(null);
    await withJev(jevCtx(t), { feature: "organizer", workspaceId, transport }, async (jev) => {
      expect(await jev!.decide(REQUEST)).toBeNull();
    });
    expect(await usage(t, workspaceId)).toMatchObject({ calls: 0, failed: 1 });
  });

  test("usage is written even when the feature throws", async () => {
    const t = setupTest();
    const { workspaceId } = await payingWorkspace(t);
    await switchOn(t, "organizer");
    const { transport } = fakeTransport();
    await expect(
      withJev(jevCtx(t), { feature: "organizer", workspaceId, transport }, async (jev) => {
        await jev!.decide(REQUEST);
        throw new Error("feature bug");
      }),
    ).rejects.toThrow("feature bug");
    expect((await usage(t, workspaceId))?.calls).toBe(1);
  });

  test("a run cannot go past the cap it opened with", async () => {
    const t = setupTest();
    const { workspaceId } = await payingWorkspace(t);
    await switchOn(t, "organizer");
    const cap = JEV_FEATURES.organizer.dailyCallsPerWorkspace;
    await t.mutation(internal.functions.jev.recordUsage, { feature: "organizer", workspaceId, calls: cap - 1, failed: 0, refused: 0, questions: 0, tokens: 0, ms: 0 });
    const { transport, sent } = fakeTransport();
    await withJev(jevCtx(t), { feature: "organizer", workspaceId, transport }, async (jev) => {
      expect(await jev!.decide(REQUEST)).not.toBeNull();
      expect(await jev!.decide(REQUEST)).toBeNull();
    });
    expect(sent).toHaveLength(1);
  });
});

describe("the admin report and switch", () => {
  test("only staff may read usage or flip a switch", async () => {
    const t = setupTest();
    process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
    const stranger = await createUser(t, "stranger@example.invalid");
    await expect(asUser(t, stranger).query(api.functions.admin.jevUsageReport, {})).rejects.toThrow();
    await expect(asUser(t, stranger).mutation(api.functions.admin.setJevSwitch, { feature: "*", off: true })).rejects.toThrow();
    await expect(t.mutation(api.functions.admin.setJevSwitch, { feature: "*", off: true })).rejects.toThrow();
  });

  test("staff see calls and cost per feature, and can switch everything off", async () => {
    const t = setupTest();
    process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
    const staff = await createUser(t, ADMIN);
    const { workspaceId } = await payingWorkspace(t);
    await asUser(t, staff).mutation(api.functions.admin.setJevSwitch, { feature: "organizer", off: false });
    await t.mutation(internal.functions.jev.recordUsage, { feature: "organizer", workspaceId, calls: 10, failed: 1, refused: 2, questions: 30, tokens: 1_000_000, ms: 500 });
    const report = await asUser(t, staff).query(api.functions.admin.jevUsageReport, { days: 7 });
    expect(report.usdPerMtok).toBe(DEFAULT_USD_PER_MTOK);
    const organizer = report.features.find((row) => row.feature === "organizer")!;
    expect(organizer).toMatchObject({ on: true, workspaces: 1, calls: 10, failed: 1, refused: 2, tokens: 1_000_000 });
    expect(organizer.costUsd).toBeCloseTo(DEFAULT_USD_PER_MTOK);

    await asUser(t, staff).mutation(api.functions.admin.setJevSwitch, { feature: "*", off: true });
    const after = await asUser(t, staff).query(api.functions.admin.jevUsageReport, {});
    expect(after.allOff).toBe(true);
    expect(after.features.every((row) => !row.on)).toBe(true);
    await expect(asUser(t, staff).mutation(api.functions.admin.setJevSwitch, { feature: "nope", off: true })).rejects.toThrow();
  });
});

describe("auto-organize rides the switch", () => {
  test("while its switch is off, a paying owner sees nothing to turn on", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await payingWorkspace(t);
    const status = await asUser(t, owner).query(api.functions.organizer.status, { workspaceId });
    expect(status).toMatchObject({ available: false, on: false, noticeNeeded: false });
  });

  test("switched on: the owner owes the notice, a member sees none of it", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await payingWorkspace(t);
    await switchOn(t, "organizer");
    expect(await asUser(t, owner).query(api.functions.organizer.status, { workspaceId })).toMatchObject({
      available: true,
      isOwner: true,
      on: true,
      noticeNeeded: true,
      startsAt: null,
    });
    const member = await createUser(t, "member@example.invalid");
    await addMember(t, workspaceId, member, "editor");
    expect(await asUser(t, member).query(api.functions.organizer.status, { workspaceId })).toMatchObject({ isOwner: false, noticeNeeded: false, pending: 0 });
    await expect(asUser(t, member).mutation(api.functions.organizer.setEnabled, { workspaceId, on: false })).rejects.toThrow();
    const stranger = await createUser(t, "stranger@example.invalid");
    expect(await asUser(t, stranger).query(api.functions.organizer.status, { workspaceId })).toBeNull();
  });

  test("seeing the notice schedules the first sweep a day out, and turning it off holds", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await payingWorkspace(t);
    await switchOn(t, "organizer");
    const before = Date.now();
    await asUser(t, owner).mutation(api.functions.organizer.acknowledgeNotice, { workspaceId });
    const status = await asUser(t, owner).query(api.functions.organizer.status, { workspaceId });
    expect(status!.noticeNeeded).toBe(false);
    expect(status!.startsAt).toBeGreaterThanOrEqual(before + 24 * 60 * 60 * 1000);

    await asUser(t, owner).mutation(api.functions.organizer.acknowledgeNotice, { workspaceId, turnOff: true });
    expect(await asUser(t, owner).query(api.functions.organizer.status, { workspaceId })).toMatchObject({ on: false, startsAt: null });
  });

  test("the control plane row holds switches and numbers, never a path", async () => {
    const t = setupTest();
    const { owner, workspaceId } = await payingWorkspace(t);
    await switchOn(t, "organizer");
    await asUser(t, owner).mutation(api.functions.organizer.setAutopilot, { workspaceId, kind: "archive", on: true });
    const row = await t.run((ctx) => ctx.db.query("organizerSettings").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).unique());
    expect(JSON.stringify(row)).not.toMatch(/\.md|\/|projects|inbox/);
  });
});
