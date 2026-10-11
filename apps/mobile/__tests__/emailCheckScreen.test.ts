/**
 * @jest-environment jsdom
 */
import { describe, expect, jest, test } from "@jest/globals";

/**
 * The once-only email question for an account a phone made: an address, then
 * the mailed code. "added" lets the app through (the layout stops drawing this
 * screen); "moved" means the address had its own account, the phone went to
 * it, and the person signs in again to land there.
 */

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const mockRouter = { replace: jest.fn(), push: jest.fn() };
jest.mock("expo-router", () => ({ useRouter: () => mockRouter }));

const mockSignOut = jest.fn(async () => {});
jest.mock("@convex-dev/auth/react", () => ({ useAuthActions: () => ({ signOut: mockSignOut }) }));
jest.mock("../features/observability/client", () => ({ resetObservabilityUser: jest.fn() }));

const mockCalls: Array<Record<string, unknown>> = [];
let mockConfirm = "added";
jest.mock("convex/react", () => ({
  useAction: () => async (args: Record<string, unknown>) => {
    mockCalls.push(args);
    if ("code" in args) return { status: mockConfirm };
    return { status: "sent", email: String(args.email).trim().toLowerCase() };
  },
}));

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { EmailCheckScreen } from "../features/auth/EmailCheckScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => {
    root.render(createElement(EmailCheckScreen));
  });
  const byId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
  const type = async (id: string, value: string) => {
    const input = byId(id) as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const press = async (id: string) => {
    await act(async () => {
      byId(id)!.click();
    });
  };
  return {
    text: () => container.textContent ?? "",
    byId,
    type,
    press,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("the email question for a phone account", () => {
  test("an address gets a code, and the sixth digit confirms it", async () => {
    mockCalls.length = 0;
    mockConfirm = "added";
    const view = mount();
    expect(view.text()).toContain("What's your email?");
    await view.type("email-check-address", "Sam@Example.com");
    await view.press("email-check-send");
    expect(view.text()).toContain("sam@example.com");
    await view.type("email-check-code", "123456");
    expect(mockCalls).toEqual([{ email: "Sam@Example.com" }, { code: "123456" }]);
    expect(view.byId("email-check-sign-in")).toBeNull();
    view.unmount();
  });

  test("an address with its own account takes the phone, and the person signs in again", async () => {
    mockCalls.length = 0;
    mockConfirm = "moved";
    mockSignOut.mockClear();
    mockRouter.replace.mockClear();
    const view = mount();
    await view.type("email-check-address", "sam@example.com");
    await view.press("email-check-send");
    await view.type("email-check-code", "123456");
    expect(view.text()).toContain("Welcome back.");
    await view.press("email-check-sign-in");
    expect(mockSignOut).toHaveBeenCalledTimes(1);
    expect(mockRouter.replace).toHaveBeenCalledWith("/login");
    view.unmount();
  });

  test("a wrong code says so and clears the boxes", async () => {
    mockConfirm = "wrong";
    const view = mount();
    await view.type("email-check-address", "sam@example.com");
    await view.press("email-check-send");
    await view.type("email-check-code", "000000");
    expect(view.text()).toContain("That code didn't work");
    view.unmount();
  });
});
