/**
 * @jest-environment jsdom
 */

/**
 * Dragging a folder in the sidebar, from the row's drop to the server:
 * `useTreeDrag` turns where the pointer was into `files.placeFolder`, and
 * `useFolderJobs.placeFolder` draws the order at once and sends it to
 * `folderOrder.set`, moving the folder first when it came from another level.
 *
 * What must hold: an order is never sent for a folder whose move did not
 * land (it would name a folder the server has not got there), a refusal of
 * the order is said and the server's order is fetched back, a viewer gets no
 * drag at all, and a refused drop says why instead of springing back.
 *
 * SABOTAGE (applied, run, reverted): sending the order without waiting for
 * `move` fails "from another level, the order waits for the move".
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { FileBrowser } from "../features/console/files/browser";
import type { FileBrowserOptions, Listings } from "../features/console/files/fileBrowser/types";
import { useFolderJobs, type FolderJobsValues } from "../features/console/files/fileBrowser/useFolderJobs";
import { useTreeDrag } from "../features/console/files/explorer/useTreeDrag";
import { WEBSITE_DETAIL } from "../features/console/files/menuBuiltIn";
import { NO_PICK } from "../features/console/files/selection";
import type { FileEntry, FolderListing } from "../features/console/files/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mockCalls: { name: string; args: unknown }[] = [];
let mockOrderAnswer: () => Promise<unknown> = async () => null;

jest.mock("convex/react", () => {
  const { getFunctionName } = require("convex/server") as typeof import("convex/server");
  return {
    useAction: (ref: never) => (args: unknown) => {
      mockCalls.push({ name: getFunctionName(ref), args });
      return mockOrderAnswer();
    },
    useMutation: () => async () => null,
    useQuery: () => undefined,
  };
});

function folder(path: string, over: Partial<FileEntry> = {}): FileEntry {
  return {
    kind: "folder",
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
    ...over,
  };
}
function listing(path: string, entries: FileEntry[]): FolderListing {
  return { path, folderDefault: "private", entries, truncated: false, manifestUsable: true };
}

const LISTINGS: Listings = {
  "": listing("", [folder("Capture", { role: "inbox" }), folder("Projects", { role: "projects" }), folder("website", { role: "website" }), folder("Recipes")]),
  Projects: listing("Projects", [folder("Projects/alpha"), folder("Projects/beta")]),
};

const live: Array<() => void> = [];
afterEach(() => {
  while (live.length > 0) live.pop()!();
});
beforeEach(() => {
  mockCalls.length = 0;
  mockOrderAnswer = async () => null;
});

function mount(render: () => void) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  function Probe() {
    render();
    return null;
  }
  act(() => root.render(createElement(Probe)));
  live.push(() => {
    act(() => root.unmount());
    container.remove();
  });
}

const flush = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

describe("useFolderJobs.placeFolder", () => {
  function jobs(move: (path: string, to: string) => Promise<boolean>) {
    const said: string[] = [];
    const refreshed: string[][] = [];
    const drawn: Listings[] = [];
    let api!: FolderJobsValues;
    mount(() => {
      api = useFolderJobs({
        options: { canEdit: true, workspaceId: "w1" } as unknown as FileBrowserOptions,
        listings: LISTINGS,
        iconOf: () => null,
        drawLocally: (change) => drawn.push(change(LISTINGS)),
        refresh: async (folders) => {
          refreshed.push([...folders]);
        },
        say: (message) => said.push(message),
        move,
      });
    });
    return { api: () => api, said, refreshed, drawn };
  }

  test("in its own level: drawn at once and sent as one order", async () => {
    const move = jest.fn(async () => true);
    const probe = jobs(move);
    act(() => probe.api().placeFolder("Recipes", "", ["Capture", "Recipes", "Projects", "website"]));
    await flush();
    expect(move).not.toHaveBeenCalled();
    expect(mockCalls).toEqual([
      { name: "functions/folderOrder:set", args: { workspaceId: "w1", parent: "", folders: ["Capture", "Recipes", "Projects", "website"] } },
    ]);
    expect(probe.drawn[0]![""]!.entries.map((entry) => entry.path)).toEqual(["Capture", "Recipes", "Projects", "website"]);
  });

  test("from another level, the order waits for the move", async () => {
    let land!: (ok: boolean) => void;
    const move = jest.fn(() => new Promise<boolean>((resolve) => (land = resolve)));
    const probe = jobs(move);
    act(() => probe.api().placeFolder("Recipes", "Projects", ["Projects/alpha", "Projects/Recipes", "Projects/beta"]));
    expect(move).toHaveBeenCalledWith("Recipes", "Projects");
    expect(mockCalls).toEqual([]);
    land(true);
    await flush();
    expect(mockCalls).toEqual([
      {
        name: "functions/folderOrder:set",
        args: { workspaceId: "w1", parent: "Projects", folders: ["Projects/alpha", "Projects/Recipes", "Projects/beta"] },
      },
    ]);
  });

  test("a move that did not land (refused, or queued offline) sends no order", async () => {
    const probe = jobs(async () => false);
    act(() => probe.api().placeFolder("Capture", "Projects", ["Projects/Capture", "Projects/alpha", "Projects/beta"]));
    await flush();
    expect(mockCalls).toEqual([]);
  });

  test("a refused order is said, and the server's order fetched back", async () => {
    mockOrderAnswer = async () => {
      throw new Error("You can't change that here.");
    };
    const probe = jobs(async () => true);
    act(() => probe.api().placeFolder("Recipes", "", ["Recipes", "Capture", "Projects", "website"]));
    await flush();
    expect(probe.said.length).toBe(1);
    expect(probe.refreshed).toEqual([[""]]);
  });
});

describe("useTreeDrag", () => {
  function drag(canEdit = true) {
    const placed: unknown[][] = [];
    const refused: string[] = [];
    const moved: unknown[][] = [];
    const files = {
      canEdit,
      listings: LISTINGS,
      expanded: new Set<string>(),
      placeFolder: (...args: unknown[]) => placed.push(args),
      move: (...args: unknown[]) => moved.push(args),
      moveMany: () => undefined,
      copyTo: () => undefined,
      copyManyTo: () => undefined,
    } as unknown as FileBrowser;
    let value!: ReturnType<typeof useTreeDrag>;
    mount(() => {
      value = useTreeDrag({
        files,
        descending: false,
        contextLabel: "@seyi",
        pickedRows: [],
        shown: { paths: new Set() },
        setPicked: () => NO_PICK,
        refuse: (reason) => refused.push(reason),
      });
    });
    return { value: () => value, placed, refused, moved };
  }

  test("a viewer has nothing to drag", () => {
    expect(drag(false).value().dragHandlers).toBeUndefined();
  });

  test("the top edge of a sibling draws a line there, and dropping reorders", () => {
    const probe = drag();
    act(() => probe.value().dragHandlers!.onDragStart("Recipes"));
    act(() => probe.value().dragHandlers!.onDragOver("Projects", [], 0.1));
    expect(probe.value().dropTarget).toEqual({ path: "Projects", zone: "above" });
    act(() => probe.value().dragHandlers!.onDrop("Projects", [], 0.1));
    expect(probe.placed).toEqual([["Recipes", "", ["Capture", "Recipes", "Projects", "website"]]]);
    expect(probe.value().dropTarget).toBeNull();
  });

  test("the middle of a folder still nests, through the existing move", () => {
    const probe = drag();
    act(() => probe.value().dragHandlers!.onDragStart("Recipes"));
    act(() => probe.value().dragHandlers!.onDragOver("Projects", [], 0.5));
    expect(probe.value().dropTarget).toEqual({ path: "Projects", zone: "into" });
    act(() => probe.value().dragHandlers!.onDrop("Projects", [], 0.5));
    expect(probe.moved).toEqual([["Recipes", "Projects"]]);
    expect(probe.placed).toEqual([]);
  });

  test("Website over another level draws nothing, and the drop says why", () => {
    const probe = drag();
    act(() => probe.value().dragHandlers!.onDragStart("website"));
    act(() => probe.value().dragHandlers!.onDragOver("Projects/alpha", [], 0.9));
    expect(probe.value().dropTarget).toBeNull();
    act(() => probe.value().dragHandlers!.onDrop("Projects/alpha", [], 0.9));
    expect(probe.refused).toEqual([WEBSITE_DETAIL]);
    expect(probe.placed).toEqual([]);
    expect(probe.moved).toEqual([]);
  });

  test("a folder dropped between its own children is refused out loud", () => {
    const probe = drag();
    act(() => probe.value().dragHandlers!.onDragStart("Projects"));
    act(() => probe.value().dragHandlers!.onDrop("Projects/beta", [], 0.1));
    expect(probe.refused).toEqual(["A folder cannot be moved inside itself."]);
    expect(probe.placed).toEqual([]);
  });
});
