/**
 * @jest-environment jsdom
 */

/**
 * EVERY FOLDER PAGE OPENS WITH ITS ABOUT NOTE, AS A SUBTITLE.
 *
 * Decided by the owner on 2026-10-08 (the folder-about boards): a folder's
 * `about.md` — or the older `overview.md`, `index.md`, `README.md`, which
 * mean the same — is shown at the top of its page and is not a row as well;
 * the top of the workspace's is `index.md`. Redesigned on 2026-10-09 ("I
 * hate how the about.md looks… sometimes about will be long, sometimes
 * short"): its opening words only, no filename, Read more when there is more
 * (the side panel where it fits, a sheet where it does not), and an Edit
 * button for a writer. Harness shared in shape with `folderPageView.test.ts`.
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

const LONG_LIST = "# Design\n\n- Brand colours\n- Type scale\n- Icon rules\n- Where the files live\n- Who signs off\n";

const BODIES: Record<string, string> = {
  "1-projects/web/overview.md": "---\nstatus: active\n---\n# Website folder\n\nPublish a [folder](https://example.invalid) as a site.\n\n## Domains\n\nOne per site.\n",
  "index.md": "# Seyi\n\nEverything I am working on.\n",
  "1-projects/do this/README.md": "Folder placeholder.\n\nObject storage has no empty folders.\n",
  "1-projects/fresh/about.md": "",
  "3-resources/design/about.md": LONG_LIST,
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
  const FRESH = listing("1-projects/fresh", [entry("file", "1-projects/fresh/about.md"), entry("file", "1-projects/fresh/a.md")]);
  const DESIGN = listing("3-resources/design", [entry("file", "3-resources/design/about.md"), entry("file", "3-resources/design/logo.md")]);

  test("shows only its opening words, plain, with no filename, and is not a row as well", async () => {
    await mount(entry("folder", "1-projects/web"), WEB, host(null));
    await act(async () => {});
    // The paragraph as words: the link's text, not its address; nothing of the heading below it.
    expect(strip(one("folder-about-words").textContent)).toBe("Publish a folder as a site.");
    expect(one("folder-about-words").getAttribute("aria-label")).toBe("Publish a folder as a site. (continues)");
    expect(strip(document.body.textContent)).not.toContain("Domains");
    expect(all("folder-about-file")).toHaveLength(0);
    expect(all("about-editor")).toHaveLength(0);
    const page = strip(one("folder-column").textContent);
    expect(page).toContain("dns");
    expect(page).not.toMatch(/overview|\.md\b/);
  });

  test("a short one offers no Read more", async () => {
    await mount(entry("folder", ""), ROOT, host(null));
    await act(async () => {});
    expect(strip(one("folder-about-words").textContent)).toBe("Everything I am working on.");
    expect(all("folder-about-more")).toHaveLength(0);
    expect(strip(one("folder-column").textContent).match(/index/g) ?? []).toHaveLength(0);
  });

  test("Read more opens the whole note beside the page, editable through the console's one editor", async () => {
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
    // Nothing is lent away just by looking at a folder.
    expect(calls).toEqual([]);
    await press(one("folder-about-more"));
    await act(async () => {});
    expect(strip(one("about-panel-title").textContent)).toBe("About Website folder");
    expect(calls).toEqual(["open 1-projects/web/overview.md"]);
    await press(one("task-panel-close"));
    expect(all("about-panel")).toHaveLength(0);
    expect(calls).toEqual(["open 1-projects/web/overview.md", "close 1-projects/web/overview.md"]);
  });

  test("where the panel has no room, Read more opens a sheet, and Open as note goes to the note", async () => {
    windowOf(390, 844);
    const view = await mount(entry("folder", "1-projects/web"), WEB, host(null));
    await act(async () => {});
    await press(one("folder-about-more"));
    await act(async () => {});
    expect(all("about-sheet")).toHaveLength(1);
    expect(strip(one("about-editor").textContent)).toContain("## Domains");
    await press(one("about-sheet-open"));
    expect(view.selected).toEqual(["1-projects/web/overview.md"]);
    expect(all("about-sheet")).toHaveLength(0);
  });

  test("a member reads it and has no Edit", async () => {
    await mount(entry("folder", "1-projects/web"), WEB, host(null));
    await act(async () => {});
    expect(all("folder-about-edit")).toHaveLength(0);
  });

  test("a writer's Edit turns the opening paragraph into a field, marks and all, and Enter saves it", async () => {
    const writes: Write[] = [];
    await mount(entry("folder", "1-projects/web"), WEB, host(writes));
    await act(async () => {});
    await press(one("folder-about-edit"));
    await act(async () => {});
    const field = one("folder-lede-input") as HTMLTextAreaElement;
    expect(field.value).toBe("Publish a [folder](https://example.invalid) as a site.");
    await type(field, "Publish a [folder](https://example.invalid) as a website.");
    expect(writes).toEqual([["1-projects/web/overview.md", "lede", "Publish a [folder](https://example.invalid) as a website.", undefined]]);
  });

  test("an about that opens with a list shows its first items on one line, and Edit opens the whole note", async () => {
    await mount(entry("folder", "3-resources/design"), DESIGN, host([]));
    await act(async () => {});
    expect(strip(one("folder-about-words").textContent)).toBe("Brand colours · Type scale · Icon rules · Where the files live…");
    await press(one("folder-about-edit"));
    await act(async () => {});
    expect(all("about-panel")).toHaveLength(1);
    expect(all("folder-lede-input")).toHaveLength(0);
  });

  test("the untouched placeholder a new folder used to get is not drawn as one", async () => {
    await mount(entry("folder", "1-projects/do this"), DO_THIS, host(null));
    await act(async () => {});
    expect(all("folder-about")).toHaveLength(0);
    expect(strip(document.body.textContent)).not.toContain("Folder placeholder");
  });

  test("a folder with none offers a writer Add a short description, which creates about.md", async () => {
    const writes: Write[] = [];
    await mount(entry("folder", "1-projects/do this"), DO_THIS, host(writes));
    await act(async () => {});
    expect(strip(one("folder-lede-edit").textContent)).toBe("Add a short description");
    await press(one("folder-lede-edit"));
    await act(async () => {});
    await type(one("folder-lede-input") as HTMLTextAreaElement, "Things to get done.");
    expect(writes).toEqual([["1-projects/do this/about.md", "lede", "Things to get done.", { create: true }]]);
  });

  test("the empty about.md a new folder writes asks a writer for words, into that same note", async () => {
    const writes: Write[] = [];
    await mount(entry("folder", "1-projects/fresh"), FRESH, host(writes));
    await act(async () => {});
    expect(strip(one("folder-lede-edit").textContent)).toBe("Add a short description");
    await press(one("folder-lede-edit"));
    await act(async () => {});
    await type(one("folder-lede-input") as HTMLTextAreaElement, "Fresh start.");
    expect(writes).toEqual([["1-projects/fresh/about.md", "lede", "Fresh start.", undefined]]);
  });

  test("a member is offered nothing where there is none", async () => {
    await mount(entry("folder", "1-projects/do this"), DO_THIS, host(null));
    await act(async () => {});
    expect(all("folder-lede-edit")).toHaveLength(0);
    await mount(entry("folder", "1-projects/fresh"), FRESH, host(null));
    await act(async () => {});
    expect(all("folder-lede-edit")).toHaveLength(0);
    expect(all("folder-about")).toHaveLength(0);
  });
});

async function type(field: HTMLTextAreaElement, text: string) {
  await act(async () => {
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    set.call(field, text);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
}
