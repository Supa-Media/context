/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement, type ReactElement } from "react";
import { ConvexError } from "convex/values";
import { createRoot } from "react-dom/client";
import type { FileBrowser } from "../features/console/files/browser";
import type { FileEntry, FolderListing } from "../features/console/files/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * A note asked for and not there (Dev, 2026-11-03). A teammate opened a link
 * to a note that did not exist and got "That file does not exist." in the
 * notice band over a loading skeleton that never stopped, and waited thirty
 * seconds for it. Now the read's `FILE_NOT_FOUND` is a state of its own,
 * drawn as one page with ways out, and never a notice.
 *
 * The server answers `FILE_NOT_FOUND` for a note the caller may not see too,
 * so the page may not tell the two apart: the suggestions and the nearest
 * folder come only from what the viewer's own listings already show.
 */

const actions: Record<string, (args: never) => Promise<unknown>> = {};
const bound: Record<string, (args: never) => Promise<unknown>> = {};
jest.mock("convex/react", () => {
  const { getFunctionName } = require("convex/server") as typeof import("convex/server");
  const record = (ref: never) => {
    const name = getFunctionName(ref);
    bound[name] ??= (args: never) => actions[name]!(args);
    return bound[name];
  };
  return { useAction: record, useMutation: record, useQuery: () => undefined, useQueries: () => ({}), useConvex: () => ({ query: async () => null }) };
});
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

import { useFileBrowser } from "../features/console/files/useFileBrowser";
import {
  NOT_FOUND_BODY,
  NOT_FOUND_TITLE,
  nearestFolder,
  notFoundOnScreen,
  searchWords,
  similarNotes,
  standingAt,
  stemOf,
} from "../features/console/files/notFound";
const { ThemeProvider } = require("../features/design/theme") as typeof import("../features/design/theme");
const { NotFoundNote } =
  require("../features/console/panes/browsePane/NotFoundNote") as typeof import("../features/console/panes/browsePane/NotFoundNote");

const GROUP = "tex/groups/kite-willow-rocket";
const ASKED = `${GROUP}/last-7-days.page.md`;

function entry(path: string, kind: "file" | "folder" = "file", updatedAt?: number): FileEntry {
  return {
    kind,
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    visibility: "team",
    inherited: "team",
    exception: false,
    readOnly: false,
    ...(updatedAt === undefined ? {} : { updatedAt }),
  };
}
function listing(path: string, entries: FileEntry[]): FolderListing {
  return { path, folderDefault: "team", truncated: false, manifestUsable: true, entries };
}

const LISTINGS: Record<string, FolderListing> = {
  "": listing("", [entry("tex", "folder")]),
  tex: listing("tex", [entry("tex/groups", "folder")]),
  "tex/groups": listing("tex/groups", [entry(GROUP, "folder"), entry("tex/groups/weekly-recap.md")]),
  [GROUP]: listing(GROUP, [
    entry(`${GROUP}/last-30-days-october.page.md`, "file", 3),
    entry(`${GROUP}/last-7-days-oct-20-to-26.page.md`, "file", 1),
    entry(`${GROUP}/last-7-days-oct-27-to-nov-2.page.md`, "file", 2),
    entry(`${GROUP}/trail-shortlist.md`, "file", 9),
    entry(`${GROUP}/gear-swap.md`, "file", 9),
    entry(`${GROUP}/map.png`, "file", 9),
  ]),
};

describe("what the page offers", () => {
  test("the name, as words to search for", () => {
    expect(stemOf(ASKED)).toBe("last-7-days");
    expect(searchWords(ASKED)).toBe("last 7 days");
    expect(searchWords("1-projects/2-weekly_recap.md")).toBe("weekly recap");
  });

  test("the nearest folder is the deepest one the viewer's own listings name", () => {
    expect(nearestFolder(ASKED, LISTINGS)).toBe(GROUP);
    expect(nearestFolder("tex/groups/paper-lantern-crew/weekly-recap.md", LISTINGS)).toBe("tex/groups");
    expect(nearestFolder("nowhere/at/all.md", LISTINGS)).toBe("");
    expect(nearestFolder("top.md", LISTINGS)).toBe("");
  });

  test("a hidden folder ends the walk exactly where a missing one does", () => {
    // The viewer's listing of tex/groups leaves the private folder out, as `canSee` does.
    const hidden = { ...LISTINGS, "tex/groups/secret": listing("tex/groups/secret", [entry("tex/groups/secret/plan.md")]) };
    expect(nearestFolder("tex/groups/secret/plan.md", hidden)).toBe("tex/groups");
    expect(nearestFolder("tex/groups/secret/plan.md", hidden)).toBe(
      nearestFolder("tex/groups/never-was/plan.md", hidden),
    );
    // And its notes are never offered.
    expect(similarNotes("tex/groups/secret/plan.md", "tex/groups", hidden).map((e) => e.path)).not.toContain(
      "tex/groups/secret/plan.md",
    );
  });

  test("similar notes: shared leading words first, ties to the newest, only notes, at most three", () => {
    expect(similarNotes(ASKED, GROUP, LISTINGS).map((e) => e.path)).toEqual([
      `${GROUP}/last-7-days-oct-27-to-nov-2.page.md`,
      `${GROUP}/last-7-days-oct-20-to-26.page.md`,
      `${GROUP}/last-30-days-october.page.md`,
    ]);
  });

  test("a near typo is offered, a name with nothing in common is not", () => {
    expect(similarNotes(`${GROUP}/trial-shortlist.md`, GROUP, LISTINGS).map((e) => e.path)).toEqual([
      `${GROUP}/trail-shortlist.md`,
    ]);
    expect(similarNotes(`${GROUP}/budget.md`, GROUP, LISTINGS)).toEqual([]);
  });

  test("the bottom bar stands in the nearest folder, never in one that is not there", () => {
    const gone = "tex/groups/paper-lantern-crew/weekly-recap.md";
    expect(standingAt(gone, gone, LISTINGS)).toBe("tex/groups");
    expect(standingAt("nowhere/x.md", "nowhere/x.md", LISTINGS)).toBeNull();
    expect(standingAt(ASKED, null, LISTINGS)).toBe(ASKED);
  });

  test("the page is on screen for the path refused, selected or still only in the address", () => {
    expect(notFoundOnScreen(ASKED, ASKED, null)).toBe(true);
    expect(notFoundOnScreen(ASKED, null, ASKED)).toBe(true);
    expect(notFoundOnScreen(ASKED, "other.md", ASKED)).toBe(false);
    expect(notFoundOnScreen(null, ASKED, ASKED)).toBe(false);
  });
});

/* ------------------------------ the browser ------------------------------ */

let browser: FileBrowser;
const live: Array<() => void> = [];
afterEach(() => {
  while (live.length > 0) live.pop()?.();
  document.body.innerHTML = "";
});

function render(element: ReactElement) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  act(() => root.render(createElement(ThemeProvider, { scheme: "light", children: element })));
  live.push(() => {
    act(() => root.unmount());
    container.remove();
  });
}

async function settle() {
  await act(async () => {
    for (let n = 0; n < 12; n += 1) await Promise.resolve();
  });
}

describe("a read that answers FILE_NOT_FOUND", () => {
  beforeEach(() => {
    actions["functions/files:listFiles"] = async (args: never) =>
      LISTINGS[(args as { path: string }).path] ?? listing((args as { path: string }).path, []);
    actions["functions/files:readNote"] = async (args: never) => {
      const { path } = args as { path: string };
      if (path !== `${GROUP}/gear-swap.md`) throw new ConvexError({ code: "FILE_NOT_FOUND", message: "That file does not exist." });
      return { path, text: "# Gear swap\n", etag: "e1", visibility: "team", inherited: "team", exception: false, readOnly: false };
    };
    function Probe() {
      browser = useFileBrowser({ workspaceId: "w1", tier: "team", canEdit: true });
      return null;
    }
    render(createElement(Probe));
  });

  test("is the not-found state, with no notice line, and clears on the next open", async () => {
    await settle();
    await act(async () => {
      browser.select(ASKED);
    });
    await settle();
    expect(browser.notFound).toBe(ASKED);
    expect(browser.notice).toBeNull();
    expect(browser.opening).toBeNull();
    expect(browser.editor.path).toBeNull();

    await act(async () => {
      browser.select(`${GROUP}/gear-swap.md`);
    });
    await settle();
    expect(browser.notFound).toBeNull();
    expect(browser.editor.path).toBe(`${GROUP}/gear-swap.md`);
  });

  test("any other refusal is still the notice it always was", async () => {
    actions["functions/files:readNote"] = async () => {
      throw new ConvexError({ code: "NOT_AUTHORIZED", message: "You can't open that." });
    };
    await settle();
    await act(async () => {
      browser.select(ASKED);
    });
    await settle();
    expect(browser.notFound).toBeNull();
    expect(browser.notice).toBe("You can't open that.");
  });
});

/* -------------------------------- the page ------------------------------- */

describe("the page", () => {
  const byId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  // Names are drawn inside bidi isolation marks (`isolateForDisplay`); the words are what is checked.
  const words = (id: string) => byId(id)!.textContent!.replace(/[\u2066-\u2069]/g, "");

  function page(overrides: Partial<Parameters<typeof NotFoundNote>[0]> = {}) {
    const calls = { opened: [] as string[], searched: [] as string[], back: 0, ensured: [] as string[] };
    render(
      createElement(NotFoundNote, {
        path: ASKED,
        workspace: "@supa",
        rootLabel: "Supa",
        listings: LISTINGS,
        ensureListing: (path: string) => calls.ensured.push(path),
        compact: false,
        onOpen: (path: string) => calls.opened.push(path),
        onSearch: (words: string) => calls.searched.push(words),
        onBack: () => (calls.back += 1),
        ...overrides,
      }),
    );
    return calls;
  }

  test("one message, the address asked for, and no skeleton", () => {
    page();
    const text = byId("note-not-found")!.textContent!;
    expect(text).toContain(NOT_FOUND_TITLE);
    expect(text).toContain(NOT_FOUND_BODY);
    expect(byId("note-not-found-address")!.textContent).toBe(`@supa${GROUP}/last-7-days.page.md`);
    expect(document.querySelector('[role="progressbar"]')).toBeNull();
    // The old words are gone, and the copy never claims the note does not exist.
    expect(text).not.toMatch(/does not exist|file|bucket|—/i);
  });

  test("the similar notes open, and so do search, the folder and back", () => {
    const calls = page();
    expect(byId("note-not-found-similar")!.children).toHaveLength(3);
    act(() => byId("note-not-found-similar-0")!.click());
    expect(calls.opened).toEqual([`${GROUP}/last-7-days-oct-27-to-nov-2.page.md`]);
    act(() => byId("note-not-found-search")!.click());
    expect(calls.searched).toEqual(["last 7 days"]);
    act(() => byId("note-not-found-folder")!.click());
    expect(calls.opened.at(-1)).toBe(GROUP);
    expect(words("note-not-found-folder")).toBe("Open kite-willow-rocket");
    act(() => byId("note-not-found-back")!.click());
    expect(calls.back).toBe(1);
  });

  test("nothing similar: no list, and the root is named for the workspace", () => {
    page({ path: "nowhere/budget.md" });
    expect(byId("note-not-found-similar")).toBeNull();
    expect(words("note-not-found-folder")).toBe("Open Supa");
  });

  test("the nearest folder's notes are asked for when the tree has not listed them", () => {
    const { [GROUP]: _left, ...rest } = LISTINGS;
    const calls = page({ listings: rest });
    expect(calls.ensured).toEqual([GROUP]);
  });

  test("a phone has no Go back: its ‹ is already at the top", () => {
    page({ compact: true, onBack: undefined });
    expect(byId("note-not-found-back")).toBeNull();
    expect(byId("note-not-found-search")).not.toBeNull();
  });
});
