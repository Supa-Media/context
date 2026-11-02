/**
 * @jest-environment jsdom
 */

/**
 * Screenshots of the system folders' ink (owner, 2026-10-26: "when we create
 * new system folders we give it a freakin icon, also arent all the non root
 * folders supposed to be colored black"): the sidebar with the Inbox's and
 * Tex's own folders drawn (chats, groups and handbacks included) in the text
 * colour, the top-level built-in folders in Tex blue, and a Website nested in
 * Areas in the text colour too. At 1440 and 390, light and dark.
 * `context-icons-shots.ts`'s technique. Every value is invented.
 *
 *     pnpm exec jest --testMatch '**\/scripts/system-folder-ink-shots.ts' --testPathIgnorePatterns '[]'
 *     PW_EXE=<chromium> node scripts/capture-trash-shots.mjs <html-dir> <png-dir>
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { act, createElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OUT = resolve(process.env.SYSTEM_FOLDER_INK_SHOTS_DIR ?? "/tmp/system-folder-ink-shots");

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
const { defaultFolderIcon } = require("@context/shared/src/folderIcons.cjs") as typeof import("@context/shared/src/folderIcons.cjs");
const { texPartIconUnder } = require("../features/console/files/jobIcons/folderJobs") as typeof import("../features/console/files/jobIcons/folderJobs");
const { jobIconMarker } = require("../features/console/files/jobIcons/marker") as typeof import("../features/console/files/jobIcons/marker");

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

async function shoot(name: string, viewport: Viewport, scheme: Scheme, node: () => ReactElement, then?: () => void): Promise<void> {
  stampViewport(viewport.width, viewport.height);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  await act(async () => {
    root!.render(createElement(ThemeProvider, { scheme, children: node() }));
  });
  await act(async () => {});
  if (then !== undefined) {
    act(then);
    await act(async () => {});
  }
  const injected = [...document.head.querySelectorAll("style")].map((style) => style.textContent ?? "").join("\n");
  const css = `${StyleSheet.getSheet().textContent}\n${injected}`;
  const file = resolve(OUT, `${name}-${scheme}-${viewport.name}.html`);
  mkdirSync(dirname(file), { recursive: true });
  expect(document.body.querySelector(`[data-testid="folder-icon-scroll"], svg path`)).not.toBeNull();
  writeFileSync(file, page(name, document.body.innerHTML, css, viewport.width, viewport.height));
  await act(async () => root!.unmount());
  container.remove();
  root = null;
  container = null;
}

/* -------------------------------------------------------------------------- */
/* The workspace in the owner's screenshots.                                  */
/* -------------------------------------------------------------------------- */

const JOBS: Record<string, Parameters<typeof jobIconMarker>[0]> = {
  inbox: "inbox",
  projects: "projects",
  areas: "areas",
  "areas/website": "website",
  resources: "resources",
  tex: "tex",
  archive: "archive",
};
const jobMap = new Map(Object.entries(JOBS));
const iconOf = (path: string) =>
  JOBS[path] !== undefined ? jobIconMarker(JOBS[path]!, path.includes("/")) : (texPartIconUnder(jobMap, path) ?? defaultFolderIcon(path));

type Row = Parameters<typeof FileTree>[0]["rows"][number];
function row(path: string, depth = 0, extra: Partial<Row> = {}): Row {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return {
    kind: "folder",
    key: path,
    path,
    name,
    label: name.replace(/\.md$/, ""),
    depth,
    expanded: false,
    selected: false,
    markerIsDefault: true,
    readOnly: false,
    ...extra,
  };
}

const TREE: Row[] = [
  row("inbox", 0, { expanded: true }),
  row("inbox/email", 1),
  row("inbox/forms", 1),
  row("inbox/meetings", 1),
  row("inbox/memories", 1),
  row("inbox/plans", 1),
  row("projects"),
  row("areas", 0, { expanded: true }),
  row("areas/website", 1),
  row("areas/health and the long list of appointments to book before winter", 1),
  row("resources"),
  row("tex", 0, { expanded: true }),
  row("tex/attention", 1),
  row("tex/chats", 1),
  row("tex/dreams", 1),
  row("tex/groups", 1),
  row("tex/handbacks", 1),
  row("tex/heartbeat", 1),
  row("tex/housekeeping", 1, { selected: true }),
  row("tex/routines", 1, { expanded: true }),
  row("tex/routines/every-day", 2),
  row("tex/skills", 1),
  row("tex/transcripts", 1),
  row("tex/about.md", 1, { kind: "file" }),
  row("tex/jobs.md", 1, { kind: "file" }),
  row("archive"),
];

function Backdrop({ children, tone, height }: { children?: ReactNode; tone: "chrome" | "surface"; height?: number }) {
  const colors = useColors();
  return createElement(
    View as never,
    { style: { flex: 1, height: height ?? "100%", backgroundColor: tone === "chrome" ? colors.chrome : colors.surface } },
    children,
  );
}

const sidebar = (width: number | string) =>
  createElement(
    View as never,
    { style: { width, height: "100%" } },
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
          workspaceId: "ws-demo",
          iconOf,
          onIconPress: () => {},
        }),
      ),
    ),
  );

const desktop = () =>
  createElement(
    View as never,
    { style: { flexDirection: "row", width: DESKTOP.width, height: DESKTOP.height } },
    sidebar(264),
    createElement(View as never, { style: { flex: 1, height: "100%" } }, createElement(Backdrop, { tone: "surface" })),
  );

const phone = () => createElement(View as never, { style: { width: PHONE.width, height: PHONE.height } }, sidebar("100%"));

describe("system folder ink shots", () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`01 the sidebar at 1440, ${scheme}`, async () => {
      await shoot("01-tree", DESKTOP, scheme, desktop);
    }, 120_000);

    test(`02 the tree at 390, ${scheme}`, async () => {
      await shoot("02-tree", PHONE, scheme, phone);
    }, 120_000);
  }
});
