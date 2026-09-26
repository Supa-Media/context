/**
 * @jest-environment jsdom
 */

/**
 * Auto-organize as built: every frame rendered by the real console, the real
 * settings overlay and the real organizer components, from a fixture view.
 * The approved artboards are the designer's (`auto-organize-artboards/`);
 * these are what they are compared against.
 *
 *     AO_SHOT_DIR=/path pnpm exec jest --testMatch '**\/scripts/auto-organize-shots.ts' \
 *       --testPathIgnorePatterns '[]'
 *     node scripts/capture-auto-organize-shots.mjs /path
 */

import { describe, expect, jest, test } from "@jest/globals";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";

const { NOW: FIXED_NOW } = require("./autoOrganize/workspace") as { NOW: number };
{
  const realNow = Date.now.bind(Date);
  const offset = FIXED_NOW - realNow();
  Date.now = () => realNow() + offset;
}
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1440, height: 900 };
const OUT = resolve(process.env.AO_SHOT_DIR ?? "/tmp/ao-built");

const mockInsets = { top: 59, bottom: 34, left: 0, right: 0 };
const mockUrl: { pathname: string; note?: string; settings?: string } = { pathname: "/console/@seyi" };
/** What the frame being drawn asks for, read lazily inside the mocks. */
const mockFrame: {
  organizer?: import("./autoOrganize/frames").OrganizerFixture;
  list?: import("../features/organizer/types").OrganizerSuggestion[];
  activity?: boolean;
  activityOpen?: boolean;
} = {};

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => mockInsets,
  SafeAreaProvider: ({ children }: { children: unknown }) => children,
}));

jest.mock("expo-router", () => {
  const go = (href: string) => {
    const [pathname, query] = href.split("?");
    mockUrl.pathname = pathname ?? "/console";
    const params = new URLSearchParams(query ?? "");
    mockUrl.note = params.get("note") ?? undefined;
    mockUrl.settings = params.get("settings") ?? undefined;
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
        if ("settings" in next) mockUrl.settings = next.settings;
      },
    }),
    usePathname: () => mockUrl.pathname,
    useLocalSearchParams: () => ({
      slug: mockUrl.pathname.replace("/console/", ""),
      note: mockUrl.note,
      settings: mockUrl.settings,
    }),
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

jest.mock("../features/console/useLiveConsoleData", () => {
  const { useDemoConsoleData } =
    require("../features/console/useDemoConsoleData") as typeof import("../features/console/useDemoConsoleData");
  return {
    useLiveConsoleData: () => {
      const data = useDemoConsoleData();
      const { ORGANIZER_ACTIVITY: mockEntries } = require("./autoOrganize/frames") as typeof import("./autoOrganize/frames");
      const activity = mockFrame.activity
        ? {
            entries: mockEntries,
            unseen: 2,
            unseenPaths: [],
            seenAt: Date.now() - 4 * 60 * 60 * 1000,
            loaded: true,
            refresh: () => {},
            markSeen: () => {},
          }
        : data.activity;
      // The console's organizer, as the frame describes it; every surface reading it is the real one.
      const { fixtureView: mockView } = require("./autoOrganize/frames") as typeof import("./autoOrganize/frames");
      const organizer = mockFrame.organizer === undefined ? undefined : mockView(mockFrame.organizer, mockFrame.list ?? []);
      return {
        ...data,
        activity,
        organizer,
        files: { ...data.files, canEdit: true, canShare: true, canSetVisibility: true },
      };
    },
  };
});

jest.mock("../features/console/placeholderData/seyi", () => {
  const actual = jest.requireActual("../features/console/placeholderData/seyi") as {
    SEYI_TREE: import("../features/console/placeholderData/treeHelpers").DemoContextTree;
  };
  const { WORKSPACE } = require("./autoOrganize/workspace") as typeof import("./autoOrganize/workspace");
  return { SEYI_TREE: WORKSPACE(actual.SEYI_TREE) };
});

jest.mock("../features/offline/useFolderLists", () => {
  const { LIST_SOURCE } = require("./autoOrganize/workspace") as typeof import("./autoOrganize/workspace");
  return { useFolderLists: () => LIST_SOURCE };
});

/** Settings sections swapped for a frame's body, by key. */
let mockSettingsBodies: Record<string, () => ReactElement> = {};
jest.mock("../features/console/settings/panels/PremiumPanel", () => {
  const actual = jest.requireActual("../features/console/settings/panels/PremiumPanel") as Record<string, unknown>;
  return {
    ...actual,
    PremiumPanel: (props: unknown) =>
      mockSettingsBodies.premium === undefined
        ? (actual.PremiumPanel as (mockProps: unknown) => ReactElement)(props)
        : mockSettingsBodies.premium(),
  };
});

/* The activity popover opened by the frame rather than by a press. */
jest.mock("../features/console/files/explorer/ExplorerFootLists", () => {
  const actual = jest.requireActual("../features/console/files/explorer/ExplorerFootLists") as {
    ExplorerFootLists: (p: object) => ReactElement;
  };
  const { createElement: h } = require("react") as typeof import("react");
  return {
    ExplorerFootLists: (mockProps: { activityOpen: number | null }) =>
      h(actual.ExplorerFootLists, mockFrame.activityOpen ? { ...mockProps, activityOpen: Date.now() } : mockProps),
  };
});

/*
  Harness correction, carried from the designer's harness (finding A): on a
  phone the floating toolbar is drawn over the editor region, so a host at the
  default inset sits under the pill. Lifted by the pill and the home indicator.
*/
jest.mock("../features/design/components/Toast", () => {
  const actual = jest.requireActual("../features/design/components/Toast") as Record<string, unknown> & {
    ToastHost: (p: object) => ReactElement;
  };
  const { createElement: h } = require("react") as typeof import("react");
  return {
    ...actual,
    ToastHost: (mockProps: object) => {
      const { layout: mockLayout } = require("../features/design/tokens/layout") as typeof import("../features/design/tokens/layout");
      const mockPhone = (globalThis as { innerWidth?: number }).innerWidth! < 880;
      return h(actual.ToastHost, { ...mockProps, bottomInset: mockPhone ? mockLayout.bottomBarHeight + 34 : 0 } as never);
    },
  };
});

const { StyleSheet } = require("react-native") as { StyleSheet: { getSheet(): { textContent: string } } };
const ConsoleLayout = (require("../app/(app)/console/_layout") as { default: () => unknown }).default;
const { ThemeProvider } = require("../features/design/theme") as {
  ThemeProvider: (props: { scheme: "light" | "dark"; children: unknown }) => unknown;
};
const { FRAMES, SUGGESTIONS, SWEEP_SUGGESTIONS } = require("./autoOrganize/frames") as typeof import("./autoOrganize/frames");

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
const QUIET_CSS = `[data-testid="presence-chip"] { display: none !important; }
.cm-scroller > .cm-content.cm-lineWrapping { flex-shrink: 1; min-width: 0; max-width: 100%; }`;

function page(title: string, body: string, css: string, size: { width: number; height: number }, ground: string, scroll: boolean): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>${scroll ? '<meta name="ao-scroll" content="settings">' : ""}
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

type Density = "phone" | "desktop";
type Scheme = "light" | "dark";

async function shoot(frame: (typeof FRAMES)[number], density: Density, scheme: Scheme): Promise<void> {
  const size = density === "phone" ? PHONE : DESKTOP;
  mockInsets.top = density === "phone" ? 59 : 0;
  mockInsets.bottom = density === "phone" ? 34 : 0;
  stampViewport(size.width, size.height);
  document.body.innerHTML = "";
  mockUrl.pathname = frame.at?.pathname ?? "/console/@seyi";
  mockUrl.note = frame.at?.note;
  mockUrl.settings = frame.at?.settings;
  mockSettingsBodies = frame.settings ?? {};
  mockFrame.organizer = frame.organizer?.(density);
  mockFrame.list = frame.id.startsWith("02") ? SWEEP_SUGGESTIONS : SUGGESTIONS;
  mockFrame.activity = frame.activity;
  mockFrame.activityOpen = frame.activityOpen && density === "desktop";

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  const render = () =>
    act(() => {
      root.render(createElement(ThemeProvider as never, { scheme } as never, createElement(ConsoleLayout as never)));
    });
  const settle = async () => {
    for (let pass = 0; pass < 6; pass += 1) render();
  };
  await settle();
  if (frame.prepare) await frame.prepare({ density, settle, press });
  await settle();
  if (frame.hover && density === "desktop") {
    const row = document.querySelector(`[data-testid="organizer-suggestion-${frame.hover}"]`);
    act(() => {
      row?.dispatchEvent(new MouseEvent("pointerover", { bubbles: true }));
    });
  }
  const text = document.body.textContent ?? "";
  for (const needle of frame.assert ?? []) {
    if (!text.includes(needle)) throw new Error(`${frame.id} ${density}: missing "${needle}"`);
  }
  const injected = [...document.head.querySelectorAll("style")].map((n) => n.textContent ?? "").join("\n");
  const file = resolve(OUT, `${frame.id}-${density}-${scheme}.html`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(
    file,
    page(
      `${frame.id} ${density} ${scheme}`,
      document.body.innerHTML,
      `${StyleSheet.getSheet().textContent}\n${injected}`,
      size,
      scheme === "dark" ? "#100F0E" : "#FFFDF9",
      frame.scroll === true,
    ),
    "utf8",
  );
  act(() => root.unmount());
  container.remove();
  mockSettingsBodies = {};
}

const only = process.env.AO_ONLY?.split(",");

describe("auto-organize built shots", () => {
  for (const frame of FRAMES) {
    if (only && !only.includes(frame.id)) continue;
    for (const density of frame.sizes ?? (["desktop", "phone"] as const)) {
      for (const scheme of frame.schemes ?? (["light"] as const)) {
        test(`${frame.id} — ${density}, ${scheme}`, async () => {
          await shoot(frame, density, scheme);
          expect(true).toBe(true);
        });
      }
    }
  }
});
