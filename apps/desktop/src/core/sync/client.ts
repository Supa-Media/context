/**
 * Posting to the gateway, on the contract's routes and nowhere else.
 *
 * Thin on purpose. Every retry decision is the outbox's (`outbox.ts`), every
 * shape is the contract's (`protocol.js`), and this module's whole job is to
 * turn one queued entry into one HTTP request and one `DrainResult`.
 *
 * ## What this file guarantees
 *
 * **The credential goes in a header and appears nowhere else.** Not in the
 * path, not in a query string, not in an error, not in a log. `postEntry`
 * builds its own error objects rather than passing the `fetch` failure through,
 * because a thrown `TypeError` from `fetch` can carry the request URL and a
 * future URL might carry a token.
 *
 * **No note content is logged.** The result carries a code and a short message
 * from the gateway; it never carries the body it sent.
 *
 * **A response we cannot parse is retryable.** A captive portal answering 200
 * with HTML is the single most common "the network is up but not really" on a
 * laptop, and treating its reply as a successful ingest would drop a meeting.
 */

import { ERRORS, ROUTES } from "../contract.ts";
import type { OutboxEntry } from "./outbox.ts";
import type { DrainResult } from "./outbox.ts";
import { isRetryable } from "./outbox.ts";

export interface GatewayConfig {
  /** Origin plus any fixed path, no trailing slash. See `acceptableGatewayUrl`. */
  baseUrl: string;
  /** Read at request time, so a re-connect takes effect without a restart. */
  token: () => Promise<string | null>;
  fetch?: typeof fetch;
  /** Milliseconds before a request is abandoned. A hung socket must not wedge a drain. */
  timeoutMs?: number;
}

/** The route one entry posts to. */
export function routeFor(entry: Pick<OutboxEntry, "kind" | "sessionId">): string {
  switch (entry.kind) {
    case "session":
      return ROUTES.sessions;
    case "segments":
      return ROUTES.segments(entry.sessionId);
    case "notes":
      return ROUTES.notes(entry.sessionId);
    case "finalize":
      return ROUTES.finalize(entry.sessionId);
  }
}

function retryable(code: string, message: string): DrainResult {
  return { ok: false, code, message, retryable: isRetryable(code) };
}

/**
 * Map an HTTP status onto a contract error code for a response that did not
 * carry one. The gateway always sends a code; a proxy, a captive portal and a
 * load balancer do not, and those are exactly the replies a laptop meets.
 */
function codeForStatus(status: number): string {
  if (status === 401 || status === 403) return ERRORS.forbidden;
  if (status === 409 || status === 412) return ERRORS.conflict;
  if (status === 400 || status === 422) return ERRORS.invalid;
  return ERRORS.unavailable;
}

export async function postEntry(config: GatewayConfig, entry: OutboxEntry): Promise<DrainResult> {
  const token = await config.token();
  if (token === null) {
    // Not a rejection: this machine is simply not connected yet. The meeting
    // waits in the queue until somebody connects it, which is the whole point
    // of the queue.
    return retryable(ERRORS.unavailable, "this machine is not connected to a context yet");
  }

  const doFetch = config.fetch ?? globalThis.fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs ?? 20_000);

  try {
    const response = await doFetch(`${config.baseUrl}${routeFor(entry)}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(entry.body),
      signal: controller.signal,
    });

    if (response.ok) {
      // A 2xx that is not JSON is a proxy, not the gateway. Retryable, and
      // never counted as an ingest.
      try {
        await response.clone().json();
      } catch {
        return retryable(ERRORS.unavailable, "the reply was not from a gateway");
      }
      return { ok: true };
    }

    let code = codeForStatus(response.status);
    let message = `gateway answered ${response.status}`;
    try {
      const body = (await response.json()) as { error?: unknown; message?: unknown };
      if (typeof body.error === "string" && body.error !== "") code = body.error;
      if (typeof body.message === "string" && body.message !== "") message = body.message;
    } catch {
      // Keep the status-derived code. An unparseable error body is common and
      // is not itself a reason to park a meeting.
    }
    return { ok: false, code, message, retryable: isRetryable(code) };
  } catch (error) {
    // Deliberately not `String(error)`: a fetch failure's message can contain
    // the request URL, and this string is written to a log file.
    const aborted = error instanceof Error && error.name === "AbortError";
    return retryable(ERRORS.unavailable, aborted ? "the request timed out" : "the network is unreachable");
  } finally {
    clearTimeout(timeout);
  }
}
