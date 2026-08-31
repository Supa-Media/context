/**
 * @jest-environment jsdom
 */

/**
 * The console, rendered to standalone HTML so it can be photographed.
 *
 * ## Why this exists
 *
 * This branch is a visual-parity exercise: the acceptance criterion is "it
 * looks like Obsidian on iOS", and there is no way to check that against a
 * measured spec except by putting the two pictures side by side. The console
 * needs a signed-in session and a customer's bucket, so photographing the real
 * app means an account, a backend and a device — none of which a reviewer
 * reading the diff has.
 *
 * So the same components are mounted here against the landing page's demo data,
 * rendered by react-native-web exactly as they are in a browser, and written out
 * as self-contained HTML files. Playwright then opens each at 440x956 — the
 * reference's own size in points — and takes the picture. Nothing is mocked
 * except the router, the safe-area insets and the Convex subscription; the
 * layout, the styles and every measurement in them are the shipped ones.
 *
 * ## It is not a test, and is not run by `pnpm test`
 *
 * `jest.config.js` matches `**\/__tests__\/**` only, so this file is inert
 * unless somebody asks for it by name:
 *
 *     pnpm exec jest --testMatch '**\/scripts/design-shots.ts' --testPathIgnorePatterns '[]'
 *
 * It is written as a Jest file rather than as a standalone script because Jest
 * is where this repo's TypeScript, JSX and react-native-web aliasing are already
 * configured, and a second toolchain for one screenshot would be a worse trade
 * than an unusual file extension.
 *
 * ## The one thing that is easy to get wrong
 *
 * The styles arrive from three places, and taking one of them gives a picture
 * that looks like a broken app rather than like the app. react-native-web
 * builds an atomic sheet reachable through `StyleSheet.getSheet()`; CodeMirror
 * injects its own base theme into `document.head`; and `LiveEditor.web.tsx`
 * injects the live-preview rules — the note's whole reading type — the same
 * way. All three are gathered after the mount, because none of them exists
 * before it.
 */

import { describe, expect, jest, test } from "@jest/globals";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The reference is a 1320x2868 screenshot at @3x, which is 440x956 points. */
const WIDTH = 440;
const HEIGHT = 956;

/**
 * A desktop window, for the shot that exists to prove nothing broke there.
 *
 * Web ships daily and is the surface most of this product's use is on today.
 * Every change on this branch is a *phone* change, and the way a phone change
 * breaks a desktop is by moving something both densities share — so one picture
 * of the pointer layout is worth the twenty lines it costs.
 */
const WIDE = 1440;
const WIDE_HEIGHT = 900;

const OUT = resolve(__dirname, "../../../docs/design/obsidian-parity");

const mockInsets = { top: 59, bottom: 34, left: 0, right: 0 };
let mockPathname = "/console/@seyi";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => mockInsets,
}));

jest.mock("expo-router", () => ({
  Slot: () => {
    const { createElement: h } =
      require("react") as typeof import("react");
    const { BrowsePane } =
      require("../features/console/panes/BrowsePane") as typeof import("../features/console/panes/BrowsePane");
    const { useConsoleData } =
      require("../features/console/ConsoleDataContext") as typeof import("../features/console/ConsoleDataContext");
    return h(BrowsePane, { data: useConsoleData() });
  },
  Redirect: () => null,
  useRouter: () => ({ replace: () => {}, push: () => {} }),
  usePathname: () => mockPathname,
}));

jest.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({ signOut: async () => {} }),
}));

/**
 * The demo console is read-only by design, and one shot needs it not to be.
 *
 * `useDemoConsoleData` sets `canEdit: false` so a landing-page visitor is never
 * offered a control that would lie. That is right for the landing page and
 * wrong for a picture of the *editing* surface: the keyboard accessory bar only
 * exists while a note is editable and focused. So one flag, read at render, and
 * nothing else about the demo data changes.
 */
/*
  Named `mockEditable` because Jest hoists `jest.mock` above every declaration
  in the file and refuses a factory that closes over an ordinary local: the
  variable would be uninitialised at the moment the factory runs. A `mock`
  prefix is the documented opt-out, on the understanding that the factory is
  only ever *called* lazily — which it is, once React renders.
*/
let mockEditable = false;

jest.mock("../features/console/useLiveConsoleData", () => {
  const { useDemoConsoleData } =
    require("../features/console/useDemoConsoleData") as typeof import("../features/console/useDemoConsoleData");
  return {
    useLiveConsoleData: () => {
      const data = useDemoConsoleData();
      return mockEditable ? { ...data, files: { ...data.files, canEdit: true } } : data;
    },
  };
});

/**
 * `StyleSheet.getSheet()` is react-native-web's, not React Native's.
 *
 * It is how RNW hands back the atomic stylesheet it has been injecting into
 * `document.head` as it renders, and it is absent from the `react-native`
 * types this repo compiles against — which is the whole reason for the cast.
 * There is no equivalent on a device, and nothing outside this harness needs
 * it.
 */
const { StyleSheet } = require("react-native") as {
  StyleSheet: { getSheet(): { textContent: string } };
};
const ConsoleLayout = (
  require("../app/(app)/console/_layout") as { default: () => unknown }
).default;

/* -------------------------------------------------------------------------- */

function stampViewport(width = WIDTH, height = HEIGHT): void {
  for (const [key, value] of [
    ["clientWidth", width],
    ["clientHeight", height],
  ] as const) {
    Object.defineProperty(document.documentElement, key, {
      value,
      configurable: true,
    });
  }
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
  window.dispatchEvent(new Event("resize"));
}

/**
 * The rendered tree plus the stylesheet react-native-web built for it.
 *
 * `#root` is given the reference's exact box so the picture is not at the mercy
 * of the browser's default margin, and `overflow: hidden` clips it the way a
 * phone's glass does rather than letting a tall region grow the page.
 */
function page(title: string, body: string, css: string, width = WIDTH, height = HEIGHT): string {
  const WIDTH = width;
  const HEIGHT = height;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${title}</title>
<style>
  html, body { margin: 0; padding: 0; background: #FFFFFF; }
  body { -webkit-font-smoothing: antialiased; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  #shot { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; position: relative; }
  /*
    The frame asks for \`height: 100dvh\`, and jsdom's CSS parser does not know
    \`dvh\` — it drops the whole declaration, which \`appFrameRender.test.ts\`
    documents as the reason its own assertion reads the style object rather
    than the rendered node. So the markup that comes out of here has the
    frame's \`max-height\` and not its height, and the frame would be content
    tall with its floating toolbar stranded in the middle of the page. This
    restores what a real browser would have computed, and nothing else.
  */
  #shot > div { height: ${HEIGHT}px !important; max-height: ${HEIGHT}px !important; }
</style>
<style id="rnw">${css}</style>
</head><body><div id="shot">${body}</div></body></html>`;
}

function press(node: Element | null): void {
  if (node === null) throw new Error("nothing to press");
  act(() => {
    node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function shoot(
  name: string,
  prepare: (container: HTMLElement) => void = () => {},
  size: { width: number; height: number } = { width: WIDTH, height: HEIGHT },
): void {
  stampViewport(size.width, size.height);

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });

  act(() => {
    root.render(createElement(ConsoleLayout as never));
  });
  prepare(container);

  /*
    Every stylesheet on the page, not only react-native-web's.

    CodeMirror injects its own base theme, and `LiveEditor.web.tsx` injects the
    live-preview rules — the ones that give the note its 16/24 type and its
    reading margin — as plain `<style>` elements in `document.head`. Taking
    `StyleSheet.getSheet()` alone produced a document whose note was 16px at
    `line-height: normal` with no side padding at all, which looked like a bug
    in the app and was a bug in this file.
  */
  const injected = [...document.head.querySelectorAll("style")]
    .map((node) => node.textContent ?? "")
    .join("\n");
  const file = resolve(OUT, `${name}.html`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    page(
      name,
      container.innerHTML,
      `${StyleSheet.getSheet().textContent}\n${injected}`,
      size.width,
      size.height,
    ),
    "utf8",
  );

  act(() => root.unmount());
  container.remove();
}

const find = (container: HTMLElement, testId: string) =>
  container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

/* -------------------------------------------------------------------------- */

describe("design shots", () => {
  test("the reading view", () => {
    shoot("context-reading", (container) => {
      // Open a note, so the shot is a document rather than an empty state.
      const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')].find(
        (node) => (node.getAttribute("aria-label") ?? "").endsWith("overview"),
      );
      if (row !== null && row !== undefined) press(row);
    });
    expect(true).toBe(true);
  });

  /**
   * The pointer layout, unchanged.
   *
   * Not parity with anything — Obsidian's desktop is a different design and
   * this branch does not touch it. It is a regression shot: the palette, the
   * marker rule and the frame's chrome are all shared, and this is where a
   * phone change shows up as a broken desktop.
   */
  test("the desktop layout still works", () => {
    shoot(
      "context-desktop",
      () => {},
      { width: WIDE, height: WIDE_HEIGHT },
    );
    expect(true).toBe(true);
  });

  /**
   * The Properties panel open, over the note it describes.
   *
   * The state the whole frontmatter change exists for: a captured note used to
   * open with a dozen lines of YAML filling the first screen, and now opens
   * with one quiet row that expands into this.
   */
  test("the properties panel", () => {
    shoot("context-properties", (container) => {
      const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')].find(
        (node) => (node.getAttribute("aria-label") ?? "").endsWith("bandshell-permit"),
      );
      if (row !== undefined) press(row);
      press(find(container, "note-properties"));
    });
    expect(true).toBe(true);
  });

  /**
   * The editing surface, with the keyboard accessory bar up.
   *
   * The bar is shown while the editor holds the caret, so the shot has to
   * actually focus it rather than assert it into existence. jsdom's `focus()`
   * dispatches a real focus event, which is what CodeMirror listens for, which
   * is what reaches `onFocus`.
   *
   * The soft keyboard itself is not in the picture — there is no soft keyboard
   * in a headless browser — so what this shows is the bar and where it lands,
   * which is the part that is ours to get right.
   */
  test("the editing view", () => {
    mockEditable = true;
    shoot("context-editing", (container) => {
      const row = [...container.querySelectorAll<HTMLElement>('[role="button"]')].find(
        (node) => (node.getAttribute("aria-label") ?? "").endsWith("context-lc"),
      );
      if (row !== undefined) press(row);
      const surface = container.querySelector<HTMLElement>(".cm-content");
      if (surface !== null) {
        act(() => {
          surface.focus();
          surface.dispatchEvent(new FocusEvent("focus", { bubbles: false }));
        });
      }
    });
    mockEditable = false;
    expect(true).toBe(true);
  });

  test("the file explorer", () => {
    shoot("context-explorer", (container) => {
      press(find(container, "frame-drawer-toggle"));
    });
    expect(true).toBe(true);
  });
});
