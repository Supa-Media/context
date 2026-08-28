/**
 * @jest-environment jsdom
 */

import { describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ConvexError } from "convex/values";

// React only treats `act` as authoritative when this is set.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * `/connect/dropbox`, wired.
 *
 * `dropboxConnect.test.ts` proves which view each set of inputs resolves to.
 * This proves the screen *does* the right thing on the way there, and there is
 * exactly one thing it does that a pure function cannot express:
 *
 * **The exchange runs once.** The attempt row is single-use and is deleted
 * before the code is spent, so a second `completeDropboxConnect` with the same
 * state is refused. A re-render — StrictMode's double effect, a subscription
 * landing, a dependency that is a fresh object every render — would therefore
 * fire a second exchange whose only possible outcome is
 * `CONNECT_ATTEMPT_INVALID`, and that failure would land *on top of* a connect
 * that had already succeeded. The person would be told their connection
 * expired while their storage was, in fact, connected.
 *
 * Everything else here is about not spending a code that should not be spent:
 * not while signed out, not while auth is still resolving, not on a refusal,
 * not on a URL with no state in it.
 *
 * ## What deleting that guard actually does, verified
 *
 * Not "the exchange fires twice". The effect sets state on every run and the
 * state is a fresh object each time, so React can never bail out: the effect
 * and its own `setAttempt` feed each other and the exchange fires without
 * bound, in a microtask loop that starves the macrotask queue. So the run
 * **hangs** rather than failing an assertion, and jest's per-test timeout never
 * gets a turn to fire.
 *
 * That is an unmistakable CI failure and it is left as the signal, because
 * every attempt to convert it into a clean one made the harness lie about the
 * bug: throwing from the mock is caught by the screen's own error branch and
 * feeds the loop again, and a promise that never settles stops the *action*
 * while the `setAttempt({ kind: "running" })` above it keeps looping on its
 * own. A stop that has to sit inside the thing under test is not a test.
 *
 * ## Why this file mocks what it mocks
 *
 * `useConvexAuth` reads a context only `ConvexProviderWithAuth` provides and
 * throws without one; `useAction` and `useQueries` need a live socket. All
 * three are stubbed so the test can stand in any point of the flow. Same
 * approach, and the same reasoning, as `appLayoutGate.test.ts`. React Native
 * itself needs no stub — `jest.config.js` maps it to `react-native-web`.
 */

// `mock`-prefixed so `jest.mock`'s hoisted factories may close over them.
let mockAuth: { isLoading: boolean; isAuthenticated: boolean } = {
  isLoading: false,
  isAuthenticated: true,
};
let mockParams: Record<string, string | string[]> = {};
let mockResults: Record<string, unknown> = {};
let mockAction: (args: unknown) => Promise<unknown> = async () => ({ workspaceId: "ws_1" });
const mockActionCalls: unknown[] = [];
const mockRedirects: string[] = [];
const mockReplaced: string[] = [];

jest.mock("expo-router", () => {
  const { createElement: h } = require("react") as typeof import("react");
  return {
    Redirect: ({ href }: { href: string }) => {
      mockRedirects.push(href);
      return h("div", { "data-testid": "redirect", "data-href": href });
    },
    Stack: () => null,
    useLocalSearchParams: () => mockParams,
    useRouter: () => ({ replace: (href: string) => mockReplaced.push(href) }),
  };
});

jest.mock("convex/react", () => {
  const actual = jest.requireActual("convex/react") as Record<string, unknown>;
  return {
    ...actual,
    useConvexAuth: () => mockAuth,
    useAction: () => (args: unknown) => {
      mockActionCalls.push(args);
      return mockAction(args);
    },
    useQueries: (spec: Record<string, unknown>) =>
      Object.fromEntries(Object.keys(spec).map((key) => [key, mockResults[key]])),
  };
});

/* eslint-disable @typescript-eslint/no-var-requires */
const { DropboxCallbackScreen } = require("../features/console/storage/DropboxCallbackScreen") as {
  DropboxCallbackScreen: () => unknown;
};

function reset() {
  mockAuth = { isLoading: false, isAuthenticated: true };
  mockParams = {};
  mockResults = {};
  mockAction = async () => ({ workspaceId: "ws_1" });
  mockActionCalls.length = 0;
  mockRedirects.length = 0;
  mockReplaced.length = 0;
}

interface Screen {
  text: string;
  q: (testID: string) => HTMLElement | null;
  rerender: () => Promise<void>;
  unmount: () => void;
}

async function mount(): Promise<Screen> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  const node = createElement(DropboxCallbackScreen as never);
  await act(async () => {
    root.render(node);
  });
  return {
    get text() {
      return container.textContent ?? "";
    },
    q: (testID: string) =>
      container.querySelector(`[data-testid="${testID}"]`) as HTMLElement | null,
    // A fresh element every time, so React reconciles rather than bailing out —
    // which is what makes "does the effect fire again?" a real question.
    rerender: async () => {
      await act(async () => {
        root.render(createElement(DropboxCallbackScreen as never));
      });
    },
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

describe("the Dropbox callback route", () => {
  /**
   * The one that matters. Three renders, one exchange.
   */
  test("the exchange runs once, however many times the screen renders", async () => {
    reset();
    mockParams = { code: "c1", state: "s1" };
    const screen = await mount();
    expect(mockActionCalls).toEqual([{ state: "s1", code: "c1" }]);

    await screen.rerender();
    await screen.rerender();
    expect(mockActionCalls).toHaveLength(1);
    screen.unmount();
  });

  test("it sends the code and state from the URL, and nothing else", async () => {
    reset();
    mockParams = { code: ["c1", "c2"], state: "s1", error: undefined as never };
    const screen = await mount();
    expect(mockActionCalls).toEqual([{ state: "s1", code: "c1" }]);
    screen.unmount();
  });

  /**
   * THE INVERSION OF A GUARD THIS FILE USED TO CARRY, on purpose.
   *
   * These used to assert that a signed-out visit spends nothing and redirects
   * to sign-in with the code in `next`. That wall is what failed the first
   * live connect: the OAuth round trip dropped the session, the wall demanded
   * email OTP, and the minutes it took outlived Dropbox's single-use code.
   * The exchange needs no session — PKCE binds the code to the parked
   * attempt — so it now runs immediately, whatever the auth state is doing.
   */
  test("the exchange runs immediately while auth is still resolving", async () => {
    reset();
    mockAuth = { isLoading: true, isAuthenticated: false };
    mockParams = { code: "c1", state: "s1" };
    const screen = await mount();
    expect(mockActionCalls).toEqual([{ state: "s1", code: "c1" }]);
    // And exactly once: auth settling later must not spend a second attempt.
    expect(mockRedirects).toEqual([]);
    screen.unmount();
  });

  test("signed out still exchanges, and is never bounced to a sign-in wall", async () => {
    reset();
    mockAuth = { isLoading: false, isAuthenticated: false };
    mockParams = { code: "c1", state: "s1" };
    const screen = await mount();
    expect(mockActionCalls).toEqual([{ state: "s1", code: "c1" }]);
    expect(mockRedirects).toEqual([]);
    screen.unmount();
  });

  test("a refusal from Dropbox spends nothing and reads as an answer", async () => {
    reset();
    mockParams = { error: "access_denied", state: "s1" };
    const screen = await mount();
    expect(mockActionCalls).toEqual([]);
    expect(screen.q("dropbox-cancelled")).not.toBe(null);
    screen.unmount();
  });

  /**
   * `state` is the only thing binding a returned code to the flow that started
   * it. Sending a bare code up is asking the backend for a refusal, and showing
   * the person an error instead of "there is nothing here to finish".
   */
  test("a code with no state is never exchanged", async () => {
    reset();
    mockParams = { code: "c1" };
    const screen = await mount();
    expect(mockActionCalls).toEqual([]);
    expect(screen.q("dropbox-incomplete")).not.toBe(null);
    screen.unmount();
  });

  test("the bare path is not a failure and spends nothing", async () => {
    reset();
    const screen = await mount();
    expect(mockActionCalls).toEqual([]);
    expect(screen.q("dropbox-incomplete")).not.toBe(null);
    screen.unmount();
  });

  /**
   * The action returns "queued, for this workspace" — it schedules the
   * exchange, so it cannot say whether it worked. The row is what says, and
   * the screen has to keep waiting until it does.
   */
  test("a queued exchange waits on the binding rather than declaring success", async () => {
    reset();
    mockParams = { code: "c1", state: "s1" };
    const screen = await mount();
    expect(screen.q("dropbox-working")).not.toBe(null);
    expect(screen.text).not.toContain("Dropbox is connected");

    mockResults = { binding: { status: "unverified", provider: "dropbox" }, workspaces: [] };
    await screen.rerender();
    expect(screen.q("dropbox-working")).not.toBe(null);

    mockResults = {
      binding: { status: "connected", provider: "dropbox" },
      workspaces: [{ workspaceId: "ws_1", slug: "seyi" }],
    };
    await screen.rerender();
    expect(screen.q("dropbox-connected")).not.toBe(null);
    expect(screen.text).toContain("Dropbox is connected");
    screen.unmount();
  });

  test("a binding that failed is described in Dropbox's terms", async () => {
    reset();
    mockParams = { code: "c1", state: "s1" };
    const screen = await mount();
    mockResults = {
      binding: { status: "error", errorCode: "CREDENTIAL_UNAVAILABLE", provider: "dropbox" },
      workspaces: [],
    };
    await screen.rerender();
    expect(screen.q("dropbox-failed")).not.toBe(null);
    expect(screen.text).toContain("Reconnect Dropbox");
    expect(screen.text).not.toMatch(/access key/i);
    screen.unmount();
  });

  test("a refused exchange shows the refusal, and does not retry it", async () => {
    reset();
    mockParams = { code: "c1", state: "s1" };
    mockAction = async () => {
      throw new ConvexError({
        code: "CONNECT_ATTEMPT_INVALID",
        message: "That Dropbox connection has expired. Start it again.",
      });
    };
    const screen = await mount();
    expect(screen.q("dropbox-failed")).not.toBe(null);
    expect(screen.text).toContain("expired");
    await screen.rerender();
    expect(mockActionCalls).toHaveLength(1);
    screen.unmount();
  });

  // A query that errored is not a binding. Reading it as one would show a
  // failure about somebody's storage when what failed was the socket.
  test("a subscription that threw is not read as a verdict", async () => {
    reset();
    mockParams = { code: "c1", state: "s1" };
    const screen = await mount();
    mockResults = { binding: new Error("socket hang up"), workspaces: new Error("socket") };
    await screen.rerender();
    expect(screen.q("dropbox-working")).not.toBe(null);
    expect(screen.q("dropbox-failed")).toBe(null);
    screen.unmount();
  });
});
