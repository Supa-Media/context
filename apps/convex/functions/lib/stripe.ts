/**
 * Stripe's wire format, as much of it as this control plane needs.
 *
 * No SDK. The gateway's rule — Web Crypto and `fetch`, no dependencies — is
 * the gateway's, but the same reasoning applies to a control plane that has to
 * be readable by somebody auditing what it does with a payment key: three form
 * fields, one HMAC and a handful of field reads is less code than the wrapper
 * around it would be, and every line of it is visible here.
 *
 * ## The signature check is the whole security of the webhook
 *
 * The endpoint is public by construction — Stripe has to be able to POST to it
 * from an address we do not control, with no bearer token. So the *only* thing
 * standing between a stranger and a free upgrade is that the body carries an
 * HMAC computed with a secret only Stripe and this deployment hold. An
 * unsigned webhook that sets an entitlement is not a bug in a feature; it is
 * the feature working for everybody on the internet.
 *
 * Four properties, each of which has been the published cause of somebody
 * else's incident:
 *
 *  1. **The signed payload is the raw body**, byte for byte, before any JSON
 *     parse. Re-serialising the parsed object and hashing that verifies a
 *     different document from the one Stripe signed.
 *  2. **The timestamp is inside the MAC and is also checked against the
 *     clock.** `t` is prepended to the payload before hashing, so it cannot be
 *     edited without breaking the signature — and it is compared to now, so a
 *     valid old delivery cannot be replayed forever.
 *  3. **Every `v1` scheme in the header is tried.** Stripe sends more than one
 *     during a signing-secret rotation, and a verifier that reads only the
 *     first fails every request for the length of the rotation.
 *  4. **The comparison is constant-time**, over digests of equal length.
 *
 * `v0` signatures — the ones on Stripe's *thin* event payloads — are
 * deliberately not accepted: this endpoint receives snapshot events, and
 * quietly widening the accepted scheme set is how a verifier ends up
 * validating something it does not understand.
 */

/**
 * The header Stripe signs with, e.g.
 * `t=1614556800,v1=5257a8…,v1=b71b3f…`.
 */
export const STRIPE_SIGNATURE_HEADER = "Stripe-Signature";

/**
 * How far out of date a delivery may be. Stripe's own libraries default to
 * five minutes, and a replay window is only as good as its smallest sensible
 * value: long enough for a slow retry, short enough that a captured request is
 * not a standing key.
 */
export const SIGNATURE_TOLERANCE_MS = 5 * 60 * 1000;

export interface StripeSignatureHeader {
  /** Seconds since the epoch, as Stripe sends it. */
  timestamp: number;
  /** Every `v1` digest in the header, in order. */
  signatures: string[];
}

/**
 * Read `t` and the `v1` digests out of the header.
 *
 * Returns `null` for anything that is not that shape — a missing header, a
 * missing `t`, a `t` that is not a number, no `v1` at all. One answer for
 * every malformed input: a caller cannot act on the difference and a prober
 * should not learn it.
 */
export function parseStripeSignatureHeader(
  raw: string | null | undefined,
): StripeSignatureHeader | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of raw.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t") {
      // Not `Number(value)`: that reads "" as 0, " 12 " as 12 and "0x10" as
      // 16, so a header with an empty timestamp would verify against epoch.
      if (!/^\d{1,15}$/.test(value)) return null;
      timestamp = Number.parseInt(value, 10);
    } else if (key === "v1") {
      if (/^[0-9a-f]+$/i.test(value)) signatures.push(value.toLowerCase());
    }
  }
  if (timestamp === null || signatures.length === 0) return null;
  return { timestamp, signatures };
}

/** Hex of an HMAC-SHA256, lowercase. */
async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return [...new Uint8Array(mac)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Compare two hex digests without leaking where they first differ.
 *
 * A length mismatch is answered before the loop and is not itself a leak here:
 * both operands are SHA-256 digests in hex, so the length is a constant of the
 * algorithm rather than a property of the secret. `gatewayAuth.ts` keeps its
 * own copy of this for bearer secrets, where the reasoning about length is
 * different; sharing one function across two arguments would mean one of them
 * is documented wrong.
 */
function constantTimeEqualsHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) {
    difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * Is this body really from Stripe?
 *
 * Boolean and nothing else — no reason, no partial credit, and no distinction
 * between a missing header, a stale timestamp and a wrong digest, for the same
 * reason `requestCarriesSecret` gives.
 *
 * A deployment with no signing secret configured verifies **nothing**: every
 * delivery is refused. That direction is not negotiable. The other one — treat
 * "unconfigured" as "allow" so the flow works before somebody finishes
 * setting it up — is a free upgrade for anybody who can find the URL, and it
 * is exactly the shape of mistake that ships because it makes a staging
 * environment work.
 */
export async function stripeSignatureIsValid(input: {
  /** The request body, exactly as received. Never a re-serialised object. */
  payload: string;
  /** The `Stripe-Signature` header. */
  header: string | null | undefined;
  /** The endpoint's signing secret, or `undefined` on a deployment with none. */
  secret: string | undefined;
  /** `Date.now()`, injectable so a test can describe a stale delivery. */
  nowMs?: number;
  toleranceMs?: number;
}): Promise<boolean> {
  const { payload, header, secret } = input;
  if (typeof secret !== "string" || secret.length === 0) return false;

  const parsed = parseStripeSignatureHeader(header);
  if (parsed === null) return false;

  const nowMs = input.nowMs ?? Date.now();
  const toleranceMs = input.toleranceMs ?? SIGNATURE_TOLERANCE_MS;
  // Absolute, so a delivery stamped in the future is refused too. A one-sided
  // check accepts a timestamp of year 3000 forever.
  if (Math.abs(nowMs - parsed.timestamp * 1000) > toleranceMs) return false;

  const expected = await hmacSha256Hex(secret, `${parsed.timestamp}.${payload}`);
  // Every candidate is compared even after one matches: `.some` with an
  // early exit would make the number of comparisons depend on which digest
  // was right, and this loop costs nothing.
  let matched = false;
  for (const candidate of parsed.signatures) {
    if (constantTimeEqualsHex(candidate, expected)) matched = true;
  }
  return matched;
}

/**
 * The fields this control plane reads off a Stripe event.
 *
 * Deliberately tiny. An event object is large, arrives from outside, and is
 * mostly about things we do not model; every field named here is one somebody
 * had to decide to trust.
 */
export interface StripeEventFacts {
  /** `evt_…`, for idempotency. */
  id: string;
  type: string;
  /** Stripe's `created`, in seconds. Used to refuse an out-of-order apply. */
  createdSeconds: number;
  /** `cus_…`, where the event carries one. */
  customerId?: string;
  /** `sub_…`, where the event carries one. */
  subscriptionId?: string;
  /**
   * The checkout attempt this event answers — **our** row id, echoed back
   * through `client_reference_id`.
   *
   * The workspace is then read off that row rather than out of the event.
   * Same shape as the gateway's `expectedWorkspaceId`, and the same reason:
   * an identifier that arrives from outside may veto, and may never select.
   */
  checkoutRef?: string;
  /**
   * Stripe's **subscription** status word, unmapped, and present only on a
   * subscription event.
   *
   * Deliberately not filled in from a checkout session's own `status`, which
   * is a different vocabulary about a different object — `complete`, `open`,
   * `expired` — and reading one as the other is how a paid checkout gets
   * mapped to a status this build has never heard of. That was written the
   * wrong way round first and `billing.test.ts` caught it.
   */
  rawStatus?: string;
  /** A checkout session's own `status` and `payment_status`. */
  sessionStatus?: string;
  paymentStatus?: string;
  /** Seconds; the end of the period already paid for. */
  currentPeriodEndSeconds?: number;
  /** True where Stripe says the subscription stops at the period end. */
  cancelAtPeriodEnd?: boolean;
}

function stringAt(source: unknown, ...path: string[]): string | undefined {
  let cursor: unknown = source;
  for (const key of path) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === "string" && cursor.length > 0 ? cursor : undefined;
}

function numberAt(source: unknown, ...path: string[]): number | undefined {
  let cursor: unknown = source;
  for (const key of path) {
    if (typeof cursor !== "object" || cursor === null) return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return typeof cursor === "number" && Number.isFinite(cursor) ? cursor : undefined;
}

/**
 * The event types this control plane acts on, and nothing else.
 *
 * An allow-list rather than a switch with a default: a Stripe account emits
 * dozens of types, several of which carry a `subscription` and a `status`
 * field that would read plausibly here — `invoice.payment_failed` among them —
 * and acting on a type nobody chose is how a plan ends up being set by an
 * event about somebody's receipt.
 */
export const HANDLED_EVENT_TYPES = [
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
] as const;

export type HandledEventType = (typeof HANDLED_EVENT_TYPES)[number];

export function isHandledEventType(type: string): type is HandledEventType {
  return (HANDLED_EVENT_TYPES as readonly string[]).includes(type);
}

/**
 * Pull the handful of fields above out of a parsed event body.
 *
 * Returns `null` when the body is not an event at all — no id, no type, no
 * `created`. Everything past that is optional by design: this reads a document
 * written by somebody else's API version, and a missing field must produce a
 * narrower update rather than an exception in an HTTP route.
 *
 * `subscription` on a checkout session is a string when the response is not
 * expanded and an object when it is, so both are read. Same for `customer`.
 */
export function stripeEventFacts(body: unknown): StripeEventFacts | null {
  if (typeof body !== "object" || body === null) return null;
  const id = stringAt(body, "id");
  const type = stringAt(body, "type");
  const createdSeconds = numberAt(body, "created");
  if (id === undefined || type === undefined || createdSeconds === undefined) {
    return null;
  }

  const object = (body as { data?: { object?: unknown } }).data?.object;
  const isSubscriptionEvent = type.startsWith("customer.subscription.");

  const customerId =
    stringAt(object, "customer") ?? stringAt(object, "customer", "id");
  const subscriptionId =
    // On a subscription event the object *is* the subscription.
    (isSubscriptionEvent ? stringAt(object, "id") : undefined) ??
    stringAt(object, "subscription") ??
    stringAt(object, "subscription", "id");

  return {
    id,
    type,
    createdSeconds,
    customerId,
    subscriptionId,
    checkoutRef: stringAt(object, "client_reference_id"),
    rawStatus: isSubscriptionEvent ? stringAt(object, "status") : undefined,
    sessionStatus: isSubscriptionEvent ? undefined : stringAt(object, "status"),
    paymentStatus: isSubscriptionEvent
      ? undefined
      : stringAt(object, "payment_status"),
    currentPeriodEndSeconds: numberAt(object, "current_period_end"),
    cancelAtPeriodEnd:
      typeof (object as { cancel_at_period_end?: unknown } | undefined)
        ?.cancel_at_period_end === "boolean"
        ? (object as { cancel_at_period_end: boolean }).cancel_at_period_end
        : undefined,
  };
}

/**
 * `application/x-www-form-urlencoded`, which is the only body format Stripe's
 * REST API accepts. Nested keys use the `a[b]` spelling Stripe documents.
 */
export function formEncode(params: Record<string, string | number | boolean>): string {
  return Object.entries(params)
    .map(
      ([key, value]) =>
        `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`,
    )
    .join("&");
}

export const STRIPE_API_BASE = "https://api.stripe.com/v1";

/**
 * The Stripe API version this code was written against.
 *
 * Pinned on every request rather than inherited from whatever the account's
 * dashboard is set to, because an account-level version bump would otherwise
 * change the shape of the objects this file reads without a deploy.
 */
export const STRIPE_API_VERSION = "2024-06-20";

export class StripeApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "StripeApiError";
    this.status = status;
  }
}

/**
 * One POST to Stripe.
 *
 * The key goes in the `Authorization` header and nowhere else — never a query
 * string, never a log line. The error path deliberately does **not** carry
 * Stripe's own message forward to a caller: a provider message can name an
 * account or an object id, and `functions/billing.ts` answers with our own
 * sentence. The status is kept because "declined" and "we are misconfigured"
 * need different operator responses.
 */
/**
 * One DELETE to Stripe. Cancelling a subscription, and nothing else so far.
 *
 * Same rules as `stripePost`: the key rides in the header, and Stripe's own
 * message is never forwarded to a caller — the status is kept because
 * "already cancelled" and "we are misconfigured" need different responses from
 * an operator.
 */
export async function stripeDelete(
  apiKey: string,
  path: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${STRIPE_API_BASE}${path}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Stripe-Version": STRIPE_API_VERSION,
    },
  });
  const text = await response.text();
  if (!response.ok) {
    throw new StripeApiError(response.status, "Stripe refused the request.");
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new StripeApiError(response.status, "Stripe returned something unreadable.");
  }
}

export async function stripePost(
  apiKey: string,
  path: string,
  params: Record<string, string | number | boolean>,
): Promise<Record<string, unknown>> {
  const response = await fetch(`${STRIPE_API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/x-www-form-urlencoded",
      "Stripe-Version": STRIPE_API_VERSION,
    },
    body: formEncode(params),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new StripeApiError(response.status, `Stripe refused the request.`);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new StripeApiError(response.status, "Stripe returned something unreadable.");
  }
}
