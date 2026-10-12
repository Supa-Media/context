/**
 * @jest-environment jsdom
 */
import { describe, expect, jest, test } from "@jest/globals";

/**
 * Page a's sign-up, written into its own last line (Dev2, 2026-10-12, board A
 * of the inline boards, then board B: "just like a line"). Driven end to end
 * against a stubbed backend: the line is the number field from the start, with
 * +1 in front of it, a new number lands on the list in place, a number
 * that is in gets the code on the same line, and each problem says so there.
 */

const mockStarted: Array<Record<string, unknown>> = [];
const mockVerified: Array<Record<string, unknown>> = [];
let mockStart: { status: string; phone?: string; conversionId?: string } = { status: "joined" };
let mockSigningIn = true;
const mockRouter = { replace: jest.fn(), push: jest.fn() };

jest.mock("expo-router", () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({}),
}));
jest.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({
    signIn: async (_provider: string, args: Record<string, unknown>) => {
      mockVerified.push(args);
      return { signingIn: mockSigningIn };
    },
  }),
}));
jest.mock("convex/react", () => ({
  useAction: () => async (args: Record<string, unknown>) => {
    mockStarted.push(args);
    return mockStart;
  },
  useMutation: () => async () => ({ status: "joined" }),
}));
jest.mock("../features/auth/landing", () => ({ landAfterSignIn: jest.fn() }));

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { InlineSignUp } from "../features/landing/InlineSignUp.web";
import { landAfterSignIn } from "../features/auth/landing";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount() {
  mockStarted.length = 0;
  mockVerified.length = 0;
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(createElement(InlineSignUp)));
  const q = <T extends Element>(selector: string) => container.querySelector(selector) as T | null;
  const button = (name: string) =>
    [...container.querySelectorAll("button")].find((b) => (b.getAttribute("aria-label") ?? b.textContent ?? "").includes(name)) as
      | HTMLButtonElement
      | undefined;
  const type = async (input: HTMLInputElement | HTMLSelectElement, value: string) => {
    const proto = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
    await act(async () => {
      setter.call(input, value);
      input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
    });
  };
  const submit = async () => {
    await act(async () => {
      q<HTMLFormElement>("form")!.requestSubmit();
    });
  };
  const press = async (name: string) => {
    await act(async () => {
      button(name)!.click();
    });
  };
  return {
    text: () => container.textContent ?? "",
    q,
    button,
    type,
    submit,
    press,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("the inline sign-up on page a", () => {
  test("is one line from the start: Join the waitlist, +1, the number, and ›, without grabbing the keyboard", async () => {
    const view = mount();
    const input = view.q<HTMLInputElement>("#sp-phone")!;
    expect(input).not.toBeNull();
    expect(input.type).toBe("tel");
    expect(document.activeElement).not.toBe(input);
    expect(view.q("label[for=sp-phone]")!.textContent).toBe("Join the waitlist");
    expect(view.q(".sp-cc")!.textContent).toContain("+1");
    expect(view.q<HTMLSelectElement>("select")!.value).toBe("US");
    expect(view.button("Join")).toBeDefined();
    expect(view.text()).toContain("Invite only for now");
    view.unmount();
  });

  test("a new number joins the list in place, and a different number puts the caret back in the line", async () => {
    mockStart = { status: "joined" };
    const view = mount();
    await view.type(view.q<HTMLInputElement>("#sp-phone")!, "(202) 615-0407");
    await view.submit();
    expect(mockStarted).toEqual([{ phone: "+12026150407" }]);
    expect(view.text()).toContain("You're on the list.");
    expect(view.text()).toContain("this number is how you sign in");
    await view.press("Use a different number");
    expect(document.activeElement).toBe(view.q("#sp-phone"));
    view.unmount();
  });

  test("the country in front of the number is what it is sent with", async () => {
    mockStart = { status: "joined" };
    const view = mount();
    await view.type(view.q<HTMLSelectElement>("select")!, "GB");
    expect(view.q(".sp-cc")!.textContent).toContain("+44");
    await view.type(view.q<HTMLInputElement>("#sp-phone")!, "07700 900123");
    await view.submit();
    expect(mockStarted).toEqual([{ phone: "+447700900123" }]);
    view.unmount();
  });

  test("a number that is in gets the code on the same line, and six digits sign in", async () => {
    mockStart = { status: "sent", phone: "+15555550100" };
    mockSigningIn = true;
    const view = mount();
    await view.type(view.q<HTMLInputElement>("#sp-phone")!, "555 555 0100");
    await view.submit();
    expect(view.text()).toContain("Check your texts.");
    const code = view.q<HTMLInputElement>("#sp-code")!;
    expect(code.autocomplete).toBe("one-time-code");
    expect(document.activeElement).toBe(code);
    await view.type(code, "392 418");
    expect(mockVerified).toEqual([{ phone: "+15555550100", code: "392418" }]);
    expect(landAfterSignIn).toHaveBeenCalled();
    view.unmount();
  });

  test("a wrong code and a bad number each say so on the line", async () => {
    mockStart = { status: "sent", phone: "+15555550100" };
    mockSigningIn = false;
    const view = mount();
    await view.type(view.q<HTMLInputElement>("#sp-phone")!, "555 555 0100");
    await view.submit();
    await view.type(view.q<HTMLInputElement>("#sp-code")!, "000000");
    expect(view.q("[role=alert]")!.textContent).toBe("That code didn't work. Check the text, or send a new code.");
    await view.press("Use a different number");

    mockStart = { status: "invalid_phone" };
    await view.type(view.q<HTMLInputElement>("#sp-phone")!, "555 201");
    await view.submit();
    expect(view.q("[role=alert]")!.textContent).toContain("That number doesn't look right");
    expect(view.q<HTMLInputElement>("#sp-phone")!.getAttribute("aria-invalid")).toBe("true");
    view.unmount();
  });

  test("an empty line sends nothing", async () => {
    const view = mount();
    await view.submit();
    expect(mockStarted).toEqual([]);
    view.unmount();
  });
});
