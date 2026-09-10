/**
 * Where Stripe sends somebody back to.
 *
 * ## Why this is in `shared` and not in the function that builds the URL
 *
 * Because it is a rule two packages must agree about, and the copy that did
 * not agree shipped. `billingStripe.ts` sent a completed payment to
 * `/settings?settings=premium&checkout=done`, and **`/settings` is not a route
 * in this app**: settings stopped being a route and became an overlay drawn
 * over a context's own page, addressed as
 * `/console/@name?settings=<section>`. So the one moment the product cannot
 * afford to get wrong — the customer has just paid — landed on `+not-found`,
 * and the `checkout=done` the URL carried was read by nobody.
 *
 * Nothing caught it because the two halves live in different packages: the
 * control plane wrote a path and the app owned the routes, and neither test
 * suite could see the other. That is exactly the case this package's own
 * header describes — "a rule with a copy on each side of a package boundary is
 * a rule that will drift" — so the path is built here, once, and
 * `apps/mobile/__tests__/checkoutReturn.test.ts` asserts that what this builds
 * is what `features/console/nav.ts` resolves.
 *
 * ## The origin is ours, never the caller's
 *
 * A return URL is built from a closed set of shapes and from the workspace on
 * our own `billingSessions` row. It is never assembled from anything a client
 * sent: `billingStripe.ts` already refuses to take a URL from the browser, and
 * moving the strings here does not loosen that — `CheckoutOrigin` has two
 * values and neither of them is a string somebody can post.
 */

/** Where the attempt started, which decides where finishing returns to. */
export type CheckoutOrigin = "settings" | "onboarding";

/** What happened at Stripe, as the returning URL says it. */
export type CheckoutOutcome = "done" | "cancelled";

/** The query parameter the app reads on the way back in. */
export const CHECKOUT_PARAM = "checkout";

/**
 * A context's addressable name in a URL: `@seyi`, never a raw workspace id.
 *
 * The same rule as the console's own `contextSegment`, which is the function
 * this must not drift from. It is duplicated in exactly one direction — the
 * console keeps its own copy because it is used on every navigation and should
 * not reach across a package for a string concat — and the test named above is
 * what keeps them honest.
 */
export function contextSegment(slug: string): string {
  return slug.startsWith("@") ? slug : `@${slug}`;
}

/** `/console/@seyi?settings=premium` — the Premium section of one context. */
export function premiumSettingsPath(slug: string): string {
  return `/console/${contextSegment(slug)}?settings=premium`;
}

/**
 * Where a checkout that started in settings comes back to.
 *
 * The Premium section of the context that was being upgraded, carrying what
 * happened — so the console can say "payment received, setting up" instead of
 * drawing the free plan at somebody who has just been charged.
 */
export function checkoutReturnPath(
  origin: CheckoutOrigin,
  slug: string,
  outcome: CheckoutOutcome,
): string {
  if (origin === "onboarding") {
    // First run has no context page to return to yet — the person is still in
    // the flow, and the flow is where the next step is.
    return `/welcome?${CHECKOUT_PARAM}=${outcome}`;
  }
  return `${premiumSettingsPath(slug)}&${CHECKOUT_PARAM}=${outcome}`;
}

/** Where Stripe's hosted billing portal returns to. Always the section it was opened from. */
export function portalReturnPath(slug: string): string {
  return premiumSettingsPath(slug);
}

/** Read the outcome off a URL's query, ignoring anything we did not write. */
export function checkoutOutcomeFrom(raw: string | undefined | null): CheckoutOutcome | null {
  if (raw === "done") return "done";
  if (raw === "cancelled") return "cancelled";
  return null;
}
