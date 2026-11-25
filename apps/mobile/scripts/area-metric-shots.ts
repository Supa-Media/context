/**
 * @jest-environment jsdom
 */

/**
 * Screenshots of stage C of data sources and metrics, to compare with the
 * data sources artboards: an area's metric picker (05, desktop and phone),
 * the Areas List after picking (06), the empty picker of a workspace with no
 * metrics (13b) and a GitHub sheet's read-only lock line (08), each in light
 * and dark.
 *
 * The pages are the real components over the real hooks (`AreasView`, which
 * works each area's metric out with stage B's engine, and `SourceSheetView`),
 * fed by the invented workspace of `data-sources-fixtures.ts`, read through
 * `readBody` as any reader's. Reliability's "Open incidents" is no workspace
 * metric, so it is read from the area's own `metrics.csv`, as before stage C.
 * The console's toast after Save is drawn by the console's own `ToastHost`.
 *
 *     AREA_METRIC_SHOTS_DIR=<html-dir> pnpm exec jest --testMatch '**\/scripts/area-metric-shots.ts' --testPathIgnorePatterns '[]'
 *     PW_EXE=<chromium> node scripts/capture-trash-shots.mjs <html-dir> <png-dir>
 */

import { afterEach, beforeAll, describe, jest, test } from "@jest/globals";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { act, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { HOUR, LISTINGS, NOTES, NOW, SHEETS, SOURCES } from "./data-sources-fixtures";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OUT = resolve(process.env.AREA_METRIC_SHOTS_DIR ?? "/tmp/area-metric-shots");

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: 1440, height: 900 }),
  SafeAreaProvider: ({ children }: { children: unknown }) => children,
}));

jest.mock("expo-router", () => ({
  useRouter: () => ({ replace: () => {}, push: () => {}, back: () => {}, setParams: () => {} }),
  useLocalSearchParams: () => ({}),
  useGlobalSearchParams: () => ({}),
  usePathname: () => "/",
  Redirect: () => null,
  Slot: () => null,
}));

jest.mock("../features/design/components/Menu", () => jest.requireActual("../features/design/components/Menu.web"));

const mockStableNoop = async () => ({});
jest.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useQuery: () => undefined,
  useQueries: () => ({}),
  useMutation: () => mockStableNoop,
  useAction: () => mockStableNoop,
  useConvex: () => ({ query: mockStableNoop, mutation: mockStableNoop, action: mockStableNoop }),
}));

const { StyleSheet, View } = require("react-native") as { StyleSheet: { getSheet(): { textContent: string } }; View: unknown };
const { ThemeProvider, useColors } = require("../features/design/theme") as typeof import("../features/design/theme");
const { FileTree } = require("../features/console/files/FileTree") as typeof import("../features/console/files/FileTree");
const { ExplorerToolbar } = require("../features/console/files/explorer/ExplorerToolbar") as typeof import("../features/console/files/explorer/ExplorerToolbar");
const { jobIconMarker } = require("../features/console/files/jobIcons/marker") as typeof import("../features/console/files/jobIcons/marker");
const { JobIcon } = require("../features/console/files/jobIcons/JobIcon") as typeof import("../features/console/files/jobIcons/JobIcon");
const { setJobFoldersNow } = require("../features/console/files/jobIcons/jobFoldersNow") as typeof import("../features/console/files/jobIcons/jobFoldersNow");
const { AreasView } = require("../features/console/files/folderPage/areas/AreasView") as typeof import("../features/console/files/folderPage/areas/AreasView");
const { ViewSwitch, AREA_VIEWS } = require("../features/console/files/folderPage/Head") as typeof import("../features/console/files/folderPage/Head");
const { PageHead } = require("../features/console/files/data/PageHead") as typeof import("../features/console/files/data/PageHead");
const { SourceSheetView } = require("../features/console/files/data/SourceSheetView") as typeof import("../features/console/files/data/SourceSheetView");
const { ConsoleDataProvider } = require("../features/console/ConsoleDataContext") as typeof import("../features/console/ConsoleDataContext");
const { ToastHost } = require("../features/design/components/Toast") as typeof import("../features/design/components/Toast");

type Scheme = "light" | "dark";
type ListNote = import("../features/console/files/listBlock/model").ListNote;
type FolderListSource = import("../features/console/files/listBlock/model").FolderListSource;
type FolderListing = import("../features/console/files/types").FolderListing;
type FolderPageHost = import("../features/console/files/folderPage/useFolderPage").FolderPageHost;

// ---------------------------------------------------------------------------
// The Areas folder, as board 06 draws it.
// ---------------------------------------------------------------------------

const note = (path: string, properties: ListNote["properties"] = {}): ListNote => ({ path, properties, updatedAt: NOW - 2 * HOUR });
const files = (folder: string, n: number) => Array.from({ length: n }, (_, i) => note(`${folder}/note-${i + 1}.md`));

/** The seats: each names a workspace metric by its note's name, but Reliability, whose "Open incidents" is its own metrics.csv's. */
function areaNotes(withMetrics: boolean): ListNote[] {
  const seat = (folder: string, owner: string, metric: string | null) =>
    note(`${folder}/about.md`, { owner, ...(withMetrics && metric !== null ? { metrics: [metric] } : {}), ...(folder.split("/").length > 2 ? { area: "true" } : {}) });
  return [
    note("areas/about.md", { owner: "@dev" }),
    seat("areas/engineering", "@dev", "PRs merged / week · target at least 10"),
    seat("areas/engineering/mcp", "@claude", "Error rate · target under 1%"),
    seat("areas/engineering/reliability", "@dev", "Open incidents · target at most 0"),
    seat("areas/engineering/search-quality", "@gus", "p95 latency · target under 800"),
    seat("areas/engineering/velocity", "@dev", "Open to live · target under 30 min"),
    seat("areas/finance", "@dev", "Revenue per AI dollar · target over $5"),
    seat("areas/design", "@seyi", null),
    ...files("areas/engineering/reliability", 1),
    ...files("areas/engineering/velocity", 4),
    ...files("areas/finance", 3),
    ...files("areas/design", 6),
  ];
}

/** Reliability's own readings, one row a day: the fallback path, unchanged by stage C. */
const RELIABILITY_CSV = ["date:date,metric,value", "2026-11-18,Open incidents,2", "2026-11-19,Open incidents,1", "2026-11-20,Open incidents,1", "2026-11-21,Open incidents,0", "2026-11-22,Open incidents,1", "2026-11-23,Open incidents,0", "2026-11-24,Open incidents,0", ""].join("\n");

interface World {
  readonly notes: ListNote[];
  readonly source: FolderListSource;
  readonly listings: { listingOf: (path: string) => FolderListing | undefined; loadListing: () => void };
}

/** "unpicked": Finance has no metric yet, so its picker opens as the phone's board draws it before a choice is saved. */
function world(kind: "full" | "unpicked" | "empty"): World {
  const data = kind !== "empty";
  const areas = areaNotes(true).map((each) => (kind === "unpicked" && each.path === "areas/finance/about.md" ? note(each.path, { owner: "@dev" }) : each));
  const notes = [...(data ? NOTES.filter((each) => !each.path.startsWith("areas/")) : []), ...(kind === "empty" ? areaNotes(false) : areas)];
  const bodies: Record<string, string> = { ...(data ? SHEETS : {}), "areas/engineering/reliability/metrics.csv": RELIABILITY_CSV };
  return {
    notes,
    source: {
      load: async (folder, subfolders) => ({
        notes: notes.filter((each) => {
          const prefix = folder === "" ? "" : `${folder}/`;
          return each.path.startsWith(prefix) && (subfolders || !each.path.slice(prefix.length).includes("/"));
        }),
        complete: true,
      }),
      readBody: async (path) => (bodies[path] === undefined ? null : { text: bodies[path]!, encrypted: false }),
    },
    listings: { listingOf: (path) => (data ? LISTINGS[path] : undefined), loadListing: () => {} },
  };
}

const FACES: Record<string, string> = { "@dev": "Dev", "@claude": "Claude", "@gus": "Gus", "@seyi": "Seyi" };

// ---------------------------------------------------------------------------
// The frame: the sidebar's tree beside the page, or a phone's screen.
// ---------------------------------------------------------------------------

const JOBS: Record<string, Parameters<typeof jobIconMarker>[0]> = { inbox: "inbox", projects: "projects", areas: "areas", data: "data", resources: "resources", archive: "archive" };
const iconOf = (path: string) => (JOBS[path] === undefined ? null : jobIconMarker(JOBS[path]!));

type Row = Parameters<typeof FileTree>[0]["rows"][number];
function row(path: string, depth = 0, extra: Partial<Row> = {}): Row {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return { kind: "folder", key: path, path, name, label: name.replace(/\.(md|csv)$/, ""), depth, expanded: false, selected: false, markerIsDefault: true, readOnly: false, ...extra };
}

function treeFor(board: Board): Row[] {
  if (board === "08") {
    const rows: Row[] = [row("inbox"), row("projects"), row("areas"), row("data", 0, { expanded: true })];
    for (const folder of [...SOURCES, "metrics"]) {
      const path = `data/${folder}`;
      const open = folder === "github";
      rows.push(row(path, 1, { expanded: open }));
      if (open) for (const child of LISTINGS[path]?.entries ?? []) rows.push(row(child.path, 2, { kind: "file", selected: child.path === "data/github/pull-requests.csv" }));
    }
    return [...rows, row("resources"), row("archive")];
  }
  return [
    row("inbox"),
    row("projects"),
    row("areas", 0, { expanded: true, selected: true }),
    row("areas/engineering", 1),
    row("areas/finance", 1),
    row("areas/design", 1),
    ...(board === "13b" ? [] : [row("data")]),
    row("resources"),
    row("archive"),
  ];
}

const explorerFiles = {
  canEdit: true,
  listings: { "": { path: "", folderDefault: "team" as const, truncated: false, manifestUsable: true, entries: [] } },
  createUntitled: () => {},
  createFolder: () => {},
  select: () => true,
  collapseAll: () => {},
  setFolderSort: () => {},
} as unknown as Parameters<typeof ExplorerToolbar>[0]["files"];

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };

function DesktopFrame({ board, children }: { board: Board; children?: ReactNode }) {
  const colors = useColors();
  return h(
    View as never,
    { style: { flexDirection: "row", width: DESKTOP.width, height: DESKTOP.height, backgroundColor: colors.chrome } },
    h(
      View as never,
      { style: { width: 264, height: "100%", paddingHorizontal: 8 } },
      h(ExplorerToolbar, { files: explorerFiles, selectedFolder: board === "08" ? "data/github" : "areas", setDialog: () => {}, workspaceSort: null, query: "", closeFilter: () => {}, dataSource: true }),
      h(FileTree, { rows: treeFor(board), onSelect: () => {}, onToggle: () => {}, workspaceId: "ws-acme", iconOf, onIconPress: () => {} }),
    ),
    h(
      View as never,
      {
        style: {
          flex: 1,
          marginTop: 44,
          marginBottom: 34,
          marginRight: 52,
          borderRadius: 10,
          borderWidth: 1,
          borderColor: colors.line,
          backgroundColor: colors.surface,
          overflow: "hidden",
          paddingTop: board === "08" ? 56 : 58,
          alignItems: "center",
        },
      },
      h(View as never, { style: { width: board === "08" ? 1060 : 820 } }, children),
    ),
  );
}

function PhoneFrame({ children }: { children?: ReactNode }) {
  const colors = useColors();
  return h(View as never, { style: { width: PHONE.width, minHeight: PHONE.height, backgroundColor: colors.surface, paddingTop: 60, paddingBottom: 40, paddingHorizontal: 16 } }, children);
}

// ---------------------------------------------------------------------------
// The boards.
// ---------------------------------------------------------------------------

type Board = "05" | "06" | "13b" | "08";

function host(w: World): FolderPageHost {
  return {
    source: w.source,
    workspaceId: "ws-acme",
    people: [],
    tasks: { io: { create: async () => {}, move: async () => {}, setProperties: async () => null, remove: async () => {} }, say: () => {}, refresh: () => {} } as unknown as NonNullable<FolderPageHost["tasks"]>,
  };
}

function AreasBoard({ board, compact, w }: { board: Board; compact: boolean; w: World }) {
  const areaNotes = w.notes.filter((each) => each.path.startsWith("areas/"));
  return h(
    View as never,
    null,
    h(PageHead, {
      tile: h(JobIcon, { job: "areas", size: 36, tile: true }),
      title: "areas",
      actions: h(ViewSwitch, { view: "list", onChange: () => {}, compact, views: AREA_VIEWS }),
      lede: compact ? null : "Who holds what, and how each area is doing.",
      compact,
    }),
    h(AreasView, {
      folder: "areas",
      root: "areas",
      rootName: "Supa",
      notes: areaNotes,
      view: "list",
      compact,
      canEdit: true,
      faceOf: (owner: string | null) => (owner === null ? { kind: "nobody" as const } : { kind: "person" as const, name: FACES[owner] ?? owner }),
      label: (owner: string) => FACES[owner] ?? owner,
      isAgent: (owner: string) => owner === "@claude",
      people: (async () => ({ people: [], agents: [], truncated: false })) as never,
      agents: [],
      chooseMany: async () => null,
      onSelect: () => {},
      readBody: w.source.readBody!,
      listings: w.listings,
      host: host(w),
      ...(board === "06" && !compact ? { onPanel: () => {} } : {}),
    }),
    board === "06"
      ? h(View as never, { style: { position: "fixed", left: compact ? 0 : 264, right: compact ? 0 : 52, bottom: compact ? 24 : 34, height: 80, backgroundColor: "transparent" } },
          h(ToastHost, { toasts: [{ id: "t", message: "Finance now tracks Revenue per AI dollar." }], onDismiss: () => {} }))
      : null,
  );
}

function SheetBoard({ compact }: { compact: boolean }) {
  const w = world("full");
  return h(SourceSheetView, {
    source: w.source,
    onOpenFolder: () => {},
    path: "data/github/pull-requests.csv",
    text: SHEETS["data/github/pull-requests.csv"]!,
    readOnly: false,
    visibility: "team",
    compact,
    onChangeText: () => {},
  });
}

function page(title: string, body: string, css: string, size: { width: number; height: number }, phone: boolean): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  html, body { margin: 0; padding: 0; }
  body { -webkit-font-smoothing: antialiased; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  #shot { width: ${size.width}px; ${phone ? "min-height" : "height"}: ${size.height}px; overflow: hidden; position: relative; }
  * { animation-duration: 0s !important; animation-delay: 0s !important; transition: none !important; }
</style>
<style id="rnw">${css}</style>
</head><body><div id="shot">${body}</div></body></html>`;
}

function stampViewport(size: { width: number; height: number }): void {
  Object.defineProperty(document.documentElement, "clientWidth", { value: size.width, configurable: true });
  Object.defineProperty(document.documentElement, "clientHeight", { value: size.height, configurable: true });
  Object.defineProperty(window, "innerWidth", { value: size.width, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: size.height, configurable: true });
  window.dispatchEvent(new Event("resize"));
}

let root: Root | null = null;
let container: HTMLElement | null = null;

afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  if (container !== null) container.remove();
  root = null;
  container = null;
  document.body.innerHTML = "";
});

beforeAll(() => {
  setJobFoldersNow({ inbox: "inbox", archive: "archive", projects: "projects", areas: "areas", data: "data" });
  // Every "1h ago" is said against the boards' own morning.
  jest.spyOn(Date, "now").mockReturnValue(NOW);
});

const settle = async (rounds = 14) => {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 5));
    });
  }
};

const click = async (testID: string) => {
  const node = document.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
  if (node === null) throw new Error(`no ${testID}`);
  await act(async () => {
    node.click();
  });
  await settle(3);
};

async function shoot(board: Board, name: string, scheme: Scheme, phone: boolean): Promise<void> {
  const size = phone ? PHONE : DESKTOP;
  stampViewport(size);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  const w = world(board === "13b" ? "empty" : board === "05" && phone ? "unpicked" : "full");
  // An owner's console, so Connect a source is offered as it is to them.
  const owner = { selectedContextId: "ws-acme", contexts: [{ id: "ws-acme", role: "owner" }], demo: false } as never;
  const content = h(ConsoleDataProvider, {
    value: owner,
    children: board === "08" ? h(SheetBoard, { compact: phone }) : h(AreasBoard, { board, compact: phone, w }),
  });
  const framed = phone ? h(PhoneFrame, null, content) : h(DesktopFrame, { board }, content);
  await act(async () => {
    root!.render(h(ThemeProvider, { scheme, children: framed }));
  });
  await settle();
  if (board === "05" && !phone) {
    // Finance's ⋯ menu, Change metric…: the picker opens on its metric and target.
    await click("area-more-areas/finance");
    await click("menu-item-metric");
  }
  if (board === "05" && phone) {
    // A phone has no ⋯ on a row; Finance, with no metric yet, offers Pick a metric, and the board's choice is made.
    await click("area-pick-areas/finance");
    await click("metric-option-data/metrics/revenue-per-ai-dollar.md");
    const input = document.querySelector<HTMLInputElement>('[data-testid="metric-target-value"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "$5");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  if (board === "13b") await click("area-pick-areas/design");
  if (board === "06" && !phone) await click("area-row-areas/finance");
  await settle(4);
  const injected = [...document.head.querySelectorAll("style")].map((style) => style.textContent ?? "").join("\n");
  const css = `${StyleSheet.getSheet().textContent}\n${injected}`;
  const file = resolve(OUT, `${name}-${scheme}-${phone ? "phone" : "desktop"}.html`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, page(name, document.body.innerHTML, css, size, phone));
}

describe("area metric shots", () => {
  const boards: [Board, string][] = [
    ["05", "05-area-metric"],
    ["06", "06-areas-list"],
    ["13b", "13b-empty-picker"],
    ["08", "08-pull-requests-sheet"],
  ];
  for (const [board, name] of boards) {
    for (const scheme of ["light", "dark"] as const) {
      for (const phone of [false, true]) {
        test(`${name} ${scheme} ${phone ? "phone" : "desktop"}`, async () => {
          await shoot(board, name, scheme, phone);
        }, 120_000);
      }
    }
  }
});
