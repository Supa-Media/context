/**
 * @jest-environment jsdom
 */

/**
 * The "areas as seats" review frames: the real console (real tree, editor,
 * title bar and frame) over a Supa-shaped demo workspace, with the prototype
 * seats panel from `prototypes/seats` mounted where the right panel goes.
 * Nothing here ships and nothing reaches a backend. Same technique as
 * `chaos-shots.ts`.
 *
 *     SEATS_SHOT_DIR=/path pnpm exec jest --testMatch '**\/scripts/seats-shots.ts' \
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
const OUT = resolve(process.env.SEATS_SHOT_DIR ?? "/tmp/seats-shots");
const FONT_DIR = process.env.SEATS_FONT_DIR ?? "";

const mockInsets = { top: 59, bottom: 34, left: 0, right: 0 };
const mockUrl: { pathname: string; note?: string } = { pathname: "/console/@supa" };

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

/* The Supa-shaped tree stands in for the demo's own workspace. */
jest.mock("../features/console/placeholderData/contexts", () => {
  const { SUPA_TREE } = require("../prototypes/seats/tree") as typeof import("../prototypes/seats/tree");
  return { DEMO_CONTEXT_TREES: { seyi: SUPA_TREE }, demoTreeFor: () => SUPA_TREE };
});

/* The demo console, editable, its own workspace named @supa. */
jest.mock("../features/console/useLiveConsoleData", () => {
  const { useDemoConsoleData } =
    require("../features/console/useDemoConsoleData") as typeof import("../features/console/useDemoConsoleData");
  return {
    useLiveConsoleData: () => {
      const data = useDemoConsoleData();
      const contexts = data.contexts.map((context) =>
        context.id === "seyi" ? { ...context, slug: "supa", displayName: "supa" } : context,
      );
      return { ...data, contexts, files: { ...data.files, canEdit: true, canShare: true, canSetVisibility: true } };
    },
  };
});

/* The right panel is the prototype's. */
jest.mock("../features/console/layout/slots", () => {
  const actual = jest.requireActual("../features/console/layout/slots") as Record<string, unknown>;
  const { createElement: h } = require("react") as typeof import("react");
  const { SeatsAside } = require("../prototypes/seats/SeatsAside") as typeof import("../prototypes/seats/SeatsAside");
  return { ...actual, consoleAsidePanel: () => h(SeatsAside) };
});

jest.mock("../features/offline/useFolderLists", () => ({ useFolderLists: () => undefined }));

const { StyleSheet } = require("react-native") as { StyleSheet: { getSheet(): { textContent: string } } };
const ConsoleLayout = (require("../app/(app)/console/_layout") as { default: () => unknown }).default;
const { ThemeProvider } = require("../features/design/theme") as {
  ThemeProvider: (props: { scheme: "light" | "dark"; children: unknown }) => unknown;
};
const { Sprites } = require("../prototypes/seats/SeatsAside") as typeof import("../prototypes/seats/SeatsAside");
const { FRAMES } = require("../prototypes/seats/frames") as typeof import("../prototypes/seats/frames");

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
@font-face { font-family: "Instrument Sans"; src: url("InstrumentSans.woff2") format("woff2"); font-weight: 400 700; }
@font-face { font-family: "JetBrains Mono"; src: url("JetBrainsMono.woff2") format("woff2"); font-weight: 400 700; }`;
const QUIET_CSS = `[data-testid="presence-pile"] { display: none !important; }
[data-testid="app-frame"] { height: 100%; }`;

function copyFonts(): void {
  if (FONT_DIR === "") return;
  for (const name of ["InstrumentSans.woff2", "JetBrainsMono.woff2"]) {
    const from = resolve(FONT_DIR, name);
    if (existsSync(from)) copyFileSync(from, resolve(OUT, name));
  }
}

function page(title: string, body: string, css: string, size: { width: number; height: number }, ground: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>${FONTS}
  html, body { margin: 0; padding: 0; background: ${ground}; }
  body { -webkit-font-smoothing: antialiased; width: ${size.width}px; height: ${size.height}px; overflow: hidden; position: relative; }
  body > div:not([data-sprites]) { height: ${size.height}px !important; max-height: ${size.height}px !important; }
  [data-sprites] { display: none; }
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

function write(stem: string, size: { width: number; height: number }, scheme: "light" | "dark"): void {
  const injected = [...document.head.querySelectorAll("style")].map((n) => n.textContent ?? "").join("\n");
  const file = resolve(OUT, `${stem}.html`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    page(stem, document.body.innerHTML, `${StyleSheet.getSheet().textContent}\n${injected}`, size, scheme === "dark" ? "#100F0E" : "#FFFDF9"),
    "utf8",
  );
}

async function shoot(frame: (typeof FRAMES)[number], density: "phone" | "desktop", scheme: "light" | "dark"): Promise<void> {
  const size = density === "phone" ? PHONE : DESKTOP;
  mockInsets.top = density === "phone" ? 59 : 0;
  mockInsets.bottom = density === "phone" ? 34 : 0;
  stampViewport(size.width, size.height);
  document.body.innerHTML = "";
  mockUrl.pathname = "/console/@supa";
  mockUrl.note = undefined;

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  const settle = async () => {
    for (let pass = 0; pass < 6; pass += 1) {
      act(() => {
        root.render(createElement(ThemeProvider as never, { scheme } as never, createElement(ConsoleLayout as never)));
      });
      await new Promise((done) => setTimeout(done, 0));
    }
  };
  const spriteHost = document.createElement("div");
  spriteHost.setAttribute("data-sprites", "");
  document.body.appendChild(spriteHost);
  const spriteRoot = createRoot(spriteHost);
  await act(async () => {
    spriteRoot.render(createElement(ThemeProvider as never, { scheme } as never, createElement(Sprites)));
  });
  await settle();
  try {
    if (frame.prepare) await frame.prepare({ density, settle, press });
    await settle();
  } finally {
    write(`${frame.id}-${density}-${scheme}`, size, scheme);
  }
  const text = (document.body.textContent ?? "").replace(/[⁦-⁩]/g, "");
  for (const needle of frame.assert ?? []) {
    if (!text.includes(needle)) throw new Error(`${frame.id} ${density}: missing "${needle}"`);
  }
  act(() => root.unmount());
  act(() => spriteRoot.unmount());
  container.remove();
  spriteHost.remove();
}

describe("areas as seats frames", () => {
  mkdirSync(OUT, { recursive: true });
  copyFonts();
  for (const frame of FRAMES) {
    for (const density of frame.sizes) {
      for (const scheme of frame.schemes ?? (["light", "dark"] as const)) {
        test(`${frame.id} — ${density}, ${scheme}`, async () => {
          await shoot(frame, density, scheme);
          expect(true).toBe(true);
        }, 120_000);
      }
    }
  }
});
