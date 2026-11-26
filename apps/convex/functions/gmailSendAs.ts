/**
 * Reads each connected Gmail's "Send mail as" list into its row
 * (`lib/gmailSendAs.ts`), so an email can go from a verified alias of the
 * mailbox (`claimPersonEmail`) and Tex is told the aliases as facts
 * (`mailHealth`).
 *
 * Read three ways: after a Gmail connects, by the sweep in `crons.ts` for a
 * list older than `SEND_AS_FRESH_MS`, and at send time when the email's From
 * matches no mailbox or alias on record (`lib/gatewayRoutes/personEmail.ts`),
 * so an alias added in Gmail a minute ago sends without waiting for the sweep.
 * One GET of Gmail's settings per mailbox; nothing of the mail is read.
 */

import { v } from "convex/values";
import { internal } from "../_generated/api";
import type { Id } from "../_generated/dataModel";
import { internalAction, internalQuery, type ActionCtx } from "../_generated/server";
import { internalMutation } from "./lib/rowWatch/mutations";
import { aiScopesOf, canReadProduct } from "./lib/googleConnect/aiScopes";
import { ownAccountClearance } from "./lib/controlPlane/ownAccount";
import { timeoutFetch } from "./lib/filesFns/forwardSyncSupport";
import { SEND_AS_FRESH_MS, sendAsAliasesOf } from "./lib/gmailSendAs";

const SEND_AS_ENDPOINT = "https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs";
/** Most mailboxes one sweep reads. */
const SWEEP_LIMIT = 50;

const alias = v.object({ address: v.string(), name: v.optional(v.string()) });

/** Live Gmail rows whose list is older than fresh, oldest first. */
export const dueRows = internalQuery({
  args: { now: v.number() },
  returns: v.array(v.id("googleConnections")),
  handler: async (ctx, args) => {
    const rows = await ctx.db.query("googleConnections").take(2_000);
    return rows
      .filter(
        (row) =>
          row.disconnectedAt === undefined &&
          row.products.includes("gmail") &&
          row.health !== "reconnect_required" &&
          canReadProduct("gmail", aiScopesOf(row)) &&
          (row.gmailSendAs === undefined || args.now - row.gmailSendAs.checkedAt >= SEND_AS_FRESH_MS),
      )
      .sort((a, b) => (a.gmailSendAs?.checkedAt ?? 0) - (b.gmailSendAs?.checkedAt ?? 0))
      .slice(0, SWEEP_LIMIT)
      .map((row) => row._id);
  },
});

/** The Gmail rows of a token's own person (the same clearance a send has), for a read at send time. */
export const rowsForToken = internalQuery({
  args: { hashedAccessToken: v.string(), expectedWorkspaceId: v.string() },
  returns: v.array(v.id("googleConnections")),
  handler: async (ctx, args) => {
    const cleared = await ownAccountClearance(ctx, args);
    if (cleared === null) return [];
    const rows = await ctx.db
      .query("googleConnections")
      .withIndex("by_workspace", (q) => q.eq("workspaceId", cleared.personal._id))
      .take(20);
    return rows
      .filter((row) => row.disconnectedAt === undefined && row.products.includes("gmail") && row.health !== "reconnect_required")
      .map((row) => row._id);
  },
});

export const record = internalMutation({
  args: { connectionId: v.id("googleConnections"), aliases: v.array(alias), checkedAt: v.number() },
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get(args.connectionId);
    if (row === null || row.disconnectedAt !== undefined) return null;
    await ctx.db.patch(args.connectionId, { gmailSendAs: { aliases: args.aliases, checkedAt: args.checkedAt } });
    return null;
  },
});

/** The address a row is for, read in the action before Gmail is asked. */
export const addressOf = internalQuery({
  args: { connectionId: v.id("googleConnections") },
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => (await ctx.db.get(args.connectionId))?.address ?? null,
});

/**
 * Read one mailbox's list and keep it. `true` when Gmail answered. A refusal
 * (no permission, say) is kept as an empty list, so the sweep does not ask
 * again every run; Google not answering keeps what was there.
 */
export async function refreshSendAs(ctx: ActionCtx, connectionId: Id<"googleConnections">): Promise<boolean> {
  const address: string | null = await ctx.runQuery(internal.functions.gmailSendAs.addressOf, { connectionId });
  if (address === null) return false;
  const minted = await ctx.runAction(internal.functions.googleConnect.mintGoogleAccessToken, { connectionId, role: "agent" as const });
  if (minted === null) return false;
  let answer: unknown;
  try {
    const response = await timeoutFetch(SEND_AS_ENDPOINT, { headers: { Authorization: `Bearer ${minted.accessToken}` } });
    if (response.status === 429 || response.status >= 500) return false;
    answer = response.ok ? await response.json() : {};
  } catch {
    return false;
  }
  const aliases = sendAsAliasesOf(answer, address);
  await ctx.runMutation(internal.functions.gmailSendAs.record, { connectionId, aliases, checkedAt: Date.now() });
  console.log(JSON.stringify({ event: "gmail_send_as", outcome: "read", aliases: aliases.length }));
  return true;
}

export const refreshOne = internalAction({
  args: { connectionId: v.id("googleConnections") },
  returns: v.boolean(),
  handler: async (ctx, args) => await refreshSendAs(ctx, args.connectionId),
});

/** The sweep (`crons.ts`): every live Gmail's list, read again once it is older than fresh. */
export const refreshDue = internalAction({
  args: {},
  returns: v.object({ read: v.number(), asked: v.number() }),
  handler: async (ctx) => {
    const ids: Id<"googleConnections">[] = await ctx.runQuery(internal.functions.gmailSendAs.dueRows, { now: Date.now() });
    let read = 0;
    for (const id of ids) if (await refreshSendAs(ctx, id)) read++;
    return { read, asked: ids.length };
  },
});
