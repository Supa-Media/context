/**
 * @jest-environment jsdom
 */

/**
 * A FOLDER PAGE IS WHERE PROJECTS ARE SEEN AND SET, WITH NO BLOCK TO WRITE.
 *
 * Reported from staging: somebody opened `projects/do this`, an empty folder,
 * and asked how to see the projects view and how to set a status. The answer
 * was "insert a list block into a note", which nobody finds. So the folder
 * page itself offers Files · List · Board, groups its children by status, and
 * gives anybody who may write a `Set status` on every folder and note —
 * writing the status into the note's own frontmatter, or a folder's front
 * note, or a new `overview.md` where a folder has none.
 *
 * The properties with teeth: a member is never shown a control (the server
 * refuses the write anyway), and a folder's status goes to the front note by
 * the fixed order, or creates `overview.md` — never anywhere else.
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

const PROJECTS = listing("1-projects", [
  entry("folder", "1-projects/app"),
  entry("folder", "1-projects/do this"),
  entry("folder", "1-projects/web"),
  entry("file", "1-projects/loose.md"),
  entry("file", "1-projects/README.md"),
]);

type Write = [path: string, key: string, value: string | null, options: { create?: boolean } | undefined];

function host(writes: Write[] | null): FolderPageHost {
  return {
    workspaceId: "ws_test",
    people: ["John"],
    source: {
      load: async () => ({ notes: NOTES, complete: true }),
      ...(writes === null
        ? {}
        : {
            setProperty: async (path: string, key: string, value: string | null, options?: { create?: boolean }) => {
              writes.push([path, key, value, options]);
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

describe("a folder whose children have statuses", () => {
  test("opens grouped by status, with everything unset together at the end", async () => {
    await mount(entry("folder", "1-projects"), PROJECTS, host([]));
    const groups = all("folder-group").map((group) => strip(group.firstElementChild?.textContent));
    expect(groups).toEqual(["Active1", "Paused1", "No status2"]);
    // A folder with nothing but its placeholder and a plain note, both promotable.
    const unset = all("folder-group")[2];
    expect(strip(unset.textContent)).toContain("do this");
    expect(strip(unset.textContent)).toContain("loose");
    // Named by its front note's heading.
    expect(strip(all("folder-group")[0].textContent)).toContain("Website folder");
  });

  test("a writer gets Set status on every unset row, and a choice writes the note that speaks for it", async () => {
    const writes: Write[] = [];
    await mount(entry("folder", "1-projects"), PROJECTS, host(writes));
    const unset = all("folder-item-status").filter((node) => strip(node.textContent) === "Set status");
    expect(unset).toHaveLength(2);

    await press(unset[0]);
    const labels = all("menu-root").length > 0 ? strip(one("menu-root").textContent) : "";
    expect(labels).toContain("Saves to overview.md");
    await press(one("menu-item-choice:0"));
    // `do this` has only its untouched placeholder, so its first status creates overview.md.
    expect(writes).toEqual([["1-projects/do this/overview.md", "status", "active", { create: true }]]);
  });

  test("a note's status goes in the note itself", async () => {
    const writes: Write[] = [];
    await mount(entry("folder", "1-projects"), PROJECTS, host(writes));
    const loose = all("folder-item").find((row) => strip(row.textContent).includes("loose"))!;
    await press(loose.querySelector<HTMLElement>('[data-testid="folder-item-status"]')!);
    await press(one("menu-item-choice:1"));
    expect(writes).toEqual([["1-projects/loose.md", "status", "paused", undefined]]);
  });

  test("a member reads the same groups with no control on them", async () => {
    const view = await mount(entry("folder", "1-projects"), PROJECTS, host(null));
    expect(all("folder-group")).toHaveLength(3);
    expect(strip(view.container.textContent)).not.toContain("Set status");
    expect(all("folder-item-status")).toHaveLength(0);
  });
});

describe("the switch", () => {
  test("offers Files, List and Board, and remembers the choice for this folder", async () => {
    await mount(entry("folder", "1-projects"), PROJECTS, host([]));
    expect(all("folder-view-switch")).toHaveLength(1);
    await press(one("folder-view-board"));
    expect(all("folder-board-column")).toHaveLength(3);
    await press(one("folder-view-files"));
    expect(all("folder-row").length).toBeGreaterThan(0);
    expect(all("folder-groups")).toHaveLength(0);

    roots.pop()!();
    await mount(entry("folder", "1-projects"), PROJECTS, host([]));
    expect(all("folder-groups")).toHaveLength(0);
    expect(all("folder-row").length).toBeGreaterThan(0);
  });
});

describe("a project folder's own page", () => {
  const WEB = listing("1-projects/web", [entry("file", "1-projects/web/overview.md"), entry("file", "1-projects/web/dns.md")]);

  test("is titled by its front note and says its status, owner and first paragraph", async () => {
    const view = await mount(entry("folder", "1-projects/web"), WEB, host(null));
    expect(strip(view.container.textContent)).toContain("Website folder");
    expect(strip(one("folder-property-line").textContent)).toMatch(/^active·Seyi·updated /);
    expect(strip(one("folder-lede").textContent)).toBe("Publish a folder as a site.");
    // The visibility sentence gives way to the property line on a project.
    expect(strip(view.container.textContent)).not.toContain("visible to the people you granted access");
    // A member sees words, not controls.
    expect(all("folder-property-status")[0].getAttribute("role")).not.toBe("button");
  });

  test("the title opens the front note", async () => {
    const view = await mount(entry("folder", "1-projects/web"), WEB, host(null));
    await press(one("folder-title-open"));
    expect(view.selected).toEqual(["1-projects/web/overview.md"]);
  });

  test("a writer changes the status in the front note it was read from", async () => {
    const writes: Write[] = [];
    await mount(entry("folder", "1-projects/web"), WEB, host(writes));
    await press(one("folder-property-status"));
    expect(strip(one("menu-root").textContent)).not.toContain("Saves to");
    await press(one("menu-item-choice:1"));
    expect(writes).toEqual([["1-projects/web/overview.md", "status", "paused", undefined]]);
  });
});

describe("a plain folder", () => {
  const DO_THIS = listing("1-projects/do this", [entry("file", "1-projects/do this/README.md")]);

  test("shows a writer Set status, which creates overview.md and says so first", async () => {
    const writes: Write[] = [];
    await mount(entry("folder", "1-projects/do this"), DO_THIS, host(writes));
    expect(strip(one("folder-property-line").textContent)).toBe("Set status");
    await press(one("folder-property-status"));
    expect(strip(one("menu-root").textContent)).toContain("Saves to overview.md");
    await press(one("menu-item-choice:0"));
    expect(writes).toEqual([["1-projects/do this/overview.md", "status", "active", { create: true }]]);
  });

  test("shows a member nothing to press", async () => {
    const view = await mount(entry("folder", "1-projects/do this"), DO_THIS, host(null));
    expect(all("folder-property-line")).toHaveLength(0);
    expect(strip(view.container.textContent)).not.toContain("Set status");
  });
});

describe("on a phone", () => {
  test("the same choice comes from a sheet, and the owner moves under the name", async () => {
    windowOf(390, 844);
    const writes: Write[] = [];
    const view = await mount(entry("folder", "1-projects"), PROJECTS, host(writes));
    const web = all("folder-item").find((row) => strip(row.textContent).includes("Website folder"))!;
    expect(strip(web.textContent)).toMatch(/Seyi · /);
    expect(all("folder-view-switch")).toHaveLength(1);
    const unset = all("folder-item-status").find((node) => strip(node.textContent) === "Set status")!;
    await press(unset);
    expect(all("menu-sheet")).toHaveLength(1);
    await press(one("menu-item-choice:1"));
    expect(writes).toEqual([["1-projects/do this/overview.md", "status", "paused", { create: true }]]);
    expect(view.container.textContent).toBeTruthy();
  });
});

describe("a folder of folders nobody has tracked yet", () => {
  const UNTRACKED: ListNote[] = [
    { path: "1-projects/trip/overview.md", updatedAt: 5, properties: {} },
    { path: "1-projects/rhythm/overview.md", updatedAt: 6, properties: { priority: "high" } },
  ];
  const LIST = listing("1-projects", [entry("folder", "1-projects/trip"), entry("folder", "1-projects/rhythm")]);
  const untracked = (): FolderPageHost => ({ ...host([]), source: { load: async () => ({ notes: UNTRACKED, complete: true }), setProperty: async () => null } });

  test("opens as files, with one line offering the list, which only switches the view", async () => {
    await mount(entry("folder", "1-projects"), LIST, untracked());
    expect(all("folder-row")).toHaveLength(2);
    expect(strip(one("folder-nudge").textContent)).toContain("Track these folders by status?");
    await press(one("folder-nudge-show"));
    expect(all("folder-group").map((group) => strip(group.firstElementChild?.textContent))).toEqual(["No status2"]);
    expect(all("folder-item-status").map((node) => strip(node.textContent))).toEqual(["Set status", "Set status"]);
    expect(all("folder-nudge")).toHaveLength(0);
  });

  test("closed, it stays closed for this viewer", async () => {
    await mount(entry("folder", "1-projects"), LIST, untracked());
    await press(one("folder-nudge-dismiss"));
    expect(all("folder-nudge")).toHaveLength(0);
    roots.pop()!();
    await mount(entry("folder", "1-projects"), LIST, untracked());
    expect(all("folder-nudge")).toHaveLength(0);
  });
});
