/**
 * @jest-environment jsdom
 */

/**
 * The tree repaints on the press, not on the reply.
 *
 * `optimisticStructure.test.ts` holds the arithmetic; this holds the wiring,
 * which is where the complaint actually lived. Renaming or moving a folder used
 * to be: await `moveEntry`, then await a `listFiles` for each folder touched,
 * and only then change a pixel. Two serial round trips of a picture that is
 * already wrong — and for a folder the subtree then *collapsed*, because every
 * listing under it was still keyed at a path the bucket no longer had and
 * `expanded` still named those paths too.
 *
 * So each test here holds the mutation open — the action never resolves until
 * the test lets it — and asserts on what is on screen while it is in flight.
 * A version of this that awaited the operation first would pass against the
 * old code, which is exactly the assertion that is worth nothing.
 */

import { afterEach, beforeEach, describe, expect, jest, test } from "@jest/globals";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { ConvexError } from "convex/values";
import type { FileBrowser } from "../features/console/files/browser";
import type { FolderListing } from "../features/console/files/types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const actions: Record<string, (args: never) => Promise<unknown>> = {};
const bound: Record<string, (args: never) => Promise<unknown>> = {};

jest.mock("convex/react", () => {
  const { getFunctionName } = require("convex/server") as typeof import("convex/server");
  return {
    useAction: (ref: never) => {
      const name = getFunctionName(ref);
      bound[name] ??= (args: never) => actions[name]!(args);
      return bound[name];
    },
    useQuery: () => undefined,
    useMutation: () => async () => undefined,
  };
});

import { useFileBrowser } from "../features/console/files/useFileBrowser";

const WORKSPACE = "w1";

function name(fn: string): string {
  return `functions/files:${fn}`;
}

/* -------------------------------------------------------------------------- */
/*                            the bucket, as fixtures                          */
/* -------------------------------------------------------------------------- */

function entryOf(path: string, kind: "file" | "folder") {
  return {
    kind,
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    visibility: "private" as const,
    inherited: "private" as const,
    exception: false,
    readOnly: false,
  };
}

function listingOf(path: string, children: readonly [string, "file" | "folder"][]): FolderListing {
  return {
    path,
    folderDefault: "private",
    entries: children.map(([child, kind]) => entryOf(child, kind)),
    truncated: false,
    manifestUsable: true,
  };
}

/**
 * `1-projects/foo/deep/b.md`, every folder of it listable.
 *
 * Deep on purpose: two levels under the folder being moved is what makes
 * "the subtree travels" a different statement from "the row moved".
 */
const BUCKET: Record<string, FolderListing> = {
  "": listingOf("", [
    ["1-projects", "folder"],
    ["2-areas", "folder"],
  ]),
  "1-projects": listingOf("1-projects", [["1-projects/foo", "folder"]]),
  "2-areas": listingOf("2-areas", []),
  "1-projects/foo": listingOf("1-projects/foo", [
    ["1-projects/foo/deep", "folder"],
    ["1-projects/foo/a.md", "file"],
  ]),
  "1-projects/foo/deep": listingOf("1-projects/foo/deep", [["1-projects/foo/deep/b.md", "file"]]),
};

let browser: FileBrowser;

function mount(): () => void {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  function Probe() {
    browser = useFileBrowser({ workspaceId: WORKSPACE, canEdit: true, tier: "private" });
    return null;
  }
  act(() => {
    root.render(createElement(Probe));
  });
  return () => {
    act(() => root.unmount());
    container.remove();
  };
}

async function settle() {
  for (let turn = 0; turn < 6; turn += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

const pathsIn = (listing: FolderListing | undefined): string[] =>
  (listing?.entries ?? []).map((one) => one.path);

/** Open the whole fixture, so there is a subtree to lose. */
async function openTree() {
  for (const folder of ["1-projects", "1-projects/foo", "1-projects/foo/deep"]) {
    await act(async () => {
      browser.toggleFolder(folder);
    });
    await settle();
  }
}

let unmount: (() => void) | null = null;

beforeEach(async () => {
  window.localStorage.clear();
  actions[name("listFiles")] = async (args: never) => {
    const { path } = args as unknown as { path: string };
    const page = BUCKET[path];
    if (page === undefined) throw new ConvexError({ code: "FILE_NOT_FOUND", message: "Gone." });
    return page;
  };
  actions[name("moveEntry")] = async () => ({});
});

afterEach(() => {
  unmount?.();
  unmount = null;
});

/* -------------------------------------------------------------------------- */

describe("a folder rename, while the mutation is still in flight", () => {
  test("the row is already at its new name", async () => {
    unmount = mount();
    await settle();
    await openTree();

    let release = () => {};
    actions[name("moveEntry")] = () => new Promise<never>((resolve) => {
      release = resolve as () => void;
    });

    await act(async () => {
      browser.rename("1-projects/foo", "bar");
    });

    expect(pathsIn(browser.listings["1-projects"])).toEqual(["1-projects/bar"]);
    release();
    await settle();
  });

  test("the subtree travels with it, still expanded, with nothing refetched to show it", async () => {
    unmount = mount();
    await settle();
    await openTree();

    let release = () => {};
    actions[name("moveEntry")] = () => new Promise<never>((resolve) => {
      release = resolve as () => void;
    });

    await act(async () => {
      browser.rename("1-projects/foo", "bar");
    });

    expect(pathsIn(browser.listings["1-projects/bar"])).toEqual([
      "1-projects/bar/deep",
      "1-projects/bar/a.md",
    ]);
    expect(pathsIn(browser.listings["1-projects/bar/deep"])).toEqual(["1-projects/bar/deep/b.md"]);
    expect(browser.listings["1-projects/foo"]).toBeUndefined();
    // The whole of "the tree does not collapse": `expanded` names paths.
    expect([...browser.expanded]).toContain("1-projects/bar");
    expect([...browser.expanded]).toContain("1-projects/bar/deep");
    expect([...browser.expanded]).not.toContain("1-projects/foo");
    release();
    await settle();
  });

  test("a refusal puts it back, and says why", async () => {
    unmount = mount();
    await settle();
    await openTree();

    actions[name("moveEntry")] = async () => {
      throw new ConvexError({ code: "DESTINATION_EXISTS", message: "Something is already there." });
    };

    await act(async () => {
      browser.rename("1-projects/foo", "bar");
    });
    await settle();

    expect(pathsIn(browser.listings["1-projects"])).toEqual(["1-projects/foo"]);
    expect(pathsIn(browser.listings["1-projects/foo"])).toEqual([
      "1-projects/foo/deep",
      "1-projects/foo/a.md",
    ]);
    expect(browser.listings["1-projects/bar"]).toBeUndefined();
    expect([...browser.expanded]).toContain("1-projects/foo");
    expect(browser.notice).toBe("Something is already there.");
  });
});

describe("a folder move into another folder", () => {
  test("lands there immediately, subtree and all", async () => {
    unmount = mount();
    await settle();
    await openTree();
    await act(async () => {
      browser.toggleFolder("2-areas");
    });
    await settle();

    let release = () => {};
    actions[name("moveEntry")] = () => new Promise<never>((resolve) => {
      release = resolve as () => void;
    });

    await act(async () => {
      browser.move("1-projects/foo", "2-areas");
    });

    expect(pathsIn(browser.listings["2-areas"])).toEqual(["2-areas/foo"]);
    expect(pathsIn(browser.listings["1-projects"])).toEqual([]);
    expect(pathsIn(browser.listings["2-areas/foo/deep"])).toEqual(["2-areas/foo/deep/b.md"]);
    release();
    await settle();
  });

  test("the whole re-keyed subtree is reloaded, because privacy.md is keyed by path", async () => {
    // The listings carried across are the ones the server last stated for the
    // OLD path. A folder's default is a rule about where it is, so the console
    // may paint the old visibility for a moment and must not keep it.
    unmount = mount();
    await settle();
    await openTree();
    await act(async () => {
      browser.toggleFolder("2-areas");
    });
    await settle();

    const asked: string[] = [];
    actions[name("listFiles")] = async (args: never) => {
      const { path } = args as unknown as { path: string };
      asked.push(path);
      const at = path.startsWith("2-areas/foo")
        ? `1-projects/foo${path.slice("2-areas/foo".length)}`
        : path;
      const page = BUCKET[at];
      if (page === undefined) throw new ConvexError({ code: "FILE_NOT_FOUND", message: "Gone." });
      return { ...page, path };
    };

    await act(async () => {
      browser.move("1-projects/foo", "2-areas");
    });
    await settle();

    expect(asked).toContain("2-areas/foo");
    expect(asked).toContain("2-areas/foo/deep");
  });
});

describe("undoing a move", () => {
  test("puts it back and reloads the subtree, which the move's own cascade did", () => {
    /*
      The verdict for a cascade has to be taken BEFORE the drawing re-keys the
      paths, and the undo is where that was wrong: `moveResult` asked what was
      loaded under the source *after* `drawMove` had already moved it, found
      nothing, and skipped the cascade — so a folder moved back kept its
      contents drawn with the visibility the destination had given them.
    */
    return (async () => {
      unmount = mount();
      await settle();
      await openTree();
      await act(async () => {
        browser.toggleFolder("2-areas");
      });
      await settle();

      const everywhere = async (args: never) => {
        const { path } = args as unknown as { path: string };
        const at = path.startsWith("2-areas/foo")
          ? `1-projects/foo${path.slice("2-areas/foo".length)}`
          : path;
        const page = BUCKET[at];
        if (page === undefined) throw new ConvexError({ code: "FILE_NOT_FOUND", message: "Gone." });
        return { ...page, path };
      };
      actions[name("listFiles")] = everywhere;

      await act(async () => {
        browser.move("1-projects/foo", "2-areas");
      });
      await settle();

      const asked: string[] = [];
      actions[name("listFiles")] = async (args: never) => {
        asked.push((args as unknown as { path: string }).path);
        return everywhere(args);
      };

      const undo = browser.toasts[0]?.undo;
      expect(undo).toBeDefined();
      await act(async () => {
        undo!();
      });
      await settle();

      expect(pathsIn(browser.listings["1-projects"])).toEqual(["1-projects/foo"]);
      expect(asked).toContain("1-projects/foo");
      expect(asked).toContain("1-projects/foo/deep");
    })();
  });
});

describe("a console that cannot edit", () => {
  test("draws nothing, rather than a row that will never be written", () => {
    /*
      A read-only console keeps all fourteen mutating methods — `menu.ts` opens
      by saying so, and `useDemoFileBrowser` sets each of them to a no-op — so
      a call that slips past `canEdit` reaches `run` rather than throwing.
      Before, that was a silent no-op; with a drawing in front of it, it would
      leave the row sitting at a path nothing will ever write.
    */
    return (async () => {
      const container = document.createElement("div");
      document.body.appendChild(container);
      const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
      function Probe() {
        browser = useFileBrowser({ workspaceId: WORKSPACE, canEdit: false, tier: "private" });
        return null;
      }
      act(() => {
        root.render(createElement(Probe));
      });
      unmount = () => {
        act(() => root.unmount());
        container.remove();
      };
      await settle();
      await act(async () => {
        browser.toggleFolder("1-projects");
      });
      await settle();

      await act(async () => {
        browser.rename("1-projects/foo", "bar");
      });
      await settle();

      expect(pathsIn(browser.listings["1-projects"])).toEqual(["1-projects/foo"]);
      expect(browser.listings["1-projects/bar"]).toBeUndefined();
    })();
  });
});

describe("a new folder", () => {
  test("is drawn before createDirectory answers, and taken back if it refuses", async () => {
    unmount = mount();
    await settle();
    await act(async () => {
      browser.toggleFolder("1-projects");
    });
    await settle();

    let release = () => {};
    actions[name("createDirectory")] = () => new Promise<never>((resolve) => {
      release = resolve as () => void;
    });

    await act(async () => {
      browser.createFolder("1-projects", "new");
    });
    expect(pathsIn(browser.listings["1-projects"])).toContain("1-projects/new");
    expect(browser.listings["1-projects/new"]?.entries).toEqual([]);
    release();
    await settle();
  });

  test("a refused creation leaves no folder behind", async () => {
    unmount = mount();
    await settle();
    await act(async () => {
      browser.toggleFolder("1-projects");
    });
    await settle();

    actions[name("createDirectory")] = async () => {
      throw new ConvexError({ code: "DESTINATION_EXISTS", message: "Already there." });
    };

    await act(async () => {
      browser.createFolder("1-projects", "new");
    });
    await settle();

    expect(pathsIn(browser.listings["1-projects"])).not.toContain("1-projects/new");
    expect(browser.listings["1-projects/new"]).toBeUndefined();
    expect(browser.notice).toBe("Already there.");
  });
});
