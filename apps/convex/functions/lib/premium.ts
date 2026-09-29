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
 * What pressing Upgrade buys. Premium is one plan (decided 2026-09-28): the
 * owner no longer ticks boxes first, so the selection is filled in here.
 *
 * - **Managed storage follows where the notes already are.** On a bucket we
 *   run it stays selected, so paying lifts the free cap on the same bucket. On
 *   the owner's own storage it is never switched on by paying, because that
 *   would start moving their notes; that move is Settings › Storage's.
 * - **Fast search comes with the plan** for a context that has never paid.
 *   A context that paid before keeps what it chose then, so turning the index
 *   off once is not undone by resubscribing, unless that would leave nothing.
 *
 * An explicit earlier choice (onboarding's paid bucket) is only ever added
 * to, never taken away. `docs/decisions/billing.md`, "One plan".
 */
export function selectionAtUpgrade(
  selected: Entitlements,
  status: PlanStatus,
  storageIsManaged: boolean,
): Entitlements {
  const managedStorage = selected.managedStorage || storageIsManaged;
  const fastSearch = selected.fastSearch || status === "none" || !managedStorage;
  return { managedStorage, fastSearch };
}

/**
 * How many notes a context on the free managed tier holds.
 *
 * A note is counted the way the console counts one (`lib/noteCount.ts`):
 * Markdown outside the dot-prefixed plumbing. At the cap, **creating** a new
 * note is refused and nothing else is: reading, editing an existing note,
 * moving, deleting and every exit keep working, because a limit on how much
 * somebody may add is a different thing from a limit on leaving with it.
 * `docs/decisions/billing.md`, "The free managed tier".
 */
export const FREE_MANAGED_NOTE_CAP = 1000;

/** The parts of a plan row these rules read. `null` is the ordinary no-row state. */
export interface PlanFacts {
  managedStorage?: boolean;
  status?: PlanStatus;
  freeManaged?: boolean;
}

/**
 * Whether this context may have a managed bucket minted for it right now.
 *
 * Paying for managed storage, as before; or being on the free managed tier
 * *while this deployment offers it*. The second half is the emergency brake:
 * with the offer switched off, no new free bucket is created. Nothing here
 * touches a bucket that already exists — this gates provisioning, never access.
 */
export function managedStorageEntitled(
  plan: PlanFacts | null,
  deployment: { freeTierOffered: boolean },
): boolean {
  if (plan?.managedStorage !== true) return false;
  if (planIsPaying(plan.status ?? "none")) return true;
  return plan.freeManaged === true && deployment.freeTierOffered;
}

/**
 * The note cap on this context, or `null` for none.
 *
 * Any context on storage we run that is not currently paying: one that started
 * on the free tier, and one whose subscription lapsed. **A lapse puts a context
 * back on the free plan; it never makes it read-only** (decided by the owner,
 * 2026-09-29). Everybody in it keeps reading, editing, moving and exporting;
 * only creating a note past the cap is refused. Paying lifts the cap, and a
 * bucket the customer owns is never capped by us (it is theirs, and they pay
 * the provider).
 *
 * A managed bucket with no plan row at all is not something the product
 * creates, and it is left uncapped rather than guessed at: a billing read that
 * cannot tell must never cost somebody the ability to write.
 *
 * There is deliberately no read-only function beside this one. Nothing about
 * a plan decides whether a context takes writes, and nothing decides whether
 * somebody may leave with their notes.
 */
export function noteCapFor(
  plan: Pick<PlanFacts, "status"> | null,
  storageIsManaged: boolean,
): number | null {
  if (!storageIsManaged || plan === null) return null;
  if (planIsPaying(plan.status ?? "none")) return null;
  return FREE_MANAGED_NOTE_CAP;
}
