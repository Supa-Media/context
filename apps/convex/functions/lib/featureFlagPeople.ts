/**
 * Finding and naming the people staff put on a flag's list or in a tester group (`functions/featureFlags.ts`): by
 * handle, email or phone, the way an invitation names one (`lib/invitees.ts`, `lib/identities.ts`), so every
 * ambiguity resolves to nobody.
 */

import type { Id } from "../../_generated/dataModel";
import type { QueryCtx } from "../../_generated/server";
import { handleForUser, resolveAddressedUser } from "./identities";
import { parseInvitee } from "./invitees";

/** The account `who` names (`@handle`, `handle`, an email or a phone), or `null`. */
export async function personNamed(ctx: QueryCtx, who: string): Promise<Id<"users"> | null> {
  const parsed = parseInvitee(who);
  if (!parsed.ok) return null;
  return await resolveAddressedUser(ctx, parsed.invitee);
}

/** How the console names a person: `@handle`, else their email, else "an account with no handle". */
export async function describePerson(ctx: QueryCtx, userId: Id<"users">): Promise<{ userId: Id<"users">; name: string }> {
  const handle = await handleForUser(ctx, userId);
  if (handle !== null) return { userId, name: `@${handle}` };
  const user = await ctx.db.get(userId);
  return { userId, name: user?.email ?? "an account with no handle" };
}
