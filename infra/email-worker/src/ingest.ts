/**
 * The decision core: everything this Worker decides, decided without a network.
 *
 * `src/index.ts` does the I/O — draining a stream, calling the control plane,
 * building a store, writing objects. This module decides *what* should happen,
 * from values. That split is what makes the security properties testable: every
 * assertion about refusals, injection, idempotency and caps below is exercised
 * with a byte array and a config object.
 *
 * ============================================================================
 * THE ORDER OF CHECKS IS THE DESIGN
 * ============================================================================
 *
 *   1. Is this address ours, well-formed, a **username**, and not a reserved
 *      mailbox?
 *   2. Is the message small enough to look at?
 *   3. Does it parse into something with a sender and a body?
 *   4. **Did the sender prove the identity they claim?**  ← ./auth.ts
 *   5. Does the owner's policy admit that *proved* identity?  ← ./policy.ts
 *   6. Only now: render, key, and hand back a write.
 *
 * Step 4 before step 5, always. A `From:` header is a claim; running an
 * allow-list against a claim produces a check that an attacker satisfies by
 * typing the name of someone trusted. There is no path in this file where a
 * policy match is reached without a passing verdict from `verifySender`.
 *
 * ============================================================================
 * REFUSALS CARRY NOTHING
 * ============================================================================
 *
 * Every refusal is `{ kind: "refuse", reason }` where `reason` is a fixed
 * enum member used **only for this Worker's own structured logs**. It is never
 * rendered, returned to a sender, or used to choose an SMTP response: `index.ts`
 * turns every refusal — unknown recipient, a name that is a shared context,
 * failed authentication, disallowed sender, over quota, storage failure — into
 * the same frozen rejection.
 *
 * That uniformity is not tidiness. Ingestion runs on the apex, so
 * `<name>@context.lc` is an address anyone can probe. A rejection that differed
 * between "no such name" and "you are not on the list" would let anyone
 * enumerate who has an account here, one guess at a time, from any mail client
 * on earth — undoing what the control plane's byte-identical errors and the
 * router's frozen link previews exist for. And a rejection that singled out
 * "that name is a shared context" would publish, to anyone with a mail client,
 * exactly which names on this domain are teams rather than people.
 *
 * ============================================================================
 * EMAIL REACHES PERSONAL CONTEXTS AND NOTHING ELSE
 * ============================================================================
 *
 * A username *is* a personal context — one per person, forever, and the
 * username is that context's path. `<username>@context.lc` therefore has one
 * destination, chosen by the address rather than by anything in the message.
 *
 * A shared context has no ingestion address. Not a disabled one, not one
 * awaiting configuration: the concept does not exist for it. Mail gets into a
 * shared context only afterwards, when a person or an agent triages a capture
 * out of somebody's personal context and moves it — which means every note in a
 * shared context that came from outside passed through exactly one accountable
 * owner's hands on the way in.
 */

import { RESERVED_NAMES, RFC2142_MANDATORY_NAMES, normalizeName, validateName } from "../../../apps/convex/functions/lib/names";
// The same adapter-boundary prefix rules the gateway uses, rather than a second
// opinion about what a safe key prefix is. See apps/mcp/src/store/index.js.
import { assertSafePrefix } from "../../../apps/mcp/src/store/index.js";
import { verifySender, type AuthFailure } from "./auth";
import { htmlToText } from "./html";
import { DEFAULT_MIME_LIMITS, parseEmail, safeFilename, singleLine, type MimeLimits } from "./mime";
import type { IngestionPolicy, SenderMatcher } from "./policy";
import { renderCaptureNote, type AttachmentPolicy, type RenderedAttachment } from "./note";

/* ------------------------------- recipients -------------------------------- */

export type RecipientDecision =
  /**
   * A claimable name, i.e. a candidate **username** — and therefore a candidate
   * personal context, since the username is that context's path. Normalised and
   * ready for the control plane, which is the only thing that can say whether
   * the name has actually been claimed by a person.
   *
   * There is deliberately no sibling variant for a shared context. This Worker
   * has no representation of one anywhere: not here, not in
   * `IngestionResolution`, not in a config field. A shared context is not
   * something it refuses — it is something it cannot express.
   */
  | { kind: "personal"; username: string }
  /**
   * `postmaster@` or `abuse@`. RFC 2142 requires these stay deliverable to a
   * human, and CLAUDE.md records that requirement as load-bearing — so they are
   * forwarded rather than refused, and they never reach the ingestion path.
   */
  | { kind: "operations"; localPart: string }
  | { kind: "refuse"; reason: RefusalReason };

/**
 * Classify a recipient address.
 *
 * Sub-address tags are **stripped and then discarded**: `seyi+receipts@` is
 * mail for `seyi`, and the tag is not used to choose a folder — nor, now that
 * there is exactly one destination, to choose a context. Letting a stranger
 * name part of the destination path is a write primitive, and with one personal
 * context per person there is nothing left for a tag to select anyway.
 */
export function classifyRecipient(address: string, ingestDomain: string): RecipientDecision {
  const cleaned = singleLine(address).toLowerCase();
  const at = cleaned.lastIndexOf("@");
  if (at <= 0) return { kind: "refuse", reason: "malformed_recipient" };
  const domain = cleaned.slice(at + 1);
  if (!ingestDomain || domain !== ingestDomain.toLowerCase()) {
    return { kind: "refuse", reason: "foreign_recipient_domain" };
  }

  const rawLocal = cleaned.slice(0, at);
  const plus = rawLocal.indexOf("+");
  const base = plus >= 0 ? rawLocal.slice(0, plus) : rawLocal;
  const normalized = normalizeName(base);

  if (RFC2142_MANDATORY_NAMES.includes(normalized)) {
    return { kind: "operations", localPart: normalized };
  }

  const validation = validateName(normalized);
  if (!validation.ok) {
    // Both branches refuse, but they are separate reasons in the log because
    // one means "nobody could ever have this address" and the other means
    // "somebody typed it wrong". Neither is observable from outside.
    return {
      kind: "refuse",
      reason: validation.reason === "reserved" ? "reserved_recipient" : "malformed_recipient",
    };
  }
  // A deliberate redundancy, and honestly labelled as one: `validateName`
  // already rejects every reserved name, so removing this line changes no
  // behaviour and no test catches its removal. It is here because the check it
  // duplicates is a *mail-interception* control — CLAUDE.md's words — and the
  // failure mode is silent: reorder `validateName`'s checks and `support@`
  // starts resolving to whoever claimed the name. The tested guard is the pair;
  // see "refuses every reserved name" in ./ingest.test.ts, which fails when
  // either half goes.
  if (RESERVED_NAMES.has(validation.normalized)) {
    return { kind: "refuse", reason: "reserved_recipient" };
  }

  return { kind: "personal", username: validation.normalized };
}

/* -------------------------------- decisions -------------------------------- */

/**
 * Why a message was refused. **Log-only.** Nothing outside this Worker's own
 * logs may ever branch on this value — see the module comment.
 */
export type RefusalReason =
  | "malformed_recipient"
  | "foreign_recipient_domain"
  | "reserved_recipient"
  /**
   * The name resolved to nothing this Worker may write to. One reason for all
   * of: nobody has the name, the name belongs to a shared context, the user has
   * no personal context, ingestion is off, storage is unbound, over quota.
   */
  | "unknown_recipient"
  /**
   * The control plane answered with something that is not this user's personal
   * context. Defence in depth: the client in ./controlPlane.ts already folds
   * this into the same `null` as `unknown_recipient`, so in a real deployment
   * this never fires. It exists for a replaced or injected client, and it is a
   * separate *log* reason — never a separate refusal — because an operator
   * wants to see a misbehaving control plane while a sender must not.
   */
  | "not_a_personal_context"
  | "message_too_large"
  | "unparseable_message"
  | "empty_message"
  | "sender_not_allowed"
  | "sender_matcher_unwired"
  | "invalid_target_folder"
  | "control_plane_unavailable"
  | "storage_unavailable"
  | "write_failed"
  | `auth_${AuthFailure}`;

export interface AttachmentWrite {
  key: string;
  bytes: Uint8Array;
  contentType: string;
}

export interface CaptureDecision {
  kind: "capture";
  /** The object key for the note. Deterministic in the message id. */
  key: string;
  note: string;
  attachments: AttachmentWrite[];
  /** For the control plane's quota accounting. Never content. */
  bytes: number;
  /** Structured-log fields. Addresses and tags only; never body text. */
  log: {
    sender: string;
    senderDomain: string;
    authMethod: string;
    attachmentCount: number;
    problems: string[];
  };
}

export type IngestDecision = CaptureDecision | { kind: "refuse"; reason: RefusalReason };

export interface IngestConfig {
  /**
   * Where captures land **inside the owner's personal context**. Validated
   * here; `""` means use the default.
   *
   * This is the one thing about the destination that stays configurable. The
   * context itself is not: it is the personal context of whoever holds the
   * username in the address.
   */
  targetFolder: string;
  policy: IngestionPolicy;
  attachmentPolicy: AttachmentPolicy;
  /** Whole-message cap from the owner's policy. */
  maxMessageBytes: number;
  limits: MimeLimits;
  /** The authserv-id whose `Authentication-Results` we will believe. */
  authServiceId: string;
}

export interface IngestInput {
  /** The address the message was delivered to, for the note's own record. */
  recipient: string;
  /**
   * The username in that address — which is also the path of the personal
   * context this capture is landing in. One string, two jobs, and the note says
   * so: a reader who only ever sees the rendered capture should come away
   * knowing that `@seyi` is where their own mail lives.
   */
  owner: string;
  raw: Uint8Array;
  now: Date;
  /** Unpredictable per message. See ./note.ts for why this must be random. */
  fenceNonce: string;
}

/** Where a capture lands when the workspace has not configured anything. */
export const DEFAULT_TARGET_FOLDER = "0-inbox/";

/**
 * Validate a workspace's configured target folder.
 *
 * Returns `null` for anything unusable rather than silently falling back to the
 * default: a folder the control plane stored and this Worker ignored is a
 * capture filed somewhere the owner is not looking, which is worse than a
 * refusal they can see in their logs.
 */
export function normalizeTargetFolder(value: string): string | null {
  const raw = singleLine(value ?? "");
  if (!raw) return DEFAULT_TARGET_FOLDER;
  if (raw.length > 200) return null;
  const trimmed = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmed) return null;
  try {
    assertSafePrefix(trimmed);
  } catch {
    return null;
  }
  return `${trimmed}/`;
}

/** SHA-256, lowercase hex. Same helper, same shape as the gateway's. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function sha256HexBytes(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * The idempotency fingerprint.
 *
 * Same construction as the gateway's `/inbox` path — `sha256(source \0
 * external_id)` — so an email capture and an API capture cannot collide and
 * both are addressable the same way. The `external_id` is the `Message-ID`,
 * which is exactly what a retried SMTP delivery repeats.
 *
 * When a message carries no `Message-ID` (legal, and common from scripts), the
 * fallback is a hash of the message's own bytes. That keeps a retry idempotent
 * — the retry is byte-identical — without letting a sender pick the key.
 */
export async function captureFingerprint(
  messageId: string,
  raw: Uint8Array,
): Promise<string> {
  const externalId = messageId ? messageId : `sha256:${await sha256HexBytes(raw)}`;
  return sha256Hex(`email ${externalId}`);
}

/**
 * Decide what to do with a message whose workspace has already been resolved.
 *
 * Pure and total: no I/O, no throwing, one of two shapes out. `matcher` is
 * injected rather than imported so tests exercise the real matching rules the
 * control plane ships (and, while ./policy.ts is unwired, so this file is not
 * the thing that has to change when it is wired).
 */
export async function decideCapture(
  input: IngestInput,
  config: IngestConfig,
  matcher: SenderMatcher,
): Promise<IngestDecision> {
  const targetFolder = normalizeTargetFolder(config.targetFolder);
  if (targetFolder === null) return { kind: "refuse", reason: "invalid_target_folder" };

  if (input.raw.length > config.maxMessageBytes) {
    return { kind: "refuse", reason: "message_too_large" };
  }

  const limits: MimeLimits = { ...DEFAULT_MIME_LIMITS, ...config.limits };
  const parsed = parseEmail(input.raw, limits, htmlToText);
  if (parsed.problems.includes("parse_failed")) {
    return { kind: "refuse", reason: "unparseable_message" };
  }

  // ── Authentication, before the allow-list, always. ────────────────────────
  const verdict = verifySender({
    authenticationResults: parsed.authenticationResults,
    fromAddress: parsed.fromAddress,
    authServiceId: config.authServiceId,
  });
  if (!verdict.ok) return { kind: "refuse", reason: `auth_${verdict.reason}` };

  // ── The allow-list, applied to the *proved* identity. ─────────────────────
  let allowed: boolean;
  try {
    allowed = matcher(verdict.address, config.policy) === true;
  } catch {
    // A matcher that throws is a matcher that has not decided. Refuse.
    allowed = false;
  }
  if (!allowed) return { kind: "refuse", reason: "sender_not_allowed" };

  const hasText = parsed.textSource !== "none" && parsed.text.trim().length > 0;
  const hasAttachments = config.attachmentPolicy !== "ignore" && parsed.attachments.length > 0;
  if (!hasText && !hasAttachments) return { kind: "refuse", reason: "empty_message" };

  const fingerprint = await captureFingerprint(parsed.messageId, input.raw);
  const key = `${targetFolder}email/${fingerprint.slice(0, 24)}.md`;

  // ── Attachments ───────────────────────────────────────────────────────────
  const writes: AttachmentWrite[] = [];
  const rendered: RenderedAttachment[] = [];
  for (const attachment of parsed.attachments) {
    let storedPath: string | null = null;
    if (config.attachmentPolicy === "store" && attachment.bytes) {
      // Content-addressed, so a name a sender chose can neither collide with
      // an existing object nor decide where the bytes land.
      //
      // `safeFilename` runs a second time here. `parseEmail` already applied it
      // — that is the layer with its own tests ("reduces a hostile filename..."
      // and "keeps a traversal attempt out of the parsed filename too" in
      // ./mime.test.ts) — so this call changes nothing today and no test catches
      // its removal. It stays because key construction should not depend on a
      // promise made in another module: this is the line that decides where
      // bytes land, and it should be able to be read on its own.
      const digest = (await sha256HexBytes(attachment.bytes)).slice(0, 12);
      const leaf = safeFilename(attachment.filename) || `${digest}.bin`;
      storedPath = `${targetFolder}email/attachments/${digest}-${leaf}`;
      writes.push({
        key: storedPath,
        bytes: attachment.bytes,
        contentType: attachment.contentType,
      });
    }
    rendered.push({
      filename: attachment.filename,
      contentType: attachment.contentType,
      size: attachment.size,
      storedPath,
    });
  }

  const note = renderCaptureNote({
    now: input.now,
    fenceNonce: input.fenceNonce,
    recipient: input.recipient,
    owner: input.owner,
    targetFolder,
    sender: verdict.address,
    senderDomain: verdict.domain,
    authMethod: verdict.method,
    subject: parsed.subject,
    sentAt: parsed.date,
    messageId: parsed.messageId,
    text: parsed.text,
    textSource: parsed.textSource,
    attachments: rendered,
    attachmentPolicy: config.attachmentPolicy,
    problems: parsed.problems,
  });

  return {
    kind: "capture",
    key,
    note,
    attachments: writes,
    bytes: input.raw.length,
    log: {
      sender: verdict.address,
      senderDomain: verdict.domain,
      authMethod: verdict.method,
      attachmentCount: rendered.length,
      problems: parsed.problems,
    },
  };
}
