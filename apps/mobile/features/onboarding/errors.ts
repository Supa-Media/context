/**
 * What went wrong claiming a name, in a sentence and a next step.
 *
 * The same bargain `console/storage/errors.ts` describes: the control plane
 * hands back a `code` from a closed set plus a `message` written for a human,
 * and the client branches on the code. `convexErrorParts` is reused rather than
 * rewritten — a thrown `ConvexError` has the same shape whichever function
 * threw it.
 *
 * The one case that is not just copy is `NAME_UNAVAILABLE`. It carries a
 * `reason` from the same vocabulary `checkNameAvailable` returns, and
 * `NameStep` uses it to put somebody back on the field with the sentence for
 * *that* reason — see `nameRejection` below.
 *
 * ## Why the reason has to be read
 *
 * `createWorkspace` throws `NAME_UNAVAILABLE` for **every** refusal, not just a
 * lost race: reserved, too long, bad characters, the punycode-shaped forms.
 * Treating the code alone as "somebody beat you to it" told a person typing
 * `@postmaster` that it had just been claimed while they were typing — a name
 * nobody has ever held and nobody ever can. The reason is the difference
 * between an accurate sentence and a fabricated one, so it is not optional
 * decoration on this type.
 */

import { convexErrorParts } from "../console/storage/errors";
import { describeRejection, type NameRejection } from "@context/convex/functions/lib/names";

export interface CreateFailure {
  headline: string;
  next?: string;
  /**
   * Present when the name itself was refused. The screen sends the person back
   * to the field instead of showing a panel they cannot act on.
   */
  nameRejection?: NameRejection;
}

const BY_CODE: Record<string, { headline: string; next?: string }> = {
  WORKSPACE_LIMIT_REACHED: {
    headline: "You already have as many brains and workspaces as one account can own",
    next: "This is a limit on creating them, not on using them. Get in touch if you genuinely need more.",
  },
  RATE_LIMITED: {
    headline: "That's a lot to create in one go",
    next: "Creating them is limited to a few an hour. Try again shortly.",
  },
  INVALID_DISPLAY_NAME: {
    headline: "That name won't work as a label",
    next: "Pick something between 1 and 80 characters.",
  },
  NOT_AUTHENTICATED: {
    headline: "Your session ended",
    next: "Sign in again — nothing was created.",
  },
};

function rejectionFrom(error: unknown): NameRejection | undefined {
  const data = (error as { data?: unknown } | null)?.data;
  if (typeof data !== "object" || data === null) return undefined;
  const reason = (data as { reason?: unknown }).reason;
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
      return undefined;
  }
}

/**
 * The headline for a refused name, by reason.
 *
 * Only `taken` is a race. The rest are properties of the name itself and were
 * true before the person pressed anything, so the copy says what is wrong
 * rather than inventing a rival claimant. The detail sentence comes from
 * `describeRejection`, which is the control plane's own wording — one copy of
 * these rules, in the module that enforces them.
 */
function nameFailureCopy(reason: NameRejection): { headline: string; next: string } {
  switch (reason) {
    case "taken":
      return {
        headline: "That name just went",
        next: "Somebody claimed it while you were typing. Pick another one.",
      };
    case "reserved":
    case "reserved_label_form":
      return { headline: "That name is reserved", next: describeRejection(reason) };
    default:
      return { headline: "That name won't work", next: describeRejection(reason) };
  }
}

/** Describe a failed `createWorkspace`. */
export function describeCreateFailure(error: unknown): CreateFailure {
  const { code, message } = convexErrorParts(error);

  if (code === "NAME_UNAVAILABLE") {
    // Absent only from a backend older than the reason field. "Taken" is the
    // right guess there: it is the one refusal the local checks cannot predict,
    // so it is overwhelmingly the one that reaches here.
    const reason = rejectionFrom(error) ?? "taken";
    return { ...nameFailureCopy(reason), nameRejection: reason };
  }

  const known = code === undefined ? undefined : BY_CODE[code];
  if (known !== undefined) return known;

  return {
    headline: "We couldn't create your brain",
    next:
      message !== undefined && message.trim().length > 0
        ? message.trim()
        : "Nothing was created. Try again in a moment.",
  };
}

/**
 * Describe a failed attempt to lay down a starting layout.
 *
 * Deliberately gentle, because this one is genuinely not important: the name is
 * claimed, the bucket is connected, and folders are something the console makes
 * in one click. Failing here must not read as a failed signup.
 */
export function describeStructureFailure(error: unknown): CreateFailure {
  const { message } = convexErrorParts(error);
  return {
    headline: "We couldn't lay down those folders",
    next:
      (message !== undefined && message.trim().length > 0
        ? `${message.trim()} `
        : "") + "Your brain and your bucket are fine — you can make folders in the console.",
  };
}
