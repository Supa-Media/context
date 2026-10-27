/**
 * Parsing who an invitation is addressed to.
 *
 * Sharing is addressed by name (`@lk`), by email or by phone number, and this
 * module turns what somebody typed into one of those, or rejects it. It is **pure** — no
 * database, no `ctx` — and that is a security property rather than a taste in
 * module boundaries:
 *
 * `inviteMember` must refuse a malformed invitee *without having looked
 * anything up*, because the only refusal an invite is allowed to produce is one
 * about the string itself. The moment a rejection could depend on what is in
 * the `names` or `users` table, the invite box becomes an existence oracle for
 * every handle and every address on the platform. Keeping the syntax judgment
 * in a file that cannot reach a database is how that stays true under a
 * refactor by somebody who has not read this comment.
 *
 * The database half — "is there a person behind this identifier?" — lives in
 * `functions/invitations.ts`, is asked only *after* an invitation row has been
 * committed either way, and never changes what the caller is told.
 */

import { ConvexError } from "convex/values";
import { normalizeEmail } from "@context/shared";
import { validateName, type NameRejection } from "./names";

/**
 * How an invitation names its recipient. `phone` is an E.164 number (the
 * owner, 2026-10-27): family in a Tex group chat who will never click an
 * invitation are invited by the number they text from, and that invitation
 * counts in the chat until they sign in with it
 * (`docs/decisions/texting-assistant/invited-family.md`).
 */
export type InviteeKind = "name" | "email" | "phone";

export interface Invitee {
  kind: InviteeKind;
  /**
   * Normalized and undecorated: `lk`, not `@lk`. The `@` is presentation — see
   * `formatInvitee` — and storing it would mean two spellings of one key.
   */
  value: string;
}

/** Why a candidate invitee was rejected. Stable codes; clients map these to copy. */
export type InviteeRejection =
  | "empty"
  | "invalid_email"
  | "invalid_phone"
  | { name: NameRejection };

export type InviteeParse =
  | { ok: true; invitee: Invitee }
  | { ok: false; reason: InviteeRejection };

/**
 * The longest an address may be, from RFC 5321 §4.5.3.1.3.
 *
 * A bound here rather than only at the schema keeps a megabyte of text from
 * becoming an index key.
 */
const MAX_EMAIL_LENGTH = 254;

/**
 * Deliberately narrower than RFC 5322.
 *
 * A full-grammar email validator accepts quoted local parts, comments, and
 * bare-domain addresses, none of which anybody types into a share box and all
 * of which are extra ways for two spellings to mean one mailbox. This accepts
 * `local@label.tld` with at least one dot in the domain, no whitespace, and no
 * second `@`. Something legitimate and exotic will occasionally be refused;
 * that is a support conversation, whereas an ambiguous key is a bug in the
 * addressing scheme.
 */
const EMAIL_PATTERN = /^[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+$/;

/**
 * Whether the string is trying to be an email rather than a handle.
 *
 * An `@` at position 0 is the handle sigil (`@lk`); an `@` anywhere else is a
 * mailbox separator. Splitting on position rather than on "does it look like an
 * email" means every input lands in exactly one branch, so no string can be
 * quietly reinterpreted as the other kind later.
 */
function looksLikeEmail(trimmed: string): boolean {
  return trimmed.indexOf("@", 1) !== -1;
}

/**
 * Whether the string is trying to be a phone number rather than a handle: a
 * leading `+`, or digits written the way people write numbers (spaces, dashes,
 * dots, brackets). A bare run of digits stays a handle, so no handle that is
 * all digits is reinterpreted, except the two shapes a US number is typed in
 * (ten digits, or eleven starting with 1), which no person picks as a name.
 */
const PHONE_SHAPE = /^\+?[\d\s().-]+$/;
function looksLikePhone(trimmed: string): boolean {
  if (!PHONE_SHAPE.test(trimmed) || !/\d/.test(trimmed)) return false;
  if (trimmed.startsWith("+") || /[\s().-]/.test(trimmed)) return true;
  return /^(?:1)?\d{10}$/.test(trimmed);
}

/** E.164, the shape every phone column in the control plane holds (`textLinks.ts`). */
const E164 = /^\+[1-9]\d{7,14}$/;

/** The number as E.164, or null. A number without a country code is read as a US one. */
function normalizePhone(trimmed: string): string | null {
  const digits = trimmed.replace(/\D/g, "");
  let value: string;
  if (trimmed.startsWith("+")) value = `+${digits}`;
  else if (digits.length === 10) value = `+1${digits}`;
  else if (digits.length === 11 && digits.startsWith("1")) value = `+${digits}`;
  else return null;
  return E164.test(value) ? value : null;
}

/**
 * Parse an invitee, or say why not. Never touches a database.
 *
 * Emails are lowercased, by the shared `normalizeEmail`. That is not strictly
 * correct — RFC 5321 makes the local part case-sensitive — but every mail
 * provider anyone uses treats it as insensitive, and a case-sensitive key would
 * let `LK@example.com` and `lk@example.com` be two invitations to one mailbox,
 * one of which the recipient could never see because their account holds only
 * one spelling.
 */
export function parseInvitee(raw: string): InviteeParse {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };

  if (looksLikeEmail(trimmed)) {
    // `normalizeEmail` rather than `.toLowerCase()`: the sign-in screen has to
    // produce the same string for the same address, and it calls the same
    // function. See `packages/shared/src/email.ts` for what disagreeing costs.
    const value = normalizeEmail(trimmed);
    if (value.length > MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(value)) {
      return { ok: false, reason: "invalid_email" };
    }
    return { ok: true, invitee: { kind: "email", value } };
  }

  if (looksLikePhone(trimmed)) {
    const value = normalizePhone(trimmed);
    if (value === null) return { ok: false, reason: "invalid_phone" };
    return { ok: true, invitee: { kind: "phone", value } };
  }

  // One leading sigil, and only one: `@@lk` is not a handle.
  const candidate = trimmed.startsWith("@") ? trimmed.slice(1) : trimmed;
  const validation = validateName(candidate);
  if (!validation.ok) {
    return { ok: false, reason: { name: validation.reason } };
  }
  return { ok: true, invitee: { kind: "name", value: validation.normalized } };
}

/** Whether a note may be shared with this invitee: a @name or an address, never a phone number. */
export function shareableInvitee(invitee: Invitee): invitee is Invitee & { kind: "name" | "email" } {
  return invitee.kind === "name" || invitee.kind === "email";
}

/** How an invitee is shown, and how it is written into an audit row. */
export function formatInvitee(invitee: Invitee): string {
  return invitee.kind === "name" ? `@${invitee.value}` : invitee.value;
}

/**
 * The refusal for a string that is not a usable invitee.
 *
 * Says only what is wrong with the *string*. There is deliberately no variant
 * meaning "nobody is called that": whether an identifier belongs to a real
 * person is not something an inviter is ever told.
 */
export function inviteeRejectionError(
  reason: InviteeRejection,
): ConvexError<{ code: string; message: string; reason: string }> {
  if (reason === "empty") {
    return new ConvexError({
      code: "INVALID_INVITEE",
      reason: "empty",
      message: "Enter a @name or an email address.",
    });
  }
  if (reason === "invalid_phone") {
    return new ConvexError({
      code: "INVALID_INVITEE",
      reason: "invalid_phone",
      message: "That does not look like a phone number. Include the country code, like +1.",
    });
  }
  if (reason === "invalid_email") {
    return new ConvexError({
      code: "INVALID_INVITEE",
      reason: "invalid_email",
      message: "That does not look like an email address.",
    });
  }
  return new ConvexError({
    code: "INVALID_INVITEE",
    reason: `name_${reason.name}`,
    message:
      "A @name may only contain lowercase letters, numbers, and hyphens. Otherwise, use an email address.",
  });
}
