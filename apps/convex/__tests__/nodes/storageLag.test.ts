/**
 * Storage keeping up with the file tree (project file `move-engine/plan.md`,
 * step C): the pace a move copies at, the time it has left, the deployment's
 * lag in admin › Search › Indexes, and the one mail each way when a move
 * falls behind the five-hour promise and when it catches up.
 *
 * Sabotage, each confirmed to fail a case here:
 *  - skip `lateAt` in `check` and the second check mails again;
 *  - drop the subscriber check in `scheduleStorageLagAlert` and a deployment
 *    nobody subscribed on schedules mail;
 *  - drop the `isAdminEmail` re-check in `facts` and a former staff member is
 *    mailed;
 *  - drop `ms` from the worker's `progress` call and no move has a pace.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { getFunctionName } from "convex/server";
import { api, internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { ADMIN_EMAILS_ENV_VAR } from "../../functions/lib/admin";
import { CATCH_UP_TARGET_MS, LATE_AFTER_MS, blendRate, etaMs, lateReason, workspaceEtaMs } from "../../functions/lib/nodes/moveLag";
import { STUCK_ATTEMPTS } from "../../functions/lib/nodes/moveRules";
import { runMoveWork } from "../../functions/lib/nodes/moveWork";

import { renderStorageLagAlert, spanWords } from "../../functions/lib/storageLagEmail";
import { STORAGE_LAG_ALERTS_PER_HOUR } from "../../functions/storageLag";
import { ADMIN, drain, fixture, start, type Fixture, type Store } from "./moveFixture.helpers";

const HOUR = 60 * 60_000;
const ENV_KEYS = [ADMIN_EMAILS_ENV_VAR, "RESEND_API_KEY", "APP_ORIGIN", "SITE_URL"] as const;
let previous: Map<string, string | undefined>;
let realFetch: typeof globalThis.fetch;
let mailbox: { to: string; subject: string; text: string; html: string }[];

beforeEach(() => {
  previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env[ADMIN_EMAILS_ENV_VAR] = ADMIN;
  process.env.RESEND_API_KEY = "re_fake_key_for_tests";
  process.env.APP_ORIGIN = "https://context.invalid";
  process.env.SITE_URL = "https://context.invalid";
  mailbox = [];
  realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url !== "https://api.resend.com/emails") throw new Error(`network access attempted: ${url}`);
    mailbox.push(JSON.parse(String(init?.body ?? "{}")));
    return new Response("{}", { status: 200 });
  }) as typeof globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const SEND = getFunctionName(internal.functions.storageLag.send);

/** The mails the check or a finish queued, by their arguments. */
async function queued(f: Fixture) {
  const jobs = await f.t.run((ctx) => ctx.db.system.query("_scheduled_functions").collect());
  return jobs.filter((job) => job.name === SEND).map((job) => (job.args[0] as { alert: Record<string, unknown> }).alert);
}

async function row(f: Fixture) {
  const [first] = await f.t.run((ctx) => ctx.db.query("moveQueue").collect());
  return first!;
}

async function age(f: Fixture, id: Id<"moveQueue">, ms: number, patch: Record<string, unknown> = {}) {
  await f.t.run((ctx) => ctx.db.patch(id, { createdAt: Date.now() - ms, ...patch }));
}

const subscribe = (f: Fixture) => f.staff.mutation(api.functions.storageLag.setAlerts, { on: true });

describe("the pace and the time left", () => {
  test("a pass's pace is blended into the pace so far", () => {
    expect(blendRate(undefined, 50, 10_000)).toBe(5);
    expect(blendRate(5, 0, 10_000)).toBeCloseTo(3.5);
    expect(blendRate(5, 10, 0)).toBe(5);
  });

  test("the time left is unknown until a pass has measured a pace", () => {
    expect(etaMs({ total: 100, moved: 40 })).toBeNull();
    expect(etaMs({ total: 100, moved: 40, rate: 2 })).toBe(30_000);
    expect(etaMs({ total: 100, moved: 100 })).toBe(0);
    expect(workspaceEtaMs([{ total: 10, moved: 0, rate: 1 }, { total: 10, moved: 5, rate: 1 }])).toBe(15_000);
    expect(workspaceEtaMs([{ total: 10, moved: 0, rate: 1 }, { total: 10, moved: 5 }])).toBeNull();
  });

  test("late at four hours old, when the pace misses five, or when stuck", () => {
    const now = Date.now();
    const base = { state: "moving" as const, total: 1000, moved: 0, attempts: 0, createdAt: now };
    expect(lateReason(base, now)).toBeNull();
    expect(lateReason({ ...base, createdAt: now - LATE_AFTER_MS }, now)).toBe("old");
    expect(lateReason({ ...base, attempts: STUCK_ATTEMPTS }, now)).toBe("stuck");
    // 1000 files at one every 20 seconds is over 5 hours.
    expect(lateReason({ ...base, rate: 0.05 }, now)).toBe("slow");
    expect(lateReason({ ...base, rate: 1000 / (CATCH_UP_TARGET_MS / 1000) + 0.01 }, now)).toBeNull();
    expect(lateReason({ ...base, state: "preparing", createdAt: 0 }, now)).toBeNull();
  });

  test("the worker records a pace each pass, and admin shows it with the time left", async () => {
    const f = await fixture();
    await start(f, "1-projects/launch", "3-resources/launch");
    const report = await f.staff.query(api.functions.nodeMovesAdmin.report, {});
    expect(report.rows[0]).toMatchObject({ rate: null, etaMs: null, late: null });
    expect(report.lag).toMatchObject({ catchUpMs: null, late: 0, targetMs: CATCH_UP_TARGET_MS });
    expect(report.lag.remaining).toBeGreaterThan(0);

    const { _id: id } = await row(f);
    await f.t.mutation(internal.functions.nodeMoves.progress, { id, moved: 1, now: Date.now(), ms: 500 });
    const after = await f.staff.query(api.functions.nodeMovesAdmin.report, {});
    expect(after.rows[0]!.rate).toBe(2);
    expect(after.rows[0]!.etaMs).toBeGreaterThan(0);
    expect(after.lag.catchUpMs).toBe(after.rows[0]!.etaMs);
    expect(JSON.stringify(after)).not.toContain("launch");
  });

  test("a real pass through the worker measures a pace", async () => {
    const f = await fixture();
    await start(f, "1-projects/launch", "3-resources/launch");
    // One file keeps failing, so the pass ends having moved the rest: a pass that reports progress.
    const store = new Proxy(f.store, {
      get(target, property, receiver) {
        const value = Reflect.get(target, property, receiver);
        if (property !== "put" || typeof value !== "function") return value;
        return async (key: string, ...rest: unknown[]) => {
          if (key === "3-resources/launch/pic.png") throw new Error("InternalError: put failed");
          return await (value as (...a: unknown[]) => Promise<unknown>).apply(target, [key, ...rest]);
        };
      },
    }) as Store;
    await runMoveWork(f.ctx, f.ws, store, null, { wait: async () => {} });
    const after = await row(f);
    expect(after.moved).toBeGreaterThan(0);
    expect(after.rate).toBeGreaterThan(0);
  });
});

describe("a move falling behind", () => {
  test("is marked once and mailed to subscribed staff once, never on every check", async () => {
    const f = await fixture();
    await subscribe(f);
    await start(f, "1-projects/launch", "3-resources/launch");
    const { _id } = await row(f);
    await age(f, _id, LATE_AFTER_MS + HOUR);

    expect(await f.t.mutation(internal.functions.storageLag.check, {})).toEqual({ late: 1, marked: 1 });
    expect(await f.t.mutation(internal.functions.storageLag.check, {})).toEqual({ late: 1, marked: 0 });
    const alerts = await queued(f);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "late", reason: "old", workspaceId: f.ws });

    await f.t.action(internal.functions.storageLag.send, { alert: alerts[0] as never });
    expect(mailbox.map((mail) => mail.to)).toEqual([ADMIN]);
    expect(mailbox[0]!.subject).toBe("Storage is behind: @acme");
    expect(mailbox[0]!.text).not.toContain("launch");
    expect(mailbox[0]!.text).not.toContain("1-projects");
  });

  test("its finish mails that it caught up", async () => {
    const f = await fixture();
    await subscribe(f);
    await start(f, "1-projects/launch", "3-resources/launch");
    const { _id } = await row(f);
    await age(f, _id, LATE_AFTER_MS + HOUR);
    await f.t.mutation(internal.functions.storageLag.check, {});
    await drain(f);
    const alerts = await queued(f);
    expect(alerts.map((alert) => alert.kind).sort()).toEqual(["late", "recovered"]);
    await f.t.action(internal.functions.storageLag.send, { alert: alerts.find((alert) => alert.kind === "recovered") as never });
    expect(mailbox.map((mail) => mail.subject)).toContain("Storage caught up: @acme");
  });

  test("a move on time and finished mails nothing", async () => {
    const f = await fixture();
    await subscribe(f);
    await start(f, "1-projects/launch", "3-resources/launch");
    await f.t.mutation(internal.functions.storageLag.check, {});
    await drain(f);
    expect(await queued(f)).toEqual([]);
  });

  test("nobody subscribed: marked for the console, nothing scheduled", async () => {
    const f = await fixture();
    await start(f, "1-projects/launch", "3-resources/launch");
    const { _id } = await row(f);
    await age(f, _id, 0, { attempts: STUCK_ATTEMPTS, lastError: "A file is too large to move on this storage" });
    expect(await f.t.mutation(internal.functions.storageLag.check, {})).toEqual({ late: 1, marked: 1 });
    expect(await queued(f)).toEqual([]);
    expect((await f.staff.query(api.functions.nodeMovesAdmin.report, {})).rows[0]!.late).toBe("stuck");
  });

  test("somebody taken off staff stops getting them", async () => {
    const f = await fixture();
    await subscribe(f);
    await start(f, "1-projects/launch", "3-resources/launch");
    const { _id } = await row(f);
    await age(f, _id, LATE_AFTER_MS + HOUR);
    await f.t.mutation(internal.functions.storageLag.check, {});
    const [alert] = await queued(f);
    process.env[ADMIN_EMAILS_ENV_VAR] = "someone-else@example.test";
    await f.t.action(internal.functions.storageLag.send, { alert: alert as never });
    expect(mailbox).toEqual([]);
  });

  test("a bad hour is a few mails, not a flood", async () => {
    const f = await fixture();
    await subscribe(f);
    const now = Date.now();
    await f.t.run(async (ctx) => {
      for (let n = 0; n < STORAGE_LAG_ALERTS_PER_HOUR + 5; n += 1) {
        await ctx.db.insert("moveQueue", {
          workspaceId: f.ws,
          from: `a${n}`,
          to: `b${n}`,
          kind: "folder",
          state: "moving",
          scope: "private",
          grantedNames: [],
          total: 1,
          moved: 0,
          added: { folders: [], notes: [] },
          attempts: 0,
          nextAt: now + HOUR,
          createdAt: now - LATE_AFTER_MS - HOUR,
          updatedAt: now,
        });
      }
    });
    await f.t.mutation(internal.functions.storageLag.check, {});
    expect(await queued(f)).toHaveLength(STORAGE_LAG_ALERTS_PER_HOUR);
  });

  test("only staff can see or change the switch", async () => {
    const f = await fixture();
    await expect(f.owner.query(api.functions.storageLag.getAlerts, {})).rejects.toThrow();
    await expect(f.owner.mutation(api.functions.storageLag.setAlerts, { on: true })).rejects.toThrow();
    expect(await f.staff.query(api.functions.storageLag.getAlerts, {})).toEqual({ on: false, email: ADMIN });
    await subscribe(f);
    expect(await f.staff.query(api.functions.storageLag.getAlerts, {})).toEqual({ on: true, email: ADMIN });
    await f.staff.mutation(api.functions.storageLag.setAlerts, { on: false });
    expect(await f.staff.query(api.functions.storageLag.getAlerts, {})).toEqual({ on: false, email: ADMIN });
  });
});

describe("the mail", () => {
  test("says why, how much is left and how long, in words", () => {
    const late = renderStorageLagAlert(
      { kind: "late", workspace: "@acme", reason: "slow", ageMs: 2 * HOUR, remaining: 1200, etaMs: 4 * HOUR + 10 * 60_000, lastError: null },
      "https://context.invalid/admin",
    );
    expect(late.text).toContain("will not finish within 5 hours");
    expect(late.text).toContain("1,200 files left to copy, about 4 hours 10 minutes");
    expect(spanWords(90_000)).toBe("2 minutes");
    expect(spanWords(3 * 24 * HOUR)).toBe("3 days");
    const escaped = renderStorageLagAlert({ kind: "recovered", workspace: "<b>x</b>", tookMs: HOUR }, "https://context.invalid/admin");
    expect(escaped.html).not.toContain("<b>x</b>");
  });
});
