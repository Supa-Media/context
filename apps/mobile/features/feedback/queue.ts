import { openStore } from "../offline/store";
import { sendFeedbackReport } from "../observability/client";
import {
  DAILY_LIMIT,
  base64ToBytes,
  dayKey,
  reportCode,
  startOfTomorrow,
  type FeedbackDraft,
} from "./model";

/**
 * Sending a report, and keeping it on this device when it cannot go yet.
 *
 * Three reasons a report waits: the device is offline, it is past the day's
 * limit, or the person pressed "Send later" after a failure. All three put it
 * in one queue, which `drainQueue` empties when the app starts and whenever the
 * device comes back online. A queued report is never lost to a failed send: it
 * leaves the queue only once Sentry has taken it.
 */

const QUEUE_KEY = "context.feedback.queue.v1";
const SENT_KEY = "context.feedback.sent.v1";

export type SubmitOutcome =
  | { kind: "sent"; code: string }
  | { kind: "offline" }
  | { kind: "limited" }
  | { kind: "failed" };

type Listener = (count: number) => void;
const listeners = new Set<Listener>();

async function readQueue(): Promise<FeedbackDraft[]> {
  try {
    const raw = await openStore().get(QUEUE_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as FeedbackDraft[]) : [];
  } catch {
    return [];
  }
}

async function writeQueue(queue: FeedbackDraft[]): Promise<void> {
  const store = openStore();
  try {
    await store.set(QUEUE_KEY, JSON.stringify(queue));
  } catch {
    // Usually the storage quota, and the screenshot is what fills it. Keep
    // every message; drop the pictures rather than the reports.
    await store.set(
      QUEUE_KEY,
      JSON.stringify(queue.map(({ screenshot: _dropped, ...rest }) => rest)),
    );
  }
  for (const listener of listeners) listener(queue.length);
}

async function sentToday(now: number): Promise<number> {
  try {
    const raw = await openStore().get(SENT_KEY);
    const value = raw === null ? null : (JSON.parse(raw) as { day?: string; count?: number });
    return value?.day === dayKey(now) && typeof value.count === "number" ? value.count : 0;
  } catch {
    return 0;
  }
}

async function countSent(now: number): Promise<void> {
  const count = (await sentToday(now)) + 1;
  try {
    await openStore().set(SENT_KEY, JSON.stringify({ day: dayKey(now), count }));
  } catch {
    // A limit that could not be recorded lets one more through. Acceptable.
  }
}

export async function enqueue(draft: FeedbackDraft): Promise<void> {
  const queue = await readQueue();
  await writeQueue([
    ...queue.filter((item) => item.clientReportId !== draft.clientReportId),
    draft,
  ]);
}

export async function discard(clientReportId: string): Promise<void> {
  const queue = await readQueue();
  await writeQueue(queue.filter((item) => item.clientReportId !== clientReportId));
}

export async function queuedCount(): Promise<number> {
  return (await readQueue()).length;
}

export function onQueueChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function deliver(draft: FeedbackDraft, now: number): Promise<string | null> {
  const eventId = await sendFeedbackReport({
    clientReportId: draft.clientReportId,
    message: draft.message,
    source: draft.source,
    screen: draft.screen,
    errorEventId: draft.errorEventId,
    activity: draft.activity,
    screenshot:
      draft.screenshot === undefined
        ? undefined
        : { data: base64ToBytes(draft.screenshot.base64), contentType: draft.screenshot.contentType },
  });
  if (eventId !== null) await countSent(now);
  return eventId;
}

/** Send now if it can go now; otherwise say why and keep it. */
export async function submit(
  draft: FeedbackDraft,
  { online, now = Date.now() }: { online: boolean; now?: number },
): Promise<SubmitOutcome> {
  if ((await sentToday(now)) >= DAILY_LIMIT) {
    await enqueue({ ...draft, notBefore: startOfTomorrow(now) });
    return { kind: "limited" };
  }
  if (!online) {
    await enqueue(draft);
    return { kind: "offline" };
  }
  const eventId = await deliver(draft, now);
  if (eventId === null) return { kind: "failed" };
  await discard(draft.clientReportId);
  return { kind: "sent", code: reportCode(eventId) };
}

let draining: Promise<void> | null = null;

/** Send what is waiting and due. Stops at the first failure; the rest wait. */
export function drainQueue(now = Date.now()): Promise<void> {
  if (draining !== null) return draining;
  draining = (async () => {
    for (const draft of await readQueue()) {
      if (draft.notBefore !== undefined && draft.notBefore > now) continue;
      if ((await sentToday(now)) >= DAILY_LIMIT) return;
      if ((await deliver(draft, now)) === null) return;
      await discard(draft.clientReportId);
    }
  })().finally(() => {
    draining = null;
  });
  return draining;
}
