/**
 * @jest-environment jsdom
 */

/**
 * STORAGE WE RUN, OFFERED WHERE A WORKSPACE IS MADE.
 *
 * The card was missing from this step and present in first run, which read as
 * a policy — "managed storage is for workspaces" — and was a wiring gap. Billing
 * is keyed by `workspaceId` throughout (`billing.status`, `startCheckout`,
 * `managedBucketName`), so a workspace has always been a thing that can be put
 * on storage we run; the only route to it was finishing the flow and finding
 * Premium in the workspace's settings.
 *
 * What these assert:
 *
 * 1. **Absent where it cannot be delivered**, exactly as in first run — a card
 *    that takes $5 for a bucket that cannot be created fails *after* the
 *    payment. `onboardingManaged.test.ts` makes the same assertion about the
 *    other flow; both matter, because the two steps pass the offer in
 *    separately.
 * 2. **The confirmation names this workspace**, not the creator's own. The
 *    billable unit is the thing people get wrong, and getting it wrong here
 *    would mean somebody paying twice for what they thought was an account.
 * 3. **It does not promise a return it cannot make.** Stripe comes back to a
 *    URL, and this flow is component state: `WORKSPACE_AFTER_PAY` says the
 *    workspace's settings, and the first-run sentence must not leak in.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits and reverted.
 *
 *   the managed card drawn regardless of `available`                   1
 *   `WORKSPACE_AFTER_PAY` swapped for the first-run sequence           1
 *   the confirmation named the creator rather than the workspace       1
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

/*
  Same boundary as `onboardingManaged.test.ts`: the storage choice reaches for
  a Convex client to start the Dropbox redirect, and there is no backend behind
  a step being asked what it draws.
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
import { WorkspaceStorageStepBody } from "../features/workspace/steps/WorkspaceStorageStep";
import { WORKSPACE_AFTER_PAY } from "../features/workspace/create";
import { FIRST_RUN_AFTER_PAY } from "../features/onboarding/steps/ManagedConfirm";
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
  priceCents: 500,
  currency: "usd",
  interval: "month",
  ceilingBytes: 50_000_000_000,
  storageIsManaged: false,
  managedStorageAvailable: true,
};

function offer(over: Partial<ManagedOffer> = {}): ManagedOffer {
  return {
    available: true,
    price: "$5 a month",
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

function mount(managed: ManagedOffer | null): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, {
    onUncaughtError: () => {},
    onCaughtError: () => {},
  });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(
      createElement(WorkspaceStorageStepBody, {
        connectState: { kind: "idle" },
        workspaceId: "ws",
        slug: "acme",
        connect: async () => ({ status: "ok" }),
        managed,
        onSkip: () => {},
        onContinuePast: () => {},
      }),
    );
  });
  return container;
}

describe("the bucket step of a new workspace", () => {
  test("offers storage we run, at the price, beside the one they bring", () => {
    const container = mount(offer());
    const card = container.querySelector('[data-testid="choose-managed"]');
    expect(card).not.toBeNull();
    expect(card?.textContent ?? "").toContain("$5 a month");
    const order = [...container.querySelectorAll("[data-testid]")]
      .map((node) => node.getAttribute("data-testid"))
      .filter((id) => id !== null && id.startsWith("choose-"));
    expect(order).toEqual(["choose-own-storage", "choose-managed"]);
  });

  test("and never where the deployment cannot provide it", () => {
    for (const managed of [null, offer({ available: false })]) {
      const container = mount(managed);
      expect(container.querySelector('[data-testid="choose-managed"]')).toBeNull();
      // Bringing your own storage is unaffected either way.
      expect(container.querySelector('[data-testid="choose-own-storage"]')).not.toBeNull();
    }
  });

  test("pressing it opens the confirmation rather than Stripe", () => {
    let chosen = 0;
    const container = mount(offer({ choose: () => (chosen += 1) }));
    const card = container.querySelector('[data-testid="choose-managed"]') as HTMLElement;
    act(() => card.click());
    expect(chosen).toBe(1);
  });
});

describe("the screen before Stripe, in this flow", () => {
  const confirming = () => mount(offer({ mode: "confirm" }));

  test("names the workspace as the billable unit, not the person", () => {
    const words = confirming().textContent ?? "";
    expect(words).toContain("@acme");
    expect(words).toContain("nothing else");
  });

  test("states the price and the promise that is never conditional", () => {
    const words = confirming().textContent ?? "";
    expect(words).toContain("$5 a month");
    expect(words).toContain(EXPORT_PROMISE);
  });

  /**
   * The one sentence this flow cannot borrow. `origin: "settings"` sends the
   * return to `/console/@acme?settings=premium`, so "back here" would be a
   * promise the redirect does not keep — and the two remaining steps of this
   * flow are skipped by the trip, which is what the sequence has to say.
   */
  test("says where the payment actually returns to", () => {
    const words = confirming().textContent ?? "";
    for (const line of WORKSPACE_AFTER_PAY) expect(words).toContain(line);
    expect(words).toContain("settings");
    expect(words).not.toContain(FIRST_RUN_AFTER_PAY[0]);
  });
});
