/**
 * @jest-environment jsdom
 */

/**
 * The data pages drawn (`features/console/files/data/`), over the real hook,
 * fed by an in-memory folder source.
 *
 * The properties with teeth: a sheet the reader cannot read draws exactly as
 * a missing one, whether its read fails, comes back encrypted or is absent;
 * a reader who may not write is offered no Connect a source, New metric or
 * New key; a malformed about.md or metric front matter draws, never throws;
 * and a phone lists sources in the order a wide page reads its two columns.
 *
 * SABOTAGE (hidden == missing): make `readSheet` in `data/useData.ts` keep a
 * failed read's error as a sheet, or let `classify` in `data/workOut.ts`
 * tell "can't read" from "no such sheet" → "an unreadable sheet draws as a
 * missing one" fails.
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement as h, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
  useSafeAreaFrame: () => ({ x: 0, y: 0, width: 1280, height: 800 }),
}));

import type { FolderListSource, ListNote } from "../features/console/files/listBlock/model";
import type { FileEntry, FolderListing } from "../features/console/files/types";
import { ThemeProvider } from "../features/design/theme";
import { DataPage } from "../features/console/files/data/DataPage";
import { SourcePage } from "../features/console/files/data/SourcePage";
import { MetricNoteView } from "../features/console/files/data/MetricNoteView";
import { metricViews } from "../features/console/files/data/DataPage";
import { useDataWorkspace } from "../features/console/files/data/useDataWorkspace";
import { setJobFoldersNow } from "../features/console/files/jobIcons/jobFoldersNow";

const NOW = Date.parse("2026-11-25T11:00:00Z");

function entry(path: string, kind: "file" | "folder" = "file"): FileEntry {
  return { kind, path, name: path.slice(path.lastIndexOf("/") + 1), visibility: "team", inherited: "team", exception: false, readOnly: false } as FileEntry;
}
function listing(path: string, entries: FileEntry[]): FolderListing {
  return { path, folderDefault: "team", truncated: false, manifestUsable: true, entries } as unknown as FolderListing;
}

const BENCH = "date:date,suite,errors:number,requests:number\n2026-11-25T09:00:00Z,search,3,100\n";
const METRIC: ListNote = {
  path: "data/metrics/error-rate.md",
  properties: { metric: "Error rate", formula: "sum(eval-ci/bench-runs.errors) / sum(eval-ci/bench-runs.requests)", every: "day", format: "0.0%" },
};

function world(opts: { notes?: ListNote[]; listings?: Record<string, FolderListing>; readBody?: FolderListSource["readBody"] }) {
  const notes = opts.notes ?? [];
  const source: FolderListSource = {
    load: async (folder, subfolders) => ({
      notes: notes.filter((note) => {
        const prefix = folder === "" ? "" : `${folder}/`;
        return note.path.startsWith(prefix) && (subfolders || !note.path.slice(prefix.length).includes("/"));
      }),
      complete: true,
    }),
    readBody: opts.readBody ?? (async () => null),
  };
  const listings = opts.listings ?? {};
  return { source, nesting: { listingOf: (path: string) => listings[path], loadListing: () => {} } };
}

let roots: { root: Root; node: HTMLElement }[] = [];
afterEach(() => {
  for (const { root, node } of roots) {
    act(() => root.unmount());
    node.remove();
  }
  roots = [];
});

async function mount(element: ReactElement): Promise<HTMLElement> {
  setJobFoldersNow({ inbox: "inbox", archive: "archive", projects: "projects", areas: "areas", data: "data" });
  const node = document.createElement("div");
  document.body.appendChild(node);
  const root = createRoot(node);
  roots.push({ root, node });
  await act(async () => {
    root.render(h(ThemeProvider, { scheme: "light", children: element }));
  });
  for (let i = 0; i < 6; i += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 1));
    });
  }
  return node;
}

type World = ReturnType<typeof world>;

function Data({ w, actions = {}, compact = false }: { w: World; actions?: Parameters<typeof DataPage>[0]["actions"]; compact?: boolean }) {
  const ws = useDataWorkspace("data", w.source, w.nesting, NOW);
  return h(DataPage, { folder: "data", compact, ws, now: NOW, actions, onOpen: () => {} });
}

function Source({ w, folder, actions = {} }: { w: World; folder: string; actions?: Parameters<typeof SourcePage>[0]["actions"] }) {
  const ws = useDataWorkspace("data", w.source, w.nesting, NOW);
  const source = ws.sources.find((each) => each.folder === folder);
  if (source === undefined) return null;
  return h(SourcePage, {
    source,
    sheets: ws.sheets,
    metrics: metricViews(ws).filter((m) => m.reads.includes(folder)),
    compact: false,
    now: NOW,
    endpoint: "https://example.test/api/sheets/rows",
    actions,
    onOpen: () => {},
  });
}

const rowsText = (node: HTMLElement) => [...node.querySelectorAll('[data-testid="metric-row"]')].map((row) => row.textContent);

describe("hidden is missing", () => {
  const evalCi = { path: "data/eval-ci/about.md", properties: { source: "push", name: "Eval CI" } };
  const notes = [evalCi, METRIC];
  const listed = {
    data: listing("data", [entry("data/eval-ci", "folder"), entry("data/metrics", "folder")]),
    "data/eval-ci": listing("data/eval-ci", [entry("data/eval-ci/about.md"), entry("data/eval-ci/bench-runs.csv")]),
    "data/metrics": listing("data/metrics", [entry(METRIC.path)]),
  };
  const absent = { ...listed, "data/eval-ci": listing("data/eval-ci", [entry("data/eval-ci/about.md")]) };

  test("an unreadable sheet draws as a missing one: a failed read, an encrypted one and none", async () => {
    // The sheet is there and readable: the metric has a value.
    const readable = await mount(h(Data, { w: world({ notes, listings: listed, readBody: async () => ({ text: BENCH, encrypted: false }) }) }));
    expect(rowsText(readable)[0]).toContain("3.0%");

    // A path nobody has read yet, so no cache is shared between the worlds.
    const failed = await mount(h(Data, { w: world({ notes, listings: listed, readBody: async () => Promise.reject(new Error("403")) }) }));
    const sealed = await mount(h(Data, { w: world({ notes, listings: listed, readBody: async () => ({ text: "", encrypted: true }) }) }));
    const missing = await mount(h(Data, { w: world({ notes, listings: absent, readBody: async () => null }) }));
    const drawn = rowsText(missing);
    expect(drawn[0]).toContain("Hidden");
    expect(rowsText(failed)).toEqual(drawn);
    expect(rowsText(sealed)).toEqual(drawn);
  });
});

describe("who may write", () => {
  const notes: ListNote[] = [{ path: "data/eval-ci/about.md", properties: { source: "push" } }];
  const listings = {
    data: listing("data", [entry("data/eval-ci", "folder")]),
    "data/eval-ci": listing("data/eval-ci", [entry("data/eval-ci/about.md"), entry("data/eval-ci/rows.csv")]),
  };

  test("a reader who may not write is offered neither Connect a source nor New metric", async () => {
    const node = await mount(h(Data, { w: world({ notes, listings }) }));
    expect(node.querySelector('[data-testid="data-connect"]')).toBeNull();
    expect(node.querySelector('[data-testid="data-new-metric"]')).toBeNull();
    const writer = await mount(h(Data, { w: world({ notes, listings }), actions: { newMetric: () => {} } }));
    expect(writer.querySelector('[data-testid="data-connect"]')).toBeNull();
    expect(writer.querySelector('[data-testid="data-new-metric"]')).not.toBeNull();
  });

  test("a push source offers New key only to who may make one", async () => {
    const reader = await mount(h(Source, { w: world({ notes, listings }), folder: "data/eval-ci" }));
    expect(reader.textContent).toContain("Send rows");
    expect(reader.textContent).not.toContain("New key");
    const editor = await mount(h(Source, { w: world({ notes, listings }), folder: "data/eval-ci", actions: { newKey: () => {} } }));
    expect(editor.textContent).toContain("New key");
  });

  test("only a synced source says its sheets are ordinary files; a push source's lede already does (boards 07, 09)", async () => {
    const both = [...notes, { path: "data/github/about.md", properties: { source: "github" } }];
    const more = {
      ...listings,
      data: listing("data", [entry("data/eval-ci", "folder"), entry("data/github", "folder")]),
      "data/github": listing("data/github", [entry("data/github/about.md"), entry("data/github/deploys.csv")]),
    };
    const push = await mount(h(Source, { w: world({ notes: both, listings: more }), folder: "data/eval-ci" }));
    expect(push.textContent).not.toContain("ordinary files");
    const synced = await mount(h(Source, { w: world({ notes: both, listings: more }), folder: "data/github" }));
    expect(synced.textContent).toContain("2 files · ordinary files you can open, copy or download");
  });
});

describe("what a person wrote by hand", () => {
  test("a malformed about.md and metric front matter draw without throwing", async () => {
    const notes: ListNote[] = [
      { path: "data/odd/about.md", properties: { source: ["github", "stripe"], repositories: "", every: [], "notes-by-status": "not/a/list" } },
      { path: "data/context/about.md", properties: { source: "context", "notes-by-status": [], "time-to-answered": "inbox/" } },
      { path: "data/metrics/x.md", properties: { formula: ["sum(a/b.c)"], every: "fortnight", format: "%%%" } },
      { path: "data/metrics/y.md", properties: {} },
    ];
    const listings = {
      data: listing("data", [entry("data/odd", "folder"), entry("data/context", "folder"), entry("data/metrics", "folder")]),
      "data/odd": listing("data/odd", [entry("data/odd/about.md"), entry("data/odd/x.csv")]),
      "data/context": listing("data/context", [entry("data/context/about.md")]),
      "data/metrics": listing("data/metrics", [entry("data/metrics/x.md"), entry("data/metrics/y.md")]),
    };
    const w = world({ notes, listings, readBody: async () => ({ text: "not,a\n\"broken", encrypted: false }) });
    const node = await mount(h(Data, { w }));
    expect(node.querySelectorAll('[data-testid="metric-row"]').length).toBe(2);
    const odd = await mount(h(Source, { w, folder: "data/odd" }));
    expect(odd.querySelector('[data-testid="data-source-page"]')).not.toBeNull();
    const context = await mount(h(Source, { w, folder: "data/context" }));
    expect(context.textContent).toContain("What it counts");
    const note = await mount(h(MetricNoteView, { path: "data/metrics/x.md", text: "---\nformula: [unclosed\nevery: :\n---\n\nbody\n", source: w.source, compact: false, gutter: 0 }));
    expect(note.querySelector('[data-testid="metric-note-view"]')).not.toBeNull();
    // The body is the person's: nothing in the view writes a value into it.
    expect(note.textContent).not.toContain("body");
  });
});

describe("a phone's sources", () => {
  test("down the left column, then the right, as a wide page reads them", async () => {
    const kinds = ["github", "cloudflare", "stripe", "context", "push"];
    const notes: ListNote[] = kinds.map((kind, at) => ({ path: `data/s${at}/about.md`, properties: { source: kind } }));
    const sheets: Record<string, string[]> = { s0: ["a", "b", "c"], s1: ["d"], s2: ["e"], s3: [], s4: ["f"] };
    const listings: Record<string, FolderListing> = { data: listing("data", kinds.map((_, at) => entry(`data/s${at}`, "folder"))) };
    for (const [folder, names] of Object.entries(sheets)) {
      listings[`data/${folder}`] = listing(`data/${folder}`, [entry(`data/${folder}/about.md`), ...names.map((n) => entry(`data/${folder}/${n}.csv`))]);
    }
    const w = world({ notes, listings });
    const names = ["GitHub", "Cloudflare", "Stripe", "Context", "s4"];
    const order = (node: HTMLElement) => [...node.querySelectorAll('[data-testid="source-card"]')].map((card) => names.find((name) => card.textContent?.startsWith(name)));
    const wide = await mount(h(Data, { w }));
    const phone = await mount(h(Data, { w, compact: true }));
    // Wide: GitHub (three sheets) and Context on the left; Cloudflare, Stripe and the push source on the right.
    expect(order(wide)).toEqual(["GitHub", "Context", "Cloudflare", "Stripe", "s4"]);
    expect(order(phone)).toEqual(order(wide));
  });
});

describe("reading big sheets once", () => {
  test("a sheet is read once while its listing stands, and again when the listing says it changed", async () => {
    const notes: ListNote[] = [{ path: "data/eval-ci/about.md", properties: { source: "push" } }, METRIC];
    const at = (updatedAt: number) => ({
      data: listing("data", [entry("data/eval-ci", "folder"), entry("data/metrics", "folder")]),
      "data/eval-ci": listing("data/eval-ci", [entry("data/eval-ci/about.md"), { ...entry("data/eval-ci/bench-runs.csv"), updatedAt }]),
      "data/metrics": listing("data/metrics", [entry(METRIC.path)]),
    });
    let reads = 0;
    const readBody = async () => {
      reads += 1;
      return { text: BENCH, encrypted: false };
    };
    const first = world({ notes, listings: at(1000), readBody });
    const node = document.createElement("div");
    document.body.appendChild(node);
    const root = createRoot(node);
    roots.push({ root, node });
    const draw = async (w: World) => {
      await act(async () => {
        root.render(h(ThemeProvider, { scheme: "light", children: h(Data, { w }) }));
      });
      for (let i = 0; i < 6; i += 1) {
        await act(async () => {
          await new Promise((done) => setTimeout(done, 1));
        });
      }
    };
    await draw(first);
    await draw(first);
    expect(reads).toBe(1);
    // A sync lands: the same source, its listing newer.
    await draw({ source: first.source, nesting: world({ listings: at(2000) }).nesting });
    expect(reads).toBe(2);
    expect(rowsText(node)[0]).toContain("3.0%");
  });
});
