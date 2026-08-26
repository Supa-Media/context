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
 * `reason` from the same vocabulary `checkNameAvailable` returns, and it means
 * the name went between the availability check and the claim — so the flow has
 * to put somebody back on the name field with the right sentence rather than
 * showing a dead end. `createWorkspace` re-checks inside its transaction, which
 * is what makes that race real and narrow.
 */

import { convexErrorParts } from "../console/storage/errors";
import type { NameRejection } from "@context/convex/functions/lib/names";

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
    headline: "You already have as many contexts as one account can own",
    next: "This is a limit on creating them, not on using them. Get in touch if you genuinely need more.",
  },
  RATE_LIMITED: {
    headline: "That's a lot of contexts in one go",
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

/** Describe a failed `createWorkspace`. */
export function describeCreateFailure(error: unknown): CreateFailure {
  const { code, message } = convexErrorParts(error);

  if (code === "NAME_UNAVAILABLE") {
    return {
      headline: "That name just went",
      next: "Somebody claimed it while you were typing. Pick another one.",
      nameRejection: rejectionFrom(error) ?? "taken",
    };
  }

  const known = code === undefined ? undefined : BY_CODE[code];
  if (known !== undefined) return known;

  return {
    headline: "We couldn't create your context",
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
        : "") + "Your context and your bucket are fine — you can make folders in the console.",
  };
}
