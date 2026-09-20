import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "@jest/globals";

import {
  MANAGED_STORAGE_CEILING_BYTES,
  PREMIUM_CURRENCY,
  PREMIUM_INTERVAL,
  PREMIUM_PRICE_CENTS,
} from "@context/convex/functions/lib/premium";
import { EARLY_TESTER_PRICE_SHORT } from "../features/console/settings/panels/premium";
import {
  CEILING,
  FREE_POINT_TWO,
  PAID_POINT_THREE,
  PAID_POINT_TWO,
  PAID_PRICE,
  PAID_PRICE_NOTE,
  PRICE,
  PRICING_COPY,
} from "../features/landing/pricingCopy";
import { LANDING_COPY } from "../features/landing/copy";

/**
 * THE PRICING CARDS SAY WHAT THE PRODUCT CHARGES, AND NOTHING IT DOES NOT SELL.
 *
 * `landingCopy.test.ts` guards what the page claims about **confidentiality**.
 * A price is the other kind of claim somebody acts on, and it fails in ways
 * that suite's patterns are not shaped for: a figure that is right the day it
 * is written and wrong the day a constant moves, and a feature listed on the
 * card that charges for it while the product hands it out free.
 */

const PRICING = readFileSync(
  join(__dirname, "..", "features", "landing", "pricingCopy.ts"),
  "utf8",
);

describe("every figure on the cards comes from the control plane", () => {
  test("the price is derived, not typed", () => {
    /*
      The failure this prevents: `$5` written into a marketing page, and left
      there the first time somebody changes `PREMIUM_PRICE_CENTS`. It is not
      hypothetical — the price already exists in four other places in this
      repo, all of which read the constant.
    */
    expect(PRICE).toBe("$5 a month");
    expect(PREMIUM_PRICE_CENTS).toBe(500);
    expect(PREMIUM_CURRENCY).toBe("usd");
    expect(PREMIUM_INTERVAL).toBe("month");
  });

  test("the module names no price of its own", () => {
    // Source-reading is crude and it is the only thing that catches a figure
    // being *added* beside the derived one rather than replacing it.
    const code = PRICING.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
    expect(code).not.toMatch(/\$\s?\d/);
  });

  test("the ceiling is derived too, and is the one the console meters", () => {
    expect(CEILING).toBe("50 GB");
    expect(MANAGED_STORAGE_CEILING_BYTES).toBe(50 * 1000 * 1000 * 1000);
    expect(PAID_POINT_TWO).toContain(CEILING);
  });

  test("the price names what it is per", () => {
    // A plan row is keyed by `workspaceId`, so one person paying for four
    // contexts is four subscriptions. A bare "$5 a month" reads as an account.
    expect(PAID_PRICE).toContain("per workspace");
  });
});

describe("the cards charge for what is charged for", () => {
  test("the early-tester framing is the product's sentence, not a paraphrase", () => {
    /*
      `premium.ts` holds it and says why it is one constant: "a guarantee
      restated in three components is a guarantee that will read differently in
      three places, and the weakest of the three wordings is the one somebody
      quotes back". Its second half is a commitment on the Stripe side —
      `docs/decisions/billing.md` — so a looser wording here would be a promise
      this deployment is not making.
    */
    expect(PAID_PRICE_NOTE).toBe(EARLY_TESTER_PRICE_SHORT);
    expect(PAID_PRICE_NOTE).toMatch(/early tester/i);
    expect(PRICING_COPY).toContain(PAID_PRICE_NOTE);
  });

  test("email capture is on the free card, because it is free", () => {
    /*
      The design canvas lists it as a benefit of managed storage. It is not:
      `functions/workspaces.ts` creates the capture address the moment a slug
      is claimed, for every personal context, with no plan check — a *shared*
      context gets no row because it has no address, which is about kind and
      never about billing.

      This is the overclaim direction that costs somebody money, so it is
      asserted from both ends: the free card names it, and no paid line does.
    */
    expect(FREE_POINT_TWO).toMatch(/0-inbox/);
    const paidLines = PRICING_COPY.filter((line) => line.startsWith("Managed") || /Fast Search/.test(line));
    for (const line of paidLines) expect(line).not.toMatch(/capture|0-inbox/i);
  });

  test("the paid card names both entitlements, not just storage", () => {
    /*
      `lib/premium.ts`: "Managed storage and fast search are selected
      independently and the price is the same either way." A card headed
      "Managed storage" alone describes half the plan, and somebody running
      their own bucket reads it as having nothing to buy.
    */
    const joined = PRICING_COPY.join(" ");
    expect(joined).toMatch(/Managed storage/);
    expect(joined).toMatch(/Fast Search/);
  });

  test("Fast Search is sold with the copy it keeps", () => {
    /*
      The assurance block four hundred pixels up already tells this visitor
      that Fast Search keeps a derived copy of their note text in a database we
      run — `lib/fastSearch.ts`'s own words. Selling it here without repeating
      that would be the page disagreeing with itself at two scroll positions.
    */
    expect(PAID_POINT_THREE).toMatch(/copy of your text/i);
    expect(PAID_POINT_THREE).toMatch(/database we run/i);
  });

  test("no card gates the exit", () => {
    /*
      Non-negotiable #1: downloading everything or handing the bucket over is
      free, identical on both plans, and still works after a cancellation. A
      pricing card is exactly where that would be quietly turned into a paid
      feature, so the hand-off line is asserted to be on the paid card as a
      *free* one and nowhere phrased as something it buys.
    */
    const handoff = PRICING_COPY.filter((line) => /hand the bucket/i.test(line));
    expect(handoff).toHaveLength(1);
    expect(handoff[0]).toMatch(/free/i);
  });
});

describe("the cards are part of the page the copy rules read", () => {
  test("every pricing line is in LANDING_COPY", () => {
    // Otherwise the overclaim patterns in `landingCopy.test.ts` are pointed at
    // a page that no longer includes two of its cards.
    const missing = PRICING_COPY.filter((line) => !LANDING_COPY.includes(line));
    expect(missing).toEqual([]);
  });
});
