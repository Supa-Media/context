/**
 * Storage failures, turned into a sentence and a next step.
 *
 * The control plane deliberately hands back two things: `lastError`, which is
 * provider prose written for a human, and `errorCode`, which is a value from a
 * closed set so a client can branch without matching on English (see
 * `functions/provisioning.ts`, "THE CLOSED SET OF FAILURE CODES"). This module
 * is the client half of that bargain.
 *
 * The rule it follows: **the code decides what to do next, the message says
 * what happened.** So a mapped failure shows our sentence about the fix *and*
 * the provider's own words underneath, because "AccessDenied" from the provider
 * is often the only thing that identifies which policy is wrong. A code we do
 * not recognise falls back to showing `lastError` on its own rather than
 * inventing advice.
 */

export interface StorageFailure {
  /** What happened, in one line. */
  headline: string;
  /** What to do about it. Absent when there is nothing honest to suggest. */
  next?: string;
  /** The provider's own words, when there are any. */
  detail?: string;
  /**
   * True when the fix is choosing an addressing style. The connect form uses
   * this to reveal the `forcePathStyle` question, which is otherwise hidden.
   */
  needsAddressingChoice?: boolean;
}

const BY_CODE: Record<string, Omit<StorageFailure, "detail">> = {
  // ── Verification codes (`VerificationErrorCode`) ────────────────────────────
  AMBIGUOUS_ADDRESSING: {
    headline: "We can't tell how this bucket is addressed",
    next: "The endpoint's first host label is the bucket name, so it could be either style. Choose one below — guessing wrong writes to the wrong bucket, so nothing will guess for you.",
    needsAddressingChoice: true,
  },
  UNREACHABLE: {
    headline: "We couldn't list your bucket",
    next: "Check the endpoint, region, and bucket name, and that the access key is allowed to list this bucket.",
  },
  NOT_WRITABLE: {
    headline: "Your bucket can be read but not written to",
    next: "The access key needs permission to put and delete objects in this bucket.",
  },
  CREDENTIAL_UNAVAILABLE: {
    headline: "We can't open the stored credential any more",
    next: "Paste the access key and secret again to rebind. Your bucket and its contents are untouched.",
  },
  INVALID_CONFIGURATION: {
    headline: "Your provider refused this configuration",
    next: "Usually the bucket name or the root prefix. Check both and reconnect.",
  },
  PROBE_FAILED: {
    headline: "The check itself failed",
    next: "Nothing about your binding changed. Try Re-verify again in a moment.",
  },

  // ── Connect-time codes (thrown by `bindStorage`) ────────────────────────────
  INVALID_ENDPOINT: {
    headline: "That endpoint won't work",
    next: "It has to be a full https:// URL on the public internet, with no username or password in it.",
  },
  INVALID_BUCKET: {
    headline: "A bucket name is required",
  },
  INVALID_ROOT_PREFIX: {
    headline: "That root prefix won't work",
    next: "Use a plain folder path like `context/`. No `..`, and no leading slash.",
  },
  INVALID_CREDENTIAL: {
    headline: "Both an access key id and a secret are required",
  },
  NO_STORAGE_BINDING: {
    headline: "There's no bucket connected to check",
    next: "Connect one first.",
  },
  STORAGE_NOT_CONNECTED: {
    headline: "This bucket hasn't verified yet",
    next: "Run Re-verify, or reconnect with fresh credentials.",
  },
  RATE_LIMITED: {
    headline: "That's enough checks for now",
    next: "Re-verify is limited to a few runs an hour. Try again shortly.",
  },
  INSUFFICIENT_ROLE: {
    headline: "Only an owner can change storage",
    next: "Ask an owner of this context to reconnect or re-verify it.",
  },
  WORKSPACE_NOT_FOUND: {
    headline: "You don't have access to this context any more",
  },
  NOT_AUTHENTICATED: {
    headline: "Your session ended",
    next: "Sign in again and retry.",
  },
};

/**
 * Describe a failure from its code and the provider's message.
 *
 * Either may be absent. With neither, the caller gets an honest shrug rather
 * than a blank panel — a binding in `error` with nothing recorded is itself
 * information.
 */
export function describeStorageFailure(
  errorCode: string | undefined,
  message: string | undefined,
): StorageFailure {
  const known = errorCode === undefined ? undefined : BY_CODE[errorCode];
  const detail = message === undefined || message.trim().length === 0 ? undefined : message.trim();

  if (known !== undefined) return { ...known, detail };

  if (detail !== undefined) {
    return { headline: "Your bucket didn't check out", detail };
  }

  return {
    headline: "Your bucket didn't check out",
    next: "Run Re-verify to try again, or reconnect with fresh credentials.",
  };
}

/** Pull `{ code, message }` out of a thrown `ConvexError`, or a plain throw. */
export function convexErrorParts(error: unknown): {
  code: string | undefined;
  message: string | undefined;
} {
  const data = (error as { data?: unknown } | null)?.data;
  if (typeof data === "object" && data !== null) {
    const record = data as { code?: unknown; message?: unknown };
    return {
      code: typeof record.code === "string" ? record.code : undefined,
      message: typeof record.message === "string" ? record.message : undefined,
    };
  }
  if (typeof data === "string") return { code: undefined, message: data };
  if (error instanceof Error) return { code: undefined, message: error.message };
  return { code: undefined, message: undefined };
}

/** `describeStorageFailure` applied straight to something that was thrown. */
export function describeThrownStorageError(error: unknown): StorageFailure {
  const { code, message } = convexErrorParts(error);
  return describeStorageFailure(code, message);
}

/**
 * Whether an endpoint and bucket leave the addressing style genuinely open.
 *
 * A deliberate second copy of `addressingIsAmbiguous` in
 * `apps/convex/functions/storage.ts`, which is itself a second copy of the
 * check inside `S3Store`. Importing the Convex one is not an option — the
 * module pulls the whole server runtime into the app bundle — and mirroring
 * three lines is cheaper than shipping a form that asks everybody a question
 * about URL addressing styles.
 *
 * **The point of the copy is *when* the question appears, not whether.** The
 * backend still refuses an ambiguous bind that arrives without an explicit
 * answer; this only decides whether the field is on screen before you press
 * Connect. If the two ever drift, the backend wins and its
 * `AMBIGUOUS_ADDRESSING` reveals the field anyway — so the failure mode of a
 * drifted copy is one wasted round trip, not a wrong bucket.
 *
 * The rule: the endpoint's first host label is the bucket name, so nothing can
 * tell whether the bucket is in the host (virtual-hosted) or in the path.
 */
export function addressingIsAmbiguous(endpoint: string, bucket: string): boolean {
  if (bucket.length === 0) return false;
  let hostname: string;
  try {
    hostname = new URL(endpoint).hostname;
  } catch {
    // Not a URL at all. There is no addressing question to answer about a
    // string that is not an endpoint; the endpoint field reports that itself.
    return false;
  }
  return hostname.startsWith(`${bucket}.`);
}
