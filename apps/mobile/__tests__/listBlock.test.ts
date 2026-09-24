/**
 * @jest-environment jsdom
 */
/**
 * Folder lists in the editor: which fences are drawn, what a drawn list
 * shows, and the words it uses. The grammar and the row choice are
 * `apps/mcp/src/lists.js` and are proved in `apps/mcp/test/lists.test.mjs`;
 * this is the half a person sees.
 */

import { describe, expect, test } from "@jest/globals";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  listFences,
  listHost,
  type ListHostContext,
  type ListNote,
} from "../features/console/files/listBlock/model";
import { ListWidget } from "../features/console/files/listBlock/widget";
import { captionFor, rowTitle, shortWhen } from "../features/console/files/listBlock/words";
import { insertFolderList } from "../features/console/files/listBlock/insert";
import { decorationsFor, livePreviewStyles, markdownLanguage } from "../features/console/files/livePreview";
import { layout } from "../features/design/tokens";
import { editorMenuItems } from "../features/console/files/editorMenu";

const NOTE = [
  "# Supa Media",
  "",
  "```list",
  "from: 1-projects",
  "where: status is active",
  "show: owner",
  "```",
  "",
  "The end.",
].join("\n");

const NOTES: ListNote[] = [
  { path: "1-projects/website.md", updatedAt: 3, properties: { status: "active", owner: "Seyi", title: "Website folder" } },
  { path: "1-projects/mobile.md", updatedAt: 5, properties: { status: "active", owner: "Ada" } },
  { path: "1-projects/old.md", updatedAt: 9, properties: { status: "done", owner: "Seyi" } },
];

function hostWith(overrides: Partial<ListHostContext> = {}): ListHostContext {
  return {
    load: async () => ({ notes: NOTES, complete: true }),
    open: () => undefined,
    selfPath: "index.md",
    ...overrides,
  };
}

function stateFor(doc: string, options: { cursor?: number; host?: ListHostContext | null } = {}): EditorState {
  const { cursor = 0, host = hostWith() } = options;
  return EditorState.create({
    doc,
    selection: { anchor: cursor },
    extensions: [markdownLanguage(), ...(host === undefined ? [] : [listHost.of({ current: host })])],
  });
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("when a folder list is drawn", () => {
  test("a list away from the caret is drawn, spanning the whole fence", () => {
    const state = stateFor(NOTE);
    const [fence] = listFences(state);
    expect(fence.config?.from).toBe("1-projects");
    expect(state.doc.sliceString(fence.from, fence.from + 7)).toBe("```list");
    expect(state.doc.sliceString(fence.to - 3, fence.to)).toBe("```");
  });

  test("the caret inside it gives the source back", () => {
    expect(listFences(stateFor(NOTE, { cursor: NOTE.indexOf("from:") }))).toEqual([]);
  });

  test("a surface with no host leaves it as source", () => {
    expect(listFences(stateFor(NOTE, { host: null }))).toEqual([]);
  });

  test("an unclosed list is somebody typing it, and stays text", () => {
    expect(listFences(stateFor("```list\nfrom: 1-projects\n"))).toEqual([]);
  });

  test("a list quoted inside a wider fence is not a list", () => {
    expect(listFences(stateFor("````md\n```list\nfrom: x\n```\n````\n", { cursor: 0 }))).toEqual([]);
  });

  test("the decoration set carries one list widget", () => {
    let found = 0;
    decorationsFor(stateFor(NOTE)).between(0, NOTE.length, (_f, _t, value) => {
      if ((value.spec as { widget?: unknown }).widget instanceof ListWidget) found += 1;
    });
    expect(found).toBe(1);
  });
});

describe("what a drawn list shows", () => {
  function draw(host: ListHostContext, doc = NOTE): { dom: HTMLElement; view: EditorView } {
    const view = new EditorView({ state: stateFor(doc, { host }) });
    const [fence] = listFences(view.state);
    const dom = new ListWidget(fence, { current: host }).toDOM(view);
    return { dom, view };
  }

  test("the matching notes, as rows with their columns", async () => {
    const { dom } = draw(hostWith());
    await flush();
    const rows = [...dom.querySelectorAll(".cm-lp-list-row")].map((row) => row.textContent);
    expect(rows).toEqual(["mobileAda", "Website folderSeyi"]);
    expect(dom.querySelector(".cm-lp-list-cap")?.textContent).toBe("projects · status is active");
  });

  test("a row opens its note, and a ⌘-click opens it behind", async () => {
    const opened: Array<[string, boolean]> = [];
    const { dom } = draw(hostWith({ open: (path, background) => opened.push([path, background]) }));
    await flush();
    const row = dom.querySelector<HTMLElement>(".cm-lp-list-row")!;
    row.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    row.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
    expect(opened).toEqual([["1-projects/mobile.md", false], ["1-projects/mobile.md", true]]);
  });

  test("it redraws when the host says the notes changed, and stops when destroyed", async () => {
    let notify: () => void = () => undefined;
    let loads = 0;
    const host = hostWith({
      load: async () => {
        loads += 1;
        return { notes: loads === 1 ? NOTES : NOTES.slice(0, 1), complete: true };
      },
      subscribe: (listener) => {
        notify = listener;
        return () => {
          notify = () => undefined;
        };
      },
    });
    const view = new EditorView({ state: stateFor(NOTE, { host }) });
    const [fence] = listFences(view.state);
    const widget = new ListWidget(fence, { current: host });
    const dom = widget.toDOM(view);
    await flush();
    expect(dom.querySelectorAll(".cm-lp-list-row")).toHaveLength(2);
    notify();
    await flush();
    expect(dom.querySelectorAll(".cm-lp-list-row")).toHaveLength(1);
    widget.destroy();
    notify();
    expect(loads).toBe(2);
  });

  test("nothing on the device says so rather than showing an empty list", async () => {
    const { dom } = draw(hostWith({ load: async () => null }));
    await flush();
    expect(dom.querySelector(".cm-lp-list-foot")?.textContent).toMatch(/on this device/);
  });

  test("no matches says so", async () => {
    const { dom } = draw(hostWith({ load: async () => ({ notes: [], complete: true }) }));
    await flush();
    expect(dom.querySelector(".cm-lp-list-foot")?.textContent).toBe("No notes match yet.");
  });

  test("a partial copy says some may be missing", async () => {
    const { dom } = draw(hostWith({ load: async () => ({ notes: NOTES, complete: false }) }));
    await flush();
    expect(dom.querySelector(".cm-lp-list-foot")?.textContent).toMatch(/still downloading/);
  });

  test("a broken block draws its reason, never a guess", () => {
    const broken = "Intro\n\n```list\nwhere: status is active\n```\n\nText";
    const { dom } = draw(hostWith(), broken);
    expect(dom.classList.contains("cm-lp-list-broken")).toBe(true);
    expect(dom.textContent).toMatch(/"from" is required/);
  });

  test("the widget is compared on its text, so typing elsewhere keeps it", () => {
    const state = stateFor(NOTE);
    const [a] = listFences(state);
    const [b] = listFences(stateFor(NOTE + " more"));
    const ref = { current: hostWith() };
    expect(new ListWidget(a, ref).eq(new ListWidget(b, ref))).toBe(true);
  });
});

describe("the phone layout", () => {
  test("switches at the console's own narrow breakpoint", () => {
    expect(livePreviewStyles).toContain(`@media (max-width: ${layout.narrowBreakpoint - 0.02}px) {\n  .cm-lp-list-row`);
  });
});

describe("the words", () => {
  test("a caption names the folder and the conditions, or the order", () => {
    const label = (folder: string) => folder.replace(/^\d+-/, "");
    const base = { where: [], sort: { key: "updated", order: "desc" as const }, show: [], limit: 50, subfolders: false };
    expect(captionFor({ ...base, from: "website/writing" }, label)).toBe("writing · newest first");
    expect(
      captionFor({ ...base, from: "1-projects", where: [{ property: "owner", op: "is set" }] }, label),
    ).toBe("projects · owner is set");
  });

  test("a title from a file name is drawn the way the tree draws it", () => {
    expect(rowTitle({ path: "blog/2-hello-world.md", title: "2-hello-world", values: [] })).toBe("hello-world");
    expect(rowTitle({ path: "blog/x.md", title: "Hello, world", values: [] })).toBe("Hello, world");
  });

  test("a time is short", () => {
    const now = new Date(2026, 8, 24, 15, 0).getTime();
    expect(shortWhen(now - 30_000, now)).toBe("just now");
    expect(shortWhen(now - 12 * 60_000, now)).toBe("12m ago");
    expect(shortWhen(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(shortWhen(new Date(2026, 8, 23, 9).getTime(), now)).toBe("yesterday");
    expect(shortWhen(new Date(2026, 8, 20).getTime(), now)).toBe("Sep 20");
    expect(shortWhen(new Date(2025, 8, 20).getTime(), now)).toBe("Sep 20, 2025");
  });
});

describe("inserting one", () => {
  function viewFor(doc: string, cursor: number, selfPath: string | null): EditorView {
    return new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: cursor },
        extensions: [markdownLanguage(), listHost.of({ current: hostWith({ selfPath }) })],
      }),
    });
  }

  test("lists the note's own folder, and leaves the caret below so it draws", () => {
    const view = viewFor("Intro\n", 6, "website/writing/index.md");
    insertFolderList(view);
    expect(view.state.doc.toString()).toBe("Intro\n```list\nfrom: website/writing\n```\n");
    expect(listFences(view.state)).toHaveLength(1);
  });

  test("at the top of the workspace, stops on from: for a folder to be named", () => {
    const view = viewFor("Intro", 5, "index.md");
    insertFolderList(view);
    expect(view.state.doc.toString()).toBe("Intro\n\n```list\nfrom: \n```\n");
    const head = view.state.selection.main.head;
    expect(view.state.doc.sliceString(head - 6, head)).toBe("from: ");
  });

  test("the menu offers it only where a list can be drawn", () => {
    const ids = (canList: boolean) =>
      editorMenuItems({ canEdit: true, hasSelection: false, apple: true, canList }).map((item) => item.id);
    expect(ids(true)).toContain("folderList");
    expect(ids(false)).not.toContain("folderList");
  });
});
