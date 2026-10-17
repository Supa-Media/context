/**
 * Who is asked for Google's write scopes before Google has reviewed them
 * (`TESTER_WRITE_SCOPES` in `googleOAuth.ts`): staff on `ADMIN_EMAILS` and the
 * production test account, each by a verified address. Everyone else connects
 * read-only, as Google's review covers.
 */

import { internal } from "../../_generated/api";
import type { ActionCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { isAdminEmail } from "./admin";
import { isProductionTestAccount } from "./testAccount";
import { scopesForConnect, type GoogleProduct } from "./googleOAuth";

export function isGoogleWriteTester(
  user: { email?: string; emailVerificationTime?: number } | null,
  env: Record<string, string | undefined> = process.env,
): boolean {
  if (user === null || user.emailVerificationTime === undefined) return false;
  return isProductionTestAccount(user) || isAdminEmail(user.email, env);
}

/** The scopes a connect started by this person asks Google for. */
export async function connectScopes(ctx: ActionCtx, userId: Id<"users">, products: readonly GoogleProduct[]): Promise<string[]> {
  const tester: boolean = await ctx.runQuery(internal.functions.googleWriteTesters.isWriteTester, { userId });
  return scopesForConnect(products, tester);
}
