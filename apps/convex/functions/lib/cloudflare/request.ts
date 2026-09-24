/**
 * The one authenticated call to the Cloudflare API, classified on the way out,
 * and the credential-redaction helper it shares with error reporting.
 *
 * Split out of `lib/cloudflare.ts` — see that file's header for what the whole
 * module is for and the credential-handling rules it follows.
 */

import { CLOUDFLARE_API_BASE } from "./naming";
import {
  classifyCloudflareFailure,
  CloudflareApiError,
  type CloudflareEnvelope,
} from "./errors";

/**
 * How long one Cloudflare API call may take.
 *
 * Same reasoning as the storage probe's deadline: a request that hangs holds an
 * action open and, here, holds a decrypted setup credential in memory for the
 * duration. `AbortSignal.timeout` is guarded rather than assumed, because this
 * code runs in three runtimes and a missing deadline is a slower failure rather
 * than a wrong one.
 */
const REQUEST_TIMEOUT_MS = 15_000;

function timeoutSignal(): AbortSignal | undefined {
  return typeof AbortSignal !== "undefined" &&
    typeof AbortSignal.timeout === "function"
    ? AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    : undefined;
}

/**
 * One authenticated call to the Cloudflare API, classified on the way out.
 *
 * The token is on the `Authorization` header and nowhere else — never in the
 * URL, never in a log line. A non-2xx, an unparseable body and `success: false`
 * are all the same kind of event to a caller: a `CloudflareApiError` carrying a
 * code from the closed set.
 */
export async function cloudflareRequest<T>(options: {
  apiToken: string;
  method: "GET" | "POST" | "DELETE";
  path: string;
  body?: unknown;
  headers?: Record<string, string>;
  /**
   * Accept a success envelope with no `result`. Only for calls whose answer is
   * the status — `DELETE /tokens/:id` is the one — because treating a missing
   * result as failure there would report a revoked token as still standing.
   */
  resultOptional?: boolean;
}): Promise<T> {
  const signal = timeoutSignal();
  let response: Response;
  try {
    response = await globalThis.fetch(`${CLOUDFLARE_API_BASE}${options.path}`, {
      method: options.method,
      headers: {
        Authorization: `Bearer ${options.apiToken}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...options.headers,
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    // No answer at all: DNS, TLS, the deadline above. Retryable — and whether
    // anything changed depends entirely on which call this was, which is a
    // question this function cannot answer. It used to answer it anyway, with
    // "Nothing was changed", on the one call where that is most likely to be
    // false: a create that timed out may well have created the bucket.
    throw new CloudflareApiError(
      {
        errorCode: "CLOUDFLARE_UNAVAILABLE",
        message: "Cloudflare could not be reached.",
      },
      String((error as { message?: unknown })?.message ?? ""),
    );
  }

  let envelope: CloudflareEnvelope<T> = {};
  let raw = "";
  try {
    raw = await response.text();
    envelope = raw.length === 0 ? {} : (JSON.parse(raw) as CloudflareEnvelope<T>);
  } catch {
    // A body that is not JSON is still a failure we have to classify; the
    // status is all we have to go on.
    envelope = {};
  }

  if (
    !response.ok ||
    envelope.success === false ||
    (envelope.result === undefined && options.resultOptional !== true)
  ) {
    const failure = classifyCloudflareFailure({
      status: response.status,
      errors: envelope.errors,
    });
    throw new CloudflareApiError(failure, describeErrors(envelope, raw));
  }
  // Only reachable as `undefined` when the caller asked for `resultOptional`,
  // which is the caller saying the status was the answer.
  return envelope.result as T;
}

/**
 * JSON fields whose value is a credential, whatever else is in the body.
 *
 * The mint call is the one endpoint here whose *body* can carry a live secret
 * (`result.value` is a Cloudflare API token), and the raw-body fallback below
 * runs before that value is known to the caller — so it could not be redacted
 * by the caller's secret list even in principle. This closes it at the source
 * instead: the field never leaves this function with its value attached.
 */
const CREDENTIAL_JSON_FIELDS =
  /"(value|secret|secret_access_key|access_key_id|token|password)"\s*:\s*"(?:[^"\\]|\\.)*"/gi;

/** Strip anything shaped like a credential out of a raw provider body. */
export function stripCredentialFields(raw: string): string {
  return raw.replace(CREDENTIAL_JSON_FIELDS, (_match, field: string) => `"${field}":"[redacted]"`);
}

/** Provider text for the honest half of a recorded error. Never our prose. */
function describeErrors(envelope: CloudflareEnvelope<unknown>, raw: string): string {
  const messages = (envelope.errors ?? [])
    .map((entry) =>
      [entry.code, entry.message].filter((part) => part !== undefined).join(" "),
    )
    .filter((line) => line.length > 0);
  if (messages.length > 0) return messages.join("; ");
  // Scrubbed before it is truncated: a slice through a token is still a token.
  return stripCredentialFields(raw).slice(0, 200);
}
