/**
 * @jest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing } from "../features/console/files/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/**
 * WHICH CONTEXTS THE CONSOLE OFFERS AS A DESTINATION, AND WHAT PRESSING MOVE
 * SENDS.
 *
 * The dialog draws whatever `moveDestinations` holds and asks nothing else, so
 * this list is the whole of the client-side gate — and it has to agree with the
 * server's rule in `functions/contextMoves.ts`, which is two halves:
 *
 *  - **`owner` on the context it is leaving.** Moving something out removes it
 *    from everybody who could read it there. An `editor` invited to help with
 *    one project does not get to make that call, and offering them the control
 *    would be offering a press that is always refused.
 *  - **`editor` or better on the one it is going to**, which the console
 *    applies where the list of contexts lives (`useLiveConsoleData`) — so what
 *    is asserted here is that this hook does not *widen* what it was handed.
 *
 * Plus the one thing that is this hook's alone: **this context is never in its
 * own destination list.** The server refuses a same-context move outright,
 * because `files.moveEntry` does that and also rewrites every link, so an offer
 * of it here would be a slower move that silently breaks references.
 */

const actions: Record<string, (args: never) => Promise<unknown>> = {};
const bound: Record<string, (args: never) => Promise<unknown>> = {};
const calls: { name: string; args: unknown }[] = [];
/** `mock`-prefixed so `jest.mock`'s factory may reach it — see its guard. */
const mockQueried: { name: string; args: unknown }[] = [];

jest.mock("convex/react", () => {
  const { getFunctionName } = require("convex/server") as typeof import("convex/server");
  const record = (ref: never) => {
    const name = getFunctionName(ref);
    bound[name] ??= (args: never) => {
      calls.push({ name, args });
      return actions[name]!(args);
    };
    return bound[name];
  };
  return {
    useAction: record,
    useMutation: record,
    useQuery: (ref: never, args: unknown) => {
      mockQueried.push({ name: getFunctionName(ref), args });
      return undefined;
    },
  };
});

import { useFileBrowser } from "../features/console/files/useFileBrowser";

const HERE = "w-here";
const WORK = { id: "w-work", label: "@work", displayName: "Work" };
const SELF = { id: HERE, label: "@here", displayName: "Here" };

const ROOT: FolderListing = {
  path: "",
  folderDefault: "private",
  entries: [
    {
      kind: "file",
      path: "note.md",
      name: "note.md",
      visibility: "private",
      inherited: "private",
      exception: false,
      readOnly: false,
    },
  ],
  truncated: false,
  manifestUsable: true,
};

function name(module: string, fn: string): string {
  return `functions/${module}:${fn}`;
}

let browser: FileBrowser;
let unmount: () => void;

function mount(options: {
  isOwner?: boolean;
  destinations?: readonly { id: string; label: string; displayName: string }[];
}): void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  function Probe() {
    browser = useFileBrowser({
      workspaceId: HERE,
      canEdit: true,
      tier: "private",
      ...options,
    });
    return null;
  }
  act(() => root.render(createElement(Probe)));
  unmount = () => {
    act(() => root.unmount());
    container.remove();
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
  });
}

beforeEach(() => {
  calls.length = 0;
  mockQueried.length = 0;
  window.localStorage.clear();
  actions[name("files", "listFiles")] = async () => ROOT;
  actions[name("files", "notePaths")] = async () => ({ kind: "notePaths", paths: [] });
  actions[name("files", "folderPaths")] = async () => ({
    kind: "folderPaths",
    folders: ["clients"],
    truncated: false,
  });
  actions[name("contextMoves", "startContextMove")] = async () => ({ moveId: "mv1" });
});

afterEach(() => {
  unmount?.();
});

describe("the contexts offered as a destination", () => {
  test("an owner is offered the ones they were handed", async () => {
    mount({ isOwner: true, destinations: [WORK] });
    await settle();
    expect(browser.moveDestinations).toEqual([WORK]);
  });

  test("an editor of this context is offered none", async () => {
    // Not a disabled control and not a refusal after the press: the row of
    // contexts simply is not drawn. Same rule as every other owner-only control
    // in this console — see the header of `menu.ts`.
    mount({ isOwner: false, destinations: [WORK] });
    await settle();
    expect(browser.moveDestinations).toEqual([]);
  });

  test("this context is not one of its own destinations", async () => {
    mount({ isOwner: true, destinations: [SELF, WORK] });
    await settle();
    expect(browser.moveDestinations).toEqual([WORK]);
  });

  test("an owner with nowhere to send anything is offered nothing", async () => {
    mount({ isOwner: true });
    await settle();
    expect(browser.moveDestinations).toEqual([]);
  });
});

describe("starting one", () => {
  test("it sends both ends, with the note's own name at the far end", async () => {
    mount({ isOwner: true, destinations: [WORK] });
    await settle();

    act(() => browser.moveToContext("1-projects/note.md", "w-work", "clients"));
    await settle();

    expect(calls.filter((call) => call.name === name("contextMoves", "startContextMove"))).toEqual([
      {
        name: name("contextMoves", "startContextMove"),
        args: {
          sourceWorkspaceId: HERE,
          from: "1-projects/note.md",
          destinationWorkspaceId: "w-work",
          to: "clients/note.md",
        },
      },
    ]);
  });

  test("a destination that was not offered is refused here, not sent", async () => {
    mount({ isOwner: false, destinations: [WORK] });
    await settle();

    act(() => browser.moveToContext("note.md", "w-work", "clients"));
    await settle();

    /*
      The server refuses this too — an editor is not an owner — and that is the
      guard that matters. This is the second one, and it is worth having
      because the failure it prevents is silent: a caller that reached the
      action with a context the console never offered would be a control
      appearing somewhere nobody audited, and the only sign of it would be a
      refusal a person cannot explain.
    */
    expect(calls.some((call) => call.name === name("contextMoves", "startContextMove"))).toBe(
      false,
    );
    expect(browser.notice).toContain("a context you can write to");
  });

  test("the folders of another context are read from that context", async () => {
    mount({ isOwner: true, destinations: [WORK] });
    await settle();

    const answer = await browser.destinationFolders("w-work");

    expect(answer).toEqual({ folders: ["clients"], truncated: false });
    expect(calls.filter((call) => call.name === name("files", "folderPaths"))).toEqual([
      { name: name("files", "folderPaths"), args: { workspaceId: "w-work" } },
    ]);
  });
});

describe("watching them", () => {
  test("only an owner subscribes, because only an owner may", async () => {
    mount({ isOwner: false, destinations: [WORK] });
    await settle();
    const asEditor = mockQueried.filter(
      (call) => call.name === name("contextMoves", "listContextMoves"),
    );
    // `"skip"` rather than absent: the hook is called unconditionally, as hooks
    // must be, and refuses to ask. A query that would be refused is a permanent
    // error on every paint.
    expect(asEditor.every((call) => call.args === "skip")).toBe(true);

    unmount();
    mount({ isOwner: true, destinations: [WORK] });
    await settle();
    expect(
      mockQueried.some(
        (call) =>
          call.name === name("contextMoves", "listContextMoves") &&
          JSON.stringify(call.args) === JSON.stringify({ workspaceId: HERE }),
      ),
    ).toBe(true);
  });
});
