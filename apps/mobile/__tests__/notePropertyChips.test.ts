/**
 * @jest-environment jsdom
 */

import { afterEach, describe, expect, jest, test } from "@jest/globals";

jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 47, bottom: 34, left: 0, right: 0 }),
}));
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";

/**
 * The property chips under a note's name (`noteEditor/chips/`).
 *
 * "it will probably be good to have a dropdown for the frontmatter as well for
 * new notes even if it doesnt exist yet" and, shown the boards, "I like the
 * chips" (owner, 2026-10-14). These mount the real `NoteEditor` with the
 * editor stubbed — the stub keeps the `propertyHost` it is handed, which is
 * the element the web editor puts under the title and the chips are portalled
 * into — and read what reaches `onChange`, because what matters is the file:
 * one front matter line, every other byte where it was.
 *
 * ## Sabotage record
 *
 * Run as temporary local edits, and reverted.
 *
 * 1. **`chipsOn` without `chipsFit`** — "a website page gets no chips"
 *    fails.
 * 2. **`showUnset` ignoring `revealed`/`fresh`** (always true) — "a written-in
 *    note keeps its faint chips out of sight" fails.
 * 3. **`useStatusList` ignoring the folder's own list** (defaults always) —
 *    "the folder's own words" fails.
 */

let lastEditorProps: Record<string, unknown> = {};
jest.mock("../features/console/files/LiveEditor", () => ({
  LiveEditor: (props: Record<string, unknown>) => {
    lastEditorProps = props;
    return null;
  },
}));

const { NoteEditor } =
  require("../features/console/files/NoteEditor") as typeof import("../features/console/files/NoteEditor");
const { emptyEditor } =
  require("../features/console/files/editor") as typeof import("../features/console/files/editor");

type EditorState = import("../features/console/files/editor").EditorState;
type FolderListSource = import("../features/console/files/listBlock/model").FolderListSource;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
  lastEditorProps = {};
});

function mount({
  width = 1440,
  canEdit = true,
  draft = "",
  path = "1-projects/cafe/untitled-2026-10-14.md",
  folderLists,
}: { width?: number; canEdit?: boolean; draft?: string; path?: string; folderLists?: FolderListSource } = {}) {
  const changes: string[] = [];
  Object.defineProperty(document.documentElement, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(document.documentElement, "clientHeight", { value: 956, configurable: true });
  window.dispatchEvent(new Event("resize"));

  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  let state: EditorState = { ...emptyEditor, status: "clean", path, baseline: draft, draft };
  const render = () =>
    root.render(
      createElement(NoteEditor, {
        state,
        canEdit,
        ...(folderLists === undefined ? {} : { folderLists }),
        onChange: (text: string) => {
          changes.push(text);
          state = { ...state, status: "dirty", draft: text };
          render();
        },
        onSave: jest.fn() as () => void,
        onDiscard: jest.fn() as () => void,
        onUseTheirs: jest.fn() as () => void,
        onKeepMine: jest.fn() as () => void,
      }),
    );
  act(render);

  const host = () => (lastEditorProps.propertyHost as HTMLElement | null | undefined) ?? null;
  const chip = (testId: string) => host()?.querySelector<HTMLElement>(`[data-testid="${testId}"]`) ?? null;
  const anywhere = (testId: string) => document.querySelector<HTMLElement>(`[data-testid="${testId}"]`) ?? host()?.querySelector<HTMLElement>(`[data-testid="${testId}"]`) ?? null;
  // A chip measures itself before its menu opens, which takes a frame.
  const press = async (node: HTMLElement | null) => {
    if (node === null) throw new Error("nothing to press");
    act(() => {
      node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
      node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 30)));
  };
  return { changes, host, chip, anywhere, press, container, latest: () => changes.at(-1) };
}

const flush = () => act(async () => {
  await Promise.resolve();
  await Promise.resolve();
});

const hidden = (node: HTMLElement | null) => node !== null && getComputedStyle(node).opacity === "0";

describe("a new note", () => {
  test("offers its common properties as chips, with nothing written", async () => {
    const app = mount();
    expect(app.host()).not.toBeNull();
    for (const key of ["status", "owner", "priority", "due"]) {
      expect(app.chip(`note-chip-add-${key}`)).not.toBeNull();
      expect(hidden(app.chip(`note-chip-add-${key}`))).toBe(false);
    }
    expect(app.chip("note-chip-more")).not.toBeNull();
    expect(app.changes).toEqual([]);
  });

  test("picking a status gives a note with no front matter its first line", async () => {
    const app = mount();
    await app.press(app.chip("note-chip-add-status"));
    // The default list, in its groups.
    expect(app.anywhere("menu-item-set:status:to do")).not.toBeNull();
    expect(app.anywhere("menu-item-set:status:finished")).not.toBeNull();
    await app.press(app.anywhere("menu-item-set:status:in progress"));
    expect(app.latest()).toBe("---\nstatus: in progress\n---\n");
    expect(app.chip("note-chip-status")!.textContent).toContain("in progress");
    expect(app.chip("note-chip-add-status")).toBeNull();
  });

  test("keeps the body exactly as it was", async () => {
    const draft = "# Order the espresso machine\n";
    const app = mount({ draft });
    await app.press(app.chip("note-chip-add-priority"));
    await app.press(app.anywhere("menu-item-set:priority:p1"));
    expect(app.latest()).toBe(`---\npriority: p1\n---\n\n${draft}`);
    expect(app.chip("note-chip-priority")!.textContent).toContain("High");
  });

  test("Other property… opens the Properties card on its Add row", async () => {
    const app = mount();
    await app.press(app.chip("note-chip-more"));
    await app.press(app.anywhere("menu-item-other"));
    expect(app.container.querySelector('[data-testid="note-properties-adding"]')).not.toBeNull();
  });
});

describe("a note with properties", () => {
  const TASK = "---\nupdated: 2026-10-01\nstatus: to do\npriority: p0\n---\n\n# Order the machine\n\nTwo quotes.\n";

  test("shows each as a solid chip, in words", async () => {
    const app = mount({ draft: TASK });
    expect(app.chip("note-chip-status")!.textContent).toContain("to do");
    expect(app.chip("note-chip-priority")!.textContent).toContain("Urgent");
  });

  test("a written-in note keeps its faint chips out of sight until pointed at", async () => {
    const app = mount({ draft: TASK });
    expect(hidden(app.chip("note-chip-add-owner"))).toBe(true);
    act(() => {
      app.host()!.dispatchEvent(new Event("pointerover", { bubbles: true }));
    });
    // Detached in this test, the host has no box; pointing at the box itself is what counts.
    const box = document.createElement("div");
    document.body.appendChild(box);
    act(() => {
      box.appendChild(app.host()!);
      app.host()!.dispatchEvent(new Event("pointerover", { bubbles: true }));
    });
    expect(hidden(app.chip("note-chip-add-owner"))).toBe(false);
  });

  test("changing one changes its line and nothing else", async () => {
    const app = mount({ draft: TASK });
    await app.press(app.chip("note-chip-status"));
    await app.press(app.anywhere("menu-item-set:status:finished"));
    expect(app.latest()).toBe(TASK.replace("status: to do", "status: finished"));
  });

  test("taking one off removes its line", async () => {
    const app = mount({ draft: TASK });
    await app.press(app.chip("note-chip-priority"));
    await app.press(app.anywhere("menu-item-clear:priority"));
    expect(app.latest()).toBe(TASK.replace("priority: p0\n", ""));
    expect(app.chip("note-chip-priority")).toBeNull();
  });

  test("somebody who can only read sees the values and nothing to press", async () => {
    const app = mount({ draft: TASK, canEdit: false });
    expect(app.chip("note-chip-status")!.textContent).toContain("to do");
    expect(app.chip("note-chip-status")!.getAttribute("role")).not.toBe("button");
    expect(app.chip("note-chip-add-owner")).toBeNull();
    expect(app.chip("note-chip-more")).toBeNull();
  });
});

test("the folder's own words, in their groups", async () => {
  const folderLists: FolderListSource = {
    load: async () => null,
    loadFront: async (folders) => {
      expect(folders).toEqual(["1-projects/cafe", "1-projects"]);
      return [
        {
          path: "1-projects/cafe/about.md",
          properties: { "statuses-not-started": ["idea"], "statuses-in-progress": ["waiting on supplier"], "statuses-done": ["open"] },
        },
      ];
    },
  };
  const app = mount({ folderLists });
  await flush();
  await app.press(app.chip("note-chip-add-status"));
  expect(app.anywhere("menu-item-set:status:waiting on supplier")).not.toBeNull();
  expect(app.anywhere("menu-item-set:status:to do")).toBeNull();
});

test("a website page gets no chips", async () => {
  mount({ path: "website/about.md", draft: "# About\n" });
  expect(lastEditorProps.propertyHost ?? null).toBeNull();
});

test("on a phone a written-in note folds the faint chips into one", async () => {
  const app = mount({ width: 390, draft: "# Notes\n\nSome words.\n" });
  expect(app.chip("note-chip-add-status")).toBeNull();
  const more = app.chip("note-chip-more")!;
  expect(more.textContent).toContain("Add property");
  expect(hidden(more)).toBe(false);
  await app.press(more);
  expect(app.anywhere("menu-item-open:status")).not.toBeNull();
  expect(app.anywhere("menu-item-open:owner")).not.toBeNull();
});
