/**
 * @jest-environment jsdom
 */

/**
 * A PROJECT'S DESCRIPTION IS EDITED WHERE IT IS DRAWN.
 *
 * Reported from a project page: "in a folder, where does this text come
 * from, and why isn't it editable". It is the first paragraph of the
 * folder's front note (`folderPage/lede.ts`), and it was drawn as plain
 * text. A writer now presses it and edits the paragraph as written; a
 * member still only reads it. Harness shared in shape with
 * `folderPageView.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { FolderView } from "../features/console/files/FolderView";
import type { FolderPageHost } from "../features/console/files/folderPage/FolderPage";
import { forgetViews } from "../features/console/files/folderPage/viewMemory";
import type { ListNote } from "../features/console/files/listBlock/model";
import type { FileEntry, FolderListing } from "../features/console/files/types";

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

type Write = [path: string, key: string, value: string | null, options: { create?: boolean } | undefined];

function host(writes: Write[] | null, notes: ListNote[] = NOTES): FolderPageHost {
  return {
    workspaceId: "ws_test",
    people: ["John"],
    source: {
      load: async () => ({ notes, complete: true }),
      readBody: async (path: string) =>
        path === "1-projects/web/overview.md"
          ? { text: "---\nstatus: active\n---\n# Website folder\n\nPublish a [folder](https://example.invalid) as a site.\n", encrypted: false }
          : null,
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

describe("a project's description", () => {
  const WEB = listing("1-projects/web", [entry("file", "1-projects/web/overview.md"), entry("file", "1-projects/web/dns.md")]);

  async function type(node: HTMLElement, value: string) {
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      set.call(node, value);
      node.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }

  test("a writer edits it in place, starting from the paragraph as written, into the front note", async () => {
    const writes: Write[] = [];
    await mount(entry("folder", "1-projects/web"), WEB, host(writes));
    await press(one("folder-lede-edit"));
    await act(async () => {});
    const field = one("folder-lede-input") as HTMLTextAreaElement;
    // The link survives: the field holds the source, not the plain words drawn.
    expect(field.value).toBe("Publish a [folder](https://example.invalid) as a site.");
    await type(field, "Publish any folder as a site.");
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    expect(writes).toEqual([["1-projects/web/overview.md", "lede", "Publish any folder as a site.", undefined]]);
    // Drawn at once, before the device's copy catches up.
    expect(all("folder-lede-input")).toHaveLength(0);
    expect(strip(one("folder-lede").textContent)).toBe("Publish any folder as a site.");
  });

  test("Escape backs out and writes nothing", async () => {
    const writes: Write[] = [];
    await mount(entry("folder", "1-projects/web"), WEB, host(writes));
    await press(one("folder-lede-edit"));
    const field = one("folder-lede-input");
    await type(field, "Something else.");
    await act(async () => {
      field.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(writes).toEqual([]);
    expect(strip(one("folder-lede").textContent)).toBe("Publish a folder as a site.");
  });

  test("a project with none offers a writer Add a description, and a member nothing", async () => {
    const bare = NOTES.map((note) => (note.path === "1-projects/web/overview.md" ? { ...note, lede: undefined } : note));
    await mount(entry("folder", "1-projects/web"), WEB, host([], bare));
    expect(strip(one("folder-lede-edit").textContent)).toBe("Add a description");
    roots.pop()!();
    await mount(entry("folder", "1-projects/web"), WEB, host(null, bare));
    expect(all("folder-lede-edit")).toHaveLength(0);
    expect(all("folder-lede")).toHaveLength(0);
  });

  test("a member reads it and cannot edit it", async () => {
    await mount(entry("folder", "1-projects/web"), WEB, host(null));
    expect(strip(one("folder-lede").textContent)).toBe("Publish a folder as a site.");
    expect(all("folder-lede-edit")).toHaveLength(0);
  });
});
