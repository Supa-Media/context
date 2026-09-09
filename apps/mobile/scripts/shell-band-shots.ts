/**
 * @jest-environment jsdom
 */

/**
 * Screenshots for the shell title band — `docs/decisions/desktop.md`, "The
 * console reserves the space".
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
const { ShellTitleBand } = require("../features/app/ShellTitleBand.tsx") as typeof import("../features/app/ShellTitleBand.tsx");
const LoginScreen = (
  require("../features/auth/LoginScreen") as { LoginScreen: () => unknown }
).LoginScreen;
const ConsoleLayout = (
  require("../app/(app)/console/_layout") as { default: () => unknown }
).default;

/**
 * The three-line shape `app/_layout.tsx`'s `AppGround` wraps every route in —
 * see this file's header for why it is reproduced rather than imported.
 */
function Ground({ children }: { children: unknown }) {
  const { View } = require("react-native") as typeof import("react-native");
  const colors = useColors();
  return createElement(
    View,
    { style: { width: WIDTH, height: HEIGHT, backgroundColor: colors.ground } },
    createElement(ShellTitleBand),
    createElement(View, { style: { flex: 1, minHeight: 0 } }, children as never),
  );
}

/* -------------------------------------------------------------------------- */

function stampViewport(): void {
  for (const [key, value] of [
    ["clientWidth", WIDTH],
    ["clientHeight", HEIGHT],
  ] as const) {
    Object.defineProperty(document.documentElement, key, { value, configurable: true });
  }
  Object.defineProperty(window, "innerWidth", { value: WIDTH, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: HEIGHT, configurable: true });
  window.dispatchEvent(new Event("resize"));
}

function page(title: string, body: string, css: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<title>${title}</title>
<style>
  html, body { margin: 0; padding: 0; background: #050506; }
  body { -webkit-font-smoothing: antialiased; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  #shot { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; position: relative; }
  #shot > div { height: ${HEIGHT}px !important; max-height: ${HEIGHT}px !important; }
</style>
<style id="rnw">${css}</style>
</head><body><div id="shot">${body}</div></body></html>`;
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
): void {
  stampViewport();
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
    page(name, container.innerHTML, `${StyleSheet.getSheet().textContent}\n${injected}`),
    "utf8",
  );

  act(() => root.unmount());
  container.remove();
}

/* -------------------------------------------------------------------------- */

describe("shell title band shots", () => {
  afterEach(() => {
    delete (globalThis as { desktop?: unknown }).desktop;
  });

  test("the sign-in page, inside a Mac shell", () => {
    (globalThis as { desktop?: unknown }).desktop = fakeDesktopBridge({
      shell: { app: "Context", version: "1.4.2", platform: "macos" },
    }).bridge;

    shoot(
      "sign-in-mac-shell",
      createElement(Ground, { children: createElement(LoginScreen as never) }),
      (container) => expect(find(container, "shell-title-band")).not.toBeNull(),
    );
    expect(true).toBe(true);
  });

  test("the console, inside a Mac shell — the chip clear of the traffic lights", () => {
    (globalThis as { desktop?: unknown }).desktop = fakeDesktopBridge({
      shell: { app: "Context", version: "1.4.2", platform: "macos" },
    }).bridge;

    shoot(
      "console-mac-shell",
      createElement(Ground, { children: createElement(ConsoleLayout as never) }),
      (container) => expect(find(container, "shell-title-band")).not.toBeNull(),
    );
    expect(true).toBe(true);
  });

  test("the console, outside the shell — no band, nothing reserved", () => {
    // No `globalThis.desktop` at all: an ordinary browser tab, which is what
    // this app is on every host but the Mac shell.
    shoot(
      "console-no-shell",
      createElement(Ground, { children: createElement(ConsoleLayout as never) }),
      (container) => expect(find(container, "shell-title-band")).toBeNull(),
    );
    expect(true).toBe(true);
  });
});
