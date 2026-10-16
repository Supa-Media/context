/** @jest-environment jsdom */
import { test, expect, jest } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { Platform } from "react-native";
import { demoPremiumView, type PremiumView } from "../features/console/settings/panels/premium";
import { usePremium } from "../features/console/settings/panels/usePremium";
import { useManagedOffer, type ManagedOffer } from "../features/onboarding/useManagedOffer";
import type { Id } from "@context/convex/_generated/dataModel";

const mockMutation = jest.fn(async () => ({ sessionId: "session" }));
const mockStatus = { ...demoPremiumView().status!, canManage: true, managedStorageAvailable: true, freeManagedAvailable: true, freeManagedEligible: true };
jest.mock("convex/react", () => ({
  useConvex: () => ({ mutation: mockMutation }),
  useQueries: () => ({ status: mockStatus }),
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

for (const os of ["ios", "android"] as const) {
  test(`${os} refuses paid handlers and still offers free storage`, async () => {
    const before = Platform.OS;
    Object.defineProperty(Platform, "OS", { configurable: true, value: os });
    mockMutation.mockClear();
    let premium!: PremiumView;
    let managed!: ManagedOffer;
    function Probe() {
      premium = usePremium({ workspaceId: "workspace" as Id<"workspaces"> });
      managed = useManagedOffer({ workspaceId: "workspace" as Id<"workspaces">, returned: null });
      return null;
    }
    const root = createRoot(document.createElement("div"));
    try {
      act(() => root.render(createElement(Probe)));
      expect(premium.upgrade).toBeUndefined();
      expect(premium.manageBilling).toBeUndefined();
      expect(premium.choose).toBeUndefined();
      expect(managed.available).toBe(false);
      expect(managed.free).not.toBeNull();
      await act(async () => {
        managed.choose();
        managed.toggle("managedStorage", true);
        managed.proceed();
      });
      expect(mockMutation).not.toHaveBeenCalled();
      expect(managed.mode).toBe("choose");
    } finally {
      act(() => root.unmount());
      Object.defineProperty(Platform, "OS", { configurable: true, value: before });
    }
  });
}
