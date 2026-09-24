/**
 * What a connection may be set to: backfill windows, folders, attachment
 * handling, which services sync, and the account slug a mailbox is filed
 * under.
 *
 * Split out of `functions/googleConnect.ts`, which keeps every registered
 * function; this module registers none and opens no credential.
 */

import { ConvexError } from "convex/values";
import type { Id } from "../../../_generated/dataModel";
import type { GoogleProduct } from "../googleOAuth";

// `chooseMailboxSlug` is the single implementation of "how a connected
// mailbox's folder is named" (`docs/decisions/communications.md`, "An address
// becomes a slug"). Reusing it here — the only place that knows every slug
// already taken in a workspace — is what makes the choice made once, at
// connect time, and never recomputed against a different `taken` set.
// eslint-disable-next-line import/extensions
import { chooseMailboxSlug, SLUG_FALLBACK } from "../../../../../packages/communications/src/paths.js";
/*
  And the folders those notes land in are the package's too, for the same
  reason the slug is: a second spelling of `0-inbox/google-chat` here is a
  second answer to "where does a day of this channel go", and the two are only
  ever compared by somebody reading a bucket.
*/
// eslint-disable-next-line import/extensions
import { CHANNEL_FOLDERS } from "../../../../../packages/communications/src/protocol.js";
// eslint-disable-next-line import/extensions
import { CALENDAR_FOLDER } from "../../../../../packages/communications/src/calendar/protocol.js";
/*
  The folder rule is the package's, not this file's. It was private here and
  threw `ConvexError`, which made it unreachable from the console — so the
  field somebody types a destination into could offer no completion and no
  validation, and the mutation was the first thing that checked. Shared now;
  this file maps the refusal to its own error and stays the check that matters.
*/
import {
  normalizeDestinationFolder as destinationFolderResult,
} from "../../../../../packages/communications/src/destination.js";
import {
  ALLOWED_BACKFILL_DAYS,
  BACKFILL_DAYS_DEFAULT,
  DEFAULT_ATTACHMENT_RETENTION_DAYS,
  MAIL_FOLDERS,
  mailConnectEnabled,
  type AttachmentMode,
  type AttachmentRetention,
  type GoogleSyncService,
  type GoogleSyncServices,
  type MailFolder,
} from "./config";

export function validateBackfillDays(value: number | undefined): number {
  const days = value ?? BACKFILL_DAYS_DEFAULT;
  if (!ALLOWED_BACKFILL_DAYS.has(days)) {
    throw new ConvexError({
      code: "INVALID_BACKFILL_WINDOW",
      message: "Choose 90 days, 1 year, or all mail.",
    });
  }
  return days;
}

/**
 * Where a product's daily notes land when nobody has chosen a folder.
 *
 * Exported for `googleSync.ts`, which needs the same answer when it hands a
 * pass its destination — one implementation, so a synced day and the console's
 * own "daily file pattern" can never name two different folders.
 *
 * **Every branch is a package constant, and Chat's used to be a string.** It
 * read `"2-areas/communications/daily"` while `channelFolder("google-chat")`
 * — the answer `planChannelDay` falls back to when a caller passes no folder —
 * said `0-inbox/google-chat`, so a Chat connection that had never been given a
 * destination wrote its days *outside the Inbox entirely*: not under the
 * folder `docs/decisions/communications.md` decided ("A channel lands in
 * `0-inbox`"), not routed by `classifyCommsPath` to the console's channel
 * view, not collapsed by `classifyCaptureKind` out of `orient`'s recency list,
 * and beside `2-areas/communications/contacts/` in the buckets where an older
 * importer had left one — two contacts folders, one of them the product's.
 * Gmail and Calendar had the right answer spelled out longhand beside it,
 * which is exactly how a third spelling goes unnoticed: nothing compares
 * these strings to the package's, so only a person reading their own bucket
 * ever finds out. They are the same constants now.
 *
 * Changing this moves nothing already written. A pass that ran before it
 * leaves its days where they were, the same as changing the destination in
 * the console does (`updateGoogleSyncDestination` patches the row and never
 * touches the bucket) — the notes are the customer's, and moving a year of
 * them is `move_folder`'s job and their decision.
 */
/**
 * The folder name this Google account's days go under.
 *
 * One answer for all three products, and it is Gmail's when Gmail has one:
 * `gmail.mailboxSlug` is chosen once at connect and never recomputed, so an
 * account whose mail is already in `0-inbox/email/<slug>/` gets
 * `0-inbox/calendar/<slug>/` and `0-inbox/google-chat/<slug>/` beside it
 * rather than a second spelling of the same person.
 *
 * `taken` is every other connection in this workspace, so two addresses that
 * slugify alike (`a.b@` and `a-b@`) get different folders — the same rule
 * `chooseMailboxSlug` applies to mailboxes, applied to the whole account. The
 * result is recorded in the connection's `destinationFolder` by its caller and
 * never recomputed, which is what makes a later disconnect unable to rename
 * the folder somebody's calendar is already in.
 */
/**
 * Every account slug this workspace has already spent, except this address's own.
 *
 * Read off the rows rather than kept in a column: a slug is *recorded* inside
 * each product's `destinationFolder`, and the mailbox's is on `gmail`, so the
 * rows are the record. Excluding the address being bound is what makes a
 * reconnect idempotent — without it, an account would find its own slug taken
 * and give itself a hashed second one on every reconnect.
 */
export async function takenAccountSlugs(
  ctx: { db: { query: (table: "googleConnections") => any } },
  workspaceId: Id<"workspaces">,
  address: string,
): Promise<string[]> {
  const rows = await ctx.db
    .query("googleConnections")
    .withIndex("by_workspace", (q: any) => q.eq("workspaceId", workspaceId))
    .collect();
  return rows
    .filter((row: any) => row.address !== address)
    .flatMap((row: any) => (row.gmail?.mailboxSlug ? [row.gmail.mailboxSlug as string] : []));
}

export function accountSlugFor(
  address: string,
  existing: { gmail?: { mailboxSlug?: string } } | null | undefined,
  taken: readonly string[],
): string {
  const chosen = existing?.gmail?.mailboxSlug;
  if (typeof chosen === "string" && chosen.length > 0) return chosen;
  return chooseMailboxSlug(address, [...taken]);
}

export function defaultGoogleDestinationFolder(
  service: GoogleSyncService,
  mailboxSlug: string | undefined,
): string {
  if (service === "gmail") return `${CHANNEL_FOLDERS.email}/${mailboxSlug ?? SLUG_FALLBACK}`;
  /*
    Calendar and Chat take the account level too, since 2026-09-18.

    They were one folder per workspace, so two connected Google accounts wrote
    one `0-inbox/calendar/2026-09-07.md` between them. It read correctly —
    every event names its account — and it cost the thing the mailbox folder
    was built for: a folder is the only unit `visibilityOf` can name, so
    "my work calendar is team and my personal one is private" was not
    expressible at all, at any number of lines in `privacy.md`.

    A slug is only ever *recorded*, never recomputed: an absent one answers
    the folder these products have always used, so an existing connection
    whose row predates `accountSlug` goes on writing exactly where it was.
    That is what makes the change forward-only for days as well as folders.
  */
  if (service === "calendar") {
    return mailboxSlug === undefined ? CALENDAR_FOLDER : `${CALENDAR_FOLDER}/${mailboxSlug}`;
  }
  return mailboxSlug === undefined
    ? CHANNEL_FOLDERS["google-chat"]
    : `${CHANNEL_FOLDERS["google-chat"]}/${mailboxSlug}`;
}

/**
 * The package's folder rule, as a throw.
 *
 * The rules, the codes and the sentences are all
 * `@context/communications/destination`'s — the console renders the same
 * refusal in the same words before the round trip, which is the whole point of
 * the move. What stays here is turning it into the `ConvexError` this layer
 * speaks, with the `GOOGLE_` prefix its callers already switch on.
 */
export function normalizeDestinationFolder(value: string): string {
  const result = destinationFolderResult(value);
  if (result.ok) return result.folder;
  throw new ConvexError({ code: `GOOGLE_${result.code}`, message: result.message });
}

export function validateFolders(value: MailFolder[] | undefined): MailFolder[] {
  const folders = value ?? (["inbox", "sent"] as MailFolder[]);
  if (
    folders.length === 0 ||
    !folders.every((folder) => (MAIL_FOLDERS as readonly string[]).includes(folder)) ||
    new Set(folders).size !== folders.length
  ) {
    throw new ConvexError({
      code: "INVALID_FOLDERS",
      message: "Choose at least one of Inbox or Sent.",
    });
  }
  return folders;
}

export function validateAttachmentMode(value: AttachmentMode | undefined): AttachmentMode {
  const mode = value ?? "store";
  if (mode !== "store" && mode !== "metadata-only") {
    throw new ConvexError({ code: "INVALID_ATTACHMENT_MODE", message: "Choose store or metadata-only." });
  }
  return mode;
}

export function validateAttachmentRetentionDays(value: AttachmentRetention | undefined): AttachmentRetention {
  const retention = value ?? DEFAULT_ATTACHMENT_RETENTION_DAYS;
  if (retention !== "forever" && (!Number.isFinite(retention) || retention <= 0)) {
    throw new ConvexError({
      code: "INVALID_ATTACHMENT_RETENTION",
      message: "Choose a positive number of days, or \"forever\".",
    });
  }
  return retention;
}

export function validateGoogleSyncServices(value: GoogleSyncServices): GoogleProduct[] {
  const products: GoogleProduct[] = [];
  if (value.gmail) products.push("gmail");
  if (value.calendar) products.push("calendar");
  if (value.chat) products.push("chat");
  if (products.length === 0) {
    throw new ConvexError({
      code: "GOOGLE_PRODUCTS_REQUIRED",
      message: "Choose at least one Google service to sync.",
    });
  }
  return products;
}

export function requireGoogleProductsEnabled(products: readonly GoogleProduct[]): void {
  if ((products.includes("gmail") || products.includes("chat")) && !mailConnectEnabled()) {
    throw new ConvexError({
      code: "MAIL_CONNECT_DISABLED",
      message: "Connecting Google mail or chat is not enabled on this deployment.",
    });
  }
  if (products.includes("calendar") && process.env.CALENDAR_CONNECT_ENABLED !== "true") {
    throw new ConvexError({
      code: "CALENDAR_CONNECT_DISABLED",
      message: "Connecting Calendar is not enabled on this deployment.",
    });
  }
}

export type GoogleConnectFlow = "gmail" | "calendar" | "chat" | "google";
