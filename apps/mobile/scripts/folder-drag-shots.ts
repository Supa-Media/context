/**
 * @jest-environment jsdom
 */

/**
 * Screenshots of dragging folders in the sidebar tree (`treeDrop.ts`; system
 * folders, owner, 2026-10-18, project file `meeting-2026-10-17/system-folders/`):
 * at 1440 the insertion line between two top-level folders (a reorder), the
 * line inside Projects at its indent (a folder placed into that level), and
 * the wash on a folder a drop goes into; at 390 the phone's Folders page in
 * the saved order rather than by name. Light and dark. `folder-jobs-shots.ts`'s
 * technique. Every value is invented; long names are deliberate, to test
 * truncation.
 *
 *     pnpm exec jest --testMatch '**\/scripts/folder-drag-shots.ts' --testPathIgnorePatterns '[]'
 *     PW_EXE=<chromium> node scripts/capture-trash-shots.mjs <html-dir> <png-dir>
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { act, createElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OUT = resolve(process.env.FOLDER_DRAG_SHOTS_DIR ?? "/tmp/folder-drag-shots");

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
const { Text } = require("../features/design/components/Text") as typeof import("../features/design/components/Text");
const { FileTree } = require("../features/console/files/FileTree") as typeof import("../features/console/files/FileTree");
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

function Backdrop({ children, tone, height }: { children?: ReactNode; tone: "chrome" | "surface"; height?: number }) {
  const colors = useColors();
  return createElement(
    View as never,
    { style: { flex: 1, height: height ?? "100%", backgroundColor: tone === "chrome" ? colors.chrome : colors.surface } },
    children,
  );
}

type DropAt = { path: string; zone: "above" | "below" | "into" };

/** What the note pane would say while the drag is held: the rule the drop follows. */
function Caption({ text }: { text: string }) {
  return createElement(
    View as never,
    { style: { paddingTop: 40, paddingHorizontal: 56 } },
    createElement(Text, { variant: "meta" }, text),
  );
}

const desktop = (dropTarget: DropAt, caption: string) => () =>
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
            dropTarget,
          }),
        ),
      ),
    ),
    createElement(View as never, { style: { flex: 1, height: "100%" } }, createElement(Backdrop, { tone: "surface" }, createElement(Caption, { text: caption }))),
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
        // Taxes and the long Recipes folder dragged up under Projects in the sidebar.
        folderFacts: new Map<string, { role?: string; order?: number }>([
          ["Capture", { role: "inbox", order: 0 }],
          ["1-projects", { role: "projects", order: 10 }],
          ["Taxes", { order: 20 }],
          ["Recipes and kitchen experiments from the allotment", { order: 30 }],
          ["2-areas", { role: "areas", order: 40 }],
          ["Library", { role: "resources", order: 50 }],
          ["4-clients", { role: "clients", order: 60 }],
          ["website", { role: "website", order: 70 }],
          ["9-archive", { role: "archive", order: 80 }],
        ]),
      },
      pins: [],
      opened: [],
      recents: [],
      onOpen: () => {},
      iconOf,
    }),
  );

describe("folder drag shots", () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`04 a reorder: the line between two top-level folders, ${scheme}`, async () => {
      await shoot(
        "04-drag-reorder",
        DESKTOP,
        scheme,
        desktop({ path: "2-areas", zone: "above" }, "Dropping here puts the folder between Projects and Areas."),
      );
    }, 120_000);

    test(`04 a place in another level: the line at Projects' indent, ${scheme}`, async () => {
      await shoot(
        "04-drag-place",
        DESKTOP,
        scheme,
        desktop(
          { path: "1-projects/studio-lease", zone: "below" },
          "Dropping here moves the folder into Projects, after New studio lease.",
        ),
      );
    }, 120_000);

    test(`04 a nest: the wash on the folder it goes into, ${scheme}`, async () => {
      await shoot(
        "04-drag-into",
        DESKTOP,
        scheme,
        desktop({ path: "Recipes and kitchen experiments from the allotment", zone: "into" }, "Dropping here puts the folder inside it."),
      );
    }, 120_000);

    test(`04 the phone's Folders page in the saved order, ${scheme}`, async () => {
      setJobFoldersNow({ inbox: "Capture", archive: "9-archive" });
      await shoot("04-drag-phone-folders", PHONE, scheme, phoneFolders);
    }, 120_000);
  }
});
