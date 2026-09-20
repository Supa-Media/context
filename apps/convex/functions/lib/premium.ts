/**
 * What Premium is, as a set of facts that do not depend on Stripe.
 *
 * Pure functions and constants, no database and no network, so the rules can
 * be driven straight from a test and so the Convex surface in
 * `functions/billing.ts` stays short enough to read in one go — the same split
 * `lib/fastSearch.ts` and `functions/fastSearch.ts` already use.
 *
 * ## A plan belongs to a workspace, never to a person
 *
 * The row is keyed by `workspaceId` for the same reason a storage binding is
 * (`CLAUDE.md`, "The workspace model"): you are upgrading a bucket, not a
 * person. A work workspace can be paid for on a work card while the same
 * person's workspace stays personal and free, and one person paying for four
 * contexts is four rows and four cards rather than one subscription somebody
 * has to divide up afterwards.
 *
 * ## Two entitlements, one price
 *
 * Managed storage and fast search are selected independently and the price is
 * the same either way. That is a product decision rather than an oversight:
 * somebody who runs their own bucket may still want the index, and somebody
 * who wants us to hold the bucket may not want a copy of their notes in a
 * database we run. Metering two prices to sell one $5 subscription buys
 * nothing and doubles the number of states this file has to describe.
 *
 * `selected` is what the owner asked for and is stored whether or not anybody
 * is paying; `active` is `selected && subscription is paying`. Keeping them
 * apart is what lets a lapsed subscription be resumed without the owner having
 * to re-choose, and it is the same "entitled" / "opted in" separation
 * `lib/fastSearch.ts` argues at length.
 *
 * ## What is NOT here, deliberately
 *
 * **Anything that gates the exit.** Non-negotiable #1: downloading everything,
 * or handing the bucket to storage of their own, is free, identical on both
 * plans, and still works after a cancellation. There is therefore no
 * `canExport`, no plan-dependent export limit and no expiry attached to one —
 * a function of the plan that answered "may they leave" is the bug this
 * paragraph exists to make obvious, and `__tests__/premium.test.ts` asserts
 * this module exports nothing shaped like one.
 */

/** $5 a month, per context. Cents, so no float ever holds a price. */
export const PREMIUM_PRICE_CENTS = 500;
export const PREMIUM_CURRENCY = "usd";
export const PREMIUM_INTERVAL = "month";

/**
 * The managed-storage ceiling: 50 GB.
 *
 * Decimal GB rather than GiB, because it is a number in a sentence a customer
 * reads ("50 GB") and storage is sold in decimal everywhere they will compare
 * it. Stated as the arithmetic rather than as a literal so the two cannot
 * drift.
 */
export const MANAGED_STORAGE_CEILING_BYTES = 50 * 1000 * 1000 * 1000;

/**
 * The Stripe price the checkout is opened against.
 *
 * A price id is a **platform identifier and not a credential** — it is visible
 * in every checkout URL the product opens — so it lives in the deployment
 * environment exactly as `MANAGED_R2_ACCOUNT_ID` does, and not in `appSecrets`.
 * That is not only tidiness: `__tests__/structure.test.ts` fails any public
 * function whose call graph reaches `decryptSecret`, and a price id read out of
 * `appSecrets` would drag that read into whichever function needed it.
 *
 * Absent and malformed are different answers, for the reason `managedAccountId`
 * gives: a deployment nobody has configured simply does not sell anything, and
 * must not be told it has misconfigured something; a value that is present and
 * is not a price id is an operator error and says so.
 */
export const STRIPE_PRICE_ID_ENV_VAR = "STRIPE_PRICE_ID";

/**
 * The API key the checkout and portal calls are made with. A credential, so
 * `appSecrets` — encrypted at rest, set in the staff console, fingerprinted,
 * rotatable — exactly as `SEARCH_D1_API_TOKEN` is, and opened only by an
 * `internalAction`.
 */
export const STRIPE_API_KEY_SECRET = "STRIPE_SECRET_KEY";

/**
 * The webhook signing secret, and it is an environment variable rather than an
 * `appSecrets` row **on purpose**.
 *
 * The route that needs it is an `httpAction`, and `structure.test.ts` pins the
 * complete list of HTTP routes that may reach a decrypted credential — three,
 * each argued for. Reading the signing secret out of `appSecrets` would make
 * the webhook a fourth, which is a worse trade than holding one more value in
 * the deployment environment: the check has to happen *before* anything this
 * request says is trusted, which is the same argument `RESERVED_SECRET_NAMES`
 * makes about `GATEWAY_SECRET`. It is named in that refusal list so an operator
 * who tries to paste it into the console is told where it goes instead of being
 * told it worked.
 */
export const STRIPE_WEBHOOK_SECRET_ENV_VAR = "STRIPE_WEBHOOK_SECRET";

/** A price id, as Stripe issues them. Deliberately not a general string. */
const PRICE_ID_PATTERN = /^price_[A-Za-z0-9]{4,}$/;

/**
 * The configured price id, or `null` where there is none.
 *
 * Trimmed but **not** case-folded: Stripe ids are case-sensitive, and a
 * lower-cased one is a different id that does not exist. (`managedAccountId`
 * folds case because a Cloudflare account id is hex, where case carries
 * nothing — the difference is the value, not the habit.)
 */
export function stripePriceId(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = env[STRIPE_PRICE_ID_ENV_VAR];
  if (typeof raw !== "string") return null;
  const priceId = raw.trim();
  if (priceId.length === 0) return null;
  if (!PRICE_ID_PATTERN.test(priceId)) {
    // Deliberately does not echo the value: it is not a secret, and there is
    // still no reason to put a half-typed configuration string into an error a
    // client renders.
    throw new Error(`${STRIPE_PRICE_ID_ENV_VAR} is set but is not a Stripe price id.`);
  }
  return priceId;
}

/**
 * The billing states a context can be in.
 *
 * `none` is a context nobody has ever paid for — which is most of them, and
 * has no row at all. The other four are mirrored from Stripe's subscription
 * status and deliberately collapse its longer vocabulary: `trialing` counts as
 * `active` because it is serving, `incomplete` and `unpaid` count as
 * `past_due` because they are not, and `incomplete_expired` is `canceled`.
 * A status Stripe adds that this build has never heard of is `unknown`, which
 * serves nothing and says so — never `active`, which would be a free upgrade
 * bought by a vocabulary change.
 */
export type PlanStatus = "none" | "active" | "past_due" | "canceled" | "unknown";

export interface Entitlements {
  managedStorage: boolean;
  fastSearch: boolean;
}

/** Stripe's status word, as this build understands it. */
export function planStatusFromStripe(raw: unknown): PlanStatus {
  switch (raw) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
    case "incomplete":
    case "unpaid":
      return "past_due";
    case "canceled":
    case "incomplete_expired":
      return "canceled";
    default:
      return "unknown";
  }
}

/** Is this subscription paying for anything right now? */
export function planIsPaying(status: PlanStatus): boolean {
  return status === "active";
}

/**
 * What this context actually gets.
 *
 * The AND of "asked for" and "paying", computed in one place so no caller can
 * check one half. A context in `past_due` keeps its selection and loses its
 * entitlements — which is the honest reading of a card that was declined, and
 * is why `selected` is returned beside `active` rather than being overwritten.
 */
export function activeEntitlements(
  selected: Entitlements,
  status: PlanStatus,
): Entitlements {
  if (!planIsPaying(status)) return { managedStorage: false, fastSearch: false };
  return { ...selected };
}

/** À la carte, but not nothing: a subscription buys at least one of the two. */
export function hasAnyEntitlement(selected: Entitlements): boolean {
  return selected.managedStorage || selected.fastSearch;
}

/**
 * Whether writing is still allowed after a lapse.
 *
 * Cancelling makes a context **read-only and exportable; it never deletes**
 * (non-negotiable #1). This function is the control plane's statement of the
 * first half. The second half has no function anywhere in this module, and
 * that absence is the design: nothing may consult a plan to decide whether
 * somebody can leave with their notes.
 *
 * Only managed storage can be made read-only by a lapse, and that distinction
 * is the whole of it: a context on a bucket the customer owns keeps working
 * with their own credentials whatever we think of their card, because the
 * bucket is theirs and revoking our access is *their* lever, not ours.
 */
export function cancellationMakesReadOnly(
  status: PlanStatus,
  storageIsManaged: boolean,
): boolean {
  return storageIsManaged && !planIsPaying(status);
}
