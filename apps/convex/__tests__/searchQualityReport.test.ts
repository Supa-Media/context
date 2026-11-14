import { describe, expect, test } from "vitest";
import { api } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ADMIN_EMAILS_ENV_VAR } from "../functions/lib/admin";
import { dayKey } from "../functions/lib/usage";
import { type TestConvex, asUser, createUser, createWorkspace, setupTest } from "./fixtures.helpers";

/**
 * THE QUALITY NUMBERS OF THE SEARCH TAB. Each figure is worked out by hand
 * below, from seeded rows, so a wrong definition fails a named test.
 *
 * Only quality rows count (rows with `who`). Timing-only rows never do.
 */

const ADMIN = "staff@example.invalid";
const DAY = 86_400_000;
const SECOND = 1000;

async function world() {
  process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
  const t = setupTest();
  const staff = await createUser(t, ADMIN);
  const ada = await createUser(t, "ada@example.invalid");
  const workspaceId = await createWorkspace(t, ada, "ada", { kind: "personal" });
  return { t, staff, ada, workspaceId };
}

type Seed = {
  workspaceId: Id<"workspaces">;
  who?: "app" | "ai" | "tex";
  at: number;
  ms: number;
  opened?: number;
  again?: boolean;
  answeredBy?: "fast" | "index" | "scan";
};

async function seed(t: TestConvex, rows: Seed[]) {
  await t.run(async (ctx) => {
    for (const row of rows) {
      const surface = row.who === "app" ? "screen" : row.who === undefined ? "app" : "ai";
      await ctx.db.insert("searchTimings", {
        workspaceId: row.workspaceId,
        surface,
        found: row.opened !== undefined,
        ms: row.ms,
        at: row.at,
        ...(row.answeredBy === undefined ? {} : { answeredBy: row.answeredBy }),
        // The app's row has no actor (it pairs on the device); a gateway row carries its HMAC.
        ...(row.who === undefined ? {} : { who: row.who, ...(row.who === "app" ? {} : { actor: "aaaaaaaaaaaaaaaa" }) }),
        ...(row.opened === undefined ? {} : { opened: row.opened }),
        ...(row.again === undefined ? {} : { again: row.again }),
      });
    }
  });
}

async function report(t: TestConvex, staff: Id<"users">, args: { days?: number; workspace?: string } = { days: 7 }) {
  return await asUser(t, staff).query(api.functions.admin.searchReport, args);
}

describe("quality: the window's figures, by who searched", () => {
  /**
   * Current window (7 days), quality rows:
   *  app (screen, who app), 5:  opened 1 ms100 | opened 2 ms200 | opened 5 ms300 | again ms400 | gave up ms1000
   *  ai (who ai), 4:           opened 3 ms2000 (index) | opened 1 ms3000 (fast) | again ms4000 (index) | gave up ms6000 (scan)
   *  tex (who tex), 2:         opened 6 ms700 (fast) | again ms800 (fast)
   *  timing-only rows (no who), 2: never counted.
   * Prior window: app 2 rows (opened 1, gave up), ai 1 row (gave up).
   */
  async function scenario() {
    const w = await world();
    const now = Date.now();
    const at = (k: number) => now - k * SECOND;
    const ws = w.workspaceId;
    await seed(w.t, [
      { workspaceId: ws, who: "app", at: at(1), ms: 100, opened: 1 },
      { workspaceId: ws, who: "app", at: at(2), ms: 200, opened: 2 },
      { workspaceId: ws, who: "app", at: at(3), ms: 300, opened: 5 },
      { workspaceId: ws, who: "app", at: at(4), ms: 400, again: true },
      { workspaceId: ws, who: "app", at: at(5), ms: 1000 },
      { workspaceId: ws, who: "ai", at: at(6), ms: 2000, opened: 3, answeredBy: "index" },
      { workspaceId: ws, who: "ai", at: at(7), ms: 3000, opened: 1, answeredBy: "fast" },
      { workspaceId: ws, who: "ai", at: at(8), ms: 4000, again: true, answeredBy: "index" },
      { workspaceId: ws, who: "ai", at: at(9), ms: 6000, answeredBy: "scan" },
      { workspaceId: ws, who: "tex", at: at(10), ms: 700, opened: 6, answeredBy: "fast" },
      { workspaceId: ws, who: "tex", at: at(11), ms: 800, again: true, answeredBy: "fast" },
      { workspaceId: ws, at: at(12), ms: 5 },
      { workspaceId: ws, at: at(13), ms: 99_999 },
      // The prior window: 7 to 14 days back.
      { workspaceId: ws, who: "app", at: now - 8 * DAY, ms: 50, opened: 1 },
      { workspaceId: ws, who: "app", at: now - 8 * DAY, ms: 60 },
      { workspaceId: ws, who: "ai", at: now - 9 * DAY, ms: 90 },
    ]);
    return w;
  }

  test("all: found, position, next, time, and the previous window's found", async () => {
    const { t, staff } = await scenario();
    const { all } = (await report(t, staff)).quality;
    expect(all).toEqual({
      n: 11,
      found: 55, // 6 of 11 opened
      pos: [18, 9, 9, 9, 9], // first 2, second 1, third 1, fourth-or-fifth 1, sixth-or-later 1
      next: [27, 18], // again 3 of 11, gave up 2 of 11
      ms: [800, 6000], // nearest rank over 11 times
      foundBefore: 33, // 1 of the 3 prior searches opened
    });
  });

  test("app: the device's searches only", async () => {
    const { t, staff } = await scenario();
    const { app } = (await report(t, staff)).quality;
    expect(app).toEqual({
      n: 5,
      found: 60,
      pos: [20, 20, 0, 20, 0],
      next: [20, 20],
      ms: [300, 1000],
      foundBefore: 50,
    });
  });

  test("ai: the gateway's AI client searches only", async () => {
    const { t, staff } = await scenario();
    const { ai } = (await report(t, staff)).quality;
    expect(ai).toEqual({
      n: 4,
      found: 50,
      pos: [25, 0, 25, 0, 0],
      next: [25, 25],
      ms: [3000, 6000],
      foundBefore: 0,
    });
  });

  test("tex: Tex's own searches only", async () => {
    const { t, staff } = await scenario();
    const { tex } = (await report(t, staff)).quality;
    expect(tex).toEqual({
      n: 2,
      found: 50,
      pos: [0, 0, 0, 0, 50],
      next: [50, 0],
      ms: [700, 800],
      foundBefore: 0,
    });
  });

  test("byIndex: among quality rows that name the index, by share, found, first and p50", async () => {
    const { t, staff } = await scenario();
    const { byIndex } = (await report(t, staff)).quality;
    expect(byIndex).toEqual([
      { answeredBy: "fast", share: 50, found: 67, first: 50, p50: 800 },
      { answeredBy: "index", share: 33, found: 50, first: 0, p50: 2000 },
      { answeredBy: "scan", share: 17, found: 0, first: 0, p50: 6000 },
    ]);
  });

  test("the per-day series holds found, first, p50 and p95 for each key", async () => {
    const t = setupTest();
    const staff = await createUser(t, ADMIN);
    process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
    const ada = await createUser(t, "ada@example.invalid");
    const workspaceId = await createWorkspace(t, ada, "ada", { kind: "personal" });
    const day = Date.now() - 2 * DAY;
    await seed(t, [
      { workspaceId, who: "app", at: day, ms: 100, opened: 1 },
      { workspaceId, who: "app", at: day + SECOND, ms: 300 },
    ]);
    const { series } = (await report(t, staff)).quality;
    expect(series).toHaveLength(7);
    const bucket = series.find((entry) => entry.label === dayKey(day))!;
    expect(bucket.app).toEqual({ found: 50, first: 100, p50: 100, p95: 300 });
    expect(bucket.ai).toEqual({ found: 0, first: 0, p50: 0, p95: 0 });
    expect(bucket.all).toEqual(bucket.app);
    expect(bucket.tex).toEqual({ found: 0, first: 0, p50: 0, p95: 0 });
  });

  test("a one-day window draws the series by the hour", async () => {
    const { t, staff } = await scenario();
    const { series } = (await report(t, staff, { days: 1 })).quality;
    expect(series).toHaveLength(24);
  });

  test("the quality figures leave the timing-only rows out, and the window is respected", async () => {
    const { t, staff, workspaceId } = await scenario();
    await seed(t, [{ workspaceId, who: "ai", at: Date.now() - 20 * DAY, ms: 9, opened: 1 }]);
    const { all } = (await report(t, staff)).quality;
    expect(all.n).toBe(11);
  });
});

describe("quality: the workspaces where search misses most", () => {
  test("only workspaces with ten or more quality searches, lowest found first, with the reason", async () => {
    process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
    const t = setupTest();
    const staff = await createUser(t, ADMIN);
    const ada = await createUser(t, "ada@example.invalid");
    const bo = await createUser(t, "bo@example.invalid");
    const carol = await createUser(t, "carol@example.invalid");
    const dan = await createUser(t, "dan@example.invalid");
    const adaWs = await createWorkspace(t, ada, "ada", { kind: "personal" });
    const boWs = await createWorkspace(t, bo, "bo", { kind: "personal" });
    const carolWs = await createWorkspace(t, carol, "carol", { kind: "personal" });
    const danWs = await createWorkspace(t, dan, "dan", { kind: "personal" });
    const now = Date.now();
    const many = (workspaceId: Id<"workspaces">, n: number, opened: number) =>
      Array.from({ length: n }, (_, i) => ({
        workspaceId,
        who: "ai" as const,
        at: now - (i + 1) * SECOND,
        ms: 100,
        ...(i < opened ? { opened: 1 } : {}),
      }));
    await seed(t, [
      ...many(adaWs, 11, 6), // 55%
      ...many(boWs, 10, 3), // 30%, the index failed
      ...many(carolWs, 10, 1), // 10%, the owner turned meaning off
      ...many(danWs, 9, 0), // too few to count
    ]);
    await t.run(async (ctx) => {
      await ctx.db.insert("meaningIndexes", {
        workspaceId: boWs,
        enabled: true,
        enabledAt: now,
        status: "failed",
        updatedAt: now,
        createdAt: now,
      });
      await ctx.db.insert("meaningIndexes", {
        workspaceId: carolWs,
        enabled: false,
        optedOut: true,
        enabledAt: now,
        status: "off",
        updatedAt: now,
        createdAt: now,
      });
    });
    const { misses } = (await report(t, staff)).quality;
    expect(misses).toEqual([
      { workspaceId: carolWs, slug: "carol", n: 10, found: 10, why: "meaning off by owner" },
      { workspaceId: boWs, slug: "bo", n: 10, found: 30, why: "index failed" },
      { workspaceId: adaWs, slug: "ada", n: 11, found: 55, why: null },
    ]);
  });
});

describe("quality: staff only", () => {
  test("a signed-in member who is not staff gets no quality figures", async () => {
    const { t, ada } = await world();
    await expect(asUser(t, ada).query(api.functions.admin.searchReport, { days: 7 })).rejects.toThrow();
  });
});
