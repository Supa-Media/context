/** @jest-environment jsdom */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, jest, test } from "@jest/globals";
import { getFunctionName } from "convex/server";
import { useManagedOffer, type ManagedOffer } from "../features/onboarding/useManagedOffer";
import { usePremium } from "../features/console/settings/panels/usePremium";
import type { PremiumView } from "../features/console/settings/panels/premium";
import type { Id } from "@context/convex/_generated/dataModel";

const mockMutation = jest.fn(async (_ref: unknown, _args: unknown) => ({ active: true, sessionId: "session" }));
const mockClient = { mutation: mockMutation };
let mockFree = true;
jest.mock("convex/react", () => ({
  useConvex: () => mockClient,
  useQueries: () => ({ status: {
    stagingFreeStorage: mockFree, canManage: true, status: "none", configured: true,
    managedStorageAvailable: true, selected: { managedStorage: true, fastSearch: false },
    active: { managedStorage: false, fastSearch: false }, priceCents: 500, currency: "usd", interval: "month",
  } }),
}));
let offer: ManagedOffer;
let premium: PremiumView;
let cleanup: (() => void) | undefined;
afterEach(() => { cleanup?.(); mockMutation.mockClear(); });
function mount() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  function Probe() {
    offer = useManagedOffer({ workspaceId: "workspace" as Id<"workspaces">, returned: null });
    premium = usePremium({ workspaceId: "workspace" as Id<"workspaces"> });
    return null;
  }
  act(() => root.render(createElement(Probe)));
  cleanup = () => { act(() => root.unmount()); host.remove(); };
}

test.each([true, false])("onboarding and settings use the server's free-staging decision (%s)", async (free) => {
  mockFree = free;
  mount();
  await act(async () => offer.proceed());
  await act(async () => premium.upgrade?.());
  expect(mockMutation.mock.calls.map(([ref]) => getFunctionName(ref as never)))
    .toEqual(Array(2).fill(free ? "functions/billing:activateTestPremium" : "functions/billing:startCheckout"));
  expect(offer.mode).toBe(free ? "settling" : "choose");
});
