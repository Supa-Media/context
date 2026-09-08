/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://context.lc/"}
 */

/**
 * **THE HALF OF THE BINDING THAT KEEPS THE FLOW WORKING, on the start side.**
 *
 * `dropboxCallbackRoute.test.ts` pins that the callback screen sends the
 * secret this browser kept, and its own comment says the sabotage it was
 * written against was two-headed: hardcode `completionSecret: ""` in the
 * screen, *or* delete the `keepCompletionSecret` call in `useDropboxStart`.
 * Only the first head was covered. Deleting the call in the hook left the
 * whole mobile suite green — measured, not assumed — while every live Dropbox
 * connect would have failed permanently, for everyone, with the refusal that
 * says "that connection has expired".
 *
 * That is precisely the failure `#76` exists because of: a connect flow that
 * stops working for its own owner. So the start side gets its own check.
 *
 * Nothing here mocks `dropbox.ts`: the store is the real `localStorage` this
 * environment provides, and the key is whatever `keepCompletionSecret` chose,
 * read back through `takeCompletionSecret` exactly as the callback screen
 * reads it. A test that asserted the literal key would pass while the two
 * halves disagreed about it.
 */

import { describe, expect, jest, test, beforeEach } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// `mock`-prefixed so `jest.mock`'s hoisted factories may close over them.
let mockStartResult: unknown = {
  authorizeUrl: "https://www.dropbox.com/oauth2/authorize?client_id=x&state=s",
  completionSecret: "kept-by-this-browser",
};
const mockStartCalls: unknown[] = [];
/** What the store held at the instant the browser was sent to Dropbox. */
const mockHeldAtNavigation: (string | null)[] = [];
const mockNavigations: string[] = [];

jest.mock("convex/react", () => ({
  useAction: () => (args: unknown) => {
    mockStartCalls.push(args);
    return Promise.resolve(mockStartResult);
  },
}));

jest.mock("../features/console/storage/leaveForDropbox", () => ({
  leaveForDropbox: (url: string) => {
    // Read here rather than after: the navigation destroys the page, so a
    // secret kept *after* this line is a secret never kept at all.
    mockHeldAtNavigation.push(globalThis.localStorage.getItem("context.dropbox.completion"));
    mockNavigations.push(url);
  },
}));

/* eslint-disable @typescript-eslint/no-var-requires */
const { useDropboxStart } = require("../features/console/storage/useDropboxStart") as {
  useDropboxStart: (
    workspaceId: string | null,
    options?: { resumeTo?: "onboarding" },
  ) => { redirectUri: string | null; start: (folder?: string) => void };
};
const { takeCompletionSecret, browserCompletionStore } =
  require("../features/console/storage/dropbox") as {
    takeCompletionSecret: (store: unknown) => string;
    browserCompletionStore: () => unknown;
  };

/** Mount a component that does nothing but hand back the hook's `start`. */
async function mountHook(): Promise<{
  start: (folder?: string) => void;
  redirectUri: string | null;
  unmount: () => void;
}> {
  let captured: { redirectUri: string | null; start: (folder?: string) => void } | null = null;
  function Probe() {
    captured = useDropboxStart("ws_1");
    return null;
  }
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  await act(async () => {
    root.render(createElement(Probe));
  });
  const held = captured as unknown as { redirectUri: string | null; start: (f?: string) => void };
  return {
    start: held.start,
    redirectUri: held.redirectUri,
    unmount: () => {
      act(() => root.unmount());
      container.remove();
    },
  };
}

beforeEach(() => {
  mockStartCalls.length = 0;
  mockNavigations.length = 0;
  mockHeldAtNavigation.length = 0;
  globalThis.localStorage.clear();
  mockStartResult = {
    authorizeUrl: "https://www.dropbox.com/oauth2/authorize?client_id=x&state=s",
    completionSecret: "kept-by-this-browser",
  };
});

describe("starting a Dropbox connect", () => {
  test("THE SECRET THE CONTROL PLANE HANDED THIS BROWSER IS KEPT BEFORE IT LEAVES", async () => {
    const screen = await mountHook();
    expect(screen.redirectUri).toBe("https://context.lc/connect/dropbox");

    await act(async () => {
      screen.start();
    });

    expect(mockNavigations).toEqual([
      "https://www.dropbox.com/oauth2/authorize?client_id=x&state=s",
    ]);
    // Kept BEFORE the navigation, because the navigation destroys the page.
    expect(mockHeldAtNavigation).toEqual(["kept-by-this-browser"]);
    // And it is the value the callback screen will read, through the same two
    // functions, rather than a key this test happens to agree with.
    expect(takeCompletionSecret(browserCompletionStore())).toBe("kept-by-this-browser");
    screen.unmount();
  });

  /**
   * A second connect must not inherit the first's proof. The callback screen
   * spends the value, and a start overwrites it, so the only secret in the
   * store is the one the most recent start was handed.
   */
  test("a second start replaces the first's secret rather than keeping both", async () => {
    const first = await mountHook();
    await act(async () => {
      first.start();
    });
    first.unmount();

    mockStartResult = {
      authorizeUrl: "https://www.dropbox.com/oauth2/authorize?client_id=x&state=s2",
      completionSecret: "the-second-one",
    };
    const second = await mountHook();
    await act(async () => {
      second.start();
    });
    expect(mockHeldAtNavigation).toEqual(["kept-by-this-browser", "the-second-one"]);
    expect(takeCompletionSecret(browserCompletionStore())).toBe("the-second-one");
    second.unmount();
  });
});
