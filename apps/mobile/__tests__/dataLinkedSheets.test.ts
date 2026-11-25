/**
 * A source's sheet kept outside its folder (`apps/mcp/src/data/sheetLinks.js`): the about note's `sheets:` links
 * name it, the metric reads it by `source/<file name>`, and only the folders those links name are listed.
 *
 * SABOTAGE: drop `linked` from `sourceOf`'s datasets in `data/sources.ts` → "a linked sheet is one of its source's
 * datasets" fails; make `foldersOfLinkedSheets` return [] → "only the folders the links name are listed" fails.
 */

import { describe, expect, test } from "@jest/globals";
import type { ListNote } from "../features/console/files/listBlock/model";
import type { FileEntry, FolderListing } from "../features/console/files/types";
import { sourceAt, sourcesIn } from "../features/console/files/data/sources";
import { foldersOfLinkedSheets, rowsReader } from "../features/console/files/data/useDataWorkspace";
import type { Sheet } from "../features/console/files/data/workOut";

function entry(path: string, kind: "file" | "folder" = "file"): FileEntry {
  return { kind, path, name: path.slice(path.lastIndexOf("/") + 1), visibility: "team", inherited: "team", exception: false, readOnly: false };
}
function listing(path: string, entries: FileEntry[]): FolderListing {
  return { path, folderDefault: "team", truncated: false, manifestUsable: true, entries } as unknown as FolderListing;
}

const LISTINGS: Record<string, FolderListing> = {
  data: listing("data", [entry("data/filings", "folder"), entry("data/github", "folder"), entry("data/metrics", "folder")]),
  "data/filings": listing("data/filings", [entry("data/filings/about.md"), entry("data/filings/old.csv")]),
  "data/github": listing("data/github", [entry("data/github/about.md"), entry("data/github/deploys.csv")]),
};
const listingOf = (path: string) => LISTINGS[path];
const NOTES: ListNote[] = [
  {
    path: "data/filings/about.md",
    properties: { source: "push", sheets: ["[[areas/operations/Filings/filings.csv]]", "[[areas/elsewhere/old.csv]]", "[[../escape.csv]]"] },
  },
  { path: "data/github/about.md", properties: { source: "github" } },
];

describe("a source's sheet can live anywhere its about note links", () => {
  test("a linked sheet is one of its source's datasets, named by its file, and the folder's own sheet keeps its name", () => {
    const filings = sourceAt("data/filings", listingOf, NOTES);
    expect(filings.datasets.map((d) => [d.name, d.path])).toEqual([
      ["old", "data/filings/old.csv"],
      ["filings", "areas/operations/Filings/filings.csv"],
    ]);
  });

  test("only the folders the links name are listed, never the sources' own", () => {
    const sources = sourcesIn("data", listingOf, NOTES);
    expect(foldersOfLinkedSheets(sources)).toEqual(["areas/operations/Filings"]);
  });

  test("a formula's source/dataset reads the linked sheet", () => {
    const sheet = { columns: [], rows: [] } as unknown as Sheet;
    const rowsOf = rowsReader(sourcesIn("data", listingOf, NOTES), new Map([["areas/operations/Filings/filings.csv", sheet]]));
    expect(rowsOf("filings", "Filings")).toBe(sheet);
    expect(rowsOf("filings", "missing")).toBeNull();
  });
});
