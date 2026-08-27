/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * The pane head is edited for the screen it is on.
 *
 * Found by looking, not by reasoning: rendered in Chromium at 390×844, the
 * title and its two-line explanation measured **95px of an 844px viewport** —
 * about a ninth of the screen, sitting above every note, every time one is
 * opened. On a desktop that paragraph orients somebody seeing the pane for the
 * first time. On a phone it is a paragraph standing between a tap and the note
 * it asked for, and the top bar already names the context.
 *
 * The heading stays at every width. It is the landmark a screen reader
 * navigates by, so dropping it would cost the page its structure and save
 * nothing — the paragraph is all of the height.
 */

const { PaneHead } =
  require("../features/console/ConsoleShell") as typeof import("../features/console/ConsoleShell");
const { layout } =
  require("../features/design/tokens") as typeof import("../features/design/tokens");

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

const DESCRIPTION =
  "Plain markdown, exactly as it sits in your bucket. Edit it here or in Obsidian — it is the same file either way.";

function mountHead(width: number) {
  // react-native-web measures `document.documentElement.clientWidth`, which
  // jsdom reports as 0 — see `appFrameRender.test.ts` for the whole trap.
  Object.defineProperty(document.documentElement, "clientWidth", {
    value: width,
    configurable: true,
  });
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: 844,
    configurable: true,
  });
  window.dispatchEvent(new Event("resize"));

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });

  act(() => {
    root.render(
      createElement(PaneHead, { title: "Browse @seyi", description: DESCRIPTION }),
    );
  });

  return container;
}

describe("the description", () => {
  test("a desktop gets it", () => {
    expect(mountHead(1440).textContent).toContain(DESCRIPTION);
  });

  test("a tablet still gets it — there is room", () => {
    expect(mountHead(1024).textContent).toContain(DESCRIPTION);
  });

  test("a phone does not", () => {
    expect(mountHead(390).textContent).not.toContain("Plain markdown");
  });

  test("the boundary is the token, not a number typed into the component", () => {
    expect(mountHead(layout.narrowBreakpoint).textContent).toContain(DESCRIPTION);
    expect(mountHead(layout.narrowBreakpoint - 1).textContent).not.toContain("Plain markdown");
  });
});

describe("the heading", () => {
  test("survives at every width, as a real heading", () => {
    for (const width of [390, 1024, 1440]) {
      const container = mountHead(width);
      expect(container.textContent).toContain("Browse @seyi");
      const heading = container.querySelector('[role="heading"]');
      expect(heading).not.toBeNull();
      expect(heading!.getAttribute("aria-level")).toBe("2");
    }
  });

  test("a width of 0 is not treated as a phone", () => {
    // react-native-web reports 0 for a frame before the window is measured,
    // and on some server-rendered mounts. Hiding the description on that frame
    // would make it flicker in on desktop; the guard is `width > 0`.
    expect(mountHead(0).textContent).toContain(DESCRIPTION);
  });
});
