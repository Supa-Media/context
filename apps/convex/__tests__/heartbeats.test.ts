import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { hashToken } from "../functions/lib/crypto";
import { HEARTBEAT_CLIENT_ID, QUIET_WAIT_MS, nextBeatAfter } from "../functions/lib/heartbeats/model";
import { RETRY_AFTER_MS } from "../functions/lib/attention/model";
import { MAX_LOOK_RETRIES } from "../functions/lib/heartbeats/runs";
import { asUser, createUser, createWorkspace, gatewayPost, setupTest } from "./fixtures.helpers";

/**
 * TEX'S CHECK-IN: WHEN IT IS DUE, WHO IT RUNS AS, WHOM IT MAY TEXT, AND HEARING BACK.
 *
 * Through the real `/agent-texts/session` and `/agent-texts/heartbeats/*`
 * routes. Check-ins fall on three daytime slots in the person's zone; a claim
 * hands out a grant on their personal workspace for the check-in client alone
 * and their own phones; one that texted goes on to the next slot, so a
 * person hears from check-ins at most three times a day.
 */
/*
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted (2026-10-17).
 *
 *   `nextBeatAfter` ignoring the slots and answering `afterMs + 1h`
 *     → "a check-in falls on a daytime slot in their zone" fails
 *   `recordHeartbeatResultHandler` pushing a texted check-in past the next slot
 *     (the old 12-hour wait, re-applied 2026-10-19)
 *     → "a check-in that texted goes on at the next slot" fails
 *   `claimDueHeartbeatsHandler` handing out every phone link instead of the person's own
 *     → "a check-in texts only the person's own phone" fails
 *   `texJobWorkspace` not asking for the phone link
 *     → "an unlinked phone gets no check-in" fails
 */

vi.setConfig({ testTimeout: 20_000 });

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const PHONE = "+15555550100";
const OTHER_PHONE = "+15555550199";
const HOUR = 60 * 60 * 1000;

type T = ReturnType<typeof setupTest>;
type Beat = { runId: string; accessToken: string; timeZone: string; since: number | null; phones: string[] };

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
      .query("texHeartbeats")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first(),
  );
}

/** Make the person's check-in due now, as the clock reaching a slot would. */
async function makeDue(t: T, userId: Id<"users">) {
  const beat = await row(t, userId);
  if (beat === null) throw new Error("no heartbeat row");
  await t.run((ctx) => ctx.db.patch(beat._id, { nextBeatAt: Date.now() - 1000 }));
}

async function due(t: T): Promise<Beat[]> {
  const { status, body } = await agentPost(t, "/agent-texts/heartbeats/due", {});
  if (status !== 200) throw new Error(`due answered ${status}`);
  return body.heartbeats as Beat[];
}

async function result(t: T, runId: string, outcome: string) {
  return await agentPost(t, "/agent-texts/heartbeats/result", { runId, outcome });
}

async function session(t: T, accessToken: string) {
  const response = await gatewayPost(t, "/gateway/session", { accessToken });
  return ((await response.json()) as { session: Record<string, unknown> | null }).session;
}

/** The wall-clock hour of `ms` in New York, where the fixtures' accounts live. */
function newYorkHour(ms: number): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hourCycle: "h23" }).format(ms));
}

describe("when", () => {
  test("a check-in falls on a daytime slot in their zone", () => {
    const start = Date.UTC(2026, 9, 17, 3, 51);
    let at = start;
    const hours: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      at = nextBeatAfter("America/New_York", at)!;
      hours.push(newYorkHour(at));
    }
    expect(hours).toEqual([10, 14, 18, 10, 14, 18]);
    expect(nextBeatAfter("America/New_York", start)! - start).toBeLessThan(24 * HOUR);
  });

  test("a text arms the next slot, and texting again never brings it forward", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await linked(t);
    await text(t);
    const armed = await row(t, userId);
    expect(armed).toMatchObject({ userId, workspaceId });
    expect(armed!.nextBeatAt!).toBeGreaterThan(Date.now());
    expect([10, 14, 18]).toContain(newYorkHour(armed!.nextBeatAt!));
    await text(t);
    expect((await row(t, userId))!.nextBeatAt).toBe(armed!.nextBeatAt);
    expect(await due(t)).toEqual([]);
  });
});

describe("handing out a check-in", () => {
  test("carries a check-in grant on their personal workspace, audited, with their own phone", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await linked(t);
    await text(t);
    await makeDue(t, userId);
    const beats = await due(t);
    expect(beats).toHaveLength(1);
    expect(beats[0]).toMatchObject({ timeZone: "America/New_York", since: null, phones: [PHONE] });
    expect(beats[0]!.accessToken).toMatch(/^cat_/);

    const grant = await t.run(async (ctx) =>
      (await ctx.db.query("oauthGrants").collect()).find((g) => g.clientId === HEARTBEAT_CLIENT_ID),
    );
    expect(grant).toMatchObject({ workspaceId, userId, status: "active" });
    expect(grant!.hashedAccessToken).toBe(await hashToken(beats[0]!.accessToken));
    expect(await session(t, beats[0]!.accessToken)).not.toBeNull();

    const audit = await t.run((ctx) =>
      ctx.db.query("auditEvents").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect(),
    );
    expect(audit.some((event) => event.action === "heartbeat.run" && event.actorClientId === HEARTBEAT_CLIENT_ID)).toBe(true);
  });

  test("a check-in texts only the person's own phone", async () => {
    const t = setupTest();
    const ada = await linked(t, "ada", PHONE);
    await linked(t, "bea", OTHER_PHONE);
    await text(t, PHONE);
    await text(t, OTHER_PHONE);
    await makeDue(t, ada.userId);
    const beats = await due(t);
    expect(beats).toHaveLength(1);
    expect(beats[0]!.phones).toEqual([PHONE]);
  });

  test("a claimed check-in is handed out once, and the next slot is already set", async () => {
    const t = setupTest();
    const { userId } = await linked(t);
    await text(t);
    await makeDue(t, userId);
    expect(await due(t)).toHaveLength(1);
    expect(await due(t)).toEqual([]);
    expect((await row(t, userId))!.nextBeatAt!).toBeGreaterThan(Date.now());
  });

  test("the check-in's grant leaves the texting grant alone", async () => {
    const t = setupTest();
    const { userId } = await linked(t);
    const texting = await text(t);
    await makeDue(t, userId);
    await due(t);
    expect(await session(t, texting)).not.toBeNull();
  });

  test("an unlinked phone gets no check-in, and its row is disarmed", async () => {
    const t = setupTest();
    const { userId } = await linked(t);
    await text(t);
    await makeDue(t, userId);
    await t.run(async (ctx) => {
      for (const link of await ctx.db.query("phoneLinks").collect()) await ctx.db.delete(link._id);
    });
    expect(await due(t)).toEqual([]);
    expect((await row(t, userId))!.nextBeatAt).toBeNull();
  });
});

describe("hearing back", () => {
  test("a quiet check-in ends its grant, and the next looks only at what came after it began", async () => {
    const t = setupTest();
    const { userId } = await linked(t);
    await text(t);
    await makeDue(t, userId);
    const [beat] = await due(t);
    const claimedAt = (await row(t, userId))!.claimedAt!;
    expect((await result(t, beat!.runId, "quiet")).body).toEqual({ status: "recorded" });

    const after = await row(t, userId);
    expect(after).toMatchObject({ lastOutcome: "quiet", lastBeatAt: claimedAt });
    expect(after!.claimedAt).toBeUndefined();
    expect(after!.lastTextedAt).toBeUndefined();
    expect(after!.nextBeatAt! - Date.now()).toBeLessThan(24 * HOUR);
    expect(await session(t, beat!.accessToken)).toBeNull();

    await makeDue(t, userId);
    const [next] = await due(t);
    expect(next!.since).toBe(claimedAt);
  });

  test("a check-in that texted goes on at the next slot", async () => {
    const t = setupTest();
    const { userId } = await linked(t);
    await text(t);
    await makeDue(t, userId);
    const [beat] = await due(t);
    const claimed = await row(t, userId);
    await result(t, beat!.runId, "texted");
    const after = await row(t, userId);
    expect(after!.lastTextedAt).toBeGreaterThan(0);
    expect(after!.nextBeatAt!).toBe(claimed!.nextBeatAt!);
    expect(after!.nextBeatAt!).toBe(nextBeatAfter("America/New_York", claimed!.claimedAt!));
  });

  test("a check-in that failed is tried again soon, a few times, and reads the same changes again", async () => {
    const t = setupTest();
    const { userId } = await linked(t);
    await text(t);
    for (let attempt = 1; attempt <= MAX_LOOK_RETRIES; attempt += 1) {
      await makeDue(t, userId);
      const [beat] = await due(t);
      const claimed = await row(t, userId);
      const before = Date.now();
      await result(t, beat!.runId, "failed");
      const after = await row(t, userId);
      expect(after!.lastBeatAt).toBeUndefined();
      expect(after!.failedLooks).toBe(attempt);
      expect(after!.nextBeatAt!).toBeGreaterThan(before);
      expect(after!.nextBeatAt!).toBeLessThanOrEqual(Math.min(Date.now() + RETRY_AFTER_MS, claimed!.nextBeatAt!));
    }
    // Failing once more waits for the slot.
    await makeDue(t, userId);
    const [again] = await due(t);
    const reclaimed = await row(t, userId);
    await result(t, again!.runId, "failed");
    expect((await row(t, userId))!.nextBeatAt).toBe(reclaimed!.nextBeatAt);
  });

  test("failures that run on into the next slot are tried again there too", async () => {
    // 2026-10-28: a look that failed after a failed one never retried, so a slow tree silenced every slot.
    const t = setupTest();
    const { userId } = await linked(t);
    await text(t);
    const failing = await row(t, userId);
    // Out of retries for an earlier slot.
    await t.run((ctx) =>
      ctx.db.patch(failing!._id, { lastOutcome: "failed", failedLooks: MAX_LOOK_RETRIES + 1, failedFor: Date.now() - 4 * 3_600_000 }),
    );
    await makeDue(t, userId);
    const [beat] = await due(t);
    const claimed = await row(t, userId);
    const before = Date.now();
    await result(t, beat!.runId, "failed");
    const after = await row(t, userId);
    expect(after!.failedLooks).toBe(1);
    expect(after!.failedFor).toBe(claimed!.nextBeatAt);
    expect(after!.nextBeatAt!).toBeGreaterThan(before);
    expect(after!.nextBeatAt!).toBeLessThanOrEqual(Math.min(Date.now() + RETRY_AFTER_MS, claimed!.nextBeatAt!));
    // A look that goes through clears the count.
    await makeDue(t, userId);
    const [next] = await due(t);
    await result(t, next!.runId, "quiet");
    const cleared = await row(t, userId);
    expect(cleared!.failedLooks).toBeUndefined();
    expect(cleared!.failedFor).toBeUndefined();
  });

  test("a check-in that found them mid-conversation looks again once the chat has been quiet, every time", async () => {
    const t = setupTest();
    const { userId } = await linked(t);
    await text(t);
    for (let round = 0; round < 2; round += 1) {
      await makeDue(t, userId);
      const [beat] = await due(t);
      const claimed = await row(t, userId);
      const before = Date.now();
      await result(t, beat!.runId, "busy");
      const after = await row(t, userId);
      // Nothing was looked at, so the next look reads the same changes.
      expect(after!.lastBeatAt).toBeUndefined();
      expect(after!.nextBeatAt!).toBeGreaterThanOrEqual(Math.min(before + QUIET_WAIT_MS, claimed!.nextBeatAt!));
      expect(after!.nextBeatAt!).toBeLessThanOrEqual(Math.min(Date.now() + QUIET_WAIT_MS, claimed!.nextBeatAt!));
    }
  });

  test("no model, or no chat to text into, waits for the next text", async () => {
    const t = setupTest();
    const { userId } = await linked(t);
    await text(t);
    for (const outcome of ["no_provider", "no_chat"]) {
      await makeDue(t, userId);
      const [beat] = await due(t);
      await result(t, beat!.runId, outcome);
      expect((await row(t, userId))!.nextBeatAt).toBeNull();
      expect(await t.mutation(internal.functions.heartbeats.armLinkedHeartbeats, {})).toBe(0);
      await text(t);
      expect((await row(t, userId))!.nextBeatAt!).toBeGreaterThan(Date.now());
    }
  });

  test("a sentence for an outcome, or an unknown run, is refused or ignored", async () => {
    const t = setupTest();
    const { userId } = await linked(t);
    await text(t);
    await makeDue(t, userId);
    const [beat] = await due(t);
    expect((await result(t, beat!.runId, "They have a dentist appointment")).status).toBe(400);
    expect((await result(t, "beat_nope", "quiet")).body).toEqual({ status: "unknown" });
  });
});

describe("everyone with a phone", () => {
  test("the daily sweep gives a first check-in only to people who never had one", async () => {
    const t = setupTest();
    const { userId } = await linked(t);
    expect(await row(t, userId)).toBeNull();
    expect(await t.mutation(internal.functions.heartbeats.armLinkedHeartbeats, {})).toBe(1);
    expect((await row(t, userId))!.nextBeatAt!).toBeGreaterThan(Date.now());
    expect(await t.mutation(internal.functions.heartbeats.armLinkedHeartbeats, {})).toBe(0);
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
