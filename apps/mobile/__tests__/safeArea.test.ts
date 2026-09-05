/**
 * @jest-environment jsdom
 */

import { describe, expect, jest, test } from "@jest/globals";
import { act, createElement, type ComponentType, type ReactElement } from "react";
import type { ViewProps } from "react-native";
import { createRoot } from "react-dom/client";
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * No screen renders under the status bar, the Dynamic Island or the home
 * indicator. **Every route, not the one somebody photographed — and while it is
 * being scrolled, not only where it comes to rest.**
 *
 * ## The second bug, which the first version of this file could not see
 *
 * Every screen passed this guard and every screen was still broken. A
 * verification pass on a device found `r2` and `BUCKET` drawn at 10pt and 50pt
 * on `/console/@:slug/settings`, and body type at 7pt on a note — under the
 * clock and behind the Dynamic Island — the moment anything was scrolled.
 *
 * The cause is a distinction the first version did not make: **padding on a
 * scroller's content scrolls away with the content.** The whole inset was spent
 * there, so the first line cleared the notch, the twentieth did not, and a
 * checker reading the resting DOM saw a perfectly padded surface. That is "a
 * guard nobody has checked" in its purest form — it *was* checked, against the
 * only state it could see.
 *
 * So `surfacePadding` splits what a surface owes in two (`SurfacePadding` in
 * `features/app/frame.ts`): the system's band is held back **outside** the
 * scroller, where it shortens the viewport and survives a swipe, and our own
 * floating chrome stays on the content, where the first and last lines can
 * still be brought out from under it. `safeAreaComplaint` below is the resting
 * rule and `scrolledComplaint` is the new one, and the self-tests at the bottom
 * sabotage each separately — a screen written to fail only the second is the
 * one that proves this file learned anything.
 *
 * ## What went wrong first, and why a per-screen fix was not the answer
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
 * 3. **It tests itself.** `SABOTAGE` and `SABOTAGE_SCROLLED` below are screens
 *    written to be wrong in the exact two ways the app has been wrong — the
 *    first paying nothing at all, the second paying everything on the content
 *    where it scrolls away — and the last tests assert the checker rejects each.
 *    A checker nobody has watched fail is a checker that may only ever return
 *    true.
 *
 * ## What it cannot assert
 *
 * jsdom lays nothing out, so this is a render test. It resolves
 * react-native-web's injected stylesheet — which is what makes "this container
 * carries 47pt of top padding" a real assertion — but it cannot tell you the
 * result looks right. That was checked on an iPhone 16 Pro Max simulator; the
 * shots are under `docs/design/safe-area/`.
 *
 * **The scrolled rule is asserted structurally, and that is stated rather than
 * implied.** jsdom performs no layout, so `scrollTop` clamps to zero and no
 * amount of driving a scroll here moves a pixel. What each screen *is* scrolled
 * for is the half a render test can see: any state that reacts to scrolling —
 * a header that hides, chrome that changes height — runs before the checker
 * does. The geometric half is arithmetic on the DOM instead: content in a
 * scroll container can rise to the top of that container's padding box and is
 * clipped there, so the highest point content can reach is the scroller's own
 * offset down the glass, which is the sum of the padding on everything above it
 * that does not scroll. That number is what `scrolledComplaint` compares
 * against the notch, and it is a fact about the tree rather than a guess.
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
    useGlobalSearchParams: () => ({}),
    usePathname: () => "/",
    // What `(app)/_layout.tsx` carries into `?next=`: the href *with* its
    // query, which `usePathname` deliberately strips.
    useUnstableGlobalHref: () => "/",
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
const { AdminChrome } =
  require("../features/admin/AdminPane") as typeof import("../features/admin/AdminPane");
const { WelcomeChrome } =
  require("../features/onboarding/WelcomeScreen") as typeof import("../features/onboarding/WelcomeScreen");
const { CreateWorkspaceChrome } =
  require("../features/workspace/CreateWorkspaceScreen") as typeof import("../features/workspace/CreateWorkspaceScreen");
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
const { SAFE_AREA_MARK, Screen, ScreenScroll } =
  require("../features/app/Screen") as typeof import("../features/app/Screen");
const { NoteEditor } =
  require("../features/console/files/NoteEditor") as typeof import("../features/console/files/NoteEditor");
const { editorReducer, emptyEditor } =
  require("../features/console/files/editor") as typeof import("../features/console/files/editor");
const { layout } = require("../features/design/tokens") as typeof import("../features/design/tokens");
const { Text } = require("../features/design/components/Text") as typeof import("../features/design/components/Text");
const { ScrollView, View } = require("react-native") as typeof import("react-native");
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
  /** Not a screen: the root providers. The HTML shell is a static file. */
  | { kind: "shell" };

const ROUTES: Record<string, Coverage> = {
  "_layout.tsx": { kind: "shell" },

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
  /*
    `CreateWorkspaceChrome`, not `CreateWorkspaceScreen`, for the reason the
    welcome route above gives: the screen is a live controller over Convex
    subscriptions, and the chrome is the whole of what this route ever paints.
  */
  /*
    The flow's navigator. A `Stack` and a background colour, like every other
    nested layout here — the session gate is `(app)`'s and is not repeated.
  */
  "(app)/workspace/_layout.tsx": { kind: "shell" },
  "(app)/workspace/new.tsx": {
    kind: "screen",
    mount: () =>
      createElement(
        CreateWorkspaceChrome,
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
  /*
    The two halves of "a link that went nowhere", mounted as themselves rather
    than through `DeadLinkScreen`, because the whole reason these routes exist
    is that Expo Router's built-in Unmatched Route screen was what somebody
    following a `context://note/…` link actually saw — and that screen pays no
    insets at all. With `useLocalSearchParams` and `useGlobalSearchParams`
    mocked empty, neither route finds an address, so each renders the dead end
    that is the only thing it ever paints: a `Redirect` paints nothing.
  */
  "+not-found.tsx": { kind: "screen", mount: () => createElement(requireRoute("+not-found.tsx")) },
  "note/[...address].tsx": {
    kind: "screen",
    mount: () => createElement(requireRoute("note/[...address].tsx")),
  },

  "(auth)/_layout.tsx": { kind: "gate", mount: () => createElement(requireRoute("(auth)/_layout.tsx")) },
  /*
    A gate, and now also where the persistent recording bar is mounted — one
    bar, above every route in the section, because a recording has to be visible
    from wherever somebody is. The `gate` assertion is exactly the guard that
    keeps it honest: while nothing is recording the bar draws nothing, so this
    layout still paints no content of its own, and a bar that started painting a
    band unconditionally would be a strip over somebody's screen on every route
    under `(app)` — and this is the test that would say so.
  */
  "(app)/_layout.tsx": { kind: "gate", mount: () => createElement(requireRoute("(app)/_layout.tsx")) },
  "connect/_layout.tsx": { kind: "gate", mount: () => createElement(requireRoute("connect/_layout.tsx")) },
  "invite/_layout.tsx": { kind: "gate", mount: () => createElement(requireRoute("invite/_layout.tsx")) },
  "s/_layout.tsx": { kind: "gate", mount: () => createElement(requireRoute("s/_layout.tsx")) },
  "note/_layout.tsx": { kind: "gate", mount: () => createElement(requireRoute("note/_layout.tsx")) },

  /*
    The staff console. A screen rather than `framed`: it sits outside the
    console's rail and `AppFrame`, so nothing above it supplies the notch
    padding and `ScreenScroll` has to. `AdminChrome` is what is mounted here —
    `AdminPane` is a live Convex subscription from its first line, and the
    chrome is the whole of what the route ever paints, which is the reason
    `WelcomeChrome` is mounted above rather than `WelcomeScreen`.
  */
  "(app)/admin/_layout.tsx": {
    kind: "gate",
    mount: () => createElement(requireRoute("(app)/admin/_layout.tsx")),
  },
  "(app)/admin/index.tsx": {
    kind: "screen",
    mount: () =>
      createElement(
        AdminChrome,
        null,
        createElement(Text, null, "the staff console's content"),
      ),
  },

  /*
    Meeting capture. Three route files, and each is covered as itself rather
    than through a chrome component: none of them is a live controller from its
    first line — the meetings state is an external store
    (`features/meetings/controller.ts`), which answers "nothing configured"
    without a session or a Convex deployment, so the routes mount here exactly
    as they do on a phone.

    The layout no longer mounts the recording bar: one bar for the whole app
    lives in `(app)/_layout.tsx`, above every route rather than above the
    meetings section only, and two mounts would draw two bars over each other
    here. It stays a `gate` rather than a `shell` because that is what it is —
    a `Stack` and a background colour — and the `gate` assertion still keeps it
    drawing no content of its own.
  */
  "(app)/meetings/_layout.tsx": {
    kind: "gate",
    mount: () => createElement(requireRoute("(app)/meetings/_layout.tsx")),
  },
  "(app)/meetings/index.tsx": {
    kind: "screen",
    mount: () => createElement(requireRoute("(app)/meetings/index.tsx")),
  },
  /*
    With `useLocalSearchParams` mocked empty there is no id at all, so this
    renders the dead-link answer — the same thing `note/[...address].tsx` is
    mounted for here, and the only thing this route paints with no recording
    behind it. (It is deliberately *not* the "not on this device" line: that one
    is a claim about the store, and the store has not been read.)
  */
  "(app)/meetings/[id].tsx": {
    kind: "screen",
    mount: () => createElement(requireRoute("(app)/meetings/[id].tsx")),
  },

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

/** Whether this element can scroll its own overflow. */
function scrolls(node: Element): boolean {
  const overflowY = window.getComputedStyle(node).overflowY;
  return overflowY === "auto" || overflowY === "scroll";
}

function ownPadding(node: Element): { top: number; bottom: number } {
  const style = window.getComputedStyle(node);
  return { top: px(style.paddingTop), bottom: px(style.paddingBottom) };
}

/** Every element between this one and the container, nearest first. */
function ancestorsOf(node: Element, container: Element): Element[] {
  const chain: Element[] = [];
  let current = node.parentElement;
  while (current !== null && current !== container) {
    chain.push(current);
    current = current.parentElement;
  }
  return chain;
}

/**
 * The distance from the top of a surface to its first line, at rest.
 *
 * A `ScreenScroll` is now two boxes rather than one: the marked `View` carries
 * the system's band, and the `ScrollView` inside it carries our chrome on its
 * content container. Both count towards where the first line lands, so the
 * spine is walked — but only *through a scroller*, which is what stops this
 * quietly crediting a surface with the padding of whatever happens to be its
 * first child.
 */
function paddingOf(element: Element): { top: number; bottom: number } {
  const total = ownPadding(element);
  const scroller = element.firstElementChild;
  if (scroller === null || !scrolls(scroller)) return total;
  for (const node of [scroller, scroller.firstElementChild]) {
    if (!(node instanceof Element)) continue;
    const padding = ownPadding(node);
    total.top += padding.top;
    total.bottom += padding.bottom;
  }
  return total;
}

/**
 * How far down the glass a scroller's viewport begins.
 *
 * **Only what is outside it counts.** Content inside a scroll container is
 * clipped at that container's padding box, so it can ride up to exactly this
 * point and no further — which makes this the highest position any word on the
 * screen can reach, and the only number the notch can be compared against once
 * somebody has swiped. Padding on the scroller's own `style` does not count
 * either, and that is not an oversight: a scroll container's content scrolls
 * *into* its padding-top band and is clipped at the border box, so a
 * `paddingTop` there buys a resting offset and nothing else.
 */
function viewportTopOf(scroller: Element, container: Element): number {
  return ancestorsOf(scroller, container).reduce((total, node) => {
    const style = window.getComputedStyle(node);
    return total + px(style.paddingTop) + px(style.marginTop) + px(style.borderTopWidth);
  }, 0);
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

/**
 * Why a mounted tree fails **once it has been scrolled**, or `null`.
 *
 * The rule is one sentence: every scroller on the screen must begin at least
 * the system's top inset below the top of the glass, counting only the padding
 * on things above it that do not themselves scroll. Anything paid inside the
 * scroller buys the resting position and nothing else.
 *
 * A scroller nested inside another is skipped rather than checked, and that is
 * correct rather than lenient: it is clipped to the outer one's viewport, so
 * the outer one already owns this edge and checking the inner would demand the
 * inset twice.
 */
function scrolledComplaint(container: HTMLElement): string | null {
  const scrollers = Array.from(container.querySelectorAll("*")).filter(scrolls);
  for (const scroller of scrollers) {
    if (ancestorsOf(scroller, container).some(scrolls)) continue;
    const held = viewportTopOf(scroller, container);
    if (held < INSETS.top) {
      return (
        `a scroller begins ${held}pt down the glass, so its content rides up under the ` +
        `${INSETS.top}pt notch as soon as anybody scrolls — the inset has to be held back ` +
        `outside the scroller, not paid on its content`
      );
    }
  }
  return null;
}

/**
 * Scroll everything on the screen, as far as it will go.
 *
 * jsdom lays nothing out, so `scrollTop` clamps to zero and this moves nothing
 * — the geometry is `scrolledComplaint`'s job and it is arithmetic, not
 * measurement. What this *does* exercise is any state that reacts to scrolling:
 * a header that collapses, chrome that changes height, a surface that repays
 * its insets on scroll. A screen that only clears the notch while it is at rest
 * has to be given the chance to prove it.
 */
function scrollEverything(container: HTMLElement): void {
  const scrollers = Array.from(container.querySelectorAll("*")).filter(scrolls);
  act(() => {
    for (const scroller of scrollers) {
      scroller.scrollTop = 10_000;
      scroller.dispatchEvent(new Event("scroll", { bubbles: true }));
    }
  });
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
      // The half a device found and this file could not: at rest every one of
      // these was already green.
      expect(scrolledComplaint(mounted.container)).toBeNull();
      scrollEverything(mounted.container);
      expect(safeAreaComplaint(mounted.container)).toBeNull();
      expect(scrolledComplaint(mounted.container)).toBeNull();
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
      /*
        And the split: of that sum, the notch's share is the part outside the
        scroller. This is the assertion the settings screen would have failed on
        a device while passing the line above — `BUCKET` at 50pt, on the clock's
        line, once anybody scrolled.
      */
      const scroller = mounted.container.querySelector('[data-safe-area="content"]');
      expect(scroller).not.toBeNull();
      expect(viewportTopOf(scroller as Element, mounted.container)).toBeGreaterThanOrEqual(
        INSETS.top,
      );
      expect(scrolledComplaint(mounted.container)).toBeNull();
      scrollEverything(mounted.container);
      expect(scrolledComplaint(mounted.container)).toBeNull();
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
      expect(scrolledComplaint(mounted.container)).toBeNull();
    } finally {
      mounted.unmount();
    }
  });

  /**
   * The note, which builds its own `ScrollView` and therefore carries no mark.
   *
   * `NoteAccessory` rides above the keyboard by being absolutely positioned at
   * the bottom of the region, so it has to be a *sibling* of the scroller
   * rather than inside it — which is why `NoteEditor` cannot be a
   * `ScreenScroll`. A surface exempt from the marker is not a surface exempt
   * from the rule, so it is mounted here and held to both halves of it.
   *
   * The bottom assertion is the second thing the verification pass found: a
   * long note's last lines rendered behind the floating toolbar, so the
   * scroller's content has to reserve the pill's height plus the gaps either
   * side of it — `contentInsets.bottom`, spent where it can be scrolled clear.
   */
  test("a note reserves the notch outside its scroller and the toolbar inside it", () => {
    const opened = editorReducer(emptyEditor, {
      type: "opened",
      note: {
        path: "1-projects/pilot.md",
        text: "# Pilot\n",
        etag: "e1",
        visibility: "private",
        inherited: "private",
        exception: false,
        readOnly: false,
      },
    });
    const mounted = mount(
      createElement(AppFrame, {
        switcher: null,
        rail: () => null,
        // A toolbar has to exist for the frame to reserve room for one.
        bottomBar: createElement(Text, null, "toolbar"),
        children: createElement(NoteEditor, {
          state: opened,
          canEdit: true,
          onChange: () => {},
          onSave: () => {},
          onDiscard: () => {},
          onUseTheirs: () => {},
          onKeepMine: () => {},
        }),
      }),
    );
    try {
      const scroller = mounted.container.querySelector('[data-testid="note-scroll"]');
      expect(scroller).not.toBeNull();
      expect(viewportTopOf(scroller as Element, mounted.container)).toBeGreaterThanOrEqual(
        INSETS.top,
      );
      const content = (scroller as Element).firstElementChild as Element;
      expect(px(window.getComputedStyle(content).paddingBottom)).toBeGreaterThanOrEqual(
        layout.bottomBarHeight + layout.floatingInset,
      );
      expect(scrolledComplaint(mounted.container)).toBeNull();
      scrollEverything(mounted.container);
      expect(scrolledComplaint(mounted.container)).toBeNull();
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

  test("rejects a surface whose content padding was overwritten", () => {
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
      // The notch survives — it is held back outside the scroller and a
      // `contentContainerStyle` cannot reach it, which is the point of the
      // split. The home indicator does not: it is content padding, and this is
      // what overwriting it costs.
      expect(safeAreaComplaint(mounted.container)).toMatch(/under the 34pt home indicator/);
    } finally {
      mounted.unmount();
    }
  });

  /**
   * **The bug this file was extended for**, written out as a screen.
   *
   * A marked surface that pays the whole inset on its scroller's content
   * container — which is exactly what `ScreenScroll` used to be, and what every
   * route in the app was doing when a device found text under the Dynamic
   * Island. It is *correct at rest*: `safeAreaComplaint` passes it, and that
   * assertion is here rather than left implied, because "the resting checker
   * still says yes" is the whole reason the second checker had to exist.
   */
  const SABOTAGE_SCROLLED = () =>
    createElement(
      View,
      /*
        `dataSet` is react-native-web's, not React Native's, so it typechecks
        through JSX in `Screen.tsx` and not through `createElement` here. The
        cast is the same escape hatch that file's own `SAFE_AREA_MARK` is.
      */
      SAFE_AREA_MARK as unknown as ViewProps,
      createElement(ScrollView, {
        contentContainerStyle: { paddingTop: INSETS.top, paddingBottom: INSETS.bottom },
        children: createElement(Text, null, "the body"),
      }),
    );

  test("rejects a screen that pays the notch where it scrolls away", () => {
    const mounted = mount(createElement(SABOTAGE_SCROLLED));
    try {
      expect(safeAreaComplaint(mounted.container)).toBeNull();
      expect(scrolledComplaint(mounted.container)).toMatch(/rides up under the 47pt notch/);
      scrollEverything(mounted.container);
      expect(scrolledComplaint(mounted.container)).toMatch(/rides up under the 47pt notch/);
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
      expect(scrolledComplaint(mounted.container)).toBeNull();
    } finally {
      mounted.unmount();
    }
  });

  test("accepts the scrolling primitive used as intended", () => {
    const mounted = mount(
      createElement(ScreenScroll, { children: createElement(Text, null, "the body") }),
    );
    try {
      expect(safeAreaComplaint(mounted.container)).toBeNull();
      expect(scrolledComplaint(mounted.container)).toBeNull();
      scrollEverything(mounted.container);
      expect(scrolledComplaint(mounted.container)).toBeNull();
    } finally {
      mounted.unmount();
    }
  });
});
