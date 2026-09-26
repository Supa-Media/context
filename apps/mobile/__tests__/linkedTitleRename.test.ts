/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing, OpenNote } from "../features/console/files/types";
import { isLinkedTitle, proposeTitle, retitled } from "../features/console/files/linkedTitle";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * **THE TITLE IS THE NAME — WHILE THE TWO ARE THE SAME.**
 *
 * The owner asked to rename a note from the page itself (2026-09-26), and the
 * approved design is `linkedTitle.ts`'s one rule. This holds the three things
 * about it a person would notice going wrong:
 *
 *  - **the file moves when you leave the title, not while you are in it** —
 *    every keystroke of a new title is not a rename, and a rename rewrites
 *    links across the context;
 *  - **a note whose title already differs from its name never moves** — a
 *    daily note called `2026-09-12` titled "Friday" is somebody's filing;
 *  - **a title that cannot be a name says so and moves nothing.**
 *
 * `untitledTitleAdoption.test.ts` is the untitled case of the same hook, and
 * the harness is its.
 */

const actions: Record<string, (args: never) => Promise<unknown>> = {};
const bound: Record<string, (args: never) => Promise<unknown>> = {};
const calls: { name: string; args: unknown }[] = [];

jest.mock("convex/react", () => {
  const { getFunctionName } = require("convex/server") as typeof import("convex/server");
  const record = (ref: never) => {
    const name = getFunctionName(ref);
    bound[name] ??= (args: never) => {
      calls.push({ name, args });
      return actions[name]!(args);
    };
    return bound[name];
  };
  return { useAction: record, useMutation: record, useQuery: () => undefined };
});

import { useFileBrowser } from "../features/console/files/useFileBrowser";

const FOLDER = "1-projects";
const ROADMAP = `${FOLDER}/Roadmap.md`;
const DAILY = `${FOLDER}/2026-09-12.md`;

function fn(name: string): string {
  return `functions/files:${name}`;
}

let files: Map<string, string>;

function listing(path: string): FolderListing {
  const prefix = path === "" ? "" : `${path}/`;
  const entries = [...files.keys()]
    .filter((key) => key.startsWith(prefix) && !key.slice(prefix.length).includes("/"))
    .map((key) => ({
      kind: "file" as const,
      path: key,
      name: key.slice(prefix.length),
      visibility: "private" as const,
      inherited: "private" as const,
      exception: false,
      readOnly: false,
    }));
  const folders =
    path === ""
      ? [
          {
            kind: "folder" as unknown as "file",
            path: FOLDER,
            name: FOLDER,
            visibility: "private" as const,
            inherited: "private" as const,
            exception: false,
            readOnly: false,
          },
        ]
      : [];
  return { path, folderDefault: "private", truncated: false, manifestUsable: true, entries: [...entries, ...folders] };
}

function read(path: string): OpenNote {
  return {
    path,
    text: files.get(path) ?? "",
    etag: `etag:${path}`,
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
  };
}

let browser: FileBrowser;

function mount(): () => void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  function Probe() {
    browser = useFileBrowser({ workspaceId: "w1", tier: "private", canEdit: true });
    return null;
  }
  act(() => {
    root.render(createElement(Probe));
  });
  return () => {
    act(() => root.unmount());
    container.remove();
  };
}

async function settle() {
  await act(async () => {
    for (let n = 0; n < 12; n += 1) await Promise.resolve();
  });
}

function moves(): { from: string; to: string }[] {
  return calls
    .filter((c) => c.name === fn("moveEntry"))
    .map((c) => {
      const { from, to } = c.args as { from: string; to: string };
      return { from, to };
    });
}

async function open(path: string) {
  await act(async () => {
    browser.toggleFolder(FOLDER);
  });
  await settle();
  await act(async () => {
    browser.select(path);
  });
  await settle();
}

async function type(text: string) {
  await act(async () => {
    browser.setDraft(text);
  });
  await act(async () => {
    browser.save();
  });
  await settle();
}

async function caret(inTitle: boolean) {
  await act(async () => {
    browser.setTitleCaret!(inTitle);
  });
  await settle();
}

describe("a note whose title is its name", () => {
  let unmount: (() => void) | null = null;

  beforeEach(() => {
    calls.length = 0;
    files = new Map([
      [ROADMAP, "# Roadmap\n\nBody.\n"],
      [DAILY, "# Friday\n\nBody.\n"],
      [`${FOLDER}/Taken.md`, "# Taken\n"],
    ]);
    actions[fn("listFiles")] = async (args: never) => listing((args as { path: string }).path);
    actions[fn("readNote")] = async (args: never) => read((args as { path: string }).path);
    actions[fn("writeNote")] = async (args: never) => {
      const { path, text } = args as { path: string; text: string };
      files.set(path, text);
      return { path, etag: `etag:${path}:${text.length}`, conflictCheck: "conditional" };
    };
    actions[fn("moveEntry")] = async (args: never) => {
      const { from, to } = args as { from: string; to: string };
      const text = files.get(from);
      files.delete(from);
      if (text !== undefined) files.set(to, text);
      return { path: to };
    };
  });

  afterEach(() => {
    unmount?.();
    unmount = null;
  });

  test("follows its title when the caret leaves it, and not before", async () => {
    unmount = mount();
    await settle();
    await open(ROADMAP);

    await caret(true);
    await type("# Q4 plan\n\nBody.\n");
    // Saved, settled, and still in the title: the tab and row mirror it, the
    // file has not moved.
    expect(browser.editor.status === "clean" || browser.editor.status === "saved").toBe(true);
    expect(moves()).toEqual([]);
    expect(browser.titleEdit).toEqual({ path: ROADMAP, label: "Q4 plan", note: null });

    await caret(false);
    expect(moves()).toEqual([{ from: ROADMAP, to: `${FOLDER}/Q4 plan.md` }]);
    expect(browser.editor.path).toBe(`${FOLDER}/Q4 plan.md`);
    expect(browser.toasts[0]?.message).toBe("Renamed to Q4 plan.");
  });

  test("a body edit alone never renames it", async () => {
    unmount = mount();
    await settle();
    await open(ROADMAP);
    await type("# Roadmap\n\nBody, and more.\n");
    expect(moves()).toEqual([]);
    expect(browser.titleEdit).toBeNull();
  });

  test("a title that is taken is said under the title, and nothing moves", async () => {
    unmount = mount();
    await settle();
    await open(ROADMAP);
    await caret(true);
    await type("# Taken\n\nBody.\n");
    expect(browser.titleEdit?.label).toBeNull();
    expect(browser.titleEdit?.note?.tone).toBe("problem");
    await caret(false);
    expect(moves()).toEqual([]);
  });

  test("undo puts the file and the title back together", async () => {
    unmount = mount();
    await settle();
    await open(ROADMAP);
    await caret(true);
    await type("# Q4 plan\n\nBody.\n");
    await caret(false);
    expect(browser.editor.path).toBe(`${FOLDER}/Q4 plan.md`);

    await act(async () => {
      browser.toasts[0]!.undo!();
    });
    await settle();
    expect(files.get(ROADMAP)).toBe("# Roadmap\n\nBody.\n");
    expect(browser.editor.path).toBe(ROADMAP);
    expect(browser.editor.draft).toBe("# Roadmap\n\nBody.\n");
  });

  test("renamed from its row while closed, its title follows", async () => {
    unmount = mount();
    await settle();
    await open(`${FOLDER}/Taken.md`);
    await act(async () => {
      browser.rename(ROADMAP, "Plan");
    });
    await settle();
    expect(files.get(`${FOLDER}/Plan.md`)).toBe("# Plan\n\nBody.\n");
  });

  test("Rename on its row goes to the title; on anything else it does not", async () => {
    unmount = mount();
    await settle();
    await open(ROADMAP);
    let handled = false;
    await act(async () => {
      handled = browser.focusTitle!(ROADMAP);
    });
    expect(handled).toBe(true);
    expect(browser.titleFocus?.path).toBe(ROADMAP);
    expect(browser.focusTitle!(`${FOLDER}/Taken.md`)).toBe(false);
  });
});

describe("a note whose title differs from its name", () => {
  let unmount: (() => void) | null = null;

  beforeEach(() => {
    calls.length = 0;
    files = new Map([[DAILY, "# Friday\n\nBody.\n"]]);
    actions[fn("listFiles")] = async (args: never) => listing((args as { path: string }).path);
    actions[fn("readNote")] = async (args: never) => read((args as { path: string }).path);
    actions[fn("writeNote")] = async (args: never) => {
      const { path, text } = args as { path: string; text: string };
      files.set(path, text);
      return { path, etag: `etag:${path}:${text.length}`, conflictCheck: "conditional" };
    };
    actions[fn("moveEntry")] = async () => ({});
  });

  afterEach(() => {
    unmount?.();
    unmount = null;
  });

  test("keeps its name whatever the heading becomes, and Rename uses the dialog", async () => {
    unmount = mount();
    await settle();
    await open(DAILY);
    await caret(true);
    await type("# Saturday\n\nBody.\n");
    await caret(false);
    expect(moves()).toEqual([]);
    expect(browser.titleEdit).toBeNull();
    expect(browser.focusTitle!(DAILY)).toBe(false);
  });
});

describe("the rule itself", () => {
  const listings = { [FOLDER]: undefined };

  test("linked when the title is the name, sort number aside, or the note is untitled", () => {
    expect(isLinkedTitle(ROADMAP, "# Roadmap\n")).toBe(true);
    expect(isLinkedTitle(`${FOLDER}/01-intro.md`, "# intro\n")).toBe(true);
    expect(isLinkedTitle(`${FOLDER}/untitled-2026-09-25.md`, "# anything\n")).toBe(true);
    expect(isLinkedTitle(DAILY, "# Friday\n")).toBe(false);
    expect(isLinkedTitle(ROADMAP, "No heading\n")).toBe(false);
    expect(isLinkedTitle(ROADMAP, "---\nstatus: active\n---\n# Roadmap\n")).toBe(true);
  });

  test("a sort number is kept, and a drawing keeps both extensions", () => {
    expect(
      proposeTitle({ path: `${FOLDER}/01-intro.md`, draft: "# overview\n", listings, sharesWarning: null }),
    ).toEqual({ kind: "rename", name: "01-overview.md", label: "overview" });
    expect(
      proposeTitle({ path: `${FOLDER}/Plan.excalidraw.md`, draft: "# Map\n", listings, sharesWarning: null }),
    ).toEqual({ kind: "rename", name: "Map.excalidraw.md", label: "Map" });
  });

  test("a slash or a leading dot is refused rather than repaired", () => {
    for (const title of ["a/b", ".hidden"]) {
      const answer = proposeTitle({ path: ROADMAP, draft: `# ${title}\n`, listings, sharesWarning: null });
      expect(answer.kind).toBe("problem");
    }
  });

  test("a title follows a rename only when it was the old name", () => {
    expect(retitled(ROADMAP, `${FOLDER}/Plan.md`, "---\na: 1\n---\n\n# Roadmap\nx\n")).toBe(
      "---\na: 1\n---\n\n# Plan\nx\n",
    );
    expect(retitled(`${FOLDER}/01-intro.md`, `${FOLDER}/01-start.md`, "# intro\n")).toBe("# start\n");
    expect(retitled(DAILY, `${FOLDER}/x.md`, "# Friday\n")).toBeNull();
    expect(retitled(ROADMAP, `${FOLDER}/Plan.md`, "no heading\n")).toBeNull();
  });

  test("a live share holds the name, and says how to change it anyway", () => {
    const answer = proposeTitle({
      path: ROADMAP,
      draft: "# Q4 plan\n",
      listings,
      sharesWarning: "1 person holds a link to this note. Renaming it breaks it — a share follows the path, not the note.",
    });
    expect(answer).toEqual({
      kind: "held",
      message: "1 person holds a link to this note, so the file keeps its name. Use Rename to change it anyway.",
    });
  });
});
