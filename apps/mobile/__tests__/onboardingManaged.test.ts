/**
 * @jest-environment jsdom
 */

/**
 * THE THIRD ANSWER ON THE STORAGE STEP, AND THE TWO SCREENS BEHIND IT.
 *
 * What these assert, in the order they matter:
 *
 * 1. **It is absent where it cannot be delivered.** A card that takes $20 for
 *    storage that cannot be created is the worst failure this flow has,
 *    because it happens *after* the payment. The control plane answers one
 *    question — a price to charge and somewhere to put the bucket — and a
 *    `false` means the card is not drawn at all rather than drawn and
 *    disabled.
 * 2. **Nobody reaches Stripe without being told the price and the unit.** The
 *    confirmation screen exists for exactly that, and a version of it missing
 *    either sentence is worse than no screen.
 * 3. **The settling screen never says "failed".** Nothing has. The payment
 *    succeeded and a webhook is in flight.
 *
 * The layout of all three is checked in a browser (`e2e/webkit/first-run.spec.ts`)
 * — jsdom lays nothing out, and the first defect in this work was a card whose
 * `flexBasis: "100%"` in a column asked for the full height of the step and
 * drew itself over the skip button.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   the managed card drawn regardless of `available`                   1
 *   `ManagedConfirm` rendering without the billable-unit sentence      1
 *   the export promise dropped from the confirmation                   1
 *   `ManagedSettling` describing the wait as a failure                 1
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

/*
  The storage choice reaches for a Convex client to start the Dropbox redirect
  — `useDropboxStart` calls `useAction` unconditionally — and there is no
  backend behind a step being asked what it draws. The boundary is drawn at
  the module, as `scripts/ux-audit-shots.ts` draws it, rather than at the one
  hook: a component that asks for a client gets one that answers nothing.
*/
jest.mock("convex/react", () => ({
  useAction: () => async () => undefined,
  useMutation: () => async () => undefined,
  useQuery: () => undefined,
  useQueries: () => ({}),
  useConvex: () => undefined,
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
}));
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { StorageStepBody } from "../features/onboarding/steps/StorageStep";
import { EXPORT_PROMISE, type PremiumStatus } from "../features/console/settings/panels/premium";
import type { ManagedOffer } from "../features/onboarding/useManagedOffer";

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

const status: PremiumStatus = {
  status: "none",
  selected: { managedStorage: true, fastSearch: false },
  active: { managedStorage: false, fastSearch: false },
  canManage: true,
  configured: true,
  priceCents: 2000,
  currency: "usd",
  interval: "month",
  ceilingBytes: 50_000_000_000,
  storageIsManaged: false,
  managedStorageAvailable: true,
};

function offer(over: Partial<ManagedOffer> = {}): ManagedOffer {
  return {
    available: true,
    price: "$20 a month",
    status,
    mode: "choose",
    session: "choosing",
    paid: false,
    slow: false,
    choose: () => {},
    back: () => {},
    toggle: () => {},
    proceed: () => {},
    retry: () => {},
    ...over,
  };
}

function mount(managed: ManagedOffer | null, storageReady = false): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(
      createElement(StorageStepBody, {
        connectState: { kind: "idle" },
        workspaceId: "ws",
        contextName: "@seyi",
        connect: async () => ({ status: "ok" }),
        managed,
        storageReady,
        onSkip: () => {},
        onContinuePast: () => {},
      }),
    );
  });
  return container;
}

describe("offering storage we keep", () => {
  test("a deployment that cannot provide it does not offer it", () => {
    for (const managed of [null, offer({ available: false })]) {
      const container = mount(managed);
      expect(container.querySelector('[data-testid="choose-managed"]')).toBeNull();
      // And the two free answers are untouched, which is the other half of the
      // rule: nothing about the BYO path gets longer because a paid one exists.
      expect(container.querySelector('[data-testid="choose-bucket"]')).not.toBeNull();
      expect(container.querySelector('[data-testid="choose-dropbox"]')).not.toBeNull();
    }
  });

  test("where it can, the card says what it costs on its own face", () => {
    const container = mount(offer());
    const card = container.querySelector('[data-testid="choose-managed"]');
    expect(card).not.toBeNull();
    expect(card?.textContent ?? "").toContain("$20 a month");
    // Ordered after the free ones. A screen that sold above a free option
    // would be selling against its own free tier.
    const order = [...container.querySelectorAll("[data-testid]")]
      .map((node) => node.getAttribute("data-testid"))
      .filter((id) => id !== null && id.startsWith("choose-"));
    expect(order).toEqual(["choose-bucket", "choose-dropbox", "choose-managed"]);
  });
});

describe("the screen before Stripe", () => {
  const confirming = () => mount(offer({ mode: "confirm" }));

  test("states the price", () => {
    expect(confirming().textContent ?? "").toContain("$20 a month");
  });

  test("and that it covers this context and nothing else", () => {
    const words = confirming().textContent ?? "";
    expect(words).toContain("@seyi");
    expect(words).toContain("nothing else");
    expect(words).toContain("Every other brain or workspace");
  });

  test("and the promise that may never be conditional", () => {
    expect(confirming().textContent ?? "").toContain(EXPORT_PROMISE);
  });

  test("and what happens after the payment, in order", () => {
    const words = confirming().textContent ?? "";
    expect(words).toContain("Stripe brings you back here");
    expect(words).toContain("We create your storage");
  });

  test("with nothing ticked there is nothing to continue to", () => {
    const container = mount(
      offer({
        mode: "confirm",
        status: { ...status, selected: { managedStorage: false, fastSearch: false } },
      }),
    );
    const button = container.querySelector('[data-testid="managed-confirm-continue"]');
    expect(button?.getAttribute("aria-disabled")).toBe("true");
    expect(container.textContent ?? "").toContain("Tick managed storage");
  });

  test("and it never invents a reason to hurry", () => {
    const words = (confirming().textContent ?? "").toLowerCase();
    for (const pressure of ["hurry", "limited", "offer ends", "most popular", "discount"]) {
      expect(words).not.toContain(pressure);
    }
  });
});

describe("back from Stripe, mid-flow", () => {
  test("nothing has failed, and it does not say so", () => {
    const words = mount(offer({ mode: "settling" })).textContent ?? "";
    expect(words).toContain("Payment received");
    expect(words.toLowerCase()).not.toContain("failed");
    expect(words.toLowerCase()).not.toContain("error");
  });

  test("the steps say what is happening rather than a percentage", () => {
    const container = mount(offer({ mode: "settling", paid: true }));
    const steps = container.querySelector('[data-testid="managed-settling-steps"]');
    expect(steps?.textContent ?? "").toContain("Payment confirmed");
    expect(steps?.textContent ?? "").toContain("Creating your storage");
    expect(container.textContent ?? "").not.toMatch(/\\d+%/);
  });

  test("provisioning that gave up says so, instead of spinning for ever", () => {
    /*
      THE WORST STATE IN THE PRODUCT: money taken, nothing delivered.

      Three things this screen owes, in this order — the payment and the notes
      are safe, a retry cannot duplicate anything, and here is the free path
      out. The third is not a punishment: somebody stuck here has already
      waited long enough.

      "Trying again is safe" is a statement of fact rather than reassurance.
      Provisioning adopts the bucket named for this workspace, and
      `apps/convex/__tests__/managedProvisioning.test.ts` holds it to that.
    */
    const container = mount(
      offer({
        mode: "settling",
        paid: true,
        provisionFailure: {
          title: "We could not finish setting up your storage",
          body: "Your payment went through and nothing has been lost. This is our end, not yours — trying again is safe and will not create a second copy of anything.",
          canRetry: true,
        },
      }),
    );
    const words = container.textContent ?? "";
    expect(words).toContain("Your payment went through");
    expect(words).toContain("nothing has been lost");
    expect(words).toContain("will not create a second copy");
    expect(container.querySelector('[data-testid="managed-settling-retry"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="managed-settling-own"]')).not.toBeNull();
    // And it is no longer pretending to be busy.
    expect(container.querySelector('[data-testid="managed-settling-steps"]')).toBeNull();
  });

  test("a failure nothing can retry does not offer a button that cannot help", () => {
    // `NOT_CONFIGURED` is an operator error: pressing again will fail the same
    // way, and a retry that cannot work is worse than no retry.
    const container = mount(
      offer({
        mode: "settling",
        paid: true,
        provisionFailure: {
          title: "We cannot set up storage on this deployment yet",
          body: "Your payment went through and nothing has been lost.",
          canRetry: false,
        },
      }),
    );
    expect(container.querySelector('[data-testid="managed-settling-retry"]')).toBeNull();
    expect(container.querySelector('[data-testid="managed-settling-own"]')).not.toBeNull();
  });

  test("a wait that stops being ordinary offers two ways out, neither a dead end", () => {
    const container = mount(offer({ mode: "settling", paid: true, slow: true }));
    const words = container.textContent ?? "";
    expect(words).toContain("Still working");
    expect(words).toContain("You can close this");
    expect(words).toContain("Your payment is safe");
    expect(container.querySelector('[data-testid="managed-settling-own"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="managed-settling-carry-on"]')).not.toBeNull();
  });
});
