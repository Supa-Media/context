/**
 * The ingestion control-plane client — this Worker's only door to Convex.
 *
 * Transport is the gateway's, unchanged (see `apps/mcp/src/controlPlane.js`):
 *
 *   POST `${CONTROL_PLANE_URL}${path}`
 *   Authorization: Bearer ${EMAIL_WORKER_SECRET}
 *   Content-Type: application/json
 *   Accept: application/json
 *   body: JSON object
 *
 * Every response is a 200 with a JSON object or a refusal. A `null` payload
 * means "nothing matched" and never distinguishes *why*.
 *
 * ============================================================================
 * THE ROUTE'S DOMAIN IS USERNAMES. THAT IS THE WHOLE SECURITY ARGUMENT.
 * ============================================================================
 *
 * A username **is** a personal context: exactly one per person, forever, and
 * the username is that context's path (`@seyi` is both "the user seyi" and
 * "seyi's context"). Everything else in the product is either somebody else's
 * personal context or a shared context, and **neither has an ingestion address
 * at all** — not a configurable one, not a disabled one. Mail reaches a shared
 * context only when a person or an agent moves an already-captured note there.
 *
 * So `resolve` takes a `username` and answers with that user's personal
 * context. It is not "resolve a workspace, and check it is personal".
 *
 * Three things carry that, and it is worth being exact about which is which,
 * because "by construction" and "by a check we wrote" are very different
 * claims. **(1) and (2) are properties of the request shape and the schema —
 * they hold whatever any code does. (3) is a requirement on the control plane
 * that this Worker cannot verify from here**, which is why
 * `assertPersonalContext` exists below and why the preconditions are spelled
 * out rather than assumed.
 *
 * 1. **No field in any request names a context.** `resolve` carries a username
 *    and two rate-limiting values; `binding` and `record` carry a ticket the
 *    control plane minted. There is no parameter — not an id, not a slug, not
 *    a path — that a caller could set to select a row. A leaked
 *    `EMAIL_WORKER_SECRET` therefore has no vocabulary for "give me the shared
 *    context `acme-board`"; the request shape does not contain the question.
 *
 * 2. **Usernames and shared-context slugs are one exclusive namespace.**
 *    CLAUDE.md's rule, and the `names` table implements it: one row per name,
 *    unique on `by_name`, carrying a discriminator — `kind: "user"` with a
 *    `userId`, or `kind: "workspace"` with a `workspaceId`. A name is one or
 *    the other, never both. So the local part in `<name>@context.lc` selects at
 *    most one row, and if that row is a `user` row it is a person.
 *
 * 3. **The resolver must admit only a personal context, and must establish that
 *    structurally.** The name selects at most one row; whether that row may
 *    receive mail is a second question, and the answer has to be more than a
 *    label.
 *
 *    `apps/convex/functions/lib/ingestionStore.ts`'s
 *    `resolvePersonalContextForIngestion` is the single implementation, and it
 *    requires **both** `workspaces.kind === "personal"` **and** that the
 *    context has exactly one member who is its owner. The second is the
 *    stricter half, and it is what makes this structural rather than
 *    descriptive: `schema.ts` defines a personal context as "a workspace with
 *    a single `owner` member", so a context that has since been shared with
 *    three people stops receiving mail whatever its `kind` field says.
 *
 *    ── What this is NOT, and why ──
 *
 *    An earlier draft of this file specified resolution through
 *    `names.by_name(...).userId` — the `kind: "user"` arm of the discriminator
 *    — and forbade any fallback to `workspaceId`, on the grounds that routing
 *    through an identity beats routing through a label.
 *
 *    That is the better design and it is not the one that shipped, because its
 *    precondition is false: **nothing in `apps/convex` has ever written a
 *    `kind: "user"` row.** `claimName` supports the arm, but its only
 *    production caller is `createWorkspace`, which always passes
 *    `kind: "workspace"`. A resolver following the user arm today would resolve
 *    nothing at all — fail-closed, but for the wrong reason, and shipping a
 *    route that cannot work is not a security property.
 *
 *    What a person actually has is a personal context whose slug is their
 *    handle, which is exactly what CLAUDE.md means by usernames and workspace
 *    slugs sharing one namespace, and it is how `resolveInviteeUser` in
 *    `functions/invitations.ts` has always resolved a handle to a person.
 *
 *    If signup ever claims the `kind: "user"` arm, that one function is where
 *    it belongs — and the argument gets stronger without anything here
 *    changing.
 *
 * A name that belongs to a shared context produces the same
 * `{ "ingestion": null }` as a name nobody has ever claimed. That is required,
 * not incidental: a refusal that differed would tell any stranger with a mail
 * client which names on this domain are teams.
 * `apps/convex/__tests__/ingestionGateway.test.ts` asserts the two refusals are
 * byte-identical, over status, headers and body.
 *
 * ============================================================================
 * THIS CONTRACT RELAXES THE TWO-PROOF RULE — DELIBERATELY
 * ============================================================================
 *
 * `apps/convex/http.ts`'s nine gateway routes are all `gatewayRoute`, and the
 * two that can resolve a context or yield a credential both require **an
 * end-user OAuth access token** as their second proof. That is the durable
 * decision recorded in CLAUDE.md: the gateway secret alone opens nothing, and
 * the gateway never gets to name the context it wants.
 *
 * **An inbound email has no user token.** Nobody is present, nothing was
 * authorized just now, and the only identifier in hand is a local part a
 * stranger typed. So the two-proof shape cannot be reproduced here, and this
 * contract is a genuine relaxation of it. What follows is the narrowest shape
 * found that keeps as much of the property as email allows — and it is now
 * implemented, in `apps/convex/functions/ingestionGateway.ts` and the three
 * routes at the bottom of `apps/convex/http.ts`:
 *
 * 1. **Its own secret.** `EMAIL_WORKER_SECRET`, not `GATEWAY_SECRET`. The
 *    gateway secret is documented as held by exactly two parties and buys
 *    nothing on its own; keeping this separate means a compromised email worker
 *    cannot become a compromised MCP gateway, and means the blast radius of
 *    each is nameable.
 *
 * 2. **Resolution never returns a credential.** `/gateway/ingest/resolve`
 *    answers with a policy and an opaque `ticket` — no context id, no bucket,
 *    no key. A message that is going to be refused for size, authentication, or
 *    sender policy is refused *before* any credential is decrypted, so most
 *    abusive traffic never causes a decrypt at all.
 *
 * 3. **The credential call cannot name a context.** `/gateway/ingest/binding`
 *    takes only the ticket the control plane just minted. This preserves the
 *    important half of the gateway's rule — the caller does not get to pick the
 *    tenant, it can only present something the control plane issued. The ticket
 *    MUST be single-use, MUST expire in minutes, and MUST be bound to the
 *    personal context the username resolved to at mint time.
 *
 * 4. **The residual risk, stated plainly.** A leaked `EMAIL_WORKER_SECRET`
 *    lets its holder ask "does this username accept mail?" and, for a person
 *    whose own policy admits them, obtain that one person's personal-context
 *    storage credential. That is a user-existence oracle and a per-person
 *    credential path that the MCP contract does not have. It is bounded by:
 *    one personal context per call, **no shared context ever** (point 1 above),
 *    ingestion-enabled users only, and whatever rate limit the control plane
 *    applies. It is not bounded by "a real person authorized this just now",
 *    because for inbound mail no such person exists.
 *
 *    What the personal-only model buys here is real and worth naming: the
 *    reachable set is contexts with exactly one accountable owner who turned
 *    ingestion on for themselves. It is not everything — the oracle survives,
 *    and so does the fact that a stolen secret opens *some* storage without a
 *    human in the loop.
 *
 *    Mitigations on the control-plane side, and where each of them now lives:
 *
 *      - **Rate-limit `resolve`.** `RESOLVE_LIMIT` in
 *        `functions/ingestionGateway.ts`: 60 per name per hour, keyed on the
 *        **recipient** rather than the envelope-from, which is attacker-chosen
 *        and bounds nothing. The cost is that flooding one address can suppress
 *        that person's real mail for the window; the alternative is an
 *        unbounded oracle for everybody.
 *      - **Expire tickets aggressively.** `TICKET_TTL_MS`: five minutes, and
 *        single-use for the credential and single-use again for the accounting
 *        write. Expiry is enforced on read, so a row nobody has swept is still
 *        dead.
 *      - **A per-user kill switch.** Already there, and it is the policy
 *        itself: `allowedSenders: []` with `allowedDomains: []` and
 *        `allowAnySender: false` accepts nothing, and a personal context has an
 *        unambiguous owner to set it. `schema.ts` says why there is no separate
 *        `enabled` flag — a second way to express "off" is a second thing to
 *        check.
 *
 *    Still open, and bigger than this contract: minting a **write-only,
 *    short-lived credential per ticket** would close the residual risk rather
 *    than bound it. That is a storage-provisioning change, not a routing one.
 *
 * ----------------------------------------------------------------------------
 * 1. POST /gateway/ingest/resolve
 * ----------------------------------------------------------------------------
 * request:
 *   { "username":     "seyi",              // normalised, never reserved
 *     "sizeBytes":    12345,               // the SMTP-reported message size
 *     "envelopeFrom": "alice@example.com"  // for rate limiting only; NOT authority
 *   }
 *
 * response 200:
 *   { "ingestion": {
 *       "ticket":           "<opaque, single-use, short-lived>",
 *       "context":          { "kind": "personal", "path": "seyi" },
 *       "targetFolder":     "0-inbox/",
 *       "attachmentPolicy": "ignore" | "list" | "store",
 *       "maxAttachmentBytes": 2000000,
 *       "maxMessageBytes":  5000000,
 *       "policy": { "allowedSenders": [...], "allowedDomains": [...],
 *                   "allowAnySender": false }
 *   } }
 *
 * or `{ "ingestion": null }`.
 *
 * `context` is the redundant half of the argument above. `kind` is the literal
 * string `"personal"` and nothing else is accepted; `path` is the context's
 * path, which for a personal context is the username — the same string that was
 * asked about. The caller re-checks both. See `assertPersonalContext`.
 *
 * The **same** `null` must cover: no such name, **the name is a shared
 * context**, the user has no personal context yet, ingestion disabled, no
 * active storage binding, over quota, and this message would take them over
 * quota. Distinguishing any of them turns `<name>@context.lc` into an
 * account-existence oracle probeable from any mail client on earth, and
 * distinguishing the shared case in particular publishes which names are teams.
 *
 * ----------------------------------------------------------------------------
 * 2. POST /gateway/ingest/binding
 * ----------------------------------------------------------------------------
 * request:  { "ticket": "<from resolve>" }
 * response: `{ "binding": … }` in exactly the shape `/gateway/binding` returns,
 *           or `{ "binding": null }`.
 *
 * The control plane derives the personal context from the ticket. There must be
 * no code path in which anything the caller sends selects a row.
 *
 * ----------------------------------------------------------------------------
 * 3. POST /gateway/ingest/record
 * ----------------------------------------------------------------------------
 * request:  { "ticket": "<same>", "outcome": "captured" | "duplicate",
 *             "bytes": 12345 }
 * response: { "ok": true }
 *
 * Quota accounting. Best-effort by construction: the note is already written
 * when this is called, so a failure here is logged and swallowed rather than
 * turned into a refusal the sender would see. It carries no subject, no body,
 * and no sender.
 */

/** How long a control-plane call may take. Same budget as the gateway's. */
const CONTROL_PLANE_TIMEOUT_MS = 8_000;

/** Every documented payload is well under a kilobyte. */
const CONTROL_PLANE_RESPONSE_BYTE_CAP = 256_000;

/**
 * A control-plane call did not produce a usable answer.
 *
 * Carries a short reason for this Worker's structured logs and nothing else:
 * never a response body, never the secret, never a ticket, never a credential.
 */
import { DEFAULT_MIME_LIMITS, MAX_ATTACHMENT_BYTES_HARD_CAP } from "./mime";

export class ControlPlaneError extends Error {
  readonly reason: string;
  constructor(reason: string) {
    super(`control plane unavailable: ${reason}`);
    this.name = "ControlPlaneError";
    this.reason = reason;
  }
}

/**
 * The only kind of context this Worker can ever be pointed at.
 *
 * A union of one, deliberately. It is not `"personal" | "shared"` with the
 * shared arm refused downstream: there is no type in this package that can hold
 * a shared context, so no function here can be given one by mistake, and adding
 * one would be a visible edit to this line rather than a quiet miss in a branch.
 */
export interface PersonalContextRef {
  readonly kind: "personal";
  /** The context's path, which for a personal context is the owner's username. */
  readonly path: string;
}

export interface IngestionResolution {
  ticket: string;
  /** Always personal. See `PersonalContextRef` and `assertPersonalContext`. */
  context: PersonalContextRef;
  targetFolder: string;
  attachmentPolicy: string;
  /**
   * The owner's per-attachment ceiling. Never `0` and never unbounded: a value
   * the control plane did not send, or sent unusably, resolves to this worker's
   * own `DEFAULT_MIME_LIMITS.maxAttachmentBytes` rather than to "no limit".
   */
  maxAttachmentBytes: number;
  maxMessageBytes: number;
  policy: {
    allowedSenders: readonly string[];
    allowedDomains: readonly string[];
    allowAnySender: boolean;
  };
}

/**
 * Re-check, at the caller, that what came back is a personal context.
 *
 * Exported and used by `index.ts` as well as here, because the two run for
 * different reasons and neither subsumes the other:
 *
 *   - here, so a real deployment folds a non-personal answer into the same
 *     `null` as an unknown name *before* anything downstream can branch on the
 *     difference and leak it;
 *   - there, so an injected or replaced client (the test suite uses one, and so
 *     would a self-hoster) cannot smuggle a shared context past by returning a
 *     resolution the parser never saw.
 *
 * `username` is the string this Worker asked about. Requiring `path` to equal
 * it is what turns "the control plane says this is personal" into something
 * anchored to the address the sender actually wrote: usernames and shared slugs
 * are one exclusive namespace, so a context whose path is the local part of a
 * `<name>@context.lc` address is a person's.
 *
 * This is a *check*, not the guarantee. The guarantee is that no request this
 * Worker sends can name a context at all — see the block comment above.
 */
export function assertPersonalContext(
  context: PersonalContextRef | null | undefined,
  username: string,
): boolean {
  return !!context && context.kind === "personal" && context.path === username;
}

export interface ControlPlaneEnv {
  CONTROL_PLANE_URL?: string;
  EMAIL_WORKER_SECRET?: string;
}

export interface ControlPlaneOptions {
  fetchImpl?: typeof fetch;
}

function requireConfig(env: ControlPlaneEnv): { base: string; secret: string } {
  const base = typeof env?.CONTROL_PLANE_URL === "string" ? env.CONTROL_PLANE_URL.trim() : "";
  const secret = typeof env?.EMAIL_WORKER_SECRET === "string" ? env.EMAIL_WORKER_SECRET : "";
  if (!base || !secret) throw new ControlPlaneError("not configured");
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new ControlPlaneError("not configured");
  }
  // The one exception is the offline test host, which never leaves the process.
  // Everything else carries a decrypted storage secret on the way back.
  if (url.protocol !== "https:" && url.hostname !== "control-plane.test") {
    throw new ControlPlaneError("not configured");
  }
  return { base: base.replace(/\/+$/, ""), secret };
}

export function createIngestControlPlane(env: ControlPlaneEnv, options: ControlPlaneOptions = {}) {
  const fetchImpl = options.fetchImpl || ((...args: Parameters<typeof fetch>) => globalThis.fetch(...args));

  async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
    const { base, secret } = requireConfig(env);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONTROL_PLANE_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method: "POST",
        headers: {
          // The secret appears here and nowhere else in the process.
          Authorization: `Bearer ${secret}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
        // "manual", not "error". workerd does not implement `redirect: "error"`
        // — `fetch` rejects with a TypeError before the request is made, which
        // this function then flattens to "request failed". Every inbound
        // message died there, and the flattening (deliberate: the raw error can
        // quote the request, headers included) hid the cause for hours.
        //
        // "manual" is equally safe here and is what the intent was: a redirect
        // is surfaced as a response rather than followed, and the status check
        // below refuses anything that is not a 200 — so a redirected call is
        // still a failed call, and no credential is ever replayed to a
        // Location we did not choose.
        redirect: "manual",
      });
    } catch {
      // The caught error may quote the request — headers included. Dropped on
      // the floor rather than wrapped.
      throw new ControlPlaneError("request failed");
    } finally {
      clearTimeout(timer);
    }

    if (!response || response.status !== 200) {
      throw new ControlPlaneError(`status ${response?.status ?? "none"}`);
    }
    const declared = Number(response.headers?.get?.("content-length"));
    if (Number.isFinite(declared) && declared > CONTROL_PLANE_RESPONSE_BYTE_CAP) {
      throw new ControlPlaneError("response too large");
    }
    let text: string;
    try {
      text = await response.text();
    } catch {
      throw new ControlPlaneError("response unreadable");
    }
    if (text.length > CONTROL_PLANE_RESPONSE_BYTE_CAP) {
      throw new ControlPlaneError("response too large");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new ControlPlaneError("response not json");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new ControlPlaneError("response not an object");
    }
    return parsed as Record<string, unknown>;
  }

  /**
   * A missing key is not the same as an explicit `null`.
   *
   * `null` is the contract's "nothing matched" and is a clean refusal. A
   * *missing* key is a control plane answering something other than what this
   * file documents, and reading that as "nothing matched" is the laxness that
   * would later read a malformed binding as "no binding".
   */
  function required(parsed: Record<string, unknown>, key: string): unknown {
    if (!(key in parsed)) throw new ControlPlaneError(`response missing ${key}`);
    return parsed[key];
  }

  return {
    /**
     * Resolve a **username** to that person's personal context.
     *
     * @returns the resolution, or `null` for every kind of "no" — including
     *          "that name is a shared context", which must be indistinguishable
     *          from "that name does not exist".
     */
    async resolveIngestion(
      username: string,
      sizeBytes: number,
      envelopeFrom: string,
    ): Promise<IngestionResolution | null> {
      const value = required(
        await post("/gateway/ingest/resolve", { username, sizeBytes, envelopeFrom }),
        "ingestion",
      );
      if (value === null) return null;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new ControlPlaneError("malformed ingestion");
      }
      const record = value as Record<string, unknown>;
      const ticket = record.ticket;
      const policy = record.policy;
      if (typeof ticket !== "string" || !ticket) throw new ControlPlaneError("malformed ingestion");
      if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
        throw new ControlPlaneError("malformed ingestion");
      }

      // ── The context, and the one place `null` and `throw` diverge. ─────────
      //
      // A *missing* `context` key means the control plane does not implement
      // this contract at all — a version skew, true for every recipient alike.
      // That is recipient-independent, so it throws and `index.ts` treats it
      // like an outage: loud, and correlated with nothing about who exists.
      //
      // A *present* `context` whose value is not this user's personal one is
      // recipient-**dependent** — it is the shared-context case, and the answer
      // would differ per name. So it folds into the very same `null` an unknown
      // name produces, here, before any caller can see the difference. A
      // stranger bouncing mail off the MX learns nothing about which names are
      // teams. The cost is a log line we deliberately give up: the control
      // plane is the side that can safely record it.
      if (!("context" in record)) throw new ControlPlaneError("response missing context");
      const context = record.context;
      if (!context || typeof context !== "object" || Array.isArray(context)) return null;
      const contextRecord = context as Record<string, unknown>;
      if (contextRecord.kind !== "personal") return null;
      if (typeof contextRecord.path !== "string" || !contextRecord.path) return null;
      const personal: PersonalContextRef = { kind: "personal", path: contextRecord.path };
      if (!assertPersonalContext(personal, username)) return null;

      const policyRecord = policy as Record<string, unknown>;
      return {
        ticket,
        context: personal,
        targetFolder: typeof record.targetFolder === "string" ? record.targetFolder : "",
        attachmentPolicy:
          typeof record.attachmentPolicy === "string" ? record.attachmentPolicy : "list",
        // Two directions, both deliberate. A missing or unusable value falls
        // back to this worker's own limit and never to unbounded — a control
        // plane answering `Infinity`, or simply not carrying the field yet,
        // must not become permission to buffer whatever a sender chose. And a
        // usable value is still clamped: the control plane may lower this limit
        // but never raise it past what this worker is willing to allocate.
        maxAttachmentBytes:
          typeof record.maxAttachmentBytes === "number" &&
          Number.isInteger(record.maxAttachmentBytes) &&
          record.maxAttachmentBytes > 0
            ? Math.min(record.maxAttachmentBytes, MAX_ATTACHMENT_BYTES_HARD_CAP)
            : DEFAULT_MIME_LIMITS.maxAttachmentBytes,
        maxMessageBytes:
          typeof record.maxMessageBytes === "number" && Number.isFinite(record.maxMessageBytes)
            ? record.maxMessageBytes
            : 0,
        policy: {
          allowedSenders: Array.isArray(policyRecord.allowedSenders)
            ? (policyRecord.allowedSenders as string[]).filter((e) => typeof e === "string")
            : [],
          allowedDomains: Array.isArray(policyRecord.allowedDomains)
            ? (policyRecord.allowedDomains as string[]).filter((e) => typeof e === "string")
            : [],
          allowAnySender: policyRecord.allowAnySender === true,
        },
      };
    },

    /**
     * @returns the binding with its secret opened, or `null`.
     *
     * The ticket is the only input, and the control plane bound it to a
     * personal context at mint time. Nothing here can name a context.
     */
    async getBinding(ticket: string): Promise<Record<string, unknown> | null> {
      const value = required(await post("/gateway/ingest/binding", { ticket }), "binding");
      if (value === null) return null;
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new ControlPlaneError("malformed binding");
      }
      return value as Record<string, unknown>;
    },

    /** Quota accounting. Callers swallow failures; the note is already written. */
    async record(ticket: string, outcome: "captured" | "duplicate", bytes: number): Promise<void> {
      await post("/gateway/ingest/record", { ticket, outcome, bytes });
    },
  };
}

export type IngestControlPlane = ReturnType<typeof createIngestControlPlane>;
