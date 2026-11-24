/**
 * THE AREAS PAGE, AND EVERY SUB-AREA, OPENS AT ONCE.
 *
 * Owner, 2026-11-24: "the areas page takes like half a second to 2 seconds to
 * load … even to sub areas. Make it immediately snappy." The page waited for
 * its folder's notes and then each area's metrics.csv on every open, while the
 * Projects List is drawn from the listing at hand. Now the Areas folder is
 * read ahead with its sheets (`preloadAreas`), a sub-area is drawn from the
 * read above it (`cachedFolder`), and readings are kept (`useReadings`).
 */

import { describe, expect, jest, test } from "@jest/globals";
import { cachedFolder, cachedFront, folderPageReady, forgetPageCache, readFolder } from "../features/console/files/folderPage/pageCache";
import { preloadAreas } from "../features/console/files/folderPage/areas/preloadAreas";
import { keptReadings, readReadings } from "../features/console/files/folderPage/areas/useReadings";
import type { FolderListSource, ListNote } from "../features/console/files/listBlock/model";

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

function note(path: string, properties: Record<string, string | string[]> = {}): ListNote {
  return { path, updatedAt: 1, properties, heading: null, lede: null };
}

const NOTES = [
  note("about.md"),
  note("areas/about.md"),
  note("areas/loose.md"),
  note("areas/eng/about.md", { area: "true", owner: "@ada", metrics: ["PR time to ship"] }),
  note("areas/eng/notes.md"),
  note("areas/eng/infra/about.md", { area: "true", owner: "@lin", metrics: ["Monthly cost"] }),
  note("areas/eng/infra/runbook.md"),
  note("areas/sales/about.md", { area: "true" }),
];
const SHEETS: Record<string, string> = {
  "areas/eng/metrics.csv": "date,metric,value\n2026-11-23,PR time to ship,2.4 days",
  "areas/eng/infra/metrics.csv": "date,metric,value\n2026-11-23,Monthly cost,$512",
};

function fakeSource() {
  const asked = { load: [] as string[], readBody: [] as string[] };
  const source: FolderListSource = {
    load: async (folder, subfolders) => {
      asked.load.push(folder);
      const prefix = folder === "" ? "" : `${folder}/`;
      return {
        notes: NOTES.filter((each) => each.path.startsWith(prefix) && (subfolders || !each.path.slice(prefix.length).includes("/"))),
        complete: true,
      };
    },
    loadFront: async (folders) =>
      NOTES.filter((each) => folders.includes(each.path.includes("/") ? each.path.slice(0, each.path.lastIndexOf("/")) : "") && each.path.endsWith("/about.md") || (folders.includes("") && each.path === "about.md")),
    readBody: async (path) => {
      asked.readBody.push(path);
      return path in SHEETS ? { text: SHEETS[path]!, encrypted: false } : null;
    },
  };
  return { source, asked };
}

describe("a sub-area is drawn from the Areas folder's read", () => {
  test("its notes and the front notes above it, exactly what its own read would answer", async () => {
    const { source } = fakeSource();
    await readFolder(source, "areas");
    const derived = cachedFolder(source, "areas/eng/infra")?.notes.map((each) => each.path).sort();
    const { source: other } = fakeSource();
    const own = (await readFolder(other, "areas/eng/infra")).notes.map((each) => each.path).sort();
    expect(derived).toEqual(own);
    // A note beside the folder above is not one of its front notes.
    expect(derived).not.toContain("areas/eng/notes.md");
    expect(derived).not.toContain("areas/loose.md");
    expect(cachedFront(source, "areas/eng")?.map((each) => each.path)).toEqual(["areas/eng/about.md"]);
  });

  test("the same notes every render, so a page drawn from them does not redraw", async () => {
    const { source } = fakeSource();
    await readFolder(source, "areas");
    expect(cachedFolder(source, "areas/eng")).toBe(cachedFolder(source, "areas/eng"));
  });

  test("its own read, once it lands, wins", async () => {
    const { source } = fakeSource();
    await readFolder(source, "areas");
    const own = await readFolder(source, "areas/eng");
    expect(cachedFolder(source, "areas/eng")).toBe(own);
  });

  test("a folder beside the one read is not drawn from it", async () => {
    const { source } = fakeSource();
    await readFolder(source, "areas/eng");
    expect(cachedFolder(source, "areas/sales")).toBeUndefined();
    expect(cachedFolder(source, "areas")).toBeUndefined();
  });

  test("a gap under the sub-area keeps it incomplete; a gap elsewhere does not", async () => {
    const { source } = fakeSource();
    const gappy: FolderListSource = {
      ...source,
      load: async (folder, subfolders) => ({ ...(await source.load(folder, subfolders))!, complete: false, missing: ["areas/eng/infra/runbook.md"] }),
    };
    await readFolder(gappy, "areas");
    expect(cachedFolder(gappy, "areas/eng/infra")?.complete).toBe(false);
    expect(cachedFolder(gappy, "areas/sales")?.complete).toBe(true);
  });

  test("signing out forgets what was drawn from it", async () => {
    const { source } = fakeSource();
    await readFolder(source, "areas");
    forgetPageCache();
    expect(cachedFolder(source, "areas/eng")).toBeUndefined();
  });
});

describe("the Areas folder is read ahead, sheets and all", () => {
  test("its page and every sub-area's are ready before anything is opened", async () => {
    const { source, asked } = fakeSource();
    preloadAreas(source, "areas");
    await flush();
    expect(folderPageReady(source, "areas")).toBe(true);
    expect(cachedFolder(source, "areas/eng/infra")).toBeDefined();
    // One read of the folder, shared with the page's own preload, and one per sheet.
    expect(asked.load.filter((folder) => folder === "areas")).toHaveLength(1);
    expect(asked.readBody.filter((path) => path.endsWith("metrics.csv")).sort()).toEqual(["areas/eng/infra/metrics.csv", "areas/eng/metrics.csv"]);
    const readings = keptReadings(source.readBody, ["areas/eng/infra"]);
    expect(readings.get("areas/eng/infra")?.size).toBe(1);
  });

  test("a sheet already on its way is not read twice", async () => {
    const { source, asked } = fakeSource();
    await Promise.all([readReadings(source.readBody!, ["areas/eng"]), readReadings(source.readBody!, ["areas/eng"])]);
    expect(asked.readBody).toEqual(["areas/eng/metrics.csv"]);
  });

  test("readings kept under one sign-in are forgotten with the page cache", async () => {
    const { source } = fakeSource();
    await readReadings(source.readBody!, ["areas/eng"]);
    expect(keptReadings(source.readBody, ["areas/eng"]).size).toBe(1);
    forgetPageCache();
    expect(keptReadings(source.readBody, ["areas/eng"]).size).toBe(0);
  });

  test("nothing is read without a source or an Areas folder", () => {
    expect(() => preloadAreas(undefined, "areas")).not.toThrow();
    const { source, asked } = fakeSource();
    preloadAreas(source, "");
    expect(asked.load).toHaveLength(0);
  });
});

describe("a reload draws what this tab last read", () => {
  function fakeSessionStorage() {
    const data = new Map<string, string>();
    const storage = {
      get length() {
        return data.size;
      },
      key: (i: number) => [...data.keys()][i] ?? null,
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
    };
    (globalThis as { sessionStorage?: unknown }).sessionStorage = storage;
    return data;
  }
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  test("the Areas page, its sub-areas and their readings, with no note's whole text", async () => {
    const data = fakeSessionStorage();
    forgetPageCache();
    const { source } = fakeSource();
    const before: FolderListSource = { ...source, tabKey: "team:w1" };
    preloadAreas(before, "areas");
    await flush();
    await wait(500);
    expect([...data.keys()]).toEqual(["context.lc.pages.v1:team:w1"]);
    expect(data.get("context.lc.pages.v1:team:w1")).not.toContain("\"text\"");

    // The reload: a new source for the same workspace and clearance, nothing in memory.
    let fresh!: typeof import("../features/console/files/folderPage/pageCache");
    let readings!: typeof import("../features/console/files/folderPage/areas/useReadings");
    jest.isolateModules(() => {
      fresh = require("../features/console/files/folderPage/pageCache");
      readings = require("../features/console/files/folderPage/areas/useReadings");
    });
    const { source: again, asked } = fakeSource();
    const after: FolderListSource = { ...again, tabKey: "team:w1" };
    expect(fresh.cachedFolder(after, "areas")?.notes.length).toBeGreaterThan(0);
    expect(fresh.cachedFolder(after, "areas/eng/infra")).toBeDefined();
    expect(readings.keptReadings(after.readBody, ["areas/eng/infra"]).get("areas/eng/infra")?.size).toBe(1);
    expect(asked.load).toHaveLength(0);

    // Another workspace or clearance draws none of it, and signing out forgets it.
    expect(fresh.cachedFolder({ ...again, tabKey: "private:w1" }, "areas")).toBeUndefined();
    fresh.forgetPageCache();
    expect(data.size).toBe(0);
    delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
  });
});
