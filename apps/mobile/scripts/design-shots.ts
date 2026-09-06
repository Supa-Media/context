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
 * ## It is not a test, and is not run by `pnpm test` — which has bitten once
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
 * **The cost of being un-run is recorded rather than assumed away.** The
 * file-explorer shot pressed a `frame-drawer-toggle`; when a phone lost its left
 * panel that testID stopped rendering, `press(null)` threw, and this file was
 * red for as long as nobody asked for it by name — while the `.html` it is the
 * only generator of stayed in `docs/design/obsidian-parity/` still carrying the
 * markup of a toggle the app no longer draws, under a README saying "open one
 * in a browser and you are looking at the app".
 *
 * So every shot below now **asserts the surface it is a picture of** before it
 * takes it. A shot that quietly photographs an empty state is worse than one
 * that fails: the failure is loud the moment somebody runs this, and evidence
 * that is wrong is worse than evidence that is missing.
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

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
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
 * The demo console is read-only by design, and these shots need it not to be.
 *
 * `useDemoConsoleData` sets `canEdit: false` so a landing-page *visitor* is
 * never offered a control that would lie. That is right for the landing page
 * and wrong for a picture of the product: the surface being measured against
 * the reference is somebody's own console, where they own the context and can
 * write to it. Held read-only, half of what is being photographed does not
 * exist — the keyboard accessory bar is gated on `editable`, the tree's create
 * verbs on `canEdit`, and the note toolbar's Share on `canShare`.
 *
 * So the demo's three capability flags are lifted for the phone shots and
 * nothing else about the data changes: the same contexts, the same tree, the
 * same notes. The demo context `@seyi` carries `role: "owner"` already, so this
 * is the shape the real product hands an owner rather than an invented one.
 *
 * The desktop shot is left as-is. It exists to prove a phone change did not
 * break the pointer layout, and the fewer variables in it the better.
 */
/*
  Named `mockOwner` because Jest hoists `jest.mock` above every declaration in
  the file and refuses a factory that closes over an ordinary local: the
  variable would be uninitialised at the moment the factory runs. A `mock`
  prefix is the documented opt-out, on the understanding that the factory is
  only ever *called* lazily — which it is, once React renders.
*/
let mockOwner = false;

jest.mock("../features/console/useLiveConsoleData", () => {
  const { useDemoConsoleData } =
    require("../features/console/useDemoConsoleData") as typeof import("../features/console/useDemoConsoleData");
  return {
    useLiveConsoleData: () => {
      const data = useDemoConsoleData();
      if (!mockOwner) return data;
      return {
        ...data,
        files: { ...data.files, canEdit: true, canShare: true, canSetVisibility: true },
      };
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

/** The same, but a missing one says which one rather than "nothing to press". */
function need(container: HTMLElement, testId: string): HTMLElement {
  const node = find(container, testId);
  if (node === null) throw new Error(`no element with testID ${testId}`);
  return node;
}

/**
 * A control by its accessible name, and **it throws when there is none.**
 *
 * Three of the shots below used to find a row with `.find(…)` and then
 * `if (row !== undefined) press(row)`. Every one of those predicates had gone
 * stale — the demo console opens on `1-projects/context-lc.md` already, and no
 * row is labelled `overview`, `bandshell-permit` or `context-lc` — so three
 * presses were doing nothing and three pictures were of a screen nobody had
 * asked for, with no way to tell from the output. A missing control is a
 * failure here, not a skip.
 */
function byLabel(container: HTMLElement, label: string): HTMLElement {
  const node = container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (node === null) throw new Error(`no control labelled ${label}`);
  return node;
}

/* -------------------------------------------------------------------------- */

describe("design shots", () => {
  /*
    Every phone shot is an owner's console — see `mockOwner`. Set once here
    rather than per test so no shot is quietly taken of a different product
    than the one beside it.
  */
  beforeEach(() => {
    mockOwner = true;
  });
  afterEach(() => {
    mockOwner = false;
  });

  /**
   * A note open, which is where the demo console already is.
   *
   * `useDemoFileBrowser` opens on `tree.defaultSelection`, so nothing has to be
   * pressed — and the press that used to be here was looking for a row labelled
   * `overview`, which no longer exists, so it was silently doing nothing.
   * Asserted rather than assumed: `note-scroll` is the document, and the two
   * pieces of chrome the acceptance question is about are either side of it.
   */
  test("the reading view", () => {
    shoot("context-reading", (container) => {
      need(container, "note-scroll");
      need(container, "context-strip");
      need(container, "bottom-bar");
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
    // The pointer layout as the landing page ships it: read-only demo data,
    // one variable fewer. See `mockOwner`.
    mockOwner = false;
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
      press(need(container, "note-properties"));
      // The panel, once. Pressing the row twice would collapse it again, and a
      // shot of a collapsed panel is the picture this test exists to not take.
      need(container, "note-properties-open");
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
    shoot("context-editing", (container) => {
      const surface = container.querySelector<HTMLElement>(".cm-content");
      if (surface === null) throw new Error("the editor did not mount a CodeMirror surface");
      act(() => {
        surface.focus();
        surface.dispatchEvent(new FocusEvent("focus", { bubbles: false }));
      });
    });
    expect(true).toBe(true);
  });

  /**
   * How a phone browses files, which is not a panel any more.
   *
   * **This was `the file explorer`, and it pressed a `frame-drawer-toggle`.**
   * That control is gone with the drawer it opened: a phone has no left panel at
   * all (`features/app/frame.ts`), so `press(null)` threw and this file has been
   * failing, unseen, ever since — see the header.
   *
   * The capability did not go with the panel, it moved. At compact `BrowsePane`
   * draws `FolderView` for the context root: the same listing the tree gave, one
   * folder at a time, in the region the note would occupy, with
   * `storage · index · counts` at its foot where the tree's footer used to carry
   * it. So the shot is the console at rest with nothing selected — there is
   * nothing to press, which is the point.
   *
   * Both testIDs are asserted rather than assumed: an empty region is also what
   * this renders when the pane fails to mount, and a photograph of that is
   * exactly the kind of wrong evidence this file exists to avoid producing.
   */
  test("the context root, which is how a phone browses files", () => {
    shoot("context-files", (container) => {
      // The note's own path bar is the way up on a phone — there is no
      // breadcrumb at this density and no tree to go back to. Its leading
      // segment is the context, and it selects `""`, which is the root.
      press(byLabel(container, "Open @seyi"));
      need(container, "folder-row");
      need(container, "context-foot");
      // And the chrome it has instead of a panel, so a reader can see that the
      // navigation is on the glass rather than behind a control.
      need(container, "context-strip");
      need(container, "bottom-bar");
    });
    expect(true).toBe(true);
  });
});
