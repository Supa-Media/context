/**
 * context-email — the Cloudflare Email Worker behind `<username>@context.lc`.
 *
 * ============================================================================
 * ONE ADDRESS, ONE DESTINATION: THE SENDER'S PERSONAL CONTEXT
 * ============================================================================
 *
 * A username **is** a personal context — one per person, forever, and the
 * username is that context's path. `seyi@context.lc` delivers to `@seyi` and
 * there is no second thing it could mean.
 *
 * Shared contexts have no ingestion address at all. Not a disabled one, not one
 * pending setup: this Worker has no type that can hold a shared context and no
 * request field that could ask for one, so there is nothing here to switch off.
 * Everything from outside enters through one accountable owner's personal
 * context and gets into a shared context only if that owner, or an agent acting
 * for them, later decides to move it.
 *
 * Two things follow, and both are load-bearing:
 *
 *   - A name that belongs to a shared context is refused **exactly** as an
 *     unclaimed name is. Anything else publishes which names here are teams.
 *   - The `+tag` in `seyi+receipts@` is stripped and thrown away. With one
 *     destination there is nothing for it to select, and a sender naming any
 *     part of a destination is a write primitive.
 *
 * All the decisions live in ./ingest.ts, ./auth.ts, ./mime.ts, ./html.ts and
 * ./note.ts as pure functions, tested without a runtime. This module does the
 * I/O: drain a stream, ask the control plane, build a store, write two objects,
 * and turn every outcome into one of exactly three observable behaviours.
 *
 * ============================================================================
 * THE THREE OBSERVABLE BEHAVIOURS
 * ============================================================================
 *
 *   accept   — the message was captured (or was a duplicate of one that was).
 *              Nothing is sent back; the SMTP transaction simply succeeds.
 *   forward  — `postmaster@` and `abuse@` only. RFC 2142 requires these stay
 *              deliverable to a human and CLAUDE.md records that as
 *              load-bearing, so they never enter the ingestion path.
 *   refuse   — `setReject(REFUSAL)`, with **one frozen string**, for every
 *              other outcome without exception.
 *
 * ── Why the refusal is one string ───────────────────────────────────────────
 *
 * Ingestion is on the apex. `<name>@context.lc` is therefore an address anyone
 * on the internet can send to, and a rejection that differed between
 *
 *   - no such name,
 *   - the name is a shared context, which takes no mail,
 *   - the person exists but you are not an allowed sender,
 *   - the person exists and is over quota,
 *   - the person exists and their storage is broken,
 *   - your message failed authentication,
 *
 * would be a username enumeration oracle drivable from any mail client on
 * earth: send to `alice@`, send to `bob@`, read the bounces, learn who has an
 * account — and, with the second line distinguishable, learn the roster of
 * teams too. That is exactly the oracle the control plane's byte-identical
 * `{"binding":null}` and the router's frozen link previews exist to deny, and
 * it would be silly to rebuild it in the one component a stranger can address
 * without authenticating at all.
 *
 * So: one constant, one call site, no formatting, nothing derived from the
 * message. `refuse()` below is the only place `setReject` is called.
 *
 * ── The cost, stated honestly ───────────────────────────────────────────────
 *
 * A storage failure for a real, allowed sender produces a permanent rejection
 * rather than a retryable one, and the message is lost. A temporary failure
 * there would be *correct* for mail and *wrong* for privacy: it happens only
 * for addresses that resolved to a real person, so it would be a perfect
 * existence oracle. Losing a message beats leaking a customer list.
 *
 * The one branch that is allowed to behave differently is a control-plane
 * outage, and only because it is recipient-independent: resolution is the first
 * call and it fails for every address alike, so a distinguishable outcome there
 * correlates with nothing. That branch rethrows, letting the runtime apply its
 * default handling rather than burning a real message on our downtime.
 *
 * ============================================================================
 * LOGGING
 * ============================================================================
 *
 * Structured logs carry the recipient username, a refusal reason, byte counts
 * and parser tags. They **never** carry a subject, a body, an attachment name,
 * a ticket, a credential, or the worker secret. `log()` is the only logging
 * call site and it takes a closed set of fields for exactly that reason.
 */

import {
  assertPersonalContext,
  createIngestControlPlane,
  ControlPlaneError,
  type IngestControlPlane,
} from "./controlPlane";
import {
  classifyRecipient,
  decideCapture,
  DEFAULT_TARGET_FOLDER,
  type RefusalReason,
} from "./ingest";
import { DEFAULT_MIME_LIMITS } from "./mime";
import { SENDER_MATCHER_WIRED, senderIsAllowed, type IngestionPolicy } from "./policy";
import type { AttachmentPolicy } from "./note";
// The gateway's storage adapter, imported rather than reimplemented. Tenancy is
// bucket-level: neither adapter namespaces a key, and the customer's optional
// rootPrefix is applied inside them and invisible here.
import { R2Store } from "../../../apps/mcp/src/store/r2.js";
import { S3Store } from "../../../apps/mcp/src/store/s3.js";

/**
 * The single refusal. Deliberately says nothing: not whether the address
 * exists, not whether the sender is allowed, not why.
 *
 * "550 5.7.1" is the right class — a permanent policy rejection — and the text
 * is the same for a mistyped address and for a targeted probe.
 */
export const REFUSAL = "550 5.7.1 Message rejected by recipient policy";

/** Where captures land, inside the owner's personal context, by default. */
export { DEFAULT_TARGET_FOLDER };

/**
 * The subset of `ForwardableEmailMessage` this Worker uses.
 *
 * Declared structurally rather than taken from `@cloudflare/workers-types` so
 * the handler can be driven from a plain object in tests, with no runtime and
 * no network.
 */
export interface InboundMessage {
  /** SMTP envelope recipient. */
  readonly to: string;
  /** SMTP envelope sender. Used for rate limiting and logs; never authority. */
  readonly from: string;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
  forward(rcptTo: string, headers?: Headers): Promise<void>;
}

export interface Env {
  /** Convex HTTP-actions origin, i.e. `https://<deployment>.convex.site`. */
  CONTROL_PLANE_URL?: string;
  /** This Worker's own secret. Never `GATEWAY_SECRET`. See ./controlPlane.ts. */
  EMAIL_WORKER_SECRET?: string;
  /** The apex we accept mail for. */
  INGEST_DOMAIN?: string;
  /** The authserv-id whose `Authentication-Results` we believe. See ./auth.ts. */
  AUTH_SERVICE_ID?: string;
  /** Where `postmaster@` and `abuse@` are delivered. */
  OPERATIONS_MAILBOX?: string;
  /** Hard ceiling, independent of any owner's policy. */
  MAX_MESSAGE_BYTES?: string;
  /** Allow-list of native R2 binding names, for self-hosters. See ./index.ts. */
  NATIVE_BINDINGS?: string;
  [key: string]: unknown;
}

/** A ceiling this Worker will not read past, whatever a policy says. */
const HARD_MAX_MESSAGE_BYTES = 5_000_000;

/* --------------------------------- logging -------------------------------- */

interface LogFields {
  event: string;
  /** The recipient's local part — a username, hence a personal-context path. */
  username?: string;
  reason?: RefusalReason | string;
  bytes?: number;
  attachments?: number;
  authMethod?: string;
  problems?: string[];
  duplicate?: boolean;
}

/**
 * The only logging call site.
 *
 * Takes a closed set of fields, so "just add the subject while debugging" is a
 * type error rather than a customer's private mail in a log aggregator. Note
 * what is absent and must stay absent: subject, body, sender address,
 * attachment names, ticket, context id, credential.
 */
function log(fields: LogFields): void {
  console.log(JSON.stringify({ worker: "context-email", ...fields }));
}

/* --------------------------------- store ---------------------------------- */

interface ContextStore {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  put(key: string, value: string | Uint8Array | ArrayBuffer): Promise<{ etag: string } | null>;
}

/**
 * Turn a binding into a store, with the same two locks the gateway applies.
 *
 * Returns `null` rather than throwing, because every failure here collapses to
 * the same refusal anyway and a thrown error is one more thing that could
 * escape with a credential in its message.
 */
function storeFor(binding: Record<string, unknown>, env: Env): ContextStore | null {
  if (binding.status !== "active") return null;

  if (binding.provider === "r2-binding") {
    // The one path where a control-plane answer names something inside *our*
    // Worker. Two locks: the name must be in an operator-set allow-list, and it
    // must actually be a bucket. Without the allow-list this would be a way to
    // reach any R2 bucket this Worker can see, from the control plane.
    const name = binding.bindingName;
    if (typeof name !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(name)) return null;
    const allowed = String(env.NATIVE_BINDINGS || "")
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    if (!allowed.includes(name)) return null;
    const bucket = env[name] as { get?: unknown; put?: unknown } | undefined;
    if (!bucket || typeof bucket.get !== "function" || typeof bucket.put !== "function") return null;
    try {
      return new R2Store(bucket as unknown as R2Bucket, {
        rootPrefix: binding.rootPrefix as string | undefined,
      }) as unknown as ContextStore;
    } catch {
      return null;
    }
  }

  const { endpoint, bucket, accessKeyId, secretAccessKey } = binding as Record<string, unknown>;
  if (
    typeof endpoint !== "string" || !endpoint ||
    typeof bucket !== "string" || !bucket ||
    typeof accessKeyId !== "string" || !accessKeyId ||
    typeof secretAccessKey !== "string" || !secretAccessKey
  ) {
    return null;
  }
  try {
    return new S3Store({
      endpoint,
      region: typeof binding.region === "string" && binding.region ? binding.region : "auto",
      bucket,
      accessKeyId,
      secretAccessKey,
      rootPrefix: binding.rootPrefix as string | undefined,
      forcePathStyle: binding.forcePathStyle as boolean | undefined,
    }) as unknown as ContextStore;
  } catch {
    // The adapter's own validation failed. Its message can quote configuration,
    // so it is dropped rather than relayed.
    return null;
  }
}

/* --------------------------------- stream --------------------------------- */

/**
 * Read the message, refusing to buffer more than `cap`.
 *
 * `rawSize` is checked first and is the cheap path, but it is a number the SMTP
 * transaction reported and this is the byte count that actually enters memory,
 * so it is enforced here too.
 */
async function drain(stream: ReadableStream<Uint8Array>, cap: number): Promise<Uint8Array | null> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > cap) return null;
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* a released lock is not an error worth propagating */
    }
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/* ---------------------------------- audit --------------------------------- */

/**
 * One `.audit/` record per capture, in the same shape the gateway writes.
 *
 * The on-bucket layout is a stable format, not an internal detail, so an email
 * capture is auditable exactly like an API capture. Best-effort: a note that
 * landed is not un-landed because its audit record did not.
 */
async function recordAudit(
  store: ContextStore,
  now: Date,
  paths: string[],
  details: Record<string, unknown>,
): Promise<void> {
  const at = now.toISOString();
  const entry = { at, action: "inbox_capture", actor_scope: "email", paths, details };
  const slug = at.replace(/[:.]/g, "-");
  await store.put(`.audit/${slug}-${crypto.randomUUID()}.json`, JSON.stringify(entry));
}

/* --------------------------------- handler -------------------------------- */

function attachmentPolicyOf(value: string): AttachmentPolicy {
  return value === "ignore" || value === "store" ? value : "list";
}

export interface HandlerOptions {
  /** Injected in tests so the suite cannot reach the network by accident. */
  controlPlane?: IngestControlPlane;
  now?: () => Date;
  nonce?: () => string;
}

/** 16 hex characters of real entropy. See ./note.ts for why it must be random. */
function randomNonce(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function handleEmail(
  message: InboundMessage,
  env: Env,
  options: HandlerOptions = {},
): Promise<void> {
  const now = options.now ? options.now() : new Date();
  const nonce = options.nonce ? options.nonce() : randomNonce();

  /**
   * The only `setReject` in this Worker. One constant, no interpolation, and
   * the reason goes to the log rather than to the sender.
   */
  const refuse = (reason: RefusalReason, username?: string) => {
    log({ event: "refused", reason, ...(username ? { username } : {}) });
    message.setReject(REFUSAL);
  };

  const recipient = classifyRecipient(message.to, env.INGEST_DOMAIN || "");

  if (recipient.kind === "refuse") return refuse(recipient.reason);

  if (recipient.kind === "operations") {
    // RFC 2142's mandatory mailboxes. Never ingested — they are ours, not a
    // customer's — and never refused if we can help it.
    const mailbox = (env.OPERATIONS_MAILBOX || "").trim();
    if (!mailbox) {
      // Nothing to forward to. This is a deployment error, not a sender error,
      // and it is worth shouting about: `postmaster@` going nowhere is an RFC
      // 2142 violation and the thing CLAUDE.md calls out by name.
      log({ event: "operations_mailbox_unset", username: recipient.localPart });
      message.setReject(REFUSAL);
      return;
    }
    try {
      await message.forward(mailbox);
      log({ event: "forwarded", username: recipient.localPart });
    } catch {
      log({ event: "forward_failed", username: recipient.localPart });
      message.setReject(REFUSAL);
    }
    return;
  }

  // A username, and therefore the path of exactly one personal context. There
  // is no other kind of destination this Worker can produce.
  const username = recipient.username;

  // Fail closed while the policy matcher is unwired. An ingestion path whose
  // only protection is a policy check must not run without one. See ./policy.ts.
  if (!SENDER_MATCHER_WIRED) return refuse("sender_matcher_unwired", username);

  const hardCap = Math.min(
    Number(env.MAX_MESSAGE_BYTES) > 0 ? Number(env.MAX_MESSAGE_BYTES) : HARD_MAX_MESSAGE_BYTES,
    HARD_MAX_MESSAGE_BYTES,
  );
  if (message.rawSize > hardCap) return refuse("message_too_large", username);

  const controlPlane = options.controlPlane || createIngestControlPlane(env);

  // ── Resolution. The one branch allowed to behave differently on failure. ──
  //
  // The only identifier that goes over the wire is the username. There is no
  // field in this call — or in any other call this Worker makes — that could
  // name a context, so there is no input by which this Worker, or anyone
  // holding its secret, could ask for a shared one.
  let resolution;
  try {
    resolution = await controlPlane.resolveIngestion(username, message.rawSize, message.from);
  } catch (error) {
    // Recipient-independent: this call happens for every well-formed address
    // alike, so a distinguishable outcome here correlates with nothing about
    // who exists. Rethrowing lets the runtime apply its own handling rather
    // than burning a real message on our downtime.
    log({
      event: "control_plane_unavailable",
      username,
      reason: error instanceof ControlPlaneError ? error.reason : "unknown",
    });
    throw error;
  }

  // Unknown name, **the name is a shared context**, ingestion disabled, unbound
  // storage, over quota — one answer, because any two of those being told apart
  // is an oracle.
  if (resolution === null) return refuse("unknown_recipient", username);

  // Defence in depth, and honestly labelled as such: ./controlPlane.ts already
  // folded a non-personal answer into the `null` above, so against the real
  // client this line is unreachable. It is here because `options.controlPlane`
  // is injectable — the suite injects one, and a self-hoster could — and a
  // replaced client must not be able to hand this Worker a shared context.
  // Note where it sits: *before* the credential call, so a control plane that
  // answered wrongly still causes no decrypt.
  if (!assertPersonalContext(resolution.context, username)) {
    return refuse("not_a_personal_context", username);
  }

  const raw = await drain(message.raw, Math.min(hardCap, resolution.maxMessageBytes || hardCap));
  if (raw === null) return refuse("message_too_large", username);

  const decision = await decideCapture(
    {
      recipient: `${username}@${(env.INGEST_DOMAIN || "").toLowerCase()}`,
      owner: resolution.context.path,
      raw,
      now,
      fenceNonce: nonce,
    },
    {
      targetFolder: resolution.targetFolder,
      policy: resolution.policy as IngestionPolicy,
      attachmentPolicy: attachmentPolicyOf(resolution.attachmentPolicy),
      maxMessageBytes: Math.min(hardCap, resolution.maxMessageBytes || hardCap),
      limits: DEFAULT_MIME_LIMITS,
      authServiceId: env.AUTH_SERVICE_ID || "",
    },
    senderIsAllowed,
  );

  if (decision.kind === "refuse") return refuse(decision.reason, username);

  // ── Credentials, fetched only now: after size, authentication and policy. ──
  let binding: Record<string, unknown> | null;
  try {
    binding = await controlPlane.getBinding(resolution.ticket);
  } catch {
    // Recipient-*dependent* — we only get here for an address that resolved —
    // so this one collapses into the frozen refusal like everything else.
    return refuse("control_plane_unavailable", username);
  }
  if (binding === null) return refuse("storage_unavailable", username);

  const store = storeFor(binding, env);
  if (!store) return refuse("storage_unavailable", username);

  try {
    // Idempotency. The key is `sha256("email " + Message-ID)`, so a retried
    // SMTP delivery of the same message computes the same key and finds the
    // note already there. A duplicate is an *accept*: the message did arrive,
    // and rejecting a retry would make every transient network blip look like a
    // policy refusal to the sender.
    const existing = await store.get(decision.key);
    if (existing) {
      log({ event: "captured", username, duplicate: true, bytes: decision.bytes });
      await controlPlane.record(resolution.ticket, "duplicate", decision.bytes).catch(() => {});
      return;
    }

    // Attachments first: a note that links to bytes that are not there yet is
    // worse than bytes with no note, and this order makes the note the commit
    // point.
    for (const attachment of decision.attachments) {
      await store.put(attachment.key, attachment.bytes);
    }
    await store.put(decision.key, decision.note);
    await recordAudit(store, now, [decision.key, ...decision.attachments.map((a) => a.key)], {
      source: "email",
      sender: decision.log.sender,
      auth_method: decision.log.authMethod,
    });
  } catch {
    // A storage failure for a real, allowed sender. Permanent rejection and a
    // lost message, because a retryable failure here would happen only for
    // addresses that exist. See the module comment.
    return refuse("write_failed", username);
  }

  log({
    event: "captured",
    username,
    duplicate: false,
    bytes: decision.bytes,
    attachments: decision.log.attachmentCount,
    authMethod: decision.log.authMethod,
    problems: decision.log.problems,
  });
  await controlPlane.record(resolution.ticket, "captured", decision.bytes).catch(() => {});
}

export default {
  email(message: InboundMessage, env: Env): Promise<void> {
    return handleEmail(message, env);
  },
};
