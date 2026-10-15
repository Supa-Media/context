import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Id } from "../../_generated/dataModel";
import {
  createUser,
  createWorkspace,
  seedGoogleConnection,
  setupTest,
  type TestConvex,
} from "../fixtures.helpers";
import { sha256Hex } from "../../functions/lib/googlePush/ensure";
import { PUSH_MIN_GAP_MS } from "../../functions/lib/googlePush/pending";
import {
  chatDelivery,
  enablePush,
  fakeGoogleSigner,
  gmailDelivery,
  pushClaims,
  type FakeGoogleSigner,
} from "./fixtures.helpers";

/**
 * The two doors Google pushes through. What each must refuse, and that what
 * gets through can do one thing only: mark a connection's product pending.
 * Attacker and victim live in ONE database throughout, so a refusal is the
 * route's and never an absent row's.
 */

const HOUR = 60 * 60 * 1000;
const CHANNEL_TOKEN = "example-channel-token-not-real-0123456789abcdef";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

async function world(t: TestConvex) {
  const owner = await createUser(t, "owner@example.invalid");
  const workspaceId = await createWorkspace(t, owner, "atlas");
  const victim = await seedGoogleConnection(t, { workspaceId, boundBy: owner, address: "Person@Example.invalid" });
  const otherOwner = await createUser(t, "other@example.invalid");
  const otherWorkspace = await createWorkspace(t, otherOwner, "borealis");
  const other = await seedGoogleConnection(t, {
    workspaceId: otherWorkspace,
    boundBy: otherOwner,
    address: "other@example.invalid",
  });
  const tokenHash = await sha256Hex(CHANNEL_TOKEN);
  const lastSyncAt = Date.now() - 2 * 60_000;
  await t.run(async (ctx) => {
    const row = (await ctx.db.get(victim))!;
    await ctx.db.patch(victim, {
      products: ["gmail", "calendar", "chat"],
      calendar: { scopes: [], lastSyncedAt: lastSyncAt },
      chat: { scopes: [], nonceSeed: "fixture-nonce", lastSyncedAt: lastSyncAt },
      gmail: { ...row.gmail!, lastSyncedAt: lastSyncAt },
      lastSyncAt,
      nextSyncAt: Date.now() + HOUR,
      push: {
        gmail: { address: "person@example.invalid", expiresAt: Date.now() + 5 * 24 * HOUR },
        calendar: { channelId: "channel-victim", resourceId: "resource-victim", tokenHash, expiresAt: Date.now() + 5 * 24 * HOUR },
        chat: { subscriptionName: "subscriptions/victim-sub", expiresAt: Date.now() + 5 * 24 * HOUR },
      },
    });
    await ctx.db.patch(other, {
      lastSyncAt,
      nextSyncAt: Date.now() + HOUR,
      push: { gmail: { address: "other@example.invalid", expiresAt: Date.now() + 5 * 24 * HOUR } },
    });
  });
  return { victim, other };
}

async function row(t: TestConvex, id: Id<"googleConnections">) {
  return (await t.run((ctx) => ctx.db.get(id)))!;
}

function pubsub(t: TestConvex, body: string, token?: string) {
  return t.fetch("/google/push/pubsub", {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body,
  });
}

function calendar(t: TestConvex, headers: Record<string, string>) {
  return t.fetch("/google/push/calendar", { method: "POST", headers });
}

describe("the Pub/Sub door (Gmail and Chat)", () => {
  let google: FakeGoogleSigner;
  beforeEach(async () => {
    google = await fakeGoogleSigner();
    vi.stubGlobal("fetch", google.fetchImpl);
  });

  test("a deployment without push configured refuses every delivery", async () => {
    const t = setupTest();
    const { victim } = await world(t);
    const response = await pubsub(t, gmailDelivery("person@example.invalid"), await google.sign(pushClaims()));
    expect(response.status).toBe(401);
    expect((await row(t, victim)).push?.pending).toBeUndefined();
  });

  test("an unsigned or wrongly signed delivery is refused and changes nothing", async () => {
    enablePush();
    const t = setupTest();
    const { victim } = await world(t);
    expect((await pubsub(t, gmailDelivery("person@example.invalid"))).status).toBe(401);
    const impostor = await fakeGoogleSigner(google.kid);
    const forged = await impostor.sign(pushClaims());
    expect((await pubsub(t, gmailDelivery("person@example.invalid"), forged)).status).toBe(401);
    const otherAccount = await google.sign(pushClaims({ email: "attacker@example-project.iam.gserviceaccount.com" }));
    expect((await pubsub(t, gmailDelivery("person@example.invalid"), otherAccount)).status).toBe(401);
    expect((await row(t, victim)).push?.pending).toBeUndefined();
  });

  test("a Gmail notification marks only that mailbox pending and brings its pass forward", async () => {
    enablePush();
    const t = setupTest();
    const { victim, other } = await world(t);
    const before = Date.now();
    const response = await pubsub(t, gmailDelivery("PERSON@example.invalid"), await google.sign(pushClaims()));
    expect(response.status).toBe(204);
    const poked = await row(t, victim);
    expect(poked.push?.pending?.gmail).toBeGreaterThanOrEqual(before);
    expect(poked.push?.pending?.chat).toBeUndefined();
    // No sooner than the gap after the last pass, and no later than an hour.
    expect(poked.nextSyncAt).toBe(Math.max(poked.push!.pending!.gmail!, poked.lastSyncAt! + PUSH_MIN_GAP_MS));
    // The other tenant's row is untouched.
    const untouched = await row(t, other);
    expect(untouched.push?.pending).toBeUndefined();
    expect(untouched.nextSyncAt).toBeGreaterThan(Date.now() + HOUR / 2);
  });

  test("a mailbox nobody here watches is acknowledged and changes nothing", async () => {
    enablePush();
    const t = setupTest();
    const { victim } = await world(t);
    const response = await pubsub(t, gmailDelivery("stranger@example.invalid"), await google.sign(pushClaims()));
    expect(response.status).toBe(204);
    expect((await row(t, victim)).push?.pending).toBeUndefined();
  });

  test("a Chat event marks Chat pending by subscription; a lifecycle event also forces renewal", async () => {
    enablePush();
    const t = setupTest();
    const { victim } = await world(t);
    const token = await google.sign(pushClaims());
    expect((await pubsub(t, chatDelivery("subscriptions/victim-sub"), token)).status).toBe(204);
    const poked = await row(t, victim);
    expect(poked.push?.pending?.chat).toBeTypeOf("number");
    expect(poked.push?.chat?.expiresAt).toBeGreaterThan(Date.now());

    await pubsub(
      t,
      chatDelivery("subscriptions/victim-sub", "google.workspace.events.subscription.v1.expirationReminder"),
      token,
    );
    expect((await row(t, victim)).push?.chat?.expiresAt).toBe(0);
  });

  test("a disconnected account is never poked", async () => {
    enablePush();
    const t = setupTest();
    const { victim } = await world(t);
    await t.run((ctx) => ctx.db.patch(victim, { disconnectedAt: Date.now() }));
    await pubsub(t, gmailDelivery("person@example.invalid"), await google.sign(pushClaims()));
    expect((await row(t, victim)).push?.pending).toBeUndefined();
  });

  test("a failing connection keeps its backoff", async () => {
    enablePush();
    const t = setupTest();
    const { victim } = await world(t);
    const backoffUntil = Date.now() + 3 * HOUR;
    await t.run((ctx) => ctx.db.patch(victim, { syncFailures: 2, nextSyncAt: backoffUntil }));
    await pubsub(t, gmailDelivery("person@example.invalid"), await google.sign(pushClaims()));
    const poked = await row(t, victim);
    expect(poked.push?.pending?.gmail).toBeTypeOf("number");
    expect(poked.nextSyncAt).toBe(backoffUntil);
  });
});

describe("the Calendar door", () => {
  test("the channel's own token opens it; a wrong token and an unknown channel are one refusal", async () => {
    const t = setupTest();
    const { victim } = await world(t);
    const wrong = await calendar(t, {
      "x-goog-channel-id": "channel-victim",
      "x-goog-channel-token": "guessed-token",
      "x-goog-resource-state": "exists",
    });
    const unknown = await calendar(t, {
      "x-goog-channel-id": "channel-nobody",
      "x-goog-channel-token": CHANNEL_TOKEN,
      "x-goog-resource-state": "exists",
    });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.text()).toBe(await unknown.text());
    expect((await row(t, victim)).push?.pending).toBeUndefined();

    const right = await calendar(t, {
      "x-goog-channel-id": "channel-victim",
      "x-goog-channel-token": CHANNEL_TOKEN,
      "x-goog-resource-state": "exists",
    });
    expect(right.status).toBe(204);
    expect((await row(t, victim)).push?.pending?.calendar).toBeTypeOf("number");
  });

  test("the handshake Google sends when a channel opens fetches nothing", async () => {
    const t = setupTest();
    const { victim } = await world(t);
    const response = await calendar(t, {
      "x-goog-channel-id": "channel-victim",
      "x-goog-channel-token": CHANNEL_TOKEN,
      "x-goog-resource-state": "sync",
    });
    expect(response.status).toBe(204);
    expect((await row(t, victim)).push?.pending).toBeUndefined();
  });

  test("a disconnect closes the door: the stored channel is gone with the row's push state", async () => {
    const t = setupTest();
    const { victim } = await world(t);
    await t.run((ctx) => ctx.db.patch(victim, { disconnectedAt: Date.now(), push: undefined }));
    const response = await calendar(t, {
      "x-goog-channel-id": "channel-victim",
      "x-goog-channel-token": CHANNEL_TOKEN,
      "x-goog-resource-state": "exists",
    });
    expect(response.status).toBe(401);
  });
});

describe("the factories check before the handler runs", () => {
  const source = readFileSync(join(__dirname, "../../functions/lib/googlePush/routes.ts"), "utf8");
  test.each([
    ["pubsubPushRoute", "pubsubTokenIsValid("],
    ["calendarChannelRoute", "acceptCalendarNotification"],
  ])("%s refuses before it hands over", (factory, guard) => {
    const start = source.indexOf(`export function ${factory}(`);
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf("\n}\n", start));
    const guardAt = body.indexOf(guard);
    const refusalAt = body.indexOf("return unauthorized()", guardAt);
    const handlerAt = body.indexOf("return await handler(");
    expect(guardAt).toBeGreaterThan(-1);
    expect(refusalAt).toBeGreaterThan(guardAt);
    expect(handlerAt).toBeGreaterThan(refusalAt);
  });
});
