/**
 * @jest-environment jsdom
 */

/**
 * AN OWNER IS PICKED, NEVER TYPED.
 *
 * Reported from a folder's List view: the owner menu offered `Sayo`, `Seyi`,
 * `Seyi Olujide` and "New value…", so one person had three spellings and
 * anybody could type a fourth. An owner is now somebody in the workspace, an
 * agent connected to it, or "any agent", found by a search the server runs —
 * a workspace of a hundred people is not a list to scroll.
 *
 * The properties with teeth: there is nowhere to type a new owner; what is
 * offered is what the search returned; typing asks the server rather than
 * filtering a roster; and an owner already written by hand is kept and shown
 * for what it is, with the member it most likely meant offered first.
 */

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SafeAreaProvider } from "react-native-safe-area-context";
import { FolderView } from "../features/console/files/FolderView";
import type { FolderPageHost } from "../features/console/files/folderPage/FolderPage";
import { forgetViews } from "../features/console/files/folderPage/viewMemory";
import { OWNER_SEARCH_DELAY_MS } from "../features/console/files/folderPage/OwnerPicker";
import type { ListNote } from "../features/console/files/listBlock/model";
import { ANY_AGENT, localOwnerSearch, ownerRows, ownersInUse, type OwnerResults } from "../features/console/files/owners";
import type { FileEntry, FolderListing } from "../features/console/files/types";

const roots: (() => void)[] = [];

function windowOf(width: number, height: number) {
  Object.defineProperty(document.documentElement, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(document.documentElement, "clientHeight", { value: height, configurable: true });
  window.dispatchEvent(new Event("resize"));
}

beforeEach(() => {
  windowOf(1280, 800);
  forgetViews();
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

const PROJECTS: FolderListing = {
  path: "1-projects",
  folderDefault: "team",
  entries: [entry("folder", "1-projects/web"), entry("folder", "1-projects/app"), entry("file", "1-projects/loose.md")],
  truncated: false,
  manifestUsable: true,
};

const NOTES: ListNote[] = [
  { path: "1-projects/web/overview.md", updatedAt: 50, properties: { status: "active", owner: "Seyi" }, heading: "Website" },
  { path: "1-projects/app/overview.md", updatedAt: 40, properties: { status: "active", owner: "Sayo" }, heading: "App" },
  { path: "1-projects/loose.md", updatedAt: 20, properties: { status: "active" } },
];

const MEMBERS = ["Sayo", "Seyi Olujide", "John Adé"];

type Write = [path: string, key: string, value: string | null];
type Asked = [query: string, prefer: readonly string[]];

/** A server that answers like `owners.searchOwners`: members matching, and one agent. */
function server(asked: Asked[]) {
  return async (query: string, prefer: readonly string[]): Promise<OwnerResults> => {
    asked.push([query, prefer]);
    const q = query.toLowerCase();
    const preferred = (name: string) => {
      const at = prefer.findIndex((word) => word.toLowerCase() === name.split(" ")[0].toLowerCase());
      return at === -1 ? prefer.length : at;
    };
    const people = MEMBERS.filter((name) => name.toLowerCase().includes(q))
      .sort((a, b) => preferred(a) - preferred(b) || a.localeCompare(b))
      .map((value) => ({ value, isMe: value === "Sayo" }));
    return { people, agents: "claude".includes(q) ? ["Claude"] : [], truncated: false };
  };
}

function host(writes: Write[], asked: Asked[] | null): FolderPageHost {
  return {
    workspaceId: "ws_test",
    people: ["Demo Person"],
    source: {
      load: async () => ({ notes: NOTES, complete: true }),
      setProperty: async (path: string, key: string, value: string | null) => {
        writes.push([path, key, value]);
        return null;
      },
      ...(asked === null ? {} : { searchOwners: server(asked) }),
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
  await act(async () => {
    root.render(
      createElement(SafeAreaProvider, {
        initialMetrics: { frame: { x: 0, y: 0, width: 390, height: 844 }, insets: { top: 0, left: 0, right: 0, bottom: 0 } },
        children: createElement(FolderView, {
          entry: folder,
          listing: list,
          canSetVisibility: true,
          contextLabel: "@team",
          onSelect: () => {},
          page,
        }),
      }),
    );
  });
  await act(async () => {});
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

async function settle() {
  await act(() => new Promise((resolve) => setTimeout(resolve, OWNER_SEARCH_DELAY_MS + 30)));
  // Opening measures the value first (a timer), then the picker asks; wait for it to have answered.
  for (let tries = 0; tries < 50 && all("owner-picker-note").some((node) => strip(node.textContent) === "Searching…"); tries += 1) {
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
  }
}

async function type(text: string) {
  const input = one("owner-picker-field") as HTMLInputElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await settle();
}

const options = () => all("owner-picker-option").map((node) => strip(node.textContent));
const ownerOf = (label: string) =>
  all("folder-item")
    .find((row) => strip(row.textContent).includes(label))!
    .querySelector<HTMLElement>('[data-testid="folder-item-owner"]')!;

describe("the owner picker on a folder's List", () => {
  test("offers people and agents from the search, and nowhere to type a new owner", async () => {
    const writes: Write[] = [];
    await mount(entry("folder", "1-projects"), PROJECTS, host(writes, []));
    await press(ownerOf("loose"));
    await settle();
    expect(all("owner-picker")).toHaveLength(1);
    expect(all("menu-root")).toHaveLength(0);
    expect(options()).toEqual(["Seyi Olujide", "Sayo (you)", "John Adé", "Claude", "Any agentWhichever picks it up"]);
    expect(strip(one("owner-picker").textContent)).not.toContain("New value");

    await press(all("owner-picker-option")[0]);
    expect(writes).toEqual([["1-projects/loose.md", "owner", "Seyi Olujide"]]);
    expect(all("owner-picker")).toHaveLength(0);
  });

  test("typing asks the server, with the folder's own owners as the ones to prefer", async () => {
    const asked: Asked[] = [];
    await mount(entry("folder", "1-projects"), PROJECTS, host([], asked));
    await press(ownerOf("loose"));
    await settle();
    await type("jo");
    expect(asked.map(([query]) => query)).toEqual(["", "jo"]);
    // Both owners the folder uses are passed; neither is dropped for being hand-typed.
    expect([...asked[1][1]].sort()).toEqual(["Sayo", "Seyi"]);
    expect(options()).toEqual(["John Adé"]);
  });

  test("an owner typed by hand is kept, marked, and its likely member offered first", async () => {
    const writes: Write[] = [];
    const asked: Asked[] = [];
    await mount(entry("folder", "1-projects"), PROJECTS, host(writes, asked));
    await press(ownerOf("Website"));
    await settle();
    // The current word leads what is preferred, so "Seyi" finds Seyi Olujide.
    expect(asked[0][1][0]).toBe("Seyi");
    expect(options().slice(0, 2)).toEqual(["✓SeyiNot a member", "Seyi Olujide"]);
    expect(options()).toContain("No owner");
    await press(all("owner-picker-option")[1]);
    expect(writes).toEqual([["1-projects/web/overview.md", "owner", "Seyi Olujide"]]);
  });

  test("any agent is a choice of its own", async () => {
    const writes: Write[] = [];
    await mount(entry("folder", "1-projects"), PROJECTS, host(writes, []));
    await press(ownerOf("loose"));
    await settle();
    await type("agent");
    expect(options()).toEqual(["Any agentWhichever picks it up"]);
    await press(one("owner-picker-option"));
    expect(writes).toEqual([["1-projects/loose.md", "owner", ANY_AGENT]]);
  });

  test("with no server to ask, it picks from the people it was handed, still without typing", async () => {
    await mount(entry("folder", "1-projects"), PROJECTS, host([], null));
    await press(ownerOf("loose"));
    await settle();
    expect(options()).toEqual(["Demo Person", "Any agentWhichever picks it up"]);
  });
});

describe("the owner on a project's own page", () => {
  test("is picked the same way", async () => {
    const writes: Write[] = [];
    const web: FolderListing = { ...PROJECTS, path: "1-projects/web", entries: [entry("file", "1-projects/web/overview.md")] };
    await mount(entry("folder", "1-projects/web"), web, host(writes, []));
    await press(one("folder-property-owner"));
    await settle();
    expect(all("owner-picker")).toHaveLength(1);
    await press(all("owner-picker-option").find((node) => strip(node.textContent) === "Sayo (you)")!);
    expect(writes).toEqual([["1-projects/web/overview.md", "owner", "Sayo"]]);
  });
});

describe("what the picker offers, as data", () => {
  const results: OwnerResults = { people: [{ value: "Sayo", isMe: false }], agents: ["Codex"], truncated: false };

  test("the owners in use, most used first, then most recent", () => {
    const notes = [
      { properties: { owner: "Seyi" }, updatedAt: 1 },
      { properties: { owner: "Sayo" }, updatedAt: 5 },
      { properties: { owner: "seyi " }, updatedAt: 2 },
      { properties: { owner: "John" }, updatedAt: 9 },
      { properties: {}, updatedAt: 10 },
    ];
    expect(ownersInUse(notes)).toEqual(["Seyi", "John", "Sayo"]);
  });

  test("a known owner is checked in place; an unknown one leads, marked", () => {
    expect(ownerRows("", "sayo", results).filter((row) => row.kind === "choice" && row.checked)).toHaveLength(1);
    expect(ownerRows("", "Bob", results)[0]).toEqual({ kind: "choice", value: "Bob", label: "Bob", detail: "Not a member", checked: true });
    expect(ownerRows("", "codex", results).some((row) => row.kind === "choice" && row.detail === "Not a member")).toBe(false);
  });

  test("nothing is offered as a choice before the search answers, but the old owner is not called a stranger", () => {
    expect(ownerRows("", "Bob", null).some((row) => row.kind === "choice" && row.detail === "Not a member")).toBe(false);
  });

  test("the local search prefers the folder's owners by first name", async () => {
    const found = await localOwnerSearch(["Ada Lovelace", "Seyi Olujide", "Bola"])("", ["Seyi"]);
    expect(found.people.map((person) => person.value)).toEqual(["Seyi Olujide", "Ada Lovelace", "Bola"]);
  });
});
