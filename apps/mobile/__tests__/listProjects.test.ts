/**
 * @jest-environment jsdom
 */
/**
 * A folder list of projects in the editor: groups, sub-projects under a
 * twisty, progress, and the panel's Projects and Group choices. Which rows are
 * projects is `apps/mcp/src/lists/projects.js`, proved in
 * `apps/mcp/test/listProjects.test.mjs`; this is the half a person sees.
 */

import { beforeAll, describe, expect, test } from "@jest/globals";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { listHost, type ListHostContext, type ListNote } from "../features/console/files/listBlock/model";
import { captionFor, groupLabel } from "../features/console/files/listBlock/words";
import { livePreview, markdownLanguage } from "../features/console/files/livePreview";

const NOTES: ListNote[] = [
  { path: "1-projects/web/overview.md", updatedAt: 3, properties: { status: "active", owner: "Seyi" }, heading: "Website folder" },
  { path: "1-projects/web/renderer.md", updatedAt: 4, properties: { status: "done", owner: "Seyi" } },
  { path: "1-projects/web/members.md", updatedAt: 2, properties: { status: "active", owner: "Ada" } },
  { path: "1-projects/incident.md", updatedAt: 9, properties: { status: "done", owner: "Seyi" } },
  { path: "1-projects/later.md", updatedAt: 1, properties: { status: "paused" } },
  { path: "1-projects/idea.md", updatedAt: 8, properties: {} },
];

const doc = (...lines: string[]) => ["# Projects", "", "```list", ...lines, "```", ""].join("\n");

// jsdom lays nothing out; the editor measures text on a later frame.
beforeAll(() => {
  Range.prototype.getClientRects = () => Object.assign([], { item: () => null }) as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () =>
    ({ top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
});

function mount(text: string, opened: string[] = []): EditorView {
  const host: ListHostContext = {
    load: async () => ({ notes: NOTES, complete: true }),
    open: (path) => opened.push(path),
    selfPath: "1-projects/README.md",
  };
  const parent = document.createElement("div");
  document.body.append(parent);
  return new EditorView({
    parent,
    state: EditorState.create({
      doc: text,
      selection: { anchor: 0 },
      extensions: [markdownLanguage(), livePreview(), listHost.of({ current: host })],
    }),
  });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const texts = (view: EditorView, selector: string) =>
  [...view.dom.querySelectorAll(selector)].map((node) => node.textContent);
const field = <T extends HTMLElement>(view: EditorView, name: string) => view.dom.querySelector<T>(`[data-field="${name}"]`)!;
const body = (view: EditorView) => {
  const text = view.state.doc.toString();
  const start = text.indexOf("```list\n") + 8;
  return text.slice(start, text.indexOf("\n```", start));
};
function change(element: HTMLSelectElement, value: string): void {
  element.value = value;
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("a list of projects", () => {
  test("rows are projects, grouped in lifecycle order with counts", async () => {
    const view = mount(doc("from: 1-projects", "rows: projects", "group: status"));
    await flush();
    expect(texts(view, ".cm-lp-list-group")).toEqual(["Active1", "Paused1", "Done1"]);
    expect(texts(view, ".cm-lp-list-name")).toEqual(["Website folder", "later", "incident"]);
    expect(texts(view, ".cm-lp-list-cap")).toEqual(["projects · by status"]);
    view.destroy();
  });

  test("a folder project shows its progress and opens its sub-projects under a twisty", async () => {
    const opened: string[] = [];
    const view = mount(doc("from: 1-projects", "rows: projects", "group: status"), opened);
    await flush();
    expect(view.dom.querySelector(".cm-lp-list-progress")?.textContent).toBe("1/2");
    expect(view.dom.querySelectorAll(".cm-lp-list-sub")).toHaveLength(0);

    const twisty = view.dom.querySelector<HTMLButtonElement>(".cm-lp-list-twisty:not(:disabled)")!;
    expect(twisty.getAttribute("aria-expanded")).toBe("false");
    twisty.click();
    await flush();
    expect(opened).toEqual([]); // the twisty opens the row, not the note
    const subs = [...view.dom.querySelectorAll(".cm-lp-list-sub")];
    expect(subs.map((row) => row.querySelector(".cm-lp-list-name")?.textContent)).toEqual(["renderer", "members"]);
    // A sub-project is not in a group of its own, so it says its own status.
    expect(subs.map((row) => row.querySelector(".cm-lp-list-own")?.textContent)).toEqual(["done", "active"]);
    expect(subs[1].classList.contains("cm-lp-list-sub-last")).toBe(true);

    view.dom.querySelector<HTMLButtonElement>(".cm-lp-list-twisty:not(:disabled)")!.click();
    await flush();
    expect(view.dom.querySelectorAll(".cm-lp-list-sub")).toHaveLength(0);
    view.destroy();
  });

  test("a row with no sub-projects keeps the twisty's space but not its button", async () => {
    const view = mount(doc("from: 1-projects", "rows: projects"));
    await flush();
    const disabled = [...view.dom.querySelectorAll<HTMLButtonElement>(".cm-lp-list-twisty:disabled")];
    expect(disabled).toHaveLength(2);
    expect(disabled.every((button) => button.tabIndex === -1)).toBe(true);
    view.destroy();
  });

  test("a folder with nothing marked says how a project starts", async () => {
    const view = mount(doc("from: elsewhere", "rows: projects"));
    await flush();
    expect(view.dom.querySelector(".cm-lp-list-foot")?.textContent).toBe(
      "No projects here yet. A folder or note becomes one when it has a status.",
    );
    view.destroy();
  });

  test("the panel switches to projects and groups, and the block says so", async () => {
    const view = mount(doc("from: 1-projects", "subfolders: yes"));
    await flush();
    view.dom.querySelector<HTMLElement>(".cm-lp-list-cap")!.click();
    expect(field<HTMLSelectElement>(view, "rows").value).toBe("notes");
    change(field<HTMLSelectElement>(view, "rows"), "projects");
    // A project folder is always looked inside, so the switch goes away with it.
    expect(body(view)).toBe("from: 1-projects\nrows: projects");
    expect(view.dom.querySelector('[data-field="subfolders"]')).toBeNull();
    change(field<HTMLSelectElement>(view, "group"), "status");
    expect(body(view)).toBe("from: 1-projects\nrows: projects\ngroup: status");
    change(field<HTMLSelectElement>(view, "group"), "");
    expect(body(view)).toBe("from: 1-projects\nrows: projects");
    view.destroy();
  });

  test("clearing the group of a board makes it a list rather than a broken block", async () => {
    const view = mount(doc("from: 1-projects", "rows: projects", "group: status", "as: board"));
    await flush();
    view.dom.querySelector<HTMLElement>(".cm-lp-list-cap")!.click();
    change(field<HTMLSelectElement>(view, "group"), "");
    expect(body(view)).toBe("from: 1-projects\nrows: projects");
    view.destroy();
  });
});

describe("the words a grouped list uses", () => {
  const base = {
    from: "1-projects",
    where: [],
    sort: { key: "updated", order: "desc" as const },
    show: [],
    limit: 50,
    subfolders: false,
    rows: "projects" as const,
    group: "status",
    as: "list" as const,
  };
  const label = (leaf: string) => leaf;

  test("a caption names its grouping, and a board says it is one", () => {
    expect(captionFor(base, label)).toBe("1-projects · by status");
    expect(captionFor({ ...base, as: "board" }, label)).toBe("1-projects · board by status");
    expect(captionFor({ ...base, where: [{ property: "owner", op: "is set" }] }, label)).toBe(
      "1-projects · by status · owner is set",
    );
  });

  test("a group heading raises the first letter, and the unset group is the nudge", () => {
    expect(groupLabel("status", "active")).toBe("Active");
    expect(groupLabel("status", "")).toBe("No status");
  });

  test("a group value is contained, since it is somebody's frontmatter", () => {
    expect(groupLabel("status", "\u202Eevil")).not.toBe("\u202Eevil");
  });
});
