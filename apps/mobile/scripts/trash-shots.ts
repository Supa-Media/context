/**
 * @jest-environment jsdom
 */

/**
 * Screenshots of the Trash page (design A, Dev2 2026-10-17, project file
 * `trash-page/`): the page beside the tree with its Trash row, the empty
 * trash, and an open trashed note's erase line, at 1440 and 390, for the
 * design check. `shared-grant-shots.ts`'s technique: the shipped components,
 * rendered by react-dom into a real DOM, written as self-contained `.html`, and
 * photographed by Playwright (`capture-chaos-shots.mjs`).
 *
 * Every value is invented. Long names are deliberate, to test truncation.
 *
 *     pnpm exec jest --testMatch '**\/scripts/trash-shots.ts' --testPathIgnorePatterns '[]'
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { act, createElement, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OUT = resolve(process.env.TRASH_SHOTS_DIR ?? "/tmp/trash-shots");

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

type Row = Record<string, unknown>;

function item(path: string, kind: "file" | "folder", daysAgo: number, by: { byYou: boolean; byName: string | null }, notes = 1): Row {
  const at = NOW - daysAgo * DAY;
  return { trash: `.context/trash/stamp-${path}/${path}`, path, kind, at, eraseAt: at + 30 * DAY, notes, ...by };
}

const ITEMS: Row[] = [
  item("1-projects/q3-vendor-shortlist.md", "file", 27, { byYou: true, byName: null }),
  item("2-areas/old-onboarding", "folder", 25, { byYou: false, byName: "@claude" }, 12),
  item("1-projects/offsite-plan.md", "file", 0, { byYou: true, byName: null }),
  item(
    "1-projects/hiring/interview-questions-for-the-senior-editor-role-and-the-follow-up-panel-with-the-whole-team.md",
    "file",
    2,
    { byYou: false, byName: "@kola-ade-from-the-riverside-studio-editorial-collective" },
  ),
  item("3-resources/dinner-ideas.md", "file", 15, { byYou: false, byName: "@ana" }),
];

type Fake = { listing: Row | undefined };
const fakeDefaults = (): Fake => ({ listing: { items: ITEMS, more: false, keepDays: 30 } });
const mockShots: Fake = fakeDefaults();

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
      return fnName(ref).endsWith("listTrash") ? mockShots.listing : undefined;
    },
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
const { TrashPage } = require("../features/console/trash/TrashPage") as typeof import("../features/console/trash/TrashPage");
const { TrashRouteProvider } = require("../features/console/trash/TrashRouteContext") as typeof import("../features/console/trash/TrashRouteContext");
const { TrashedByline, InTrashPill } = require("../features/console/files/noteEditor/trashed") as typeof import("../features/console/files/noteEditor/trashed");
const { DocumentPage } = require("../features/console/panes/browsePane/DocumentPage") as typeof import("../features/console/panes/browsePane/DocumentPage");
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
  writeFileSync(file, page(name, container!.innerHTML, css, width, height));
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
  fake: Partial<Fake> = {},
): Promise<void> {
  for (const viewport of VIEWPORTS) {
    Object.assign(mockShots, fakeDefaults(), fake);
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

const ROUTE = { open: true, workspaceId: "ws-test", openTrash: () => {}, closeTrash: () => {} };

/** The tree's foot. Its Trash row went with the pointer layout's tree (2026-10-18), so it is empty. */
const sidebar = () => createElement(View as never, { style: { flex: 1, justifyContent: "flex-end", padding: 8 } });

const trashPage = (viewport: Viewport) =>
  createElement(
    TrashRouteProvider,
    { value: ROUTE },
    shell(
      createElement(DocumentPage, null, createElement(TrashPage, { workspaceId: "ws-test", compact: viewport.name === "phone", onOpen: () => {}, onClose: () => {} })),
      sidebar(),
      viewport,
    ),
  );

const trashedNote = (viewport: Viewport) =>
  shell(
    createElement(
      DocumentPage,
      null,
      createElement(
        View as never,
        { style: { paddingTop: 32, gap: 12 } },
        createElement(InTrashPill, { style: { alignSelf: "flex-start" } }),
        createElement(Text, { variant: "noteTitle" }, "Interview questions for the senior editor role and the follow-up panel"),
        createElement(TrashedByline, {
          trashed: { byYou: false, byName: "@kola-ade-from-the-riverside-studio", at: NOW - 3 * DAY, eraseAt: NOW + 27 * DAY },
        }),
      ),
    ),
    null,
    viewport,
  );

describe("trash shots", () => {
  test("01 the Trash page beside the tree", async () => {
    await board("01-trash-page", trashPage);
  }, 120_000);

  test("02 an empty trash", async () => {
    await board("02-trash-empty", trashPage, { listing: { items: [], more: false, keepDays: 30 } });
  }, 120_000);

  test("03 an open trashed note says when it goes", async () => {
    await board("03-trashed-note", trashedNote);
  }, 120_000);
});
