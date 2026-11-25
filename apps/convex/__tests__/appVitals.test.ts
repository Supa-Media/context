import { describe, expect, test } from "vitest";
import { api, internal } from "../_generated/api";
import { MAX_VITAL_MS, VITALS_PER_HOUR, VITALS_RETENTION_DAYS, vitalShape } from "../functions/appVitals";
import { asUser, createUser, gatewayPost, setupTest } from "./fixtures.helpers";

/**
 * The app's own vitals for the Context usage source (`functions/appVitals.ts`): Start time, Load time, Clean sessions.
 *
 * Sabotage record (temporary local edits, reverted):
 * 1. `report` storing without a signed-in caller: "signed out, nothing is kept" fails.
 * 2. `report` skipping the repeat check: "one row per session per kind" fails.
 */

const S1 = "0123456789abcdef";
const S2 = "fedcba9876543210";
const DAY = 86_400_000;

describe("app vitals", () => {
  test("a report is a session id, and milliseconds only on a timing, in range", () => {
    expect(vitalShape({ kind: "start", ms: 1200, session: S1 })).toBe(true);
    expect(vitalShape({ kind: "session", session: S1 })).toBe(true);
    expect(vitalShape({ kind: "session", ms: 5, session: S1 })).toBe(false);
    expect(vitalShape({ kind: "load", session: S1 })).toBe(false);
    expect(vitalShape({ kind: "load", ms: MAX_VITAL_MS + 1, session: S1 })).toBe(false);
    expect(vitalShape({ kind: "load", ms: -1, session: S1 })).toBe(false);
    expect(vitalShape({ kind: "error", session: "user_123" })).toBe(false);
  });

  test("signed out, nothing is kept", async () => {
    const t = setupTest();
    expect(await t.mutation(api.functions.appVitals.report, { platform: "web", kind: "session", session: S1 })).toBe(false);
    expect(await t.run((ctx) => ctx.db.query("appVitals").collect())).toEqual([]);
  });

  test("one row per session per kind, and a row names no account", async () => {
    const t = setupTest();
    const me = asUser(t, await createUser(t, "vitals@example.invalid"));
    expect(await me.mutation(api.functions.appVitals.report, { platform: "ios", kind: "session", session: S1 })).toBe(true);
    expect(await me.mutation(api.functions.appVitals.report, { platform: "ios", kind: "session", session: S1 })).toBe(false);
    expect(await me.mutation(api.functions.appVitals.report, { platform: "ios", kind: "start", ms: 1834.6, session: S1 })).toBe(true);
    expect(await me.mutation(api.functions.appVitals.report, { platform: "ios", kind: "error", session: S1 })).toBe(true);
    expect(await me.mutation(api.functions.appVitals.report, { platform: "web", kind: "load", ms: 900, session: S2 })).toBe(true);
    const rows = await t.run((ctx) => ctx.db.query("appVitals").collect());
    expect(rows.map(({ platform, kind, ms, session }) => ({ platform, kind, ms, session }))).toEqual([
      { platform: "ios", kind: "session", ms: undefined, session: S1 },
      { platform: "ios", kind: "start", ms: 1835, session: S1 },
      { platform: "ios", kind: "error", ms: undefined, session: S1 },
      { platform: "web", kind: "load", ms: 900, session: S2 },
    ]);
    for (const row of rows) expect(Object.keys(row).every((k) => ["_creationTime", "_id", "at", "platform", "kind", "ms", "session"].includes(k))).toBe(true);
  });

  test("a client in a loop is cut off after the hour's budget", async () => {
    const t = setupTest();
    const me = asUser(t, await createUser(t, "loop@example.invalid"));
    let kept = 0;
    for (let i = 0; i < VITALS_PER_HOUR + 5; i += 1) {
      if (await me.mutation(api.functions.appVitals.report, { platform: "web", kind: "session", session: i.toString(16).padStart(16, "0") })) kept += 1;
    }
    expect(kept).toBe(VITALS_PER_HOUR);
  });

  test("rows past their retention are pruned, and the gateway's export carries the rest", async () => {
    const t = setupTest();
    const now = Date.now();
    await t.run(async (ctx) => {
      await ctx.db.insert("appVitals", { at: now - (VITALS_RETENTION_DAYS + 1) * DAY, platform: "web", kind: "session", session: S1 });
      await ctx.db.insert("appVitals", { at: now - DAY, platform: "android", kind: "start", ms: 2400, session: S2 });
    });
    await t.mutation(internal.functions.appVitals.prune, { at: now });
    const response = await gatewayPost(t, "/gateway/usage/export", { since: 0 });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.vitals).toEqual([{ at: now - DAY, platform: "android", kind: "start", ms: 2400, session: S2 }]);
  });
});
