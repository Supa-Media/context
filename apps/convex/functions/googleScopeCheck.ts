/**
 * Asking Google what a calendar connection may really do, before Tex tells
 * somebody to reconnect (`lib/googleWriteAccess.ts`).
 *
 * `claimCalendarWrite` reads the scopes stored when the person last
 * connected. When none of their calendars has the scope to change events,
 * the calendar route calls `recheckCalendarWrite`: each calendar connection's
 * token is refreshed and Google's own tokeninfo says what the grant holds. A
 * stored list that was behind is corrected, and the change goes; a grant that
 * truly can't change events is refused with the accounts named, so Tex says
 * once, correctly, which account needs one reconnect.
 */

import { v } from "convex/values";
import { internalAction, internalMutation, internalQuery } from "../_generated/server";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { ownAccountClearance } from "./lib/controlPlane/ownAccount";
import { CALENDAR_WRITE_SCOPE } from "./lib/googleOAuth";
import { grantedScopes } from "./lib/googleWriteAccess";

/** The person's live calendar connections that, by their stored scopes, can only be read. */
export const calendarReaders = internalQuery({
  args: { hashedAccessToken: v.string(), expectedWorkspaceId: v.string() },
  returns: v.array(v.object({ connectionId: v.id("googleConnections"), address: v.string() })),
  handler: async (ctx, args) => {
    const cleared = await ownAccountClearance(ctx, args);
    if (cleared === null) return [];
    const rows = await ctx.db
      .query("googleConnections")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", cleared.personal._id))
      .take(20);
    return rows
      .filter((row) => row.disconnectedAt === undefined && row.products.includes("calendar") && !row.scopes.includes(CALENDAR_WRITE_SCOPE))
      .map((row) => ({ connectionId: row._id, address: row.address }));
  },
});

/** Adds the scopes Google says the grant holds to a connection's stored list. */
export const recordGrantedScopes = internalMutation({
  args: { connectionId: v.id("googleConnections"), scopes: v.array(v.string()) },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.connectionId);
    if (row === null) return null;
    await ctx.db.patch(args.connectionId, { scopes: [...new Set([...row.scopes, ...args.scopes])] });
    return null;
  },
});

/**
 * Whether Google says one of the person's calendar connections may change
 * events after all (its stored scopes are corrected when so), and the
 * accounts that truly can't.
 */
export const recheckCalendarWrite = internalAction({
  args: { hashedAccessToken: v.string(), expectedWorkspaceId: v.string() },
  returns: v.object({ writable: v.boolean(), readOnly: v.array(v.string()) }),
  handler: async (ctx, args): Promise<{ writable: boolean; readOnly: string[] }> => {
    const readers: Array<{ connectionId: Id<"googleConnections">; address: string }> = await ctx.runQuery(
      internal.functions.googleScopeCheck.calendarReaders,
      args,
    );
    let writable = false;
    const readOnly: string[] = [];
    for (const reader of readers) {
      // A fresh token, so the answer is the grant as it stands now.
      const minted = await ctx.runAction(internal.functions.googleConnect.mintGoogleAccessTokenOutcome, {
        connectionId: reader.connectionId,
        forceRefresh: true,
      });
      const scopes = minted.kind === "minted" ? await grantedScopes(minted.accessToken) : null;
      if (scopes?.includes(CALENDAR_WRITE_SCOPE)) {
        await ctx.runMutation(internal.functions.googleScopeCheck.recordGrantedScopes, { connectionId: reader.connectionId, scopes });
        writable = true;
      } else {
        readOnly.push(reader.address);
      }
      console.log(
        JSON.stringify({
          event: "calendar_scope_recheck",
          outcome: scopes === null ? "unanswered" : scopes.includes(CALENDAR_WRITE_SCOPE) ? "writable" : "read_only",
        }),
      );
    }
    return { writable, readOnly };
  },
});
