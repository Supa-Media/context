/**
 * The daily second look at Google grants marked revoked.
 *
 * `mintGoogleAccessToken` marks a row `reconnect_required` (`GRANT_REVOKED`)
 * the moment Google's token endpoint answers `invalid_grant`, and the sync
 * gate then skips that row until somebody reconnects. One spurious refusal
 * (Google has answered `invalid_grant` for a grant that worked again minutes
 * later) used to stop a mailbox for good, and the owner's words are that they
 * should not have to deal with this unless they have to give a new
 * permission. So once a day each such row gets one refresh; if Google accepts
 * the grant, caching the token clears the flag and makes the row due
 * (`cacheAccessTokenHandler`). A refusal again, or no answer, leaves it for
 * tomorrow.
 *
 * Only a refused grant (`REFRESHABLE_RECONNECT_CODES`): `SCOPES_INCOMPLETE`
 * is a permission the person has to give, and a refresh cannot. A
 * disconnected row is never asked about.
 * `docs/decisions/communications/sync-recovery.md`.
 */

import { v } from "convex/values";
import { internalAction, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { REFRESHABLE_RECONNECT_CODES } from "./lib/googleConnect/syncTokens";

const PAGE_SIZE = 200;

export const revokedGrantCandidates = internalQuery({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    connectionIds: v.array(v.id("googleConnections")),
    continueCursor: v.string(),
    isDone: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const page = await ctx.db
      .query("googleConnections")
      .withIndex("by_sync_due", (q) => q.eq("disconnectedAt", undefined))
      .paginate({ numItems: PAGE_SIZE, cursor: args.cursor });
    return {
      connectionIds: page.page
        .filter((row) => row.health === "reconnect_required" && REFRESHABLE_RECONNECT_CODES.has(row.errorCode ?? ""))
        .map((row) => row._id),
      continueCursor: page.continueCursor,
      isDone: page.isDone,
    };
  },
});

export const recheckRevokedGrants = internalAction({
  args: {},
  returns: v.object({ checked: v.number(), recovered: v.number() }),
  handler: async (ctx): Promise<{ checked: number; recovered: number }> => {
    let cursor: string | null = null;
    let checked = 0;
    let recovered = 0;
    for (;;) {
      const page: { connectionIds: Id<"googleConnections">[]; continueCursor: string; isDone: boolean } =
        await ctx.runQuery(internal.functions.googleReconnect.revokedGrantCandidates, { cursor });
      for (const connectionId of page.connectionIds) {
        checked += 1;
        try {
          const outcome: { kind: string } = await ctx.runAction(
            internal.functions.googleConnect.mintGoogleAccessTokenOutcome,
            { connectionId, forceRefresh: true },
          );
          if (outcome.kind === "minted") recovered += 1;
        } catch {
          // One row that cannot be asked about is not the batch's failure.
        }
      }
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
    console.log(JSON.stringify({ event: "google.revoked_grants_rechecked", checked, recovered }));
    return { checked, recovered };
  },
});
