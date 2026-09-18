/**
 * @jest-environment jsdom
 */

/**
 * Screenshots for the shell title band — `docs/decisions/desktop.md`, "The
 * console reserves the space" and, for the pass that moved it into the bar,
 * "The band moves into the bar".
 *
 * Same technique as `design-shots.ts`: real components, rendered by
 * react-dom exactly as react-native-web renders them for a browser, written
 * out as self-contained `.html` and photographed by Playwright at a fixed
 * size. See that file's header for why this is a Jest file rather than a
 * standalone script, and for why it is **not** run by `pnpm test`
 * (`jest.config.js` only matches `__tests__/`):
 *
 *     pnpm exec jest --testMatch '**\/scripts/shell-band-shots.ts' --testPathIgnorePatterns '[]'
 *
 * ## What is faithful here and what is a stand-in
 *
 * `ShellTitleBand` and `ConsoleLayout` are the shipped components, mounted
 * the same way `design-shots.ts` already mounts the console (demo data, a
 * mocked router). The band's own defect and fix live entirely in
 * `ShellTitleBand.tsx` and in *where* `app/_layout.tsx` mounts it, and this
 * file's `Ground` wrapper reproduces that structure — a band, then a flexed
 * region below it — because `AppGround` itself is a private, unexported
 * function of that route file. It is not re-implemented logic, it is the same
 * three-line shape: a band, then everything else.
 *
 * `LoginScreen` is mounted for real, with `expo-router` and
 * `@convex-dev/auth/react` mocked exactly enough to render — no Convex client,
 * because a screenshot of the sign-in *form* does not need a session to sign
 * into.
 *
 * The fake bridge is `@context/desktop-bridge`'s own reference shell, on
 * `globalThis.desktop`, reporting `platform: "macos"` — the one case this
 * change draws a band for at all.
 *
 * ## The traffic lights in these pictures are drawn by this file
 *
 * The real ones are native chrome: macOS draws them over the window at
 * `SHELL_TRAFFIC_LIGHTS`, and nothing in this bundle, jsdom or Chromium puts
 * a pixel there. A screenshot of a reservation with nothing reserved in it is
 * a picture of an empty corner, which is exactly what these shots exist to
 * argue about — so `page()` paints three discs at the shared constant, from
 * the same `SHELL_TRAFFIC_LIGHTS` the shell positions the real ones by.
 *
 * They are a **stand-in and are marked as one here** rather than in the
 * picture, because the picture is meant to look like the product. What makes
 * them honest is that their position is not typed into this file: move the
 * constant and every shot moves with the real buttons.
 *
 * ## Both palettes
 *
 * `ThemeProvider` pins a subtree to one appearance, so each surface is shot
 * twice. The band and the bar are chrome colours and the whole complaint is
 * about how they read as a slab, which is a question about colour as much as
 * height — a fix checked in one palette is checked in half the product.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { fakeDesktopBridge } from "@context/desktop-bridge/fake";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The shell's console window, 1,040×760 by default — see `windows.ts` —
 * photographed at the task's own size instead. */
const WIDTH = 1280;
const HEIGHT = 800;

const OUT = resolve(__dirname, "../../../docs/design/desktop");

const mockInsets = { top: 0, bottom: 0, left: 0, right: 0 };

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => mockInsets,
}));

const mockUrl: { pathname: string; note?: string } = { pathname: "/console/@seyi" };

jest.mock("expo-router", () => {
  const go = (href: string) => {
    const [pathname] = href.split("?");
    mockUrl.pathname = pathname ?? "/console";
  };
  return {
    Slot: () => {
      const { createElement: h } = require("react") as typeof import("react");
      const Route = (
        require("../app/(app)/console/[slug]/index") as { default: () => unknown }
      ).default;
      return h(Route as never);
    },
    Redirect: () => null,
    useRouter: () => ({ replace: go, push: go }),
    usePathname: () => mockUrl.pathname,
    useLocalSearchParams: () => ({
      slug: mockUrl.pathname.replace("/console/", ""),
    }),
    useNavigation: () => ({ setParams: () => {} }),
  };
});

jest.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({ signIn: async () => {}, signOut: async () => {} }),
}));

/*
  No Convex client, for the same reason there is no session: a picture of the
  console's *chrome* does not need a backend behind it, and the demo data the
  mock below returns is what fills the panes. Without this the console panes
  throw on `useAction` the moment one of them reaches for a write — which is
  how these shots quietly stopped rendering after they were written, since
  `jest.config.js` matches only `__tests__/` and nothing runs this file but a
  person. The stubs answer the three shapes the panes use and nothing more.
*/
jest.mock("convex/react", () => ({
  useAction: () => async () => undefined,
  useMutation: () => async () => undefined,
  useQuery: () => undefined,
}));

jest.mock("../features/console/useLiveConsoleData", () => {
  const { useDemoConsoleData } =
    require("../features/console/useDemoConsoleData") as typeof import("../features/console/useDemoConsoleData");
  return {
    useLiveConsoleData: () => {
      const data = useDemoConsoleData();
      return {
        ...data,
        files: { ...data.files, canEdit: true, canShare: true, canSetVisibility: true },
      };
    },
  };
});

const { StyleSheet } = require("react-native") as {
  StyleSheet: { getSheet(): { textContent: string } };
};
const { useColors } = require("../features/design/theme") as typeof import("../features/design/theme");
const { RootShellTitleBand } =
  require("../features/app/ShellTitleBandView") as typeof import("../features/app/ShellTitleBandView");
const { ThemeProvider } = require("../features/design/theme") as typeof import("../features/design/theme");
const { SHELL_TRAFFIC_LIGHTS } =
  require("@context/desktop-bridge") as typeof import("@context/desktop-bridge");
const LoginScreen = (
  require("../features/auth/LoginScreen") as { LoginScreen: () => unknown }
).LoginScreen;
const ConsoleLayout = (
  require("../app/(app)/console/_layout") as { default: () => unknown }
).default;

/**
 * The three-line shape `app/_layout.tsx`'s `AppGround` wraps every route in —
 * see this file's header for why it is reproduced rather than imported.
 *
 * `RootShellTitleBand`, not `ShellTitleBand`, because that is what the root
 * layout mounts and the whole of what these shots are about is the band
 * standing down for a bar that took the job. The unconditional one is
 * settings', and has its own reason.
 */
function Ground({ children, width, height }: { children: unknown; width: number; height: number }) {
  const { View } = require("react-native") as typeof import("react-native");
  const colors = useColors();
  return createElement(
    View,
    { style: { width, height, backgroundColor: colors.ground } },
    createElement(RootShellTitleBand),
    createElement(View, { style: { flex: 1, minHeight: 0 } }, children as never),
  );
}

/** One surface, pinned to one appearance. */
function Shot({
  children,
  scheme,
  width,
  height,
}: {
  children: unknown;
  scheme: "light" | "dark";
  width: number;
  height: number;
}) {
  return createElement(
    ThemeProvider as never,
    { scheme } as never,
    createElement(Ground, { children, width, height }),
  );
}

/* -------------------------------------------------------------------------- */

function stampViewport(width: number, height: number): void {
  for (const [key, value] of [
    ["clientWidth", width],
    ["clientHeight", height],
  ] as const) {
    Object.defineProperty(document.documentElement, key, { value, configurable: true });
  }
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
  window.dispatchEvent(new Event("resize"));
}

/**
 * The three discs macOS draws and this bundle never does — see the header.
 *
 * Positioned from `SHELL_TRAFFIC_LIGHTS`, the same object
 * `createConsoleWindow` passes to `trafficLightPosition`, so a change to the
 * constant moves the stand-in and the real buttons together. The 8pt pitch
 * between them is the system's, measured, and the only number here that is
 * this file's own.
 */
function trafficLights(): string {
  const { x, y } = SHELL_TRAFFIC_LIGHTS;
  const colours = ["#ff5f57", "#febc2e", "#28c840"];
  return colours
    .map(
      (fill, index) =>
        `<span style="position:absolute;left:${x + index * 20}px;top:${y}px;width:12px;height:12px;` +
        `border-radius:50%;background:${fill};"></span>`,
    )
    .join("");
}

function page(title: string, body: string, css: string, width: number, height: number): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${title}</title>
<style>
  html, body { margin: 0; padding: 0; background: #050506; }
  body { -webkit-font-smoothing: antialiased; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  #shot { width: ${width}px; height: ${height}px; overflow: hidden; position: relative; }
  #shot > div { height: ${height}px !important; max-height: ${height}px !important; }
  /*
    And the frame inside it, for the reason this file's siblings already record
    about \`dvh\`: jsdom's CSS parser does not know the unit, drops the whole
    declaration on the way into the CSSOM, and so \`StyleSheet.getSheet()\` hands
    over a sheet with no height on \`AppFrame\` at all. Chromium would honour
    \`calc(100dvh - …)\` perfectly well if it ever received it — what it receives
    is jsdom's edit. Without this the console stops at its content and the
    bottom of every shot is bare page, which is a picture of the harness.
  */
  #shot [data-testid="app-frame"] { height: ${height}px !important; max-height: ${height}px !important; }
</style>
<style id="rnw">${css}</style>
</head><body><div id="shot">${body}${trafficLights()}</div></body></html>`;
}

const find = (container: HTMLElement, testId: string) =>
  container.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

/**
 * `assertSurface` runs before the picture is taken, per `design-shots.ts`'s
 * own rule: a shot that silently photographs the wrong surface (an empty
 * route, a band that failed to mount) is worse than a failing one.
 */
function shoot(
  name: string,
  element: ReturnType<typeof createElement>,
  assertSurface: (container: HTMLElement) => void = () => {},
  size: { width: number; height: number } = { width: WIDTH, height: HEIGHT },
): void {
  stampViewport(size.width, size.height);
  mockUrl.pathname = "/console/@seyi";

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });

  act(() => {
    root.render(element);
  });

  assertSurface(container);

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

/* -------------------------------------------------------------------------- */

const SCHEMES = ["light", "dark"] as const;

/** A console window narrowed past `narrowBreakpoint` — the compact layout. */
const NARROW = { width: 760, height: HEIGHT };
const FULL = { width: WIDTH, height: HEIGHT };

/** A Mac inside the shell: the one configuration with buttons to clear. */
function installMacShell(): void {
  (globalThis as { desktop?: unknown }).desktop = fakeDesktopBridge({
    shell: { app: "Context", version: "1.4.2", platform: "macos" },
  }).bridge;
}

const topBarLead = (container: HTMLElement) => {
  const bar = find(container, "app-top-bar");
  if (bar === null) return null;
  return window.getComputedStyle(bar).getPropertyValue("padding-left");
};

describe("shell title band shots", () => {
  afterEach(() => {
    delete (globalThis as { desktop?: unknown }).desktop;
  });

  for (const scheme of SCHEMES) {
    test(`the console inside a Mac shell, ${scheme} — the lights in the bar`, () => {
      installMacShell();
      shoot(
        `console-mac-shell-${scheme}`,
        createElement(Shot, {
          scheme,
          ...FULL,
          children: createElement(ConsoleLayout as never),
        }),
        (container) => {
          // The subject of the picture, asserted rather than eyeballed: no
          // band above the app, and the bar itself holding the corner open.
          expect(find(container, "shell-title-band")).toBeNull();
          expect(topBarLead(container)).toBe("84px");
        },
        FULL,
      );
      expect(true).toBe(true);
    });

    test(`the same window narrowed, ${scheme} — the band comes back`, () => {
      installMacShell();
      shoot(
        `console-narrow-mac-shell-${scheme}`,
        createElement(Shot, {
          scheme,
          ...NARROW,
          children: createElement(ConsoleLayout as never),
        }),
        (container) => {
          // The phone layout cannot hold them: its bar is absolute and over
          // the note. The band is the fallback and this is the proof it works
          // by dragging an edge, not only by owning a phone.
          expect(find(container, "shell-title-band")).not.toBeNull();
        },
        NARROW,
      );
      expect(true).toBe(true);
    });

    test(`the sign-in page inside a Mac shell, ${scheme} — no bar, so the band stays`, () => {
      installMacShell();
      shoot(
        `sign-in-mac-shell-${scheme}`,
        createElement(Shot, {
          scheme,
          ...FULL,
          children: createElement(LoginScreen as never),
        }),
        (container) => expect(find(container, "shell-title-band")).not.toBeNull(),
        FULL,
      );
      expect(true).toBe(true);
    });

    test(`the console outside the shell, ${scheme} — nothing reserved either way`, () => {
      // No `globalThis.desktop` at all: an ordinary browser tab, which is what
      // this app is on every host but the Mac shell. No band, and no 84pt of
      // leading inset for buttons that are not there.
      shoot(
        `console-no-shell-${scheme}`,
        createElement(Shot, {
          scheme,
          ...FULL,
          children: createElement(ConsoleLayout as never),
        }),
        (container) => {
          expect(find(container, "shell-title-band")).toBeNull();
          expect(topBarLead(container)).not.toBe("84px");
        },
        FULL,
      );
      expect(true).toBe(true);
    });
  }
});
