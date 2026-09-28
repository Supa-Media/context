/**
 * A café project, mounted as its folder page through react-native-web — the
 * Board and the task side panel's tests share it. Fake names and paths only.
 */

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { FolderView } from "../../features/console/files/FolderView";
import type { FolderPageHost } from "../../features/console/files/folderPage/FolderPage";
import type { TaskWriteIO } from "../../features/console/files/folderPage/tasks/taskWrites";
import type { ListNote } from "../../features/console/files/listBlock/model";
import type { FileEntry, FolderListing } from "../../features/console/files/types";

export const CAFE = "1-projects/cafe";

export const strip = (text: string | null | undefined): string => (text ?? "").replace(/[⁦-⁩]/g, "");

export const entry = (kind: "file" | "folder", path: string): FileEntry => ({
  kind,
  path,
  name: path.split("/").pop()!,
  visibility: "team",
  inherited: "team",
  exception: false,
  readOnly: false,
});

export const note = (name: string, properties: ListNote["properties"], updatedAt = 1, heading?: string): ListNote => ({
  path: `${CAFE}/${name}`,
  properties,
  updatedAt,
  ...(heading === undefined ? {} : { heading }),
});

export const NOTES: ListNote[] = [
  note("overview.md", { status: "in progress" }, 1, "Café opening"),
  note("lease.md", { status: "to do", priority: "p0", owner: "@seyi", tags: ["Setup"], due: "2020-10-02" }, 5, "Sign the lease"),
  note("photos.md", { status: "to do", priority: "p2" }, 9, "Take photos for the menu"),
  note("post.md", { status: "to do", priority: "p3", owner: "Claude", tags: ["Writing"] }, 7, "Write the opening-day post"),
  note("later.md", { status: "backlog" }, 3, "Loyalty cards"),
  note("kitchen/overview.md", { status: "in progress", priority: "p1", owner: ["@sayo", "@seyi"], tags: ["Kitchen", "Suppliers"] }, 6, "Get the kitchen ready"),
  note("kitchen/oven.md", { status: "finished", owner: "@sayo" }, 6, "Order the oven"),
  note("kitchen/fridge.md", { status: "finished", owner: "Claude" }, 6, "Compare fridge prices"),
  note("kitchen/inspection.md", { status: "to do" }, 6, "Book the health inspection"),
  note("kitchen/layout.md", {}, 6, "Kitchen layout sketch"),
  note("opened.md", { status: "finished" }, 2, "Open the doors"),
  note("budget.md", {}, 8, "Opening budget"),
];

export const LISTING: FolderListing = {
  path: CAFE,
  folderDefault: "team",
  entries: ["overview.md", "lease.md", "photos.md", "post.md", "later.md", "opened.md", "budget.md"]
    .map((name) => entry("file", `${CAFE}/${name}`))
    .concat([entry("folder", `${CAFE}/kitchen`)]),
  truncated: false,
  manifestUsable: true,
};

export type Write = [path: string, key: string, value: unknown, options: { create?: boolean } | undefined];

/** A writer's page (every property write recorded in `writes`, every file write in `files`), or a member's with `null`. */
export function host(writes: Write[] | null, options: { notes?: ListNote[]; files?: string[] } = {}): FolderPageHost {
  const notes = options.notes ?? NOTES;
  const files = options.files;
  const tasks: TaskWriteIO | undefined =
    writes === null || files === undefined
      ? undefined
      : {
          create: async (path, text) => void files.push(`create ${path}\n${text}`),
          move: async (from, to) => void files.push(`move ${from} -> ${to}`),
          setProperties: async (path, changes, opts) => {
            for (const [key, value] of changes) writes.push([path, key, value, opts]);
            return null;
          },
          remove: async (path) => void files.push(`remove ${path}`),
        };
  return {
    workspaceId: "ws_test",
    people: ["Seyi", "Sayo"],
    me: ["Seyi"],
    ...(tasks === undefined ? {} : { tasks }),
    source: {
      load: async () => ({ notes, complete: true }),
      searchOwners: async () => ({ people: [{ value: "@sayo", name: "Sayo", isMe: false }, { value: "@seyi", name: "Seyi", isMe: true }], agents: ["Claude"], truncated: false }),
      ...(writes === null
        ? {}
        : {
            setProperty: async (path: string, key: string, value: string | null, opts?: { create?: boolean }) => {
              writes.push([path, key, value, opts]);
              return null;
            },
            setProperties: async (path: string, changes: readonly (readonly [string, unknown])[], opts?: { create?: boolean }) => {
              for (const [key, value] of changes) writes.push([path, key, value, opts]);
              return null;
            },
          }),
    },
  };
}

export function windowOf(width: number, height = 800) {
  Object.defineProperty(document.documentElement, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(document.documentElement, "clientHeight", { value: height, configurable: true });
  window.dispatchEvent(new Event("resize"));
}

const roots: (() => void)[] = [];

export function unmountAll() {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
}

export async function mount(page: FolderPageHost, listing: FolderListing = LISTING) {
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
          entry: entry("folder", CAFE),
          listing,
          canSetVisibility: true,
          contextLabel: "@seyi",
          onSelect: (path: string) => void selected.push(path),
          page,
        }),
      }),
    );
  });
  await act(async () => {});
  await act(async () => {});
  return { container, selected };
}

export const all = (testID: string, within: ParentNode = document): HTMLElement[] => [
  ...within.querySelectorAll<HTMLElement>(`[data-testid="${testID}"]`),
];
export const one = (testID: string, within: ParentNode = document): HTMLElement => {
  const found = all(testID, within)[0];
  if (found === undefined) throw new Error(`no ${testID}`);
  return found;
};

export async function press(node: HTMLElement) {
  await act(async () => {
    node.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    node.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

export async function type(input: HTMLElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

export async function key(node: EventTarget, name: string) {
  await act(async () => {
    node.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  });
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

/** An HTML drag event carrying `data`, as `boardDrag.web.ts` reads it. */
export function drag(type: string, data: Map<string, string>): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      get types() {
        return [...data.keys()];
      },
      setData: (key: string, value: string) => void data.set(key, value),
      getData: (key: string) => data.get(key) ?? "",
      effectAllowed: "none",
      dropEffect: "none",
    },
  });
  return event;
}
