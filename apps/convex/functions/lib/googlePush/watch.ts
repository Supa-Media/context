/**
 * The Google calls that ask for, renew and stop push notifications.
 *
 * Each takes its socket and its access token as parameters and opens nothing
 * itself, like `gmailSync.js`. Each answers what it learned (an expiry, a
 * channel, a subscription name) and throws `GooglePushError` for anything
 * else; the caller records the failure and keeps polling.
 */

export class GooglePushError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
  ) {
    super(`Google push ${reason} (${status})`);
    this.name = "GooglePushError";
  }
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** Gmail's own label names for the two folders a connection may sync. */
const GMAIL_LABELS = { inbox: "INBOX", sent: "SENT" } as const;

/** Chat: every space this person is in, user-authorized. */
export const CHAT_ALL_SPACES = "//chat.googleapis.com/spaces/-";
export const CHAT_MESSAGE_CREATED = "google.workspace.chat.message.v1.created";
const WORKSPACE_EVENTS = "https://workspaceevents.googleapis.com/v1";

async function call(
  fetchImpl: Fetch,
  accessToken: string,
  url: string,
  reason: string,
  init: { method: string; body?: unknown },
): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    method: init.method,
    headers: {
      authorization: `Bearer ${accessToken}`,
      ...(init.body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!response.ok) throw new GooglePushError(response.status, reason);
  const text = await response.text();
  if (text.length === 0) return {};
  const parsed: unknown = JSON.parse(text);
  return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

function epochMs(value: unknown): number | undefined {
  const parsed = typeof value === "string" ? Number(value) : typeof value === "number" ? value : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function isoMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * `users.watch`. Calling it again on a mailbox that is already watched simply
 * extends the watch, which is how it is renewed; Google recommends doing so
 * daily. The `historyId` it returns is not stored: the sync's own cursor is
 * the only cursor, and a notification only says "look".
 */
export async function watchGmail(input: {
  fetchImpl: Fetch;
  accessToken: string;
  topic: string;
  folders: readonly ("inbox" | "sent")[];
}): Promise<{ expiresAt: number }> {
  const body = await call(
    input.fetchImpl,
    input.accessToken,
    "https://gmail.googleapis.com/gmail/v1/users/me/watch",
    "gmail_watch",
    {
      method: "POST",
      body: {
        topicName: input.topic,
        labelIds: input.folders.map((folder) => GMAIL_LABELS[folder]),
        labelFilterBehavior: "INCLUDE",
      },
    },
  );
  const expiresAt = epochMs(body.expiration);
  if (expiresAt === undefined) throw new GooglePushError(200, "gmail_watch_no_expiry");
  return { expiresAt };
}

/** `events.watch` on the primary calendar: a new channel, every time. */
export async function watchCalendar(input: {
  fetchImpl: Fetch;
  accessToken: string;
  address: string;
  channelId: string;
  token: string;
  ttlSeconds: number;
}): Promise<{ resourceId: string; expiresAt: number }> {
  const body = await call(
    input.fetchImpl,
    input.accessToken,
    "https://www.googleapis.com/calendar/v3/calendars/primary/events/watch",
    "calendar_watch",
    {
      method: "POST",
      body: {
        id: input.channelId,
        type: "web_hook",
        address: input.address,
        token: input.token,
        params: { ttl: String(input.ttlSeconds) },
      },
    },
  );
  const expiresAt = epochMs(body.expiration);
  if (typeof body.resourceId !== "string" || expiresAt === undefined) {
    throw new GooglePushError(200, "calendar_watch_incomplete");
  }
  return { resourceId: body.resourceId, expiresAt };
}

/** `channels.stop`. A channel that is already gone is not an error. */
export async function stopCalendarChannel(input: {
  fetchImpl: Fetch;
  accessToken: string;
  channelId: string;
  resourceId: string;
}): Promise<void> {
  try {
    await call(
      input.fetchImpl,
      input.accessToken,
      "https://www.googleapis.com/calendar/v3/channels/stop",
      "calendar_stop",
      { method: "POST", body: { id: input.channelId, resourceId: input.resourceId } },
    );
  } catch (error) {
    if (error instanceof GooglePushError && error.status === 404) return;
    throw error;
  }
}

type ChatSubscription = { name: string; expiresAt?: number; state?: string; topic?: string };

function subscriptionOf(value: unknown): ChatSubscription | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || !record.name.startsWith("subscriptions/")) return undefined;
  const topic = (record.notificationEndpoint as { pubsubTopic?: unknown } | undefined)?.pubsubTopic;
  return {
    name: record.name,
    expiresAt: isoMs(record.expireTime),
    state: typeof record.state === "string" ? record.state : undefined,
    topic: typeof topic === "string" ? topic : undefined,
  };
}

/** A long-running operation's result, when Google finished it in the same call. */
function operationResult(operation: Record<string, unknown>): ChatSubscription | undefined {
  return operation.done === true ? subscriptionOf(operation.response) : undefined;
}

function isStatus(error: unknown, status: number): boolean {
  return error instanceof GooglePushError && error.status === status;
}

async function getChatSubscription(
  fetchImpl: Fetch,
  accessToken: string,
  name: string,
): Promise<ChatSubscription | undefined> {
  try {
    return subscriptionOf(await call(fetchImpl, accessToken, `${WORKSPACE_EVENTS}/${name}`, "chat_get", { method: "GET" }));
  } catch (error) {
    // Google deletes a subscription once it expires.
    if (isStatus(error, 404)) return undefined;
    throw error;
  }
}

/** The subscription Google says this person already has on every space, whatever topic it names. */
async function findChatSubscription(fetchImpl: Fetch, accessToken: string): Promise<ChatSubscription | undefined> {
  const filter = `event_types:"${CHAT_MESSAGE_CREATED}" AND target_resource="${CHAT_ALL_SPACES}"`;
  const body = await call(
    fetchImpl,
    accessToken,
    `${WORKSPACE_EVENTS}/subscriptions?filter=${encodeURIComponent(filter)}`,
    "chat_list",
    { method: "GET" },
  );
  const subscriptions = Array.isArray(body.subscriptions) ? body.subscriptions : [];
  return subscriptions.map(subscriptionOf).find((subscription) => subscription !== undefined);
}

async function renewChatSubscription(
  fetchImpl: Fetch,
  accessToken: string,
  subscription: ChatSubscription,
): Promise<ChatSubscription> {
  if (subscription.state === "SUSPENDED") {
    // A suspended subscription delivers nothing until it is reactivated;
    // renewing its lifetime alone would record a watch that is not watching.
    await call(fetchImpl, accessToken, `${WORKSPACE_EVENTS}/${subscription.name}:reactivate`, "chat_reactivate", {
      method: "POST",
      body: {},
    });
  }
  // `ttl: 0s` asks for the longest lifetime Google allows.
  const operation = await call(
    fetchImpl,
    accessToken,
    `${WORKSPACE_EVENTS}/${subscription.name}?updateMask=ttl`,
    "chat_renew",
    { method: "PATCH", body: { ttl: "0s" } },
  );
  return operationResult(operation) ?? { name: subscription.name };
}

async function deleteChatSubscription(fetchImpl: Fetch, accessToken: string, name: string): Promise<void> {
  try {
    await call(fetchImpl, accessToken, `${WORKSPACE_EVENTS}/${name}`, "chat_delete", { method: "DELETE" });
  } catch (error) {
    if (!isStatus(error, 404)) throw error;
  }
}

async function createChatSubscription(
  fetchImpl: Fetch,
  accessToken: string,
  topic: string,
): Promise<ChatSubscription | "exists" | "pending"> {
  try {
    const operation = await call(fetchImpl, accessToken, `${WORKSPACE_EVENTS}/subscriptions`, "chat_create", {
      method: "POST",
      body: {
        targetResource: CHAT_ALL_SPACES,
        eventTypes: [CHAT_MESSAGE_CREATED],
        notificationEndpoint: { pubsubTopic: topic },
        payloadOptions: { includeResource: false },
      },
    });
    return operationResult(operation) ?? "pending";
  } catch (error) {
    if (isStatus(error, 409)) return "exists";
    throw error;
  }
}

/**
 * Make sure one Workspace Events subscription delivers this person's new Chat
 * messages, from every space they are in, to our topic.
 *
 * Google allows one such subscription per app, person and target, and its
 * topic cannot be changed, so: one we know of is read back first, reactivated
 * if Google suspended it, and renewed; one that names another topic (this
 * deployment's topic was changed) is deleted and replaced; and a create that
 * Google refuses because one exists adopts that one by the same rules.
 *
 * Answers the subscription's name, and its expiry when Google reported one in
 * the same call. Without an expiry the caller tries again later.
 */
export async function ensureChatSubscription(input: {
  fetchImpl: Fetch;
  accessToken: string;
  topic: string;
  known?: string;
}): Promise<ChatSubscription> {
  const { fetchImpl, accessToken, topic } = input;
  const adopt = async (existing: ChatSubscription | undefined): Promise<ChatSubscription | undefined> => {
    if (existing === undefined) return undefined;
    if (existing.topic === undefined || existing.topic === topic) {
      return await renewChatSubscription(fetchImpl, accessToken, existing);
    }
    await deleteChatSubscription(fetchImpl, accessToken, existing.name);
    return undefined;
  };

  if (input.known !== undefined) {
    const kept = await adopt(await getChatSubscription(fetchImpl, accessToken, input.known));
    if (kept !== undefined) return kept;
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const created = await createChatSubscription(fetchImpl, accessToken, topic);
    if (typeof created === "object") return created;
    // Created but not finished, or already there: either way it is listable.
    const existing = await findChatSubscription(fetchImpl, accessToken);
    if (created === "pending" && existing !== undefined && existing.topic === topic) return existing;
    const kept = await adopt(existing);
    if (kept !== undefined) return kept;
    // An old-topic subscription was deleted above: the second create replaces it.
  }
  throw new GooglePushError(200, "chat_subscription_missing");
}
