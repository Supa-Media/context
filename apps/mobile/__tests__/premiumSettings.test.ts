/**
 * THE SECTION THAT ASKS FOR MONEY, AND THE ONE SENTENCE IT MAY NEVER QUALIFY.
 *
 * Most of this file is the ordinary console rule: never offer a control the
 * server would refuse, never synthesise a state we were not told, never render
 * a provider's text.
 *
 * The part that is not ordinary is the exit. `CLAUDE.md`'s first
 * non-negotiable says downloading everything, or handing the bucket to storage
 * of your own, is free, identical on both plans, and still works after a
 * cancellation — so this is the one screen in the product where a plausible,
 * well-meaning change is a product change: a paragraph that says export is
 * "included in Premium", a lock beside it, a "before you cancel" step. Every
 * one of those reads as a feature and each of them ends the promise.
 *
 * `EXPORT_PROMISE` is therefore a constant with no parameters, and the tests
 * below walk every state to assert it is the same sentence in all of them and
 * that no function in the module takes a plan and answers a question about
 * leaving.
 *
 * ## Sabotage record
 *
 * The measurements live in `premiumPanelRender.test.ts`, which is where the
 * same mutations were run against this file and that one together — a rule
 * broken only in the pure module is not worth counting twice, and the
 * interesting number for every one of them is how many checks fail in total.
 */

import { describe, expect, test } from "@jest/globals";
import * as premium from "../features/console/settings/panels/premium";
import {
  EARLY_TESTER_PRICE_NOTE,
  EXPORT_PROMISE,
  PREMIUM_STATES,
  describePremium,
  describeSessionFailure,
  earlyTesterPriceNote,
  entitlementRows,
  entitlementsHint,
  formatBytes,
  formatPrice,
  managedMigrationCopy,
  premiumControl,
  premiumPill,
  premiumStateOf,
  renewalLine,
  shouldReadPremium,
  usageLine,
  type PremiumStatus,
  type PremiumView,
} from "../features/console/settings/panels/premium";

const status = (over: Partial<PremiumStatus> = {}): PremiumStatus => ({
  status: "none",
  selected: { managedStorage: false, fastSearch: false },
  active: { managedStorage: false, fastSearch: false },
  canManage: true,
  configured: true,
  priceCents: 500,
  currency: "usd",
  interval: "month",
  ceilingBytes: 50_000_000_000,
  storageIsManaged: false,
  ...over,
});

const view = (over: Partial<PremiumView> = {}): PremiumView => ({
  status: status(),
  loading: false,
  session: null,
  choose: async () => {},
  upgrade: async () => {},
  manageBilling: async () => {},
  ...over,
});

describe("reading a plan off the wire", () => {
  test("every state this build knows survives the round trip", () => {
    expect(premiumStateOf("none")).toBe("free");
    expect(premiumStateOf("active")).toBe("premium");
    expect(premiumStateOf("past_due")).toBe("past_due");
    expect(premiumStateOf("canceled")).toBe("canceled");
  });

  test("a state this build has never heard of closes the section down", () => {
    // A newer control plane, a corrupted row, a typo in a fixture. The
    // direction this must fail is "offer nothing and explain" — never "free",
    // which would offer to sell against a vocabulary we do not share, and
    // never "premium", which would claim entitlements a context may not have.
    for (const raw of [
      undefined,
      null,
      "",
      "ACTIVE",
      "trialing",
      "paused",
      1,
      {},
    ]) {
      expect(premiumStateOf(raw)).toBe("unavailable");
    }
  });

  test("a member is not told the owner's card was declined", () => {
    /*
      The money fields are owner-only on the wire, and this sentence was not:
      `past_due` said "The last payment did not go through … update the card and
      it comes straight back" to every member of a shared workspace. That is
      somebody's card being declined, in the second person, to people who do not
      hold it and cannot act on it, on a screen they can open at any time.
    */
    const asMember = describePremium("past_due", false);
    expect(asMember.title).not.toMatch(/payment|card/i);
    expect(asMember.blurb).not.toMatch(/card/i);
    expect(asMember.blurb).not.toMatch(/payment/i);
    // Still told the part that affects them — what the context is entitled to.
    expect(asMember.blurb).toMatch(/off/i);
    expect(asMember.blurb).toMatch(/nothing has been deleted/i);

    // …and the owner still gets the actionable version, because they can act.
    expect(describePremium("past_due", true).blurb).toMatch(/card/i);

    // The pill is part of what a member is told, and it was missed first time:
    // the paragraph narrowed while the chip beside it still read "Payment
    // failed".
    expect(premiumPill("past_due", false)?.label).not.toMatch(/payment/i);
    expect(premiumPill("past_due", true)?.label).toMatch(/payment/i);
  });

  test("the states that are legitimately everybody's business do not narrow", () => {
    // What a context is entitled to affects every member of it. Only the
    // sentence about somebody's card narrows, and narrowing more would be
    // hiding a state from the people living in it.
    for (const state of [
      "free",
      "premium",
      "canceled",
      "unavailable",
    ] as const) {
      expect(describePremium(state, false)).toEqual(
        describePremium(state, true),
      );
    }
  });

  test("every state has copy and a decided pill", () => {
    for (const state of PREMIUM_STATES) {
      const copy = describePremium(state);
      expect(copy.title.length).toBeGreaterThan(0);
      expect(copy.blurb.length).toBeGreaterThan(0);
      // `null` is a decision — no pill on a deployment that does not sell —
      // rather than an omission, so it is asserted rather than skipped.
      const pill = premiumPill(state);
      if (state === "unavailable") expect(pill).toBeNull();
      else expect(pill?.label.length).toBeGreaterThan(0);
    }
  });
});

describe("the exit is never a feature of the plan", () => {
  test("the same sentence in every state", () => {
    // A constant, not a function: there is no state to pass it and nothing to
    // branch on. This walks the states anyway, because the failure it exists
    // to catch is somebody making it take one.
    for (const state of PREMIUM_STATES) {
      expect(describePremium(state).blurb).not.toMatch(/export|download/i);
    }
    expect(EXPORT_PROMISE).toMatch(/free/i);
    expect(EXPORT_PROMISE).toMatch(/both plans/i);
    expect(EXPORT_PROMISE).toMatch(/after you cancel/i);
    expect(EXPORT_PROMISE).toMatch(/never deletes/i);
  });

  test("no function here takes a plan and answers a question about leaving", () => {
    // `canExport(status)`, `exportLimitBytes(plan)`, `exportWindowDays(plan)`.
    // Each would read as a feature and each ends the promise. There is no
    // behaviour to assert about a function that does not exist, so this is a
    // shape test — the same guard `apps/convex/__tests__/premium.test.ts`
    // keeps over the control plane's half.
    const exits = Object.keys(premium).filter((name) =>
      /export|download|handoff|handOff|leave|retention/i.test(name),
    );
    // The one permitted name is the constant itself; anything else here is a
    // plan being asked whether somebody may leave.
    expect(exits).toEqual(["EXPORT_PROMISE"]);
    expect(typeof EXPORT_PROMISE).toBe("string");
  });
});

describe("which control is offered", () => {
  test("an owner who has chosen something is offered the upgrade", () => {
    expect(
      premiumControl(
        view({
          status: status({
            selected: { managedStorage: true, fastSearch: false },
          }),
        }),
      ),
    ).toBe("upgrade");
  });

  test("an owner who has chosen nothing is told what to tick, not shown a dead button", () => {
    // The server refuses a checkout with nothing in it, and the fix is one tap
    // away rather than a permission a person cannot get.
    expect(premiumControl(view())).toBe("choose");
  });

  test("a context with a customer goes to the portal, whatever the status", () => {
    for (const raw of ["active", "past_due", "canceled"]) {
      expect(
        premiumControl(
          view({ status: status({ status: raw, hasStripeCustomer: true }) }),
        ),
      ).toBe("manage");
    }
  });

  test("the server's canManage is the whole answer, and is not re-derived", () => {
    // A member may read the plan and may not change it. A control here would
    // be a button whose only outcome is a permission error.
    for (const over of [
      {},
      { hasStripeCustomer: true },
      { selected: { managedStorage: true, fastSearch: true } },
    ]) {
      expect(
        premiumControl(view({ status: status({ canManage: false, ...over }) })),
      ).toBe("none");
    }
  });

  test("nothing is offered before the status has landed", () => {
    // `null` is "not answered yet", not "free" — a section that guesses here
    // offers to sell something to a context that may already be paying.
    expect(premiumControl(view({ status: null }))).toBe("none");
  });

  test("an action this console does not hold is not drawn as one it does", () => {
    // The landing page's demo console runs this same section with no mutations
    // behind it. A button there would do nothing.
    expect(
      premiumControl(
        view({
          upgrade: undefined,
          status: status({
            selected: { managedStorage: true, fastSearch: false },
          }),
        }),
      ),
    ).toBe("none");
    expect(
      premiumControl(
        view({
          manageBilling: undefined,
          status: status({ hasStripeCustomer: true }),
        }),
      ),
    ).toBe("none");
  });

  test("a deployment that does not sell offers nothing to buy", () => {
    // A self-hoster. Everything else about the context works; there is simply
    // no checkout to open, and a button that fails is worse than no button.
    expect(
      premiumControl(
        view({
          status: status({
            configured: false,
            selected: { managedStorage: true, fastSearch: true },
          }),
        }),
      ),
    ).toBe("none");
  });

  test("but a context that is already paying still reaches its own billing", () => {
    // `configured` is about selling something new. Somebody with a live
    // subscription must be able to reach the portal to cancel it even if the
    // deployment's price id has since been removed — otherwise a
    // misconfiguration on our side becomes a subscription they cannot end.
    expect(
      premiumControl(
        view({
          status: status({ configured: false, hasStripeCustomer: true }),
        }),
      ),
    ).toBe("manage");
  });
});

describe("moving an existing context into managed storage", () => {
  test("a new managed bucket names the two-minute wait instead of inventing a copy", () => {
    const copy = managedMigrationCopy(
      status({
        status: "active",
        selected: { managedStorage: true, fastSearch: false },
        active: { managedStorage: true, fastSearch: false },
        managedProvisioning: "running",
      }),
    );
    expect(copy?.title).toMatch(/creating managed storage/i);
    expect(copy?.body).toMatch(/up to 2 minutes/i);
    expect(copy?.body).toMatch(/keep this page open/i);
    expect(copy?.body).not.toMatch(/original storage/i);
  });

  test("a ready plan without its binding reports the broken state instead of copying forever", () => {
    const copy = managedMigrationCopy(
      status({
        status: "active",
        selected: { managedStorage: true, fastSearch: false },
        active: { managedStorage: true, fastSearch: false },
        managedProvisioning: "ready",
      }),
    );
    expect(copy?.failed).toBe(true);
    expect(copy?.title).toMatch(/not connected/i);
  });
  test("the original stays authoritative while a verified copy runs", () => {
    const copy = managedMigrationCopy(
      status({
        status: "active",
        selected: { managedStorage: true, fastSearch: false },
        active: { managedStorage: true, fastSearch: false },
        managedProvisioning: "running",
        managedMigrationPhase: "copy",
        managedMigrationObjectsTotal: 50,
        managedMigrationObjectsProcessed: 40,
        managedMigrationObjectsCopied: 38,
      }),
    );
    expect(copy?.title).toMatch(/copying/i);
    expect(copy?.body).toMatch(
      /original storage stays connected and untouched/i,
    );
    expect(copy?.body).toMatch(/40 of 50 files/i);
    expect(copy?.percent).toBe(80);
  });

  test("each verification pass is named and never presented as another copy", () => {
    const source = managedMigrationCopy(
      status({
        status: "active",
        selected: { managedStorage: true, fastSearch: false },
        managedProvisioning: "running",
        managedMigrationPhase: "verify_source",
        managedMigrationObjectsTotal: 50,
        managedMigrationObjectsProcessed: 10,
      }),
    );
    expect(source?.title).toMatch(/verifying your original/i);
    expect(source?.body).toMatch(/10 of 50 files/i);
    expect(source?.percent).toBe(20);

    const target = managedMigrationCopy(
      status({
        status: "active",
        selected: { managedStorage: true, fastSearch: false },
        managedProvisioning: "running",
        managedMigrationPhase: "verify_target",
        managedMigrationObjectsTotal: 50,
        managedMigrationObjectsProcessed: 45,
      }),
    );
    expect(target?.title).toMatch(/verifying the managed copy/i);
    expect(target?.percent).toBe(90);
  });

  test("the counting pass does not invent a percentage before it knows the total", () => {
    const copy = managedMigrationCopy(
      status({
        status: "active",
        selected: { managedStorage: true, fastSearch: false },
        managedProvisioning: "running",
        managedMigrationPhase: "count",
        managedMigrationObjectsProcessed: 25,
      }),
    );
    expect(copy?.title).toMatch(/measuring/i);
    expect(copy?.body).toMatch(/25 files found/i);
    expect(copy?.percent).toBeUndefined();
  });

  test("an active step never claims one hundred percent", () => {
    const copy = managedMigrationCopy(
      status({
        status: "active",
        selected: { managedStorage: true, fastSearch: false },
        managedProvisioning: "running",
        managedMigrationPhase: "copy",
        managedMigrationObjectsTotal: 50,
        managedMigrationObjectsProcessed: 55,
      }),
    );
    expect(copy?.percent).toBe(99);
    expect(copy?.body).toMatch(/55 files checked/i);
    expect(copy?.body).toMatch(/more than the earlier count/i);
  });

  test("a stopped copy says nothing switched and retry is safe", () => {
    const copy = managedMigrationCopy(
      status({
        status: "active",
        selected: { managedStorage: true, fastSearch: false },
        active: { managedStorage: true, fastSearch: false },
        managedProvisioning: "failed",
        managedMigrationPhase: "copy",
      }),
    );
    expect(copy?.failed).toBe(true);
    expect(copy?.body).toMatch(/original remains connected and untouched/i);
    expect(copy?.body).toMatch(/safely try again/i);
  });

  test("no migration message remains after managed storage is live", () => {
    expect(
      managedMigrationCopy(
        status({
          status: "active",
          selected: { managedStorage: true, fastSearch: false },
          storageIsManaged: true,
          managedProvisioning: "ready",
        }),
      ),
    ).toBeNull();
  });
});

describe("the two entitlements", () => {
  test("independent, and the price says so", () => {
    const rows = entitlementRows(
      status({ selected: { managedStorage: true, fastSearch: false } }),
    );
    expect(rows.map((row) => row.value)).toEqual([
      "managedStorage",
      "fastSearch",
    ]);
    expect(rows[0]!.on).toBe(true);
    expect(rows[1]!.on).toBe(false);
  });

  test("the ceiling is named on the row that has one", () => {
    const rows = entitlementRows(status());
    expect(rows[0]!.detail).toContain("50 GB");
    // Fast search has no storage ceiling and must not borrow one.
    expect(rows[1]!.detail).not.toContain("50 GB");
  });

  test("the price does not move, and the group says so", () => {
    expect(entitlementsHint(status())).toContain(
      "$5 a month whichever you choose",
    );
  });

  test("a ticked box on a lapsed plan is labelled as a choice, not a state", () => {
    /*
      Only visible by rendering it: on `past_due` and `canceled` the boxes are
      ticked, because they show what was chosen, while the card above says what
      Premium adds is off. Ticked and off, side by side, with nothing saying
      which is which.
    */
    for (const raw of ["past_due", "canceled"]) {
      expect(
        entitlementsHint(
          status({
            status: raw,
            selected: { managedStorage: true, fastSearch: false },
          }),
        ),
      ).toMatch(/turns on when the subscription is active/);
    }
    // Not said where it would be noise: nothing chosen, or already paying.
    expect(entitlementsHint(status({ status: "past_due" }))).not.toMatch(
      /turns on/,
    );
    expect(
      entitlementsHint(
        status({
          status: "active",
          selected: { managedStorage: true, fastSearch: true },
        }),
      ),
    ).not.toMatch(/turns on/);
  });

  test("the rows show what was chosen, not what is active", () => {
    // A lapsed subscription keeps the choice, so resuming is a payment rather
    // than a set-up.
    const rows = entitlementRows(
      status({
        status: "past_due",
        selected: { managedStorage: true, fastSearch: true },
        active: { managedStorage: false, fastSearch: false },
      }),
    );
    expect(rows.every((row) => row.on)).toBe(true);
  });
});

describe("the price and the ceiling, as words", () => {
  test("five dollars a month", () => {
    expect(formatPrice(status())).toBe("$5 a month");
  });

  test("the price itself is the price, with no framing baked into it", () => {
    /*
      `formatPrice` renders money and nothing else. The early-tester framing is
      a separate string precisely so a price row, a badge and a receipt can
      show the number without each of them having to carry a promise — and so
      the promise cannot be smuggled into a currency formatter where no test
      about promises would ever look for it.
    */
    expect(formatPrice(status())).not.toMatch(/early|tester|held|stays/i);
  });

  test("a currency we do not have a symbol for is still legible", () => {
    expect(formatPrice(status({ currency: "eur", priceCents: 1850 }))).toBe(
      "18.50 EUR a month",
    );
  });

  test("decimal bytes, because storage is sold in decimal", () => {
    expect(formatBytes(50_000_000_000)).toBe("50 GB");
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1500)).toBe("1.5 kB");
    expect(formatBytes(-1)).toBe("—");
    expect(formatBytes(Number.NaN)).toBe("—");
  });
});

/**
 * THE PRICE IS TEMPORARY AND THE PROMISE ABOUT IT IS NOT.
 *
 * $5 is early-tester pricing: it goes up for people who join later, and the
 * people paying it now keep it for as long as they keep the subscription. The
 * second half is the one with a bill attached — it means a price rise creates
 * a new Stripe Price for new subscriptions and leaves the live ones where they
 * are. These tests hold the copy to saying both halves, and to *not* saying
 * the second one where it would be false.
 *
 * ## Sabotage record
 *
 *   `earlyTesterPriceNote` returning the note for `canceled` too       2
 *   the note dropped from the rendered panel, module untouched         2
 *   the framing baked into `formatPrice` instead of beside it          4
 *
 * The middle one is measured in `premiumPanelRender.test.ts` and is why that
 * file has its own assertions: nothing here mounts anything, so nothing here
 * notices a constant that no screen draws.
 */
describe("the early-tester price, and who is actually promised it", () => {
  test("the note says both halves: it goes up, and yours does not", () => {
    /*
      Half of this sentence is the offer and half is the commitment, and the
      commitment is the expensive half — see `docs/decisions/billing.md`. A
      note that only said "early tester price" would be an announcement that
      the price is going up, with nothing in it for the person reading it.
    */
    expect(EARLY_TESTER_PRICE_NOTE).toMatch(/goes up/i);
    expect(EARLY_TESTER_PRICE_NOTE).toMatch(/stays at this price/i);
    expect(EARLY_TESTER_PRICE_NOTE).toMatch(/as long as you keep it/i);
  });

  test("it is said where somebody is deciding, or already paying", () => {
    for (const state of ["free", "premium", "past_due"] as const) {
      expect(earlyTesterPriceNote(state)).toBe(EARLY_TESTER_PRICE_NOTE);
    }
  });

  test("it is NOT said to a context that cancelled", () => {
    /*
      The whole reason this is a function rather than a constant. The promise
      is tied to keeping the subscription; a cancelled context has not kept
      one, and restarting is a new subscription at whatever Premium costs then.
      "Yours stays at this price" rendered under "Premium has ended for this
      context" promises a rate nobody held and nobody paid for.
    */
    expect(earlyTesterPriceNote("canceled")).toBeNull();
  });

  test("a deployment that does not sell says nothing about a price", () => {
    // There is no price on the screen at all, so there is nothing to frame.
    expect(earlyTesterPriceNote("unavailable")).toBeNull();
  });

  test("every state is decided, and none of them throws", () => {
    for (const state of PREMIUM_STATES) {
      const note = earlyTesterPriceNote(state);
      expect(note === null || note === EARLY_TESTER_PRICE_NOTE).toBe(true);
    }
  });

  test("the note never qualifies the export promise", () => {
    /*
      Non-negotiable #1 is the one sentence money may not touch, and a price
      note is exactly the kind of neighbouring copy that erodes it: "locked in
      while you keep it" sitting beside leaving is one editing pass away from
      implying that leaving costs something.
    */
    expect(EARLY_TESTER_PRICE_NOTE).not.toMatch(
      /export|download|leave|leaving|cancel/i,
    );
    expect(EXPORT_PROMISE).not.toMatch(/early|tester|price/i);
  });
});

describe("what this context is using", () => {
  test("notes, and it says the ceiling is not metered", () => {
    // Bytes are not measured anywhere yet. Drawing a bar against a denominator
    // nobody measured would be a more confident lie than saying so.
    const line = usageLine(status({ notes: 412 }));
    expect(line).toContain("412 notes");
    expect(line).toContain("50 GB");
    expect(line).toMatch(/not metered yet/i);
  });

  test("a truncated walk says so rather than reading as exact", () => {
    expect(usageLine(status({ notes: 500, notesTruncated: true }))).toContain(
      "500+",
    );
  });

  test("a member gets no census at all", () => {
    // The server withholds it — a total that includes private notes lets
    // somebody derive how much they are not being shown.
    expect(usageLine(status())).toBeNull();
  });

  test("absent and zero are different answers", () => {
    expect(usageLine(status({ notes: 0 }))).toContain("0 notes");
  });
});

describe("the renewal line", () => {
  const day = Date.UTC(2026, 8, 30) / 1000;

  test("says when it renews", () => {
    expect(
      renewalLine(status({ currentPeriodEnd: day }), Date.UTC(2026, 8, 1)),
    ).toMatch(/^Renews on /);
  });

  test("and says when it is ending instead", () => {
    expect(
      renewalLine(
        status({ currentPeriodEnd: day, cancelAtPeriodEnd: true }),
        Date.UTC(2026, 8, 1),
      ),
    ).toMatch(/^Premium ends on /);
  });

  test("nothing to say without a period", () => {
    expect(renewalLine(status())).toBeNull();
  });
});

describe("a failed attempt gets our sentence", () => {
  test("the codes the control plane records", () => {
    expect(describeSessionFailure("NOT_CONFIGURED")).toMatch(/not set up/i);
    expect(describeSessionFailure("NO_CUSTOMER")).toMatch(/nothing to manage/i);
  });

  test("and anything else gets the general one rather than being rendered raw", () => {
    // A provider message can name an account, a customer or a price. Nothing
    // from Stripe reaches a screen.
    for (const code of [
      undefined,
      "",
      "STRIPE_REFUSED",
      "card_declined: cus_x",
    ]) {
      expect(describeSessionFailure(code)).toBe(
        "That did not go through. Check your connection and try again.",
      );
    }
  });
});

describe("when the section subscribes at all", () => {
  test("no context is no question", () => {
    expect(shouldReadPremium({ workspaceId: null })).toBe(false);
    expect(shouldReadPremium({ workspaceId: "ws_1" })).toBe(true);
  });
});
