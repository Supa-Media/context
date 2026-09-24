/**
 * @jest-environment jsdom
 */
import { describe, expect, jest, test } from "@jest/globals";

/**
 * A-01 and A-02, driven: an address becomes a code request, six digits become
 * a verification, and the two ways off the code screen do what they say.
 *
 * The OTP itself is `@convex-dev/auth`'s; what this proves is the screen's own
 * wiring — the calls it makes and the state it leaves behind.
 */

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const mockCalls: Array<Record<string, unknown>> = [];
const mockRouter = { replace: jest.fn(), push: jest.fn() };

jest.mock("expo-router", () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({}),
}));

jest.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({
    signIn: async (_provider: string, args: Record<string, unknown>) => {
      mockCalls.push(args);
    },
  }),
}));

jest.mock("../features/auth/landing", () => ({
  landAfterSignIn: jest.fn(),
}));

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { LoginScreen } from "../features/auth/LoginScreen";
import { codeDigits } from "../features/auth/CodeBoxes";
import { SignInPreview } from "../features/auth/SignInPreview";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => {
    root.render(createElement(LoginScreen));
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

describe("the code field", () => {
  test("keeps digits only, never more than six", () => {
    expect(codeDigits("392 418")).toBe("392418");
    expect(codeDigits("39-24-18-99")).toBe("392418");
    expect(codeDigits("abc")).toBe("");
  });
});

describe("signing in", () => {
  test("an address asks for a code, and the code screen says what the backend really sends", async () => {
    mockCalls.length = 0;
    const view = mount();
    expect(view.text()).toContain("Tell one AI once");
    await view.type("login-email", "Seyi@Example.com ");
    await view.press("login-submit");
    expect(mockCalls).toEqual([{ email: "seyi@example.com" }]);
    // Six digits and ten minutes are `@supa-media/convex`'s, not ours to change.
    expect(view.text()).toContain("six-digit code");
    expect(view.text()).toContain("ten minutes");
    view.unmount();
  });

  test("the sixth digit verifies — a pasted code with spaces included", async () => {
    mockCalls.length = 0;
    const view = mount();
    await view.type("login-email", "seyi@example.com");
    await view.press("login-submit");
    await view.type("login-code", "392 41");
    expect(mockCalls).toHaveLength(1);
    await view.type("login-code", "392 418");
    expect(mockCalls[1]).toEqual({ email: "seyi@example.com", code: "392418" });
    view.unmount();
  });

  test("Resend asks again and says the old code is spent; Change email goes back", async () => {
    mockCalls.length = 0;
    const view = mount();
    await view.type("login-email", "seyi@example.com");
    await view.press("login-submit");
    await view.press("login-resend");
    expect(mockCalls).toEqual([{ email: "seyi@example.com" }, { email: "seyi@example.com" }]);
    expect(view.text()).toContain("The last one no longer works");
    await view.press("login-change-email");
    expect(view.byId("login-email")).not.toBeNull();
    view.unmount();
  });

  test("the illustration never shows a code somebody could type", () => {
    // Rendered directly: on the screen it is only drawn on a wide window, and a
    // test that skipped itself when it was not drawn would check nothing.
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
    act(() => {
      root.render(createElement(SignInPreview, { kind: "email", email: "seyi@example.com" }));
    });
    expect(container.textContent).toContain("is your Context code");
    expect(container.textContent).not.toMatch(/\d{6}/);
    act(() => root.unmount());
    container.remove();
  });
});
