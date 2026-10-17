/**
 * @jest-environment jsdom
 */

/**
 * Screenshots of "Recent shows only what you did" (boards 1 to 4, option A,
 * Dev2 2026-10-17, project file `meeting-2026-10-17/recent/`): phone Home's
 * Recent saying what you did, ⌘K's Recent with its small print, and the
 * line under a note's name when an AI changed it last, at 1440 and 390.
 * `trash-shots.ts`'s technique. Every value is invented; long names are
 * deliberate, to test truncation.
 *
 *     pnpm exec jest --testMatch '**\/scripts/recent-shots.ts' --testPathIgnorePatterns '[]'
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OUT = resolve(process.env.RECENT_SHOTS_DIR ?? "/tmp/recent-shots");

const MINUTE = 60 * 1000;
const NOW = Date.now();

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
      void fnName(ref);
      return undefined;
    },
    useQueries: () => ({}),
    useMutation: () => mockStableNoop,
    useAction: () => mockStableNoop,
  };
});

/* -------------------------------------------------------------------------- */
/* Rendering and writing.                                                      */
/* -------------------------------------------------------------------------- */

const { StyleSheet, View } = require("react-native") as {
  StyleSheet: { getSheet(): { textContent: string } };
  View: unknown;
};
const { ThemeProvider } = require("../features/design/theme") as typeof import("../features/design/theme");
const { PhoneHome } = require("../features/console/home/PhoneHome") as typeof import("../features/console/home/PhoneHome");
const { Palette } = require("../features/design/components/Palette") as typeof import("../features/design/components/Palette");
const { LastChangeLine } = require("../features/console/files/noteEditor/chips/LastChangeLine") as typeof import("../features/console/files/noteEditor/chips/LastChangeLine");
const { accountRecentItems } = require("../features/console/files/palette") as typeof import("../features/console/files/palette");
const { recentLabel } = require("../features/console/home/homeModel") as typeof import("../features/console/home/homeModel");
const { Text } = require("../features/design/components/Text") as typeof import("../features/design/components/Text");

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
  container.style.width = `${viewport.width}px`;
  container.style.height = `${viewport.height}px`;
  document.body.appendChild(container);
  root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  await act(async () => {
    root!.render(createElement(ThemeProvider, { scheme: "light", children: node }));
  });
}

function page(title: string, body: string, css: string, width: number, height: number): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  html, body { margin: 0; padding: 0; }
  body { -webkit-font-smoothing: antialiased; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  #shot { width: ${width}px; height: ${height}px; overflow: hidden; position: relative; }
</style>
<style id="rnw">${css}</style>
</head><body><div id="shot">${body}</div></body></html>`;
}

/** Writes the mounted screen as a self-contained page at one viewport. */
function write(name: string, width: number, height: number): void {
  const injected = [...document.head.querySelectorAll("style")]
    .map((node) => node.textContent ?? "")
    .join("\n");
  const css = `${StyleSheet.getSheet().textContent}\n${injected}`;
  const file = resolve(OUT, `${name}.html`);
  mkdirSync(dirname(file), { recursive: true });
  expect(container).not.toBeNull();
  // The body, not the container: ⌘K draws in a modal portalled beside it.
  writeFileSync(file, page(name, document.body.innerHTML, css, width, height));
}

/**
 * The page as the reader sees it: on a desktop, the sidebar in its column with
 * the page beside it (as `ConsoleFrame` draws it); on a phone, the page alone,
 * since a phone has no sidebar to stand beside.
 */
function shell(main: ReactElement, sidebar: ReactElement | null, viewport: Viewport): ReactElement {
  const column = createElement(
    View as never,
    { style: { width: 264, height: "100%", borderRightWidth: 1, borderRightColor: "rgba(0,0,0,0.08)" } },
    sidebar,
  );
  return createElement(
    View as never,
    { style: { flexDirection: "row", width: "100%", height: viewport.height, overflow: "hidden" } },
    viewport.name === "desktop" ? column : null,
    createElement(View as never, { style: { flex: 1, minWidth: 0, height: "100%" } }, main),
  );
}

/** One board at both widths: reset the fakes, mount, run the steps, write. */
async function board(
  name: string,
  node: (viewport: Viewport) => ReactElement,
): Promise<void> {
  for (const viewport of VIEWPORTS) {
    await mount(node(viewport), viewport);
    await act(async () => {});
    write(`${name}-${viewport.name}`, viewport.width, viewport.height);
    await act(async () => root!.unmount());
    container!.remove();
    root = null;
    container = null;
  }
}

/* -------------------------------------------------------------------------- */
/* The boards.                                                                 */
/* -------------------------------------------------------------------------- */

const NOTES = [
  { path: "1-projects/meeting-rhythm/assigned-cadence.md", title: "Assigned cadence", lede: "Weekly 1:1s with each chapter lead", updatedAt: NOW - 20 * MINUTE },
  { path: "todo.md", title: "todo", lede: null, updatedAt: NOW - 5 * MINUTE },
  {
    path: "1-projects/all-team/2027-vision-overview-for-the-new-york-and-dmv-chapter-announcements.md",
    title: "2027 vision overview for the New York and DMV chapter announcements",
    lede: "What everyone hears first",
    updatedAt: NOW - 3 * 24 * 60 * MINUTE,
  },
  { path: "2-areas/agent-todos/claude-security-review.md", title: "Claude security review", lede: null, updatedAt: NOW - 2 * MINUTE },
].map((note) => ({ ...note, tags: [] as string[] }));

const RECENTS = [
  { path: NOTES[0].path, at: NOW - 35 * MINUTE, kind: "edited" as const },
  { path: NOTES[1].path, at: NOW - 67 * MINUTE, kind: "opened" as const },
  { path: NOTES[2].path, at: NOW - 2 * 24 * 60 * MINUTE, kind: "edited" as const },
];

const home = () =>
  createElement(PhoneHome, {
    title: "@seyi",
    source: { notes: NOTES, folders: ["1-projects", "2-areas", "1-projects/meeting-rhythm", "1-projects/all-team", "2-areas/agent-todos"], shared: new Set<string>() },
    pins: [],
    opened: [],
    recents: RECENTS,
    onOpen: () => {},
  });

const palette = (viewport: Viewport) =>
  shell(
    createElement(Palette, {
      items: [],
      placeholder: "Search",
      recent: accountRecentItems(RECENTS, [], (row) => recentLabel(row.kind, row.at, NOW)),
      emptyHeading: "Recent",
      emptyNote: "Notes you opened or typed in, on any device.",
      onChoose: () => {},
      onDismiss: () => {},
    }),
    null,
    viewport,
  );

const note = (viewport: Viewport) =>
  shell(
    createElement(
      View as never,
      { style: { paddingTop: 32, paddingHorizontal: viewport.name === "phone" ? 20 : 120, gap: 8 } },
      createElement(Text, { variant: "noteTitle" }, "Claude security review"),
      createElement(LastChangeLine, { text: "Claude changed this at 9:31", onOpen: () => {} }),
      createElement(Text, null, "Weekly pass over the gateway's auth and tenant checks."),
      createElement(View as never, { style: { height: 16 } }),
      createElement(Text, { variant: "noteTitle" }, "Interview questions for the senior editor role and the follow-up panel"),
      createElement(LastChangeLine, { text: "@kola-ade-from-the-riverside-studio-editorial-collective's ChatGPT changed this on Monday", onOpen: () => {} }),
    ),
    null,
    viewport,
  );

describe("recent shots", () => {
  test("01 phone Home's Recent says what you did", async () => {
    await board("01-home", () => home());
  }, 120_000);

  test("02 ⌘K's Recent is the same list", async () => {
    await board("02-palette", palette);
  }, 120_000);

  test("03 a note says who changed it last", async () => {
    await board("03-note", note);
  }, 120_000);
});
