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

// `waitlist.enter` decides whether the address goes on to a code. Each test
// sets the answer; `mockEntered` records what was asked.
let mockStatus: "admitted" | "joined" | "already" = "admitted";
const mockEntered: Array<Record<string, unknown>> = [];
const mockDescribed: Array<Record<string, unknown>> = [];
jest.mock("convex/react", () => ({
  useMutation: (ref: unknown) => async (args: Record<string, unknown>) => {
    if ("useFor" in args) {
      mockDescribed.push(args);
      return null;
    }
    mockEntered.push(args);
    return { status: mockStatus };
  },
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
    mockEntered.length = 0;
    mockStatus = "admitted";
    const view = mount();
    expect(view.text()).toContain("Invite only for now");
    await view.type("login-email", "Seyi@Example.com ");
    await view.press("login-submit");
    expect(mockEntered).toEqual([{ email: "seyi@example.com", source: "login" }]);
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

  test("the fixed-code test account is not asked about the waitlist", async () => {
    mockCalls.length = 0;
    mockEntered.length = 0;
    const view = mount();
    await view.type("login-email", "agentseyi@agentmail.to");
    await view.press("login-submit");
    expect(mockEntered).toEqual([]);
    expect(mockCalls).toEqual([{ email: "agentseyi@agentmail.to" }]);
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

/*
  Invite-only (2026-09-28): an address nobody has let in is put on the list
  right here, and never asks for a code.
*/
describe("somebody not let in yet", () => {
  test("joins the list in place, and can say what they'd use it for once", async () => {
    mockCalls.length = 0;
    mockDescribed.length = 0;
    mockStatus = "joined";
    const view = mount();
    await view.type("login-email", "jon@studio.test");
    await view.press("login-submit");
    expect(mockCalls).toEqual([]);
    expect(view.text()).toContain("You're on the list");
    expect(view.text()).toContain("jon@studio.test");
    await view.type("waitlist-use-for", "agency notes");
    await view.press("waitlist-use-for-send");
    expect(mockDescribed).toEqual([{ email: "jon@studio.test", useFor: "agency notes" }]);
    expect(view.byId("waitlist-use-for")).toBeNull();
    view.unmount();
  });

  test("is told they are already on the list, and can use another address", async () => {
    mockCalls.length = 0;
    mockStatus = "already";
    const view = mount();
    await view.type("login-email", "jon@studio.test");
    await view.press("login-submit");
    expect(mockCalls).toEqual([]);
    expect(view.text()).toContain("You're already on the list");
    await view.press("waitlist-change-email");
    expect(view.byId("login-email")).not.toBeNull();
    view.unmount();
  });
});

/*
  Board 8 of the phone redesign (2026-09-27): the button is the width of the
  form on a phone, and the line under it is in plain words. The old line spoke
  of "the control plane", which is our architecture, not the reader's concern.
*/
describe("the request screen on a phone", () => {
  function atWidth(width: number) {
    Object.defineProperty(document.documentElement, "clientWidth", { value: width, configurable: true });
    Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
  }

  test("says what happens in plain words", () => {
    atWidth(390);
    const view = mount();
    expect(view.text()).toContain("Already in? We'll email you a code. Not yet? We'll add you to the waitlist.");
    expect(view.text()).not.toContain("control plane");
    view.unmount();
  });

  test("the send button is full width on a phone and sized to its label on a desktop", () => {
    atWidth(390);
    const phone = mount();
    expect(getComputedStyle(phone.byId("login-submit")!).alignSelf).toBe("stretch");
    phone.unmount();

    atWidth(1280);
    const desktop = mount();
    expect(getComputedStyle(desktop.byId("login-submit")!).alignSelf).toBe("flex-start");
    desktop.unmount();
    atWidth(0);
  });
});
