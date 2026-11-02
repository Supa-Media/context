/**
 * Whether a person has ever used an AI client other than this app, kept as one
 * row written the first time, never patched.
 *
 * The invite card asks it on every render (`referrals.mine`, through
 * `allowanceFor`). Answered from the grants themselves it read up to a hundred
 * rows, and re-ran each time any of them was stamped (`touchGrant`, a refresh,
 * the console renewing its hourly token): 17 GB of Convex reads in eighteen
 * days for a fact that, once true, never changes (Convex invoice, owner
 * 2026-10-30). The grant stamps write this row once; a person without it is
 * answered from the grants as before, so nobody needs a backfill.
 */

import type { GenericDatabaseReader, GenericDatabaseWriter } from "convex/server";
import type { DataModel, Doc, Id } from "../../_generated/dataModel";

/** The console's own client id (`agentGrant.ts`): the person's own hand, not a tool of theirs. */
const CONSOLE_CLIENT_ID = "context_console";

/** Whether this grant's use counts as using an AI client. */
export function countsAsAgentUse(grant: Pick<Doc<"oauthGrants">, "clientId">): boolean {
  return grant.clientId !== CONSOLE_CLIENT_ID;
}

/** Records the first use, in the transaction that stamps the grant. */
export async function noteAgentUse(
  db: GenericDatabaseWriter<DataModel>,
  grant: Pick<Doc<"oauthGrants">, "clientId" | "userId">,
  at: number,
): Promise<void> {
  if (!countsAsAgentUse(grant)) return;
  const known = await db
    .query("agentUse")
    .withIndex("by_user", (q) => q.eq("userId", grant.userId))
    .first();
  if (known === null) await db.insert("agentUse", { userId: grant.userId, firstAt: at });
}

/** Whether the person has used an AI client: the row, or, before one is written, their grants. */
export async function hasUsedAgent(db: GenericDatabaseReader<DataModel>, userId: Id<"users">): Promise<boolean> {
  const known = await db
    .query("agentUse")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .first();
  if (known !== null) return true;
  const grants = await db
    .query("oauthGrants")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(100);
  return grants.some((grant) => countsAsAgentUse(grant) && typeof grant.lastUsedAt === "number" && grant.lastUsedAt > 0);
}
