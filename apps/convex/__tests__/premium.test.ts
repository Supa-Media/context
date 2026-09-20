/**
 * WHAT PREMIUM IS, AND WHAT IT MAY NEVER REACH.
 *
 * Two things are being pinned here and they are not the same kind of thing.
 *
 * The first is arithmetic: a price, a ceiling, and the AND of "asked for" and
 * "paying". Those are easy to get right and easy to quietly change, so they
 * are written down.
 *
 * The second is the one that matters. **Nothing about a plan may decide
 * whether somebody can leave with their notes.** Non-negotiable #1 says the
 * exit is free, identical on both plans, and still works after a cancellation
 * — so a plan module that grew a `canExport`, an export quota, or an expiry
 * attached to one would be the product changing into a different product, and
 * it would look like a feature while it did it. The test at the bottom of this
 * file reads the module's own exports and fails on the shape.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted; counts as measured, across this
 * file, `billing.test.ts` and `structure.test.ts` together.
 *
 *   `planStatusFromStripe` defaulting to "active"                     1
 *   `activeEntitlements` ignoring the status                          4
 *   `stripePriceId` returning a malformed value instead of throwing   1
 *   `stripeSignatureIsValid` returning true for an absent secret      2
 *   `stripeSignatureIsValid` skipping the timestamp check             2
 *   `stripeSignatureIsValid` reading only the first v1 digest         1
 *   `parseStripeSignatureHeader` accepting a non-numeric `t`          1
 *   an exported `canExport` added to `lib/premium.ts`                 1
 *
 * **`planStatusFromStripe` defaulting to "active"** is one, and one is thin
 * for the guard that decides whether an unrecognised word is a free upgrade.
 * It is one because a single test walks every unknown input; splitting it into
 * eight would raise the number and prove nothing more. What would genuinely
 * widen it is a behavioural test at the webhook — an event carrying a status
 * Stripe has not invented yet — and there is nowhere honest to get one.
 */

import { describe, expect, test } from "vitest";
import * as premium from "../functions/lib/premium";
import {
  MANAGED_STORAGE_CEILING_BYTES,
  PREMIUM_CURRENCY,
  PREMIUM_INTERVAL,
  PREMIUM_PRICE_CENTS,
  STRIPE_PRICE_ID_ENV_VAR,
  activeEntitlements,
  cancellationMakesReadOnly,
  hasAnyEntitlement,
  planIsPaying,
  planStatusFromStripe,
  stripePriceId,
} from "../functions/lib/premium";
import {
  HANDLED_EVENT_TYPES,
  STRIPE_API_VERSION,
  formEncode,
  isHandledEventType,
  parseStripeSignatureHeader,
  stripeEventFacts,
  stripeSignatureIsValid,
} from "../functions/lib/stripe";

const bothOff = { managedStorage: false, fastSearch: false };
const bothOn = { managedStorage: true, fastSearch: true };

describe("the price and the ceiling", () => {
  test("five dollars a month, in cents", () => {
    expect(PREMIUM_PRICE_CENTS).toBe(500);
    expect(PREMIUM_CURRENCY).toBe("usd");
    expect(PREMIUM_INTERVAL).toBe("month");
  });

  test("the same price whichever entitlements are chosen", () => {
    // À la carte means "pick what you want", not "pick what you pay". There is
    // one price constant and no function taking entitlements and returning a
    // number — the absence is the assertion.
    const priced = Object.entries(premium).filter(
      ([name]) => /price|cents|amount/i.test(name) && name !== "STRIPE_PRICE_ID_ENV_VAR",
    );
    expect(priced.map(([name]) => name).sort()).toEqual([
      "PREMIUM_PRICE_CENTS",
      "stripePriceId",
    ]);
  });

  test("fifty gigabytes, stated as the arithmetic", () => {
    expect(MANAGED_STORAGE_CEILING_BYTES).toBe(50_000_000_000);
  });
});

describe("reading Stripe's status word", () => {
  test("the states that are serving", () => {
    expect(planStatusFromStripe("active")).toBe("active");
    expect(planStatusFromStripe("trialing")).toBe("active");
  });

  test("the states that are not", () => {
    for (const raw of ["past_due", "incomplete", "unpaid"]) {
      expect(planStatusFromStripe(raw)).toBe("past_due");
    }
    for (const raw of ["canceled", "incomplete_expired"]) {
      expect(planStatusFromStripe(raw)).toBe("canceled");
    }
  });

  test("a word this build has never heard of is never a free upgrade", () => {
    // The direction this must fail. A newer Stripe API version naming a state
    // we do not know must not be read as "paying" — that is an entitlement
    // bought by a vocabulary change.
    for (const raw of [undefined, null, "", "ACTIVE", "paused", 1, {}]) {
      expect(planStatusFromStripe(raw)).toBe("unknown");
      expect(planIsPaying(planStatusFromStripe(raw))).toBe(false);
    }
  });
});

describe("selected is not the same as active", () => {
  test("both halves have to be true", () => {
    expect(activeEntitlements(bothOn, "active")).toEqual(bothOn);
    expect(activeEntitlements(bothOn, "past_due")).toEqual(bothOff);
    expect(activeEntitlements(bothOn, "canceled")).toEqual(bothOff);
    expect(activeEntitlements(bothOn, "none")).toEqual(bothOff);
    expect(activeEntitlements(bothOn, "unknown")).toEqual(bothOff);
  });

  test("a lapse does not erase what the owner chose", () => {
    // So resuming is a payment rather than a re-selection. `selected` is
    // returned beside `active` for this reason and must not be overwritten.
    const selected = { managedStorage: true, fastSearch: false };
    expect(activeEntitlements(selected, "past_due")).toEqual(bothOff);
    expect(selected).toEqual({ managedStorage: true, fastSearch: false });
  });

  test("the two entitlements are independent", () => {
    expect(activeEntitlements({ managedStorage: true, fastSearch: false }, "active"))
      .toEqual({ managedStorage: true, fastSearch: false });
    expect(activeEntitlements({ managedStorage: false, fastSearch: true }, "active"))
      .toEqual({ managedStorage: false, fastSearch: true });
  });

  test("a subscription buys at least one of them", () => {
    expect(hasAnyEntitlement(bothOff)).toBe(false);
    expect(hasAnyEntitlement({ managedStorage: true, fastSearch: false })).toBe(true);
    expect(hasAnyEntitlement({ managedStorage: false, fastSearch: true })).toBe(true);
  });
});

describe("what a lapse does, and what it may never do", () => {
  test("only a managed context goes read-only", () => {
    // A bucket the customer owns keeps working whatever we think of their
    // card. Our credential is theirs to revoke, not ours to hold over them.
    expect(cancellationMakesReadOnly("canceled", true)).toBe(true);
    expect(cancellationMakesReadOnly("canceled", false)).toBe(false);
    expect(cancellationMakesReadOnly("active", true)).toBe(false);
  });

  test("nothing in this module answers whether somebody may export", () => {
    /*
      The guard for the first non-negotiable, and it is deliberately a shape
      test rather than a behavioural one: the failure it exists to catch is a
      function being *added*, and there is no behaviour to assert about a
      function that does not exist yet.

      Anything matching this is a plan deciding an exit — `canExport`,
      `exportLimitBytes`, `exportWindowDays`, `downloadAllowed`. Adding one and
      running this file is how the conversation starts.
    */
    const exits = Object.keys(premium).filter((name) =>
      /export|download|handoff|handOff|leave|retention/i.test(name),
    );
    expect(
      exits,
      "a plan must never decide whether somebody can leave with their notes",
    ).toEqual([]);
  });
});

describe("the price id is configuration, not a credential", () => {
  test("absent is an ordinary state", () => {
    // A self-hoster sells nothing and must not be told they have
    // misconfigured something.
    expect(stripePriceId({})).toBeNull();
    expect(stripePriceId({ [STRIPE_PRICE_ID_ENV_VAR]: "" })).toBeNull();
    expect(stripePriceId({ [STRIPE_PRICE_ID_ENV_VAR]: "   " })).toBeNull();
  });

  test("present and well-formed is returned verbatim", () => {
    // Obviously fake, like every fixture in this public repository.
    expect(stripePriceId({ [STRIPE_PRICE_ID_ENV_VAR]: " price_FAKE00000000 " })).toBe(
      "price_FAKE00000000",
    );
  });

  test("case is not folded, because a Stripe id is case-sensitive", () => {
    expect(stripePriceId({ [STRIPE_PRICE_ID_ENV_VAR]: "price_AbCdEfGh" })).toBe(
      "price_AbCdEfGh",
    );
  });

  test("present and malformed throws rather than disabling billing silently", () => {
    for (const raw of ["not-a-price", "price_", "sub_FAKE00000000", "price_x"]) {
      expect(() => stripePriceId({ [STRIPE_PRICE_ID_ENV_VAR]: raw })).toThrow();
    }
  });

  test("a refusal does not echo the value back", () => {
    try {
      stripePriceId({ [STRIPE_PRICE_ID_ENV_VAR]: "definitely-not-a-price-id" });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(String(error)).not.toContain("definitely-not-a-price-id");
    }
  });
});

/*
  The signature fixtures below are computed here rather than pasted, because a
  pasted digest is a digest nobody can re-derive when the format changes — and
  because this repository is public and a real Stripe signature, even an
  expired one, is somebody's traffic.
*/
const SIGNING_SECRET = "whsec_obviously_fake_test_secret";

async function sign(payload: string, timestampSeconds: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(SIGNING_SECRET),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(`${timestampSeconds}.${payload}`),
  );
  return [...new Uint8Array(mac)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

describe("the webhook signature is the whole security of the endpoint", () => {
  const payload = JSON.stringify({ id: "evt_fake", type: "ping" });
  const nowSeconds = 1_780_000_000;
  const nowMs = nowSeconds * 1000;

  test("a body signed with the endpoint's secret is accepted", async () => {
    /*
      Named for what it does. It said "a body Stripe signed", and Stripe signed
      nothing here — `sign()` above is the same construction as the verifier, so
      this proves the two agree and would not notice if both computed the MAC
      over the wrong preimage. What holds the construction itself is the
      documented scheme, and the negative cases below: a body edited after
      signing, a timestamp moved, a v0 scheme, a wrong secret.
    */
    const digest = await sign(payload, nowSeconds);
    expect(
      await stripeSignatureIsValid({
        payload,
        header: `t=${nowSeconds},v1=${digest}`,
        secret: SIGNING_SECRET,
        nowMs,
      }),
    ).toBe(true);
  });

  test("a deployment with no signing secret verifies nothing", async () => {
    // The direction this must fail. "Unconfigured means allow" makes the
    // endpoint a free upgrade for anybody who can find the URL, and it is the
    // shape of mistake that ships because it makes staging work.
    const digest = await sign(payload, nowSeconds);
    for (const secret of [undefined, ""]) {
      expect(
        await stripeSignatureIsValid({
          payload,
          header: `t=${nowSeconds},v1=${digest}`,
          secret,
          nowMs,
        }),
      ).toBe(false);
    }
  });

  test("a body edited after signing is refused", async () => {
    const digest = await sign(payload, nowSeconds);
    expect(
      await stripeSignatureIsValid({
        payload: payload.replace("ping", "pong"),
        header: `t=${nowSeconds},v1=${digest}`,
        secret: SIGNING_SECRET,
        nowMs,
      }),
    ).toBe(false);
  });

  test("the timestamp is inside the MAC, so it cannot be edited either", async () => {
    const digest = await sign(payload, nowSeconds);
    expect(
      await stripeSignatureIsValid({
        payload,
        header: `t=${nowSeconds + 1},v1=${digest}`,
        secret: SIGNING_SECRET,
        nowMs,
      }),
    ).toBe(false);
  });

  test("a valid old delivery cannot be replayed forever", async () => {
    const digest = await sign(payload, nowSeconds);
    expect(
      await stripeSignatureIsValid({
        payload,
        header: `t=${nowSeconds},v1=${digest}`,
        secret: SIGNING_SECRET,
        nowMs: nowMs + 10 * 60 * 1000,
      }),
    ).toBe(false);
  });

  test("nor one stamped in the future", async () => {
    const digest = await sign(payload, nowSeconds);
    expect(
      await stripeSignatureIsValid({
        payload,
        header: `t=${nowSeconds},v1=${digest}`,
        secret: SIGNING_SECRET,
        nowMs: nowMs - 10 * 60 * 1000,
      }),
    ).toBe(false);
  });

  test("every v1 digest is tried, so a secret rotation does not break it", async () => {
    // Stripe sends more than one signature during a rotation. A verifier that
    // reads the first refuses every request for the length of the rotation.
    const digest = await sign(payload, nowSeconds);
    expect(
      await stripeSignatureIsValid({
        payload,
        header: `t=${nowSeconds},v1=${"0".repeat(64)},v1=${digest}`,
        secret: SIGNING_SECRET,
        nowMs,
      }),
    ).toBe(true);
  });

  test("a v0 signature is not a v1 signature", async () => {
    const digest = await sign(payload, nowSeconds);
    expect(
      await stripeSignatureIsValid({
        payload,
        header: `t=${nowSeconds},v0=${digest}`,
        secret: SIGNING_SECRET,
        nowMs,
      }),
    ).toBe(false);
  });

  test("a header that is not a header is one answer, never an exception", async () => {
    for (const header of [
      null,
      undefined,
      "",
      "garbage",
      "t=,v1=abc",
      `t=notanumber,v1=${"a".repeat(64)}`,
      `t=${nowSeconds}`,
      `v1=${"a".repeat(64)}`,
    ]) {
      expect(
        await stripeSignatureIsValid({
          payload,
          header,
          secret: SIGNING_SECRET,
          nowMs,
        }),
      ).toBe(false);
    }
  });

  test("a wrong secret does not verify", async () => {
    const digest = await sign(payload, nowSeconds);
    expect(
      await stripeSignatureIsValid({
        payload,
        header: `t=${nowSeconds},v1=${digest}`,
        secret: "whsec_a_different_fake_secret",
        nowMs,
      }),
    ).toBe(false);
  });

  test("the parser reads what it should and refuses what it should not", () => {
    expect(parseStripeSignatureHeader(`t=1,v1=AB,v1=cd`)).toEqual({
      timestamp: 1,
      signatures: ["ab", "cd"],
    });
    expect(parseStripeSignatureHeader("t=0x10,v1=ab")).toBeNull();
    expect(parseStripeSignatureHeader("t= 1 ,v1=zz")).toBeNull();
  });
});

describe("what is read off an event, and what is not", () => {
  /*
    Fixtures built from Stripe's documented payload shapes. NOTHING HERE WAS
    OBSERVED FROM A LIVE STRIPE ACCOUNT: no request has been made against
    api.stripe.com from this environment, so these tests prove this code reads
    the shape the documentation describes and prove nothing at all about the
    live contract.
  */
  const checkoutCompleted = {
    id: "evt_fake_checkout",
    object: "event",
    type: "checkout.session.completed",
    created: 1_780_000_000,
    data: {
      object: {
        id: "cs_test_fake",
        object: "checkout.session",
        client_reference_id: "attempt_row_id",
        customer: "cus_FAKE",
        subscription: "sub_FAKE",
        status: "complete",
        payment_status: "paid",
      },
    },
  };

  const subscriptionUpdated = {
    id: "evt_fake_sub",
    object: "event",
    type: "customer.subscription.updated",
    created: 1_780_000_100,
    data: {
      object: {
        id: "sub_FAKE",
        object: "subscription",
        customer: "cus_FAKE",
        status: "past_due",
        current_period_end: 1_782_000_000,
        cancel_at_period_end: true,
      },
    },
  };

  test("a completed checkout names our own attempt row, not a workspace", () => {
    const facts = stripeEventFacts(checkoutCompleted);
    expect(facts?.checkoutRef).toBe("attempt_row_id");
    expect(facts?.subscriptionId).toBe("sub_FAKE");
    expect(facts?.customerId).toBe("cus_FAKE");
    // The workspace is read off our row. An id arriving from outside may veto
    // and may never select — the same rule `expectedWorkspaceId` follows.
    expect(Object.keys(facts ?? {})).not.toContain("workspaceId");
  });

  test("a session's own words are not read as a subscription's", () => {
    // `complete`/`open`/`expired` against `active`/`past_due`/`canceled`: two
    // vocabularies about two objects. Reading one as the other mapped a paid
    // checkout onto a status this build has never heard of, which is how a
    // person who had just paid saw nothing happen. Caught by
    // `billing.test.ts`; pinned here at the level it went wrong.
    const facts = stripeEventFacts(checkoutCompleted);
    expect(facts?.rawStatus).toBeUndefined();
    expect(facts?.sessionStatus).toBe("complete");
    expect(facts?.paymentStatus).toBe("paid");

    const subscription = stripeEventFacts(subscriptionUpdated);
    expect(subscription?.sessionStatus).toBeUndefined();
    expect(subscription?.paymentStatus).toBeUndefined();
  });

  test("a subscription event is its own object", () => {
    const facts = stripeEventFacts(subscriptionUpdated);
    expect(facts?.subscriptionId).toBe("sub_FAKE");
    expect(facts?.rawStatus).toBe("past_due");
    expect(facts?.currentPeriodEndSeconds).toBe(1_782_000_000);
    expect(facts?.cancelAtPeriodEnd).toBe(true);
  });

  test("a body that is not an event at all is null, not a half-read one", () => {
    for (const body of [null, undefined, "", 7, {}, { id: "evt_x" }, { type: "x" }]) {
      expect(stripeEventFacts(body)).toBeNull();
    }
  });

  test("only the four types somebody chose are acted on", () => {
    expect([...HANDLED_EVENT_TYPES]).toEqual([
      "checkout.session.completed",
      "customer.subscription.created",
      "customer.subscription.updated",
      "customer.subscription.deleted",
    ]);
    // The near-misses: each carries a subscription and reads plausibly.
    for (const type of [
      "invoice.payment_failed",
      "invoice.paid",
      "customer.subscription.trial_will_end",
      "checkout.session.expired",
    ]) {
      expect(isHandledEventType(type)).toBe(false);
    }
  });
});

describe("talking to Stripe", () => {
  test("the request body is form-encoded the way Stripe documents", () => {
    expect(
      formEncode({
        mode: "subscription",
        "line_items[0][price]": "price_FAKE",
        "line_items[0][quantity]": 1,
      }),
    ).toBe(
      "mode=subscription&line_items%5B0%5D%5Bprice%5D=price_FAKE&line_items%5B0%5D%5Bquantity%5D=1",
    );
  });

  test("the API version is sent on outbound calls, and claims nothing about webhooks", () => {
    /*
      This test used to be called "the API version is pinned rather than
      inherited from the dashboard" and asserted a protection that does not
      exist. `Stripe-Version` pins what comes back from a call WE make. A
      webhook payload's shape is decided by the ENDPOINT's version, and there is
      no header on an inbound request to pin — the request is Stripe's.

      The version below is therefore a statement about outbound calls only, and
      the reader for the field that actually moved is tested beside it.
    */
    expect(STRIPE_API_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("the renewal date is read in both shapes Stripe has put it in", () => {
    /*
      `current_period_end` moved off the subscription and onto
      `items.data[].current_period_end` in the `2025-03-31` versions. Reading
      only the old place yields `undefined` on any deployment whose endpoint is
      on a current version — and the console's renewal line then vanishes with
      no error anywhere, which is the kind of wrong answer nobody reports.
    */
    const older = stripeEventFacts({
      id: "evt_fake_old_shape",
      type: "customer.subscription.updated",
      created: 1_780_000_000,
      data: {
        object: {
          id: "sub_FAKE",
          object: "subscription",
          status: "active",
          current_period_end: 1_782_000_000,
        },
      },
    });
    expect(older?.currentPeriodEndSeconds).toBe(1_782_000_000);

    const newer = stripeEventFacts({
      id: "evt_fake_new_shape",
      type: "customer.subscription.updated",
      created: 1_780_000_000,
      data: {
        object: {
          id: "sub_FAKE",
          object: "subscription",
          status: "active",
          items: {
            object: "list",
            data: [{ id: "si_FAKE", current_period_end: 1_782_000_000 }],
          },
        },
      },
    });
    expect(newer?.currentPeriodEndSeconds).toBe(1_782_000_000);

    // And neither shape present is still absent rather than a guess.
    const neither = stripeEventFacts({
      id: "evt_fake_no_period",
      type: "customer.subscription.updated",
      created: 1_780_000_000,
      data: { object: { id: "sub_FAKE", object: "subscription", status: "active" } },
    });
    expect(neither?.currentPeriodEndSeconds).toBeUndefined();
  });
});
