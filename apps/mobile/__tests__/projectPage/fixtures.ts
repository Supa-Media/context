/**
 * A café project, mounted as its folder page through react-native-web — the
 * Board and the task side panel's tests share it. Fake names and paths only.
 */

import { act, createElement, useState, type ReactNode } from "react";
import { FrameContext, useFrame } from "../../features/app/appFrame/context";
import { createRoot } from "react-dom/client";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { ConsoleNavProvider, type ConsoleNav } from "../../features/console/ConsoleNavContext";
import { FolderView } from "../../features/console/files/FolderView";
import type { FolderPageHost } from "../../features/console/files/folderPage/FolderPage";
import type { TaskHost } from "../../features/console/files/folderPage/tasks/taskHost";
import type { ListNote } from "../../features/console/files/listBlock/model";
import type { FileEntry, FolderListing } from "../../features/console/files/types";

export const CAFE = "1-projects/cafe";

export const strip = (text: string | null | undefined): string => (text ?? "").replace(/[\u2066-\u2069]/g, "");

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

/** What some of the notes say, as the device holds them; any other note has no body on this device. */
export const BODIES: Record<string, string> = {
  [`${CAFE}/overview.md`]: "---\nstatus: in progress\n---\n# Café opening\n\nOpen a café on the corner by spring.\n",
  [`${CAFE}/kitchen/overview.md`]: "---\nstatus: in progress\npriority: p1\n---\n# Get the kitchen ready\n\nEverything the cooks need on day one.\n",
  [`${CAFE}/kitchen/layout.md`]: "# Kitchen layout sketch\n\nOven on the back wall.\n",
  [`${CAFE}/budget.md`]: "# Opening budget\n\nRent, stock and the first month's wages.\n",
  [`${CAFE}/lease.md`]: "---\nstatus: to do\n---\n# Sign the lease\n\nTwo years, with a break at one.\n",
};

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

/** A toast the page said, with its Undo when it offered one. */
export type Toast = { message: string; undo?: () => void };

/**
 * A writer's page (every property write recorded in `writes`, every file write
 * in `files`, every toast in `toasts`), or a member's with `null`.
 */
export function host(
  writes: Write[] | null,
  options: { notes?: ListNote[]; files?: string[]; toasts?: Toast[]; bodies?: Record<string, string>; reads?: string[] } = {},
): FolderPageHost {
  const notes = options.notes ?? NOTES;
  const bodies = options.bodies ?? BODIES;
  const files = options.files;
  const toasts = options.toasts ?? [];
  const tasks: TaskHost | undefined =
    writes === null || files === undefined
      ? undefined
      : {
          io: {
            create: async (path, text) => void files.push(`create ${path}\n${text}`),
            move: async (from, to) => void files.push(`move ${from} -> ${to}`),
            setProperties: async (path, changes, opts) => {
              for (const [key, value] of changes) writes.push([path, key, value, opts]);
              return null;
            },
            remove: async (path) => void files.push(`remove ${path}`),
          },
          say: (message, undo) => void toasts.push({ message, ...(undo === undefined ? {} : { undo }) }),
          refresh: () => undefined,
        };
  return {
    workspaceId: "ws_test",
    people: ["Seyi", "Sayo"],
    me: ["Seyi"],
    ...(tasks === undefined ? {} : { tasks }),
    source: {
      load: async () => ({ notes, complete: true }),
      readBody: async (path: string) => {
        options.reads?.push(path);
        const text = bodies[path];
        return text === undefined ? null : { text, encrypted: false };
      },
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

/** The console's file tree as a test sees it: shown or folded, as the frame last left it. */
export interface Tree {
  hidden: boolean;
}

export async function mount(page: FolderPageHost, listing: FolderListing = LISTING, nav?: ConsoleNav, tree?: Tree) {
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
        children: wrap(nav, tree, createElement(FolderView, {
          entry: entry("folder", listing.path),
          listing,
          canSetVisibility: true,
          contextLabel: "@seyi",
          onSelect: (path: string) => void selected.push(path),
          page,
        })),
      }),
    );
  });
  await act(async () => {});
  await act(async () => {});
  return { container, selected };
}

function wrap(nav: ConsoleNav | undefined, tree: Tree | undefined, child: ReturnType<typeof createElement>) {
  const framed = tree === undefined ? child : createElement(FrameWith, { tree, children: child });
  return nav === undefined ? framed : createElement(ConsoleNavProvider, { value: nav, children: framed });
}

/** A frame whose file tree folds and unfolds, and says where it is left in `tree`. */
function FrameWith({ tree, children }: { tree: Tree; children: ReactNode }) {
  const base = useFrame();
  const [hidden, setHidden] = useState(tree.hidden);
  tree.hidden = hidden;
  const value = {
    ...base,
    state: { ...base.state, explorerHidden: hidden },
    regions: { ...base.regions, explorer: hidden ? ("hidden" as const) : ("column" as const) },
    toggleExplorer: () => {
      tree.hidden = !tree.hidden;
      setHidden(tree.hidden);
    },
    // Said to `tree` at once too: a page being left folds nothing back by rendering again.
    setExplorerFolded: (folded: boolean) => {
      tree.hidden = folded;
      setHidden(folded);
    },
  };
  return createElement(FrameContext.Provider, { value, children });
}

/** The console's navigation, recording every tab a link or a panel opens. */
export function navRecording(opened: [string, string][]): ConsoleNav {
  return {
    follow: (path, mode) => void opened.push([path, mode]),
    back: () => {},
    forward: () => {},
    canBack: false,
    canForward: false,
  };
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
