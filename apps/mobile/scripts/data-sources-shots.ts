/**
 * @jest-environment jsdom
 */

/**
 * Screenshots of stage B's data pages, to compare with the data sources
 * artboards: the Data page (01, desktop light and dark, phone), the GitHub
 * folder (07, desktop and phone), the Eval CI push source (09), the built-in
 * Context source (10), the metrics folder (11) and a metric note (12), and
 * the states no board draws (x1 to x5): an empty data folder, the page while
 * its notes load, a metric whose formula does not parse beside one over a
 * sheet this reader cannot read, and each of those two opened as a note.
 *
 * The pages are the real components over the real hook (`useDataWorkspace`),
 * fed by an in-memory folder source: every sheet is invented CSV made below,
 * read through `readBody` like any reader's, and every metric is worked out
 * from it as the page reads it. Only what stage B cannot know yet is passed
 * in, as the artboards draw it: a source's last sync (stage E), and the keys
 * the control plane lists. `data-source-menu-shots.ts`'s technique.
 *
 *     DATA_SOURCES_SHOTS_DIR=<html-dir> pnpm exec jest --testMatch '**\/scripts/data-sources-shots.ts' --testPathIgnorePatterns '[]'
 *     PW_EXE=<chromium> node scripts/capture-trash-shots.mjs <html-dir> <png-dir>
 */

import { afterEach, beforeAll, describe, jest, test } from "@jest/globals";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { withoutTextExtension } from "@context/shared/src/fileKinds.cjs";
import { act, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OUT = resolve(process.env.DATA_SOURCES_SHOTS_DIR ?? "/tmp/data-sources-shots");

/*
  jsdom lays nothing out, so `onLayout` never fires and the readings chart,
  which draws at its measured width, would draw nothing. A ResizeObserver that
  reports each observed node at the width its column has in the browser.
*/
let chartWidth = 794;
class StubResizeObserver {
  constructor(private readonly callback: (entries: { target: Element }[]) => void) {}
  observe(target: Element): void {
    if (target.getAttribute("data-testid") === "metric-readings-chart") {
      Object.defineProperty(target, "getBoundingClientRect", {
        value: () => ({ x: 0, y: 0, left: 0, top: 0, width: chartWidth, height: 150, right: chartWidth, bottom: 150 }),
        configurable: true,
      });
      Object.defineProperty(target, "offsetWidth", { value: chartWidth, configurable: true });
      Object.defineProperty(target, "offsetHeight", { value: 150, configurable: true });
    }
    queueMicrotask(() => this.callback([{ target }]));
  }
  unobserve(): void {}
  disconnect(): void {}
}
(window as unknown as { ResizeObserver: unknown }).ResizeObserver = StubResizeObserver;

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

jest.mock("../features/design/components/Menu", () => jest.requireActual("../features/design/components/Menu.web"));

const mockStableNoop = async () => ({});

/** What the sync says of the right-now metric in boards n1 and n2 (`useMetricKeep.ts`), set per board. */
const mockKeep: { current: Record<string, unknown> } = { current: { state: undefined, armed: false } };
// The right-now boards draw the console's own Readings header (`KeptReadingsHead`), which shows only inside the console.
jest.mock("../features/console/ConsoleDataContext", () => ({
  ...(jest.requireActual("../features/console/ConsoleDataContext") as object),
  useOptionalConsoleData: () => (mockKeep.current.inConsole === true ? { demo: false } : null),
}));
jest.mock("../features/console/files/data/useMetricKeep", () => ({
  ...(jest.requireActual("../features/console/files/data/useMetricKeep") as object),
  useMetricKeep: () => mockKeep.current,
}));
jest.mock("convex/react", () => ({
  useConvexAuth: () => ({ isLoading: false, isAuthenticated: true }),
  useQuery: () => undefined,
  useQueries: () => ({}),
  useMutation: () => mockStableNoop,
  useAction: () => mockStableNoop,
}));

const { StyleSheet, View, Text } = require("react-native") as {
  StyleSheet: { getSheet(): { textContent: string } };
  View: unknown;
  Text: unknown;
};
const { ThemeProvider, useColors } = require("../features/design/theme") as typeof import("../features/design/theme");
const { FileTree } = require("../features/console/files/FileTree") as typeof import("../features/console/files/FileTree");
const { ExplorerToolbar } = require("../features/console/files/explorer/ExplorerToolbar") as typeof import("../features/console/files/explorer/ExplorerToolbar");
const { jobIconMarker } = require("../features/console/files/jobIcons/marker") as typeof import("../features/console/files/jobIcons/marker");
const { setJobFoldersNow } = require("../features/console/files/jobIcons/jobFoldersNow") as typeof import("../features/console/files/jobIcons/jobFoldersNow");
const { useDataWorkspace } = require("../features/console/files/data/useDataWorkspace") as typeof import("../features/console/files/data/useDataWorkspace");
const { DataPage, metricViews } = require("../features/console/files/data/DataPage") as typeof import("../features/console/files/data/DataPage");
const { SourcePage } = require("../features/console/files/data/SourcePage") as typeof import("../features/console/files/data/SourcePage");
const { MetricsPage } = require("../features/console/files/data/MetricsPage") as typeof import("../features/console/files/data/MetricsPage");
const { MetricBuilderDialog } = require("../features/console/files/data/MetricBuilder") as typeof import("../features/console/files/data/MetricBuilder");
const { ConnectSourceDialog } = require("../features/console/files/data/ConnectSource") as typeof import("../features/console/files/data/ConnectSource");
const { MetricNoteView } = require("../features/console/files/data/MetricNoteView") as typeof import("../features/console/files/data/MetricNoteView");
const { KeyList } = require("../features/console/files/data/SourceParts") as typeof import("../features/console/files/data/SourceParts");
const { sheetRowsEndpoint } = require("../features/console/files/sheet/SheetSources") as typeof import("../features/console/files/sheet/SheetSources");
const { pointerType } = require("../features/design/tokens") as typeof import("../features/design/tokens");

type Scheme = "light" | "dark";
type ListNote = import("../features/console/files/listBlock/model").ListNote;
type FolderListSource = import("../features/console/files/listBlock/model").FolderListSource;

// ---------------------------------------------------------------------------
// Fixtures: a workspace's data folder, every value invented.
// ---------------------------------------------------------------------------

import {
  NOW,
  MIN,
  HOUR,
  DAY,
  METRICS,
  SHEETS,
  NOTES,
  entry,
  SOURCES,
  LISTINGS,
  source,
  nesting,
  type Nesting,
} from "./data-sources-fixtures";

/*
  The states no board draws. A workspace whose data folder is empty; one
  whose notes have not arrived; and two metrics the boards never show: one
  whose formula does not parse, and one reading a sheet this reader cannot
  read, which arrives exactly as a missing one does.
*/
const emptySource: FolderListSource = { load: async () => ({ notes: [], complete: true }), readBody: async () => null };
const emptyNesting: Nesting = {
  listingOf: (path: string) => (path === "data" ? { path, folderDefault: "team" as const, truncated: false, manifestUsable: true, entries: [] } : undefined),
  loadListing: () => {},
};
const loadingSource: FolderListSource = { load: () => new Promise(() => {}), readBody: () => new Promise(() => {}) };

const ODD_METRICS = [
  { slug: "refunds-week", props: { metric: "Refunds / week", formula: "sum(stripe/refunds.usd)", every: "week", format: "$0" } },
  { slug: "deploy-gap", props: { metric: "Deploy gap", formula: "median(github/deploys.finished -)", every: "week", format: "duration" } },
];
const ODD_NOTES: ListNote[] = [
  ...NOTES.filter((note) => note.path !== "areas/Finance/about.md"),
  ...ODD_METRICS.map((m) => ({ path: `data/metrics/${m.slug}.md`, updatedAt: NOW - DAY, properties: m.props })),
  { path: "areas/Finance/about.md", properties: { metrics: ["Revenue per AI dollar, target over $5", "Refunds / week, target under $500"] } },
];
const oddSource: FolderListSource = {
  load: async (folder, subfolders) => ({
    notes: ODD_NOTES.filter((note) => {
      const prefix = folder === "" ? "" : `${folder}/`;
      return note.path.startsWith(prefix) && (subfolders || !note.path.slice(prefix.length).includes("/"));
    }),
    complete: true,
  }),
  // stripe/refunds.csv is listed but unreadable here: its read comes back as nothing, as a missing sheet's does.
  readBody: async (path) => (SHEETS[path] === undefined ? null : { text: SHEETS[path]!, encrypted: false }),
};
const oddNesting: Nesting = {
  listingOf: (path: string) =>
    path === "data/metrics"
      ? { ...LISTINGS[path]!, entries: [...LISTINGS[path]!.entries, ...ODD_METRICS.map((m) => entry(`data/metrics/${m.slug}.md`, "file", NOW - DAY))] }
      : path === "data/stripe"
        ? { ...LISTINGS[path]!, entries: [...LISTINGS[path]!.entries, entry("data/stripe/refunds.csv", "file", NOW - HOUR)] }
        : LISTINGS[path],
  loadListing: () => {},
};

/*
  A right-now metric: open incidents, over a sheet with no dates, so its value is the rows as they stand and its
  past days are what the sync kept beside its note, one reading an hour (`data/metrics/open-incidents.csv`).
*/
const NOW_METRIC = { slug: "open-incidents", props: { metric: "Open incidents", formula: "count(cloudflare/incidents.id where open = true)", every: "day" }, body: "How many incidents are open right now." };
const NOW_SHEETS: Record<string, string> = {
  "data/cloudflare/incidents.csv": "id,title,open:checkbox\nINC-41,Slow search in eu,true\nINC-42,Mail sends late,true\nINC-43,Map tiles blank,true\nINC-39,Login loop,false\n",
  "data/metrics/open-incidents.csv": `hour:date,value:number\n${[6, 5, 7, 4, 2]
    // Dated from the clock the note view reads (its own `Date.now()`), so each lands in the day it is drawn under.
    .map((value, back) => `${new Date(Date.now() - (5 - back) * DAY).toISOString().slice(0, 13)}:00Z,${value}`)
    .join("\n")}\n`,
};
const nowNotes: ListNote[] = [...NOTES, { path: `data/metrics/${NOW_METRIC.slug}.md`, updatedAt: NOW - DAY, properties: NOW_METRIC.props }];
const nowSource = (kept: boolean): FolderListSource => ({
  load: async (folder, subfolders) => ({
    notes: nowNotes.filter((note) => {
      const prefix = folder === "" ? "" : `${folder}/`;
      return note.path.startsWith(prefix) && (subfolders || !note.path.slice(prefix.length).includes("/"));
    }),
    complete: true,
  }),
  readBody: async (path) => {
    if (path === "data/metrics/open-incidents.csv" && !kept) return null;
    const text = NOW_SHEETS[path] ?? SHEETS[path];
    return text === undefined ? null : { text, encrypted: false };
  },
});

/** What stage E's sync object will say; drawn here as the boards do. */
/** GitHub's calls answered as the boards draw them: two of three repositories picked. */
const GITHUB_FLOW = {
  begin: async () => null,
  repos: async () => ({ repos: [{ name: "supa/app", private: true }, { name: "supa/context", private: false }, { name: "supa/site", private: false }], picked: ["supa/app", "supa/context"] }),
  pick: async () => null,
};

const SYNC: Record<string, { syncedAt?: number; failedAt?: number }> = {
  "data/github": { syncedAt: NOW - 5 * MIN },
  "data/cloudflare": { syncedAt: NOW - HOUR },
  "data/stripe": { syncedAt: NOW - 2 * HOUR, failedAt: NOW - 25 * MIN },
};

/** What the control plane lists for the push source's sheet; it keeps no maker's name. */
const KEYS = [
  { id: "k1", name: "GitHub Actions · eval job", made: "Made Nov 3", rows: "1,904 rows", used: "Used 12 min ago" },
  { id: "k2", name: "Dev's laptop", made: "Made Nov 18", rows: "127 rows", used: "Used Nov 20" },
];

// ---------------------------------------------------------------------------
// The frame: the sidebar's tree beside the page, or a phone's screen.
// ---------------------------------------------------------------------------

const JOBS: Record<string, Parameters<typeof jobIconMarker>[0]> = {
  inbox: "inbox",
  projects: "projects",
  areas: "areas",
  data: "data",
  resources: "resources",
  archive: "archive",
};
const iconOf = (path: string) => (JOBS[path] === undefined ? null : jobIconMarker(JOBS[path]!));

type Row = Parameters<typeof FileTree>[0]["rows"][number];
function row(path: string, depth = 0, extra: Partial<Row> = {}): Row {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return { kind: "folder", key: path, path, name, label: withoutTextExtension(name), depth, expanded: false, selected: false, markerIsDefault: true, readOnly: false, ...extra };
}

function treeFor(selected: string): Row[] {
  const rows: Row[] = [row("inbox"), row("projects"), row("areas"), row("data", 0, { expanded: true, selected: selected === "data" })];
  for (const folder of [...SOURCES, "metrics"]) {
    const path = `data/${folder}`;
    const open = selected === path || selected.startsWith(`${path}/`);
    rows.push(row(path, 1, { expanded: open, selected: selected === path }));
    if (!open) continue;
    for (const child of LISTINGS[path]?.entries ?? []) {
      rows.push(row(child.path, 2, { kind: "file", selected: selected === child.path }));
    }
  }
  rows.push(row("resources"), row("archive"));
  return rows;
}

const files = {
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

function DesktopFrame({ selected, children }: { selected: string; children?: ReactNode }) {
  const colors = useColors();
  return h(
    View as never,
    { style: { flexDirection: "row", width: DESKTOP.width, height: DESKTOP.height, backgroundColor: colors.chrome } },
    h(
      View as never,
      { style: { width: 264, height: "100%", paddingHorizontal: 8 } },
      h(ExplorerToolbar, { files, selectedFolder: selected, setDialog: () => {}, workspaceSort: null, query: "", closeFilter: () => {}, dataSource: true }),
      h(FileTree, { rows: treeFor(selected), onSelect: () => {}, onToggle: () => {}, workspaceId: "ws-acme", iconOf, onIconPress: () => {} }),
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
          paddingTop: 96,
          alignItems: "center",
        },
      },
      h(View as never, { style: { width: 820 } }, children),
    ),
  );
}

function PhoneFrame({ children }: { children?: ReactNode }) {
  const colors = useColors();
  return h(
    View as never,
    { style: { width: PHONE.width, minHeight: PHONE.height, backgroundColor: colors.surface, paddingTop: 60, paddingBottom: 40 } },
    children,
  );
}

// ---------------------------------------------------------------------------
// The boards.
// ---------------------------------------------------------------------------

type BoardId = "02" | "02c" | "02s" | "02g" | "02r" | "03c" | "04" | "04b" | "01" | "07" | "09" | "10" | "11" | "12" | "empty" | "loading" | "odd-metrics" | "hidden-note" | "broken-note" | "now-new" | "now-kept";

const WORLD: Partial<Record<BoardId, { source: FolderListSource; nesting: Nesting }>> = {
  empty: { source: emptySource, nesting: emptyNesting },
  loading: { source: loadingSource, nesting },
  "odd-metrics": { source: oddSource, nesting: oddNesting },
  "hidden-note": { source: oddSource, nesting: oddNesting },
  "broken-note": { source: oddSource, nesting: oddNesting },
  "now-new": { source: nowSource(false), nesting },
  "now-kept": { source: nowSource(true), nesting },
};

function noteText(m: { props: Record<string, string>; body?: string }): string {
  return `---\n${Object.entries(m.props).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join("\n")}\n---\n\n${m.body ?? ""}\n`;
}

function BoardView({ board, compact }: { board: BoardId; compact: boolean }) {
  const world = WORLD[board] ?? { source, nesting };
  const ws = useDataWorkspace("data", world.source, world.nesting, NOW);
  const colors = useColors();
  const open = () => {};
  const dataActions = { connect: () => {}, newMetric: () => {} };
  if (board === "loading") return h(DataPage, { folder: "data", compact, ws, now: NOW, actions: dataActions, onOpen: open });
  if (board === "hidden-note" || board === "broken-note") {
    const m = ODD_METRICS[board === "hidden-note" ? 0 : 1]!;
    return h(MetricNoteView, { path: `data/metrics/${m.slug}.md`, text: noteText(m), source: world.source, compact, gutter: 0, onOpen: open });
  }
  if (!ws.settled) return null;
  const metrics = metricViews(ws);
  const sourcePage = (folder: string, extra: Partial<Parameters<typeof SourcePage>[0]> = {}) => {
    const each = ws.sources.find((s) => s.folder === folder)!;
    return h(SourcePage, {
      source: each,
      sheets: ws.sheets,
      metrics: metrics.filter((m) => m.reads.includes(folder)),
      compact,
      now: NOW,
      endpoint: sheetRowsEndpoint(),
      actions: { more: () => {}, copy: () => {}, ...(SYNC[folder] === undefined ? {} : { syncNow: () => {} }) },
      ...(SYNC[folder] === undefined ? {} : { sync: SYNC[folder] }),
      onOpen: open,
      ...extra,
    });
  };
  switch (board) {
    // Board 02 with its Apps, for an owner, and Cloudflare's token form or Stripe's key form (connected again in place), over the data page.
    case "02":
    case "02c":
    case "02s":
    case "02g":
    case "02r":
      return h(
        View as never,
        null,
        h(DataPage, { folder: "data", compact, ws, now: NOW, actions: dataActions, onOpen: open, sync: (folder: string) => SYNC[folder] }),
        h(ConnectSourceDialog, {
          dataFolder: "data",
          taken: new Set<string>(),
          sheet: compact,
          sources: ws.sources,
          onMake: async () => null,
          onMakeUrl: async () => null,
          onConnectApp: async () => null,
          ...(board === "02c" ? { start: "cloudflare" as const } : board === "02s" ? { start: "stripe" as const } : board === "02g" ? { start: "github" as const } : board === "02r" ? { start: "github-repos" as const } : {}),
          github: GITHUB_FLOW,
          onClose: () => {},
        }),
      );
    // Cloudflare's page for an owner, its token refused at the last run.
    case "03c":
      return sourcePage("data/cloudflare", {
        actions: { reconnect: () => {}, disconnect: () => {}, more: () => {}, copy: () => {} },
        sync: { known: true, syncedAt: NOW - 3 * HOUR, failedAt: NOW - 25 * MIN, stopped: true, said: "Stopped: Cloudflare refused the token. An owner can connect it again here." },
      });
    // The builder over the data page, as the boards draw it: board 04 with its draft, 04b typing a column.
    case "04":
    case "04b":
      return h(
        View as never,
        null,
        h(DataPage, { folder: "data", compact, ws, now: NOW, actions: dataActions, onOpen: open, sync: (folder: string) => SYNC[folder] }),
        h(MetricBuilderDialog, {
          metricsFolder: "data/metrics",
          taken: new Set(["data/metrics/revenue-per-ai-dollar.md"]),
          sources: ws.sources,
          sheets: ws.sheets,
          startFormula: "",
          initial:
            board === "04"
              ? { name: "Revenue per AI dollar", formula: "sum(stripe/revenue.usd) / sum(cloudflare/ai-spend.usd)", every: "month", format: "$0.00" }
              : { name: "Revenue per AI dollar (Team plan)", formula: "sum(stripe/revenue.usd where plan = Team) / sum(cloudflare/ai-spend.", every: "month", format: "$0.00" },
          editing: board === "04b",
          sheet: compact,
          now: NOW,
          onSave: async () => null,
          onClose: () => {},
        }),
      );
    case "01":
    case "empty":
      return h(DataPage, { folder: "data", compact, ws, now: NOW, actions: dataActions, onOpen: open, sync: (folder: string) => SYNC[folder] });
    // GitHub's page for an owner: Repositories…, Connect again and Disconnect in place of Sync now.
    case "07":
      return sourcePage("data/github", { actions: { repositories: () => {}, reconnect: () => {}, disconnect: () => {}, more: () => {}, copy: () => {} } });
    case "09":
      return sourcePage("data/eval-ci", {
        actions: { newKey: () => {}, more: () => {}, copy: () => {} },
        keys: h(KeyList, { keys: KEYS, onRevoke: () => {} }),
      });
    case "10":
      return sourcePage("data/context");
    // The metrics page, with the two odd metrics after the board's six.
    case "odd-metrics":
    case "11":
      return h(MetricsPage, { title: "metrics", metrics, readings: null, compact, now: NOW, newMetric: () => {}, onOpen: open });
    case "now-new":
    case "now-kept":
      return h(
        View as never,
        null,
        h(MetricNoteView, { path: `data/metrics/${NOW_METRIC.slug}.md`, text: noteText(NOW_METRIC), source: world.source, compact, gutter: 0, onOpen: open }),
        h(Text as never, { style: { fontSize: pointerType.lede, lineHeight: 24, color: colors.text, marginTop: 18 } }, NOW_METRIC.body),
      );
    case "12": {
      const m = METRICS.find((each) => each.slug === "revenue-per-ai-dollar")!;
      return h(
        View as never,
        null,
        h(MetricNoteView, { path: "data/metrics/revenue-per-ai-dollar.md", text: noteText(m), source, compact, gutter: 0, onOpen: open }),
        // The note's body, as the editor draws it under the view.
        h(Text as never, { style: { fontSize: pointerType.lede, lineHeight: 24, color: colors.text, marginTop: 18 } }, m.body),
      );
    }
    default:
      return null;
  }
}

function page(title: string, body: string, css: string, size: { width: number; height: number }, phone: boolean): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>
  html, body { margin: 0; padding: 0; }
  /* A photograph of where each animation ends (a dialog's fade), never part of the way there. */
  *, *::before, *::after { animation-duration: 0s !important; animation-delay: 0s !important; transition: none !important; }
  body { -webkit-font-smoothing: antialiased; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  #shot { width: ${size.width}px; ${phone ? "min-height" : "height"}: ${size.height}px; overflow: hidden; position: relative; }
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
});

beforeAll(() => {
  setJobFoldersNow({ inbox: "inbox", archive: "archive", projects: "projects", areas: "areas", data: "data" });
});

const SELECTED: Record<BoardId, string> = {
  "02": "data",
  "02c": "data",
  "02s": "data",
  "02g": "data",
  "02r": "data",
  "03c": "data/cloudflare",
  "04": "data",
  "04b": "data",
  "01": "data",
  "07": "data/github",
  "09": "data/eval-ci",
  "10": "data/context",
  "11": "data/metrics",
  "12": "data/metrics/revenue-per-ai-dollar.md",
  empty: "data",
  loading: "data",
  "odd-metrics": "data/metrics",
  "hidden-note": "data/metrics/refunds-week.md",
  "broken-note": "data/metrics/deploy-gap.md",
  "now-new": "data/metrics/open-incidents.md",
  "now-kept": "data/metrics/open-incidents.md",
};

async function shoot(board: BoardId, name: string, scheme: Scheme, phone: boolean): Promise<void> {
  const size = phone ? PHONE : DESKTOP;
  mockKeep.current =
    board === "now-kept"
      ? { inConsole: true, state: { known: true, syncedAt: Date.now() - 12 * MIN }, armed: true }
      : board === "now-new"
        ? { inConsole: true, state: { known: true }, armed: false, keep: async () => null }
        : { state: undefined, armed: false };
  // The builder's chart sits in its dialog's card: the dialog's width less its padding and the card's.
  const builder = board === "04" || board === "04b" || board === "02" || board === "02c" || board === "02s" || board === "02g" || board === "02r";
  chartWidth = builder ? (phone ? PHONE.width : 680) - 48 - 26 : phone ? PHONE.width - 32 - 26 : 820 - 26;
  stampViewport(size);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  const content = h(BoardView, { board, compact: phone });
  const framed = phone ? h(PhoneFrame, null, h(View as never, { style: { paddingHorizontal: 16 } }, content)) : h(DesktopFrame, { selected: SELECTED[board] }, content);
  await act(async () => {
    root!.render(h(ThemeProvider, { scheme, children: framed }));
  });
  // The folder reads, the sheet reads and the chart's measure each land a tick later.
  // A dialog fades in over 300 ms: photographed once it has.
  for (let i = 0; i < (builder ? 40 : 12); i += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, builder ? 15 : 5));
    });
  }
  const injected = [...document.head.querySelectorAll("style")].map((style) => style.textContent ?? "").join("\n");
  const css = `${StyleSheet.getSheet().textContent}\n${injected}`;
  const file = resolve(OUT, `${name}-${scheme}-${phone ? "phone" : "desktop"}.html`);
  mkdirSync(dirname(file), { recursive: true });
  // A dialog is a modal, drawn in a layer of its own on the body beside the page: kept, over the page, as it is seen.
  const layers = [...document.body.children].filter((each) => each !== container).map((each) => each.outerHTML).join("");
  writeFileSync(file, page(name, container.innerHTML + layers, css, size, phone));
}

describe("data sources shots", () => {
  const shots: [BoardId, string, Scheme, boolean][] = [
    ["02", "02-connect-apps", "light", false],
    ["02", "02-connect-apps", "dark", false],
    ["02", "02-connect-apps", "light", true],
    ["02c", "02c-cloudflare-token", "light", false],
    ["02c", "02c-cloudflare-token", "light", true],
    ["02s", "02s-stripe-key", "light", false],
    ["02s", "02s-stripe-key", "light", true],
    ["02g", "02g-github-connect", "light", false],
    ["02g", "02g-github-connect", "dark", false],
    ["02g", "02g-github-connect", "light", true],
    ["02r", "02r-github-repos", "light", false],
    ["02r", "02r-github-repos", "light", true],
    ["03c", "03c-cloudflare-source", "light", false],
    ["03c", "03c-cloudflare-source", "light", true],
    ["04", "04-metric-builder", "light", false],
    ["04", "04-metric-builder", "dark", false],
    ["04", "04-metric-builder", "light", true],
    ["04b", "04b-metric-edit", "light", false],
    ["04b", "04b-metric-edit", "light", true],
    ["01", "01-data-page", "light", false],
    ["01", "01-data-page", "dark", false],
    ["01", "01-data-page", "light", true],
    ["01", "01-data-page", "dark", true],
    ["07", "07-github-folder", "light", false],
    ["07", "07-github-folder", "light", true],
    ["09", "09-evalci-folder", "light", false],
    ["10", "10-context-folder", "light", false],
    ["11", "11-metrics-folder", "light", false],
    ["12", "12-metric-note", "light", false],
    ["empty", "x1-empty-data-folder", "light", false],
    ["empty", "x1-empty-data-folder", "light", true],
    ["loading", "x2-loading", "light", false],
    ["odd-metrics", "x3-unparsed-and-hidden-metrics", "light", false],
    ["odd-metrics", "x3-unparsed-and-hidden-metrics", "light", true],
    ["hidden-note", "x4-hidden-metric-note", "light", false],
    ["broken-note", "x5-unparsed-metric-note", "light", false],
    ["now-new", "n1-right-now-metric", "light", false],
    ["now-new", "n1-right-now-metric", "light", true],
    ["now-kept", "n2-right-now-kept", "light", false],
    ["now-kept", "n2-right-now-kept", "dark", false],
    ["now-kept", "n2-right-now-kept", "light", true],
  ];
  for (const [board, name, scheme, phone] of shots) {
    test(`${name} ${scheme} ${phone ? "phone" : "desktop"}`, async () => {
      await shoot(board, name, scheme, phone);
    }, 120_000);
  }
});
