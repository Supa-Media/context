import { useEffect, useSyncExternalStore } from "react";
import { useConvex, useQueries } from "convex/react";
import { api } from "@context/convex/_generated/api";
import { FEEDBACK_LIMITS } from "@context/shared";
import { reportDevice } from "./device";
import type { FeedbackSource } from "./model";

/**
 * How a report leaves the app: to the control plane's `submitFeedback`
 * (`apps/convex/functions/feedback.ts`), which checks it again, counts it
 * against the day's ten and sends it on to Sentry. The app holds no Sentry
 * key for feedback, and nothing here decides a limit — it only reports what
 * the server said, so the queue can keep a report that has to wait.
 *
 * The Convex client is handed in by `useFeedbackTransport`, which both the
 * signed-in layout's host and the broken page mount: the broken page replaces
 * the whole app, host included, but still sits inside the Convex provider.
 */

export interface FeedbackReport {
  clientReportId: string;
  message: string;
  source: FeedbackSource;
  /** Cleaned route of the screen behind the report. */
  screen: string;
  /** The error the report is about, when it was opened from the broken page. */
  errorEventId?: string;
  /** The activity log exactly as the person saw it; absent when unticked. */
  activity?: string;
  screenshot?: { data: Uint8Array; contentType: string };
}

export type SendResult =
  | { kind: "sent"; eventId: string }
  /** Over the day's limit: try again after this many milliseconds. */
  | { kind: "limited"; retryAfterMs: number }
  /** Not taken this time — offline, timed out, the server busy or off. Keep it. */
  | { kind: "failed" }
  /** The server will never take this report as it is. */
  | { kind: "rejected" };

type SubmitArgs = Omit<FeedbackReport, "screenshot"> & {
  screenshot?: ArrayBuffer;
  screenshotType?: string;
  app: { platform: string; build?: string };
  system?: { family: string; version?: string };
};

export type FeedbackSubmitter = (args: SubmitArgs) => Promise<{ eventId: string }>;

/** Longer than the server's own 15 seconds to Sentry, so its answer can arrive. */
export const SEND_TIMEOUT_MS = 25_000;

let submitter: FeedbackSubmitter | null = null;

export function setFeedbackSubmitter(next: FeedbackSubmitter | null): void {
  submitter = next;
}

let available = false;
const availabilityListeners = new Set<() => void>();

/** Whether this deployment takes reports, as the server last said. */
export function feedbackAvailable(): boolean {
  return available;
}

export function setFeedbackAvailable(next: boolean): void {
  if (available === next) return;
  available = next;
  for (const listener of availabilityListeners) listener();
}

function subscribeAvailability(listener: () => void): () => void {
  availabilityListeners.add(listener);
  return () => availabilityListeners.delete(listener);
}

/** For the entry points: draw the report button only where a report can go. */
export function useCanSendFeedback(): boolean {
  return useSyncExternalStore(subscribeAvailability, feedbackAvailable, feedbackAvailable);
}

/**
 * Hand this module the Convex client. Not undone on unmount: the broken page
 * unmounts the host and still sends. The broken page mounts this one alone —
 * never `useQuery`, which re-throws a failed query during render and would
 * throw again inside the page that exists to catch it.
 */
export function useFeedbackSubmitter(): void {
  const convex = useConvex();
  useEffect(() => {
    setFeedbackSubmitter((args) => convex.action(api.functions.feedback.submitFeedback, args));
  }, [convex]);
}

const AVAILABILITY_QUERY = { available: { query: api.functions.feedback.feedbackAvailable, args: {} } };

/**
 * The signed-in host: the client, and whether the server takes reports. Read
 * with `useQueries`, which hands back a failure as a value: a backend a
 * deploy behind, without the function yet, hides the report button rather
 * than taking the app down.
 */
export function useFeedbackTransport(): void {
  useFeedbackSubmitter();
  const serverSays: unknown = useQueries(AVAILABILITY_QUERY).available;
  useEffect(() => {
    if (serverSays === undefined) return;
    setFeedbackAvailable(serverSays === true);
  }, [serverSays]);
}

/** The ConvexError payload, when the server refused on purpose. */
function refusal(error: unknown): { code?: string; retryAfterMs?: number } | null {
  const data = (error as { data?: unknown } | null)?.data;
  return data !== null && typeof data === "object" ? (data as { code?: string; retryAfterMs?: number }) : null;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function sendFeedbackReport(
  report: FeedbackReport,
  timeoutMs = SEND_TIMEOUT_MS,
): Promise<SendResult> {
  const send = submitter;
  if (send === null) return { kind: "failed" };
  // A picture over the server's cap would refuse the whole report; the words
  // matter more than the picture, so it goes without one.
  const screenshot =
    report.screenshot !== undefined && report.screenshot.data.byteLength <= FEEDBACK_LIMITS.screenshotBytes
      ? report.screenshot
      : undefined;
  const args: SubmitArgs = {
    clientReportId: report.clientReportId,
    message: report.message,
    source: report.source,
    screen: report.screen,
    ...(report.errorEventId === undefined ? {} : { errorEventId: report.errorEventId }),
    ...(report.activity === undefined || report.activity === "" ? {} : { activity: report.activity }),
    ...(screenshot === undefined
      ? {}
      : { screenshot: toArrayBuffer(screenshot.data), screenshotType: screenshot.contentType }),
    ...reportDevice(),
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const answer = await Promise.race([
      send(args),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
      }),
    ]);
    return { kind: "sent", eventId: answer.eventId };
  } catch (error) {
    const data = refusal(error);
    if (data?.code === "FEEDBACK_RATE_LIMITED") {
      const wait = typeof data.retryAfterMs === "number" && data.retryAfterMs > 0 ? data.retryAfterMs : 60 * 60 * 1000;
      return { kind: "limited", retryAfterMs: Math.min(wait, 24 * 60 * 60 * 1000) };
    }
    if (data?.code === "FEEDBACK_INVALID") return { kind: "rejected" };
    return { kind: "failed" };
  } finally {
    clearTimeout(timer);
  }
}
