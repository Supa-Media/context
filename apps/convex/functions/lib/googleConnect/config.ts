/**
 * The Google connect flow's settings: the OAuth client, the deployment flag,
 * the sync windows and quotas, and the small checks every product's connect
 * flow shares.
 *
 * Split out of `functions/googleConnect.ts`, which keeps every registered
 * function; this module registers none and opens no credential.
 */

import { ConvexError } from "convex/values";
import type { Id } from "../../../_generated/dataModel";
import { getAuthUserId } from "@convex-dev/auth/server";
import { grantedScopesFor } from "../googleOAuth";

/** How long a started connect stays answerable. Same ten minutes as Dropbox's. */
export const ATTEMPT_TTL_MS = 10 * 60 * 1000;

/** Bytes of state. The same width as every other opaque token here. */
export const STATE_BYTES = 32;

export const GOOGLE_CLIENT_ID_ENV_VAR = "GOOGLE_OAUTH_CLIENT_ID";
export const GOOGLE_CLIENT_SECRET_ENV_VAR = "GOOGLE_OAUTH_CLIENT_SECRET";

/**
 * The flag. A restricted-scope feature is off by default on every deployment,
 * including this project's own until Google's verification lands — an unset
 * variable must read as disabled, never as enabled.
 */
export const MAIL_CONNECT_ENABLED_ENV_VAR = "MAIL_CONNECT_ENABLED";

export function mailConnectEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env[MAIL_CONNECT_ENABLED_ENV_VAR] === "true";
}

export async function readCurrentGmailHistoryId(accessToken: string, scopes: string[]): Promise<string | undefined> {
  if (grantedScopesFor("gmail", scopes).length === 0) return undefined;
  try {
    const response = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/profile", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!response.ok) return undefined;
    const json = (await response.json()) as { historyId?: unknown };
    return typeof json.historyId === "string" && json.historyId.length > 0 ? json.historyId : undefined;
  } catch {
    return undefined;
  }
}

export function requireMailConnectEnabled(): void {
  if (!mailConnectEnabled()) {
    throw new ConvexError({
      code: "MAIL_CONNECT_DISABLED",
      message: "Connecting a Google account is not enabled on this deployment.",
    });
  }
}

/** Which Gmail system labels this v1 will ever sync. Spam and Trash are never valid here. */
export const MAIL_FOLDERS = ["inbox", "sent"] as const;
export type MailFolder = (typeof MAIL_FOLDERS)[number];

/** Legacy Gmail history windows kept for old rows; new message sync is forward-only. */
export const BACKFILL_DAYS_DEFAULT = 90;
export const BACKFILL_DAYS_YEAR = 365;
/** "All mail": no fixed window, capped generously so a corrupt value cannot mean "forever" literally. */
export const BACKFILL_DAYS_ALL_MAIL = 36_500;
export const ALLOWED_BACKFILL_DAYS = new Set([BACKFILL_DAYS_DEFAULT, BACKFILL_DAYS_YEAR, BACKFILL_DAYS_ALL_MAIL]);

/**
 * A hard ceiling on bytes one connection may write, independent of the
 * customer's overall storage — note text and stored attachment bytes both.
 * Quota-bound per the owner's brief: backfill and sync both refuse to write
 * past this rather than silently exceeding what the estimator showed before
 * the first fetch.
 */
export const DEFAULT_MAIL_QUOTA_BYTES = 5 * 1024 * 1024 * 1024;

/**
 * The working default for how long a fetched attachment's bytes stay in the
 * bucket before `sweepExpiredAttachments` deletes them and the note's link
 * is rewritten to name and size only. Per-connection and overridable to
 * `"forever"` — see `docs/decisions/communications.md`, "Attachments are
 * fetched into the bucket, retained on a timer".
 */
export const DEFAULT_ATTACHMENT_RETENTION_DAYS = 90;

export type AttachmentMode = "metadata-only" | "store";
export type AttachmentRetention = number | "forever";
export type GoogleSyncServices = { gmail: boolean; calendar: boolean; chat: boolean };
export type GoogleSyncService = "gmail" | "calendar" | "chat";

// The four helpers below are exported for `calendarConnect.ts` (and Chat's
// sibling module): one OAuth client id, one client secret, one "who is
// calling" check, one "that attempt is gone" refusal — true of every
// product's connect flow because it is the same client and the same parked
// attempt shape, not a Gmail-specific fact. Reusing them is what keeps "how
// do we know who is calling" from becoming a second implementation the day
// it needs to change.
export function requireGoogleClientId(): string {
  const id = process.env[GOOGLE_CLIENT_ID_ENV_VAR];
  if (typeof id !== "string" || id.length === 0) {
    throw new ConvexError({
      code: "MAIL_CONNECT_NOT_CONFIGURED",
      message: "Google connect is not configured on this deployment.",
    });
  }
  return id;
}

/** Optional, like Dropbox's app secret — see `googleOAuth.ts` for why PKCE covers the flow either way. */
export function readGoogleClientSecret(): string | undefined {
  const secret = process.env[GOOGLE_CLIENT_SECRET_ENV_VAR];
  return typeof secret === "string" && secret.length > 0 ? secret : undefined;
}

export async function requireActor(ctx: {
  auth: { getUserIdentity: () => Promise<unknown> };
}): Promise<Id<"users">> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const userId = await getAuthUserId(ctx as any);
  if (userId === null) {
    throw new ConvexError({ code: "NOT_AUTHENTICATED", message: "Not authenticated" });
  }
  return userId as Id<"users">;
}

export function refuseAttempt(): never {
  throw new ConvexError({
    code: "CONNECT_ATTEMPT_INVALID",
    message: "That connection attempt has expired. Start it again.",
  });
}
