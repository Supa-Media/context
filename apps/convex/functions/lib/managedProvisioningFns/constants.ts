/**
 * Shared constants and small types for `functions/managedProvisioning.ts`.
 *
 * Split out of `functions/managedProvisioning.ts` — see that file's header
 * comment on `provisionManagedStorage` for the whole flow this belongs to.
 */

/**
 * A page is the unit of a scheduled action, and the unit progress is saved at.
 *
 * Larger than it was, because it is no longer walked one object at a time: a
 * page now costs about `MIGRATION_PAGE_SIZE / MIGRATION_WAVE_WIDTH` round trips
 * rather than one per object, so the per-action scheduling overhead is what a
 * small page was really buying. Still bounded, because a page that fails is a
 * page that is retried from its cursor, and nothing is saved mid-page.
 */
export const MIGRATION_PAGE_SIZE = 100;
export const MIGRATION_OBJECT_BYTE_CAP = 25 * 1024 * 1024;

/**
 * How many objects of a page are reconciled at once, and how many bytes of them
 * may be in flight together.
 *
 * The gateway's own wave width is 6, sized to the Workers limit on simultaneous
 * open connections. That reasoning does not reach here: this runs in a Convex
 * action, not a Worker, and the bound that matters instead is memory — one
 * object in flight holds its source bytes and its target bytes at once, and the
 * byte cap admits 25MB objects. So the width is the wider one an action can
 * actually use, and the byte budget is what keeps a page of attachments from
 * turning that width into a heap the action dies on.
 */
export const MIGRATION_WAVE_WIDTH = 16;
export const MIGRATION_WAVE_BYTE_BUDGET = 32 * 1024 * 1024;

export const MANAGED_STORAGE_SETTLE_POLL_MS = 5 * 1000;

/**
 * Failures that mean the same thing however many times they are tried.
 *
 * Everything else — a refused signature, a 404 for a bucket that exists, a
 * reset socket — is treated as a bucket that has not settled yet, because on
 * this path that is overwhelmingly what it is.
 */
export const TERMINAL_MIGRATION_ERRORS = new Set([
  "SOURCE_UNAVAILABLE",
  "OBJECT_TOO_LARGE",
]);

/** Ours, from a closed set. Never Cloudflare's text, which can name an account. */
export type ManagedProvisionError =
  | "NOT_CONFIGURED"
  | "NOT_ENTITLED"
  | "ALREADY_BOUND"
  | "CLOUDFLARE_REFUSED"
  | "PROVISION_FAILED";

/**
 * The R2 permission group a bucket-scoped token needs, by name.
 *
 * Resolved at runtime rather than hardcoded, exactly as the BYO path does it:
 * only the read group's id is published, and a hardcoded id would be a guess
 * about what a token is allowed to do.
 */
export const R2_BUCKET_WRITE_PERMISSION_GROUP = "Workers R2 Storage Bucket Item Write";
