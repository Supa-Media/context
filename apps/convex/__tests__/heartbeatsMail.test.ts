import { describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import {
  MAIL_LOOK_SPACING_MS,
  MAIL_SETTLE_MS,
  MAX_CHECK_IN_TEXTS_A_DAY,
  firstBeatTomorrow,
  mailLookAt,
} from "../functions/lib/heartbeats/mail";
import { asUser, createUser, createWorkspace, seedGoogleConnection, setupTest } from "./fixtures.helpers";

/**
 * NEW MAIL BRINGS TEX'S NEXT CHECK-IN FORWARD, AND CHECK-INS TEXT AT MOST
 * THREE TIMES A DAY.
 *
 * The owner, 2026-10-19, chose "Yes, on new mail": an email that needs them
 * should not wait for the next slot. Through the real Gmail pass record and
 * the real `/agent-texts/heartbeats/*` routes.
 */
/*
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted (2026-10-19).
 *
 *   `recordGoogleForwardSyncPass` not calling `lookSoonForMail`
 *     → "a Gmail pass that wrote mail brings the next look forward" fails
 *   `lookSoonForMail` ignoring today's texts
 *     → "once today's texts are used up, nothing until tomorrow's first slot" fails
 *   `mailLookAt` ignoring the night
 *     → "mail by night waits for 8 am, by day it waits a couple of minutes" fails
 */

vi.setConfig({ testTimeout: 20_000 });

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const PHONE = "+15555550100";
const HOUR = 60 * 60 * 1000;
const ZONE = "America/New_York";

type T = ReturnType<typeof setupTest>;

async function agentPost(t: T, path: string, body: unknown) {
  const response = await t.fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${AGENT_SECRET}` },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: JSON.parse(await response.text()) as Record<string, unknown> };
}

/** A person with a linked phone, a check-in row (armed by their first text) and Gmail connected. */
async function withMail(t: T) {
  const userId = await createUser(t, "ada@example.invalid");
  const workspaceId = await createWorkspace(t, userId, "ada", { kind: "personal" });
  const { code } = await asUser(t, userId).action(api.functions.textLinks.startPhoneLink, { phone: PHONE });
  await agentPost(t, "/agent-texts/link", { phone: PHONE, code });
  expect((await agentPost(t, "/agent-texts/session", { phone: PHONE })).body.status).toBe("linked");
  const connectionId = await seedGoogleConnection(t, { workspaceId, boundBy: userId });
  return { userId, workspaceId, connectionId };
}

async function row(t: T, userId: Id<"users">) {
  return await t.run((ctx) =>
    ctx.db
      .query("texHeartbeats")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first(),
  );
}

async function setNextBeat(t: T, userId: Id<"users">, at: number) {
  const beat = await row(t, userId);
  if (beat === null) throw new Error("no heartbeat row");
  await t.run((ctx) => ctx.db.patch(beat._id, { nextBeatAt: at }));
}

async function gmailPass(t: T, connectionId: Id<"googleConnections">, extra: Record<string, unknown> = {}) {
  await t.mutation(internal.functions.googleSync.recordGoogleForwardSyncPass, {
    connectionId,
    product: "gmail",
    status: "synced",
    historyId: "200",
    daysTouched: 1,
    bytesWritten: 100,
    ...extra,
  });
}

async function textedCheckIn(t: T, userId: Id<"users">) {
  await setNextBeat(t, userId, Date.now() - 1000);
  const { body } = await agentPost(t, "/agent-texts/heartbeats/due", {});
  const [beat] = body.heartbeats as { runId: string }[];
  expect(beat).toBeDefined();
  await agentPost(t, "/agent-texts/heartbeats/result", { runId: beat!.runId, outcome: "texted" });
}

describe("when a look for mail runs", () => {
  test("mail by night waits for 8 am, by day it waits a couple of minutes", () => {
    const noon = Date.UTC(2026, 9, 19, 16, 0); // 12:00 in New York
    expect(mailLookAt(noon, ZONE, undefined)).toBe(noon + MAIL_SETTLE_MS);
    const night = Date.UTC(2026, 9, 19, 7, 47); // 3:47 am in New York
    expect(mailLookAt(night, ZONE, undefined)).toBe(Date.UTC(2026, 9, 19, 12, 0)); // 8:00 am
    const late = Date.UTC(2026, 9, 20, 2, 30); // 10:30 pm
    expect(mailLookAt(late, ZONE, undefined)).toBe(Date.UTC(2026, 9, 20, 12, 0));
  });

  test("a look for mail comes at most once an hour after the last look", () => {
    const noon = Date.UTC(2026, 9, 19, 16, 0);
    expect(mailLookAt(noon, ZONE, noon - 10 * 60_000)).toBe(noon - 10 * 60_000 + MAIL_LOOK_SPACING_MS);
    // Spaced into the night, it waits for the morning instead.
    const evening = Date.UTC(2026, 9, 20, 1, 30); // 9:30 pm
    expect(mailLookAt(evening, ZONE, evening)).toBe(Date.UTC(2026, 9, 20, 12, 0));
  });

  test("the first slot tomorrow is 10 am their time", () => {
    const afternoon = Date.UTC(2026, 9, 19, 18, 5); // 2:05 pm
    expect(firstBeatTomorrow(ZONE, afternoon)).toBe(Date.UTC(2026, 9, 20, 14, 0));
  });
});

describe("a Gmail pass", () => {
  test("a Gmail pass that wrote mail brings the next look forward", async () => {
    const t = setupTest();
    const { userId, connectionId } = await withMail(t);
    await setNextBeat(t, userId, Date.now() + 24 * HOUR);
    const before = Date.now();
    await gmailPass(t, connectionId);
    const after = Date.now();
    const next = (await row(t, userId))!.nextBeatAt!;
    expect(next).toBeGreaterThanOrEqual(mailLookAt(before, ZONE, undefined));
    expect(next).toBeLessThanOrEqual(mailLookAt(after, ZONE, undefined));
  });

  test("a pass that read no mail, or only set its cursor, leaves the look where it was", async () => {
    const t = setupTest();
    const { userId, connectionId } = await withMail(t);
    const later = Date.now() + 24 * HOUR;
    await setNextBeat(t, userId, later);
    await gmailPass(t, connectionId, { daysTouched: 0 });
    await gmailPass(t, connectionId, { baseline: true });
    expect((await row(t, userId))!.nextBeatAt).toBe(later);
  });

  test("never pushes a look later than it already was", async () => {
    const t = setupTest();
    const { userId, connectionId } = await withMail(t);
    const soon = Date.now() + 30_000;
    await setNextBeat(t, userId, soon);
    await gmailPass(t, connectionId);
    expect((await row(t, userId))!.nextBeatAt).toBe(soon);
  });

  test("a workspace without check-ins is left alone", async () => {
    const t = setupTest();
    const userId = await createUser(t, "bo@example.invalid");
    const workspaceId = await createWorkspace(t, userId, "bo", { kind: "personal" });
    const connectionId = await seedGoogleConnection(t, { workspaceId, boundBy: userId });
    await gmailPass(t, connectionId);
    expect(await row(t, userId)).toBeNull();
  });
});

describe("three texts a day", () => {
  test("once today's texts are used up, nothing until tomorrow's first slot", async () => {
    const t = setupTest();
    const { userId, connectionId } = await withMail(t);
    for (let i = 0; i < MAX_CHECK_IN_TEXTS_A_DAY - 1; i += 1) await textedCheckIn(t, userId);
    const third = Date.now();
    await textedCheckIn(t, userId);
    const capped = (await row(t, userId))!;
    expect(capped.textedCount).toBe(MAX_CHECK_IN_TEXTS_A_DAY);
    expect(capped.nextBeatAt).toBe(firstBeatTomorrow(ZONE, third));
    await gmailPass(t, connectionId);
    expect((await row(t, userId))!.nextBeatAt).toBe(capped.nextBeatAt);
  });
});
