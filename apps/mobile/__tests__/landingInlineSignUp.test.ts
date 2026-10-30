/**
 * @jest-environment jsdom
 */
import { describe, expect, jest, test } from "@jest/globals";

/**
 * Page a's sign-up (Dev, 2026-10-18: "the button to click enter isn't clear";
 * Dev2, 2026-10-28: email leads here, texting is tex.lc's). Driven end to end
 * against a stubbed backend: the email field is open from the start with a
 * button that says "Join the waitlist", a new address lands on the list in
 * place, an address that is in gets the code in the same place, somebody who
 * signs in by phone can switch to the texted code, and each problem says so
 * there.
 */

const mockStarted: Array<Record<string, unknown>> = [];
const mockVerified: Array<Record<string, unknown>> = [];
const mockEntered: Array<Record<string, unknown>> = [];
const mockDescribed: Array<Record<string, unknown>> = [];
let mockStart: { status: string; phone?: string; conversionId?: string } = { status: "joined" };
let mockEnter: { status: string; conversionId?: string } = { status: "joined" };
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
  useMutation: (ref: unknown) => async (args: Record<string, unknown>) => {
    if (ref === "describe") {
      mockDescribed.push(args);
      return null;
    }
    mockEntered.push(args);
    return mockEnter;
  },
}));
jest.mock("@context/convex/_generated/api", () => ({
  api: { functions: { waitlist: { enter: "enter", describe: "describe" }, phoneSignIn: { start: "start" } } },
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
  mockEntered.length = 0;
  mockDescribed.length = 0;
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
  const submit = async (selector = "form") => {
    await act(async () => {
      q<HTMLFormElement>(selector)!.requestSubmit();
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
  test("is open from the start: Join the waitlist, an email field, and a button saying so, without grabbing the keyboard", async () => {
    const view = mount();
    const input = view.q<HTMLInputElement>("#tp-email")!;
    expect(input).not.toBeNull();
    expect(input.type).toBe("email");
    expect(input.autocomplete).toBe("email");
    expect(document.activeElement).not.toBe(input);
    expect(view.q("label[for=tp-email]")!.textContent).toBe("Join the waitlist");
    expect(view.q("#tp-phone")).toBeNull();
    expect(view.q(".tp-cc")).toBeNull();
    const join = view.button("Join the waitlist")!;
    expect(join.type).toBe("submit");
    expect(join.textContent).toBe("Join the waitlist");
    expect(view.text()).toContain("Invite only for now");
    expect(view.text()).not.toContain("Tex");
    view.unmount();
  });

  test("a new address joins the list in place, says it will email, and takes the optional answer once", async () => {
    mockEnter = { status: "joined" };
    const view = mount();
    await view.type(view.q<HTMLInputElement>("#tp-email")!, "Ana@Example.com ");
    await view.submit();
    expect(mockEntered).toHaveLength(1);
    expect(mockEntered[0]).toMatchObject({ email: "ana@example.com", source: "homepage" });
    expect(mockVerified).toEqual([]);
    expect(view.text()).toContain("You're on the list.");
    expect(view.text()).toContain("We'll email Ana@Example.com when it's your turn.");
    expect(view.text()).not.toContain("text you");
    await view.type(view.q<HTMLInputElement>(".tp-ask input")!, "Notes for my band");
    await view.submit(".tp-ask");
    expect(mockDescribed).toEqual([{ email: "ana@example.com", useFor: "Notes for my band" }]);
    expect(view.text()).toContain("Thanks, that helps.");
    await view.press("Use a different email");
    expect(document.activeElement).toBe(view.q("#tp-email"));
    view.unmount();
  });

  test("an address already on the list is told so, with nothing else to answer", async () => {
    mockEnter = { status: "already" };
    const view = mount();
    await view.type(view.q<HTMLInputElement>("#tp-email")!, "ana@example.com");
    await view.submit();
    expect(view.text()).toContain("You're already on the list.");
    expect(view.q(".tp-ask")).toBeNull();
    view.unmount();
  });

  test("an address that is in gets the code on the same line, and six digits sign in", async () => {
    mockEnter = { status: "admitted" };
    mockSigningIn = true;
    const view = mount();
    await view.type(view.q<HTMLInputElement>("#tp-email")!, "ana@example.com");
    await view.submit();
    expect(mockVerified).toEqual([{ email: "ana@example.com" }]);
    expect(view.text()).toContain("Check your email");
    expect(view.text()).toContain("ana@example.com");
    const code = view.q<HTMLInputElement>("#tp-code")!;
    expect(code.autocomplete).toBe("one-time-code");
    expect(document.activeElement).toBe(code);
    await view.type(code, "392 418");
    expect(mockVerified).toEqual([{ email: "ana@example.com" }, { email: "ana@example.com", code: "392418" }]);
    expect(landAfterSignIn).toHaveBeenCalled();
    view.unmount();
  });

  test("a wrong emailed code says so on the line", async () => {
    mockEnter = { status: "admitted" };
    mockSigningIn = false;
    const view = mount();
    await view.type(view.q<HTMLInputElement>("#tp-email")!, "ana@example.com");
    await view.submit();
    await view.type(view.q<HTMLInputElement>("#tp-code")!, "000000");
    expect(view.q("[role=alert]")!.textContent).toContain("That code didn't work.");
    expect(view.q<HTMLInputElement>("#tp-code")!.getAttribute("aria-invalid")).toBe("true");
    view.unmount();
  });

  test("an empty line sends nothing", async () => {
    const view = mount();
    await view.submit();
    expect(mockEntered).toEqual([]);
    expect(mockVerified).toEqual([]);
    view.unmount();
  });
});

describe("signing in with a phone from page a", () => {
  async function phoneLine() {
    const view = mount();
    await view.press("Sign in with your phone");
    return view;
  }

  test("is one link away, with +1 in front and the caret in the number", async () => {
    const view = await phoneLine();
    const input = view.q<HTMLInputElement>("#tp-phone")!;
    expect(input.type).toBe("tel");
    expect(document.activeElement).toBe(input);
    expect(view.q(".tp-cc")!.textContent).toContain("+1");
    expect(view.q<HTMLSelectElement>("select")!.value).toBe("US");
    expect(view.button("Text me a code")!.type).toBe("submit");
    await view.press("Use email instead");
    expect(view.q("#tp-email")).not.toBeNull();
    view.unmount();
  });

  test("a number that is in gets the code on the same line, and six digits sign in", async () => {
    mockStart = { status: "sent", phone: "+15555550100" };
    mockSigningIn = true;
    const view = await phoneLine();
    await view.type(view.q<HTMLInputElement>("#tp-phone")!, "555 555 0100");
    await view.submit();
    expect(mockStarted).toEqual([{ phone: "+15555550100" }]);
    expect(view.text()).toContain("Check your texts");
    const code = view.q<HTMLInputElement>("#tp-code")!;
    expect(document.activeElement).toBe(code);
    await view.type(code, "392 418");
    expect(mockVerified).toEqual([{ phone: "+15555550100", code: "392418" }]);
    expect(landAfterSignIn).toHaveBeenCalled();
    view.unmount();
  });

  test("the country in front of the number is what it is sent with", async () => {
    mockStart = { status: "joined" };
    const view = await phoneLine();
    await view.type(view.q<HTMLSelectElement>("select")!, "GB");
    expect(view.q(".tp-cc")!.textContent).toContain("+44");
    await view.type(view.q<HTMLInputElement>("#tp-phone")!, "07700 900123");
    await view.submit();
    expect(mockStarted).toEqual([{ phone: "+447700900123" }]);
    expect(view.text()).toContain("You're on the list.");
    view.unmount();
  });

  test("a wrong code and a bad number each say so on the line", async () => {
    mockStart = { status: "sent", phone: "+15555550100" };
    mockSigningIn = false;
    const view = await phoneLine();
    await view.type(view.q<HTMLInputElement>("#tp-phone")!, "555 555 0100");
    await view.submit();
    await view.type(view.q<HTMLInputElement>("#tp-code")!, "000000");
    expect(view.q("[role=alert]")!.textContent).toBe("That code didn't work. Check the text, or send a new code.");
    await view.press("Use a different number");

    mockStart = { status: "invalid_phone" };
    await view.type(view.q<HTMLInputElement>("#tp-phone")!, "555 201");
    await view.submit();
    expect(view.q("[role=alert]")!.textContent).toContain("That number doesn't look right");
    expect(view.q<HTMLInputElement>("#tp-phone")!.getAttribute("aria-invalid")).toBe("true");
    view.unmount();
  });
});
