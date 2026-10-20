/**
 * @jest-environment jsdom
 */

/**
 * Screenshots of the Tex launch (2026-10-20): tex.lc's landing, the waitlist
 * status page in each state, and the staff Waitlist tab searching answers, at
 * 1440 and 390, for the design check. `trash-shots.ts`'s technique: the
 * shipped components, rendered by react-dom into a real DOM, written as
 * self-contained `.html`, and photographed by Playwright
 * (`capture-tex-launch-shots.mjs`).
 *
 * Every value is invented; numbers are in the 555 range.
 *
 *     pnpm exec jest --testMatch '**\/scripts/tex-launch-shots.ts' --testPathIgnorePatterns '[]'
 *
 * `TEX_SHOTS_FONTS` names a stylesheet with local `@font-face` rules for
 * Instrument Sans and Libron, inlined so the photographs touch no network.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OUT = resolve(process.env.TEX_SHOTS_DIR ?? "/tmp/tex-launch-shots");
const FONTS = process.env.TEX_SHOTS_FONTS;
const RECEIPT = "ab".repeat(32);
// jsdom has no object URLs; the contact card link only needs one to draw.
Object.assign(URL, { createObjectURL: () => "blob:tex-card", revokeObjectURL: () => {} });
const HOUR = 3_600_000;
const NOW = Date.now();

type Fake = { status: unknown; list: unknown };
const mockShots: Fake = { status: null, list: undefined };

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
      const name = fnName(ref);
      if (name.endsWith("waitlistStatus:status")) return mockShots.status;
      if (name.endsWith("admin:listWaitlist")) return mockShots.list;
      if (name.endsWith("admin:waitlistLandingCounts")) return [{ landing: "tex", joined: 214, admitted: 18 }];
      return undefined;
    },
    useMutation: () => mockStableNoop,
    useAction: () => mockStableNoop,
  };
});

const { StyleSheet } = require("react-native") as { StyleSheet: { getSheet(): { textContent: string } } };
const { ThemeProvider } = require("../features/design/theme") as typeof import("../features/design/theme");
const { TexLanding } = require("../features/tex/launch/TexLanding.web") as typeof import("../features/tex/launch/TexLanding.web");
const { TexStatus } = require("../features/tex/launch/TexStatus.web") as typeof import("../features/tex/launch/TexStatus.web");
const { WaitlistSection } = require("../features/admin/WaitlistSection") as typeof import("../features/admin/WaitlistSection");

type Viewport = { name: "desktop" | "phone"; width: number; height: number };
const VIEWPORTS: Viewport[] = [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
];

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  if (container !== null) container.remove();
  root = null;
  container = null;
  localStorage.clear();
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

async function mount(node: ReactElement, viewport: Viewport): Promise<void> {
  stampViewport(viewport.width, viewport.height);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  await act(async () => {
    root!.render(createElement(ThemeProvider, { scheme: "light", children: node }));
  });
}

/** Full height: the page grows to its content, and the photograph takes all of it. */
function page(title: string, body: string, css: string, width: number): string {
  const fonts = FONTS !== undefined && existsSync(FONTS) ? readFileSync(FONTS, "utf8") : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${fonts}</style>
<style>
  html, body { margin: 0; padding: 0; }
  body { -webkit-font-smoothing: antialiased; font-family: "Instrument Sans", -apple-system, sans-serif; }
  #shot { width: ${width}px; position: relative; }
  #shot .tx { height: auto !important; min-height: 100vh; overflow: visible !important; }
</style>
<style id="rnw">${css}</style>
</head><body><div id="shot">${body}</div></body></html>`;
}

function write(name: string, width: number): void {
  const injected = [...document.querySelectorAll("style")].map((node) => node.textContent ?? "").join("\n");
  const css = `${StyleSheet.getSheet().textContent}\n${injected}`;
  const file = resolve(OUT, `${name}.html`);
  mkdirSync(dirname(file), { recursive: true });
  expect(container).not.toBeNull();
  writeFileSync(file, page(name, container!.innerHTML, css, width));
}

async function board(name: string, node: () => ReactElement, fake: Partial<Fake>, steps?: () => Promise<void>) {
  for (const viewport of VIEWPORTS) {
    Object.assign(mockShots, { status: null, list: undefined }, fake);
    if (fake.status !== undefined && fake.status !== null) localStorage.setItem("context.waitlistReceipt", RECEIPT);
    await mount(node(), viewport);
    await act(async () => {});
    if (steps) await steps();
    write(`${name}-${viewport.name}`, viewport.width);
    act(() => root!.unmount());
    container!.remove();
    root = null;
    container = null;
    localStorage.clear();
  }
}

const waiting = (useFor: string | null) => ({
  state: "waiting",
  contact: { kind: "phone", ending: "0142" },
  useFor,
  texLine: null,
});

function row(id: string, who: string, useFor: string | null, hoursAgo: number, edited?: number) {
  return {
    id,
    email: null,
    phone: who,
    status: "waiting",
    joinedAt: NOW - hoursAgo * HOUR,
    source: "home",
    useFor,
    useForAt: edited === undefined ? null : NOW - edited * HOUR,
    admittedAt: null,
    landing: "tex",
  };
}

const MATCHES = [
  row("w1", "+15555550101", "Keeping the family calendar straight: two kids, three sports, my mom's appointments.", 3, 2),
  row("w2", "+15555550102", "Work calendar and invoices for my cleaning business. I lose track of who paid.", 26),
  row("w3", "+15555550103", "Reminders, mostly. And putting plans on my calendar when friends text me.", 50, 30),
];

describe("tex launch shots", () => {
  test("landing", async () => {
    await board("01-landing", () => createElement(TexLanding), {});
  });

  test("status: on the list, question open", async () => {
    await board("02-status-waiting", () => createElement(TexStatus), { status: waiting(null) });
  });

  test("status: on the list, answer saved", async () => {
    await board("03-status-answered", () => createElement(TexStatus), {
      status: waiting("Keeping my kids' schedules and the bills straight."),
    });
  });

  test("status: let in", async () => {
    await board("04-status-admitted", () => createElement(TexStatus), {
      status: { state: "admitted", contact: { kind: "phone", ending: "0142" }, useFor: null, texLine: "+15555550199" },
    });
  });

  test("status: let in, line not ready", async () => {
    await board("05-status-admitted-no-line", () => createElement(TexStatus), {
      status: { state: "admitted", contact: { kind: "phone", ending: "0142" }, useFor: null, texLine: null },
    });
  });

  test("status: not found", async () => {
    await board("06-status-not-found", () => createElement(TexStatus), { status: null });
  });

  test("admin: searching answers", async () => {
    await board(
      "07-admin-search",
      () => createElement(WaitlistSection),
      {
        list: {
          rows: MATCHES,
          more: false,
          counts: { waiting: 214, admitted: 18 },
          filter: { matches: 3, capped: false },
        },
      },
      async () => {
        const field = document.querySelector('[data-testid="admin-waitlist-search"]') as HTMLInputElement;
        await act(async () => {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, "calendar");
          field.dispatchEvent(new Event("input", { bubbles: true }));
        });
        await act(async () => {
          await new Promise((done) => setTimeout(done, 350));
        });
      },
    );
  });
});
