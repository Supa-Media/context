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
import { UNROUTABLE, isRetryable, routableContext } from "./outbox.ts";

export interface GatewayConfig {
  /** Origin plus any fixed path, no trailing slash. See `acceptableGatewayUrl`. */
  baseUrl: string;
  /** Read at request time, so a re-connect takes effect without a restart. */
  token: () => Promise<string | null>;
  fetch?: typeof fetch;
  /** Milliseconds before a request is abandoned. A hung socket must not wedge a drain. */
  timeoutMs?: number;
}

/**
 * The full path one entry posts to, or `null` when it is not addressable.
 *
 * `null` is a refusal rather than a fallback, and that direction is the whole
 * point: an `@name` the gateway's selector will not read falls off the front of
 * the path and the request is served by whatever context the credential
 * defaults to — a meeting written into the wrong tenant, in silence. Refusing
 * parks the entry with a sentence instead, which is what an absent capability
 * looks like everywhere else in this app.
 *
 * The `@` is written even though the selector treats it as cosmetic: it is what
 * a person sees in their MCP client settings, and a name in a URL that reads as
 * a name is the difference between a path segment and a directory.
 */
export function contextRouteFor(entry: Pick<OutboxEntry, "kind" | "sessionId" | "context">): string | null {
  const route = routeFor(entry);
  const slug = routableContext(entry.context);
  if (slug === UNROUTABLE) return null;
  return slug === null ? route : `/@${slug}${route}`;
}

/** The route one entry posts to, before the context is put on the front. */
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
  const address = contextRouteFor(entry);
  if (address === null) {
    /*
      Not retryable, because it will read the same way on every attempt, and a
      refusal retried forever against somebody's gateway is what parking exists
      to stop. The message does not echo the slug back: a refusal that repeats
      what it was sent is a reflection, and this string is written to a log.
    */
    return {
      ok: false,
      code: ERRORS.invalid,
      message: "this meeting is addressed to a context this machine cannot reach",
      retryable: false,
    };
  }

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
    const response = await doFetch(`${config.baseUrl}${address}`, {
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
      let ack: { notePath?: unknown };
      try {
        ack = (await response.clone().json()) as { notePath?: unknown };
      } catch {
        return retryable(ERRORS.unavailable, "the reply was not from a gateway");
      }
      /*
        The note's path, when the gateway answered with one.

        Read off the ack rather than composed here — where a note lands is the
        gateway's decision, including the folder fallback it applies when the
        one it was asked for is refused, so a path this client guessed would be
        the wrong one exactly when it mattered. Carried only for a finalize
        because that is the only kind whose answer contains one.
      */
      return {
        ok: true,
        notePath: typeof ack?.notePath === "string" && ack.notePath !== "" ? ack.notePath : null,
      };
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
