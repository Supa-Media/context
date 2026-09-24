/**
 * Shared constants, small formatters and validators for `functions/cloudflare.ts`.
 *
 * Split out of `functions/cloudflare.ts` — see that file's header for the
 * whole flow this belongs to and the credential-handling rules it follows.
 */

import { v } from "convex/values";

export const jurisdictionValidator = v.union(
  v.literal("default"),
  v.literal("eu"),
  v.literal("fedramp"),
);

/**
 * How many buckets one workspace may ask us to create per hour.
 *
 * Every accepted request creates real objects in a customer's cloud account, so
 * an unlimited version is a way to fill somebody's account with buckets using a
 * credential they gave us for one. Keyed by workspace for the same reason
 * `reverifyStorage` is: the workspace is what has storage.
 */
export const PROVISION_LIMIT = 5;
export const PROVISION_WINDOW_MS = 60 * 60 * 1000;

/**
 * Cap on recorded failure text.
 *
 * Larger than the bindings' 300 because our half of this string now has two
 * jobs — what went wrong, and what exists in the customer's Cloudflare account
 * because of it — and the second half is the actionable one. `fail` truncates
 * Cloudflare's detail to protect it, and this bound is what remains for the
 * pathological case where our own two sentences are long.
 */
export const MAX_RECORDED_ERROR_LENGTH = 500;

/**
 * How long an unfinished attempt may hold the sealed setup credential.
 *
 * Three Cloudflare calls with a 15-second deadline each, so a run that has not
 * finished in fifteen minutes is not running. What expires is not the attempt's
 * *result* — it is the credential: `purgeExpiredProvisioning` marks the row
 * failed and strips the envelope, which is the only thing standing between "a
 * scheduled job was lost to a deploy" and an account-level Cloudflare
 * credential sitting in the control plane indefinitely.
 */
export const PROVISION_ATTEMPT_TTL_MS = 15 * 60 * 1000;

/**
 * How long a failed attempt's *explanation* is kept.
 *
 * The row carries no credential once it has failed; what it carries is the
 * sentence the owner needs to read, including "we created this bucket, retry
 * with the same name". Deleting that promptly would delete the recovery
 * instructions, so the second deadline is a week rather than an hour.
 */
export const FAILED_ATTEMPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Rows per sweep run. A backlog drains over several runs, like the others. */
export const SWEEP_BATCH_SIZE = 200;

/** `" (Cloudflare: )"` — the wrapper around provider detail, as a length. */
export const DETAIL_WRAPPER_LENGTH = 15;

/** Below this, provider detail is a fragment rather than a clue. Drop it. */
export const MIN_DETAIL_LENGTH = 24;

/** Truncation with an ellipsis, used on recorded text and nothing else. */
export function truncated(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** What the provisioning action reports. Deliberately free of any credential. */
export interface ProvisionOutcome {
  ok: boolean;
  errorCode?: string;
}
