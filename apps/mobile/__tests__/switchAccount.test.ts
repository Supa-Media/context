/**
 * @jest-environment jsdom
 */
import { beforeEach, describe, expect, jest, test } from "@jest/globals";

/**
 * "Use another account" from a page that is not the console: the session
 * ends before anywhere else is opened, and the page asked for is where the
 * next sign-in lands — a vault link sent to a different account comes back to
 * that link.
 */

const calls: string[] = [];
let mockUnsent = { pending: 0, conflicted: 0, rejected: 0 };

jest.mock("expo-router", () => ({ useRouter: () => ({ replace: (href: string) => void calls.push(`replace ${href}`) }) }));
jest.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({ signOut: async () => void calls.push("signOut") }),
}));
jest.mock("../features/observability/client", () => ({ resetObservabilityUser: () => void calls.push("resetObservability") }));
jest.mock("../features/offline/forget", () => ({
  unsentOnDevice: async () => mockUnsent,
  forgetLocalCopies: async () => void calls.push("forget"),
}));

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { useSwitchAccount } from "../features/auth/useSwitchAccount";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function switchTo(next: string) {
  let switchAccount: ((next: string) => void) | null = null;
  function Probe() {
    switchAccount = useSwitchAccount();
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() => root.render(createElement(Probe)));
  await act(async () => {
    switchAccount!(next);
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  act(() => root.unmount());
}

beforeEach(() => {
  calls.length = 0;
  mockUnsent = { pending: 0, conflicted: 0, rejected: 0 };
});

describe("signing in as someone else", () => {
  test("signs out first, then opens sign-in with the way back", async () => {
    const next = `/login?next=${encodeURIComponent("/vault/tok?name=Netflix")}`;
    await switchTo(next);
    expect(calls).toEqual(["forget", "signOut", "resetObservability", `replace ${next}`]);
  });

  test("edits still waiting to sync stay on the device", async () => {
    mockUnsent = { pending: 2, conflicted: 0, rejected: 0 };
    await switchTo("/");
    expect(calls).toEqual(["signOut", "resetObservability", "replace /"]);
  });
});
