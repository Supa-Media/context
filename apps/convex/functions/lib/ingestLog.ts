/**
 * Operator-only logging for the inbound-mail path.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 *
 * Every refusal on the ingest routes is the same `{"ingestion":null}`, and the
 * Worker turns every refusal of its own into one frozen SMTP string. That is
 * correct and must not change: `<name>@context.lc` is an address anyone on the
 * internet can send to, so a distinguishable answer is a username-enumeration
 * oracle drivable from any mail client.
 *
 * The cost of that, paid in full once already: when ingestion resolved to
 * nothing in production there was no way to learn *which* of the nine refusals
 * had fired, on either side of the wire. Cloudflare's Email Routing activity log
 * said "worker script threw an exception"; the control plane said nothing at
 * all, because a route that answers 401 and a route that answers `null` both
 * complete successfully and write no line anywhere. Hours went into
 * reconstructing from the outside a fact the deployment already knew.
 *
 * So the reason is recorded **here**, on the side that can safely record it —
 * `infra/email-worker/src/controlPlane.ts` says exactly this in as many words:
 * "The cost is a log line we deliberately give up: the control plane is the side
 * that can safely record it."
 *
 * ============================================================================
 * WHY THIS IS NOT THE ORACLE AGAIN
 * ============================================================================
 *
 * The oracle is a *response* a stranger can read. This is a line in the
 * deployment's own logs, which only an operator of this deployment can read —
 * the same place `auth:store` and every other Convex `console.log` already
 * lands. Nothing here is returned, and nothing here reaches a header, a status,
 * or a body. `__tests__/ingestionGateway.test.ts` pins that: the responses stay
 * byte-identical across refusals that now log different reasons.
 *
 * ============================================================================
 * THE FIELD SET IS CLOSED, AND SO IS THE CHARSET
 * ============================================================================
 *
 * Three fields, deliberately, in the same spirit as `LogFields` in the Worker:
 * "just add the envelope-from while debugging" should be a type error rather
 * than a stranger's address in a log aggregator. Absent, and required to stay
 * absent: the sender, the subject, the ticket (in either form), the worker
 * secret, and any workspace or user id.
 *
 * `name` is the one attacker-influenced value, and callers may only pass it
 * **after `validateName` has accepted it** — so anything that reaches a log is
 * `[a-z0-9-]{2,32}`, which cannot carry a newline, a quote, or a control
 * character into a log line. A name that failed validation is described by its
 * rejection code and never echoed.
 */

/** The rejection codes `validateName` produces, as they appear in a reason. */
export type IngestLogFields = {
  /** What happened. A short, stable, code-shaped string. */
  event:
    | "resolve_ok"
    | "resolve_refused"
    | "unauthorized"
    | "bad_request";
  /**
   * Why, for a refusal. Stable codes an operator can grep for and a runbook can
   * name. Never free text, never derived from the message.
   */
  reason?: string;
  /**
   * The recipient name — a personal-context path. Only ever passed for a name
   * `validateName` has already accepted. See the charset note above.
   */
  name?: string;
};

/**
 * The only logging call site for the ingest routes.
 *
 * One line of JSON, tagged so it can be filtered out of a deployment's log
 * stream without knowing which function emitted it.
 */
export function logIngest(fields: IngestLogFields): void {
  console.log(JSON.stringify({ controlPlane: "ingest", ...fields }));
}
