/**
 * @jest-environment jsdom
 */
import { afterEach, describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { PremiumBody } from "../features/console/settings/panels/PremiumPanel";
import type { PremiumStatus, PremiumView } from "../features/console/settings/panels/premium";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function mount(view: PremiumView): HTMLElement {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(createElement(PremiumBody, { view, section: "premium" }));
  });
  return container;
}

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

/*
  THE FREE MANAGED TIER IN SETTINGS › PREMIUM.

  A usage line while there is room; the nudge once the cap is reached, with
  its two ways forward drawn only where they can act; nothing at all for a
  context without a cap. Sabotage: rendering the nudge below the cap fails the
  first; dropping the `noteCap` check fails the third.
*/
describe("the free tier's note cap", () => {
  test("below the cap, one line of usage and no nudge", () => {
    const text = mount(view({ status: status({ freeManaged: true, noteCap: 1000, notes: 420 }) })).textContent ?? "";
    expect(text).toContain("Free plan: 420 of 1,000 notes.");
    expect(text).not.toContain("free-tier cap");
  });

  test("at the cap, the nudge — saying what still works — with both ways forward", () => {
    let opened = 0;
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
    roots.push(() => {
      act(() => root.unmount());
      container.remove();
    });
    act(() => {
      root.render(
        createElement(PremiumBody, {
          view: view({ status: status({ freeManaged: true, noteCap: 1000, notes: 1000 }) }),
          section: "premium",
          onOpenStorage: () => {
            opened += 1;
          },
        }),
      );
    });
    const text = container.textContent ?? "";
    expect(text).toMatch(/reached the free-tier cap/);
    expect(text).toMatch(/editing, moving and downloading what you have all keep working/);
    expect(container.querySelector('[data-testid="payment-level-up"]')).not.toBeNull();
    const own = container.querySelector('[data-testid="payment-bring-own"]') as HTMLElement | null;
    expect(own).not.toBeNull();
    act(() => own!.click());
    expect(opened).toBe(1);
  });

  test("a context with no cap is told nothing about one", () => {
    const text = mount(view({ status: status({ notes: 5000 }) })).textContent ?? "";
    expect(text).not.toMatch(/Free plan:|free-tier cap/);
  });

  test("a member sees where the context stands, with no button they cannot use", () => {
    const container = mount(
      view({ status: status({ freeManaged: true, noteCap: 1000, notes: 1000, canManage: false }), upgrade: undefined }),
    );
    expect(container.querySelector('[data-testid="premium-free-nudge"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="payment-level-up"]')).toBeNull();
    expect(container.querySelector('[data-testid="payment-bring-own"]')).toBeNull();
  });
});
