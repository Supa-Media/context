/**
 * Classifying and narrating a failed Cloudflare provisioning call.
 *
 * Split out of `lib/cloudflare.ts` — see that file's header for what the whole
 * module is for and the credential-handling rules it follows.
 */

import { scopedTokenName } from "./naming";

/**
 * How a provisioning attempt failed, as something a client can branch on.
 *
 * Same discipline as `VerificationErrorCode` in `functions/provisioning.ts`:
 * coarse, closed, and each value maps to a different thing the owner does.
 *
 *  - `R2_NOT_ENTITLED`             — R2 is not switched on for this account.
 *                                    See `NOT_ENTITLED_MESSAGE`; this one is
 *                                    not a storage error and must not be
 *                                    reported as one.
 *  - `BUCKET_NAME_TAKEN`           — a bucket of that name already exists.
 *                                    Choose another name.
 *  - `INVALID_BUCKET_NAME`         — refused before any call was made.
 *  - `CREDENTIAL_REJECTED`         — Cloudflare did not accept the credential.
 *                                    Paste a new one.
 *  - `INSUFFICIENT_PERMISSIONS`    — accepted, but not allowed to do this.
 *  - `PERMISSION_GROUP_UNAVAILABLE`— the write permission group was not in the
 *                                    list Cloudflare returned, so no correctly
 *                                    scoped key can be minted. Never mint a
 *                                    broader one instead.
 *  - `CLOUDFLARE_UNAVAILABLE`      — 5xx or no answer. Retry.
 *  - `PROVISION_EXPIRED`           — the attempt never finished and was swept.
 *                                    Never returned by `classifyCloudflareFailure`;
 *                                    written by the cron that destroys the
 *                                    sealed setup credential of an abandoned
 *                                    run. In the list because it lands in the
 *                                    same field and a client branches on it the
 *                                    same way.
 *  - `PROVISION_FAILED`            — anything else. Show the detail.
 */
export type ProvisionErrorCode =
  | "R2_NOT_ENTITLED"
  | "BUCKET_NAME_TAKEN"
  | "INVALID_BUCKET_NAME"
  | "CREDENTIAL_REJECTED"
  | "INSUFFICIENT_PERMISSIONS"
  | "PERMISSION_GROUP_UNAVAILABLE"
  | "CLOUDFLARE_UNAVAILABLE"
  | "PROVISION_EXPIRED"
  | "PROVISION_FAILED";

/**
 * Which call an attempt was making when it failed.
 *
 * **The classifier alone cannot tell an honest story.** "Cloudflare refused"
 * means nothing was created when it is the permission-group lookup, and means a
 * bucket now exists in somebody's account when it is the mint that follows the
 * create. The old code emitted one message for both, and the message said
 * "Nothing was changed" — which is exactly the instruction that walks a person
 * into `BUCKET_NAME_TAKEN` on the bucket we made for them one attempt earlier.
 *
 * So a stage travels with every failure, and `residueAfterFailure` turns it
 * into the only thing the person actually needs: what is in their Cloudflare
 * account now.
 */
export type ProvisionStage =
  | "resolve-permission-group"
  | "create-bucket"
  | "mint-token"
  | "store-binding";

/**
 * What an attempt left behind in the customer's account when it failed.
 *
 *  - `nothing`         — no bucket, no token. The only case that may say so.
 *  - `possible-bucket` — the create call never got an answer, so the bucket may
 *                        or may not be there. Claiming either way is a guess.
 *  - `bucket`          — a bucket exists, made by us, empty.
 *  - `bucket-and-token`— a bucket exists and so does an API token we minted and
 *                        could not take back. The one residue the person has to
 *                        act on rather than just know about.
 */
export type AttemptResidue =
  | "nothing"
  | "possible-bucket"
  | "bucket"
  | "bucket-and-token";

/**
 * What is left in the customer's account, from the stage and the code.
 *
 * The asymmetry in `create-bucket` is the whole point: a classified refusal is
 * Cloudflare telling us it did not create anything, whereas a 5xx or a socket
 * that never answered leaves the question genuinely open — the request may have
 * been processed and the answer lost. Only the first may say "nothing".
 */
export function residueAfterFailure(
  stage: ProvisionStage,
  errorCode: ProvisionErrorCode,
  tokenRevoked = false,
): AttemptResidue {
  switch (stage) {
    case "resolve-permission-group":
      return "nothing";
    case "create-bucket":
      return errorCode === "CLOUDFLARE_UNAVAILABLE" ? "possible-bucket" : "nothing";
    case "mint-token":
      return "bucket";
    case "store-binding":
      // The token was minted. If we managed to delete it again, all that is
      // left is the bucket; if we did not, say so rather than leaving a
      // credential in somebody's account that nothing here records.
      return tokenRevoked ? "bucket" : "bucket-and-token";
  }
}

/**
 * The sentence that says what exists now, and what to do about it.
 *
 * Written as a whole sentence per residue rather than assembled from clauses,
 * because the failure modes here are prose failures: "Nothing was changed; try
 * again shortly" was true of one branch and false of two, and no amount of
 * string concatenation would have caught that.
 */
export function residueSentence(
  residue: AttemptResidue,
  facts: { bucket: string },
): string {
  const bucket = `"${facts.bucket}"`;
  switch (residue) {
    case "nothing":
      return "Nothing was created in your Cloudflare account.";
    case "possible-bucket":
      return `Cloudflare never answered, so the bucket ${bucket} may or may not have been created. Try again with the same name — Context reuses a bucket it created itself.`;
    case "bucket":
      return `The bucket ${bucket} was created in your Cloudflare account and is empty. Try again with the same name once that is fixed — Context reuses the bucket it created rather than needing a new name.`;
    case "bucket-and-token":
      return `The bucket ${bucket} was created in your Cloudflare account, along with an API token named ${JSON.stringify(scopedTokenName(facts.bucket))} that Context could not delete again. Remove that token in the Cloudflare dashboard, then try again with the same name.`;
  }
}

/**
 * The recorded message for a failed attempt: what went wrong, then what exists.
 *
 * One composer, so the two halves cannot disagree. Everything that records a
 * provisioning failure goes through here.
 */
export function provisionFailureMessage(input: {
  /** The classifier's sentence, or ours for a failure Cloudflare had no part in. */
  message: string;
  stage: ProvisionStage;
  errorCode: ProvisionErrorCode;
  bucket: string;
  tokenRevoked?: boolean;
}): string {
  const residue = residueAfterFailure(
    input.stage,
    input.errorCode,
    input.tokenRevoked ?? false,
  );
  return `${input.message} ${residueSentence(residue, { bucket: input.bucket })}`;
}

/**
 * What a name that is already taken means when we cannot prove we made it.
 *
 * Deliberately not the classifier's `BUCKET_NAME_TAKEN` message: this one is
 * emitted after asking Cloudflare when the bucket was created and finding it
 * predates this attempt. Saying so matters — the person's next move is
 * different when the bucket is theirs from before than when it is ours.
 */
export function bucketNotOursMessage(bucket: string): string {
  return `A bucket named "${bucket}" already exists in this Cloudflare account and Context cannot tell that it created it, so it will not touch it. Choose a different name, or connect that bucket directly with its own access key.`;
}

/**
 * THE MESSAGE FOR ERROR 10042, WRITTEN ON PURPOSE.
 *
 * Cloudflare requires a payment method on the account before R2 will accept a
 * bucket, even for usage that never leaves the free tier. The same error
 * appears months later if a card expires, and when it does Cloudflare blocks
 * access to the bucket while leaving every object in it intact.
 *
 * So this is a durable, non-alarming state with a one-time fix, and the wording
 * has three jobs: say what to do, say that it is free, and say whose
 * requirement the card is. "Storage error, contact support" would be true,
 * useless, and would make us answer for somebody else's billing rule.
 */
export const NOT_ENTITLED_MESSAGE =
  "Cloudflare has not enabled R2 on this account yet. Complete R2 checkout once in the Cloudflare dashboard — R2 is free below its included limits, and the card on file is Cloudflare's requirement, not ours. Your notes are untouched; try again afterwards.";

/** What a classified failure carries. `detail` is provider text, never ours. */
export interface ProvisionFailure {
  errorCode: ProvisionErrorCode;
  message: string;
}

/** One error object out of a Cloudflare API envelope. */
export interface CloudflareApiErrorEntry {
  code?: number;
  message?: string;
}

/** Every Cloudflare API response has this shape, success or failure. */
export interface CloudflareEnvelope<T> {
  success?: boolean;
  errors?: CloudflareApiErrorEntry[];
  result?: T;
}

/**
 * A Cloudflare call that did not succeed, already classified.
 *
 * Carries no request headers and no token — an exception is one of the easiest
 * places in a system for a credential to escape, and this one is caught,
 * recorded on a row, and shown to a person.
 */
export class CloudflareApiError extends Error {
  readonly errorCode: ProvisionErrorCode;
  /** Provider text, for the honest half of the recorded error. May be empty. */
  readonly detail: string;

  constructor(failure: ProvisionFailure, detail: string) {
    super(failure.message);
    this.name = "CloudflareApiError";
    this.errorCode = failure.errorCode;
    this.detail = detail;
  }
}

/**
 * Map an HTTP status and Cloudflare's own error codes onto our closed set.
 *
 * Code first, status second: Cloudflare's numeric codes are the specific
 * signal, and 10042 in particular arrives as a 403, which would otherwise be
 * indistinguishable from "this token may not do that" — two failures with
 * completely different fixes.
 */
export function classifyCloudflareFailure(input: {
  status: number;
  errors?: CloudflareApiErrorEntry[];
}): ProvisionFailure {
  const codes = (input.errors ?? [])
    .map((entry) => entry.code)
    .filter((code): code is number => typeof code === "number");

  // 10042 `NotEntitled`. Checked before anything else, including before the
  // status, because it is the one failure here that is neither the customer's
  // mistake nor ours.
  if (codes.includes(10042)) {
    return { errorCode: "R2_NOT_ENTITLED", message: NOT_ENTITLED_MESSAGE };
  }
  // 10073: a bucket of that name is already in this account.
  if (codes.includes(10073) || input.status === 409) {
    return {
      errorCode: "BUCKET_NAME_TAKEN",
      message:
        "A bucket with that name already exists in this Cloudflare account. Choose a different name, or connect the existing bucket directly with its own access key.",
    };
  }
  if (input.status === 401 || codes.includes(10000)) {
    return {
      errorCode: "CREDENTIAL_REJECTED",
      message:
        "Cloudflare did not accept that credential. Create a fresh API token and try again.",
    };
  }
  if (input.status === 403) {
    return {
      errorCode: "INSUFFICIENT_PERMISSIONS",
      message:
        'That credential is valid but not allowed to do this. It needs "Workers R2 Storage" edit and "Account API Tokens" write on the account you chose.',
    };
  }
  if (input.status >= 500) {
    // No claim about what was or was not changed: this classifier does not
    // know which call it is classifying, and a 5xx is precisely the answer
    // that leaves that open. `provisionFailureMessage` adds the half this
    // cannot know.
    return {
      errorCode: "CLOUDFLARE_UNAVAILABLE",
      message: "Cloudflare did not answer.",
    };
  }
  return {
    errorCode: "PROVISION_FAILED",
    message: "Cloudflare refused the request.",
  };
}

