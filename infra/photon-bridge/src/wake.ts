/**
 * Waking the Photon container. A deploy can leave the object with no
 * instance ("There is no container instance that can be provided to this
 * Durable Object, try again later"). Waiting for the next minute alarm is
 * how that gap stretched on 2026-11-17. Retry here, and when the instance
 * is missing, wake again in a few seconds.
 */

export const ALARM_MS = 60_000;
export const WAKE_AGAIN_MS = 5_000;
export const WAKE_BACKOFF_MS = [1_000, 2_000, 4_000];

export type WakeOutcome = "up" | "missing" | "down";

const SAFE_DETAIL = /^(?:There is no container instance\b.*|container not ready|start \d{3}|next \d{3}|ack \d{3})$/;

export function isMissingContainer(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /no container instance/i.test(message) || message === "container not ready";
}

/** A known operational sentence only. Anything else might carry a payload. */
export function containerErrorDetail(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : "";
  if (!SAFE_DETAIL.test(message)) return undefined;
  return message.slice(0, 180);
}

export function containerGapDelayMs(attempt: number): number {
  return WAKE_BACKOFF_MS[Math.min(Math.max(attempt, 0), WAKE_BACKOFF_MS.length - 1)] ?? WAKE_BACKOFF_MS[WAKE_BACKOFF_MS.length - 1]!;
}

export function nextAlarmDelay(outcome: WakeOutcome): number {
  return outcome === "missing" ? WAKE_AGAIN_MS : ALARM_MS;
}

/**
 * Runs `run` until it resolves. Each failure waits the next backoff, including
 * a wake that failed for a reason other than a missing container. A fatal
 * error (the bridge is off) is not retried. The last failure is logged as
 * `wake.failed` and does not wait again.
 */
export async function retryWake(
  run: () => Promise<void>,
  {
    sleep,
    log,
    isFatal,
    backoffs = WAKE_BACKOFF_MS,
  }: {
    sleep: (ms: number) => Promise<void>;
    log: (record: Record<string, unknown>) => void;
    isFatal?: (error: unknown) => boolean;
    backoffs?: readonly number[];
  },
): Promise<WakeOutcome> {
  const attempts = backoffs.length + 1;
  for (let i = 0; i < attempts; i += 1) {
    try {
      await run();
      return "up";
    } catch (error) {
      if (isFatal?.(error)) throw error;
      const name = error instanceof Error ? error.name : "unknown";
      const detail = containerErrorDetail(error);
      const fields = { error: name, ...(detail ? { detail } : {}) };
      if (i === attempts - 1) {
        log({ event: "wake.failed", ...fields });
        return isMissingContainer(error) ? "missing" : "down";
      }
      const delay = backoffs[i] ?? backoffs[backoffs.length - 1] ?? WAKE_AGAIN_MS;
      log({ event: "wake.retry", attempt: i + 1, delay_ms: delay, ...fields });
      await sleep(delay);
    }
  }
  return "down";
}
