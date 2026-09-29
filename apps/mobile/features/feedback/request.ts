import { useSyncExternalStore } from "react";
import { telemetryRoute } from "../observability/privacy";
import { captureScreen, type Screenshot } from "./screenshot";
import type { FeedbackRequest, FeedbackSource } from "./model";

/**
 * Which report is open, if any, for the one `FeedbackHost` the signed-in app
 * mounts. Any surface can open it — the top bar's bug, the account card's row,
 * Settings — without a prop threaded down to it.
 *
 * The screenshot starts here rather than when the dialog mounts, so it is of
 * the screen the person was looking at when they asked. `screenshot.web.ts`
 * leaves the dialog out of the picture in case it lands first.
 */

export interface OpenReport extends FeedbackRequest {
  /** The screen with its words covered. `null` when no picture could be made. */
  screenshot: Promise<Screenshot | null>;
  openedAt: number;
}

let open: OpenReport | null = null;
const listeners = new Set<() => void>();

function currentPath(): string {
  return typeof window !== "undefined" && window.location ? window.location.pathname : "/";
}

/** A report about the screen as it is now, starting its screenshot at once. */
export function openReport(source: FeedbackSource, errorEventId?: string): OpenReport {
  return {
    source,
    errorEventId,
    screen: telemetryRoute(currentPath()),
    screenshot: captureScreen({ showText: false }),
    openedAt: Date.now(),
  };
}

export function openFeedback(source: FeedbackSource, errorEventId?: string): void {
  open = openReport(source, errorEventId);
  for (const listener of listeners) listener();
}

export function closeFeedback(): void {
  open = null;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useOpenFeedback(): OpenReport | null {
  return useSyncExternalStore(subscribe, () => open, () => null);
}
