/**
 * @jest-environment jsdom
 */

import { describe, expect, jest, test } from "@jest/globals";

/*
  The notch and the home indicator, as a number.

  Every screen now clears them through `features/app/Screen.tsx`, which reads
  `useSafeAreaInsets` — and that hook throws outside a `SafeAreaProvider`
  rather than answering zero. Mocking the hook is the same trade
  `appFrameRender.test.ts` makes: the insets are the platform's business, and a
  provider here would be a second thing under test.
*/
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ErrorBoundary } from "../features/app/ErrorBoundary";

// React only treats `act` as authoritative when this is set, and warns loudly on
// every call when it is not.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The blank-dark-page guard.
 *
 * Convex's `useQuery` re-throws a failed query **during render**. One transient
 * failure anywhere in the route tree — an auth blip, a deploy, a backend
 * hiccup — therefore threw straight past every layout in this app, because
 * there was no `componentDidCatch` anywhere in `app/` or `features/`. React's
 * behaviour when nothing catches is to unmount the entire tree, so the user got
 * the dark ground and *nothing else*: no message, no reload prompt, no clue
 * that reloading would help.
 *
 * This file mounts a real reconciler because that is the only thing that can
 * fail: an error boundary is a reconciler feature. `renderToStaticMarkup` does
 * not run `getDerivedStateFromError` at all, and a component that throws under
 * SSR just rejects the render — a harness that "passes" without ever proving a
 * boundary caught anything.
 *
 * React logs a caught error to `console.error` by design; `onCaughtError` is
 * silenced on the root so the suite's output stays readable and a real
 * unexpected throw is still visible as a failing assertion.
 */

function mount(children: ReactNode): { container: HTMLElement; root: Root } {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, {
    onUncaughtError: () => {},
    onCaughtError: () => {},
  });
  act(() => {
    root.render(children);
  });
  return { container, root };
}

function unmount({ container, root }: { container: HTMLElement; root: Root }) {
  act(() => root.unmount());
  container.remove();
}

/** A child that throws on its first render and behaves on every one after. */
function flaky(state: { throws: boolean }) {
  return function Flaky() {
    if (state.throws) throw new Error("NOT_AUTHENTICATED");
    return createElement("div", { "data-testid": "child" }, "the console");
  };
}

describe("the root error boundary", () => {
  test("a child that renders is left completely alone", () => {
    const mounted = mount(
      createElement(ErrorBoundary, null, createElement(flaky({ throws: false }))),
    );
    expect(mounted.container.querySelector('[data-testid="child"]')).not.toBeNull();
    expect(mounted.container.querySelector('[data-testid="error-boundary"]')).toBeNull();
    unmount(mounted);
  });

  test("a throw during render becomes a screen with words on it, not a void", () => {
    const mounted = mount(
      createElement(ErrorBoundary, null, createElement(flaky({ throws: true }))),
    );

    const screen = mounted.container.querySelector('[data-testid="error-boundary"]');
    expect(screen).not.toBeNull();

    // The failure that mattered was a *blank* page. The assertion is therefore
    // that there is readable text, and a control, not merely that something
    // rendered.
    expect(mounted.container.textContent).toContain("Something broke on this screen");
    expect(mounted.container.querySelector('[data-testid="error-retry"]')).not.toBeNull();

    unmount(mounted);
  });

  test("the thrown message is shown, so a screenshot is a bug report", () => {
    const mounted = mount(
      createElement(ErrorBoundary, null, createElement(flaky({ throws: true }))),
    );
    expect(mounted.container.textContent).toContain("NOT_AUTHENTICATED");
    unmount(mounted);
  });

  test("Try again re-renders the children, and a cleared failure comes back", () => {
    const state = { throws: true };
    const Flaky = flaky(state);
    const mounted = mount(createElement(ErrorBoundary, null, createElement(Flaky)));
    expect(mounted.container.querySelector('[data-testid="child"]')).toBeNull();

    // Whatever it was has passed — which is the ordinary case for a transient
    // query failure by the time somebody reaches for the button.
    state.throws = false;
    const retry = mounted.container.querySelector(
      '[data-testid="error-retry"]',
    ) as HTMLElement;
    act(() => {
      retry.click();
    });

    expect(mounted.container.querySelector('[data-testid="child"]')).not.toBeNull();
    expect(mounted.container.querySelector('[data-testid="error-boundary"]')).toBeNull();
    unmount(mounted);
  });

  test("a failure that has not cleared shows the same screen rather than looping", () => {
    const mounted = mount(
      createElement(ErrorBoundary, null, createElement(flaky({ throws: true }))),
    );
    const retry = mounted.container.querySelector(
      '[data-testid="error-retry"]',
    ) as HTMLElement;
    act(() => {
      retry.click();
    });
    // Still the boundary, not a spinner and not a stack overflow: the boundary
    // never retries on its own.
    expect(mounted.container.querySelector('[data-testid="error-boundary"]')).not.toBeNull();
    unmount(mounted);
  });

  test("it is actually mounted around every route, inside the Convex provider", () => {
    // The component existing is worth nothing if nothing wraps the app in it,
    // and that wiring lives in a file this suite cannot render (`expo-router`'s
    // `Slot` needs a router). Reading it is the honest check.
    const layout = readFileSync(join(__dirname, "../app/_layout.tsx"), "utf8");
    const boundary = layout.indexOf("<ErrorBoundary>");
    const provider = layout.indexOf("<SupaConvexProvider");
    const slot = layout.indexOf("<Slot />");

    expect(provider).toBeGreaterThan(-1);
    expect(boundary).toBeGreaterThan(-1);
    // Inside the provider (so the fallback and the retry still have a client
    // and a session context) and outside the routes (so it can catch them).
    expect(boundary).toBeGreaterThan(provider);
    expect(slot).toBeGreaterThan(boundary);
  });
});
