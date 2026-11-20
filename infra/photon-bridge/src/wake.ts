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

const SAFE_DETAIL = /^(?:There is no container instance\b.*|container not ready|start \d{3}|next \d{3}|ack \d{3}|Network connection lost\.|The operation was aborted)$/;
/** A bare name such as an error code: letters, digits, dots and underscores. */
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_.]{0,60}$/;
/** A sentence the container or the platform says about itself. */
const SENTENCE = /^(?:Container|The container) /;
/** Five digits in a row can be a phone number, an id or a count of something private: never allowed in a detail. */
const LONG_DIGITS = /\d{5}/;
/** Quotes, brackets and braces mark a payload (a JSON body, a quoted value). */
const PAYLOAD = /[{}[\]"'`<>\\]/;
const PRINTABLE = /^[ -~]+$/;

/**
 * The class name of a thrown value, for logs. The error's own name, or its
 * constructor's when the name is the generic "Error"; "unknown" for a value
 * that is not an object. Never the message.
 */
export function errorClass(error: unknown): string {
  if (error === null || typeof error !== "object") return "unknown";
  const name = (error as { name?: unknown }).name;
  if (typeof name === "string" && name !== "" && name !== "Error") return name;
  return (error as { constructor?: { name?: string } }).constructor?.name || "Error";
}

/** Whether a message is an operational one that can be logged: a fixed sentence, a bare name, or a plain container sentence. */
function isSafeDetail(message: string): boolean {
  if (message.length === 0) return false;
  if (SAFE_DETAIL.test(message)) return true;
  if (LONG_DIGITS.test(message)) return false;
  if (IDENTIFIER.test(message)) return true;
  return SENTENCE.test(message) && message.length <= 180 && PRINTABLE.test(message) && !PAYLOAD.test(message);
}

export function isMissingContainer(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? "");
  return /no container instance/i.test(message) || message === "container not ready";
}

/** A known operational sentence only. Anything else might carry a payload. */
export function containerErrorDetail(error: unknown): string | undefined {
  const message = error instanceof Error ? error.message : "";
  if (!isSafeDetail(message)) return undefined;
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
      const name = errorClass(error);
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
