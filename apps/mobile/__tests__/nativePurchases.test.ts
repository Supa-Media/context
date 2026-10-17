/** @jest-environment jsdom */
import { test, expect, jest } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Platform } from "react-native";
import { PremiumBody } from "../features/console/settings/panels/PremiumPanel";
import { demoPremiumView, EXPORT_PROMISE } from "../features/console/settings/panels/premium";
import { WorkspaceStorageStepBody } from "../features/workspace/steps/WorkspaceStorageStep";
import type { ManagedOffer } from "../features/onboarding/useManagedOffer";
import { StorageChoice } from "../features/console/storage/StorageChoice";

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
      act(() => root.render(createElement(StorageChoice, {
        connect: async () => ({ status: "bound" }),
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

test("native Premium retains its storage recovery", async () => {
  const before = Platform.OS;
  Object.defineProperty(Platform, "OS", { configurable: true, value: "ios" });
  const host = document.createElement("div");
  const root = createRoot(host);
  const retry = jest.fn(async () => {});
  try {
    const base = demoPremiumView();
    const view = { ...base, retryManagedStorage: retry, status: {
      ...base.status!, status: "active" as const, freeManaged: true,
      selected: { managedStorage: true, fastSearch: false },
      managedProvisioning: "failed" as const, managedMigrationPhase: "copy" as const,
    } };
    act(() => root.render(createElement(PremiumBody, { view })));
    expect(host.querySelector('[data-testid="native-plan-title"]')?.textContent).toBe("Premium");
    expect(host.textContent).toContain("Your notes are still in your original storage");
    await act(async () => (host.querySelector('[data-testid="managed-storage-retry"]') as HTMLElement).click());
    expect(retry).toHaveBeenCalledTimes(1);
  } finally {
    act(() => root.unmount());
    Object.defineProperty(Platform, "OS", { configurable: true, value: before });
  }
});

test("native shared-workspace creation can start free managed storage", () => {
  const before = Platform.OS;
  Object.defineProperty(Platform, "OS", { configurable: true, value: "ios" });
  const host = document.createElement("div");
  const root = createRoot(host);
  const startFree = jest.fn();
  const managed: ManagedOffer = {
    available: false, price: "$5 a month", status: null, mode: "choose", session: "choosing",
    paid: false, slow: false, choose: jest.fn(), back: jest.fn(), toggle: jest.fn(),
    proceed: jest.fn(), retry: jest.fn(), free: { cap: 1000 }, startedFree: false,
    startFree, startingFree: false,
  };
  const props = { connectState: { kind: "idle" as const }, workspaceId: "workspace", slug: "demo",
    connect: async () => ({ status: "bound" }), managed, onSkip: jest.fn(), onContinuePast: jest.fn() };
  try {
    act(() => root.render(createElement(WorkspaceStorageStepBody, props)));
    expect(host.textContent).toContain("Free storage");
    expect(host.textContent).not.toContain("$5");
    act(() => (host.querySelector('[data-testid="choose-free"]') as HTMLElement).click());
    expect(startFree).toHaveBeenCalledTimes(1);
    act(() => root.render(createElement(WorkspaceStorageStepBody, { ...props, managed: { ...managed, mode: "settling", startedFree: true } })));
    expect(host.textContent).toContain("Creating your bucket");
    expect(host.textContent).not.toContain("Payment received");
  } finally {
    act(() => root.unmount());
    Object.defineProperty(Platform, "OS", { configurable: true, value: before });
  }
});
