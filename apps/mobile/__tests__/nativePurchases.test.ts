/** @jest-environment jsdom */
import { test, expect, jest } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Platform } from "react-native";
import { PremiumBody } from "../features/console/settings/panels/PremiumPanel";
import { demoPremiumView, EXPORT_PROMISE } from "../features/console/settings/panels/premium";
import { StorageChoiceBody } from "../features/console/storage/StorageChoice";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

for (const os of ["ios", "android"] as const) {
  test(`${os} never renders checkout, prices, or a website purchase instruction`, () => {
    const before = Platform.OS;
    Object.defineProperty(Platform, "OS", { configurable: true, value: os });
    const host = document.createElement("div");
    const root = createRoot(host);
    try {
      const view = { ...demoPremiumView(), upgrade: jest.fn(async () => {}), manageBilling: jest.fn(async () => {}), choose: jest.fn(async () => {}), session: { status: "ready" as const, kind: "checkout" as const, url: "https://checkout.stripe.com/test" } };
      act(() => root.render(createElement(PremiumBody, { view })));
      expect(host.querySelector('[data-testid="premium-upgrade"]')).toBeNull();
      expect(host.querySelector('[data-testid="premium-manage"]')).toBeNull();
      expect(host.querySelector('[data-testid="premium-continue"]')).toBeNull();
      expect(host.querySelector('[data-testid="premium-price"]')).toBeNull();
      expect(host.textContent).toContain(EXPORT_PROMISE);
      expect(host.textContent).not.toMatch(/upgrade|website|desktop|\$5/i);
      act(() => root.render(createElement(StorageChoiceBody, {
        dropboxReady: false, redirectUri: null, dropboxState: { kind: "idle" },
        startDropbox: jest.fn(), connect: async () => ({ status: "bound" }),
        free: { cap: 1000, onChoose: jest.fn() },
        managed: { price: "$5 a month", onChoose: jest.fn() },
      })));
      expect(host.querySelector('[data-testid="choose-managed-storage"]')).toBeNull();
      expect(host.textContent).not.toContain("$5");
      expect(host.textContent).toContain("Free storage");
    } finally {
      act(() => root.unmount());
      Object.defineProperty(Platform, "OS", { configurable: true, value: before });
    }
  });
}
