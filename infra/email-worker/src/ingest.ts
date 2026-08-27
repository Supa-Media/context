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
 *   4. **What, if anything, did the sender prove?**  ← ./auth.ts
 *   5. Does the owner's policy admit the address on the message? ← ./policy.ts
 *   6. Only now: render, key, and hand back a write.
 *
 * ============================================================================
 * STEP 4 LABELS. IT NO LONGER GATES.
 * ============================================================================
 *
 * This file used to refuse every message that failed or lacked authentication,
 * and the comment here said so in the strongest terms. That was reversed
 * deliberately — see the "authentication is a label, not a gate" block at the
 * top of ./auth.ts for the two real deliveries that settled it and the owner's
 * reasoning. An inbox is expected to contain unverified mail; every note is
 * fenced as untrusted input regardless of who sent it.
 *
 * So step 4 now produces a `SenderIdentity` and step 5 runs the allow-list
 * against `identity.address`, which — when nothing authenticated — is a string
 * the sender typed into a `From:` header.
 *
 * **What that means, said plainly rather than implied:** the allow-list filters,
 * it does not authenticate. A sender who knows one address on it can put that
 * address in `From:` and be captured. The list is still worth having — it keeps
 * the ordinary internet out of somebody's context — but it is not a boundary,
 * and nothing in this codebase may describe it as one. `renderCaptureNote`
 * carries the honest label into the note, and the console copy in
 * `apps/mobile/features/console/ingestion/` says the same thing to the owner.
 *
 * The refusals that remain are the structural ones — a recipient that is not
 * ours, a reserved name, a message too large or unparseable, an unusable target
 * folder, an empty message, a sender the owner's list does not admit. None of
 * those are about trust.
 *
 * ============================================================================
 * REFUSALS CARRY NOTHING
 * ============================================================================
 *
 * Every refusal is `{ kind: "refuse", reason }` where `reason` is a fixed
 * enum member used **only for this Worker's own structured logs**. It is never
 * rendered, returned to a sender, or used to choose an SMTP response: `index.ts`
 * turns every refusal — unknown recipient, a name that is a shared context,
 * disallowed sender, over quota, storage failure — into the same frozen
 * rejection.
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
// The control plane's own folder rules, imported rather than restated — the
// same function `updateIngestionSettings` validates a folder with. See
// `normalizeTargetFolder` below for why this Worker checks them again.
import { normalizeTargetFolder as controlPlaneFolderRules } from "../../../apps/convex/functions/lib/ingestion";
// The same adapter-boundary prefix rules the gateway uses, rather than a second
// opinion about what a safe key prefix is. See apps/mcp/src/store/index.js.
import { assertSafePrefix } from "../../../apps/mcp/src/store/index.js";
import { describeArcShape, describeSender } from "./auth";
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
  | "invalid_target_folder"
  | "control_plane_unavailable"
  | "storage_unavailable"
  | "write_failed";
// There is deliberately no `auth_*` member any more. Authentication cannot
// refuse a message — see the block at the top of this file — so a reason for it
// would be a reason nothing produces, and a dead enum member is an invitation
// to wire it back up without reading why it went.

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
    /** The method that passed, or the literal `none`. Never a guess. */
    authMethod: string;
    /**
     * Why nothing passed, as a fixed `AuthFailure` member; absent on a verified
     * capture. This is where the operator now sees what used to be a refusal
     * reason, and it is the only way to notice that every message on a
     * deployment is arriving unverified.
     */
    authFailure?: string;
    /**
     * A bounded description of the message's ARC shape — integers and one
     * closed enum, never a sender string. Present only when the operator set
     * `LOG_ARC_SHAPE` and the message was not verified. See `describeArcShape`
     * in ./auth.ts for what it is for and why it is safe to log.
     */
    arc?: string;
    attachmentCount: number;
    problems: string[];
  };
}

export interface RefuseDecision {
  kind: "refuse";
  reason: RefusalReason;
}

export type IngestDecision = CaptureDecision | RefuseDecision;

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
  /**
   * Emit the bounded ARC shape alongside an unverified capture.
   *
   * Off unless the operator turns it on. It exists because whether the ARC path
   * in ./auth.ts can ever fire depends on header positions nobody has yet
   * captured from a real Cloudflare delivery, and "every capture is unverified"
   * is not a diagnosis. It used to ride on a refusal; there is no
   * authentication refusal left to ride on.
   */
  arcDiagnostics?: boolean;
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

/** Where a capture lands when the owner has not configured anything. */
export const DEFAULT_TARGET_FOLDER = "0-inbox/";

/**
 * Validate the target folder the control plane handed back.
 *
 * Returns `null` for anything unusable rather than silently falling back to the
 * default: a folder the control plane stored and this Worker ignored is a
 * capture filed somewhere the owner is not looking, which is worse than a
 * refusal they can see in their logs.
 *
 * ## Two checks, because they are two different questions
 *
 * `controlPlaneFolderRules` is the product rule — the same
 * `normalizeTargetFolder` that `updateIngestionSettings` refuses a bad folder
 * with, imported rather than restated. It is what refuses `..`, and what
 * refuses **any dot-prefixed segment**: `.history/` and `.audit/` are the
 * on-bucket plumbing, and a capture landing in `.history/` would forge note
 * history. That is the one this Worker used to be missing, and the gap was
 * silent — a stored `.history/` folder, from a row written before that rule or
 * by any future path that skips it, would have been accepted here.
 *
 * `assertSafePrefix` is the adapter rule — what `S3Store` and `R2Store` agree
 * is an addressable prefix. It is deliberately not the same set: it knows
 * nothing about `.history/`, and the product rule knows nothing about the
 * adapter's key length.
 *
 * Both must pass. Re-validating what the control plane already validated is the
 * point: this Worker is a separate deployment, and a receiver that trusts the
 * answer it was given has no defence left when the answer is wrong.
 *
 * ## The product rule's *verdict* is used; its repairs are not
 *
 * `controlPlaneFolderRules` canonicalises as well as validates — it collapses
 * `a//b` to `a/b` and hands that back. That is right on the write path, where a
 * person is typing a folder and a tidy-up is a kindness. It is wrong here.
 *
 * The control plane stores the canonical form, so a folder arriving with a
 * double slash means the answer did not come from the write path this Worker
 * thinks it did. Accepting a repaired version of it would file a capture at a
 * key nobody stored, which is the same failure as ignoring the folder outright.
 * So `assertSafePrefix` and the returned key are both computed from what we
 * were actually given, and the product rule contributes a yes/no and nothing
 * else.
 */
export function normalizeTargetFolder(value: string): string | null {
  const raw = singleLine(value ?? "");
  if (!raw) return DEFAULT_TARGET_FOLDER;
  if (raw.length > 200) return null;

  const trimmed = raw.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!trimmed) return null;

  // The verdict only. See above.
  if (!controlPlaneFolderRules(trimmed).ok) return null;

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

  // ── Authentication: evaluated in full, acted on not at all. ───────────────
  //
  // The verdict is still computed before the allow-list — the ordering never
  // mattered for correctness, only for what we did next — and it now becomes a
  // label the note carries. See the block at the top of this file.
  const authInput = {
    authenticationResults: parsed.authenticationResults,
    authenticationResultsFolded: parsed.authenticationResultsFolded,
    authenticationResultsFirstLine: parsed.authenticationResultsFirstLine,
    arcAuthenticationResults: parsed.arcAuthenticationResults,
    fromAddress: parsed.fromAddress,
    authServiceId: config.authServiceId,
  };
  const identity = describeSender(authInput);

  // ── The allow-list, applied to the identity on the message. ───────────────
  //
  // Proved when `identity.verified`; claimed otherwise. This is the seam where
  // the trade-off actually lands, so it is worth being exact about what happens
  // next: an unverified address that matches the list is captured, and the note
  // says it was not verified. An address that matches nothing is refused, which
  // is the same refusal it always was and is not about trust — it is the owner
  // saying they do not want mail from there.
  //
  // A message with no parseable `From:` refuses here rather than anywhere
  // special: `senderIsAllowed` returns false for an unparseable address *before*
  // it consults `allowAnySender`, so "anyone" still does not mean "nobody in
  // particular".
  let allowed: boolean;
  try {
    allowed = matcher(identity.address, config.policy) === true;
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
    sender: identity.address,
    senderDomain: identity.domain,
    verified: identity.verified,
    authMethod: identity.method,
    authFailure: identity.failure,
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
      sender: identity.address,
      senderDomain: identity.domain,
      authMethod: identity.method ?? "none",
      ...(identity.failure ? { authFailure: identity.failure } : {}),
      // Only when an operator asked for it, and only when there is something to
      // diagnose. Absent by default, so an ordinary capture logs exactly the
      // fields it always did.
      ...(config.arcDiagnostics && !identity.verified
        ? { arc: describeArcShape(authInput) }
        : {}),
      attachmentCount: rendered.length,
      problems: parsed.problems,
    },
  };
}
