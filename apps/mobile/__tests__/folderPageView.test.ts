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
  test("opens grouped by status group, with everything unset together first in Not started", async () => {
    await mount(entry("folder", "1-projects"), PROJECTS, host([]));
    const groups = all("folder-group").map((group) => strip(group.firstElementChild?.textContent));
    expect(groups).toEqual(["Not started2", "In progress2"]);
    // A group holding two statuses names each; nothing declared, so active and paused are In progress words.
    expect(all("folder-status").map((node) => strip(node.firstElementChild?.textContent))).toContain("Active1");
    // A folder with nothing but its placeholder and a plain note, both promotable.
    const unset = all("folder-group")[0];
    expect(strip(unset.textContent)).toContain("do this");
    expect(strip(unset.textContent)).toContain("loose");
    // Named by its front note's heading.
    expect(strip(all("folder-group")[1].textContent)).toContain("Website folder");
  });

  test("a writer gets Set status on every unset row, and a choice writes the note that speaks for it", async () => {
    const writes: Write[] = [];
    await mount(entry("folder", "1-projects"), PROJECTS, host(writes));
    const unset = all("folder-item-status").filter((node) => strip(node.textContent) === "Set status");
    expect(unset).toHaveLength(2);

    await press(unset[0]);
    const labels = all("menu-root").length > 0 ? strip(one("menu-root").textContent) : "";
    expect(labels).toContain("Saves to overview.md");
    // The menu offers the folder's statuses in their groups, not loose words.
    expect(labels).toMatch(/Not started.*No status.*In progress.*in progress.*Done.*finished/);
    await press(one("menu-item-choice:1"));
    // `do this` has only its untouched placeholder, so its first status creates overview.md.
    expect(writes).toEqual([["1-projects/do this/overview.md", "status", "in progress", { create: true }]]);
  });

  test("a note's status goes in the note itself", async () => {
    const writes: Write[] = [];
    await mount(entry("folder", "1-projects"), PROJECTS, host(writes));
    const loose = all("folder-item").find((row) => strip(row.textContent).includes("loose"))!;
    await press(loose.querySelector<HTMLElement>('[data-testid="folder-item-status"]')!);
    await press(one("menu-item-choice:2"));
    expect(writes).toEqual([["1-projects/loose.md", "status", "finished", undefined]]);
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
    const loose = () => all("folder-item").find((row) => strip(row.textContent).includes("loose"))!;
    await press(loose().querySelector<HTMLElement>('[data-testid="folder-item-status"]')!);
    await press(one("menu-item-choice:2"));
    // Moved to Done before the write answers.
    expect(all("folder-group").map((group) => strip(group.firstElementChild?.textContent))).toEqual(["Not started1", "In progress2", "Done1"]);
    await act(async () => settle("That note is changing right now. Try again in a moment."));
    expect(all("folder-group").map((group) => strip(group.firstElementChild?.textContent))).toEqual(["Not started2", "In progress2"]);
    expect(strip(one("folder-problem").textContent)).toBe("That note is changing right now. Try again in a moment.");
  });

  test("a member reads the same groups with no control on them", async () => {
    const view = await mount(entry("folder", "1-projects"), PROJECTS, host(null));
    expect(all("folder-group")).toHaveLength(2);
    expect(strip(view.container.textContent)).not.toContain("Set status");
    // Placing the folder's words is not theirs either.
    expect(all("folder-choose-group")).toHaveLength(0);
    expect(all("folder-item-status")).toHaveLength(0);
  });
});

describe("the switch", () => {
  test("offers Files, List and Board, and remembers the choice for this folder", async () => {
    await mount(entry("folder", "1-projects"), PROJECTS, host([]));
    expect(all("folder-view-switch")).toHaveLength(1);
    await press(one("folder-view-board"));
    // Every status in the folder's list is a column to drop on, empty or not, under its group, No status first.
    expect(all("folder-board-band").map((band) => band.getAttribute("aria-label"))).toEqual(["Not started", "In progress", "Done"]);
    expect(all("folder-board-column").map((column) => column.getAttribute("aria-label"))).toEqual([
      "No status, 2",
      "In progress, 0",
      "Active, 1",
      "Paused, 1",
      "Finished, 0",
    ]);
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
    await press(one("menu-item-choice:2"));
    expect(writes).toEqual([["1-projects/web/overview.md", "status", "finished", undefined]]);
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
    await press(one("menu-item-choice:1"));
    expect(writes).toEqual([["1-projects/do this/overview.md", "status", "in progress", { create: true }]]);
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
    await press(one("menu-item-choice:2"));
    expect(writes).toEqual([["1-projects/do this/overview.md", "status", "finished", { create: true }]]);
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
    expect(all("folder-group").map((group) => strip(group.firstElementChild?.textContent))).toEqual(["Not started2"]);
    expect(all("folder-item-status").map((node) => strip(node.textContent))).toEqual(["Set status", "Set status"]);
    expect(all("folder-nudge")).toHaveLength(0);
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
  const column = (label: string) => all("folder-board-column").find((node) => node.getAttribute("aria-label")?.startsWith(`${label},`))!;
  const cardIn = (label: string) => strip(column(label).textContent);
  const cardNamed = (name: string) => all("folder-card-drag").find((node) => strip(node.textContent).includes(name))!;

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

  test("a folder with no front note moves by creating its overview.md, as the menu does", async () => {
    const writes: Write[] = [];
    await mount(entry("folder", "1-projects"), PROJECTS, host(writes));
    await press(one("folder-view-board"));
    await dragOnto("do this", "In progress");
    expect(writes).toEqual([["1-projects/do this/overview.md", "status", "in progress", { create: true }]]);
  });

  test("dropping on No status clears it, and dropping where it already is writes nothing", async () => {
    const writes: Write[] = [];
    await mount(entry("folder", "1-projects"), PROJECTS, host(writes));
    await press(one("folder-view-board"));
    await dragOnto("app", "Paused");
    expect(writes).toEqual([]);
    await dragOnto("app", "No status");
    expect(writes).toEqual([["1-projects/app/index.md", "status", null, undefined]]);
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
    expect(buttons).toHaveLength(4);
    expect(buttons.map((node) => node.getAttribute("aria-label"))).toContain("Change status, active");
    await press(buttons.find((node) => node.getAttribute("aria-label") === "Change status, active")!);
    await press(one("menu-item-choice:2"));
    expect(cardIn("Finished")).toContain("Website folder");
  });

  test("a member's cards do not move and have no button, and No status is a column only with something in it", async () => {
    await mount(entry("folder", "1-projects"), PROJECTS, host(null));
    await press(one("folder-view-board"));
    expect(all("folder-card-drag").every((node) => node.getAttribute("draggable") === "false")).toBe(true);
    expect(all("folder-card-status")).toHaveLength(0);
    expect(all("folder-board-column").map((node) => node.getAttribute("aria-label"))).toEqual(["No status, 2", "In progress, 0", "Active, 1", "Paused, 1", "Finished, 0"]);
    const data = new Map<string, string>([["application/x-context-folder-card", "1-projects/loose.md"]]);
    const over = drag("dragover", data);
    await act(async () => void column("Active").dispatchEvent(over));
    expect(over.defaultPrevented).toBe(false);
  });
});

describe("a quiet status in the list", () => {
  test("is hidden beside its group heading, and shown when a keyboard reaches it", async () => {
    await mount(entry("folder", "1-projects"), PROJECTS, host([]));
    const web = all("folder-item").find((row) => strip(row.textContent).includes("Website folder"))!;
    const button = web.querySelector<HTMLElement>('[data-testid="folder-item-status"]')!;
    const word = button.firstElementChild as HTMLElement;
    expect(getComputedStyle(word).opacity).toBe("0");
    await act(async () => button.focus());
    expect(getComputedStyle(word).opacity).not.toBe("0");
  });
});

/**
 * Dev2, on the first cut: a sentence per word, stacked between the header and
 * the list ("is on 1 item here but isn’t one of this folder’s statuses…"),
 * "should never ever look like this". So a word the folder's list does not
 * hold asks nothing of the page: an ordinary word sits in its group, a word
 * nobody placed sits last under No group yet with one Choose group on its own
 * heading, and tidying (add, merge) is in "Edit statuses…".
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

  test("sits last under No group yet, asked about on its own heading and nowhere above the list", async () => {
    const view = await mount(entry("folder", "1-projects"), RESEARCH, placing([]));
    const groups = all("folder-group");
    expect(groups.map((group) => strip(group.firstElementChild?.textContent))).toEqual(["Not started2", "In progress2", "No group yet1Choose group"]);
    expect(all("folder-choose-group")).toHaveLength(1);
    expect(groups[2].contains(one("folder-choose-group"))).toBe(true);
    // Neither word is a sentence anywhere on the page.
    expect(strip(view.container.textContent)).not.toMatch(/isn’t one of this folder’s statuses|reads as|Merge into|Keep as a status/);
  });

  test("Choose group adds it to the folder's list in that group, and its note keeps its word", async () => {
    const writes: Write[] = [];
    const lists: ListWrite[] = [];
    await mount(entry("folder", "1-projects"), RESEARCH, placing(writes, lists));
    await press(one("folder-choose-group"));
    await press(one("menu-item-to:not-started"));
    expect(lists).toHaveLength(1);
    expect(lists[0][1]).toContainEqual(["statuses-not-started", ["exploration"]]);
    expect(writes).toEqual([]);
  });

  test("on the board, Choose group is in the word's own column head", async () => {
    await mount(entry("folder", "1-projects"), RESEARCH, placing([]));
    await press(one("folder-view-board"));
    const bands = all("folder-board-band");
    expect(bands.map((band) => band.getAttribute("aria-label"))).toEqual(["Not started", "In progress", "Done", "No group yet"]);
    const column = all("folder-board-column").find((node) => node.getAttribute("aria-label") === "Exploration, 1")!;
    expect(column.contains(one("folder-choose-group"))).toBe(true);
  });

  test("a member sees No group yet with nothing to press", async () => {
    await mount(entry("folder", "1-projects"), RESEARCH, placing(null));
    expect(strip(all("folder-group").at(-1)?.firstElementChild?.textContent)).toBe("No group yet1");
    expect(all("folder-choose-group")).toHaveLength(0);
  });

  test("Edit statuses lists the words in use, and merging one asks with the count first", async () => {
    const writes: Write[] = [];
    await mount(entry("folder", "1-projects"), RESEARCH, placing(writes));
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
