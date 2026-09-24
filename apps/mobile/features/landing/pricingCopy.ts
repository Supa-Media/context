import {
  MANAGED_STORAGE_CEILING_BYTES,
  PREMIUM_CURRENCY,
  PREMIUM_INTERVAL,
  PREMIUM_PRICE_CENTS,
} from "@context/convex/functions/lib/premium";

import {
  EARLY_TESTER_PRICE_SHORT,
  formatBytes,
  formatPrice,
} from "../console/settings/panels/premium";

/**
 * THE TWO PLANS, ON THE PAGE SOMEBODY DECIDES FROM.
 *
 * `Landing-Sections.dc.html` draws them and leaves the number as
 * `[YOUR PRICE]`. It is $5 a month per workspace — and every figure below is
 * **derived from the control plane's own constants** rather than written out,
 * which is the whole reason this is a module and not four strings in a
 * component. A price typed into a marketing page is a page that lies the first
 * time somebody changes `PREMIUM_PRICE_CENTS`, and it lies in the direction
 * nobody notices until a customer quotes it back.
 *
 * Same argument for the ceiling: `MANAGED_STORAGE_CEILING_BYTES` is stated in
 * `premium.ts` as the arithmetic rather than as a literal "so the two cannot
 * drift", and a third copy of it here would be the drift that comment exists
 * to prevent.
 *
 * ## The early-tester sentence is the product's, not a new one
 *
 * `EARLY_TESTER_PRICE_SHORT`, imported rather than re-typed. Its own header
 * gives the rule: "a guarantee restated in three components is a guarantee that
 * will read differently in three places, and the weakest of the three wordings
 * is the one somebody quotes back." It is also a commitment on the billing side
 * — `docs/decisions/billing.md` records that raising the price means a *new*
 * Stripe Price with live subscriptions left where they are — so a looser
 * paraphrase here would be a promise the deployment is not making.
 *
 * ## Two corrections to what the board draws
 *
 * **Email capture is not a paid feature.** The board lists "Email capture
 * straight into `0-inbox/`" as a benefit of managed storage. It is not:
 * `functions/workspaces.ts` creates the capture address the moment a slug is
 * claimed, for every personal context, with no plan check at all — the comment
 * there is explicit that a *shared* context gets no row because it has no
 * address, which is about kind and never about billing. Printing it on the
 * paid card tells a visitor they must pay for something they already have,
 * which is the one direction an overclaim costs them money. It is on the free
 * card.
 *
 * **One price buys two things.** The board's paid card is headed "Managed
 * storage" and stops there. `lib/premium.ts` is unambiguous: "Managed storage
 * and fast search are selected independently and the price is the same either
 * way" — so a card that names one of them describes half the plan, and
 * somebody running their own bucket reads it as having nothing to buy. Fast
 * Search is named, and named honestly: `lib/fastSearch.ts` says turning it on
 * "adds a derived copy of that context's note text, including private notes,
 * in a database Supa Media owns", and the assurance block above already tells
 * a visitor that. A pricing card that sold it without repeating the exception
 * would be the page contradicting itself four hundred pixels apart.
 */

/** "$5 a month", from the constant the checkout is opened against. */
export const PRICE = formatPrice({
  priceCents: PREMIUM_PRICE_CENTS,
  currency: PREMIUM_CURRENCY,
  interval: PREMIUM_INTERVAL,
});

/** "50 GB", decimal, from the same constant the console's meter reads. */
export const CEILING = formatBytes(MANAGED_STORAGE_CEILING_BYTES);

export const PRICING_EYEBROW = "Pricing";
export const PRICING_TITLE = "Free on your own storage. Five dollars on ours.";

export const FREE_LABEL = "Free";
export const FREE_TITLE = "Your bucket";
export const FREE_BODY =
  "Connect R2, S3 or anything compatible. You pay your storage " +
  "provider; you pay us nothing.";
export const FREE_POINT_ONE = "The full gateway, every tool, every client";
/*
  On the FREE card, because it is free. See the header: the capture address is
  live the moment a slug is claimed.
*/
export const FREE_POINT_TWO = "A capture address, so email lands in 0-inbox/";
export const FREE_POINT_THREE = "Revoke our credential at any time and keep working";
export const FREE_POINT_FOUR = "Self-host the whole thing — MIT, no asterisk";
export const FREE_CTA = "Connect a bucket";

export const PAID_LABEL = "Managed storage and Fast Search";
export const PAID_BADGE = "nothing to set up";
export const PAID_PRICE = `${PRICE}, per workspace`;
export const PAID_BODY =
  "We create the bucket and pay for it. One bucket per workspace, named from " +
  "its id — never a shared bucket with your name on a folder.";
export const PAID_POINT_ONE = "Everything in Free";
export const PAID_POINT_TWO = `Managed storage up to ${CEILING}, with nothing to configure`;
/*
  Named with its cost, because the assurance block four hundred pixels up has
  already told this visitor that Fast Search keeps a copy of their text in a
  database we run. Selling it here without repeating that would be the page
  disagreeing with itself.
*/
export const PAID_POINT_THREE =
  "Fast Search, which keeps a rebuildable copy of your text in a database we run";
export const PAID_POINT_FOUR = "Hand the bucket to storage of your own, free, whenever";
export const PAID_CTA = "Start free, add storage later";

/** The price's own framing, from the product rather than paraphrased. */
export const PAID_PRICE_NOTE = EARLY_TESTER_PRICE_SHORT;

/**
 * Every string these cards render, for `landingCopy.test.ts`.
 *
 * Its own module for the reason `heroWindowCopy.ts` is: `copy.ts`'s
 * completeness reader cannot parse an array export, and two of the strings
 * here are template literals built from constants rather than plain text —
 * which that reader cannot evaluate either.
 */
export const PRICING_COPY = [
  PRICING_EYEBROW,
  PRICING_TITLE,
  FREE_LABEL,
  FREE_TITLE,
  FREE_BODY,
  FREE_POINT_ONE,
  FREE_POINT_TWO,
  FREE_POINT_THREE,
  FREE_POINT_FOUR,
  FREE_CTA,
  PAID_LABEL,
  PAID_BADGE,
  PAID_PRICE,
  PAID_PRICE_NOTE,
  PAID_BODY,
  PAID_POINT_ONE,
  PAID_POINT_TWO,
  PAID_POINT_THREE,
  PAID_POINT_FOUR,
  PAID_CTA,
];
