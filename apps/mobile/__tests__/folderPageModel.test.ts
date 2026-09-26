/**
 * A folder page that shows what is in it by status: which note speaks for a
 * folder, where a status is written when nothing does yet, and the order the
 * groups are drawn in. Pure — `folderPage/model.ts` takes the listing and the
 * device's notes and decides nothing about drawing.
 */

import { describe, expect, test } from "@jest/globals";
import {
  defaultFolderView,
  folderItems,
  groupFolderItems,
  dropValue,
  propertyChoices,
  summarizeFolder,
} from "../features/console/files/folderPage/model";
import { defaultStatusList } from "../../mcp/src/lists.js";
import { statusBands, type StatusList } from "../features/console/files/folderPage/statuses";
import type { ListNote } from "../features/console/files/listBlock/model";
import type { FileEntry } from "../features/console/files/types";

const strip = (text: string): string => text.replace(/[\u2066-\u2069]/g, "");

const folder = (path: string): FileEntry => ({
  kind: "folder",
  path,
  name: path.split("/").pop()!,
  visibility: "team",
  inherited: "team",
  exception: false,
  readOnly: false,
});
const file = (path: string): FileEntry => ({ ...folder(path), kind: "file" });

const note = (path: string, properties: Record<string, string> = {}, extra: Partial<ListNote> = {}): ListNote => ({
  path,
  properties,
  updatedAt: 1_000,
  ...extra,
});

describe("the note that speaks for a folder", () => {
  test("is overview.md before index.md before README.md", () => {
    const notes = [
      note("p/web/README.md", { status: "paused" }),
      note("p/web/index.md", { status: "planned" }),
      note("p/web/overview.md", { status: "active" }, { heading: "Website" }),
    ];
    const summary = summarizeFolder("p/web", notes);
    expect(summary.target).toBe("p/web/overview.md");
    expect(summary.creates).toBe(false);
    expect(summary.properties.status).toBe("active");
    expect(strip(summary.title ?? "")).toBe("Website");
    expect(summarizeFolder("p/web", notes.slice(0, 2)).target).toBe("p/web/index.md");
  });

  test("a folder with no front note writes to a new overview.md", () => {
    const summary = summarizeFolder("p/do this", [note("p/do this/sketch.md")]);
    expect(summary.target).toBe("p/do this/overview.md");
    expect(summary.creates).toBe(true);
    expect(summary.title).toBeNull();
    expect(summary.properties).toEqual({});
  });

  test("a front note deeper down is not this folder's", () => {
    const summary = summarizeFolder("p", [note("p/web/overview.md", { status: "active" })]);
    expect(summary.creates).toBe(true);
    expect(summary.properties.status).toBeUndefined();
  });

  test("updated is the newest save anywhere inside the folder", () => {
    const summary = summarizeFolder("p/web", [
      note("p/web/overview.md", {}, { updatedAt: 5 }),
      note("p/web/deep/cert.md", {}, { updatedAt: 90 }),
    ]);
    expect(summary.updatedAt).toBe(90);
  });
});

describe("a folder's children as items", () => {
  const entries = [folder("p/web"), folder("p/backlog"), folder("p/do this"), file("p/loose.md"), file("p/overview.md"), file("p/logo.png")];
  const notes = [
    note("p/overview.md", { status: "active" }),
    note("p/web/overview.md", { status: "active", owner: "Seyi" }, { updatedAt: 50 }),
    note("p/web/dns/overview.md", { status: "done" }, { updatedAt: 10 }),
    note("p/web/certs.md", { status: "planned" }, { updatedAt: 20 }),
    note("p/backlog/idea.md", {}, { updatedAt: 70 }),
    note("p/loose.md", { status: "paused" }),
  ];

  test("folders and notes are both items; the folder's own front note and attachments are not", () => {
    const { items, skipped } = folderItems("p", entries, notes);
    expect(items.map((item) => item.path)).toEqual(["p/web", "p/backlog", "p/do this", "p/loose.md"]);
    expect(skipped).toBe(1);
  });

  test("a folder is read through its front note, a note through itself", () => {
    const { items } = folderItems("p", entries, notes);
    const web = items.find((item) => item.path === "p/web")!;
    expect(web).toMatchObject({ kind: "folder", target: "p/web/overview.md", creates: false, status: "active", updatedAt: 50 });
    expect(web.properties.owner).toBe("Seyi");
    const backlog = items.find((item) => item.path === "p/backlog")!;
    expect(backlog).toMatchObject({ target: "p/backlog/overview.md", creates: true, status: "", updatedAt: 70 });
    const loose = items.find((item) => item.path === "p/loose.md")!;
    expect(loose).toMatchObject({ kind: "note", target: "p/loose.md", creates: false, status: "paused" });
  });

  test("a folder with sub-projects counts how many are closed", () => {
    const { items } = folderItems("p", entries, notes);
    expect(items.find((item) => item.path === "p/web")!.progress).toEqual({ done: 1, total: 2 });
    expect(items.find((item) => item.path === "p/backlog")!.progress).toBeNull();
  });
});

describe("groups", () => {
  const items = folderItems(
    "p",
    [folder("p/a"), folder("p/b"), folder("p/c"), folder("p/d"), folder("p/e"), file("p/f.md"), file("p/g.md")],
    [
      note("p/a/overview.md", { status: "done" }),
      note("p/b/overview.md", { status: "Active" }),
      note("p/c/overview.md", { status: "planned" }),
      note("p/d/overview.md", { status: "paused" }),
      note("p/f.md", { status: "waiting on legal" }),
      note("p/g.md"),
    ],
  ).items;

  const list = defaultStatusList() as StatusList;

  test("run No status, Not started, In progress, Done, then words in no group", () => {
    const groups = groupFolderItems(items, "status", list);
    expect(groups.map((group) => strip(group.label))).toEqual([
      "No status",
      "Planned",
      "Active",
      "Paused",
      "Done",
      "Waiting on legal",
    ]);
    // A folder with nothing in it and a note with no frontmatter both sit in
    // No status: nothing is held back in a bucket of its own.
    expect(groups[0].items.map((item) => item.path)).toEqual(["p/g.md", "p/e"]);
  });

  test("newest first within a group", () => {
    const within = folderItems(
      "p",
      [folder("p/old"), folder("p/new")],
      [note("p/old/overview.md", { status: "active" }, { updatedAt: 1 }), note("p/new/overview.md", { status: "active" }, { updatedAt: 9 })],
    ).items;
    expect(groupFolderItems(within, "status", defaultStatusList() as StatusList)[0].items.map((item) => item.path)).toEqual(["p/new", "p/old"]);
  });
});

describe("the view a folder opens in", () => {
  test("is the grouped list once anything in it has a status, and files otherwise", () => {
    const withStatus = folderItems("p", [folder("p/a")], [note("p/a/overview.md", { status: "active" })]).items;
    const without = folderItems("p", [folder("p/a"), folder("p/b")], []).items;
    expect(defaultFolderView(withStatus)).toBe("list");
    expect(defaultFolderView(without)).toBe("files");
  });
});

describe("what a value menu offers", () => {
  test("a status is chosen from the folder's status list, not from whatever words are in use", () => {
    const items = folderItems("p", [folder("p/a")], [note("p/a/overview.md", { status: "paused" })]).items;
    // Everything "paused" still offers "finished": moving a card on is one press, never typing.
    expect(propertyChoices(items, "status", defaultStatusList() as StatusList)).toEqual(["in progress", "finished"]);
    const list = { "not-started": ["exploration"], "in-progress": ["doing"], done: ["won", "lost"] };
    expect(propertyChoices([], "status", list)).toEqual(["exploration", "doing", "won", "lost"]);
  });
});

describe("the placeholder a new folder is made with", () => {
  const placeholder = note("p/do this/README.md", {}, { lede: "Folder placeholder. Object storage has no empty folders, so this file is what makes p/do this/ exist." });

  test("is not a front note, so a first status creates overview.md beside it", () => {
    const summary = summarizeFolder("p/do this", [placeholder]);
    expect(summary).toMatchObject({ target: "p/do this/overview.md", creates: true, lede: null });
  });

  test("is one once somebody has written in it", () => {
    const written = { ...placeholder, properties: { status: "active" } };
    expect(summarizeFolder("p/do this", [written])).toMatchObject({ target: "p/do this/README.md", creates: false });
    const rewritten = note("p/do this/README.md", {}, { lede: "What this folder is for." });
    expect(summarizeFolder("p/do this", [rewritten]).target).toBe("p/do this/README.md");
  });
});

describe("a board's columns and what a drop writes", () => {
  const items = folderItems(
    "p",
    [folder("p/a"), folder("p/b"), folder("p/c")],
    [note("p/a/overview.md", { status: "Active" }), note("p/b/overview.md", { status: "done" })],
  ).items;
  const list = defaultStatusList() as StatusList;
  const groups = groupFolderItems(items, "status", list);
  const shape = (bands: ReturnType<typeof statusBands>) =>
    bands.map((band) => [band.label, band.columns.map((column) => [column.value, column.items.length])]);

  test("a column for every status in the list, empty or not, under its group", () => {
    expect(shape(statusBands(groups, list, false))).toEqual([
      ["Not started", [["", 1]]],
      ["In progress", [["in progress", 0], ["Active", 1]]],
      ["Done", [["finished", 0], ["done", 1]]],
    ]);
  });

  test("No status is a column to drop on for a writer even when nothing is in it, and not for a reader", () => {
    const tracked = groupFolderItems(items.filter((item) => item.status !== ""), "status", list);
    expect(shape(statusBands(tracked, list, true))[0]).toEqual(["Not started", [["", 0]]]);
    expect(shape(statusBands(tracked, list, false)).map(([label]) => label)).toEqual(["In progress", "Done"]);
  });

  test("a drop writes the column's value, clears on No status, and does nothing where the card already is", () => {
    expect(dropValue({ status: "Active" }, "done")).toBe("done");
    expect(dropValue({ status: "Active" }, "")).toBeNull();
    expect(dropValue({ status: "Active" }, "active")).toBeUndefined();
    expect(dropValue({ status: "" }, "")).toBeUndefined();
    expect(dropValue({ status: "" }, "planned")).toBe("planned");
  });
});
