/**
 * @jest-environment jsdom
 */
import { describe, expect, jest, test } from "@jest/globals";

/**
 * The phone check when the number already has a Context account (Dev2,
 * 2026-10-09: one identity per person, however many emails). The server
 * answers "joined": this email went onto that account, so the screen says so
 * and signs out for the person to sign in again there.
 */

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const mockRouter = { replace: jest.fn(), push: jest.fn() };
jest.mock("expo-router", () => ({ useRouter: () => mockRouter }));

const mockSignOut = jest.fn(async () => {});
jest.mock("@convex-dev/auth/react", () => ({ useAuthActions: () => ({ signOut: mockSignOut }) }));
jest.mock("../features/observability/client", () => ({ resetObservabilityUser: jest.fn() }));
jest.mock("../features/offline/forget", () => ({
  unsentOnDevice: async () => ({ pending: 0, conflicted: 0, rejected: 0 }),
  forgetLocalCopies: async () => {},
}));

let mockConfirm = "joined";
jest.mock("convex/react", () => ({
  useAction: () => async (args: Record<string, unknown>) =>
    "code" in args ? { status: mockConfirm } : { status: "sent", phone: "+15555550100" },
}));

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { PhoneCheckScreen } from "../features/auth/PhoneCheckScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => {
    const Screen = PhoneCheckScreen as (props: { initialSentTo?: string }) => ReturnType<typeof PhoneCheckScreen>;
    root.render(createElement(Screen, { initialSentTo: "+15555550100" }));
  });
  const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  return {
    text: () => container.textContent ?? "",
    byId,
    type: async (id: string, value: string) => {
      const input = byId(id) as HTMLInputElement;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      await act(async () => {
        setter.call(input, value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      });
    },
    press: async (id: string) => {
      await act(async () => {
        byId(id)!.click();
      });
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("a number that already has an account", () => {
  test("says this email joined it, and signing in again lands there", async () => {
    mockConfirm = "joined";
    const view = mount();
    await view.type("phone-check-code", "123456");
    expect(view.text()).toContain("Welcome back.");
    expect(view.text()).toContain("already has a Context account");
    expect(view.byId("phone-check-sign-out")).toBeNull();
    await view.press("phone-check-sign-in");
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    view.unmount();
  });

  test("a plain confirmation shows no such message", async () => {
    mockConfirm = "confirmed";
    const view = mount();
    await view.type("phone-check-code", "123456");
    expect(view.text()).not.toContain("Welcome back.");
    view.unmount();
  });
});
