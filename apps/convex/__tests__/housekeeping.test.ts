import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { hashToken } from "../functions/lib/crypto";
import { HOUSEKEEPING_CLIENT_ID, nextHousekeepingAfter } from "../functions/lib/housekeeping/model";
import { HEARTBEAT_CLIENT_ID } from "../functions/lib/heartbeats/model";
import { asUser, createUser, createWorkspace, gatewayPost, setupTest } from "./fixtures.helpers";

/**
 * TEX'S HOUSEKEEPING: WHEN IT IS DUE, WHO IT RUNS AS, AND HEARING BACK.
 *
 * Through the real `/agent-texts/session` and `/agent-texts/housekeeping/*`
 * routes. A run falls once a day at 9am in the person's zone; a claim hands
 * out a grant on their personal workspace for the housekeeping client alone.
 */
/*
 * ## Sabotage record
 *
 *   `runHousekeepingNowHandler` patching a leased row (2026-10-26)
 *     → "brings one person's next run forward…" fails
 *
 * Run as temporary local edits and reverted (2026-10-17).
 *
 *   `nextHousekeepingAfter` answering `afterMs + 1h`
 *     → "a run falls at 9am in their zone, once a day" fails
 *   `claimDueHousekeepingHandler` minting the grant for HEARTBEAT_CLIENT_ID
 *     → "carries a housekeeping grant on their personal workspace, audited" fails
 *   `claimDueHousekeepingHandler` not asking `texJobWorkspace`
 *     → "an unlinked phone gets no housekeeping" fails
 *   HOUSEKEEPING_CLIENT_ID left out of `builtinModel.ts`'s BUILTIN_CLIENTS
 *     (as it shipped on 2026-10-17, refusing every run as `not_texts`)
 *     → "a run's grant may spend the built-in model on a founding plan" fails
 *   `armLinkedHousekeepingHandler` skipping every existing row
 *     → "the daily sweep starts again a row that stopped" fails
 */

vi.setConfig({ testTimeout: 20_000 });

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const PHONE = "+15555550100";
const HOUR = 60 * 60 * 1000;

type T = ReturnType<typeof setupTest>;
type Run = { runId: string; accessToken: string; timeZone: string };

afterEach(() => {
  vi.useRealTimers();
});

async function agentPost(t: T, path: string, body: unknown) {
  const response = await t.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_SECRET}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: JSON.parse(await response.text()) as Record<string, unknown> };
}

async function linked(t: T, slug = "ada", phone = PHONE) {
  const userId = await createUser(t, `${slug}@example.invalid`);
  const workspaceId = await createWorkspace(t, userId, slug, { kind: "personal" });
  const { code } = await asUser(t, userId).action(api.functions.textLinks.startPhoneLink, { phone });
  await agentPost(t, "/agent-texts/link", { phone, code });
  return { userId, workspaceId };
}

async function text(t: T, phone = PHONE) {
  const opened = await agentPost(t, "/agent-texts/session", { phone });
  expect(opened.body.status).toBe("linked");
  return opened.body.accessToken as string;
}

async function row(t: T, userId: Id<"users">) {
  return await t.run((ctx) =>
    ctx.db
      .query("texHousekeeping")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first(),
  );
}

async function makeDue(t: T, userId: Id<"users">) {
  const run = await row(t, userId);
  if (run === null) throw new Error("no housekeeping row");
  await t.run((ctx) => ctx.db.patch(run._id, { nextRunAt: Date.now() - 1000 }));
}

async function due(t: T): Promise<Run[]> {
  const { status, body } = await agentPost(t, "/agent-texts/housekeeping/due", {});
  if (status !== 200) throw new Error(`due answered ${status}`);
  return body.runs as Run[];
}

async function result(t: T, runId: string, outcome: string) {
  return await agentPost(t, "/agent-texts/housekeeping/result", { runId, outcome });
}

async function session(t: T, accessToken: string) {
  const response = await gatewayPost(t, "/gateway/session", { accessToken });
  return ((await response.json()) as { session: Record<string, unknown> | null }).session;
}

function newYorkHour(ms: number): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(ms));
}

describe("when", () => {
  test("a run falls at 9am in their zone, once a day", () => {
    let at = Date.UTC(2026, 9, 17, 3, 51);
    const gaps: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const next = nextHousekeepingAfter("America/New_York", at)!;
      expect(newYorkHour(next)).toBe(9);
      gaps.push(next - at);
      at = next;
    }
    expect(gaps[0]!).toBeLessThan(24 * HOUR);
    expect(gaps.slice(1)).toEqual([24 * HOUR, 24 * HOUR]);
  });

  test("a text arms the next run, and texting again never brings it forward", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await linked(t);
    await text(t);
    const armed = await row(t, userId);
    expect(armed).toMatchObject({ userId, workspaceId });
    expect(newYorkHour(armed!.nextRunAt!)).toBe(9);
    await text(t);
    expect((await row(t, userId))!.nextRunAt).toBe(armed!.nextRunAt);
    expect(await due(t)).toEqual([]);
  });
});

describe("handing out a run", () => {
  test("carries a housekeeping grant on their personal workspace, audited", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await linked(t);
    const texting = await text(t);
    await makeDue(t, userId);
    const runs = await due(t);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ timeZone: "America/New_York" });
    expect(runs[0]!.accessToken).toMatch(/^cat_/);

    const grants = await t.run(async (ctx) => await ctx.db.query("oauthGrants").collect());
    const grant = grants.find((g) => g.clientId === HOUSEKEEPING_CLIENT_ID);
    expect(grant).toMatchObject({ clientId: HOUSEKEEPING_CLIENT_ID, workspaceId, userId, status: "active" });
    expect(grant!.hashedAccessToken).toBe(await hashToken(runs[0]!.accessToken));
    expect(grants.some((g) => g.clientId === HEARTBEAT_CLIENT_ID)).toBe(false);
    expect(await session(t, runs[0]!.accessToken)).not.toBeNull();
    expect(await session(t, texting)).not.toBeNull();

    const audit = await t.run((ctx) =>
      ctx.db.query("auditEvents").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect(),
    );
    expect(audit.some((event) => event.action === "housekeeping.run" && event.actorClientId === HOUSEKEEPING_CLIENT_ID)).toBe(true);
  });

  test("a claimed run is handed out once, and tomorrow's is already set", async () => {
    const t = setupTest();
    const { userId } = await linked(t);
    await text(t);
    await makeDue(t, userId);
    expect(await due(t)).toHaveLength(1);
    expect(await due(t)).toEqual([]);
    const next = (await row(t, userId))!.nextRunAt!;
    expect(next).toBeGreaterThan(Date.now());
    expect(newYorkHour(next)).toBe(9);
  });

  test("an unlinked phone gets no housekeeping, and its row is disarmed", async () => {
    const t = setupTest();
    const { userId } = await linked(t);
    await text(t);
    await makeDue(t, userId);
    await t.run(async (ctx) => {
      for (const link of await ctx.db.query("phoneLinks").collect()) await ctx.db.delete(link._id);
    });
    expect(await due(t)).toEqual([]);
    expect((await row(t, userId))!.nextRunAt).toBeNull();
  });
});

describe("the model", () => {
  test("a run's grant may spend the built-in model on a founding plan", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await linked(t);
    await text(t);
    await makeDue(t, userId);
    const [run] = await due(t);
    const now = Date.now();
    await t.run((ctx) =>
      ctx.db.insert("workspacePlans", {
        workspaceId,
        managedStorage: false,
        fastSearch: true,
        status: "active",
        founding: true,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const started = await t.mutation(internal.functions.builtinModel.startBuiltinTurn, {
      hashedAccessToken: await hashToken(run!.accessToken),
      expectedWorkspaceId: workspaceId,
    });
    expect(started).toMatchObject({ allowed: true });
  });
});

describe("hearing back", () => {
  test("a finished run ends its grant and goes on tomorrow", async () => {
    const t = setupTest();
    const { userId } = await linked(t);
    await text(t);
    await makeDue(t, userId);
    const [run] = await due(t);
    const claimedAt = (await row(t, userId))!.claimedAt!;
    expect((await result(t, run!.runId, "tidied")).body).toEqual({ status: "recorded" });
    const after = await row(t, userId);
    expect(after).toMatchObject({ lastOutcome: "tidied", lastRunAt: claimedAt });
    expect(after!.claimedAt).toBeUndefined();
    expect(after!.nextRunAt!).toBeGreaterThan(Date.now());
    expect(await session(t, run!.accessToken)).toBeNull();
  });

  test("no model goes on tomorrow, like any other run", async () => {
    const t = setupTest();
    const { userId } = await linked(t);
    await text(t);
    await makeDue(t, userId);
    const [run] = await due(t);
    await result(t, run!.runId, "no_provider");
    const next = (await row(t, userId))!.nextRunAt!;
    expect(next).toBeGreaterThan(Date.now());
    expect(newYorkHour(next)).toBe(9);
  });

  test("the daily sweep starts again a row that stopped", async () => {
    const t = setupTest();
    const { userId } = await linked(t);
    await text(t);
    const stopped = await row(t, userId);
    await t.run((ctx) => ctx.db.patch(stopped!._id, { nextRunAt: null, lastOutcome: "no_provider" }));
    expect(await t.mutation(internal.functions.housekeeping.armLinkedHousekeeping, {})).toBe(1);
    expect(newYorkHour((await row(t, userId))!.nextRunAt!)).toBe(9);
    expect(await t.mutation(internal.functions.housekeeping.armLinkedHousekeeping, {})).toBe(0);
  });

  test("a sentence for an outcome, or an unknown run, is refused or ignored", async () => {
    const t = setupTest();
    const { userId } = await linked(t);
    await text(t);
    await makeDue(t, userId);
    const [run] = await due(t);
    expect((await result(t, run!.runId, "Archived the kitchen remodel")).status).toBe(400);
    expect((await result(t, "house_nope", "tidied")).body).toEqual({ status: "unknown" });
  });
});

describe("a run now, by hand", () => {
  test("brings one person's next run forward by their workspace's handle, and leaves a run already out alone", async () => {
    const t = setupTest();
    const { userId } = await linked(t, "ada");
    await text(t);
    expect(await t.mutation(internal.functions.housekeeping.runHousekeepingNow, { name: "@ada" })).toBe("due");
    const [run] = await due(t);
    expect(run).toBeDefined();
    expect(await t.mutation(internal.functions.housekeeping.runHousekeepingNow, { name: "ada" })).toBe("running");
    expect((await t.query(internal.functions.housekeeping.housekeepingNowStatus, { name: "ada" })).status).toBe("running");
    await result(t, run!.runId, "tidied");
    expect((await row(t, userId))!.nextRunAt!).toBeGreaterThan(Date.now());
    const after = await t.query(internal.functions.housekeeping.housekeepingNowStatus, { name: "ada" });
    expect(after.status).toBe("tidied");
    expect(after.lastRunAt).not.toBeNull();
    expect((await t.query(internal.functions.housekeeping.housekeepingNowStatus, { name: "nobody-here" })).status).toBe("unknown_name");
    expect(await t.mutation(internal.functions.housekeeping.runHousekeepingNow, { name: "nobody-here" })).toBe("unknown_name");
  });
});

describe("everyone with a phone", () => {
  test("the daily sweep gives a first run only to people who never had one", async () => {
    const t = setupTest();
    const { userId } = await linked(t);
    expect(await row(t, userId)).toBeNull();
    expect(await t.mutation(internal.functions.housekeeping.armLinkedHousekeeping, {})).toBe(1);
    expect((await row(t, userId))!.nextRunAt!).toBeGreaterThan(Date.now());
    expect(await t.mutation(internal.functions.housekeeping.armLinkedHousekeeping, {})).toBe(0);
  });

  test("account deletion takes the row with it", async () => {
    const t = setupTest();
    const { userId } = await linked(t);
    await text(t);
    const { deleteTextLinksOf } = await import("../functions/textLinks");
    await t.run((ctx) => deleteTextLinksOf(ctx, userId));
    expect(await row(t, userId)).toBeNull();
  });
});
