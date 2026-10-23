/**
 * Who is texting Tex: the account facts Tex is told on every turn it answers
 * for one person (`apps/mcp/src/agent/identity.js`).
 *
 * Decided by the owner (Dev2), 2026-10-23, after Tex, texting him from his own
 * number, asked "What's the number on your Partiful account?": Tex always
 * knows the texter's own phone number, name, emails and connected accounts,
 * and uses them for a sign-in without asking.
 *
 * Only Tex's own one-person clients may read it (texts, routines, check-ins),
 * only for the grant's own person, and only on their personal workspace: a
 * third-party MCP client never learns a phone number this way, a group chat's
 * grant (several people) gets nothing, and nobody reads another person's.
 * Every refusal is the same `null`.
 */

import type { Id } from "../../../_generated/dataModel";
import type { QueryCtx } from "../../../_generated/server";
import { resolveGrantByAccessTokenHandler } from "../controlPlane/session";
import { confirmedEmailsOf } from "../emailProof";
import { HEARTBEAT_CLIENT_ID } from "../heartbeats/model";
import { ROUTINES_CLIENT_ID } from "../routines/model";
import { personalWorkspaceOf, TEXTS_CLIENT_ID } from "../../textLinks";

/** The clients that answer for one person and may be told who that is. */
export const IDENTITY_CLIENTS: ReadonlySet<string> = new Set([TEXTS_CLIENT_ID, ROUTINES_CLIENT_ID, HEARTBEAT_CLIENT_ID]);

/** Bounds, so a strange account costs one short prompt and not a long one. */
const MAX_PHONES = 5;
const MAX_EMAILS = 10;
const MAX_ACCOUNTS = 10;

export type TexterIdentity = {
  name: string | null;
  handle: string;
  phones: string[];
  emails: string[];
  google: Array<{ address: string; products: string[] }>;
};

export async function texterIdentityHandler(
  ctx: QueryCtx,
  args: { hashedAccessToken: string; expectedWorkspaceId: string },
): Promise<TexterIdentity | null> {
  const session = await resolveGrantByAccessTokenHandler(ctx, { hashedAccessToken: args.hashedAccessToken });
  if (session === null || !IDENTITY_CLIENTS.has(session.clientId)) return null;
  const userId = session.actorUserId as Id<"users">;
  const home = await personalWorkspaceOf(ctx, userId);
  if (home === null || home !== args.expectedWorkspaceId) return null;
  if (!session.workspaces.some((entry) => entry.workspaceId === home)) return null;
  const user = await ctx.db.get(userId);
  const workspace = await ctx.db.get(home);
  if (user === null || workspace === null) return null;

  const phones: string[] = [];
  const add = (phone: string | undefined) => {
    if (typeof phone === "string" && phone !== "" && !phones.includes(phone) && phones.length < MAX_PHONES) phones.push(phone);
  };
  // The phone they text Tex from first: that is the one they are holding.
  const links = await ctx.db
    .query("phoneLinks")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(MAX_PHONES);
  for (const link of links) add(link.phone);
  if (user.phoneVerificationTime !== undefined) add(user.phone);

  const emails = (await confirmedEmailsOf(ctx, userId)).slice(0, MAX_EMAILS);
  const connections = await ctx.db
    .query("googleConnections")
    .withIndex("by_workspace", (q) => q.eq("workspaceId", home))
    .take(MAX_ACCOUNTS * 2);
  const google = connections
    .filter((connection) => connection.disconnectedAt === undefined)
    .slice(0, MAX_ACCOUNTS)
    .map((connection) => ({ address: connection.address, products: [...connection.products] }));
  for (const { address } of google) {
    const lower = address.toLowerCase();
    if (!emails.includes(lower) && emails.length < MAX_EMAILS) emails.push(lower);
  }

  // The account's name, else the name their personal workspace goes by.
  const name = [user.name, workspace.displayName].find((value) => typeof value === "string" && value.trim() !== "")?.trim() ?? null;
  return { name, handle: workspace.slug, phones, emails, google };
}
