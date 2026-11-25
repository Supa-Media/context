/**
 * @jest-environment jsdom
 */

/**
 * Screenshot of the sidebar's New menu in a shared workspace with no data
 * folder yet: "Data source…" with "Makes a data folder the first time" under
 * it, to compare with the data sources artboard 13 (`13-empty-plus-desktop`).
 * `folder-jobs-shots.ts`'s technique. Every value is invented.
 *
 *     DATA_SOURCE_SHOTS_DIR=<html-dir> pnpm exec jest --testMatch '**\/scripts/data-source-menu-shots.ts' --testPathIgnorePatterns '[]'
 *     PW_EXE=<chromium> node scripts/capture-trash-shots.mjs <html-dir> <png-dir>
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OUT = resolve(process.env.DATA_SOURCE_SHOTS_DIR ?? "/tmp/data-source-shots");

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
}));

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {}, back: () => {}, setParams: () => {} }),
  useLocalSearchParams: () => ({}),
  useGlobalSearchParams: () => ({}),
  usePathname: () => "/",
  Redirect: () => null,
  Slot: () => null,
}));

// The pointer layout's popover (`Menu.web.tsx`), which jest would otherwise resolve to the phone's sheet.
jest.mock("../features/design/components/Menu", () => jest.requireActual("../features/design/components/Menu.web"));

const mockStableNoop = async () => ({});

jest.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useQuery: () => undefined,
  useQueries: () => ({}),
  useMutation: () => mockStableNoop,
  useAction: () => mockStableNoop,
}));

const { StyleSheet, View } = require("react-native") as {
  StyleSheet: { getSheet(): { textContent: string } };
  View: unknown;
};
const { ThemeProvider, useColors } = require("../features/design/theme") as typeof import("../features/design/theme");
const { FileTree } = require("../features/console/files/FileTree") as typeof import("../features/console/files/FileTree");
const { ExplorerToolbar } = require("../features/console/files/explorer/ExplorerToolbar") as typeof import("../features/console/files/explorer/ExplorerToolbar");
const { jobIconMarker } = require("../features/console/files/jobIcons/marker") as typeof import("../features/console/files/jobIcons/marker");

type Scheme = "light" | "dark";
const WIDTH = 1440;
const HEIGHT = 900;

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  if (container !== null) container.remove();
  root = null;
  container = null;
});

const JOBS: Record<string, Parameters<typeof jobIconMarker>[0]> = {
  inbox: "inbox",
  projects: "projects",
  areas: "areas",
  resources: "resources",
  archive: "archive",
};
const iconOf = (path: string) => (JOBS[path] === undefined ? null : jobIconMarker(JOBS[path]!));

type Row = Parameters<typeof FileTree>[0]["rows"][number];
function row(path: string, depth = 0, extra: Partial<Row> = {}): Row {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return { kind: "folder", key: path, path, name, label: name, depth, expanded: false, selected: false, markerIsDefault: true, readOnly: false, ...extra };
}

const TREE: Row[] = [
  row("inbox"),
  row("projects"),
  row("areas", 0, { expanded: true, selected: true }),
  row("areas/engineering", 1),
  row("areas/finance", 1),
  row("areas/design", 1),
  row("resources"),
  row("archive"),
];

const folder = (path: string) => ({
  kind: "folder" as const,
  path,
  name: path,
  role: JOBS[path] ?? null,
  visibility: "team" as const,
  inherited: "team" as const,
  exception: false,
  readOnly: false,
});

const files = {
  canEdit: true,
  listings: {
    "": { path: "", folderDefault: "team" as const, truncated: false, manifestUsable: true, entries: Object.keys(JOBS).map(folder) },
  },
  createUntitled: () => {},
  createFolder: () => {},
  select: () => true,
  collapseAll: () => {},
  setFolderSort: () => {},
} as unknown as Parameters<typeof ExplorerToolbar>[0]["files"];

function Backdrop({ children }: { children?: ReactNode }) {
  const colors = useColors();
  return createElement(View as never, { style: { flexDirection: "row", width: WIDTH, height: HEIGHT, backgroundColor: colors.surface } }, children);
}

function Sidebar() {
  const colors = useColors();
  return createElement(
    View as never,
    { style: { width: 264, height: "100%", backgroundColor: colors.chrome, paddingHorizontal: 8 } },
    createElement(ExplorerToolbar, {
      files,
      selectedFolder: "areas",
      setDialog: () => {},
      workspaceSort: null,
      query: "",
      closeFilter: () => {},
      dataSource: true,
    }),
    createElement(FileTree, { rows: TREE, onSelect: () => {}, onToggle: () => {}, workspaceId: "ws-acme", iconOf, onIconPress: () => {} }),
  );
}

function page(body: string, css: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>13 plus menu</title>
<style>
  html, body { margin: 0; padding: 0; }
  body { -webkit-font-smoothing: antialiased; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  #shot { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; position: relative; }
</style>
<style id="rnw">${css}</style>
</head><body><div id="shot">${body}</div></body></html>`;
}

/** A desktop window, so the menu is the pointer layout's popover (`densityFor`), not the narrow window's sheet. */
function stampViewport(): void {
  Object.defineProperty(document.documentElement, "clientWidth", { value: WIDTH, configurable: true });
  Object.defineProperty(document.documentElement, "clientHeight", { value: HEIGHT, configurable: true });
  Object.defineProperty(window, "innerWidth", { value: WIDTH, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: HEIGHT, configurable: true });
  window.dispatchEvent(new Event("resize"));
}

async function shoot(scheme: Scheme): Promise<void> {
  stampViewport();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  await act(async () => {
    root!.render(createElement(ThemeProvider, { scheme, children: createElement(Backdrop, null, createElement(Sidebar)) }));
  });
  const plus = document.body.querySelector('[data-testid="explorer-new"]')!;
  await act(async () => {
    for (const type of ["mousedown", "mouseup", "click"]) plus.dispatchEvent(new MouseEvent(type, { bubbles: true }));
  });
  await act(async () => {});
  expect(document.body.querySelector('[data-testid="explorer-data-source"]')).not.toBeNull();
  const injected = [...document.head.querySelectorAll("style")].map((style) => style.textContent ?? "").join("\n");
  const css = `${StyleSheet.getSheet().textContent}\n${injected}`;
  const file = resolve(OUT, `13-plus-menu-${scheme}-desktop.html`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, page(document.body.innerHTML, css));
}

describe("data source menu shots", () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`13 the + menu with Data source…, ${scheme}`, async () => {
      await shoot(scheme);
    }, 120_000);
  }
});
