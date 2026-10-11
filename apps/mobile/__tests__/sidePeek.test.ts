/**
 * @jest-environment jsdom
 */

/**
 * A TASK, A NOTE OR A PROJECT OPENS BESIDE THE BOARD.
 *
 * Decided by the owner on 2026-09-28, after the task panel: "when in list
 * view or board view, clicking on a project or note should open in a side
 * panel, with an option to expand fully / open in a new page" — and, to be
 * clear, like Notion's side peek. Since 2026-10-10 the List's rows are the
 * Notes rows and open the page (`folderPageList.test.ts`), so on any desktop
 * page the Board is the way in:
 *
 *  - a Board card opens in the panel — a task, and a project on the projects
 *    folder's page — and a subtask or a note in a task opens from the panel;
 *  - the panel shows the note's words under its properties (a task) or on
 *    their own under its title (a note); a folder's are its front note's;
 *  - Expand takes it to its full page here, Open in new tab opens it in a
 *    tab of its own and leaves the board where it is;
 *  - opening it folds the file tree away, and closing it brings the tree back
 *    only if it was showing before;
 *  - where the board and the panel do not both fit, the panel lies over the
 *    board rather than not opening.
 *
 * A plain note with no status has no card, so it has no way into the panel
 * from its own folder's page; the one reached here is a note in a task.
 *
 * The words are editable for a writer (the owner, 2026-09-28, reversing the
 * read-only peek of the same day: "the side panel shouldnt be read only, it
 * should be editable") — by the console's one editor, lent to the peek
 * (`panel/peekEditing.ts`), never a second one: opening the panel puts the
 * note in it, closing gives it back, and a keystroke goes to its draft. A
 * member, and a page with no editor to lend, still reads them read-only.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

/** The last editor drawn, so a test can type into it. */
const drawn: { onChange?: (text: string) => void } = {};

jest.mock("../features/console/files/LiveEditor", () => ({
  LiveEditor: (props: { value: string; editable: boolean; onChange: (text: string) => void }) => {
    drawn.onChange = props.onChange;
    return require("react").createElement("div", { "data-testid": "task-panel-body-editor", "data-editable": String(props.editable) }, props.value);
  },
}));

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from "react";
import { forgetViews } from "../features/console/files/folderPage/viewMemory";
import type { PeekEditing } from "../features/console/files/folderPage/panel/peekEditing";
import {
  BODIES,
  CAFE,
  LISTING,
  all,
  entry,
  host,
  key,
  mount,
  navRecording,
  one,
  press,
  strip,
  unmountAll,
  windowOf,
  type Tree,
} from "./projectPage/fixtures";

beforeEach(() => {
  windowOf(1280);
  forgetViews();
  try {
    localStorage.clear();
  } catch {
    // no storage in this environment
  }
});
afterEach(unmountAll);

const card = (name: string) => all("folder-card").find((node) => strip(node.textContent).includes(name))!;
// The folder page draws its own about note with the same editor; these are the panel's.
const panel = () => one("task-panel");
const body = () => one("task-panel-body-editor", panel());

/** Shows the Board and opens the card named. */
async function open(name: string) {
  if (all("folder-card").length === 0) await press(one("folder-view-board"));
  await press(card(name));
}

/** Opens the kitchen task, then its one note, "Kitchen layout sketch", in its place. */
async function openSketch() {
  await open("Get the kitchen ready");
  await press(one("task-panel-note"));
}

describe("a note opens beside the board", () => {
  test("a plain note: its name and its words, read-only, with no task values", async () => {
    const { selected } = await mount(host([]));
    await openSketch();
    expect(selected).toEqual([]);
    expect(strip(one("task-panel-title").textContent)).toBe("Kitchen layout sketch");
    // The words without the title line the panel already draws above them.
    expect(strip(body().textContent)).toBe("Oven on the back wall.\n");
    expect(body().getAttribute("data-editable")).toBe("false");
    expect(all("task-panel-status")).toHaveLength(0);
    expect(all("task-panel-subtasks-head")).toHaveLength(0);
  });

  test("a task: its words under its values, subtasks and notes, without the frontmatter", async () => {
    await mount(host([]));
    await open("Get the kitchen ready");
    expect(strip(body().textContent)).toBe("Everything the cooks need on day one.\n");
    expect(strip(body().textContent)).not.toContain("priority:");
    const order = [one("task-panel-status"), one("task-panel-subtasks-head"), one("task-panel-notes-head"), body()];
    for (let i = 1; i < order.length; i += 1) {
      expect(order[i - 1].compareDocumentPosition(order[i]) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
  });

  test("a task's card is marked while it is open", async () => {
    await mount(host([]));
    await open("Get the kitchen ready");
    expect(card("Get the kitchen ready").getAttribute("aria-current")).toBe("true");
    expect(card("Sign the lease").getAttribute("aria-current")).toBeNull();
  });

  test("a note this device has not got yet says so, and a locked one says it is locked", async () => {
    await mount(host([], { bodies: { ...BODIES, [`${CAFE}/kitchen/layout.md`]: "---\ncontext_encryption: v1\n---\nciphertext\n" } }));
    await openSketch();
    expect(all("task-panel-body-editor", panel())).toHaveLength(0);
    expect(strip(one("task-panel-body-note", panel()).textContent)).toMatch(/locked/i);
    expect(strip(one("task-panel").textContent)).not.toContain("ciphertext");
    await press(card("Take photos for the menu"));
    expect(strip(one("task-panel-body-note", panel()).textContent)).toMatch(/not on this device/i);
  });

  test("a member reads the words, and nothing in the panel writes", async () => {
    await mount(host(null));
    await open("Sign the lease");
    expect(body().getAttribute("data-editable")).toBe("false");
    expect(strip(body().textContent)).toBe("Two years, with a break at one.\n");
    for (const control of ["task-panel-add-subtask", "task-panel-add-note", "task-panel-status-button"]) {
      expect(all(control)).toHaveLength(0);
    }
  });
});

describe("Expand and Open in new tab", () => {
  test("Expand opens the full page here; Open in new tab opens a tab and leaves the board", async () => {
    const opened: [string, string][] = [];
    const { selected } = await mount(host([]), LISTING, navRecording(opened));
    await open("Get the kitchen ready");
    expect(one("task-panel-new-tab").getAttribute("aria-label")).toBe("Open in new tab");
    await press(one("task-panel-new-tab"));
    // A folder task's page is its front note, which is what a tab can hold.
    expect(opened).toEqual([[`${CAFE}/kitchen/overview.md`, "background"]]);
    expect(selected).toEqual([]);
    expect(all("task-panel")).toHaveLength(1);
    await press(one("task-panel-note"));
    await press(one("task-panel-new-tab"));
    expect(opened[1]).toEqual([`${CAFE}/kitchen/layout.md`, "background"]);
    expect(one("task-panel-expand").getAttribute("aria-label")).toBe("Expand");
    await press(one("task-panel-expand"));
    expect(selected).toEqual([`${CAFE}/kitchen/layout.md`]);
  });

  test("where there are no tabs, there is no Open in new tab", async () => {
    await mount(host([]));
    await open("Sign the lease");
    expect(all("task-panel-new-tab")).toHaveLength(0);
    expect(all("task-panel-expand")).toHaveLength(1);
  });
});

describe("a project on the projects folder's page", () => {
  const PROJECTS = { ...LISTING, path: "1-projects", entries: [entry("folder", CAFE)] };

  test("opens beside the board with its values, its tasks and its front note's words", async () => {
    const { selected } = await mount(host([]), PROJECTS);
    await open("Café opening");
    expect(selected).toEqual([]);
    expect(strip(one("task-panel-title").textContent)).toBe("Café opening");
    expect(strip(one("task-panel-status").textContent)).toContain("in progress");
    expect(strip(body().textContent)).toBe("Open a café on the corner by spring.\n");
    expect(all("task-panel-subtask").length).toBeGreaterThan(0);
  });
});

describe("the file tree while the panel is open", () => {
  test("folds away when it opens, and comes back when it closes", async () => {
    const tree: Tree = { hidden: false };
    await mount(host([]), LISTING, undefined, tree);
    await open("Get the kitchen ready");
    expect(tree.hidden).toBe(true);
    // Moving from one card to another keeps it folded.
    await press(card("Sign the lease"));
    expect(tree.hidden).toBe(true);
    await press(one("task-panel-close"));
    expect(tree.hidden).toBe(false);
    await press(card("Sign the lease"));
    expect(tree.hidden).toBe(true);
    await key(document, "Escape");
    expect(all("task-panel")).toHaveLength(0);
    expect(tree.hidden).toBe(false);
  });

  test("stays folded after closing when it was folded before", async () => {
    const tree: Tree = { hidden: true };
    await mount(host([]), LISTING, undefined, tree);
    await open("Sign the lease");
    expect(tree.hidden).toBe(true);
    await press(one("task-panel-close"));
    expect(tree.hidden).toBe(true);
  });

  test("comes back when the page shows its Notes, where there is no panel", async () => {
    const tree: Tree = { hidden: false };
    await mount(host([]), LISTING, undefined, tree);
    await open("Sign the lease");
    expect(tree.hidden).toBe(true);
    await press(one("folder-view-files"));
    expect(all("task-panel")).toHaveLength(0);
    expect(tree.hidden).toBe(false);
  });

  test("comes back when the panel goes because the page was left", async () => {
    const tree: Tree = { hidden: false };
    await mount(host([]), LISTING, undefined, tree);
    await open("Sign the lease");
    expect(tree.hidden).toBe(true);
    unmountAll();
    expect(tree.hidden).toBe(false);
  });
});

describe("where it opens", () => {
  test("on a desktop page too narrow for both, it lies over the board instead of not opening", async () => {
    windowOf(1000);
    const { selected } = await mount(host([]));
    await open("Get the kitchen ready");
    expect(selected).toEqual([]);
    expect(one("task-panel-peek").getAttribute("data-mode")).toBe("over");
    windowOf(1600);
    await act(async () => {});
    expect(one("task-panel-peek").getAttribute("data-mode")).toBe("beside");
  });
});

/**
 * The console's editor as the peek borrows it: every open, close and
 * keystroke recorded. `holds` is the note it already has — the note is open
 * in the console, or the lend has landed.
 */
function lender(holds: string | null, draft = "", canEdit = true) {
  const calls: string[] = [];
  const editing: PeekEditing = {
    open: (path) => (calls.push(`open ${path}`), true),
    close: (path) => (calls.push(`close ${path}`), true),
    editor: { path: holds, draft, status: "clean", readOnly: false, encrypted: false },
    canEdit,
    onChange: (text) => void calls.push(`type ${text}`),
    onSave: () => void calls.push("save"),
  };
  return { editing, calls };
}

describe("a writer edits in the peek, through the console's one editor", () => {
  const LEASE = `${CAFE}/lease.md`;

  test("opening lends the note to the editor, its draft is drawn editable, and a keystroke goes to it", async () => {
    const { editing, calls } = lender(LEASE, "---\nstatus: to do\n---\n# Sign the lease\n\nTwo years, unsaved.\n");
    await mount({ ...host([], { files: [] }), editing });
    await open("Sign the lease");
    expect(calls).toEqual([`open ${LEASE}`]);
    expect(body().getAttribute("data-editable")).toBe("true");
    // The editor's draft — what is unsaved included — not the copy on the device.
    expect(strip(body().textContent)).toContain("Two years, unsaved.");
    await act(async () => drawn.onChange?.("typed"));
    expect(calls).toContain("type typed");
  });

  test("closing the panel, or moving to another card, gives the note back", async () => {
    const { editing, calls } = lender(LEASE);
    await mount({ ...host([], { files: [] }), editing });
    await open("Sign the lease");
    await open("Take photos for the menu");
    expect(calls).toEqual([`open ${LEASE}`, `close ${LEASE}`, `open ${CAFE}/photos.md`]);
    await press(one("task-panel-close"));
    expect(calls.at(-1)).toBe(`close ${CAFE}/photos.md`);
  });

  test("until the editor holds the note, its words are read from the device, read-only", async () => {
    const { editing } = lender(null);
    await mount({ ...host([], { files: [] }), editing });
    await open("Sign the lease");
    expect(body().getAttribute("data-editable")).toBe("false");
    expect(strip(body().textContent)).toBe("Two years, with a break at one.\n");
  });

  test("a member is never lent the editor, and reads", async () => {
    const { editing, calls } = lender(LEASE, "draft", false);
    await mount({ ...host(null), editing });
    await open("Sign the lease");
    expect(calls).toEqual([]);
    expect(body().getAttribute("data-editable")).toBe("false");
    expect(strip(body().textContent)).toBe("Two years, with a break at one.\n");
    // The editor's own word decides too, not only the page's: a console that may not write lends nothing.
    unmountAll();
    await mount({ ...host([], { files: [] }), editing });
    await open("Sign the lease");
    expect(calls).toEqual([]);
    expect(body().getAttribute("data-editable")).toBe("false");
  });

  test("a locked note is not typed into even when the editor holds it", async () => {
    const { editing } = lender(LEASE, "ciphertext");
    await mount({ ...host([], { files: [] }), editing: { ...editing, editor: { ...editing.editor, encrypted: true } } });
    await open("Sign the lease");
    expect(all("task-panel-body-editor", panel()).every((node) => node.getAttribute("data-editable") === "false")).toBe(true);
  });
});
