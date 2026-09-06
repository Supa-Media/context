import type { MeetingDestination } from "./destination";
import { ERRORS, ROUTES } from "./protocol";
import type {
  IngestAck,
  MeetingSession,
  MeetingSessionSummary,
  SessionList,
  TranscriptSegment,
} from "./protocol";

/**
 * The gateway, as one object the meetings feature can hold.
 *
 * The shape `features/console/files/browser.ts` established: one interface, two
 * implementations — a real one over `fetch` and a deterministic fake — and
 * every screen and controller takes the interface and nothing else. That is
 * what lets the whole capture flow, including a meeting that fails halfway
 * through finalizing, be an ordinary test with no network and no worker.
 *
 * ## The routes are the protocol's, not this file's
 *
 * Every path comes from `ROUTES` in `packages/meetings/src/protocol.js`. There
 * are no string literals for paths here on purpose: three clients and one
 * gateway agree through that file, and a fourth spelling of `/meetings/sessions`
 * in the phone app is how a client and a gateway silently stop agreeing.
 *
 * ## Authentication is an argument, and there is no default
 *
 * `authorization` returns the header value for a request, or `null` when this
 * device has nothing to present. **This is the one seam in the meetings feature
 * that is not settled**, and it is a deliberate hole rather than an oversight:
 * the gateway authenticates MCP clients through per-client OAuth grants
 * (non-negotiable #4), and this app is not one of those clients — it signs in
 * to the *control plane* with `@convex-dev/auth`. Which credential the phone
 * presents to the gateway is a decision for whoever builds the gateway half,
 * and inventing one here would be this screen guessing about somebody else's
 * auth.
 *
 * So `authorization` answering `null` is a first-class state, not an error:
 * `createHttpGateway` refuses to send rather than sending an unauthenticated
 * request, the controller keeps the meeting on the device, and the screen says
 * the meeting has not left the phone. An absent capability is reported, never
 * faked, and never turned into a request that will be refused.
 *
 * ## Why the base URL is not `MCP_ENDPOINT`
 *
 * `MCP_ENDPOINT` is `https://…/mcp` — one route on the gateway, and the one
 * clients connect to. `ROUTES` are siblings of it, so what this takes is the
 * gateway's **origin**, and `gatewayOriginFrom` derives it in one place so a
 * self-hoster who moved their gateway moves both.
 *
 * ## Every call about a meeting is addressed to the meeting's destination
 *
 * A `MeetingDestination` is two halves — a context and a folder — and for a
 * while only the folder did anything. The context was produced by the sheet,
 * drawn on the row, written to the device and re-validated on the way back, and
 * routed nothing: every request went to the bare route, which the gateway
 * resolves to whatever context the credential defaults to. Somebody standing in
 * `@acme/finance` was shown `@acme / finance`, *"Visible to the team"*, and the
 * note was headed for a bucket nobody had named on the screen.
 *
 * So the destination is the **address**, and it is the first argument to every
 * method rather than a trailing option on one of them. Three things follow, and
 * each is the reason it is shaped this way:
 *
 *  - **It is the gateway's own routing, not a new one.** `splitWorkspacePath`
 *    reads an optional `@name` off the front of the path, resolves it through
 *    the control plane, and clamps the session's scopes and visibility tier to
 *    the caller's role in *that* context. A `contextSlug` field in the finalize
 *    body would be a second routing mechanism that neither the tier gate nor
 *    the store factory ever sees — a note written into the connection's own
 *    bucket wearing somebody else's label, which is worse than the defect.
 *  - **It is on all four calls, not just finalize.** The session record lives
 *    in the destination context's own bucket under `.meetings/sessions/`, so a
 *    session upserted into one context and finalized against another finds
 *    nothing to finalize. Routing is per meeting, not per request kind.
 *  - **The folder cannot travel without its context.** Taking one value rather
 *    than two is what makes "the folder said one thing and the context another"
 *    unrepresentable rather than merely absent.
 *
 * `null` is a first-class answer and means the connection's own default
 * context: the list screen's one-tap record genuinely chose nothing, and the
 * gateway's default is the right answer for it.
 *
 * `list()` takes none, deliberately. It answers "what has this connection
 * recorded", which is a question about the connection rather than about any one
 * meeting; a cross-context listing is `context: "@name"`'s job and is not built.
 */

/** Anything the gateway refused or could not do, as data rather than a throw. */
export class MeetingGatewayError extends Error {
  readonly code: string;
  /** The HTTP status, when there was a response at all. */
  readonly status: number | null;

  constructor(code: string, message: string, status: number | null = null) {
    super(message);
    this.name = "MeetingGatewayError";
    this.code = code;
    this.status = status;
  }
}

/**
 * Where the person said this meeting goes, or `null` when nobody was asked.
 *
 * The first argument to every call about a meeting; see the file comment for
 * why it is the address rather than a trailing option on the finalize.
 */
export type MeetingAddress = MeetingDestination | null;

export interface MeetingsGateway {
  /** Upsert the session's metadata. Idempotent on the session id. */
  putSession(to: MeetingAddress, session: MeetingSession): Promise<IngestAck>;
  /** Append transcript segments. Idempotent on each segment id. */
  putSegments(
    to: MeetingAddress,
    sessionId: string,
    segments: readonly TranscriptSegment[],
  ): Promise<IngestAck>;
  /** Replace the human's Markdown. Wholesale, so it is idempotent by construction. */
  putNotes(to: MeetingAddress, sessionId: string, markdown: string): Promise<IngestAck>;
  /**
   * End, enhance, write to the bucket. Returns the note path it wrote, or
   * already wrote.
   *
   * The folder half of `to` rides on *this* call and only this one: it is the
   * request that turns a session into a note, so the request whose answer is a
   * path is the request that carries where the path goes.
   */
  finalize(to: MeetingAddress, sessionId: string): Promise<IngestAck>;
  /**
   * Recent sessions this workspace holds, newest first.
   *
   * Summaries, not sessions: the listing route carries no transcript, and the
   * contract says so — `SessionList` of `MeetingSessionSummary`. Typing this as
   * `MeetingSession[]` claimed a `transcript` field that never arrives.
   */
  list(): Promise<MeetingSessionSummary[]>;
}

export interface HttpGatewayOptions {
  /** The gateway's origin, e.g. `https://mcp.example.org`. */
  origin: string;
  /**
   * The `Authorization` header value for the next request, or `null` when this
   * device has nothing to present. See the file comment: `null` refuses the
   * request rather than sending it bare.
   */
  authorization: () => Promise<string | null>;
  /** Injected so a test drives the wire without a network. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Injected for the same reason. Bounds every request; see below. */
  timeoutMs?: number;
}

/**
 * How long a request may take before it is treated as a transient failure.
 *
 * Bounded for `features/offline`'s reason, one layer out: a request that
 * neither resolves nor rejects leaves a meeting sitting in "syncing" forever
 * with no path to the queue that exists to hold it. Thirty seconds is long
 * enough for a slow uplink to finish a batch of segments and short enough that
 * somebody watching a recording end is not left with a spinner.
 */
export const GATEWAY_TIMEOUT_MS = 30_000;

/**
 * The gateway's origin, from the MCP endpoint the console already shows.
 *
 * `null` when the endpoint is not a URL — a misconfigured self-host — because a
 * guessed origin is a request sent somewhere nobody chose.
 */
export function gatewayOriginFrom(mcpEndpoint: string): string | null {
  try {
    return new URL(mcpEndpoint).origin;
  } catch {
    return null;
  }
}

export function createHttpGateway(options: HttpGatewayOptions): MeetingsGateway {
  const doFetch = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? GATEWAY_TIMEOUT_MS;

  async function send<T>(
    to: MeetingAddress,
    route: string,
    method: "GET" | "POST",
    body?: unknown,
  ): Promise<T> {
    const address = contextRoute(to, route);
    if (address === null) {
      /*
        A destination the gateway's own selector would not read as a context.
        The slug would fall off the front of the path and the request would be
        served by whatever context the credential defaults to — which is a
        meeting written into the wrong tenant, in silence. Refusing is the one
        answer that is not that: `invalid` parks the meeting on the device with
        a sentence beside it, which is what an absent capability looks like
        everywhere else in this feature.

        The value is not in the message. A refusal that echoes what it was sent
        is a reflection, which is `normalizeMeetingFolder`'s rule one field over.
      */
      throw new MeetingGatewayError(
        ERRORS.invalid,
        "This meeting is addressed to a context this app cannot reach, so it is being kept here.",
      );
    }

    const authorization = await options.authorization();
    if (authorization === null) {
      throw new MeetingGatewayError(
        ERRORS.forbidden,
        "This device is not connected to your context yet, so the meeting is being kept here.",
      );
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response: Response;
    try {
      response = await doFetch(`${options.origin}${address}`, {
        method,
        headers: {
          Authorization: authorization,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      // A dropped socket, a captive portal, an abort. All transient, all worth
      // trying again when something says the connection is back.
      throw new MeetingGatewayError(ERRORS.unavailable, messageOf(error));
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) throw await refusal(response);
    return (await response.json()) as T;
  }

  return {
    putSession: (to, session) => send(to, ROUTES.sessions, "POST", session),
    putSegments: (to, sessionId, segments) =>
      send(to, ROUTES.segments(sessionId), "POST", { segments }),
    putNotes: (to, sessionId, markdown) =>
      send(to, ROUTES.notes(sessionId), "POST", { markdown }),
    finalize: (to, sessionId) => send(to, ROUTES.finalize(sessionId), "POST", finalizeBody(to)),
    list: async () => {
      const answer = await send<Partial<SessionList>>(null, ROUTES.sessions, "GET");
      return answer.sessions ?? [];
    },
  };
}

/**
 * A slug the gateway's workspace selector will read as one.
 *
 * `splitWorkspacePath` in `apps/mcp/src/session.js` accepts `[a-z0-9-]{2,32}`
 * and treats anything else as "no slug at all" — the path is then served by the
 * connection's default context. Restated here rather than imported, because the
 * phone does not depend on the worker's source; the point of mirroring it is
 * that a value this pattern refuses is exactly a value that would be *ignored*
 * on the far end, which is the one outcome worth refusing to send.
 */
const ROUTABLE_SLUG = /^[a-z0-9-]{2,32}$/;

/**
 * The path a call about this meeting is sent to, or `null` for "not addressable".
 *
 * `null` in, no prefix out: the connection's own default context, which is what
 * "nobody chose" has always meant. A slug the selector would not read is `null`
 * out, and the caller refuses to send rather than letting the request be served
 * by a context nobody named.
 *
 * The `@` is written even though the selector treats it as cosmetic. It is what
 * a person sees in their MCP client settings, and a name in a URL that reads as
 * a name is the difference between a path segment and a directory.
 */
function contextRoute(to: MeetingAddress, route: string): string | null {
  if (to === null) return route;
  if (!ROUTABLE_SLUG.test(to.contextSlug)) return null;
  return `/@${to.contextSlug}${route}`;
}

/**
 * What a finalize says, which is nothing at all when nobody chose a folder.
 *
 * `{}` is the contract's own "no fields", and it is what a meeting with no
 * destination sends — the gateway's default then stands, which is exactly what
 * has always happened, and what the meetings list's one-tap record wants.
 *
 * `folder` is `FinalizeBody`'s own field: `normalizeMeetingFolder` decides what
 * a legal one is, `meetingNotePath` files into it, and a folder the gateway
 * will not file into falls back to the default with `folderRejected` on the ack
 * rather than losing the meeting. This client reads that flag — see
 * `sync.ts` — because a fallback nobody is told about is the same silent wrong
 * destination one layer down.
 *
 * `notePath` on a session is still only ever the gateway's own `written`
 * answer, never the folder this device asked for, so the screens print where
 * the note *is* rather than where it was sent.
 */
function finalizeBody(to: MeetingAddress): Record<string, string> {
  return to === null ? {} : { folder: to.folder };
}

/**
 * Turn a refusal into one of the protocol's four codes.
 *
 * The body is trusted for its `error` field only when it is one of the codes
 * `ERRORS` names. Anything else — an HTML error page from a proxy, a code from
 * a newer gateway — falls back to the status, and an unrecognised status falls
 * back to `invalid`, which is the code that does *not* retry. That direction is
 * deliberate and is `classifySyncFailure`'s argument seen from the other end:
 * a refusal nobody understands, retried forever against a customer's gateway,
 * is worse than one parked with a sentence beside it.
 */
async function refusal(response: Response): Promise<MeetingGatewayError> {
  const known: ReadonlySet<string> = new Set(Object.values(ERRORS));
  let code: string | null = null;
  let message = "";
  try {
    const body = (await response.json()) as { error?: unknown; message?: unknown };
    if (typeof body.error === "string" && known.has(body.error)) code = body.error;
    if (typeof body.message === "string") message = body.message;
  } catch {
    // No body, or not JSON. The status is all there is.
  }

  if (code === null) code = codeForStatus(response.status);
  if (message === "") message = defaultMessageFor(code);
  return new MeetingGatewayError(code, message, response.status);
}

function codeForStatus(status: number): string {
  if (status === 401 || status === 403) return ERRORS.forbidden;
  if (status === 409 || status === 412) return ERRORS.conflict;
  if (status === 429 || status >= 500) return ERRORS.unavailable;
  return ERRORS.invalid;
}

function defaultMessageFor(code: string): string {
  if (code === ERRORS.forbidden) {
    return "Your context would not accept this meeting from this device.";
  }
  if (code === ERRORS.conflict) return "Something else wrote to that note first.";
  if (code === ERRORS.unavailable) return "Your context could not be reached.";
  return "Your context could not read that meeting.";
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message !== "") return error.message;
  return "The gateway could not be reached.";
}
