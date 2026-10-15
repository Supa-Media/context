import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  enableMailSync,
  endToEnd,
  googleAndBucket,
  calendarAndBucket,
  chatAndBucket,
  patchConnection,
  readConnection,
  runPass,
} from "../googleSyncLoop/fixtures.helpers";
import { sha256Hex } from "../../functions/lib/googlePush/ensure";
import { enablePush, TOPIC, SITE } from "./fixtures.helpers";

/**
 * Registration rides the pass that just synced: it is asked for once,
 * renewed before it lapses, never repeated while it is fresh, and never the
 * reason a pass fails.
 */

const DAY = 24 * 60 * 60 * 1000;

type Call = { method: string; path: string; body?: Record<string, unknown> };

/** Google's push endpoints in front of a sync fixture's own `fetchImpl`. */
function withPushApis(
  inner: (input: URL | RequestInfo, init?: RequestInit) => Promise<Response>,
  answers: {
    status?: number;
    /** The subscription Google already holds for this person, if any. */
    existing?: { name: string; state?: string; notificationEndpoint?: { pubsubTopic: string } };
  } = {},
) {
  const calls: Call[] = [];
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fetchImpl = async (input: URL | RequestInfo, init: RequestInit = {}) => {
    const url = new URL(typeof input === "string" ? input : String(input));
    const key = `${url.hostname}${url.pathname}`;
    const record = () =>
      calls.push({
        method: init.method ?? "GET",
        path: key,
        body: typeof init.body === "string" && init.body.length > 0 ? JSON.parse(init.body) : undefined,
      });
    if (key === "gmail.googleapis.com/gmail/v1/users/me/watch") {
      record();
      if (answers.status) return json({ error: {} }, answers.status);
      return json({ historyId: "1", expiration: String(Date.now() + 7 * DAY) });
    }
    if (key === "www.googleapis.com/calendar/v3/calendars/primary/events/watch") {
      record();
      const body = JSON.parse(String(init.body));
      return json({ id: body.id, resourceId: "resource-1", expiration: String(Date.now() + 7 * DAY) });
    }
    if (key === "www.googleapis.com/calendar/v3/channels/stop") {
      record();
      return new Response(null, { status: 204 });
    }
    if (url.hostname === "workspaceevents.googleapis.com") {
      record();
      const method = init.method ?? "GET";
      const subscription = (name: string, extra: Record<string, unknown> = {}) => ({
        name,
        expireTime: new Date(Date.now() + 7 * DAY).toISOString(),
        notificationEndpoint: { pubsubTopic: TOPIC },
        state: "ACTIVE",
        ...extra,
      });
      const existing = answers.existing;
      if (method === "POST" && url.pathname === "/v1/subscriptions") {
        if (existing !== undefined) return json({ error: { status: "ALREADY_EXISTS" } }, 409);
        return json({ name: "operations/x", done: true, response: subscription("subscriptions/example-sub") });
      }
      if (method === "GET" && url.pathname === "/v1/subscriptions") {
        return json({ subscriptions: existing === undefined ? [] : [subscription(existing.name, existing)] });
      }
      if (method === "GET") {
        const name = url.pathname.slice("/v1/".length);
        if (existing === undefined || existing.name !== name) return json({ error: {} }, 404);
        return json(subscription(name, existing));
      }
      if (method === "DELETE") {
        answers.existing = undefined;
        return json({ name: "operations/z", done: true });
      }
      if (method === "POST" && url.pathname.endsWith(":reactivate")) {
        if (existing !== undefined) existing.state = "ACTIVE";
        return json({ name: "operations/r", done: false });
      }
      if (method === "PATCH") {
        const name = url.pathname.slice("/v1/".length);
        return json({ name: "operations/y", done: true, response: subscription(name, existing ?? {}) });
      }
    }
    return await inner(input, init);
  };
  return { fetchImpl, calls };
}

describe("push registration from inside the pass", () => {
  beforeEach(() => enableMailSync());

  test("with push off, a pass asks Google for nothing new", async () => {
    const { t, workspaceId, connectionId, backend } = await endToEnd({ historyId: "1000" });
    const google = withPushApis(googleAndBucket({ backend }).fetchImpl);
    vi.stubGlobal("fetch", google.fetchImpl);
    await runPass(t, workspaceId, connectionId);
    expect(google.calls).toEqual([]);
    expect((await readConnection(t, connectionId)).push).toBeUndefined();
  });

  test("Gmail is watched on our topic for its own folders, once, and renewed only near expiry", async () => {
    enablePush();
    const { t, workspaceId, connectionId, backend } = await endToEnd({ historyId: "1000" });
    const google = withPushApis(googleAndBucket({ backend }).fetchImpl);
    vi.stubGlobal("fetch", google.fetchImpl);
    await runPass(t, workspaceId, connectionId);
    expect(google.calls).toEqual([
      {
        method: "POST",
        path: "gmail.googleapis.com/gmail/v1/users/me/watch",
        body: { topicName: TOPIC, labelIds: ["INBOX"], labelFilterBehavior: "INCLUDE" },
      },
    ]);
    const watched = await readConnection(t, connectionId);
    expect(watched.push?.gmail).toMatchObject({ address: "person@example.invalid", topic: TOPIC });
    expect(watched.push?.gmail?.expiresAt).toBeGreaterThan(Date.now() + 6 * DAY);

    // Fresh: the next pass leaves it alone.
    await patchConnection(t, connectionId, { syncStartedAt: Date.now() });
    await runPass(t, workspaceId, connectionId);
    expect(google.calls).toHaveLength(1);

    // A day later it is re-watched, which is how Gmail extends a watch.
    await patchConnection(t, connectionId, {
      syncStartedAt: Date.now(),
      push: { ...watched.push, gmail: { ...watched.push!.gmail!, expiresAt: Date.now() + 5 * DAY } },
    });
    await runPass(t, workspaceId, connectionId);
    expect(google.calls).toHaveLength(2);
  });

  test("a refused watch is recorded, the pass still syncs, and it is not retried every pass", async () => {
    enablePush();
    const { t, workspaceId, connectionId, backend } = await endToEnd({ historyId: "1000" });
    const google = withPushApis(googleAndBucket({ backend }).fetchImpl, { status: 403 });
    vi.stubGlobal("fetch", google.fetchImpl);
    const result = await runPass(t, workspaceId, connectionId);
    expect(result).toMatchObject({ status: "synced" });
    const row = await readConnection(t, connectionId);
    expect(row.health).toBe("active");
    expect(row.push?.gmail).toMatchObject({ failure: "gmail_watch (403)" });

    await patchConnection(t, connectionId, { syncStartedAt: Date.now() });
    await runPass(t, workspaceId, connectionId);
    expect(google.calls).toHaveLength(1);
  });

  test("Calendar opens a channel to this deployment, stores only its token's hash, and stops the old one on renewal", async () => {
    enablePush();
    const { t, workspaceId, connectionId, backend } = await endToEnd();
    await patchConnection(t, connectionId, {
      products: ["calendar"],
      gmail: undefined,
      calendar: { scopes: [], destinationFolder: "0-inbox/calendar" },
    });
    const google = withPushApis(calendarAndBucket({ backend }).fetchImpl);
    vi.stubGlobal("fetch", google.fetchImpl);
    await runPass(t, workspaceId, connectionId);

    const watch = google.calls.find((call) => call.path.endsWith("/events/watch"))!;
    expect(watch.body).toMatchObject({ type: "web_hook", address: `${SITE}/google/push/calendar` });
    const first = (await readConnection(t, connectionId)).push!.calendar!;
    expect(first.channelId).toBe(watch.body!.id);
    expect(first.tokenHash).toBe(await sha256Hex(String(watch.body!.token)));
    expect(JSON.stringify(await readConnection(t, connectionId))).not.toContain(String(watch.body!.token));

    await patchConnection(t, connectionId, {
      syncStartedAt: Date.now(),
      push: { calendar: { ...first, expiresAt: Date.now() + DAY } },
    });
    await runPass(t, workspaceId, connectionId);
    const second = (await readConnection(t, connectionId)).push!.calendar!;
    expect(second.channelId).not.toBe(first.channelId);
    expect(google.calls.find((call) => call.path.endsWith("/channels/stop"))?.body).toEqual({
      id: first.channelId,
      resourceId: first.resourceId,
    });
  });

  async function chatScenario() {
    const scene = await endToEnd();
    await patchConnection(scene.t, scene.connectionId, {
      products: ["chat"],
      gmail: undefined,
      chat: {
        scopes: [],
        nonceSeed: "fixture-chat-nonce-seed",
        cursors: { "spaces/alpha": "2026-09-12T09:00:00.000Z" },
      },
    });
    return scene;
  }
  const mutating = (calls: Call[]) => calls.filter((call) => call.method !== "GET").map((call) => `${call.method} ${call.path}`);

  test("Chat is subscribed across every space to our topic", async () => {
    enablePush();
    const { t, workspaceId, connectionId, backend } = await chatScenario();
    const google = withPushApis(chatAndBucket({ backend }).fetchImpl);
    vi.stubGlobal("fetch", google.fetchImpl);
    await runPass(t, workspaceId, connectionId);
    expect(google.calls.find((call) => call.method === "POST")!.body).toEqual({
      targetResource: "//chat.googleapis.com/spaces/-",
      eventTypes: ["google.workspace.chat.message.v1.created"],
      notificationEndpoint: { pubsubTopic: TOPIC },
      payloadOptions: { includeResource: false },
    });
    expect((await readConnection(t, connectionId)).push?.chat).toMatchObject({
      subscriptionName: "subscriptions/example-sub",
      topic: TOPIC,
    });
  });

  test("a subscription Google already holds on our topic is adopted and renewed", async () => {
    enablePush();
    const { t, workspaceId, connectionId, backend } = await chatScenario();
    const google = withPushApis(chatAndBucket({ backend }).fetchImpl, {
      existing: { name: "subscriptions/held" },
    });
    vi.stubGlobal("fetch", google.fetchImpl);
    await runPass(t, workspaceId, connectionId);
    expect(mutating(google.calls)).toEqual([
      "POST workspaceevents.googleapis.com/v1/subscriptions",
      "PATCH workspaceevents.googleapis.com/v1/subscriptions/held",
    ]);
    expect((await readConnection(t, connectionId)).push?.chat?.subscriptionName).toBe("subscriptions/held");
  });

  test("one on a retired topic is deleted and replaced, not left blocking push forever", async () => {
    enablePush();
    const { t, workspaceId, connectionId, backend } = await chatScenario();
    const google = withPushApis(chatAndBucket({ backend }).fetchImpl, {
      existing: {
        name: "subscriptions/old-topic",
        notificationEndpoint: { pubsubTopic: "projects/example-project/topics/retired" },
      },
    });
    vi.stubGlobal("fetch", google.fetchImpl);
    await runPass(t, workspaceId, connectionId);
    expect(mutating(google.calls)).toEqual([
      "POST workspaceevents.googleapis.com/v1/subscriptions",
      "DELETE workspaceevents.googleapis.com/v1/subscriptions/old-topic",
      "POST workspaceevents.googleapis.com/v1/subscriptions",
    ]);
    expect((await readConnection(t, connectionId)).push?.chat).toMatchObject({
      subscriptionName: "subscriptions/example-sub",
      topic: TOPIC,
    });
  });

  test("a suspended subscription is reactivated, not merely given a longer life", async () => {
    enablePush();
    const { t, workspaceId, connectionId, backend } = await chatScenario();
    // What a suspension lifecycle event leaves behind: a known name, expiry 0.
    await patchConnection(t, connectionId, {
      push: { chat: { subscriptionName: "subscriptions/held", topic: TOPIC, expiresAt: 0 } },
    });
    const google = withPushApis(chatAndBucket({ backend }).fetchImpl, {
      existing: { name: "subscriptions/held", state: "SUSPENDED" },
    });
    vi.stubGlobal("fetch", google.fetchImpl);
    await runPass(t, workspaceId, connectionId);
    expect(mutating(google.calls)).toEqual([
      "POST workspaceevents.googleapis.com/v1/subscriptions/held:reactivate",
      "PATCH workspaceevents.googleapis.com/v1/subscriptions/held",
    ]);
    expect((await readConnection(t, connectionId)).push?.chat?.expiresAt).toBeGreaterThan(Date.now());
  });

});
