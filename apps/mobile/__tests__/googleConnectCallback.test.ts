/**
 * @jest-environment jsdom
 */
import { beforeEach, describe, expect, jest, test } from "@jest/globals";

/**
 * The Google callback page survives a remount. The first connect after a full
 * disconnect showed "Google did not connect" while a second try in the same
 * tab worked: the screen read-and-deleted the completion secret on its first
 * mount, so a second mount of the same URL found none. Now the secret is only
 * forgotten once the completion call settles, and a remount joins the call
 * already in flight (the server spends the attempt on first use, so a second
 * call could only be refused).
 */

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

const mockParams: Record<string, string> = { code: "code-1", state: "state-1" };
const mockRouter = { replace: jest.fn(), push: jest.fn() };
jest.mock("expo-router", () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockParams,
}));

type Settle = { resolve: (value: unknown) => void; reject: (error: unknown) => void };
const mockCalls: Array<Record<string, unknown>> = [];
const mockSettles: Settle[] = [];
jest.mock("convex/browser", () => ({
  ConvexHttpClient: class {
    action(_ref: unknown, args: Record<string, unknown>) {
      mockCalls.push(args);
      return new Promise((resolve, reject) => mockSettles.push({ resolve, reject }));
    }
  },
}));

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { GoogleCallbackScreen } from "../features/console/google/GoogleCallbackScreen";
import {
  __resetGoogleCallbackInFlightForTests,
  completeGoogleCallbackOnce,
} from "../features/console/google/completeGoogleCallback";
import { peekGoogleCompletionSecret, rememberGoogleCompletionSecret } from "../features/console/google/google";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
process.env.EXPO_PUBLIC_CONVEX_URL = "https://fake-deployment.convex.cloud";

function mount() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => {
    root.render(createElement(GoogleCallbackScreen));
  });
  return {
    text: () => container.textContent ?? "",
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

async function settle(index: number, outcome: "resolve" | "reject") {
  await act(async () => {
    if (outcome === "resolve") mockSettles[index].resolve({ workspaceId: "workspace-1", ai: false });
    else mockSettles[index].reject(new Error("refused"));
  });
}

beforeEach(() => {
  mockCalls.length = 0;
  mockSettles.length = 0;
  window.sessionStorage.clear();
  __resetGoogleCallbackInFlightForTests();
});

describe("the Google callback page", () => {
  test("a remount with the same state joins the first completion and shows success", async () => {
    rememberGoogleCompletionSecret("state-1", "secret-1");
    const first = mount();
    expect(first.text()).toContain("The connection is finishing on our side.");
    first.unmount();

    const second = mount();
    expect(second.text()).not.toContain("Google did not connect");
    // One completion call, not two: the code and attempt are single-use.
    expect(mockCalls).toEqual([{ state: "state-1", code: "code-1", completionSecret: "secret-1" }]);

    await settle(0, "resolve");
    expect(second.text()).toContain("Google is connected");
    expect(mockCalls).toHaveLength(1);
    second.unmount();

    // A remount after success still says success, though the secret is gone.
    const third = mount();
    await act(async () => {});
    expect(third.text()).toContain("Google is connected");
    expect(mockCalls).toHaveLength(1);
    third.unmount();
  });

  test("the secret survives until the completion settles", async () => {
    rememberGoogleCompletionSecret("state-1", "secret-1");
    const view = mount();
    expect(peekGoogleCompletionSecret("state-1")).toBe("secret-1");
    await settle(0, "resolve");
    expect(peekGoogleCompletionSecret("state-1")).toBeNull();
    view.unmount();
  });

  test("a refused completion shows the failure and forgets the secret", async () => {
    rememberGoogleCompletionSecret("state-1", "secret-1");
    const view = mount();
    await settle(0, "reject");
    expect(view.text()).toContain("Google did not connect");
    expect(peekGoogleCompletionSecret("state-1")).toBeNull();
    view.unmount();
  });

  test("with no secret and nothing in flight, the page fails without calling", () => {
    const view = mount();
    expect(view.text()).toContain("Google did not connect");
    expect(mockCalls).toHaveLength(0);
    view.unmount();
  });
});

describe("completeGoogleCallbackOnce", () => {
  const args = { state: "state-9", code: "code-9", completionSecret: "secret-9" };

  test("a rejected completion can be retried", async () => {
    const run = jest.fn<() => Promise<{ ai: boolean; workspaceId: string }>>();
    run.mockRejectedValueOnce(new Error("network"));
    run.mockResolvedValueOnce({ ai: false, workspaceId: "workspace-9" });
    await expect(completeGoogleCallbackOnce(args, run)).rejects.toThrow("network");
    await expect(completeGoogleCallbackOnce(args, run)).resolves.toEqual({ ai: false, workspaceId: "workspace-9" });
    expect(run).toHaveBeenCalledTimes(2);
  });

  test("concurrent and later calls for one state share one run once it succeeds", async () => {
    const run = jest.fn(async () => ({ ai: true, workspaceId: "workspace-9" }));
    const a = completeGoogleCallbackOnce(args, run);
    const b = completeGoogleCallbackOnce(args, run);
    expect(a).toBe(b);
    await a;
    await completeGoogleCallbackOnce(args, run);
    expect(run).toHaveBeenCalledTimes(1);
  });
});
