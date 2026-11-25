/**
 * @jest-environment jsdom
 */

/**
 * Screenshots of Fetch from a URL, to compare with board 02 (Connect a source): the dialog's "Your own" step over
 * the Data page, its url form filled in, and a url source's own page after a good run and after a refused one, each
 * light and dark, desktop and phone.
 *
 * The pages are the real components over the real hook (`useDataWorkspace`), fed by `data-sources-fixtures.ts`'s
 * in-memory workspace plus one url source, `data/status-example-com`, whose sheet is invented CSV. What the sync
 * object would answer is passed in as its state (`SyncState`), as the page gets it from `useSourceSync.ts`.
 *
 *     DATA_SYNC_SHOTS_DIR=<html-dir> pnpm exec jest --testMatch '**\/scripts/data-sync-shots.ts' --testPathIgnorePatterns '[]'
 *     PW_EXE=<chromium> node scripts/capture-trash-shots.mjs <html-dir> <png-dir>
 */

import { afterEach, beforeAll, describe, jest, test } from "@jest/globals";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { withoutTextExtension } from "@context/shared/src/fileKinds.cjs";
import { act, createElement as h, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const OUT = resolve(process.env.DATA_SYNC_SHOTS_DIR ?? "/tmp/data-sync-shots");

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

const { StyleSheet, View } = require("react-native") as { StyleSheet: { getSheet(): { textContent: string } }; View: unknown };
const { ThemeProvider, useColors } = require("../features/design/theme") as typeof import("../features/design/theme");
const { FileTree } = require("../features/console/files/FileTree") as typeof import("../features/console/files/FileTree");
const { ExplorerToolbar } = require("../features/console/files/explorer/ExplorerToolbar") as typeof import("../features/console/files/explorer/ExplorerToolbar");
const { jobIconMarker } = require("../features/console/files/jobIcons/marker") as typeof import("../features/console/files/jobIcons/marker");
const { setJobFoldersNow } = require("../features/console/files/jobIcons/jobFoldersNow") as typeof import("../features/console/files/jobIcons/jobFoldersNow");
const { useDataWorkspace } = require("../features/console/files/data/useDataWorkspace") as typeof import("../features/console/files/data/useDataWorkspace");
const { DataPage, metricViews } = require("../features/console/files/data/DataPage") as typeof import("../features/console/files/data/DataPage");
const { SourcePage } = require("../features/console/files/data/SourcePage") as typeof import("../features/console/files/data/SourcePage");
const { ConnectSourceDialog } = require("../features/console/files/data/ConnectSource") as typeof import("../features/console/files/data/ConnectSource");
const { sheetRowsEndpoint } = require("../features/console/files/sheet/SheetSources") as typeof import("../features/console/files/sheet/SheetSources");

import { NOW, MIN, HOUR, DAY, NOTES, SHEETS, LISTINGS, SOURCES, entry, listing, csv, iso, type Nesting } from "./data-sources-fixtures";

type Scheme = "light" | "dark";
type ListNote = import("../features/console/files/listBlock/model").ListNote;
type FolderListSource = import("../features/console/files/listBlock/model").FolderListSource;
type SyncState = import("../features/console/files/data/words").SyncState;

// ---------------------------------------------------------------------------
// The workspace: stage B's fixtures plus one url source, every value invented.
// ---------------------------------------------------------------------------

const URL_FOLDER = "data/status-example-com";
const URL_SHEET = `${URL_FOLDER}/incidents.csv`;
const URL_ABOUT: ListNote = {
  path: `${URL_FOLDER}/about.md`,
  updatedAt: NOW - 2 * DAY,
  properties: { source: "url", name: "status.example.com", url: "https://status.example.com/incidents.json", dataset: "incidents", key: "id", date: "opened" },
};
const SEVERITY = ["minor", "major", "minor", "minor", "critical", "minor", "major"];
const URL_ROWS = SEVERITY.map((severity, i) => [`INC-${310 + i}`, `Elevated errors on region ${(i % 3) + 1}`, severity, iso(NOW - (i * 19 + 3) * HOUR)] as const);
const ALL_SHEETS: Record<string, string> = { ...SHEETS, [URL_SHEET]: csv("id,title,severity,opened", URL_ROWS) };
const ALL_NOTES: ListNote[] = [...NOTES, URL_ABOUT];
const ALL_SOURCES = [...SOURCES, "status-example-com"];
listing("data", [...ALL_SOURCES.map((s) => entry(`data/${s}`, "folder")), entry("data/metrics", "folder")]);
listing(URL_FOLDER, [entry(URL_ABOUT.path, "file", URL_ABOUT.updatedAt), entry(URL_SHEET, "file", NOW - 5 * MIN)]);

const source: FolderListSource = {
  load: async (folder, subfolders) => ({
    notes: ALL_NOTES.filter((note) => {
      const prefix = folder === "" ? "" : `${folder}/`;
      return note.path.startsWith(prefix) && (subfolders || !note.path.slice(prefix.length).includes("/"));
    }),
    complete: true,
  }),
  readBody: async (path) => (ALL_SHEETS[path] === undefined ? null : { text: ALL_SHEETS[path]!, encrypted: false }),
};
const nesting: Nesting = { listingOf: (path: string) => LISTINGS[path], loadListing: () => {} };

/** What the sync object answers for each source, as `useSourceSync.ts` hands it on. */
const SYNC_OK: Record<string, SyncState> = {
  "data/github": { known: true, syncedAt: NOW - 5 * MIN },
  "data/cloudflare": { known: true, syncedAt: NOW - HOUR },
  "data/stripe": { known: true, syncedAt: NOW - 2 * HOUR },
  [URL_FOLDER]: { known: true, syncedAt: NOW - 5 * MIN, rows: URL_ROWS.length },
};
const SYNC_REFUSED: SyncState = {
  known: true,
  syncedAt: NOW - 3 * HOUR,
  failedAt: NOW - 25 * MIN,
  said: "Nothing was written: the address answered 404 Not Found.",
};

// ---------------------------------------------------------------------------
// The frame: the sidebar's tree beside the page, or a phone's screen.
// ---------------------------------------------------------------------------

const JOBS: Record<string, Parameters<typeof jobIconMarker>[0]> = { inbox: "inbox", projects: "projects", areas: "areas", data: "data", resources: "resources", archive: "archive" };
const iconOf = (path: string) => (JOBS[path] === undefined ? null : jobIconMarker(JOBS[path]!));

type Row = Parameters<typeof FileTree>[0]["rows"][number];
function row(path: string, depth = 0, extra: Partial<Row> = {}): Row {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return { kind: "folder", key: path, path, name, label: withoutTextExtension(name), depth, expanded: false, selected: false, markerIsDefault: true, readOnly: false, ...extra };
}

function treeFor(selected: string): Row[] {
  const rows: Row[] = [row("inbox"), row("projects"), row("areas"), row("data", 0, { expanded: true, selected: selected === "data" })];
  for (const folder of [...ALL_SOURCES, "metrics"]) {
    const path = `data/${folder}`;
    const open = selected === path;
    rows.push(row(path, 1, { expanded: open, selected: open }));
    if (!open) continue;
    for (const child of LISTINGS[path]?.entries ?? []) rows.push(row(child.path, 2, { kind: "file" }));
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
  return h(View as never, { style: { width: PHONE.width, minHeight: PHONE.height, backgroundColor: colors.surface, paddingTop: 60, paddingBottom: 40, paddingHorizontal: 16 } }, children);
}

// ---------------------------------------------------------------------------
// The boards.
// ---------------------------------------------------------------------------

type Board = "choose" | "url-form" | "url-source" | "url-refused";

function BoardView({ board, compact }: { board: Board; compact: boolean }) {
  const ws = useDataWorkspace("data", source, nesting, NOW);
  if (!ws.settled) return null;
  const open = () => {};
  if (board === "choose" || board === "url-form") {
    return h(
      View as never,
      null,
      h(DataPage, { folder: "data", compact, ws, now: NOW, actions: { connect: () => {}, newMetric: () => {} }, onOpen: open, sync: (folder: string) => SYNC_OK[folder] }),
      h(ConnectSourceDialog, {
        dataFolder: "data",
        taken: new Set(LISTINGS.data!.entries.map((each) => each.path)),
        sheet: compact,
        onMake: async () => null,
        onMakeUrl: async () => null,
        onClose: () => {},
      }),
    );
  }
  const each = ws.sources.find((s) => s.folder === URL_FOLDER)!;
  return h(SourcePage, {
    source: each,
    sheets: ws.sheets,
    metrics: metricViews(ws).filter((m) => m.reads.includes(URL_FOLDER)),
    compact,
    now: NOW,
    sync: board === "url-refused" ? SYNC_REFUSED : SYNC_OK[URL_FOLDER]!,
    endpoint: sheetRowsEndpoint(),
    actions: { syncNow: () => {}, more: () => {}, copy: () => {} },
    onOpen: open,
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
  jest.spyOn(Date, "now").mockReturnValue(NOW);
});

const settle = async (rounds = 12) => {
  for (let i = 0; i < rounds; i += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 5));
    });
  }
};

async function click(testID: string): Promise<void> {
  const node = document.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
  if (node === null) throw new Error(`no ${testID}`);
  await act(async () => {
    node.click();
  });
  await settle(3);
}

async function type(testID: string, text: string): Promise<void> {
  const at = document.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
  const input = (at instanceof HTMLInputElement ? at : at?.querySelector("input")) ?? null;
  if (input === null) throw new Error(`no field ${testID}`);
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function shoot(board: Board, name: string, scheme: Scheme, phone: boolean): Promise<void> {
  const size = phone ? PHONE : DESKTOP;
  stampViewport(size);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  const content = h(BoardView, { board, compact: phone });
  const framed = phone ? h(PhoneFrame, null, content) : h(DesktopFrame, { selected: board === "choose" || board === "url-form" ? "data" : URL_FOLDER }, content);
  await act(async () => {
    root!.render(h(ThemeProvider, { scheme, children: framed }));
  });
  await settle();
  if (board === "url-form") {
    await click("connect-way-url");
    await type("connect-url-address", "https://status.example.com/incidents.json");
    await type("connect-url-dataset", "Open incidents");
  }
  await settle(4);
  const injected = [...document.head.querySelectorAll("style")].map((style) => style.textContent ?? "").join("\n");
  const css = `${StyleSheet.getSheet().textContent}\n${injected}`;
  const file = resolve(OUT, `${name}-${scheme}-${phone ? "phone" : "desktop"}.html`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, page(name, document.body.innerHTML, css, size, phone));
}

describe("data sync shots", () => {
  const boards: [Board, string][] = [
    ["choose", "02-connect-choose"],
    ["url-form", "02-connect-url-form"],
    ["url-source", "s1-url-source"],
    ["url-refused", "s2-url-source-refused"],
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
