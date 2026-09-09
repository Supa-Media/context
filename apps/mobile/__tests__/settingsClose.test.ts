/**
 * @jest-environment jsdom
 */

/**
 * **Closing settings must not close the note behind it.**
 *
 * This file used to guard a reconstruction. Settings was a *route* pushed over
 * Browse, so dismissing it had to work out where to go back to — the context
 * root, or the note somebody had open — and get it right, because a URL that
 * has lost its `?note=` is an instruction to close that note rather than a
 * stale address (`noteAddress.ts`). The route named both cases explicitly and
 * this test stopped anybody tidying it back to a bare `browseHref`.
 *
 * **There is nothing left to reconstruct.** The console renders one `<Slot />`,
 * so a settings route replaced Browse rather than covering it — which is why
 * the reconstruction existed at all. Settings is a parameter on the context's
 * own page now (`?settings=<section>`), drawn as an overlay by the console
 * layout, so the note keeps its own `?note=` throughout and closing drops one
 * parameter and touches nothing else.
 *
 * What still needs guarding is the other half of that promise: the old path is
 * in the wild — the Dropbox failure notice and the search nudge both link to
 * it, and somebody has it in a chat — so it must keep landing on settings
 * rather than on a dead page. That is what this file asserts now.
 */

import { describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import Route from "../app/(app)/console/[slug]/settings";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const redirected: string[] = [];
let mockSlug: string | undefined = "@seyi";

jest.mock("expo-router", () => ({
  useRouter: () => ({ push: () => {}, replace: () => {} }),
  useLocalSearchParams: () => ({ slug: mockSlug }),
  Redirect: ({ href }: { href: string }) => {
    redirected.push(href);
    return null;
  },
}));

jest.mock("../features/console/ConsoleDataContext", () => ({
  useConsoleData: () => ({ contexts: [{ id: "w1", slug: "seyi", role: "owner" }] }),
}));

function render(): void {
  redirected.length = 0;
  const host = document.createElement("div");
  const root = createRoot(host);
  act(() => {
    root.render(createElement(Route));
  });
  act(() => {
    root.unmount();
  });
}

describe("the settings path somebody already has", () => {
  test("still lands on settings, as the parameter form", () => {
    mockSlug = "@seyi";
    render();
    // Not `/console/@seyi` — that is Browse with settings closed, which is the
    // dead page this redirect exists to avoid.
    expect(redirected).toEqual(["/console/@seyi?settings=overview"]);
  });

  test("does not invent a context when the URL names none", () => {
    mockSlug = undefined;
    render();
    // The one case where there is no context to open settings for. It goes to
    // a place rather than to `?settings=` on nothing.
    expect(redirected).toEqual(["/console/@you"]);
  });
});
