/**
 * @jest-environment jsdom
 */

/**
 * Screenshots of Context's own icons (owner, 2026-10-21, "Context icon set",
 * board B ink): the sidebar with folders wearing Context icons in the text
 * colour and Tex's own folders drawn in Tex blue, beside the picker open on
 * Context icons, at 1440; the picker searched; and the phone's sheet on both
 * tabs at 390. Light and dark. `folder-jobs-shots.ts`'s technique. Every
 * value is invented; long names are deliberate, to test truncation.
 *
 *     pnpm exec jest --testMatch '**\/scripts/context-icons-shots.ts' --testPathIgnorePatterns '[]'
 *     PW_EXE=<chromium> node scripts/capture-trash-shots.mjs <html-dir> <png-dir>
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { act, createElement, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OUT = resolve(process.env.CONTEXT_ICONS_SHOTS_DIR ?? "/tmp/context-icons-shots");

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
const { FolderIconDialog } = require("../features/console/files/FolderIconDialog") as typeof import("../features/console/files/FolderIconDialog");
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
/* Maya's workspace: Context icons on her folders, Tex nested in Assistant.    */
/* -------------------------------------------------------------------------- */

const JOBS: Record<string, Parameters<typeof jobIconMarker>[0]> = {
  "0-inbox": "inbox",
  "1-projects": "projects",
  "2-areas": "areas",
  "Assistant/tex": "tex",
};
const CHOSEN: Record<string, string> = {
  "1-projects/harbor-linen": "context:icon:briefcase",
  "1-projects/studio-lease": "context:icon:key",
  "1-projects/launch": "context:icon:rocket",
  "Recipes and kitchen experiments from the allotment": "context:icon:utensils",
  Taxes: "context:icon:receipt",
  "Small group (Thursdays)": "context:icon:group",
  Running: "🏃",
};
const jobMap = new Map(Object.entries(JOBS));
const iconOf = (path: string) =>
  JOBS[path] !== undefined ? jobIconMarker(JOBS[path]!) : (CHOSEN[path] ?? texPartIconUnder(jobMap, path));

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
  row("0-inbox", "Inbox"),
  row("1-projects", "Projects", 0, { expanded: true }),
  row("1-projects/harbor-linen", "Harbor Linen spring wholesale reorder and the delayed March shipment", 1),
  row("1-projects/studio-lease", "New studio lease", 1),
  row("1-projects/launch", "Launch", 1, { selected: true }),
  row("2-areas", "Areas"),
  row("Recipes and kitchen experiments from the allotment", "Recipes and kitchen experiments from the allotment"),
  row("Taxes", "Taxes"),
  row("Small group (Thursdays)", "Small group (Thursdays)"),
  row("Running", "Running"),
  row("Assistant", "Assistant", 0, { expanded: true }),
  row("Assistant/tex", "Tex", 1, { expanded: true }),
  row("Assistant/tex/about.md", "About me", 2, { kind: "file" }),
  row("Assistant/tex/attention", "attention", 2),
  row("Assistant/tex/dreams", "dreams", 2),
  row("Assistant/tex/heartbeat", "heartbeat", 2),
  row("Assistant/tex/housekeeping", "housekeeping", 2),
  row("Assistant/tex/routines", "routines", 2, { expanded: true }),
  row("Assistant/tex/routines/every-day", "every-day", 3),
  row("Assistant/tex/routines/every-week", "every-week", 3),
  row("Assistant/tex/skills", "skills", 2),
  row("Assistant/tex/transcripts", "transcripts", 2),
];

function Backdrop({ children, tone, height }: { children?: ReactNode; tone: "chrome" | "surface"; height?: number }) {
  const colors = useColors();
  return createElement(
    View as never,
    { style: { flex: 1, height: height ?? "100%", backgroundColor: tone === "chrome" ? colors.chrome : colors.surface } },
    children,
  );
}

const PICKING = "1-projects/launch";
const picker = () =>
  createElement(FolderIconDialog, {
    path: PICKING,
    current: CHOSEN[PICKING]!,
    onSet: async () => {},
    onClose: () => {},
    suggest: async (set?: "context") => (set === "context" ? "context:icon:rocket" : "🚀"),
  });

const desktop = (withPicker: boolean) => () =>
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
    createElement(View as never, { style: { flex: 1, height: "100%" } }, createElement(Backdrop, { tone: "surface" })),
    withPicker ? picker() : null,
  );

const phone = () => createElement(Backdrop, { tone: "surface", height: PHONE.height }, picker());

const byTestID = (testID: string) => document.querySelector(`[data-testid="${testID}"]`) as HTMLElement | null;
function typeIn(testID: string, text: string): void {
  const field = byTestID(testID);
  if (field === null) throw new Error(`no field called ${testID}`);
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(field, text);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}
const tap = (testID: string) => () => byTestID(testID)?.click();

describe("context icons shots", () => {
  for (const scheme of ["light", "dark"] as const) {
    test(`01 the sidebar with Context icons and Tex's own folders, ${scheme}`, async () => {
      await shoot("01-tree", DESKTOP, scheme, desktop(false));
    }, 120_000);

    test(`02 the picker open on Context icons, ${scheme}`, async () => {
      await shoot("02-picker", DESKTOP, scheme, desktop(true));
    }, 120_000);

    test(`03 the picker searched, ${scheme}`, async () => {
      await shoot("03-search", DESKTOP, scheme, desktop(true), () => typeIn("folder-icon-search", "birthday"));
    }, 120_000);

    test(`04 the phone's sheet on Context icons, ${scheme}`, async () => {
      await shoot("04-phone-context", PHONE, scheme, phone);
    }, 120_000);

    test(`05 the phone's sheet on Emoji, ${scheme}`, async () => {
      await shoot("05-phone-emoji", PHONE, scheme, phone, tap("folder-icon-tab-emoji"));
    }, 120_000);
  }
});
