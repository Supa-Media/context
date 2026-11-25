/**
 * @jest-environment jsdom
 */

/**
 * THE AREAS PAGE READS AN AREA'S METRIC FROM THE WORKSPACE'S METRICS, AND PICKS ONE.
 *
 * Stage C of data sources and metrics (the data sources boards, 05, 06 and
 * 13b): the Areas List draws a workspace metric's value worked out from the
 * reader's sheets, with the sources it reads; an area with none offers
 * "+ Pick a metric" to an editor and says "No metric yet" to a reader; the
 * picker lists the workspace's metrics and Save writes the seat's own line
 * and says so. A sheet the reader cannot read is "Hidden", never named.
 *
 * Sabotage record (temporary local edits, reverted):
 * 1. `AreasView` reading every area from its `metrics.csv` (`readingOf`
 *    ignoring the workspace): "Finance reads the workspace metric" fails.
 * 2. `NoMetric` offering the chip without `onPick`: "a reader sees No metric
 *    yet and no chip" fails.
 */

import { afterEach, beforeAll, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import type { FolderListSource, ListNote } from "../features/console/files/listBlock/model";
import type { FileEntry, FolderListing } from "../features/console/files/types";
import type { FolderPageHost } from "../features/console/files/folderPage/useFolderPage";
import { AreasView, type AreasViewProps } from "../features/console/files/folderPage/areas/AreasView";
import { setJobFoldersNow } from "../features/console/files/jobIcons/jobFoldersNow";
import { forgetPageCache } from "../features/console/files/folderPage/pageCache";
import { all, one, press, strip } from "./projectPage/fixtures";

const today = new Date().toISOString().slice(0, 10);

function entry(path: string, kind: "file" | "folder" = "file"): FileEntry {
  return { kind, path, name: path.slice(path.lastIndexOf("/") + 1), visibility: "team", inherited: "team", exception: false, readOnly: false };
}
function listing(path: string, entries: FileEntry[]): FolderListing {
  return { path, folderDefault: "team", truncated: false, manifestUsable: true, entries } as unknown as FolderListing;
}
const note = (path: string, properties: ListNote["properties"] = {}): ListNote => ({ path, properties });

const LISTINGS: Record<string, FolderListing> = {
  data: listing("data", [entry("data/stripe", "folder"), entry("data/cloudflare", "folder"), entry("data/metrics", "folder")]),
  "data/stripe": listing("data/stripe", [entry("data/stripe/about.md"), entry("data/stripe/revenue.csv")]),
  "data/cloudflare": listing("data/cloudflare", [entry("data/cloudflare/about.md"), entry("data/cloudflare/ai-spend.csv")]),
  "data/metrics": listing("data/metrics", [entry("data/metrics/revenue-per-ai-dollar.md")]),
};

const NOTES: ListNote[] = [
  note("data/stripe/about.md", { source: "stripe" }),
  note("data/cloudflare/about.md", { source: "cloudflare" }),
  note("data/metrics/revenue-per-ai-dollar.md", { metric: "Revenue per AI dollar", formula: "sum(stripe/revenue.usd) / sum(cloudflare/ai-spend.usd)", every: "month", format: "$0.00" }),
  note("areas/about.md"),
  note("areas/finance/about.md", { owner: "@dev", metrics: ["revenue per AI dollar · target over $5"] }),
  note("areas/design/about.md", { owner: "@seyi" }),
];

const SHEETS: Record<string, string> = {
  "data/stripe/revenue.csv": `date:date,plan,usd:number\n${today},Team,94\n`,
  "data/cloudflare/ai-spend.csv": `date:date,model,usd:number\n${today},claude,10\n`,
};

type Change = readonly [string, unknown];

function world(hidden: readonly string[] = []) {
  const writes: { target: string; changes: readonly Change[] }[] = [];
  const toasts: string[] = [];
  const source: FolderListSource = {
    load: async (folder, subfolders) => ({
      notes: NOTES.filter((each) => {
        const prefix = folder === "" ? "" : `${folder}/`;
        return each.path.startsWith(prefix) && (subfolders || !each.path.slice(prefix.length).includes("/"));
      }),
      complete: true,
    }),
    readBody: async (path) => (SHEETS[path] === undefined || hidden.includes(path) ? null : { text: SHEETS[path]!, encrypted: false }),
  };
  const host: FolderPageHost = {
    source,
    workspaceId: "ws_test",
    people: [],
    tasks: {
      io: { create: async () => {}, move: async () => {}, setProperties: async () => null, remove: async () => {} },
      say: (message: string) => void toasts.push(message),
      refresh: () => {},
    } as unknown as NonNullable<FolderPageHost["tasks"]>,
  };
  return { source, host, writes, toasts };
}

let root: Root | null = null;
let container: HTMLElement | null = null;

beforeAll(() => {
  setJobFoldersNow({ inbox: "inbox", archive: "archive", projects: "projects", areas: "areas", data: "data" });
});
afterEach(() => {
  if (root !== null) act(() => root!.unmount());
  container?.remove();
  root = null;
  container = null;
  forgetPageCache();
  jest.restoreAllMocks();
});

async function render(w: ReturnType<typeof world>, overrides: Partial<AreasViewProps> = {}) {
  const props: AreasViewProps = {
    folder: "areas",
    root: "areas",
    rootName: "Supa",
    notes: NOTES.filter((each) => each.path.startsWith("areas/")),
    view: "list",
    compact: false,
    canEdit: true,
    faceOf: (owner) => (owner === null ? { kind: "nobody" } : ({ kind: "person", name: owner } as never)),
    label: (owner) => owner.replace(/^@/, ""),
    isAgent: () => false,
    people: (async () => ({ people: [], agents: [], truncated: false })) as never,
    agents: [],
    chooseMany: async (target, changes) => {
      w.writes.push({ target, changes });
      return null;
    },
    onSelect: () => {},
    readBody: w.source.readBody!,
    listings: { listingOf: (path) => LISTINGS[path], loadListing: () => {} },
    host: w.host,
    ...overrides,
  };
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  await act(async () => {
    root!.render(createElement(AreasView, props));
  });
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((done) => setTimeout(done, 0));
    });
  }
}

describe("an area's metric on the Areas page", () => {
  test("Finance reads the workspace metric its seat names, in any case, with the sources it reads", async () => {
    await render(world());
    const row = strip(one("area-row-areas/finance").textContent);
    expect(row).toContain("$9.40");
    expect(row).toContain("> $5");
    expect(strip(one("area-metric-source", one("area-row-areas/finance")).textContent)).toContain("Stripe + Cloudflare");
  });

  test("a sheet the reader cannot read makes it Hidden, and names no sheet", async () => {
    await render(world(["data/cloudflare/ai-spend.csv"]));
    const row = strip(one("area-row-areas/finance").textContent);
    expect(row).toContain("Hidden");
    expect(row).not.toContain("$9.40");
    expect(document.body.textContent).not.toContain("ai-spend");
  });

  test("an area with no metric offers Pick a metric, and Save writes the seat line and says so", async () => {
    const w = world();
    await render(w);
    const design = one("area-row-areas/design");
    expect(strip(design.textContent)).toContain("No metric");
    await press(one("area-pick-areas/design"));
    const picker = one("metric-picker");
    expect(strip(picker.textContent)).toContain("Design metric");
    expect(strip(picker.textContent)).toContain("Design · seyi");
    expect(strip(picker.textContent)).toContain("Saved in areas/design/about.md");
    const option = one("metric-option-data/metrics/revenue-per-ai-dollar.md");
    expect(strip(option.textContent)).toContain("Stripe + Cloudflare · used by Finance");
    await press(option);
    await press(one("metric-target-under"));
    const input = one("metric-target-value") as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "$3");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(strip(one("metric-target-hint").textContent)).toBe("Green when the latest value is under $3.");
    await press(one("metric-picker-save"));
    await act(async () => {});
    expect(w.writes).toHaveLength(1);
    const changes = new Map(w.writes[0]!.changes);
    expect(w.writes[0]!.target).toBe("areas/design/about.md");
    expect(changes.get("metrics")).toEqual(["Revenue per AI dollar · target under $3"]);
    expect(w.toasts).toEqual(["Design now tracks Revenue per AI dollar."]);
    expect(all("metric-picker")).toHaveLength(0);
  });

  test("the picker opens on the area's metric and target", async () => {
    await render(world());
    await press(one("area-more-areas/finance"));
    await press(one("menu-item-metric"));
    expect(one("metric-option-data/metrics/revenue-per-ai-dollar.md").getAttribute("aria-checked")).toBe("true");
    expect((one("metric-target-value") as HTMLInputElement).value).toBe("$5");
    expect(one("metric-target-over").getAttribute("aria-checked")).toBe("true");
  });

  test("a reader sees No metric yet and no chip", async () => {
    await render(world(), { canEdit: false });
    expect(strip(one("area-row-areas/design").textContent)).toContain("No metric yet");
    expect(all("area-pick-areas/design")).toHaveLength(0);
  });

  test("on a phone the picker is a sheet whose Over and Under are both whole, the value beside them and the hint under", async () => {
    await render(world(), { compact: true });
    await press(one("area-pick-areas/design"));
    expect(strip(one("metric-target-over").textContent)).toBe("Over");
    expect(strip(one("metric-target-under").textContent)).toBe("Under");
    // The hint is its own line, not squeezed into the row with the segment and the value.
    expect(one("metric-target-hint").parentElement).not.toBe(one("metric-target-value").parentElement);
  });
});
