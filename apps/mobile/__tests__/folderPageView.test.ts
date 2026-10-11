/**
 * @jest-environment jsdom
 */

/**
 * A FOLDER PAGE IS WHERE PROJECTS ARE SEEN AND SET, WITH NO BLOCK TO WRITE.
 *
 * Reported from staging: somebody opened `projects/do this`, an empty folder,
 * and asked how to see the projects view and how to set a status. The answer
 * was "insert a list block into a note", which nobody finds. So the folder
 * page itself offers Notes · List · Board — List the Notes rows with a status
 * dot on each task (the owner, 2026-10-10; `folderPageList.test.ts`), Board
 * a column per status — and gives anybody who may write a `Set status` on the
 * folder and on every card, writing the status into the note's own
 * frontmatter, or a folder's front note, or a new `about.md` where a folder
 * has none.
 *
 * The properties with teeth: a member is never shown a control (the server
 * refuses the write anyway), and a folder's status goes to the front note by
 * the fixed order, or creates `about.md` — never anywhere else.
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { FolderView } from "../features/console/files/FolderView";
import type { FolderPageHost } from "../features/console/files/folderPage/FolderPage";
import { SETTLE_AFTER } from "../features/console/files/folderPage/useFolderPage";
import { forgetViews, rememberView } from "../features/console/files/folderPage/viewMemory";
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

const dotOf = (node: Element) => node.querySelector('[data-testid^="status-dot-"]')?.getAttribute("data-testid") ?? null;
const dots = () => document.querySelectorAll('[data-testid^="status-dot-"]');
const rowNamed = (name: string) => all("folder-row").find((node) => strip(node.getAttribute("aria-label")).startsWith(name))!;

describe("a folder whose children have statuses", () => {
  test("opens in List: the Notes rows, a dot on each task and none on a note", async () => {
    await mount(entry("folder", "1-projects"), PROJECTS, host([]));
    expect(one("folder-view-list").getAttribute("aria-selected")).toBe("true");
    expect(all("folder-row").map((node) => strip(node.textContent))).toEqual(["app", "do this", "web", "loose"]);
    // Nothing declared, so active and paused are In progress words.
    expect(dotOf(rowNamed("web"))).toBe("status-dot-in-progress");
    expect(dotOf(rowNamed("app"))).toBe("status-dot-in-progress");
    // A folder with nothing but its placeholder and a plain note are notes, not "No status" tasks.
    expect(dotOf(rowNamed("do this"))).toBeNull();
    expect(dotOf(rowNamed("loose"))).toBeNull();
    expect(strip(document.body.textContent)).not.toContain("No status");
  });

  test("a card's status menu offers the folder's statuses in their groups", async () => {
    const writes: Write[] = [];
    await mount(entry("folder", "1-projects"), PROJECTS, host(writes));
    await press(one("folder-view-board"));
    await press(statusOf(cardNamed("Website folder")));
    expect(strip(one("menu-root").textContent)).toMatch(/Not started.*No status.*backlog.*to do.*In progress.*in progress.*Done.*finished/);
    await press(one("menu-item-choice:4"));
    expect(writes).toEqual([["1-projects/web/overview.md", "status", "finished", undefined]]);
  });

  test("a choice shows at once, and a refused one is taken back with the reason", async () => {
    let settle: (answer: string | null) => void = () => {};
    const refusing: FolderPageHost = {
      ...host([]),
      source: {
        load: async () => ({ notes: NOTES, complete: true }),
        setProperty: () => new Promise<string | null>((resolve) => (settle = resolve)),
      },
    };
    await mount(entry("folder", "1-projects"), PROJECTS, refusing);
    await press(one("folder-view-board"));
    await press(statusOf(cardNamed("Website folder")));
    await press(one("menu-item-choice:4"));
    // Under Finished before the write answers, and no longer Active.
    expect(strip(boardColumn("Finished").textContent)).toContain("Website folder");
    expect(boardColumn("Active")).toBeUndefined();
    await act(async () => settle("That note is changing right now. Try again in a moment."));
    expect(strip(boardColumn("Active").textContent)).toContain("Website folder");
    expect(strip(boardColumn("Finished").textContent)).not.toContain("Website folder");
    expect(strip(one("folder-problem").textContent)).toBe("That note is changing right now. Try again in a moment.");
  });

  test("a member reads the same List with no control on it", async () => {
    const view = await mount(entry("folder", "1-projects"), PROJECTS, host(null));
    expect(dotOf(rowNamed("web"))).toBe("status-dot-in-progress");
    expect(dots()).toHaveLength(2);
    expect(strip(view.container.textContent)).not.toContain("Set status");
    // Placing the folder's words is not theirs either.
    expect(all("folder-choose-group")).toHaveLength(0);
  });
});

describe("the switch", () => {
  test("offers Notes, List and Board, and remembers the choice for this folder", async () => {
    await mount(entry("folder", "1-projects"), PROJECTS, host([]));
    expect(all("folder-view-switch")).toHaveLength(1);
    // The listing is called Notes: "Files" was a word for the storage, not for what is in it.
    expect(strip(one("folder-view-files").textContent)).toBe("Notes");
    await press(one("folder-view-board"));
    // Every status in the folder's list is somewhere to drop, empty or not — Backlog as the rail — and notes are not cards.
    expect(one("folder-board-rail").getAttribute("aria-label")).toBe("Backlog, 0");
    expect(all("folder-board-column").map((column) => column.getAttribute("aria-label"))).toEqual([
      "To do, 0",
      "In progress, 0",
      "Active, 1",
      "Paused, 1",
      "Finished, 0",
    ]);
    await press(one("folder-view-files"));
    expect(all("folder-row").length).toBeGreaterThan(0);
    expect(dots()).toHaveLength(0);

    roots.pop()!();
    await mount(entry("folder", "1-projects"), PROJECTS, host([]));
    expect(one("folder-view-files").getAttribute("aria-selected")).toBe("true");
    expect(dots()).toHaveLength(0);
    expect(all("folder-row").length).toBeGreaterThan(0);
  });
});

describe("a project folder's own page", () => {
  const WEB = listing("1-projects/web", [entry("file", "1-projects/web/overview.md"), entry("file", "1-projects/web/dns.md")]);

  test("is titled by its front note and says its status and owner above its words", async () => {
    const view = await mount(entry("folder", "1-projects/web"), WEB, host(null));
    expect(strip(view.container.textContent)).toContain("Website folder");
    expect(strip(one("folder-property-line").textContent)).toMatch(/^active·Seyi·updated /);
    // Its words are the about note's opening, under the title (`folderAbout.test.ts`); this
    // page has no source to read them from, so none are drawn rather than a guess.
    expect(all("folder-about")).toHaveLength(0);
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
    await press(one("menu-item-choice:4"));
    expect(writes).toEqual([["1-projects/web/overview.md", "status", "finished", undefined]]);
  });
});

describe("a plain folder", () => {
  const DO_THIS = listing("1-projects/do this", [entry("file", "1-projects/do this/README.md")]);

  test("shows a writer Set status, which creates about.md and says so first", async () => {
    const writes: Write[] = [];
    await mount(entry("folder", "1-projects/do this"), DO_THIS, host(writes));
    expect(strip(one("folder-property-line").textContent)).toBe("Set status");
    await press(one("folder-property-status"));
    expect(strip(one("menu-root").textContent)).toContain("Saves to about.md");
    await press(one("menu-item-choice:3"));
    expect(writes).toEqual([["1-projects/do this/about.md", "status", "in progress", { create: true }]]);
  });

  test("shows a member nothing to press", async () => {
    const view = await mount(entry("folder", "1-projects/do this"), DO_THIS, host(null));
    expect(all("folder-property-line")).toHaveLength(0);
    expect(strip(view.container.textContent)).not.toContain("Set status");
  });
});

describe("on a phone", () => {
  test("the same choice comes from a sheet", async () => {
    windowOf(390, 844);
    const writes: Write[] = [];
    await mount(entry("folder", "1-projects"), PROJECTS, host(writes));
    expect(all("folder-view-switch")).toHaveLength(1);
    await press(one("folder-view-board"));
    await press(statusOf(cardNamed("Website folder")));
    expect(all("menu-sheet")).toHaveLength(1);
    await press(one("menu-item-choice:4"));
    expect(writes).toEqual([["1-projects/web/overview.md", "status", "finished", undefined]]);
  });
});

describe("a folder outside projects", () => {
  // Reported by the owner: areas and resources are places to keep things, not
  // work in progress, and Files · List · Board there was only clutter.
  const AREA_NOTES: ListNote[] = [
    { path: "2-areas/apps/overview.md", updatedAt: 5, properties: { status: "active" } },
    { path: "2-areas/health/overview.md", updatedAt: 6, properties: {} },
    { path: "2-areas/loose.md", updatedAt: 7, properties: { status: "paused" } },
  ];
  const AREAS = listing("2-areas", [entry("folder", "2-areas/apps"), entry("folder", "2-areas/health"), entry("file", "2-areas/loose.md")]);
  const areas = (): FolderPageHost => ({ ...host([]), source: { load: async () => ({ notes: AREA_NOTES, complete: true }), setProperty: async () => null } });

  test("is its files, with no switch and no nudge, even when things in it have a status", async () => {
    await mount(entry("folder", "2-areas"), AREAS, areas());
    expect(all("folder-view-switch")).toHaveLength(0);
    expect(all("folder-nudge")).toHaveLength(0);
    expect(dots()).toHaveLength(0);
    expect(all("folder-row")).toHaveLength(3);
  });

  test("a subfolder offers no Set status, and a status it has is not drawn as a project", async () => {
    await mount(entry("folder", "2-areas/apps"), listing("2-areas/apps", []), areas());
    expect(all("folder-view-switch")).toHaveLength(0);
    expect(all("folder-property-line")).toHaveLength(0);
    await mount(entry("folder", "2-areas/health"), listing("2-areas/health", []), areas());
    expect(all("folder-property-line")).toHaveLength(0);
  });

  test("a view picked there before is not brought back", async () => {
    rememberView("ws_test", "2-areas", "board");
    await mount(entry("folder", "2-areas"), AREAS, areas());
    expect(all("folder-board")).toHaveLength(0);
    expect(all("folder-row")).toHaveLength(3);
  });
});

test("a project folder asks for its notes to be current when it opens; a folder outside projects does not", async () => {
  // Reported by the owner: a phone's List read "In progress 2" where the web read 9, its copy days behind.
  const freshened: string[] = [];
  const asking = (): FolderPageHost => ({ ...host([]), source: { load: async () => ({ notes: [], complete: true }), freshen: (at: string) => freshened.push(at) } });
  await mount(entry("folder", "1-projects"), listing("1-projects", []), asking());
  await mount(entry("folder", "2-areas"), listing("2-areas", []), asking());
  expect(freshened).toEqual(["1-projects"]);
});

describe("a folder of folders nobody has tracked yet", () => {
  const UNTRACKED: ListNote[] = [
    { path: "1-projects/trip/overview.md", updatedAt: 5, properties: {} },
    { path: "1-projects/rhythm/overview.md", updatedAt: 6, properties: { priority: "high" } },
  ];
  const LIST = listing("1-projects", [entry("folder", "1-projects/trip"), entry("folder", "1-projects/rhythm")]);
  const untracked = (writes: Write[] = []): FolderPageHost => ({
    ...host(writes),
    source: { ...host(writes).source, load: async () => ({ notes: UNTRACKED, complete: true }) },
  });

  test("opens as files, with one line offering the list, which only switches the view", async () => {
    const writes: Write[] = [];
    await mount(entry("folder", "1-projects"), LIST, untracked(writes));
    expect(all("folder-row")).toHaveLength(2);
    expect(strip(one("folder-nudge").textContent)).toContain("Track these folders by status?");
    await press(one("folder-nudge-show"));
    expect(one("folder-view-list").getAttribute("aria-selected")).toBe("true");
    // Nothing has a status yet, so both are notes: the same two rows, with no dot.
    expect(all("folder-row")).toHaveLength(2);
    expect(dots()).toHaveLength(0);
    expect(all("folder-nudge")).toHaveLength(0);
    expect(writes).toEqual([]);
  });

  test("is not offered to a member, who could set nothing in the list it opens", async () => {
    await mount(entry("folder", "1-projects"), LIST, { ...host(null), source: { load: async () => ({ notes: UNTRACKED, complete: true }) } });
    expect(all("folder-row")).toHaveLength(2);
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

const boardColumn = (label: string) => all("folder-board-column").find((node) => node.getAttribute("aria-label")?.startsWith(`${label},`))!;
const cardNamed = (name: string) => all("folder-card-drag").find((node) => strip(node.textContent).includes(name))!;
const statusOf = (card: HTMLElement) => card.querySelector<HTMLElement>('[data-testid="folder-card-status"]')!;

/** A drag event carrying a card, as jsdom has no DataTransfer of its own. */
function drag(type: string, data: Map<string, string>): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", {
    value: {
      types: [...data.keys()],
      setData: (key: string, value: string) => data.set(key, value),
      getData: (key: string) => data.get(key) ?? "",
      effectAllowed: "none",
      dropEffect: "none",
    },
  });
  return event;
}

describe("the board", () => {
  const column = boardColumn;
  const cardIn = (label: string) => strip(column(label).textContent);

  async function dragOnto(name: string, label: string) {
    const data = new Map<string, string>();
    await act(async () => void cardNamed(name).dispatchEvent(drag("dragstart", data)));
    const over = drag("dragover", data);
    await act(async () => void column(label).dispatchEvent(over));
    await act(async () => void column(label).dispatchEvent(drag("drop", data)));
    return over;
  }

  test("a card dropped on another column takes that status, at once and through the same write as the menu", async () => {
    const writes: Write[] = [];
    await mount(entry("folder", "1-projects"), PROJECTS, host(writes));
    await press(one("folder-view-board"));
    expect(cardNamed("Website folder").getAttribute("draggable")).toBe("true");
    const over = await dragOnto("Website folder", "Finished");
    expect(over.defaultPrevented).toBe(true);
    expect(writes).toEqual([["1-projects/web/overview.md", "status", "finished", undefined]]);
    expect(cardIn("Finished")).toContain("Website folder");
    // Active was only a column because something used it; nothing does now.
    expect(column("Active")).toBeUndefined();
  });

  test("a folder's card moves by writing its front note, whichever it is, as the menu does", async () => {
    const writes: Write[] = [];
    await mount(entry("folder", "1-projects"), PROJECTS, host(writes));
    await press(one("folder-view-board"));
    await dragOnto("app", "Finished");
    expect(writes).toEqual([["1-projects/app/index.md", "status", "finished", undefined]]);
  });

  test("draws tasks only, and dropping where a card already is writes nothing", async () => {
    const writes: Write[] = [];
    await mount(entry("folder", "1-projects"), PROJECTS, host(writes));
    await press(one("folder-view-board"));
    // `do this` and `loose` have no status: notes, not cards, and there is no No status column.
    expect(all("folder-card-drag").map((node) => strip(node.textContent))).toEqual([
      expect.stringContaining("Website folder"),
      expect.stringContaining("app"),
    ]);
    expect(column("No status")).toBeUndefined();
    await dragOnto("app", "Paused");
    expect(writes).toEqual([]);
  });

  test("a refused drop puts the card back and says why", async () => {
    const refusing: FolderPageHost = {
      ...host([]),
      source: { load: async () => ({ notes: NOTES, complete: true }), setProperty: async () => "You can read that note but not change it." },
    };
    await mount(entry("folder", "1-projects"), PROJECTS, refusing);
    await press(one("folder-view-board"));
    await dragOnto("Website folder", "Finished");
    expect(cardIn("Active")).toContain("Website folder");
    expect(strip(one("folder-problem").textContent)).toBe("You can read that note but not change it.");
  });

  test("says it is saving until the write answers", async () => {
    let answer: (value: string | null) => void = () => {};
    const slow: FolderPageHost = {
      ...host([]),
      source: { load: async () => ({ notes: NOTES, complete: true }), setProperty: () => new Promise((resolve) => (answer = resolve)) },
    };
    await mount(entry("folder", "1-projects"), PROJECTS, slow);
    await press(one("folder-view-board"));
    await dragOnto("Website folder", "Finished");
    expect(strip(one("folder-saving").textContent)).toBe("Saving…");
    await act(async () => answer(null));
    expect(all("folder-saving")).toHaveLength(0);
  });

  test("a drag that is not a card is not taken", async () => {
    const writes: Write[] = [];
    await mount(entry("folder", "1-projects"), PROJECTS, host(writes));
    await press(one("folder-view-board"));
    const stranger = drag("dragover", new Map([["Files", "x"]]));
    await act(async () => void column("Finished").dispatchEvent(stranger));
    expect(stranger.defaultPrevented).toBe(false);
    await act(async () => void column("Finished").dispatchEvent(drag("drop", new Map([["text/plain", "1-projects/loose.md"]]))));
    expect(writes).toEqual([]);
  });

  test("every card a writer sees has its status button, drawn, so a keyboard or a phone can move it", async () => {
    await mount(entry("folder", "1-projects"), PROJECTS, host([]));
    await press(one("folder-view-board"));
    const buttons = all("folder-card-status");
    expect(buttons).toHaveLength(2);
    expect(buttons.map((node) => node.getAttribute("aria-label"))).toContain("Change status, active");
    await press(buttons.find((node) => node.getAttribute("aria-label") === "Change status, active")!);
    await press(one("menu-item-choice:4"));
    expect(cardIn("Finished")).toContain("Website folder");
  });

  test("a member's cards do not move and have no button", async () => {
    await mount(entry("folder", "1-projects"), PROJECTS, host(null));
    await press(one("folder-view-board"));
    expect(all("folder-card-drag").every((node) => node.getAttribute("draggable") === "false")).toBe(true);
    expect(all("folder-card-status")).toHaveLength(0);
    expect(all("folder-board-column").map((node) => node.getAttribute("aria-label"))).toEqual(["To do, 0", "In progress, 0", "Active, 1", "Paused, 1", "Finished, 0"]);
    const data = new Map<string, string>([["application/x-context-folder-card", "1-projects/loose.md"]]);
    const over = drag("dragover", data);
    await act(async () => void column("Active").dispatchEvent(over));
    expect(over.defaultPrevented).toBe(false);
  });
});

/**
 * Dev2, on the first cut: a sentence per word, stacked between the header and
 * the list ("is on 1 item here but isn’t one of this folder’s statuses…"),
 * "should never ever look like this". So a word the folder's list does not
 * hold asks nothing of the page: an ordinary word sits in its group, a word
 * nobody placed is the Board's last column with one Choose group on its own
 * head, and tidying (add, merge) is in "Edit statuses…". (The List once drew
 * it last under No group yet; the List no longer groups, 2026-10-10.)
 */
describe("a word nobody placed", () => {
  const UNPLACED: ListNote[] = [...NOTES, { path: "1-projects/research.md", updatedAt: 10, properties: { status: "exploration" } }];
  const RESEARCH = listing("1-projects", [...PROJECTS.entries, entry("file", "1-projects/research.md")]);
  type ListWrite = [path: string, changes: readonly (readonly [string, unknown])[]];
  function placing(writes: Write[] | null, lists: ListWrite[] = []): FolderPageHost {
    const base = host(writes);
    return {
      ...base,
      source: {
        ...base.source,
        load: async () => ({ notes: UNPLACED, complete: true }),
        ...(writes === null
          ? {}
          : {
              setProperties: async (path: string, changes: readonly (readonly [string, unknown])[]) => {
                lists.push([path, changes]);
                return null;
              },
            }),
      },
    };
  }

  test("on the board, it is the last column, with Choose group in its own head and nowhere else", async () => {
    const view = await mount(entry("folder", "1-projects"), RESEARCH, placing([]));
    await press(one("folder-view-board"));
    // Its column comes after Done.
    expect(all("folder-board-column").map((node) => node.getAttribute("aria-label")).at(-1)).toBe("Exploration, 1");
    const column = all("folder-board-column").find((node) => node.getAttribute("aria-label") === "Exploration, 1")!;
    expect(all("folder-choose-group")).toHaveLength(1);
    expect(column.contains(one("folder-choose-group"))).toBe(true);
    // Neither word is a sentence anywhere on the page.
    expect(strip(view.container.textContent)).not.toMatch(/isn’t one of this folder’s statuses|reads as|Merge into|Keep as a status/);
  });

  test("Choose group adds it to the folder's list in that group, and its note keeps its word", async () => {
    const writes: Write[] = [];
    const lists: ListWrite[] = [];
    await mount(entry("folder", "1-projects"), RESEARCH, placing(writes, lists));
    await press(one("folder-view-board"));
    await press(one("folder-choose-group"));
    await press(one("menu-item-to:not-started"));
    expect(lists).toHaveLength(1);
    // Nothing declared yet, so the defaults are written with it: backlog and to do stay.
    expect(lists[0][1]).toContainEqual(["statuses-not-started", ["backlog", "to do", "exploration"]]);
    expect(writes).toEqual([]);
  });

  test("a member sees its column with nothing to press", async () => {
    await mount(entry("folder", "1-projects"), RESEARCH, placing(null));
    await press(one("folder-view-board"));
    expect(all("folder-board-column").map((node) => node.getAttribute("aria-label")).at(-1)).toBe("Exploration, 1");
    expect(all("folder-choose-group")).toHaveLength(0);
  });

  test("Edit statuses lists the words in use, and merging one asks with the count first", async () => {
    const writes: Write[] = [];
    await mount(entry("folder", "1-projects"), RESEARCH, placing(writes));
    await press(one("folder-view-board"));
    await press(one("folder-choose-group"));
    await press(one("menu-item-edit"));
    const rows = all("statuses-in-use-row").map((row) => strip(row.textContent));
    expect(rows).toEqual([
      "Active1 note · reads as In progressAdd to listMerge into In progress",
      "Paused1 note · reads as In progressAdd to listMerge into In progress",
      "Exploration1 note · no groupChoose group",
    ]);
    await press(all("statuses-in-use-merge")[0]);
    expect(strip(one("statuses-confirm").textContent)).toContain("1 note uses “active”. Merging changes their status to “in progress”.");
    expect(writes).toEqual([]);
    await press(one("statuses-confirm-go"));
    expect(writes).toEqual([["1-projects/web/overview.md", "status", "in progress", undefined]]);
  });
});

/**
 * Dev2: "when opening projects it starts out as not-started and then snaps
 * into its proper space". The device's first answer can come before it has
 * the folder's notes (incomplete, none of them yet), and a Board drawn from it
 * put every card under No status with its file name, then moved them all. A
 * List or Board now holds an empty place until the notes can say where each
 * item goes, or until `SETTLE_AFTER` has passed.
 */
describe("opening a board before the device has the folder's notes", () => {
  function arriving(): { page: FolderPageHost; arrive: () => Promise<void> } {
    let current: { notes: ListNote[]; complete: boolean } = { notes: [], complete: false };
    const listeners: (() => void)[] = [];
    const page: FolderPageHost = {
      ...host([]),
      source: {
        ...host([]).source,
        load: async () => current,
        subscribe: (listener: () => void) => {
          listeners.push(listener);
          return () => {};
        },
      },
    };
    return {
      page,
      arrive: async () => {
        current = { notes: NOTES, complete: true };
        await act(async () => listeners.forEach((listener) => listener()));
        await act(async () => {});
      },
    };
  }

  test("holds an empty place, then draws every card where it belongs, once", async () => {
    const { page, arrive } = arriving();
    await mount(entry("folder", "1-projects"), PROJECTS, page);
    await press(one("folder-view-board"));
    expect(all("folder-waiting")).toHaveLength(1);
    expect(all("folder-card")).toHaveLength(0);
    await arrive();
    expect(all("folder-waiting")).toHaveLength(0);
    expect(one("folder-board-rail").getAttribute("aria-label")).toBe("Backlog, 0");
    expect(all("folder-board-column").map((column) => column.getAttribute("aria-label"))).toEqual([
      "To do, 0",
      "In progress, 0",
      "Active, 1",
      "Paused, 1",
      "Finished, 0",
    ]);
  });

  test("draws what it has once it has waited long enough", async () => {
    const { page } = arriving();
    await mount(entry("folder", "1-projects"), PROJECTS, page);
    await press(one("folder-view-board"));
    expect(all("folder-waiting")).toHaveLength(1);
    await act(async () => new Promise((resolve) => setTimeout(resolve, SETTLE_AFTER + 50)));
    expect(all("folder-waiting")).toHaveLength(0);
    // Nothing it has says a status, so nothing is a task yet: it says so rather than drawing notes as cards.
    expect(all("folder-card")).toHaveLength(0);
    expect(strip(one("folder-no-tasks").textContent)).toContain("Nothing here is a task yet");
  });
});
