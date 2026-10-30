/**
 * Which consent a Google connection runs under once a connect has bound it
 * (2026-10-30, after Google asked for exact scope matching and least
 * privilege per feature).
 *
 * Every new request asks for the minimum (`standardScopesFor`,
 * `agentScopesFor` in `aiScopes.ts`): the standard client gets identity and,
 * with Calendar, the owned calendar read; AI gets its own consent on the
 * agent client. A row bound under that consent is `split`: it runs switched
 * on whatever the deployment's settings say (`googleEnvForRow`), so AI reads
 * it through the agent grant or not at all, and never through a standard
 * token the person gave for their own use.
 *
 * A row made before keeps the route it had, AI included, for as long as its
 * grant holds what that route reads: Google's `include_granted_scopes` hands a
 * reconnect back every scope the account already gave, so a reconnect or an
 * added product changes nothing for it. Only when the grant no longer covers
 * the row's products the old way (the person unticked a box, or Google forgot
 * the grant) does the row move to `split`, since the old route could not
 * read it anyway and a reconnect under the minimum consent cannot mend it;
 * AI then waits for the person's AI consent (`aiAccessNeeded`). Nothing is
 * revoked and no existing grant is narrowed by this.
 */

import type { GoogleProduct } from "../googleOAuth";
import { standardGrantCovers } from "./aiScopes";
import { googleEnvFor, googleEnvForRow } from "./clients";

/** Re-exported so a connect flow takes its request and its binding rule from one place. */
export { standardScopesFor } from "./aiScopes";

type Existing = { _id?: string; disconnectedAt?: number; consentPlan?: "split" } | null;

/**
 * The plan the bound row runs under, and the products its standard grant
 * leaves without what that plan needs (the row then says reconnect). A new
 * row, or one revived after a disconnect (which revoked every grant), is
 * `split`.
 */
export function planForBinding(
  workspaceId: string,
  existing: Existing,
  products: readonly GoogleProduct[],
  scopes: readonly string[],
): { consentPlan: "split" | undefined; starved: GoogleProduct[] } {
  const fresh = existing === null || existing.disconnectedAt !== undefined;
  const legacyHolds = !fresh && existing.consentPlan !== "split" && products.every((product) => standardGrantCovers(product, scopes, googleEnvFor(workspaceId)));
  const consentPlan = legacyHolds ? undefined : ("split" as const);
  if (!fresh && existing.consentPlan !== "split" && consentPlan === "split") {
    // Counts and ids only: the row's address and scopes stay out of the log.
    console.log(JSON.stringify({ event: "google.consent_plan_split", workspaceId, connectionId: existing._id, reason: "legacy_grant_narrowed" }));
  }
  const env = googleEnvForRow({ workspaceId, consentPlan });
  return { consentPlan, starved: products.filter((product) => !standardGrantCovers(product, scopes, env)) };
}
