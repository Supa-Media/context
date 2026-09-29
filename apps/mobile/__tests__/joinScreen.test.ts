/**
 * @jest-environment jsdom
 */
import { describe, expect, jest, test } from "@jest/globals";

/**
 * `/join/<token>`, driven: `/login`'s field under the invite, and the one place
 * it answers differently — an address that is not let in is the wrong address
 * for this invite, said as an error with a way to the waitlist.
 */

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const mockRouter = { replace: jest.fn(), push: jest.fn() };
let mockToken: string | undefined = "tok";
jest.mock("expo-router", () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => ({ token: mockToken }),
}));

const mockCalls: Array<Record<string, unknown>> = [];
jest.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({
    signIn: async (_provider: string, args: Record<string, unknown>) => {
      mockCalls.push(args);
    },
  }),
}));

let mockStatus: "admitted" | "joined" | "already" = "admitted";
let mockPreview: { works: boolean; inviterHandle: string | null } | undefined;
const mockQueried: unknown[] = [];
jest.mock("convex/react", () => ({
  useMutation: () => async () => ({ status: mockStatus }),
  useQuery: (_ref: unknown, args: unknown) => {
    mockQueried.push(args);
    return args === "skip" ? undefined : mockPreview;
  },
}));

jest.mock("../features/auth/landing", () => ({
  landAfterSignIn: jest.fn(),
}));

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { JoinScreen } from "../features/auth/JoinScreen";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => {
    root.render(createElement(JoinScreen));
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

describe("a working invite", () => {
  test("shows who invited you, and the invited address goes on to the code", async () => {
    mockToken = "tok";
    mockPreview = { works: true, inviterHandle: "maya" };
    mockStatus = "admitted";
    mockCalls.length = 0;
    const view = mount();
    expect(view.text()).toContain("@maya invited you");
    expect(view.text()).toContain("Notes for your team and your AI tools");
    expect(view.text()).toContain("Use the email the invite went to.");
    await view.type("login-email", "jon@studio.test");
    await view.press("login-submit");
    expect(mockCalls).toEqual([{ email: "jon@studio.test" }]);
    expect(view.text()).toContain("six-digit code");
    view.unmount();
  });

  test("another address is told it is the wrong one, not that it is on the list", async () => {
    mockPreview = { works: true, inviterHandle: "maya" };
    for (const status of ["joined", "already"] as const) {
      mockStatus = status;
      mockCalls.length = 0;
      const view = mount();
      await view.type("login-email", "someone@else.test");
      await view.press("login-submit");
      expect(mockCalls).toEqual([]);
      expect(view.text()).toContain("This invite is for a different email. Use the one it went to.");
      expect(view.byId("waitlist-result")).toBeNull();
      expect(view.text()).not.toContain("on the list");

      // Editing the address is the retry: the error goes and Continue comes back.
      mockStatus = "admitted";
      await view.type("login-email", "jon@studio.test");
      expect(view.byId("join-wrong-email")).toBeNull();
      await view.press("login-submit");
      expect(mockCalls).toEqual([{ email: "jon@studio.test" }]);
      view.unmount();
    }
  });

  test("Join the waitlist instead goes to /login", async () => {
    mockPreview = { works: true, inviterHandle: "maya" };
    mockStatus = "joined";
    mockRouter.replace.mockClear();
    const view = mount();
    await view.type("login-email", "someone@else.test");
    await view.press("login-submit");
    await view.press("join-waitlist-instead");
    expect(mockRouter.replace).toHaveBeenCalledWith("/login");
    view.unmount();
  });
});

describe("an invite that no longer works", () => {
  test("says so, and the field is /login's waitlist", async () => {
    mockToken = "tok";
    mockPreview = { works: false, inviterHandle: null };
    mockStatus = "joined";
    const view = mount();
    expect(view.text()).toContain("This invite no longer works");
    expect(view.text()).toContain("Ask whoever invited you for a new one, or join the waitlist below.");
    await view.type("login-email", "jon@studio.test");
    await view.press("login-submit");
    expect(view.text()).toContain("You're on the list");
    expect(view.byId("join-wrong-email")).toBeNull();
    view.unmount();
  });

  test("while the preview loads, the page waits rather than guessing", () => {
    mockToken = "tok";
    mockPreview = undefined;
    const view = mount();
    expect(view.byId("join-loading")).not.toBeNull();
    expect(view.byId("login-email")).toBeNull();
    view.unmount();
  });

  test("a missing token is not sent to the server", () => {
    mockToken = undefined;
    mockQueried.length = 0;
    const view = mount();
    expect(mockQueried).toEqual(["skip"]);
    expect(view.text()).toContain("This invite no longer works");
    view.unmount();
  });
});
