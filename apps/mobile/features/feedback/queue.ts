import { openStore } from "../offline/store";
import { base64ToBytes, reportCode, type FeedbackDraft } from "./model";
import { sendFeedbackReport, type SendResult } from "./transport";

/**
 * Sending a report, and keeping it on this device when it cannot go yet.
 *
 * Three reasons a report waits: the device is offline, the server said it is
 * past the day's limit, or the person pressed "Send later" after a failure.
 * All three put it in one queue, which `drainQueue` empties when the app
 * starts and whenever the device comes back online. A queued report leaves
 * the queue only once the server has taken it — or refused it for good, which
 * a report this app built should never be.
 *
 * The limit is the server's (`functions/feedback.ts`): it counts across every
 * device, and this only keeps a report until the time the server named.
 */

const QUEUE_KEY = "context.feedback.queue.v1";
/** The old per-device count, before the server kept the limit. Removed on sight. */
const LEGACY_SENT_KEY = "context.feedback.sent.v1";

export type SubmitOutcome =
  | { kind: "sent"; code: string }
  | { kind: "offline" }
  | { kind: "limited" }
  | { kind: "failed" }
  | { kind: "rejected" };

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

function deliver(draft: FeedbackDraft): Promise<SendResult> {
  return sendFeedbackReport({
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
}

async function holdUntil(draft: FeedbackDraft, notBefore: number): Promise<void> {
  const queue = await readQueue();
  const kept = queue.some((item) => item.clientReportId === draft.clientReportId);
  await writeQueue(
    kept
      ? queue.map((item) => (item.clientReportId === draft.clientReportId ? { ...item, notBefore } : item))
      : [...queue, { ...draft, notBefore }],
  );
}

/** Send now if it can go now; otherwise say why, and keep it if it can go later. */
export async function submit(
  draft: FeedbackDraft,
  { online, now = Date.now() }: { online: boolean; now?: number },
): Promise<SubmitOutcome> {
  if (!online) {
    await enqueue(draft);
    return { kind: "offline" };
  }
  const result = await deliver(draft);
  switch (result.kind) {
    case "sent":
      await discard(draft.clientReportId);
      return { kind: "sent", code: reportCode(result.eventId) };
    case "limited":
      await holdUntil(draft, now + result.retryAfterMs);
      return { kind: "limited" };
    case "rejected":
      await discard(draft.clientReportId);
      return { kind: "rejected" };
    case "failed":
      return { kind: "failed" };
  }
}

let draining: Promise<void> | null = null;

/**
 * Send what is waiting and due, oldest first. A failure stops the run — the
 * rest wait for the next chance; the day's limit holds the report that hit it
 * until the time the server named, and stops the run too.
 */
export function drainQueue(now = Date.now()): Promise<void> {
  if (draining !== null) return draining;
  draining = (async () => {
    await openStore().remove(LEGACY_SENT_KEY).catch(() => {});
    for (const draft of await readQueue()) {
      if (draft.notBefore !== undefined && draft.notBefore > now) continue;
      const result = await deliver(draft);
      if (result.kind === "failed") return;
      if (result.kind === "limited") {
        await holdUntil(draft, now + result.retryAfterMs);
        return;
      }
      await discard(draft.clientReportId);
    }
  })().finally(() => {
    draining = null;
  });
  return draining;
}
