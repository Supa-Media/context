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

export interface MeetingsGateway {
  /** Upsert the session's metadata. Idempotent on the session id. */
  putSession(session: MeetingSession): Promise<IngestAck>;
  /** Append transcript segments. Idempotent on each segment id. */
  putSegments(sessionId: string, segments: readonly TranscriptSegment[]): Promise<IngestAck>;
  /** Replace the human's Markdown. Wholesale, so it is idempotent by construction. */
  putNotes(sessionId: string, markdown: string): Promise<IngestAck>;
  /**
   * End, enhance, write to the bucket. Returns the note path it wrote, or
   * already wrote.
   *
   * `destination` is where the person said the note should go, or `null` when
   * nobody was asked — see `MeetingRecord.destination`. It rides on *this* call
   * because this is the one that turns a session into a note: the request whose
   * answer is a path is the request that should carry where the path goes.
   */
  finalize(sessionId: string, destination: MeetingDestination | null): Promise<IngestAck>;
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

  async function send<T>(route: string, method: "GET" | "POST", body?: unknown): Promise<T> {
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
      response = await doFetch(`${options.origin}${route}`, {
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
    putSession: (session) => send(ROUTES.sessions, "POST", session),
    putSegments: (sessionId, segments) =>
      send(ROUTES.segments(sessionId), "POST", { segments }),
    putNotes: (sessionId, markdown) => send(ROUTES.notes(sessionId), "POST", { markdown }),
    finalize: (sessionId, destination) =>
      send(ROUTES.finalize(sessionId), "POST", finalizeBody(destination)),
    list: async () => {
      const answer = await send<Partial<SessionList>>(ROUTES.sessions, "GET");
      return answer.sessions ?? [];
    },
  };
}

/**
 * What a finalize says, which is nothing at all when nobody chose a folder.
 *
 * `{}` is the contract's own "no fields", and it is what a meeting with no
 * destination sends — the gateway's default then stands, which is exactly what
 * has always happened.
 *
 * ## `folder` is ahead of the contract, and this is the note saying so
 *
 * `FinalizeBody` in `packages/meetings/src/protocol.js` does not name it, and
 * the gateway's `foldMetadata` reads a fixed list of fields, so a deployed
 * gateway **reads this and does nothing with it**: it is not an error, it is
 * not stored, and `meetingNotePath` still derives `0-inbox/meetings/YYYY/MM/…`
 * from the session alone. Sending it is therefore inert rather than wrong, and
 * this client never claims otherwise — `notePath` on a session comes from the
 * gateway's own `written` answer and is never the folder this device asked for,
 * so the screens print where the note *is*, not where it was sent.
 *
 * Making the ask real is three edits upstream, in one change:
 * `FinalizeBody` gains `folder`; `meetingNotePath` takes it instead of the
 * hard-coded `MEETINGS_FOLDER`; and `finalizeSession` passes the body's value
 * through. That is `packages/meetings` and `apps/mcp`, which is why it is named
 * here rather than done here — CLAUDE.md's rule is that the contract is not
 * edited from inside this app.
 */
function finalizeBody(destination: MeetingDestination | null): Record<string, string> {
  return destination === null ? {} : { folder: destination.folder };
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
