/**
 * @jest-environment jsdom
 */

/**
 * The chaos score as built: every placement rendered by the real console and
 * the real chaos components, from a fixture score over the demo workspace,
 * written out as HTML for `capture-chaos-shots.mjs` to photograph.
 *
 *     CHAOS_SHOT_DIR=/path pnpm exec jest --testMatch '**\/scripts/chaos-shots.ts' \
 *       --testPathIgnorePatterns '[]'
 *     PW_EXE=/path/to/chrome node scripts/capture-chaos-shots.mjs /path
 */

import { describe, expect, jest, test } from "@jest/globals";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };
const OUT = resolve(process.env.CHAOS_SHOT_DIR ?? "/tmp/chaos-shots");
const FONT_DIR = process.env.CHAOS_FONT_DIR ?? "/mnt/skills/examples/canvas-design/canvas-fonts";

const mockInsets = { top: 59, bottom: 34, left: 0, right: 0 };
const mockUrl: { pathname: string; note?: string } = { pathname: "/console/@seyi" };

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => mockInsets,
  SafeAreaProvider: ({ children }: { children: unknown }) => children,
}));

jest.mock("expo-router", () => {
  const go = (href: string) => {
    const [pathname, query] = href.split("?");
    mockUrl.pathname = pathname ?? "/console";
    mockUrl.note = new URLSearchParams(query ?? "").get("note") ?? undefined;
  };
  return {
    Slot: () => {
      const { createElement: h } = require("react") as typeof import("react");
      const module = require("../app/(app)/console/[slug]/index") as { default: () => unknown };
      return h(module.default as never);
    },
    Redirect: () => null,
    useRouter: () => ({
      replace: go,
      push: go,
      back: () => {},
      setParams: (next: Record<string, string | undefined>) => {
        if ("note" in next) mockUrl.note = next.note;
      },
    }),
    usePathname: () => mockUrl.pathname,
    useLocalSearchParams: () => ({ slug: mockUrl.pathname.replace("/console/", ""), note: mockUrl.note }),
    useNavigation: () => ({
      setParams: ({ note }: { note?: string }) => {
        mockUrl.note = note;
      },
    }),
  };
});

jest.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({ signOut: async () => {} }),
  useAuthToken: () => null,
}));

const mockClient = {
  query: async () => undefined,
  mutation: async () => undefined,
  action: async () => undefined,
  watchQuery: () => ({ onUpdate: () => () => {}, localQueryResult: () => undefined }),
};
jest.mock("convex/react", () => ({
  useAction: () => async () => undefined,
  useMutation: () => async () => undefined,
  useQuery: () => undefined,
  useQueries: () => ({}),
  useConvex: () => mockClient,
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
}));

/* The demo console, with the chaos score the server would hand it. */
jest.mock("../features/console/useLiveConsoleData", () => {
  const { useDemoConsoleData } =
    require("../features/console/useDemoConsoleData") as typeof import("../features/console/useDemoConsoleData");
  const { useMemo } = require("react") as typeof import("react");
  const { fixtureSource: mockSource } = require("./chaos/frames") as typeof import("./chaos/frames");
  return {
    useLiveConsoleData: () => {
      const data = useDemoConsoleData();
      const chaos = useMemo(() => mockSource(), []);
      return { ...data, chaos, files: { ...data.files, canEdit: true, canShare: true, canSetVisibility: true } };
    },
  };
});

jest.mock("../features/offline/useFolderLists", () => ({ useFolderLists: () => undefined }));

const { StyleSheet } = require("react-native") as { StyleSheet: { getSheet(): { textContent: string } } };
const ConsoleLayout = (require("../app/(app)/console/_layout") as { default: () => unknown }).default;
const { ThemeProvider } = require("../features/design/theme") as {
  ThemeProvider: (props: { scheme: "light" | "dark"; children: unknown }) => unknown;
};
const { FRAMES, FigureStrip } = require("./chaos/frames") as typeof import("./chaos/frames");

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

const FONTS = `
@font-face { font-family: "Instrument Sans"; src: url("InstrumentSans-Regular.ttf"); font-weight: 400 500; }
@font-face { font-family: "Instrument Sans"; src: url("InstrumentSans-Bold.ttf"); font-weight: 600 700; }
@font-face { font-family: "JetBrains Mono"; src: url("JetBrainsMono-Regular.ttf"); font-weight: 400 700; }`;
// The frame fills the window in the app (its root is a full-height flex column); a static page has to say so.
const QUIET_CSS = `[data-testid="presence-pile"] { display: none !important; }
[data-testid="app-frame"] { height: 100%; }`;

function copyFonts(): void {
  for (const name of ["InstrumentSans-Regular.ttf", "InstrumentSans-Bold.ttf", "JetBrainsMono-Regular.ttf"]) {
    const from = resolve(FONT_DIR, name);
    if (existsSync(from)) copyFileSync(from, resolve(OUT, name));
  }
}

function page(title: string, body: string, css: string, size: { width: number; height: number }, ground: string, scroll: boolean): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>${scroll ? '<meta name="chaos-scroll" content="end">' : ""}
<style>${FONTS}
  html, body { margin: 0; padding: 0; background: ${ground}; }
  body { -webkit-font-smoothing: antialiased; width: ${size.width}px; height: ${size.height}px; overflow: hidden; position: relative; }
  body > div { height: ${size.height}px !important; max-height: ${size.height}px !important; }
  ${QUIET_CSS}
</style>
<style id="rnw">${css}</style>
</head><body>${body}</body></html>`;
}

function press(node: Element | null): void {
  if (node === null) throw new Error("nothing to press");
  act(() => {
    node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function write(stem: string, size: { width: number; height: number }, scheme: "light" | "dark", scroll: boolean): void {
  const injected = [...document.head.querySelectorAll("style")].map((n) => n.textContent ?? "").join("\n");
  const file = resolve(OUT, `${stem}.html`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    page(stem, document.body.innerHTML, `${StyleSheet.getSheet().textContent}\n${injected}`, size, scheme === "dark" ? "#100F0E" : "#FFFDF9", scroll),
    "utf8",
  );
}

async function shoot(frame: (typeof FRAMES)[number], density: "phone" | "desktop", scheme: "light" | "dark"): Promise<void> {
  const size = density === "phone" ? PHONE : DESKTOP;
  mockInsets.top = density === "phone" ? 59 : 0;
  mockInsets.bottom = density === "phone" ? 34 : 0;
  stampViewport(size.width, size.height);
  document.body.innerHTML = "";
  mockUrl.pathname = "/console/@seyi";
  mockUrl.note = undefined;

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  const settle = async () => {
    for (let pass = 0; pass < 6; pass += 1) {
      act(() => {
        root.render(createElement(ThemeProvider as never, { scheme } as never, createElement(ConsoleLayout as never)));
      });
      // A turn for the fixture's answers (a folder chip asks for its own score) to land.
      await new Promise((done) => setTimeout(done, 0));
    }
  };
  await settle();
  try {
    if (frame.prepare) await frame.prepare({ density, settle, press });
    await settle();
  } finally {
    // Written either way: a frame that could not be reached is easiest to mend from what it drew.
    write(`${frame.id}-${density}-${scheme}`, size, scheme, frame.scroll === true);
  }
  const text = document.body.textContent ?? "";
  for (const needle of frame.assert ?? []) {
    if (!text.replace(/[\u2066-\u2069]/g, "").includes(needle)) throw new Error(`${frame.id} ${density}: missing "${needle}"`);
  }
  act(() => root.unmount());
  container.remove();
}

describe("chaos score built shots", () => {
  mkdirSync(OUT, { recursive: true });
  copyFonts();
  for (const frame of FRAMES) {
    for (const density of frame.sizes) {
      for (const scheme of frame.schemes ?? (["light"] as const)) {
        test(`${frame.id} — ${density}, ${scheme}`, async () => {
          await shoot(frame, density, scheme);
          expect(true).toBe(true);
        }, 120_000);
      }
    }
  }

  for (const scheme of ["light", "dark"] as const) {
    test(`07-figures — ${scheme}`, async () => {
      const size = { width: 1300, height: 420 };
      stampViewport(size.width, size.height);
      document.body.innerHTML = "";
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container);
      await act(async () => {
        root.render(createElement(ThemeProvider as never, { scheme } as never, createElement(FigureStrip)));
      });
      write(`07-figures-strip-${scheme}`, size, scheme, false);
      act(() => root.unmount());
      container.remove();
      expect(true).toBe(true);
    });
  }
});
