/**
 * A bot's helper's token (`botHelpers`; `docs/decisions/app-and-console/bot-helpers.md`): live only while its own time
 * lasts, and while the bot's own grant (`parentGrantId`) passes every check `validateLiveGrantRecord` makes except the
 * parent token's own expiry (a helper outlives the hour-long token the bot connected with, as a Tex computer run does).
 *
 * Resolved for an MCP session, its read clearance and its mail, as a run grant is, and never by `resolveLiveGrant`: so
 * no owner or editor clearance takes a helper's token, and a helper never sets a webhook, binds a bot or starts a
 * helper of its own.
 */

import type { Doc } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { TOKEN_HASH_PATTERN } from "../crypto";
import { CONSOLE_CLIENT_ID } from "../../agentGrant";
import { TEXTS_GROUP_CLIENT_ID } from "../../textGroups";
import { TEXTS_CLIENT_ID } from "../../textLinks";
import { type LiveGrant, validateLiveGrantRecord } from "./liveGrants";

/** What a helper's session says about it: who it is, whose it is, and where its note is. Names and paths only. */
export interface HelperInfo {
  helperId: string;
  workspaceId: Doc<"botHelpers">["workspaceId"];
  bot: string;
  botName: string;
  name: string;
  mail: string;
  note: string;
  expiresAt: number;
}

/** The grants a bot may start a helper from: an AI client's own, never Tex's texting grants or the app's. */
export function mayParentHelper(clientId: string): boolean {
  return clientId !== TEXTS_CLIENT_ID && clientId !== TEXTS_GROUP_CLIENT_ID && clientId !== CONSOLE_CLIENT_ID;
}

export function helperInfoOf(row: Doc<"botHelpers">): HelperInfo {
  return {
    helperId: row.helperId,
    workspaceId: row.workspaceId,
    bot: row.bot,
    botName: row.botName,
    name: row.name,
    mail: row.mail,
    note: row.note,
    expiresAt: row.expiresAt,
  };
}

export async function resolveHelperGrant(
  ctx: QueryCtx,
  hashedAccessToken: string,
): Promise<(LiveGrant & { helper: HelperInfo }) | null> {
  if (!TOKEN_HASH_PATTERN.test(hashedAccessToken)) return null;
  const row = await ctx.db
    .query("botHelpers")
    .withIndex("by_access_token", (q) => q.eq("hashedAccessToken", hashedAccessToken))
    .unique();
  if (row === null || row.expiresAt <= Date.now()) return null;
  const parent = await ctx.db.get(row.parentGrantId);
  if (parent === null || !mayParentHelper(parent.clientId)) return null;
  // The parent's own token expiry is replaced by the helper's, so only the helper's time bounds it; revoking the parent
  // (status), or its person leaving the workspace, ends the helper on its next request.
  const live = await validateLiveGrantRecord(ctx, { ...parent, accessTokenExpiresAt: row.expiresAt });
  if (live === null) return null;
  return { ...live, helper: helperInfoOf(row) };
}
