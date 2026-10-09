/**
 * The wire between the console's approvals screen and the gateway's
 * `/approvals` route.
 *
 * `apps/mcp/src/http/approvals.js` is the server half, and this is the other
 * half of the same contract. The egress gate there holds a call an AI client
 * made that would let more people see something; the person answers here. Pure,
 * and separate from the hook that drives it, for the same reason as
 * `features/agent/gateway.ts`: what is shown, what is sent and what somebody is
 * told when it fails are each decided in one place a test can reach.
 *
 * ## Fields are named, never spread
 *
 * A record on the server carries more than the screen should show, and the
 * listing carries the arguments that would run. Each field this module keeps is
 * read by name, so a field added to the server's record for some other purpose
 * stays off the screen until somebody decides otherwise in a diff a reviewer
 * reads. `agentGateway.test.ts` proves the same thing for the agent's request.
 *
 * ## A malformed answer is a failure value, never a throw
 *
 * A panel with somebody waiting at it cannot throw. Every read here returns
 * either the value or a sentence, and a body this build cannot read is the same
 * as a refusal: a list the person cannot trust is not shown as one.
 */

/** Approve runs the held call once; deny drops it. Nothing else. */
export type DecisionAction = "approve" | "deny";

/** One held call, as the screen shows it. */
export interface Approval {
  id: string;
  /** One short sentence, written by the gateway: what would happen. */
  summary: string;
  /** The tool that would run, by its name on the gateway. */
  tool: string;
  /** The arguments exactly as the client sent them. Read-only on the screen. */
  args: unknown;
  /** Who would be able to see it, as the gateway words it. `null` when not said. */
  audience: string | null;
  /** The asking client's display name, e.g. "Claude Desktop". `null` when unnamed. */
  client: string | null;
  /** Epoch milliseconds. */
  createdAt: number;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/** What a listing answers with: the held calls, or a sentence for why not. */
export type ListingRead =
  | { kind: "listed"; approvals: Approval[] }
  | { kind: "failed"; sentence: string };

/** What an approve or deny settled as. */
export type Decision =
  | {
      status: "approved";
      summary: string | null;
      /** True only when the gateway said the call ran. Approved is not the same claim. */
      ok: boolean;
      /** The tool's own answer text, or `""` when none was text. */
      result: string;
    }
  | { status: "denied"; summary: string | null };

/**
 * What a decision answers with.
 *
 * `gone` is its own outcome rather than a failure: the held call was already
 * settled, or it expired, and the screen should take it off the list rather
 * than offer the same two buttons again.
 */
export type DecisionRead =
  | { kind: "decided"; decision: Decision }
  | { kind: "gone" }
  | { kind: "failed"; sentence: string };

/**
 * The `/approvals` route, derived from the MCP endpoint the console shows.
 *
 * The origin and nothing else, as `agentEndpoint` does and for the same reason:
 * the grant names the context, so a slug in the path would be a second answer
 * to a question the token has already answered.
 */
export function approvalsEndpoint(mcpEndpoint: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(mcpEndpoint);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  return `${parsed.origin}/approvals`;
}

/** The body one decision sends. Built field by field, never forwarded. */
export function decisionRequest(id: string, action: DecisionAction): { id: string; action: DecisionAction } {
  return { id, action };
}

/**
 * The sentence somebody is shown when the list cannot be read.
 *
 * Names the one outcome they can act on — a connection that expired — and says
 * nothing else about the cause, because the gateway's refusal carries none.
 */
export function listingSentence(status: number): string {
  if (status === 401 || status === 403) {
    return "This app's connection to your context expired. Reload to see what is waiting.";
  }
  return "I could not load what is waiting for your OK. Try again in a moment.";
}

/** The sentence for an approve or deny the gateway refused, or never answered. */
export function decisionSentence(status: number): string {
  if (status === 401 || status === 403) {
    return "This app's connection to your context expired. Reload and try again.";
  }
  if (status === 400) {
    return "That could not be sent. Refresh the list and try again.";
  }
  return "That did not go through. Nothing was approved or denied. Try again in a moment.";
}

/** The sentence for a request that never reached the gateway at all. */
export const UNREACHABLE_SENTENCE = "I could not reach your context. Try again in a moment.";

/** The sentence for an approval that is no longer waiting. */
export const GONE_SENTENCE =
  "That one was already settled, or it expired before you answered. It is off the list.";

function objectOf(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function epochMs(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * One record, field by field. `null` when the record is one this build cannot
 * act on — which fails the whole listing; see `readListing`.
 */
function approvalFrom(raw: unknown): Approval | null {
  const record = objectOf(raw);
  if (record === null) return null;
  const id = nonEmptyString(record.id);
  const summary = typeof record.summary === "string" ? record.summary : null;
  const tool = nonEmptyString(record.tool);
  const createdAt = epochMs(record.created_at);
  const expiresAt = epochMs(record.expires_at);
  if (id === null || summary === null || tool === null || createdAt === null || expiresAt === null) {
    return null;
  }
  return {
    id,
    summary,
    tool,
    args: record.args === undefined ? null : record.args,
    audience: typeof record.audience === "string" ? record.audience : null,
    client: typeof record.client === "string" ? record.client : null,
    createdAt,
    expiresAt,
  };
}

/**
 * Read one `GET /approvals` answer.
 *
 * One unreadable record fails the whole listing rather than being dropped. The
 * tab's count is the number of things waiting, and a held call this build
 * cannot read is still waiting — leaving it out would make the count a lie.
 */
export function readListing(status: number, body: unknown): ListingRead {
  if (status !== 200) return { kind: "failed", sentence: listingSentence(status) };
  const list = objectOf(body)?.approvals;
  if (!Array.isArray(list)) return { kind: "failed", sentence: listingSentence(status) };
  const approvals: Approval[] = [];
  for (const raw of list) {
    const approval = approvalFrom(raw);
    if (approval === null) return { kind: "failed", sentence: listingSentence(200) };
    approvals.push(approval);
  }
  return { kind: "listed", approvals };
}

/**
 * Read one `POST /approvals` answer.
 *
 * `404` is "gone", not a failure: see `DecisionRead`. A `200` must name its
 * status as `approved` or `denied`; anything else is a failure, because an
 * answer that does not say what happened is not evidence that anything did.
 */
export function readDecision(status: number, body: unknown): DecisionRead {
  if (status === 404) return { kind: "gone" };
  if (status !== 200) return { kind: "failed", sentence: decisionSentence(status) };
  const record = objectOf(body);
  const summary = typeof record?.summary === "string" ? record.summary : null;
  if (record?.status === "denied") {
    return { kind: "decided", decision: { status: "denied", summary } };
  }
  if (record?.status === "approved") {
    return {
      kind: "decided",
      decision: {
        status: "approved",
        summary,
        ok: record.ok === true,
        result: typeof record.result === "string" ? record.result : "",
      },
    };
  }
  return { kind: "failed", sentence: decisionSentence(200) };
}
