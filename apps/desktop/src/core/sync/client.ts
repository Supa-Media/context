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
import { MEETING_TIER_REFUSAL, grantCoversMeetings } from "./connection.ts";

export interface GatewayConfig {
  /** Origin plus any fixed path, no trailing slash. See `acceptableGatewayUrl`. */
  baseUrl: string;
  /** Read at request time, so a re-connect takes effect without a restart. */
  token: () => Promise<string | null>;
  /**
   * What the grant this machine holds actually carries. Read per request, for
   * the same reason `token` is: a re-connect must take effect without one.
   *
   * **Required rather than optional**, because an optional guard is one a later
   * caller drops by forgetting it, and what it stops is a person's meeting
   * notes being published to everybody they have ever shared a folder with. A
   * caller with nothing to say answers `null`, which is refused rather than
   * waved through.
   */
  scope: () => string | null;
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

  /*
    The grant is read as well as spent, and a meeting is not sent on one that
    cannot file it privately.

    `DESKTOP_SCOPE` asks for `context:private` because the tier decides what a
    meeting is *filed as*, and the person approving may hand over less. Sending
    anyway is the failure this check exists for: the gateway would accept the
    write and publish the note team-visible — readable by everybody the owner
    has shared that folder with, and recorded as such in their own `privacy.md`
    — or refuse it with a sentence about a destination, which is a true fact
    about the wrong thing. So the entry is refused before a request is built,
    and the meeting is held rather than degraded.

    **Held, deliberately, and not parked.** Everything about this reads like a
    park — it is a refusal retrying cannot fix, which is the sentence `park`
    exists for — and parking it would be wrong for one reason: nothing in this
    app un-parks. A parked entry stays parked (`applyDrain`, and the comment
    above `mergeEntry` saying so), so parking here would mean a person who
    reconnects at the tier they meant still never sees the meetings that were
    recorded before they noticed. The condition is not a rejected write; it is
    a machine connected at the wrong tier, in the same family as "not connected
    yet" one branch above — and that one waits, too. It costs nothing to wait:
    this refusal never reaches the network, so a retry is one local comparison
    a minute, and the queue drains itself the moment the grant is right.

    The reason is visible either way, which is the part that must not be lost:
    `lastError` carries this sentence to the outbox status the tray and the
    console both read, and `uiState` puts it on the "This machine" card for as
    long as the grant is short.
  */
  if (!grantCoversMeetings(config.scope())) {
    // `unavailable` rather than `forbidden`, so the code and the retryability
    // agree: `isRetryable` reads `forbidden` as final, and a result whose flag
    // disagreed with its own code is the next reader's bug.
    return retryable(ERRORS.unavailable, MEETING_TIER_REFUSAL);
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
    let described = "";
    try {
      const body = (await response.json()) as {
        error?: unknown;
        error_description?: unknown;
        message?: unknown;
      };
      if (typeof body.error === "string" && body.error !== "") code = body.error;
      /*
        `error_description` FIRST, BECAUSE IT IS THE FIELD THIS GATEWAY ACTUALLY
        SENDS.

        `refusal()` in `apps/mcp/src/meetings/ingest.js` answers
        `{error, error_description}` and never `message`, so every refusal this
        app has ever logged read `gateway answered 400` and nothing else — the
        sentence explaining *why* was on the wire, parsed, and thrown away one
        line from where it was needed. An evening of meetings was diagnosed by
        reading a JSON file off somebody's disk because of this line.

        `message` is still read, second, for a proxy or a future route that
        speaks that spelling instead.
      */
      if (typeof body.error_description === "string" && body.error_description !== "") {
        described = body.error_description;
      } else if (typeof body.message === "string" && body.message !== "") {
        described = body.message;
      }
    } catch {
      // Keep the status-derived code. An unparseable error body is common and
      // is not itself a reason to park a meeting.
    }
    /*
      The status stays in the sentence even when the gateway explained itself.
      "400" alone was useless; the description alone would lose the one fact
      that tells a captive portal's HTML from a refusal this gateway composed.
    */
    const message = described === "" ? `gateway answered ${response.status}` : `${response.status}: ${described}`;
    return { ok: false, status: response.status, code, message, retryable: isRetryable(code) };
  } catch (error) {
    // Deliberately not `String(error)`: a fetch failure's message can contain
    // the request URL, and this string is written to a log file.
    const aborted = error instanceof Error && error.name === "AbortError";
    return retryable(ERRORS.unavailable, aborted ? "the request timed out" : "the network is unreachable");
  } finally {
    clearTimeout(timeout);
  }
}
