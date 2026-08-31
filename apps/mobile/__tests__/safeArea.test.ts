/**
 * @jest-environment jsdom
 */

import { describe, expect, jest, test } from "@jest/globals";
import { act, createElement, type ComponentType, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * No screen renders under the status bar, the Dynamic Island or the home
 * indicator. **Every route, not the one somebody photographed.**
 *
 * ## What went wrong, and why a per-screen fix was not the answer
 *
 * The context settings screen drew "@seyi settings" on the same line as the
 * clock, with the Connected pill and Done behind the notch. It was not a
 * settings bug: five files in the whole app touched `useSafeAreaInsets` against
 * thirteen routes, so *every* screen that did not happen to go through
 * `AppFrame` was exposed — the share viewer worst of all, with no wrap at all
 * and its card flush to the top of the glass. Fixing the screenshot would have
 * left seven others waiting to be noticed one at a time.
 *
 * So the fix is a primitive — `features/app/Screen.tsx`, over `surfacePadding`
 * in `features/app/frame.ts` — and this is the guard that keeps it used.
 *
 * ## What makes this a guard rather than a smoke test
 *
 * Three things, and each answers one of the ways the guards in this repo have
 * turned out to be weaker than they looked (see CLAUDE.md, "A guard nobody has
 * checked is not a guard"):
 *
 * 1. **It enumerates the route files from disk.** A new route under `app/` that
 *    nobody classified fails the first test, so the guard cannot silently stop
 *    covering the app as the app grows. That is the failure mode of a guard
 *    that greps for export names.
 * 2. **It reads the rendered DOM, not the source.** A screen passes by *drawing*
 *    a padded surface with every word of its content inside it, which no
 *    comment, import or prose can fake. That is the failure mode of an import
 *    guard that read English as code.
 * 3. **It tests itself.** `SABOTAGE` below is a screen written to be wrong in
 *    the exact way the settings screen was, and the last test asserts the
 *    checker rejects it. A checker nobody has watched fail is a checker that may
 *    only ever return true.
 *
 * ## What it cannot assert
 *
 * jsdom lays nothing out, so this is a render test. It resolves
 * react-native-web's injected stylesheet — which is what makes "this container
 * carries 47pt of top padding" a real assertion — but it cannot tell you the
 * result looks right. That was checked on an iPhone 16 Pro Max simulator; the
 * shots are under `docs/design/safe-area/`.
 */

/* -------------------------------------------------------------------------- */
/*                                   mocks                                    */
/* -------------------------------------------------------------------------- */

/** A notched phone. Every assertion below is against these two numbers. */
const INSETS = { top: 47, bottom: 34, left: 0, right: 0 };

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));

jest.mock("expo-router", () => {
  const { createElement: h } = require("react") as typeof import("react");
  return {
    Redirect: ({ href }: { href: string }) =>
      h("div", { "data-testid": "redirect", "data-href": href }),
    // A navigator renders its screens through the router, which is not mounted
    // here. Rendering nothing is what makes "a layout draws no content of its
    // own" an assertion about the layout rather than about its children.
    Stack: () => null,
    Slot: () => null,
    Link: ({ children }: { children?: unknown }) => h("div", null, children as never),
    useRouter: () => ({ replace: () => {}, push: () => {}, back: () => {} }),
    useLocalSearchParams: () => ({}),
    usePathname: () => "/",
  };
});

jest.mock("convex/react", () => {
  const actual = jest.requireActual("convex/react") as Record<string, unknown>;
  return {
    ...actual,
    useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
    useAction: () => async () => ({}),
    useMutation: () => async () => ({}),
    useQuery: () => undefined,
    useQueries: () => ({}),
  };
});

jest.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({ signIn: async () => {}, signOut: async () => {} }),
}));

/* eslint-disable @typescript-eslint/no-require-imports */
const { LoginScreen } = require("../features/auth/LoginScreen") as typeof import("../features/auth/LoginScreen");
const { ConsentScreen } =
  require("../features/consent/ConsentScreen") as typeof import("../features/consent/ConsentScreen");
const { WelcomeChrome } =
  require("../features/onboarding/WelcomeScreen") as typeof import("../features/onboarding/WelcomeScreen");
const { InviteScreen } =
  require("../features/invite/InviteScreen") as typeof import("../features/invite/InviteScreen");
const { InviteListScreen } =
  require("../features/invite/InviteListScreen") as typeof import("../features/invite/InviteListScreen");
const { ShareScreen } = require("../features/share/ShareScreen") as typeof import("../features/share/ShareScreen");
const { DropboxCallbackScreen } =
  require("../features/console/storage/DropboxCallbackScreen") as typeof import("../features/console/storage/DropboxCallbackScreen");
const { EditorRegion } =
  require("../features/console/EditorRegion") as typeof import("../features/console/EditorRegion");
const { AppFrame } = require("../features/app/AppFrame") as typeof import("../features/app/AppFrame");
const { Screen, ScreenScroll } = require("../features/app/Screen") as typeof import("../features/app/Screen");
const { Text } = require("../features/design/components/Text") as typeof import("../features/design/components/Text");
const { View } = require("react-native") as typeof import("react-native");
/* eslint-enable @typescript-eslint/no-require-imports */

/* -------------------------------------------------------------------------- */
/*                              the route census                              */
/* -------------------------------------------------------------------------- */

/**
 * How a route file is covered. Every `.tsx` under `app/` must name one, and the
 * first test is what makes that true of files added later.
 */
type Coverage =
  /** Mounted below, and checked for a padded surface around all of its text. */
  | { kind: "screen"; mount: () => ReactElement }
  /**
   * A navigator or a gate: it renders a `Stack`, a `Redirect` or nothing, and
   * has no content of its own. Mounted anyway, and asserted to draw no text —
   * so a banner added to a layout turns this red rather than shipping a band
   * across the notch.
   */
  | { kind: "gate"; mount: () => ReactElement }
  /**
   * Content that reaches the glass through `AppFrame` and `EditorRegion`,
   * covered by the two `region` tests below rather than by mounting the whole
   * console with its Convex subscriptions.
   */
  | { kind: "framed" }
  /** Not a screen: the root providers, and the build-time HTML shell. */
  | { kind: "shell" };

const ROUTES: Record<string, Coverage> = {
  "_layout.tsx": { kind: "shell" },
  "+html.tsx": { kind: "shell" },

  /*
    The route module, not `Landing` — jest renders through react-native-web, so
    `resolveRootRoute` answers "render" here exactly as a browser would, and the
    landing page is what this mounts. On a phone the same route redirects and
    paints nothing; that half is `authRedirect.test.ts`'s.
  */
  "index.tsx": { kind: "screen", mount: () => createElement(requireRoute("index.tsx")) },
  "authorize.tsx": { kind: "screen", mount: () => createElement(ConsentScreen) },
  "(auth)/login.tsx": { kind: "screen", mount: () => createElement(LoginScreen) },
  /*
    `WelcomeChrome`, not `WelcomeScreen`. The screen is a gate over a live
    onboarding controller and renders a blank `View` until it resolves, so
    mounting it here would assert nothing about a page nobody had drawn. The
    chrome is the whole of what this route ever paints, and it is exported for
    exactly this reason — "so the chrome can be rendered, and looked at, without
    a session or a Convex deployment behind it".
  */
  "(app)/welcome.tsx": {
    kind: "screen",
    mount: () =>
      createElement(
        WelcomeChrome,
        {
          step: "name",
          shape: { storage: "connected" },
          children: createElement(Text, null, "the step's card"),
        },
      ),
  },
  "invite/index.tsx": { kind: "screen", mount: () => createElement(InviteListScreen) },
  "invite/[token].tsx": { kind: "screen", mount: () => createElement(InviteScreen) },
  "s/[token].tsx": { kind: "screen", mount: () => createElement(ShareScreen) },
  "connect/dropbox.tsx": { kind: "screen", mount: () => createElement(DropboxCallbackScreen) },

  "(auth)/_layout.tsx": { kind: "gate", mount: () => createElement(requireRoute("(auth)/_layout.tsx")) },
  "(app)/_layout.tsx": { kind: "gate", mount: () => createElement(requireRoute("(app)/_layout.tsx")) },
  "connect/_layout.tsx": { kind: "gate", mount: () => createElement(requireRoute("connect/_layout.tsx")) },
  "invite/_layout.tsx": { kind: "gate", mount: () => createElement(requireRoute("invite/_layout.tsx")) },
  "s/_layout.tsx": { kind: "gate", mount: () => createElement(requireRoute("s/_layout.tsx")) },

  "(app)/console/_layout.tsx": { kind: "framed" },
  "(app)/console/index.tsx": { kind: "framed" },
  "(app)/console/map.tsx": { kind: "framed" },
  "(app)/console/connections.tsx": { kind: "framed" },
  "(app)/console/[slug]/index.tsx": { kind: "framed" },
  "(app)/console/[slug]/settings.tsx": { kind: "framed" },
};

const APP_DIR = join(__dirname, "..", "app");

function routeFiles(dir: string = APP_DIR): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) return routeFiles(full);
    return entry.name.endsWith(".tsx") ? [relative(APP_DIR, full)] : [];
  });
}

function requireRoute(route: string): ComponentType {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return (require(join(APP_DIR, route)) as { default: ComponentType }).default;
}

/* -------------------------------------------------------------------------- */
/*                                the checker                                 */
/* -------------------------------------------------------------------------- */

interface Mounted {
  container: HTMLElement;
  unmount: () => void;
}

/**
 * Mount at 390pt, which is a phone — the density where the frame stops padding
 * itself and every one of these bugs lives.
 *
 * react-native-web's `Dimensions` measures `document.documentElement
 * .clientWidth`, and **jsdom reports 0** because it performs no layout. Left
 * unstubbed every mount lands in the compact branch for entirely the wrong
 * reason. See `appFrameRender.test.ts`, which found this first.
 */
function mount(element: ReactElement, width = 390): Mounted {
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
  const root = createRoot(container);
  act(() => root.render(element));
  return {
    container,
    unmount: () => {
      /*
        `AccessibilityInfo.addEventListener` returns `undefined` under
        react-native-web in jsdom, so `useReducedMotion`'s cleanup throws on the
        way out of the landing page. That is a teardown artifact of the
        environment and not a claim about the screen, and swallowing it here
        keeps a real assertion from being reported as a crash in a `finally`.
      */
      try {
        act(() => root.unmount());
      } catch {
        /* see above */
      }
      container.remove();
    },
  };
}

function px(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * The padding a surface actually carries, at each edge.
 *
 * A `ScreenScroll` is a react-native-web `ScrollView`: the mark lands on the
 * outer element and the padding on the **content container**, which is the
 * child inside it. So both are read and the larger taken, rather than the
 * checker quietly reporting zero for every scrolling screen — which is the
 * shape of vacuous pass this file's third test exists to rule out.
 */
function paddingOf(element: Element): { top: number; bottom: number } {
  const candidates = [element, element.firstElementChild].filter(
    (node): node is Element => node instanceof Element,
  );
  const read = candidates.map((node) => {
    const style = window.getComputedStyle(node);
    return { top: px(style.paddingTop), bottom: px(style.paddingBottom) };
  });
  return {
    top: Math.max(...read.map((r) => r.top)),
    bottom: Math.max(...read.map((r) => r.bottom)),
  };
}

/** Every element that carries text of its own, rather than through a child. */
function textCarriers(container: HTMLElement): Element[] {
  return Array.from(container.querySelectorAll("*")).filter(
    (node) => node.children.length === 0 && (node.textContent ?? "").trim() !== "",
  );
}

/**
 * Why a mounted tree fails, or `null`.
 *
 * A string rather than a boolean so a failure names the screen's actual defect
 * instead of `expected true, got false` — and so the self-test at the bottom
 * can assert *which* rule the sabotaged screen broke.
 */
function safeAreaComplaint(container: HTMLElement): string | null {
  const surfaces = Array.from(container.querySelectorAll('[data-safe-area="surface"]'));
  if (surfaces.length === 0) {
    return "nothing on this screen goes through Screen/ScreenScroll — its content is laid out under the status bar";
  }

  const stray = textCarriers(container).filter(
    (node) => !surfaces.some((surface) => surface.contains(node)),
  );
  if (stray.length > 0) {
    return `text renders outside every padded surface: ${stray
      .slice(0, 3)
      .map((node) => JSON.stringify((node.textContent ?? "").trim().slice(0, 40)))
      .join(", ")}`;
  }

  // The outermost surface is the one that owes the system's insets; a nested
  // one is inside a parent that has already paid them.
  const outermost = surfaces.filter(
    (surface) => !surfaces.some((other) => other !== surface && other.contains(surface)),
  );
  for (const surface of outermost) {
    const padding = paddingOf(surface);
    if (padding.top < INSETS.top) {
      return `a surface carries ${padding.top}pt of top padding, under the ${INSETS.top}pt notch`;
    }
    if (padding.bottom < INSETS.bottom) {
      return `a surface carries ${padding.bottom}pt of bottom padding, under the ${INSETS.bottom}pt home indicator`;
    }
  }
  return null;
}

/* -------------------------------------------------------------------------- */

describe("the route census", () => {
  test("every route file under app/ says how it is covered", () => {
    // Sorted so a failure reads as a diff of two lists rather than as a set.
    expect(routeFiles().sort()).toEqual(Object.keys(ROUTES).sort());
  });
});

describe("no screen lays itself out under the system's furniture", () => {
  const screens = Object.entries(ROUTES).filter(
    (entry): entry is [string, Extract<Coverage, { kind: "screen" }>] =>
      entry[1].kind === "screen",
  );

  test.each(screens)("%s", (_route, coverage) => {
    const mounted = mount(coverage.mount());
    try {
      // A screen that painted nothing would pass every rule below without
      // being covered by any of them, which is the vacuous green this repo
      // keeps producing. So: it has to have drawn something first.
      expect(textCarriers(mounted.container).length).toBeGreaterThan(0);
      expect(safeAreaComplaint(mounted.container)).toBeNull();
    } finally {
      mounted.unmount();
    }
  });
});

describe("a navigator draws no content of its own", () => {
  const gates = Object.entries(ROUTES).filter(
    (entry): entry is [string, Extract<Coverage, { kind: "gate" }>] => entry[1].kind === "gate",
  );

  /*
    These five layouts exist to answer an auth question and hand off to a
    `Stack`. If one grows a header, a banner or an error line, that content
    reaches the top of the glass with nothing under it — so the moment a layout
    draws a word, this goes red and points at `Screen`.
  */
  test.each(gates)("%s", (_route, coverage) => {
    const mounted = mount(coverage.mount());
    try {
      expect((mounted.container.textContent ?? "").trim()).toBe("");
    } finally {
      mounted.unmount();
    }
  });
});

describe("the console's panes, through the frame that carries them", () => {
  /**
   * Map, Connections and Settings — the three that were broken.
   *
   * Mounted as the real `EditorRegion` inside the real `AppFrame` at 390pt,
   * because the bug was in the seam between them: the frame deliberately does
   * not pad itself at compact and floats its bars over a full-bleed document,
   * and the region was paying nothing for it.
   */
  test("a document pane clears the notch and the floating toggle", () => {
    const mounted = mount(
      createElement(
        AppFrame,
        {
          switcher: null,
          rail: () => null,
          children: createElement(
            EditorRegion,
            {
              browse: false,
              failure: null,
              tabs: null,
              onCloseTab: () => {},
              phone: true,
              children: createElement(Text, null, "@seyi settings"),
            },
          ),
        },
      ),
    );
    try {
      const surface = mounted.container.querySelector('[data-safe-area="surface"]');
      expect(surface).not.toBeNull();
      const padding = paddingOf(surface as Element);
      // The notch *plus* the floating chrome over it: `insets.top` (47), the
      // 44pt round toggle and 12pt of air. Content passes under the toggle;
      // the first line is what has to clear it.
      expect(padding.top).toBeGreaterThanOrEqual(INSETS.top + 44 + 12);
      expect(padding.bottom).toBeGreaterThanOrEqual(INSETS.bottom);
    } finally {
      mounted.unmount();
    }
  });

  /**
   * Browse owns its own scroller and does not get the mark, because
   * `NoteAccessory` has to be a sibling of that scroller rather than inside it.
   * It spends the same number through `useSurfacePadding`, which is what this
   * checks — a pane exempt from the marker is not a pane exempt from the rule.
   */
  test("a pane with its own scroller spends the same number", () => {
    const Probe = () =>
      createElement(
        ScreenScroll,
        { testID: "probe", children: createElement(Text, null, "the note") },
      );
    const mounted = mount(
      createElement(AppFrame, {
        switcher: null,
        rail: () => null,
        children: createElement(Probe),
      }),
    );
    try {
      const surface = mounted.container.querySelector('[data-safe-area="surface"]');
      expect(paddingOf(surface as Element).top).toBeGreaterThanOrEqual(INSETS.top);
    } finally {
      mounted.unmount();
    }
  });
});

/* -------------------------------------------------------------------------- */

describe("the checker itself", () => {
  /**
   * The settings screen as it was: a scroller with a flat 12pt of top padding
   * and no inset, which is what put "@seyi settings" on the clock's line.
   *
   * Kept in the suite rather than reverted by hand once, because a checker
   * proved by a sabotage run somebody did in July is a checker nobody has
   * proved since.
   */
  const SABOTAGE = () =>
    createElement(
      View,
      { style: { paddingTop: 12 } },
      createElement(Text, null, "@seyi settings"),
    );

  test("rejects a screen that pays nothing", () => {
    const mounted = mount(createElement(SABOTAGE));
    try {
      expect(safeAreaComplaint(mounted.container)).toMatch(/under the status bar/);
    } finally {
      mounted.unmount();
    }
  });

  test("rejects a padded surface with content escaping above it", () => {
    const Escaped = () =>
      createElement(
        View,
        null,
        createElement(Text, null, "a title pinned above the padding"),
        createElement(Screen, null, createElement(Text, null, "the body")),
      );
    const mounted = mount(createElement(Escaped));
    try {
      expect(safeAreaComplaint(mounted.container)).toMatch(/text renders outside/);
    } finally {
      mounted.unmount();
    }
  });

  test("rejects a surface whose padding was overwritten", () => {
    const Overwritten = () =>
      createElement(
        ScreenScroll,
        {
          contentContainerStyle: { paddingTop: 0, paddingBottom: 0 },
          children: createElement(Text, null, "the body"),
        },
      );
    const mounted = mount(createElement(Overwritten));
    try {
      expect(safeAreaComplaint(mounted.container)).toMatch(/under the 47pt notch/);
    } finally {
      mounted.unmount();
    }
  });

  test("accepts the primitive used as intended", () => {
    const mounted = mount(
      createElement(Screen, null, createElement(Text, null, "the body")),
    );
    try {
      expect(safeAreaComplaint(mounted.container)).toBeNull();
    } finally {
      mounted.unmount();
    }
  });
});
