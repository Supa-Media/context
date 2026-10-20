/**
 * @jest-environment jsdom
 */
import { afterEach, describe, expect, jest, test } from "@jest/globals";

/**
 * "Make your account", driven. The screen's own wiring: which calls it makes
 * for each step, when Continue is allowed, and what it sends when it is. The
 * rules themselves are in `accountSetupModel.test.ts`.
 */

jest.mock("@context/convex/_generated/api", () => ({
  api: {
    functions: {
      phoneCheck: {
        myPhoneCheck: "phone.check",
        sendPhoneCode: "phone.send",
        confirmPhoneCode: "phone.confirm",
      },
      signInEmails: { startAddEmail: "email.start", confirmAddEmail: "email.confirm" },
      accountSetup: { finishSetup: "setup.finish" },
    },
  },
}));

let mockPhoneCheck: { required: boolean; confirmed: boolean; needsEmail: boolean; phone?: string } | undefined;
const mockCalls: Array<[string, unknown]> = [];
const mockAnswers: Record<string, (args: unknown) => unknown> = {};

jest.mock("convex/react", () => ({
  useQuery: (ref: string) => (ref === "phone.check" ? mockPhoneCheck : undefined),
  useAction: (ref: string) => async (args: unknown) => {
    mockCalls.push([ref, args]);
    return mockAnswers[ref]!(args);
  },
  useMutation: (ref: string) => async (args: unknown) => {
    mockCalls.push([ref, args]);
    return { slug: "ada" };
  },
}));

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: jest.fn(), push: jest.fn() }),
}));

jest.mock("../features/auth/useSwitchAccount", () => ({
  useSwitchAccount: () => () => undefined,
}));

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { AccountSetupScreen } from "../features/auth/AccountSetupScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => {
    root.render(
      createElement(AccountSetupScreen, { email: "ada@publicworship.life", suggestedName: "Ada Okafor" }),
    );
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

function resetMocks() {
  mockCalls.length = 0;
  mockPhoneCheck = { required: false, confirmed: false, needsEmail: false };
  mockAnswers["phone.send"] = () => ({ status: "sent", phone: "+15555550142" });
  mockAnswers["phone.confirm"] = () => ({ status: "confirmed" });
  mockAnswers["email.start"] = () => ({ status: "sent", email: "ada@gmail.com" });
  mockAnswers["email.confirm"] = () => ({ status: "added" });
}

resetMocks();
afterEach(resetMocks);

describe("making your account", () => {
  test("opens with the suggested name and nothing else done, so Continue is off", () => {
    const view = mount();
    expect(view.text()).toContain("Make your account");
    expect(view.text()).toContain("Signed in as ada@publicworship.life");
    expect((view.byId("account-setup-name") as HTMLInputElement).value).toBe("Ada Okafor");
    expect(view.byId("account-setup-phone")).not.toBeNull();
    // The personal Gmail is the next step, not this one (Dev, 2026-10-20).
    expect(view.byId("account-setup-email")).toBeNull();
    expect(view.text()).toContain("leave publicworship.life");
    view.unmount();
  });

  test("a phone the account already confirmed is not asked for again", () => {
    mockPhoneCheck = { required: false, confirmed: true, needsEmail: false, phone: "+15555550100" };
    const view = mount();
    expect(view.byId("account-setup-phone")).toBeNull();
    expect(view.text()).toContain("Your phone is +15555550100.");
    view.unmount();
  });

  test("a phone is texted a code, and the code confirms it", async () => {
    const view = mount();
    await view.type("account-setup-phone", "+1 555 555 0142");
    await view.press("account-setup-phone-send");
    expect(mockCalls).toContainEqual(["phone.send", { phone: "+15555550142" }]);
    await view.type("account-setup-phone-code", "123456");
    expect(mockCalls).toContainEqual(["phone.confirm", { phone: "+15555550142", code: "123456" }]);
    expect(view.text()).toContain("Your phone is");
    view.unmount();
  });

  test("a wrong phone code says so in plain words and asks for the code again", async () => {
    mockAnswers["phone.confirm"] = () => ({ status: "wrong" });
    const view = mount();
    await view.type("account-setup-phone", "+1 555 555 0142");
    await view.press("account-setup-phone-send");
    await view.type("account-setup-phone-code", "000000");
    expect(view.text()).toContain("That code didn't work. Check the text, or send a new code.");
    expect(view.byId("account-setup-phone-code")).not.toBeNull();
    view.unmount();
  });

  test("Continue does nothing until the phone is confirmed, then finishes with the name", async () => {
    const view = mount();
    await view.press("account-setup-continue");
    expect(mockCalls.filter(([ref]) => ref === "setup.finish")).toEqual([]);

    await view.type("account-setup-phone", "+1 555 555 0142");
    await view.press("account-setup-phone-send");
    await view.type("account-setup-phone-code", "123456");
    await view.press("account-setup-continue");
    expect(mockCalls.filter(([ref]) => ref === "setup.finish")).toEqual([
      ["setup.finish", { name: "Ada Okafor" }],
    ]);
    view.unmount();
  });

  test("a number another account holds says so, and offers to sign in again", async () => {
    mockAnswers["phone.confirm"] = () => ({ status: "joined" });
    const view = mount();
    await view.type("account-setup-phone", "+1 555 555 0142");
    await view.press("account-setup-phone-send");
    await view.type("account-setup-phone-code", "123456");
    expect(view.text()).toContain("Welcome back.");
    expect(view.byId("account-setup-sign-in")).not.toBeNull();
    view.unmount();
  });
});
