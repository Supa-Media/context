import { internal } from "../../../_generated/api";
import type { Id } from "../../../_generated/dataModel";
import type { ActionCtx } from "../../../_generated/server";

/**
 * The first Gmail of an account with no email yet becomes its main email
 * (`signInEmails.adoptGoogleAddress`), and only when Google vouches for the
 * address. Run before the binding lands, so a page waiting on the binding
 * already sees the main email.
 */
export async function adoptVerifiedAddress(
  ctx: ActionCtx,
  userId: Id<"users">,
  tokens: { address: string; addressVerified: boolean },
): Promise<void> {
  if (!tokens.addressVerified) return;
  await ctx.runMutation(internal.functions.signInEmails.adoptGoogleAddress, { userId, email: tokens.address });
}
