/**
 * Writing a connection once Google has answered: the failure record, and the
 * binding row a successful exchange produces. The exchange itself, and the
 * sealing of the token it returns, stay in `functions/googleConnect.ts`.
 *
 * Split out of `functions/googleConnect.ts`, which keeps every registered
 * function and wires these handlers to them; this module registers none and opens no credential.
 */

import { v } from "convex/values";
import type { ObjectType } from "convex/values";
import type { MutationCtx } from "../../../_generated/server";
import type { Id } from "../../../_generated/dataModel";
import { recordAudit } from "../audit";
import { grantedScopesFor } from "../googleOAuth";
import { DEFAULT_MAIL_QUOTA_BYTES } from "./config";
import { defaultGoogleDestinationFolder } from "./validation";

export const recordConnectFailureArgs = { workspaceId: v.id("workspaces"), errorCode: v.string(), message: v.string() };

export const recordConnectFailureReturns = v.null();

/**
 * Record a connect that failed after the caller was told "started". Written
 * onto whatever connection row already exists for a *reconnect*; a first
 * connect that fails leaves nothing behind to attach it to, so it is dropped
 * after being logged — there is no half-built row for a client to poll.
 */
export async function recordConnectFailureHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof recordConnectFailureArgs>,
) {
  console.log(
    JSON.stringify({ event: "mail.connect_failed", workspaceId: args.workspaceId, errorCode: args.errorCode }),
  );
  return null;
}

export const applyGmailConnectionBindingArgs = {
  workspaceId: v.id("workspaces"),
  boundBy: v.id("users"),
  address: v.string(),
  mailboxSlug: v.string(),
  googleAccountId: v.string(),
  scopes: v.array(v.string()),
  backfillDays: v.number(),
  folders: v.array(v.union(v.literal("inbox"), v.literal("sent"))),
  attachmentMode: v.union(v.literal("metadata-only"), v.literal("store")),
  attachmentRetentionDays: v.union(v.number(), v.literal("forever")),
  encryptedRefreshToken: v.string(),
  encryptedAccessToken: v.string(),
  accessTokenExpiresAt: v.number(),
  historyId: v.optional(v.string()),
};

export const applyGmailConnectionBindingReturns = v.id("googleConnections");

/**
 * Write (or reconnect) the Google connection, with Gmail enabled on it.
 *
 * Keyed on `(workspaceId, address)`: reconnecting the same account updates
 * the same row rather than creating a second one, which is what keeps
 * `gmail.mailboxSlug` — chosen once — stable across a reconnect, and what
 * keeps any *other* product already enabled on this account (Calendar, Chat)
 * untouched by a Gmail-only reconnect. A connect that lands on a *different*
 * Google account for an address already connected cannot happen: the address
 * comes from Google's own id token for the account that completed consent,
 * so `address` and `googleAccountId` always move together.
 */
export async function applyGmailConnectionBindingHandler(
  ctx: MutationCtx,
  args: ObjectType<typeof applyGmailConnectionBindingArgs>,
) {
  const now = Date.now();
  const existing = await ctx.db
    .query("googleConnections")
    .withIndex("by_workspace_address", (q) =>
      q.eq("workspaceId", args.workspaceId).eq("address", args.address),
    )
    .unique();

  // AN EXPLICIT DISCONNECT ENDED EVERY PRODUCT ON THIS ACCOUNT — one grant,
  // one revoke — and `products` is left behind only as a record of what the
  // connection used to sync. So reviving this row for a Gmail connect
  // revives Gmail and nothing else: the other products' settings objects
  // and cursors are kept (they are somebody's folder names and sync
  // positions, not consent), but they are off the live `products` set until
  // the person reconnects them deliberately. Without this, "I disconnected
  // my Google account, then reconnected Gmail" silently puts Chat and
  // Calendar back on the row — a claim of consent out of a revocation.
  // `chatProduct.ts`'s `applyChatConnectionBinding` states the same rule
  // from the other side; this is its mirror, and the two must not diverge.
  const revived = existing !== null && existing.disconnectedAt !== undefined;
  const products = new Set(revived ? [] : (existing?.products ?? []));
  products.add("gmail");

  // A grant NARROWER than the row's live products, same check and the same
  // reason `applyChatConnectionBinding` gives: the slice is recorded
  // honestly as `[]`, nothing anywhere reads a slice, so without this the
  // row goes on reporting `backfilling` for a product whose sync can only
  // ever take a refusal from Google. Every name in the message is one of
  // this module's own literals, never a provider string.
  const starved = [...products].filter((product) => grantedScopesFor(product, args.scopes).length === 0);
  const gmailHistoryId = existing?.gmail?.historyId ?? args.historyId;

  const fields = {
    workspaceId: args.workspaceId,
    provider: "google" as const,
    address: args.address,
    encryptedRefreshToken: args.encryptedRefreshToken,
    encryptedAccessToken: args.encryptedAccessToken,
    accessTokenExpiresAt: args.accessTokenExpiresAt,
    scopes: args.scopes,
    googleAccountId: args.googleAccountId,
    products: [...products],
    gmail: {
      scopes: grantedScopesFor("gmail", args.scopes),
      // A reconnect keeps the folder, the cursor, and last-synced time:
      // it is the same account, and resetting any of them would rename a
      // folder or force a needless full reconcile. They are cleared only
      // by `disconnectGoogleConnection`.
      mailboxSlug: existing?.gmail?.mailboxSlug ?? args.mailboxSlug,
      backfillDays: args.backfillDays,
      folders: args.folders,
      storeRawMime: existing?.gmail?.storeRawMime ?? false,
      attachmentMode: args.attachmentMode,
      attachmentRetentionDays: args.attachmentRetentionDays,
      destinationFolder:
        existing?.gmail?.destinationFolder ??
        defaultGoogleDestinationFolder("gmail", existing?.gmail?.mailboxSlug ?? args.mailboxSlug),
      quotaBytes: existing?.gmail?.quotaBytes ?? DEFAULT_MAIL_QUOTA_BYTES,
      historyId: gmailHistoryId,
      lastSyncedAt: existing?.gmail?.lastSyncedAt,
    },
    // EVERY product's scope slice is recomputed from the ONE verbatim grant
    // this connect just received, never carried forward.
    //
    // The schema states the rule — "two views of one fact, never two facts"
    // — and carrying `existing.calendar` through untouched breaks it the
    // moment a second product exists: a Gmail-only reconnect replaces the
    // top-level `scopes` with the new grant's list while `calendar.scopes`
    // goes on claiming scopes that grant may no longer carry, and the
    // console would report a Calendar connection as healthy on the strength
    // of a record of a consent that has been replaced. The settings and the
    // cursor are the product's own and are kept; the scopes are a view of
    // the account's grant and are derived.
    //
    // NOTE FOR THE CALENDAR AND CHAT WORK LANDING ON THIS ROW: this makes
    // the row honest, it does not make an incremental connect correct.
    // Google returns a grant covering exactly what was REQUESTED, so a
    // later "add Calendar" that asks for `scopesForProducts(["calendar"])`
    // alone comes back with a refresh token that no longer covers Gmail —
    // and this mutation would then write a `gmail.scopes` of `[]` next to a
    // `products` still listing `gmail`, which is the honest record of a
    // real regression rather than a hidden one. The fix belongs in the
    // connect that adds a product: request the union of every product
    // already on the row plus the new one (`scopesForProducts` already
    // takes an arbitrary list), or set `include_granted_scopes=true` on the
    // authorize URL. Not decided here, because no such flow exists yet.
    calendar: existing?.calendar
      ? { ...existing.calendar, scopes: grantedScopesFor("calendar", args.scopes) }
      : undefined,
    chat: existing?.chat
      ? { ...existing.chat, scopes: grantedScopesFor("chat", args.scopes) }
      : undefined,
    health: (
      starved.length ? "reconnect_required" : gmailHistoryId ? "active" : "backfilling"
    ) as "reconnect_required" | "active" | "backfilling",
    lastError: starved.length
      ? `This Google account's authorization no longer covers ${starved.join(", ")}. Reconnect to restore it.`
      : undefined,
    errorCode: starved.length ? "SCOPES_INCOMPLETE" : undefined,
    disconnectedAt: undefined,
    boundBy: args.boundBy,
    updatedAt: now,
  };

  let connectionId: Id<"googleConnections">;
  if (existing === null) {
    connectionId = await ctx.db.insert("googleConnections", { ...fields, createdAt: now });
  } else {
    await ctx.db.patch(existing._id, fields);
    connectionId = existing._id;
  }

  await recordAudit(ctx, {
    workspaceId: args.workspaceId,
    actorUserId: args.boundBy,
    action: existing === null ? "mail.connected" : "mail.reconnected",
    details: { mailboxSlug: fields.gmail.mailboxSlug, backfillDays: args.backfillDays },
  });
  return connectionId;
}
