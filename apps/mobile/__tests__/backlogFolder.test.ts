/**
 * BACKLOG IS A FOLDER WHERE THE PAGE HAS ONE.
 *
 * Reported by the owner on 2026-09-28: "where is the backlog where I can drag
 * things in there". On a projects folder the parked projects live in
 * `1-projects/backlog/`, which the List drew as one more project called
 * Backlog. A folder named `backlog` (any case) directly in the page's folder
 * is the page's Backlog band: drawn first and folded, counting what is in it,
 * never also a row; a drop there moves the row in, and a row dragged out onto
 * a status group moves back and takes that status. A writer always has the
 * band to drop on; a reader sees it only when something is in it.
 *
 * Pure — `listLayout.ts` and `tasks/backlogFolder.ts`.
 */

import { describe, expect, test } from "@jest/globals";
import { defaultStatusList } from "../../mcp/src/lists.js";
import { folderItems } from "../features/console/files/folderPage/model";
import { BACKLOG_EMPTY_HINT, listLayout } from "../features/console/files/folderPage/listLayout";
import { backlogFolderOf, isBacklogFolder, isParked, planParkInFolder, planUnpark } from "../features/console/files/folderPage/tasks/backlogFolder";
import { runTaskPlan, type TaskRef, type TaskSnapshot } from "../features/console/files/folderPage/tasks/taskWrites";
import type { StatusList } from "../features/console/files/folderPage/statuses";
import type { ListNote } from "../features/console/files/listBlock/model";
import type { FileEntry } from "../features/console/files/types";

const P = "1-projects";
const entry = (kind: "file" | "folder", path: string): FileEntry => ({
  kind,
  path,
  name: path.split("/").pop()!,
  visibility: "team",
  inherited: "team",
  exception: false,
  readOnly: false,
});
const note = (path: string, properties: ListNote["properties"] = {}): ListNote => ({ path, properties, updatedAt: 1 });
const list = defaultStatusList() as StatusList;
/** A list with no backlog word anywhere. */
const noWord: StatusList = { ...list, "not-started": list["not-started"].filter((word) => word.toLowerCase() !== "backlog") };

const NOTES: ListNote[] = [
  note(`${P}/cafe/overview.md`, { status: "in progress" }),
  note(`${P}/portal/overview.md`, { status: "to do" }),
  note(`${P}/Backlog/overview.md`, {}),
  note(`${P}/Backlog/podcast/overview.md`, { status: "idea" }),
  note(`${P}/Backlog/maps.md`, {}),
  note(`${P}/reading.md`, {}),
];
const ENTRIES = [
  entry("folder", `${P}/cafe`),
  entry("folder", `${P}/portal`),
  entry("folder", `${P}/Backlog`),
  entry("file", `${P}/reading.md`),
];
const items = folderItems(P, ENTRIES, NOTES).items;
const backlog = backlogFolderOf(items, P)!;
const paths = (section: { columns: readonly { rows: readonly { item: { path: string } }[] }[] }) =>
  section.columns.flatMap((column) => column.rows.map((row) => row.item.path));

describe("which folder is the Backlog", () => {
  test("a folder named backlog, in any case, directly in the page's folder", () => {
    expect(backlog.path).toBe(`${P}/Backlog`);
    expect(isBacklogFolder({ kind: "folder", path: `${P}/BACKLOG` }, P)).toBe(true);
    // Not a note called backlog, and not one deeper down.
    expect(isBacklogFolder({ kind: "note", path: `${P}/backlog.md` }, P)).toBe(false);
    expect(isBacklogFolder({ kind: "folder", path: `${P}/cafe/backlog` }, P)).toBe(false);
    expect(isParked(`${P}/Backlog/maps.md`, backlog.path)).toBe(true);
    expect(isParked(`${P}/Backlog/podcast/overview.md`, backlog.path)).toBe(false);
    expect(isParked(`${P}/cafe`, null)).toBe(false);
  });
});

describe("the band", () => {
  const layout = listLayout(items, list, NOTES, null, { folder: backlog, always: false });

  test("is drawn first and folded, and holds what is in the folder, task or not", () => {
    const first = layout.sections[0]!;
    expect([first.key, first.label, first.folded, first.folder]).toEqual(["backlog", "Backlog", true, `${P}/Backlog`]);
    expect(first.total).toBe(2);
    expect(paths(first).sort()).toEqual([`${P}/Backlog/maps.md`, `${P}/Backlog/podcast`]);
  });

  test("the folder is never also a row or a note of the page", () => {
    const everywhere = [...layout.sections.flatMap(paths), ...layout.notes.map((item) => item.path)];
    expect(everywhere).not.toContain(`${P}/Backlog`);
    expect(layout.notes.map((item) => item.path)).toEqual([`${P}/reading.md`]);
  });

  test("an empty folder is a band to drop on for a writer, and nothing for a reader", () => {
    const empty = folderItems(P, [entry("folder", `${P}/cafe`), entry("folder", `${P}/backlog`)], [note(`${P}/cafe/overview.md`, { status: "to do" })]).items;
    const folder = backlogFolderOf(empty, P);
    const writer = listLayout(empty, noWord, [], null, { folder, always: true });
    expect([writer.sections[0]!.key, writer.sections[0]!.total, writer.sections[0]!.folder]).toEqual(["backlog", 0, `${P}/backlog`]);
    const reader = listLayout(empty, noWord, [], null, { folder, always: false });
    expect(reader.sections.map((section) => section.key)).not.toContain("backlog");
    expect(BACKLOG_EMPTY_HINT).toBe("Drop here to park");
  });

  test("a writer's page with the backlog word and no folder keeps an empty band; one with neither has none", () => {
    const plain = folderItems(P, [entry("folder", `${P}/cafe`)], [note(`${P}/cafe/overview.md`, { status: "to do" })]).items;
    const word = listLayout(plain, list, [], null, { folder: null, always: true });
    expect([word.sections[0]!.key, word.sections[0]!.folder]).toEqual(["backlog", null]);
    const neither = listLayout(plain, noWord, [], null, { folder: null, always: true });
    expect(neither.sections.map((section) => section.key)).not.toContain("backlog");
  });

  test("a row with the backlog word and a parked row share the one band", () => {
    const both = [...NOTES, note(`${P}/someday.md`, { status: "backlog" })];
    const withWord = folderItems(P, [...ENTRIES, entry("file", `${P}/someday.md`)], both).items;
    const layoutBoth = listLayout(withWord, list, both, null, { folder: backlogFolderOf(withWord, P), always: false });
    expect(layoutBoth.sections.filter((section) => section.key === "backlog")).toHaveLength(1);
    expect(paths(layoutBoth.sections[0]!)).toContain(`${P}/someday.md`);
    expect(layoutBoth.sections[0]!.total).toBe(3);
  });
});

const snapshot: TaskSnapshot = { folder: P, notes: NOTES };
const ref = (path: string, status: string, kind: "note" | "folder" = "folder"): TaskRef => ({
  path,
  kind,
  target: kind === "folder" ? `${path}/overview.md` : path,
  creates: false,
  label: path.split("/").pop()!,
  status,
});

describe("parking in the folder", () => {
  test("moves the row in, keeping its status, and Undo moves it back", async () => {
    const planned = planParkInFolder(ref(`${P}/cafe`, "in progress"), backlog.path, snapshot);
    expect(planned.ok && planned.plan.steps).toEqual([{ kind: "move", from: `${P}/cafe`, to: `${P}/Backlog/cafe` }]);
    expect(planned.ok && planned.plan.message).toBe("Moved “cafe” to Backlog.");
    const done: string[] = [];
    const io = { create: async () => undefined, move: async (from: string, to: string) => void done.push(`${from} -> ${to}`), setProperties: async () => null };
    const run = await runTaskPlan(io, planned.ok ? planned.plan : (null as never));
    expect(run.ok).toBe(true);
    await (run.ok ? run.undo?.() : undefined);
    expect(done).toEqual([`${P}/cafe -> ${P}/Backlog/cafe`, `${P}/Backlog/cafe -> ${P}/cafe`]);
  });

  test("a name already taken in the folder is not overwritten", () => {
    const taken: TaskSnapshot = { folder: P, notes: [...NOTES, note(`${P}/Backlog/cafe/overview.md`)] };
    const planned = planParkInFolder(ref(`${P}/cafe`, "to do"), backlog.path, taken);
    expect(planned.ok && planned.plan.path).not.toBe(`${P}/Backlog/cafe`);
    expect(planned.ok && planned.plan.path.startsWith(`${P}/Backlog/`)).toBe(true);
  });

  test("refuses the folder itself, a row already parked, and a row that is not directly on the page", () => {
    expect(planParkInFolder(ref(backlog.path, ""), backlog.path, snapshot).ok).toBe(false);
    expect(planParkInFolder(ref(`${P}/Backlog/maps.md`, "", "note"), backlog.path, snapshot).ok).toBe(false);
    expect(planParkInFolder(ref(`${P}/cafe/oven.md`, "to do", "note"), backlog.path, snapshot).ok).toBe(false);
  });
});

describe("bringing a row out", () => {
  test("moves it to the page's folder and gives its front note the group's status; Undo takes both back, last first", async () => {
    const planned = planUnpark(ref(`${P}/Backlog/podcast`, "idea"), backlog.path, "in progress", snapshot);
    expect(planned.ok && planned.plan.steps).toEqual([
      { kind: "move", from: `${P}/Backlog/podcast`, to: `${P}/podcast` },
      { kind: "set", path: `${P}/podcast/overview.md`, changes: [["status", "in progress"]], creates: false, previous: [["status", "idea"]] },
    ]);
    expect(planned.ok && planned.plan.message).toBe("Moved “podcast” out of Backlog to In progress.");
    const done: string[] = [];
    const io = {
      create: async () => undefined,
      move: async (from: string, to: string) => void done.push(`move ${from} -> ${to}`),
      setProperties: async (path: string, changes: readonly (readonly [string, unknown])[]) => (done.push(`set ${path} ${JSON.stringify(changes)}`), null),
    };
    const run = await runTaskPlan(io, planned.ok ? planned.plan : (null as never));
    await (run.ok ? run.undo?.() : undefined);
    expect(done).toEqual([
      `move ${P}/Backlog/podcast -> ${P}/podcast`,
      `set ${P}/podcast/overview.md [["status","in progress"]]`,
      `set ${P}/podcast/overview.md [["status","idea"]]`,
      `move ${P}/podcast -> ${P}/Backlog/podcast`,
    ]);
  });

  test("a note with no status is given one; a row already of that status only moves", () => {
    const plain = planUnpark(ref(`${P}/Backlog/maps.md`, "", "note"), backlog.path, "to do", snapshot);
    expect(plain.ok && plain.plan.steps[1]).toMatchObject({ kind: "set", path: `${P}/maps.md`, previous: [["status", null]] });
    const same = planUnpark(ref(`${P}/Backlog/podcast`, "idea"), backlog.path, "Idea", snapshot);
    expect(same.ok && same.plan.steps).toHaveLength(1);
  });

  test("refuses a row that is not parked", () => {
    expect(planUnpark(ref(`${P}/cafe`, "in progress"), backlog.path, "to do", snapshot).ok).toBe(false);
  });
});
