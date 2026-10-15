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

type ChatSubscription = { name: string; expiresAt?: number; state?: string };

function subscriptionOf(value: unknown): ChatSubscription | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.name !== "string" || !record.name.startsWith("subscriptions/")) return undefined;
  return {
    name: record.name,
    expiresAt: isoMs(record.expireTime),
    state: typeof record.state === "string" ? record.state : undefined,
  };
}

/** A long-running operation's result, when Google finished it in the same call. */
function operationResult(operation: Record<string, unknown>): ChatSubscription | undefined {
  return operation.done === true ? subscriptionOf(operation.response) : undefined;
}

async function findChatSubscription(
  fetchImpl: Fetch,
  accessToken: string,
  topic: string,
): Promise<ChatSubscription | undefined> {
  const filter = `event_types:"${CHAT_MESSAGE_CREATED}" AND target_resource="${CHAT_ALL_SPACES}"`;
  const body = await call(
    fetchImpl,
    accessToken,
    `${WORKSPACE_EVENTS}/subscriptions?filter=${encodeURIComponent(filter)}`,
    "chat_list",
    { method: "GET" },
  );
  const subscriptions = Array.isArray(body.subscriptions) ? body.subscriptions : [];
  for (const candidate of subscriptions) {
    const endpoint = (candidate as { notificationEndpoint?: { pubsubTopic?: unknown } })
      .notificationEndpoint?.pubsubTopic;
    const subscription = subscriptionOf(candidate);
    if (subscription !== undefined && endpoint === topic) return subscription;
  }
  return undefined;
}

async function renewChatSubscription(
  fetchImpl: Fetch,
  accessToken: string,
  subscription: ChatSubscription,
): Promise<ChatSubscription | undefined> {
  if (subscription.state === "SUSPENDED") {
    // Google suspends a subscription when, say, the grant stopped covering
    // it; a reactivate is the documented way back once it does again.
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

/**
 * Make sure one Workspace Events subscription delivers this person's new Chat
 * messages, from every space they are in, to our topic: renew the one we know
 * of, or create one, or adopt the one Google says already exists.
 *
 * Answers the subscription's name, and its expiry when Google reported one in
 * the same call. Without an expiry the caller keeps the old one or none, which
 * only means the next pass checks again.
 */
export async function ensureChatSubscription(input: {
  fetchImpl: Fetch;
  accessToken: string;
  topic: string;
  known?: string;
}): Promise<ChatSubscription> {
  const { fetchImpl, accessToken, topic } = input;
  if (input.known !== undefined) {
    try {
      const renewed = await renewChatSubscription(fetchImpl, accessToken, { name: input.known });
      if (renewed !== undefined) return renewed;
    } catch (error) {
      // An expired subscription is deleted by Google; anything else is real.
      if (!(error instanceof GooglePushError && error.status === 404)) throw error;
    }
  }
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
    const created = operationResult(operation);
    if (created !== undefined) return created;
  } catch (error) {
    if (!(error instanceof GooglePushError && error.status === 409)) throw error;
  }
  // Created but not finished, or already there: either way it is listable.
  const existing = await findChatSubscription(fetchImpl, accessToken, topic);
  if (existing === undefined) throw new GooglePushError(200, "chat_subscription_missing");
  if (existing.state === "SUSPENDED" || existing.expiresAt === undefined) {
    return (await renewChatSubscription(fetchImpl, accessToken, existing)) ?? existing;
  }
  return existing;
}
