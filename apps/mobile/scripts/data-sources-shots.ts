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
const { MetricNoteView } = require("../features/console/files/data/MetricNoteView") as typeof import("../features/console/files/data/MetricNoteView");
const { KeyList } = require("../features/console/files/data/SourceParts") as typeof import("../features/console/files/data/SourceParts");
const { sheetRowsEndpoint } = require("../features/console/files/sheet/SheetSources") as typeof import("../features/console/files/sheet/SheetSources");
const { pointerType } = require("../features/design/tokens") as typeof import("../features/design/tokens");

type Scheme = "light" | "dark";
type ListNote = import("../features/console/files/listBlock/model").ListNote;
type FolderListSource = import("../features/console/files/listBlock/model").FolderListSource;
type FolderListing = import("../features/console/files/types").FolderListing;
type FileEntry = import("../features/console/files/types").FileEntry;

// ---------------------------------------------------------------------------
// Fixtures: a workspace's data folder, every value invented.
// ---------------------------------------------------------------------------

/** Tuesday 24 November 2026, 11:00 UTC, as the boards are drawn. */
const NOW = Date.UTC(2026, 10, 24, 11, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** A small deterministic generator, so every run draws the same numbers. */
function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

const iso = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}Z`;
const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const csv = (header: string, rows: readonly (readonly (string | number)[])[]) => `${header}\n${rows.map((row) => row.join(",")).join("\n")}\n`;

/* As the boards draw them, newest week first: PRs merged each calendar week, their lines in thousands, and open-to-live minutes each rolling week. */
const MERGED_PER_WEEK = [7, 6, 7, 9, 6, 8];
const LINES_PER_WEEK = [18.2, 17, 22, 12, 19, 14];
const LEAD_PER_WEEK = [22, 24, 31, 28, 37, 34, 41];

function pullRequests(): string {
  const rand = seeded(7);
  const rows: (string | number)[][] = [];
  const count = 1284;
  const span = 26 * 7 * DAY;
  const monday = Date.UTC(2026, 10, 23);
  const merges = new Map<number, number>();
  // Newest first, so each week's quota goes to its latest pull requests.
  for (let n = count - 1; n >= 0; n -= 1) {
    const opened = NOW - 50 * MIN - Math.floor(((count - 1 - n) / count) * span);
    const rolling = Math.floor((NOW - opened) / (7 * DAY));
    const lead = (LEAD_PER_WEEK[rolling] ?? 41) - 1 + Math.floor(rand() * 3);
    const week = Math.max(0, Math.ceil((monday - (opened + lead * MIN)) / (7 * DAY)));
    const quota = MERGED_PER_WEEK[week] ?? 9;
    const done = merges.get(week) ?? 0;
    const mergedHere = done < quota && rand() < (week === 0 ? 1 : 0.5);
    if (mergedHere) merges.set(week, done + 1);
    const merged = mergedHere ? iso(opened + (lead - 4) * MIN) : "";
    const deployed = mergedHere ? iso(opened + lead * MIN) : "";
    // Each merged change carries its week's share of the lines, three parts added to one removed.
    const lines = Math.round(((LINES_PER_WEEK[week] ?? 15) * 1000) / quota);
    const added = mergedHere ? Math.round(lines * 0.75) : 0;
    const removed = mergedHere ? lines - added : 0;
    rows.unshift([n % 3 === 0 ? "acme/context" : "acme/app", 4000 + n, `Change ${n}`, ["dev", "sam", "ana"][n % 3]!, iso(opened), merged, deployed, added, removed]);
  }
  return csv("repo,number,title,author:person,opened:date,merged:date,deployed:date,lines added:number,lines removed:number", rows);
}

function deploys(): string {
  const rows: (string | number)[][] = [];
  for (let n = 0; n < 412; n += 1) {
    const started = NOW - 78 * MIN - n * 11 * HOUR;
    rows.push(["acme/app", `a${(n * 7919).toString(16)}`, n % 4 === 0 ? "staging" : "production", iso(started), iso(started + 6 * MIN), "ok"]);
  }
  return csv("repo,sha,environment,started:date,finished:date,status", rows);
}

function workflowRuns(): string {
  const rows: (string | number)[][] = [];
  for (let n = 0; n < 3920; n += 1) {
    const started = NOW - 60 * MIN - n * 70 * MIN;
    rows.push(["acme/app", "ci", "main", iso(started), iso(started + 9 * MIN), "success"]);
  }
  return csv("repo,workflow,branch,started:date,finished:date,conclusion", rows);
}

/** Revenue per AI dollar by month, June to November, as board 12 draws it. */
const RATIO = [6.1, 6.8, 7.4, 8.2, 8.9, 9.4];

function aiSpend(): string {
  const rows: (string | number)[][] = [];
  for (let n = 181; n >= 0; n -= 1) {
    const at = Date.UTC(2026, 10, 24) - n * DAY;
    rows.push([day(at), "claude", (40).toFixed(2)]);
  }
  return csv("date:date,model,usd:number", rows);
}

function revenue(): string {
  const rows: (string | number)[][] = [];
  for (let n = 179; n >= 0; n -= 1) {
    const at = Date.UTC(2026, 10, 24) - n * DAY;
    const month = new Date(at).getUTCMonth();
    const ratio = RATIO[month - 5] ?? 6;
    for (const plan of ["Team", "Pro", "Free"]) rows.push([day(at), plan, ((40 * ratio) / 3).toFixed(4)]);
  }
  return csv("date:date,plan,usd:number", rows);
}

function benchRuns(): string {
  const rand = seeded(11);
  const rows: (string | number)[][] = [];
  const count = 2031;
  for (let n = count - 1; n >= 0; n -= 1) {
    const at = NOW - 12 * MIN - n * 2 * HOUR;
    const daysAgo = Math.floor((NOW - at) / DAY);
    const p95 = Math.round(1436 - daysAgo * 18 - rand() * 40);
    const requests = 1200;
    const errors = Math.round(requests * Math.max(0.004, 0.022 - daysAgo * 0.0028) + (rand() - 0.5));
    rows.push([iso(at), n % 2 === 0 ? "search" : "answers", p95, errors, requests]);
  }
  return csv("date:date,suite,p95 ms:number,errors:number,requests:number", rows);
}

const METRICS: readonly { slug: string; props: Record<string, string>; body: string }[] = [
  { slug: "open-to-live", props: { metric: "Open to live", formula: "median(github/pull-requests.deployed - opened)", every: "7 days", format: "duration" }, body: "" },
  { slug: "prs-merged-week", props: { metric: "PRs merged / week", formula: "count(github/pull-requests.merged)", every: "week", format: "0" }, body: "" },
  { slug: "lines-changed-week", props: { metric: "Lines changed / week", formula: "sum(github/pull-requests.lines added + lines removed)", every: "week", format: "0.0k" }, body: "" },
  {
    slug: "revenue-per-ai-dollar",
    props: { metric: "Revenue per AI dollar", formula: "sum(stripe/revenue.usd) / sum(cloudflare/ai-spend.usd)", every: "month", format: "$0.00" },
    body: "Stripe revenue in a month, divided by what Cloudflare AI cost that month. Written by Claude from “revenue per dollar of AI spend, monthly”, checked by Dev.",
  },
  { slug: "error-rate", props: { metric: "Error rate", formula: "sum(eval-ci/bench-runs.errors) / sum(eval-ci/bench-runs.requests)", every: "day", format: "0.0%" }, body: "" },
  { slug: "p95-latency", props: { metric: "p95 latency", formula: "p95(eval-ci/bench-runs.p95 ms)", every: "day", format: "0" }, body: "" },
];

const ABOUTS: Record<string, { props: Record<string, string | string[]>; lede?: string; updatedAt: number }> = {
  "data/github": {
    props: { source: "github", repositories: ["acme/app", "acme/context"], every: "hour", history: "last 90 days", access: "read-only" },
    lede: "Pull requests, deploys and workflow runs from acme/app and acme/context, kept as plain sheets.",
    updatedAt: NOW - 3 * DAY,
  },
  "data/cloudflare": { props: { source: "cloudflare", every: "hour" }, updatedAt: NOW - 9 * DAY },
  "data/stripe": { props: { source: "stripe", every: "hour" }, updatedAt: NOW - 9 * DAY },
  "data/context": {
    props: { source: "context", "notes-by-status": ["areas/reliability/incidents/", "projects/"], "time-to-answered": ["inbox/questions/"] },
    updatedAt: NOW - 6 * DAY,
  },
  "data/eval-ci": {
    props: { source: "push", name: "Eval CI" },
    lede: "Rows sent by our eval job. Anything with a key can add rows here; nothing can read them back with it.",
    updatedAt: NOW - 21 * DAY,
  },
};

const AREAS: Record<string, string> = {
  Velocity: "Open to live · target under 30 min",
  Engineering: "PRs merged / week · target over 10",
  Finance: "Revenue per AI dollar · target over $5",
  MCP: "Error rate · target under 1%",
  "Search quality": "p95 latency · target under 1000",
};

const SHEETS: Record<string, string> = {
  "data/github/pull-requests.csv": pullRequests(),
  "data/github/deploys.csv": deploys(),
  "data/github/workflow-runs.csv": workflowRuns(),
  "data/cloudflare/ai-spend.csv": aiSpend(),
  "data/stripe/revenue.csv": revenue(),
  "data/eval-ci/bench-runs.csv": benchRuns(),
};

function countedNotes(): ListNote[] {
  const out: ListNote[] = [];
  const add = (folder: string, status: string, n: number) => {
    for (let i = 0; i < n; i += 1) out.push({ path: `${folder}/${status}-${i}.md`, properties: { status } });
  };
  add("areas/reliability/incidents", "closed", 14);
  add("projects", "active", 6);
  add("projects", "done", 31);
  for (let i = 0; i < 12; i += 1) {
    const asked = NOW - (i + 1) * 9 * HOUR;
    out.push({ path: `inbox/questions/q-${i}.md`, properties: { asked: iso(asked), answered: iso(asked + (30 + i * 7) * MIN) } });
  }
  return out;
}

const NOTES: ListNote[] = [
  ...Object.entries(ABOUTS).map(([folder, about]) => ({
    path: `${folder}/about.md`,
    updatedAt: about.updatedAt,
    properties: about.props,
    ...(about.lede === undefined ? {} : { lede: about.lede }),
  })),
  ...METRICS.map((m) => ({ path: `data/metrics/${m.slug}.md`, updatedAt: NOW - 5 * DAY, properties: m.props })),
  ...Object.entries(AREAS).map(([area, metric]) => ({ path: `areas/${area}/about.md`, properties: { metric } })),
  { path: "areas/reliability/about.md", properties: {} },
  ...countedNotes(),
];

function entry(path: string, kind: "file" | "folder", updatedAt?: number): FileEntry {
  return {
    kind,
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    visibility: "team",
    inherited: "team",
    exception: false,
    readOnly: false,
    ...(updatedAt === undefined ? {} : { updatedAt }),
  } as FileEntry;
}

const SOURCES = ["github", "cloudflare", "stripe", "context", "eval-ci"];
const LISTINGS: Record<string, FolderListing> = {};
function listing(path: string, entries: FileEntry[]): void {
  LISTINGS[path] = { path, folderDefault: "team", truncated: false, manifestUsable: true, entries };
}
listing("data", [...SOURCES.map((s) => entry(`data/${s}`, "folder")), entry("data/metrics", "folder")]);
for (const s of SOURCES) {
  const sheets = Object.keys(SHEETS).filter((p) => p.startsWith(`data/${s}/`));
  listing(`data/${s}`, [entry(`data/${s}/about.md`, "file", ABOUTS[`data/${s}`]!.updatedAt), ...sheets.map((p) => entry(p, "file", NOW - HOUR))]);
}
listing("data/metrics", METRICS.map((m) => entry(`data/metrics/${m.slug}.md`, "file", NOW - 5 * DAY)));

const source: FolderListSource = {
  load: async (folder, subfolders) => ({
    notes: NOTES.filter((note) => {
      const prefix = folder === "" ? "" : `${folder}/`;
      return note.path.startsWith(prefix) && (subfolders || !note.path.slice(prefix.length).includes("/"));
    }),
    complete: true,
  }),
  readBody: async (path) => (SHEETS[path] === undefined ? null : { text: SHEETS[path]!, encrypted: false }),
};

type Nesting = { listingOf: (path: string) => FolderListing | undefined; loadListing: () => void };
const nesting: Nesting = {
  listingOf: (path: string) => LISTINGS[path],
  loadListing: () => {},
};

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

/** What stage E's sync object will say; drawn here as the boards do. */
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
  return { kind: "folder", key: path, path, name, label: name.replace(/\.md$/, ""), depth, expanded: false, selected: false, markerIsDefault: true, readOnly: false, ...extra };
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

type BoardId = "01" | "07" | "09" | "10" | "11" | "12" | "empty" | "loading" | "odd-metrics" | "hidden-note" | "broken-note";

const WORLD: Partial<Record<BoardId, { source: FolderListSource; nesting: Nesting }>> = {
  empty: { source: emptySource, nesting: emptyNesting },
  loading: { source: loadingSource, nesting },
  "odd-metrics": { source: oddSource, nesting: oddNesting },
  "hidden-note": { source: oddSource, nesting: oddNesting },
  "broken-note": { source: oddSource, nesting: oddNesting },
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
    case "01":
    case "empty":
      return h(DataPage, { folder: "data", compact, ws, now: NOW, actions: dataActions, onOpen: open, sync: (folder: string) => SYNC[folder] });
    case "07":
      return sourcePage("data/github");
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
};

async function shoot(board: BoardId, name: string, scheme: Scheme, phone: boolean): Promise<void> {
  const size = phone ? PHONE : DESKTOP;
  chartWidth = phone ? PHONE.width - 32 - 26 : 820 - 26;
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
  for (let i = 0; i < 12; i += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 5));
    });
  }
  const injected = [...document.head.querySelectorAll("style")].map((style) => style.textContent ?? "").join("\n");
  const css = `${StyleSheet.getSheet().textContent}\n${injected}`;
  const file = resolve(OUT, `${name}-${scheme}-${phone ? "phone" : "desktop"}.html`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, page(name, container.innerHTML, css, size, phone));
}

describe("data sources shots", () => {
  const shots: [BoardId, string, Scheme, boolean][] = [
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
  ];
  for (const [board, name, scheme, phone] of shots) {
    test(`${name} ${scheme} ${phone ? "phone" : "desktop"}`, async () => {
      await shoot(board, name, scheme, phone);
    }, 120_000);
  }
});
