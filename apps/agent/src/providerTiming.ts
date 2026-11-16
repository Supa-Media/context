/**
 * What a texting provider says about a text's way in and a send's way out, in one shape whatever the provider
 * (Sendblue, Linq, Whapi, Photon), so the chat's `text` and `send` steps show where the time went (Dev2, 2026-11-14:
 * "there's a lot of lag due to provider that's not really being logged ... that node should show the lag and any logs
 * or any error messages from the provider"). In Tex Devs that day a text took about two minutes from the phone to
 * Sendblue's webhook, and Sendblue's own "sent" took 15 to 333 seconds, and no step showed either.
 *
 * Times are epoch milliseconds. A step keeps ids, codes and times, never anyone's words: a provider's error message
 * is its own text, cut short.
 */

export type ProviderName = "sendblue" | "linq" | "whapi" | "photon" | "lab";
export type ProviderError = { code: string; message?: string };

/** A text's way in: the provider's own time for it, when we got its webhook, and the lag between. */
export type ProviderArrival = {
  name: ProviderName;
  /** The provider's time for the text (Sendblue `date_sent`, Whapi `timestamp`, Linq `sent_at`). */
  providerAt?: number;
  /** When this Worker took the webhook. */
  receivedAt: number;
  /** `receivedAt - providerAt`, when the provider gave a time we can trust. */
  lagMs?: number;
  status?: string;
  error?: ProviderError;
};

export type SendStatusName = "queued" | "sent" | "delivered" | "read" | "failed" | "other";

/** A send's way out, as one status callback or delivery event tells it. */
export type ProviderSend = {
  name: ProviderName;
  /** The provider's id for the send. */
  handle: string;
  status: SendStatusName;
  /** The provider's time for this status. */
  providerAt?: number;
  /** The provider's time for the send itself (when it took it). */
  sentAt?: number;
  /** `providerAt - sentAt`: how long the provider took to reach this status. */
  lagMs?: number;
  error?: ProviderError;
};

const NAMES: readonly ProviderName[] = ["sendblue", "linq", "whapi", "photon", "lab"];
/** A time this far ahead of ours is the provider's clock, not a lag; this far behind is a replay, not a lag either. */
export const LAG_SKEW_MS = 60_000;
export const LAG_MOST_MS = 24 * 60 * 60 * 1000;
const CODE = /[^\w.-]/g;
const MAX_MESSAGE = 200;

/** A provider's time as epoch milliseconds: an ISO or RFC string, or a number in seconds or milliseconds. */
export function providerTime(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return Math.round(value < 1e12 ? value * 1000 : value);
  if (typeof value === "string" && value.length <= 64) {
    if (/^\d{9,13}$/.test(value)) return providerTime(Number(value));
    const at = Date.parse(value);
    return Number.isFinite(at) ? at : null;
  }
  return null;
}

/** `later - earlier` in whole milliseconds, or null when it is out of reach (a skewed clock, a replay). */
export function lagBetween(earlier: number | null | undefined, later: number): number | null {
  if (typeof earlier !== "number" || !Number.isFinite(earlier)) return null;
  const lag = later - earlier;
  if (lag < -LAG_SKEW_MS || lag > LAG_MOST_MS) return null;
  return Math.max(0, Math.round(lag));
}

/** An error as a step keeps it: a code, and the provider's own message cut short. */
export function providerError(code: unknown, message?: unknown): ProviderError | undefined {
  const kept = typeof code === "string" || typeof code === "number" ? String(code).replace(CODE, "").slice(0, 40) : "";
  if (kept === "") return undefined;
  return { code: kept, ...(typeof message === "string" && message.trim() !== "" ? { message: message.trim().slice(0, MAX_MESSAGE) } : {}) };
}

/** A text's arrival, from the provider's time for it (any form `providerTime` reads) and when its webhook came. */
export function arrivalOf(name: ProviderName, providerAt: unknown, receivedAt: number, extra: { status?: string; error?: ProviderError } = {}): ProviderArrival {
  const at = providerTime(providerAt);
  const lag = lagBetween(at, receivedAt);
  return {
    name,
    ...(at !== null && lag !== null ? { providerAt: at, lagMs: lag } : {}),
    receivedAt,
    ...(typeof extra.status === "string" && extra.status !== "" ? { status: extra.status.replace(CODE, "").slice(0, 40) } : {}),
    ...(extra.error ? { error: extra.error } : {}),
  };
}

/** A send's status, from the provider's times for the status and for the send. */
export function sendReportOf(
  name: ProviderName,
  handle: string,
  status: SendStatusName,
  times: { providerAt?: unknown; sentAt?: unknown } = {},
  error?: ProviderError,
): ProviderSend {
  const at = providerTime(times.providerAt);
  const sent = providerTime(times.sentAt);
  const lag = at !== null ? lagBetween(sent, at) : null;
  return {
    name,
    handle: handle.slice(0, 120),
    status,
    ...(at !== null ? { providerAt: at } : {}),
    ...(sent !== null ? { sentAt: sent } : {}),
    ...(lag !== null ? { lagMs: lag } : {}),
    ...(error ? { error } : {}),
  };
}

/** An arrival as a message carries it, checked: anything else is dropped (a message is stored and handed on). */
export function readArrival(value: unknown): ProviderArrival | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (!NAMES.includes(v.name as ProviderName) || typeof v.receivedAt !== "number" || !Number.isFinite(v.receivedAt)) return undefined;
  const num = (x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
  const error = v.error && typeof v.error === "object" ? providerError((v.error as ProviderError).code, (v.error as ProviderError).message) : undefined;
  const providerAt = num(v.providerAt);
  const lagMs = num(v.lagMs);
  return {
    name: v.name as ProviderName,
    ...(providerAt !== undefined ? { providerAt } : {}),
    receivedAt: v.receivedAt,
    ...(lagMs !== undefined ? { lagMs } : {}),
    ...(typeof v.status === "string" ? { status: v.status.replace(CODE, "").slice(0, 40) } : {}),
    ...(error ? { error } : {}),
  };
}
