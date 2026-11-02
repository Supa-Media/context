/**
 * @jest-environment jsdom
 * @jest-environment-options {"url": "https://context.lc/"}
 */

/**
 * Screenshots of tex.lc signed in and Gmail first (2026-10-20), for the
 * design check against tex-signup-gmail-artboards: `/text`, the landing
 * signed in, the Gmail-first gate and its typed-email fallback, the page Google
 * returns to, and `/add-gmail`. `tex-launch-shots.ts`'s technique: the shipped
 * components rendered by react-dom, written as `.html`, photographed by
 * `capture-tex-launch-shots.mjs`. Every value is invented.
 *
 *     pnpm exec jest --testMatch '**\/scripts/tex-signup-gmail-shots.ts' --testPathIgnorePatterns '[]'
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OUT = resolve(process.env.TEX_SHOTS_DIR ?? "/tmp/tex-signup-gmail-shots");
const FONTS = process.env.TEX_SHOTS_FONTS;
Object.assign(URL, { createObjectURL: () => "blob:tex-card", revokeObjectURL: () => {} });

const mockShots: { home: unknown } = { home: undefined };

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {}, back: () => {}, setParams: () => {} }),
  useLocalSearchParams: () => ({}),
  useGlobalSearchParams: () => ({}),
  usePathname: () => "/",
  Redirect: () => null,
  Slot: () => null,
}));

jest.mock("@convex-dev/auth/react", () => ({
  useAuthActions: () => ({ signIn: async () => ({}), signOut: async () => {} }),
}));

const mockStableNoop = async () => ({});

jest.mock("convex/react", () => {
  const fnName = (ref: unknown): string => {
    const { getFunctionName } = require("convex/server") as typeof import("convex/server");
    try {
      return getFunctionName(ref as never);
    } catch {
      return String(ref);
    }
  };
  return {
    useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
    useQuery: (ref: unknown, args: unknown) => {
      if (args === "skip") return undefined;
      if (fnName(ref).endsWith("texHome:mine")) return mockShots.home;
      return undefined;
    },
    useMutation: () => mockStableNoop,
    useAction: () => mockStableNoop,
  };
});

const { StyleSheet } = require("react-native") as { StyleSheet: { getSheet(): { textContent: string } } };
const { ThemeProvider } = require("../features/design/theme") as typeof import("../features/design/theme");
const { TexLanding } = require("../features/tex/launch/TexLanding.web") as typeof import("../features/tex/launch/TexLanding.web");
const { TexText } = require("../features/tex/launch/TexText.web") as typeof import("../features/tex/launch/TexText.web");
const { GmailFirstScreen } = require("../features/auth/gmailFirst/GmailFirstScreen") as typeof import("../features/auth/gmailFirst/GmailFirstScreen");
const { GmailDone } = require("../features/auth/gmailFirst/GmailDone") as typeof import("../features/auth/gmailFirst/GmailDone");
const { EmailCheckScreen } = require("../features/auth/EmailCheckScreen") as typeof import("../features/auth/EmailCheckScreen");

type Viewport = { name: "desktop" | "phone"; width: number; height: number };
const DESKTOP: Viewport = { name: "desktop", width: 1440, height: 900 };
const PHONE: Viewport = { name: "phone", width: 390, height: 844 };

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  if (container !== null) container.remove();
  root = null;
  container = null;
});

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

function page(title: string, body: string, css: string, width: number, ground: string): string {
  const fonts = FONTS !== undefined && existsSync(FONTS) ? readFileSync(FONTS, "utf8") : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${fonts}</style>
<style>
  html, body { margin: 0; padding: 0; background: ${ground}; }
  body { -webkit-font-smoothing: antialiased; font-family: "Instrument Sans", -apple-system, sans-serif; }
  #shot { width: ${width}px; min-height: 100vh; position: relative; display: flex; flex-direction: column; }
  #shot > div { flex: 1; display: flex; flex-direction: column; }
  #shot .tx { height: auto !important; min-height: 100vh; overflow: visible !important; }
</style>
<style id="rnw">${css}</style>
</head><body><div id="shot">${body}</div></body></html>`;
}

const HOME = {
  ending: "0199",
  line: "+15555550177",
  firstText: true,
  mainEmail: "ada.lovelace@gmail.com",
  workspaceId: "w1",
  gmails: ["ada.lovelace@gmail.com"],
};

async function board(name: string, node: () => ReactElement, home: unknown, viewports: Viewport[], scheme: "light" | "dark" = "light") {
  for (const viewport of viewports) {
    mockShots.home = home;
    stampViewport(viewport.width, viewport.height);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
    await act(async () => {
      root!.render(createElement(ThemeProvider, { scheme, children: node() }));
    });
    await act(async () => {});
    const injected = [...document.querySelectorAll("style")].map((n) => n.textContent ?? "").join("\n");
    const css = `${StyleSheet.getSheet().textContent}\n${injected}`;
    const file = resolve(OUT, `${name}-${viewport.name}.html`);
    mkdirSync(dirname(file), { recursive: true });
    expect(container).not.toBeNull();
    const ground = name.startsWith("0") && Number(name.slice(0, 2)) <= 3 ? "#F2F0EA" : scheme === "dark" ? "#100F0E" : "#FFFDF9";
    writeFileSync(file, page(name, container!.innerHTML, css, viewport.width, ground));
    act(() => root!.unmount());
    container!.remove();
    root = null;
    container = null;
  }
}

describe("tex signup and gmail first shots", () => {
  test("01 /text", async () => {
    await board("01-text-tex", () => createElement(TexText), HOME, [DESKTOP, PHONE]);
  });
  test("02 /text, no line", async () => {
    await board("02-text-tex-no-line", () => createElement(TexText), { ...HOME, line: null }, [DESKTOP, PHONE]);
  });
  test("03 landing, signed in", async () => {
    await board("03-landing-signed-in", () => createElement(TexLanding), HOME, [DESKTOP, PHONE]);
  });
  test("06 gate, Gmail first", async () => {
    const gate = () => createElement(GmailFirstScreen, { mode: "primary", workspaceId: "w1", mainEmail: null, onTypeEmail: () => {} });
    await board("06-gate-gmail", gate, { ...HOME, mainEmail: null, gmails: [] }, [DESKTOP, PHONE]);
    await board("06-gate-gmail-dark", gate, { ...HOME, mainEmail: null, gmails: [] }, [PHONE], "dark");
  });
  test("07 gate, typed email", async () => {
    await board("07-gate-fallback", () => createElement(EmailCheckScreen as (props: { onUseGmail?: () => void }) => ReactElement, { onUseGmail: () => {} }), HOME, [PHONE]);
  });
  test("08 done, main email", async () => {
    await board("08-gmail-done", () => createElement(GmailDone, { mode: "primary" }), { ...HOME, firstText: false }, [DESKTOP, PHONE]);
  });
  test("08b done, address held elsewhere", async () => {
    await board("08b-gmail-done-not-main", () => createElement(GmailDone, { mode: "primary" }), { ...HOME, mainEmail: null, firstText: false }, [PHONE]);
  });
  test("09 add another", async () => {
    await board(
      "09-add-another",
      () => createElement(GmailFirstScreen, { mode: "another", workspaceId: "w1", mainEmail: "ada.lovelace@gmail.com" }),
      HOME,
      [PHONE],
    );
  });
});
