/**
 * @jest-environment jsdom
 */

/**
 * EVERY FOLDER PAGE OPENS WITH ITS ABOUT NOTE.
 *
 * Decided by the owner on 2026-10-08 (the folder-about boards): a folder's
 * `about.md` — or the older `overview.md`, `index.md`, `README.md`, which
 * mean the same — is drawn at the top of its page with its filename in the
 * corner, and is not a row as well; the top of the workspace's is
 * `index.md`. A writer presses the words to edit them through the console's
 * one editor, and a folder with none offers "Add a description", which
 * creates `about.md`. It replaced the one-paragraph lede on project pages
 * (reported from a project page: "where does this text come from, and why
 * isn't it editable"). Harness shared in shape with `folderPageView.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import type { PeekEditing } from "../features/console/files/folderPage/panel/peekEditing";
import { createRoot } from "react-dom/client";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { FolderView } from "../features/console/files/FolderView";
import type { FolderPageHost } from "../features/console/files/folderPage/FolderPage";
import { forgetViews } from "../features/console/files/folderPage/viewMemory";
import type { ListNote } from "../features/console/files/listBlock/model";
import type { FileEntry, FolderListing } from "../features/console/files/types";

// The editor is the console's own; here it is its words and whether they can be typed in.
jest.mock("../features/console/files/LiveEditor", () => ({
  LiveEditor: (props: { value: string; editable: boolean }) =>
    require("react").createElement("div", { "data-testid": "about-editor", "data-editable": String(props.editable) }, props.value),
}));

const roots: (() => void)[] = [];

/** jsdom lays nothing out, so react-native-web's window is whatever this says. */
function windowOf(width: number, height: number) {
  Object.defineProperty(document.documentElement, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(document.documentElement, "clientHeight", { value: height, configurable: true });
  window.dispatchEvent(new Event("resize"));
}

beforeEach(() => {
  windowOf(1280, 800);
  forgetViews();
  try {
    localStorage.clear();
  } catch {
    // no storage in this environment
  }
});
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

const strip = (text: string | null | undefined): string => (text ?? "").replace(/[\u2066-\u2069]/g, "");

const entry = (kind: "file" | "folder", path: string): FileEntry => ({
  kind,
  path,
  name: path.split("/").pop()!,
  visibility: "team",
  inherited: "team",
  exception: false,
  readOnly: false,
});

const listing = (path: string, entries: FileEntry[]): FolderListing => ({
  path,
  folderDefault: "team",
  entries,
  truncated: false,
  manifestUsable: true,
});

const NOTES: ListNote[] = [
  { path: "1-projects/web/overview.md", updatedAt: 50, properties: { status: "active", owner: "Seyi" }, heading: "Website folder", lede: "Publish a folder as a site." },
  { path: "1-projects/app/index.md", updatedAt: 40, properties: { status: "paused" } },
  { path: "1-projects/do this/README.md", updatedAt: 30, properties: {}, lede: "Folder placeholder." },
  { path: "1-projects/loose.md", updatedAt: 20, properties: {} },
];

const BODIES: Record<string, string> = {
  "1-projects/web/overview.md": "---\nstatus: active\n---\n# Website folder\n\nPublish a [folder](https://example.invalid) as a site.\n\n## Domains\n\nOne per site.\n",
  "index.md": "# Seyi\n\nEverything I am working on.\n",
  "1-projects/do this/README.md": "Folder placeholder.\n\nObject storage has no empty folders.\n",
};

type Write = [path: string, key: string, value: string | null, options: { create?: boolean } | undefined];

function host(writes: Write[] | null, notes: ListNote[] = NOTES): FolderPageHost {
  return {
    workspaceId: "ws_test",
    people: ["John"],
    source: {
      load: async () => ({ notes, complete: true }),
      readBody: async (path: string) => (BODIES[path] === undefined ? null : { text: BODIES[path]!, encrypted: false }),
      ...(writes === null
        ? {}
        : {
            setProperty: async (path: string, key: string, value: string | null, options?: { create?: boolean }) => {
              writes.push([path, key, value, options]);
              return null;
            },
            setLede: async (path: string, text: string, options?: { create?: boolean }) => {
              writes.push([path, "lede", text, options]);
              return null;
            },
          }),
    },
  };
}

async function mount(folder: FileEntry, list: FolderListing, page: FolderPageHost) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  const selected: string[] = [];
  await act(async () => {
    root.render(
      createElement(SafeAreaProvider, {
        initialMetrics: { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } },
        children: createElement(FolderView, {
          entry: folder,
          listing: list,
          canSetVisibility: true,
          contextLabel: "@seyi",
          onSelect: (path: string) => void selected.push(path),
          page,
        }),
      }),
    );
  });
  // The device's notes arrive a tick later.
  await act(async () => {});
  return { container, selected };
}

const all = (testID: string): HTMLElement[] => [...document.querySelectorAll<HTMLElement>(`[data-testid="${testID}"]`)];
const one = (testID: string): HTMLElement => {
  const found = all(testID)[0];
  if (found === undefined) throw new Error(`no ${testID}`);
  return found;
};

async function press(node: HTMLElement) {
  await act(async () => {
    node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

describe("a folder's about note", () => {
  const WEB = listing("1-projects/web", [entry("file", "1-projects/web/overview.md"), entry("file", "1-projects/web/dns.md")]);
  const ROOT = listing("", [entry("folder", "1-projects"), entry("file", "index.md"), entry("file", "todo.md")]);
  const DO_THIS = listing("1-projects/do this", [entry("file", "1-projects/do this/README.md")]);

  test("is drawn at the top with its filename, whole, and is not a row as well", async () => {
    await mount(entry("folder", "1-projects/web"), WEB, host(null));
    await act(async () => {});
    const words = strip(one("about-editor").textContent);
    // The whole note, links as written, without the frontmatter or the heading the title already says.
    expect(words).toContain("Publish a [folder](https://example.invalid) as a site.");
    expect(words).toContain("## Domains");
    expect(words).not.toContain("status: active");
    expect(words).not.toContain("# Website folder");
    expect(strip(one("folder-about-file").textContent)).toBe("overview.md");
    // The listing below has the folder's other note, and not this one again.
    const page = strip(one("folder-column").textContent);
    expect(page).toContain("dns");
    expect(page.match(/overview/g)).toHaveLength(1);
  });

  test("its filename opens it as a note", async () => {
    const view = await mount(entry("folder", "1-projects/web"), WEB, host(null));
    await press(one("folder-about-file"));
    expect(view.selected).toEqual(["1-projects/web/overview.md"]);
  });

  test("at the top of the workspace it is index.md, and index.md is not a row", async () => {
    await mount(entry("folder", ""), ROOT, host(null));
    await act(async () => {});
    expect(strip(one("about-editor").textContent)).toContain("Everything I am working on.");
    expect(strip(one("folder-about-file").textContent)).toBe("index.md");
    expect(strip(one("folder-column").textContent)).toContain("todo");
    expect(strip(one("folder-column").textContent).match(/index/g)).toHaveLength(1);
  });

  test("a member reads it and has nothing to press", async () => {
    await mount(entry("folder", "1-projects/web"), WEB, host(null));
    await act(async () => {});
    expect(one("about-editor").getAttribute("data-editable")).toBe("false");
    expect(one("folder-about-words").getAttribute("aria-disabled")).toBe("true");
  });

  test("a writer presses the words and types in them through the console's one editor, and Done gives it back", async () => {
    const calls: string[] = [];
    const editing: PeekEditing = {
      open: (path) => (calls.push(`open ${path}`), true),
      close: (path) => (calls.push(`close ${path}`), true),
      editor: { path: "1-projects/web/overview.md", draft: BODIES["1-projects/web/overview.md"]!, status: "clean", readOnly: false, encrypted: false },
      canEdit: true,
      onChange: (text) => void calls.push(`type ${text}`),
      onSave: () => void calls.push("save"),
    };
    await mount(entry("folder", "1-projects/web"), WEB, { ...host([]), editing });
    await act(async () => {});
    // Read-only until pressed: nothing is lent away just by looking at a folder.
    expect(calls).toEqual([]);
    await press(one("folder-about-words"));
    await act(async () => {});
    expect(calls).toEqual(["open 1-projects/web/overview.md"]);
    expect(one("about-editor").getAttribute("data-editable")).not.toBe("false");
    await press(one("folder-about-done"));
    expect(calls).toEqual(["open 1-projects/web/overview.md", "close 1-projects/web/overview.md"]);
    expect(all("folder-about-done")).toHaveLength(0);
  });

  test("the untouched placeholder a new folder used to get is not drawn as one", async () => {
    await mount(entry("folder", "1-projects/do this"), DO_THIS, host(null));
    await act(async () => {});
    expect(all("folder-about")).toHaveLength(0);
    expect(strip(document.body.textContent)).not.toContain("Folder placeholder");
  });

  test("a folder with none offers a writer Add a description, which creates about.md", async () => {
    const writes: Write[] = [];
    await mount(entry("folder", "1-projects/do this"), DO_THIS, host(writes));
    await act(async () => {});
    expect(strip(one("folder-lede-edit").textContent)).toBe("Add a description");
    await press(one("folder-lede-edit"));
    await act(async () => {});
    const field = one("folder-lede-input") as HTMLTextAreaElement;
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      set.call(field, "Things to get done.");
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(writes).toEqual([["1-projects/do this/about.md", "lede", "Things to get done.", { create: true }]]);
  });

  test("a member is offered nothing where there is none", async () => {
    await mount(entry("folder", "1-projects/do this"), DO_THIS, host(null));
    await act(async () => {});
    expect(all("folder-lede-edit")).toHaveLength(0);
  });
});
