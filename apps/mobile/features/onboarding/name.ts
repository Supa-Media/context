/**
 * Picking the name, as a state machine.
 *
 * This is the most consequential field in the product and the copy has to say
 * so. The name someone types here becomes, all at once:
 *
 *  - their personal context — the one they are only ever allowed one of;
 *  - the path other people address them by, `@name/1-projects/note.md`;
 *  - the mailbox they forward things into, `name@context.lc`.
 *
 * And it cannot be changed afterwards. There is no release, rename, or reclaim
 * path anywhere in the control plane (issue #10), so "you can sort it out
 * later" is not true and must not be implied. The screen says this before the
 * field, not in a footnote under it.
 *
 * ## Where the rules come from
 *
 * `validateName` and the reserved list are **imported from the control plane**
 * rather than copied. That is a deliberate departure from the local copy of
 * `addressingIsAmbiguous` in `console/storage/errors.ts`: there, a drifted copy
 * costs one wasted round trip. Here it would show somebody a green tick on a
 * name the server is about to refuse — and the reserved list is a security
 * control (it decides who receives `support@` the apex domain), so two copies
 * of it is exactly the wrong number. `functions/lib/names.ts` imports nothing,
 * so this costs the bundle a regex and a Set.
 *
 * The shape check runs locally so that a half-typed name never reaches
 * `checkNameAvailable`, which requires auth and is deliberately not rate
 * limited (it cannot be — it is a query). Availability itself is always the
 * server's answer, never inferred here.
 */

import {
  NAME_MAX_LENGTH,
  NAME_MIN_LENGTH,
  describeRejection,
  normalizeName,
  validateName,
  type NameRejection,
} from "@context/convex/functions/lib/names";

export { NAME_MAX_LENGTH, NAME_MIN_LENGTH };

/** What `checkNameAvailable` hands back. */
export interface NameAvailability {
  available: boolean;
  normalized: string;
  reason?: string;
  message?: string;
}

export type NameStatus =
  /** Nothing typed yet. */
  | { kind: "empty" }
  /** Badly formed — wrong characters, too short, too long, stray hyphen. */
  | { kind: "malformed"; normalized: string; reason: NameRejection }
  /** Well formed, but ours and never claimable. */
  | { kind: "reserved"; normalized: string; reason: NameRejection }
  /** Well formed; the server has not answered yet. */
  | { kind: "checking"; normalized: string }
  /** Well formed, free, and not reserved. */
  | { kind: "available"; normalized: string }
  /** Somebody got there first. */
  | { kind: "taken"; normalized: string };

/**
 * The two rejections that mean "this name is not available to anybody" rather
 * than "you typed it wrong". Worth separating because the fix is different:
 * a malformed name is edited, a reserved one is abandoned.
 */
function isReservedReason(reason: NameRejection): boolean {
  return reason === "reserved" || reason === "reserved_label_form";
}

function asRejection(reason: string | undefined): NameRejection | null {
  switch (reason) {
    case "too_short":
    case "too_long":
    case "invalid_characters":
    case "invalid_start_or_end":
    case "reserved_label_form":
    case "reserved":
    case "taken":
      return reason;
    default:
      return null;
  }
}

/**
 * Should we ask the server about this name at all?
 *
 * Only once it is well formed. Firing a query per keystroke of `s`, `se`,
 * `sey` teaches the namespace to anybody watching and answers a question the
 * local rules already answered.
 */
export function shouldCheckAvailability(raw: string): boolean {
  return validateName(raw).ok;
}

/** The name a claim would actually be made under. */
export function normalizedName(raw: string): string {
  return normalizeName(raw);
}

/**
 * Fold the typed value and the server's answer into one status.
 *
 * `availability` is the result for the *current* normalized name, or
 * `undefined` while that query is in flight. Passing a stale answer for a
 * different name is the caller's bug to avoid — `useOnboarding` keys the
 * subscription on the normalized name so a stale one cannot arrive.
 */
export function nameStatus(
  raw: string,
  availability: NameAvailability | undefined,
): NameStatus {
  const normalized = normalizeName(raw);
  if (normalized.length === 0) return { kind: "empty" };

  const shape = validateName(raw);
  if (!shape.ok) {
    return isReservedReason(shape.reason)
      ? { kind: "reserved", normalized, reason: shape.reason }
      : { kind: "malformed", normalized, reason: shape.reason };
  }

  if (availability === undefined) return { kind: "checking", normalized };
  if (availability.available) return { kind: "available", normalized };

  const reason = asRejection(availability.reason);
  if (reason === null || reason === "taken") return { kind: "taken", normalized };
  return isReservedReason(reason)
    ? { kind: "reserved", normalized, reason }
    : { kind: "malformed", normalized, reason };
}

/** Only a name the server has confirmed free may be submitted. */
export function canClaim(status: NameStatus): boolean {
  return status.kind === "available";
}

export interface NameFeedback {
  tone: "neutral" | "ok" | "crit";
  message: string;
}

/**
 * What to say under the field.
 *
 * Three failures, three different sentences, because the reader's next move is
 * different in each. "That name is unavailable" for all of them is the
 * unhelpful version this avoids.
 */
export function nameFeedback(status: NameStatus): NameFeedback | null {
  switch (status.kind) {
    case "empty":
      return null;
    case "checking":
      return { tone: "neutral", message: "Checking…" };
    case "available":
      return {
        tone: "ok",
        message: `@${status.normalized} is free. It's yours when you continue.`,
      };
    case "taken":
      return {
        tone: "crit",
        message: `Somebody already has @${status.normalized}. Names are first come, first served — try another, or add a word that's yours.`,
      };
    case "reserved":
      return {
        tone: "crit",
        message:
          status.reason === "reserved"
            ? `@${status.normalized} is reserved. Some names have to keep working as part of the system — including the mail sent to them — so they're never handed out.`
            : `@${status.normalized} can't be used: two hyphens in the third and fourth positions are reserved by the standard that turns names into web addresses.`,
      };
    case "malformed":
      return { tone: "crit", message: describeRejection(status.reason) };
  }
}

/**
 * The three things the name becomes, ready to render.
 *
 * Kept here rather than inline in the component so the examples cannot drift
 * from the format the gateway and the ingestion alias actually use, and so a
 * test can assert them.
 */
export function nameConsequences(name: string): {
  context: string;
  path: string;
  mailbox: string;
} {
  const shown = name.length > 0 ? name : "yourname";
  return {
    context: `@${shown}`,
    path: `@${shown}/1-projects/note.md`,
    mailbox: `${shown}@context.lc`,
  };
}
