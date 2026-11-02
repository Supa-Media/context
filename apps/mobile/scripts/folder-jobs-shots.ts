/**
 * @jest-environment jsdom
 */

/**
 * Screenshots of built-in folders found by job (system folders boards 8 and 9,
 * owner, 2026-10-17, project file `meeting-2026-10-17/system-folders/`): the
 * sidebar tree with the Inbox renamed Capture and Resources renamed Library,
 * each drawing its job's icon, beside Capture's own page with its paper tile
 * and "Built-in Inbox." line, at 1440; the phone's Folders page and Capture's
 * page at 390. Light and dark. `recent-shots.ts`'s technique. Every value is
 * invented; long names are deliberate, to test truncation.
 *
 *     pnpm exec jest --testMatch '**\/scripts/folder-jobs-shots.ts' --testPathIgnorePatterns '[]'
 *     PW_EXE=<chromium> node scripts/capture-trash-shots.mjs <html-dir> <png-dir>
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { act, createElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OUT = resolve(process.env.FOLDER_JOBS_SHOTS_DIR ?? "/tmp/folder-jobs-shots");

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
const { FolderRow } = require("../features/console/files/FolderRow") as typeof import("../features/console/files/FolderRow");
const { FolderHead } = require("../features/console/files/folderPage/Head") as typeof import("../features/console/files/folderPage/Head");
const { PhoneHome } = require("../features/console/home/PhoneHome") as typeof import("../features/console/home/PhoneHome");
const { jobIconMarker } = require("../features/console/files/jobIcons/marker") as typeof import("../features/console/files/jobIcons/marker");
const { setJobFoldersNow } = require("../features/console/files/jobIcons/jobFoldersNow") as typeof import("../features/console/files/jobIcons/jobFoldersNow");

type Scheme = "light" | "dark";
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

async function shoot(name: string, viewport: Viewport, scheme: Scheme, node: () => ReactElement): Promise<void> {
  stampViewport(viewport.width, viewport.height);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  await act(async () => {
    root!.render(createElement(ThemeProvider, { scheme, children: node() }));
  });
  await act(async () => {});
  const injected = [...document.head.querySelectorAll("style")].map((style) => style.textContent ?? "").join("\n");
  const css = `${StyleSheet.getSheet().textContent}\n${injected}`;
  const file = resolve(OUT, `${name}-${scheme}-${viewport.name}.html`);
  mkdirSync(dirname(file), { recursive: true });
  expect(container.querySelector("svg path")).not.toBeNull();
  writeFileSync(file, page(name, document.body.innerHTML, css, viewport.width, viewport.height));
  await act(async () => root!.unmount());
  container.remove();
  root = null;
  container = null;
}

/* -------------------------------------------------------------------------- */
/* The workspace: Maya's, Inbox renamed Capture, Resources renamed Library.    */
/* -------------------------------------------------------------------------- */

const JOBS: Record<string, Parameters<typeof jobIconMarker>[0]> = {
  Capture: "inbox",
  "1-projects": "projects",
  "2-areas": "areas",
  Library: "resources",
  "4-clients": "clients",
  website: "website",
  "9-archive": "archive",
  "Capture/meetings": "meetings",
};
const EMOJI: Record<string, string> = {
  "1-projects/harbor-linen": "📁",
  "1-projects/studio-lease": "🧵",
  "Recipes and kitchen experiments from the allotment": "🍳",
};
const iconOf = (path: string) => (JOBS[path] === undefined ? (EMOJI[path] ?? null) : jobIconMarker(JOBS[path]!));

type Row = Parameters<typeof FileTree>[0]["rows"][number];
function row(path: string, label: string, depth = 0, extra: Partial<Row> = {}): Row {
  return {
    kind: "folder",
    key: path,
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    label,
    depth,
    expanded: false,
    selected: false,
    markerIsDefault: true,
    readOnly: false,
    ...extra,
  };
}

const TREE: Row[] = [
  row("Capture", "Capture", 0, { selected: true }),
  row("1-projects", "Projects", 0, { expanded: true }),
  row("1-projects/harbor-linen", "Harbor Linen spring wholesale reorder", 1),
  row("1-projects/studio-lease", "New studio lease", 1),
  row("2-areas", "Areas"),
  row("Library", "Library"),
  row("4-clients", "Clients"),
  row("website", "Website"),
  row("Recipes and kitchen experiments from the allotment", "Recipes and kitchen experiments from the allotment"),
  row("Taxes", "Taxes"),
  row("9-archive", "Archive"),
];

function entry(path: string, name: string, kind: "file" | "folder" = "file") {
  return { kind, path, name, visibility: "private" as const, inherited: "private" as const, exception: false, readOnly: false };
}

const CAPTURE = [
  entry("Capture/meetings", "meetings", "folder"),
  entry("Capture/call-with-priya.md", "Call with Priya about the linen reorder and the delayed March shipment.md"),
  entry("Capture/quarry-wool.md", "Fwd: Quarry Wool Works price list 2027.md"),
  entry("Capture/pop-up.md", "Idea: pop-up shop with the bakery on Grand Street.md"),
];

function Backdrop({ children, tone, height }: { children?: ReactNode; tone: "chrome" | "surface"; height?: number }) {
  const colors = useColors();
  return createElement(
    View as never,
    { style: { flex: 1, height: height ?? "100%", backgroundColor: tone === "chrome" ? colors.chrome : colors.surface } },
    children,
  );
}

function capturePage(large: boolean) {
  return createElement(
    View as never,
    { style: { paddingTop: large ? 24 : 40, paddingHorizontal: large ? 16 : 56, gap: 16 } },
    createElement(FolderHead, { title: "Capture", icon: iconOf("Capture"), switcher: null, large }),
    createElement(
      View as never,
      { style: { gap: 0 } },
      ...CAPTURE.map((item) =>
        createElement(FolderRow, {
          key: item.path,
          row: item,
          onSelect: () => {},
          folderIcon: item.kind === "folder" || item.path.endsWith(".md") ? iconOf(item.path) : null,
          ...(large ? { card: true } : {}),
        }),
      ),
    ),
  );
}

const desktop = () =>
  createElement(
    View as never,
    { style: { flexDirection: "row", width: DESKTOP.width, height: DESKTOP.height } },
    createElement(
      View as never,
      { style: { width: 264, height: "100%" } },
      createElement(
        Backdrop,
        { tone: "chrome" },
        createElement(
          View as never,
          { style: { paddingTop: 12, paddingHorizontal: 8 } },
          createElement(FileTree, {
            rows: TREE,
            onSelect: () => {},
            onToggle: () => {},
            workspaceId: "ws-maya",
            iconOf,
            onIconPress: () => {},
          }),
        ),
      ),
    ),
    createElement(View as never, { style: { flex: 1, height: "100%" } }, createElement(Backdrop, { tone: "surface" }, capturePage(false))),
  );

const phoneFolders = () =>
  createElement(
    Backdrop,
    { tone: "surface", height: PHONE.height },
    createElement(PhoneHome, {
      title: "Maya's notes",
      source: {
        notes: [],
        folders: TREE.filter((each) => each.depth === 0).map((each) => each.path),
        shared: new Set<string>(),
      },
      pins: [],
      opened: [],
      recents: [],
      onOpen: () => {},
      iconOf,
    }),
  );

const phoneCapture = () => createElement(Backdrop, { tone: "surface", height: PHONE.height }, capturePage(true));

describe("folder jobs shots", () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`01 the sidebar with Capture and its page, ${scheme}`, async () => {
      await shoot("01-tree", DESKTOP, scheme, desktop);
    }, 120_000);

    test(`02 the phone's Folders page, ${scheme}`, async () => {
      // The Inbox is the phone's first page, not a row on Folders (`PhoneHome`).
      setJobFoldersNow({ inbox: "Capture", archive: "9-archive" });
      await shoot("02-phone-folders", PHONE, scheme, phoneFolders);
    }, 120_000);

    test(`03 Capture's page on a phone, ${scheme}`, async () => {
      await shoot("03-phone-capture", PHONE, scheme, phoneCapture);
    }, 120_000);
  }
});
