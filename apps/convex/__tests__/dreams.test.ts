import { afterEach, describe, expect, test, vi } from "vitest";
import { api, internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { hashToken } from "../functions/lib/crypto";
import { DREAMS_CLIENT_ID, nextDreamAfter } from "../functions/lib/dreams/model";
import { asUser, createUser, createWorkspace, gatewayPost, setupTest } from "./fixtures.helpers";

/**
 * TEX'S NIGHTLY DREAM: WHEN IT IS DUE, WHO IT RUNS AS, AND HEARING BACK.
 *
 * Through the real `/agent-texts/session` and `/agent-texts/dreams/*` routes.
 * A text arms the next 3 am in the person's zone; a claim hands out a grant on
 * their personal workspace for the dreams client alone; what comes back is a
 * code from a closed list, never text.
 */
/*
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   `claimDueDreamsHandler` not clearing `nextDreamAt` on claim
 *     → "a claimed dream is handed out once" fails
 *   `dreamingWorkspace` not asking for the phone link
 *     → "an unlinked phone is not dreamed about" fails
 *   `applyDreamGrant` reusing any active grant instead of the dreams client's
 *     → "the dream's grant leaves the texting grant alone" fails
 *   `armLinkedDreamsHandler` arming rows that already exist
 *     → "the daily sweep gives a first dream only to people who never had one" and
 *       "a dream refused for want of a model waits…" fail
 */

vi.setConfig({ testTimeout: 20_000 });

const AGENT_SECRET = "test-agent-worker-secret-not-a-real-one";
const PHONE = "+15555550100";

type T = ReturnType<typeof setupTest>;
type Dream = { runId: string; accessToken: string; timeZone: string; since: number | null };

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

async function linked(t: T, slug = "ada") {
  const userId = await createUser(t, `${slug}@example.invalid`);
  const workspaceId = await createWorkspace(t, userId, slug, { kind: "personal" });
  const { code } = await asUser(t, userId).action(api.functions.textLinks.startPhoneLink, { phone: PHONE });
  await agentPost(t, "/agent-texts/link", { phone: PHONE, code });
  return { userId, workspaceId };
}

async function text(t: T) {
  const opened = await agentPost(t, "/agent-texts/session", { phone: PHONE });
  expect(opened.body.status).toBe("linked");
  return opened.body.accessToken as string;
}

async function row(t: T, userId: Id<"users">) {
  return await t.run((ctx) =>
    ctx.db
      .query("texDreams")
      .withIndex("by_user", (q) => q.eq("userId", userId))
      .first(),
  );
}

/** Make the person's dream due now, as the clock reaching 3 am would. */
async function makeDue(t: T, userId: Id<"users">) {
  const dream = await row(t, userId);
  if (dream === null) throw new Error("no dream row");
  await t.run((ctx) => ctx.db.patch(dream._id, { nextDreamAt: Date.now() - 1000 }));
}

async function due(t: T): Promise<Dream[]> {
  const { status, body } = await agentPost(t, "/agent-texts/dreams/due", {});
  if (status !== 200) throw new Error(`due answered ${status}`);
  return body.dreams as Dream[];
}

async function result(t: T, runId: string, outcome: string) {
  return await agentPost(t, "/agent-texts/dreams/result", { runId, outcome });
}

async function session(t: T, accessToken: string) {
  const response = await gatewayPost(t, "/gateway/session", { accessToken });
  return ((await response.json()) as { session: Record<string, unknown> | null }).session;
}

describe("arming", () => {
  test("a text arms the next 3 am in their zone, and a second text keeps it", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await linked(t);
    const before = Date.now();
    await text(t);
    const armed = await row(t, userId);
    expect(armed).toMatchObject({ userId, workspaceId });
    expect(armed!.nextDreamAt).toBe(nextDreamAfter("America/New_York", armed!.lastTextedAt!));
    expect(armed!.nextDreamAt!).toBeGreaterThan(before);
    await text(t);
    expect((await row(t, userId))!.nextDreamAt).toBe(armed!.nextDreamAt);
  });

  test("nothing is due before its time", async () => {
    const t = setupTest();
    await linked(t);
    await text(t);
    expect(await due(t)).toEqual([]);
  });
});

describe("handing out a dream", () => {
  test("carries a dreams grant on their personal workspace, audited, with no first `since`", async () => {
    const t = setupTest();
    const { userId, workspaceId } = await linked(t);
    await text(t);
    await makeDue(t, userId);
    const dreams = await due(t);
    expect(dreams).toHaveLength(1);
    expect(dreams[0]).toMatchObject({ timeZone: "America/New_York", since: null });
    expect(dreams[0]!.accessToken).toMatch(/^cat_/);

    const grant = await t.run(async (ctx) =>
      (await ctx.db.query("oauthGrants").collect()).find((g) => g.clientId === DREAMS_CLIENT_ID),
    );
    expect(grant).toMatchObject({ workspaceId, userId, status: "active" });
    expect(grant!.hashedAccessToken).toBe(await hashToken(dreams[0]!.accessToken));
    expect(await session(t, dreams[0]!.accessToken)).not.toBeNull();

    const audit = await t.run((ctx) =>
      ctx.db.query("auditEvents").withIndex("by_workspace", (q) => q.eq("workspaceId", workspaceId)).collect(),
    );
    expect(audit.some((event) => event.action === "dream.run" && event.actorClientId === DREAMS_CLIENT_ID)).toBe(true);
  });

  test("a claimed dream is handed out once", async () => {
    const t = setupTest();
    const { userId } = await linked(t);
    await text(t);
    await makeDue(t, userId);
    expect(await due(t)).toHaveLength(1);
    expect(await due(t)).toEqual([]);
  });

  test("the dream's grant leaves the texting grant alone", async () => {
    const t = setupTest();
    const { userId } = await linked(t);
    const texting = await text(t);
    await makeDue(t, userId);
    await due(t);
    expect(await session(t, texting)).not.toBeNull();
  });

  test("an unlinked phone is not dreamed about, and its row is disarmed", async () => {
    const t = setupTest();
    const { userId } = await linked(t);
    await text(t);
    await makeDue(t, userId);
    await t.run(async (ctx) => {
      for (const link of await ctx.db.query("phoneLinks").collect()) await ctx.db.delete(link._id);
    });
    expect(await due(t)).toEqual([]);
    expect((await row(t, userId))!.nextDreamAt).toBeNull();
  });
});

describe("hearing back", () => {
  test("a finished dream ends its grant, and the next one waits for a text and reads from when it began", async () => {
    const t = setupTest();
    const { userId } = await linked(t);
    await text(t);
    await makeDue(t, userId);
    const [dream] = await due(t);
    const claimedAt = (await row(t, userId))!.claimedAt!;
    expect((await result(t, dream!.runId, "dreamed")).body).toEqual({ status: "recorded" });

    const after = await row(t, userId);
    expect(after).toMatchObject({ lastOutcome: "dreamed", lastDreamedAt: claimedAt, nextDreamAt: null });
    expect(after!.claimedAt).toBeUndefined();
    expect(await session(t, dream!.accessToken)).toBeNull();

    await text(t);
    await makeDue(t, userId);
    const [next] = await due(t);
    expect(next!.since).toBe(claimedAt);
  });

  test("a dream that failed is tried again the next night", async () => {
    const t = setupTest();
    const { userId } = await linked(t);
    await text(t);
    await makeDue(t, userId);
    const [dream] = await due(t);
    await result(t, dream!.runId, "failed");
    const after = await row(t, userId);
    expect(after!.lastDreamedAt).toBeUndefined();
    expect(after!.nextDreamAt!).toBeGreaterThan(Date.now());
  });

  test("a dream refused for want of a model waits for the next text, not the next night", async () => {
    const t = setupTest();
    const { userId } = await linked(t);
    await text(t);
    await makeDue(t, userId);
    const [dream] = await due(t);
    await result(t, dream!.runId, "no_provider");
    expect((await row(t, userId))!.nextDreamAt).toBeNull();
    expect(await t.mutation(internal.functions.dreams.armLinkedDreams, {})).toBe(0);
    await text(t);
    expect((await row(t, userId))!.nextDreamAt!).toBeGreaterThan(Date.now());
  });

  test("a sentence for an outcome, or an unknown run, is refused or ignored", async () => {
    const t = setupTest();
    const { userId } = await linked(t);
    await text(t);
    await makeDue(t, userId);
    const [dream] = await due(t);
    expect((await result(t, dream!.runId, "I learned they like tea")).status).toBe(400);
    expect((await result(t, "dream_nope", "dreamed")).body).toEqual({ status: "unknown" });
  });
});

describe("everyone with a phone", () => {
  test("the daily sweep gives a first dream only to people who never had one", async () => {
    const t = setupTest();
    const { userId } = await linked(t);
    expect(await row(t, userId)).toBeNull();
    expect(await t.mutation(internal.functions.dreams.armLinkedDreams, {})).toBe(1);
    expect((await row(t, userId))!.nextDreamAt!).toBeGreaterThan(Date.now());

    await makeDue(t, userId);
    const [dream] = await due(t);
    await result(t, dream!.runId, "dreamed");
    expect(await t.mutation(internal.functions.dreams.armLinkedDreams, {})).toBe(0);
    expect((await row(t, userId))!.nextDreamAt).toBeNull();
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
