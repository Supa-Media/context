/**
 * What a menu item does, without a renderer.
 *
 * `files/actions.ts` was a `switch` inside `Explorer.tsx`, which is why the
 * tree was the only surface in the console where a right-click did anything.
 * Pulled out, the dispatch is checkable on its own — and the checks that matter
 * are the ones a reader of the `switch` cannot make by reading it:
 *
 *  - **where a creation lands**, which is the folder itself on a folder and the
 *    *parent* on a note, and is the pair a second surface would have got wrong;
 *  - **that a selection dispatches nothing**, rather than quietly acting on its
 *    first row;
 *  - **that a surface missing a capability degrades**, rather than throwing.
 */

import { describe, expect, test } from "@jest/globals";
import {
  actionTargetOf,
  runMenuAction,
  type ActionContext,
  type Dialog,
} from "../features/console/files/actions";
import type { MenuActionId, MenuTarget } from "../features/console/files/menu";
import type { FileBrowser } from "../features/console/files/browser";
import type { TreeRow } from "../features/console/files/tree";
import type { Visibility } from "../features/console/files/types";
import { displayName } from "../features/console/files/paths";

/* -------------------------------------------------------------------------- */
/*                                  fixtures                                  */
/* -------------------------------------------------------------------------- */

function row(kind: TreeRow["kind"], path: string, over: Partial<TreeRow> = {}): TreeRow {
  return {
    kind,
    key: path,
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    label: displayName(path.slice(path.lastIndexOf("/") + 1)),
    depth: 0,
    expanded: false,
    selected: false,
    markerIsDefault: kind === "folder",
    readOnly: false,
    ...over,
  };
}
const note = (path: string) => row("file", path);
const dir = (path: string) => row("folder", path);

interface Call {
  name: string;
  args: unknown[];
}

/** A `FileBrowser` that records rather than acts. */
function stubBrowser(calls: Call[]): FileBrowser {
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push({ name, args });
    };
  // Only the mutating surface this dispatcher reaches is filled in; the rest is
  // cast, because a full literal would be forty members of noise and would go
  // stale on every unrelated addition to the interface.
  return {
    destroy: record("destroy"),
    duplicate: record("duplicate"),
    copy: record("copy"),
    cut: record("cut"),
    paste: record("paste"),
    move: record("move"),
    setVisibility: record("setVisibility"),
  } as unknown as FileBrowser;
}

function harness(over: Partial<ActionContext> = {}) {
  const calls: Call[] = [];
  const dialogs: Dialog[] = [];
  const opened: string[] = [];
  const pinned: string[] = [];
  const revealed: string[] = [];
  const copied: string[] = [];
  const context: ActionContext = {
    files: stubBrowser(calls),
    contextLabel: "@seyi",
    select: (path) => opened.push(path),
    setDialog: (dialog) => dialogs.push(dialog),
    writeClipboard: (text) => copied.push(text),
    openPinned: (path) => pinned.push(path),
    reveal: (path) => revealed.push(path),
    inheritedOf: () => "team",
    ...over,
  };
  const run = (id: MenuActionId, target: MenuTarget) => runMenuAction(id, target, context);
  return { run, calls, dialogs, opened, pinned, revealed, copied, context };
}

const onRow = (r: TreeRow): MenuTarget => ({ kind: "row", row: r });

/* -------------------------------------------------------------------------- */

describe("where a creation lands", () => {
  /**
   * The pair that a second surface would have got wrong, and the reason
   * `actionTargetOf` exists rather than each caller working it out.
   */
  test("a folder row creates inside itself", () => {
    const h = harness();
    h.run("newNote", onRow(dir("1-projects")));
    expect(h.dialogs).toEqual([{ kind: "newNote", folder: "1-projects" }]);
  });

  test("a note row creates beside itself, in its parent", () => {
    const h = harness();
    h.run("newFolder", onRow(note("1-projects/plan.md")));
    expect(h.dialogs).toEqual([{ kind: "newFolder", folder: "1-projects" }]);
  });

  test("a note at the root creates at the root", () => {
    const h = harness();
    h.run("newNote", onRow(note("index.md")));
    expect(h.dialogs).toEqual([{ kind: "newNote", folder: "" }]);
  });

  test("empty space creates in the folder it is the space of", () => {
    const h = harness();
    h.run("newDrawing", { kind: "background", folder: "2-areas" });
    expect(h.dialogs).toEqual([{ kind: "newDrawing", folder: "2-areas" }]);
  });

  test("a breadcrumb creates inside the folder it names", () => {
    const h = harness();
    h.run("newNote", { kind: "crumb", folder: "2-areas/health" });
    expect(h.dialogs).toEqual([{ kind: "newNote", folder: "2-areas/health" }]);
  });

  test("and pasting lands in the same folder a creation would", () => {
    const h = harness();
    h.run("paste", onRow(note("1-projects/plan.md")));
    expect(h.calls).toEqual([{ name: "paste", args: ["1-projects"] }]);
  });
});

describe("a selection dispatches nothing at all", () => {
  /**
   * `menu.ts` models the plural menu; nothing opens one yet. Acting on the
   * first row would be an "Archive 3 items" that archives one — the partial
   * success this menu was written to avoid — so it declines instead.
   */
  const selection: MenuTarget = {
    kind: "selection",
    rows: [note("a.md"), note("b.md"), note("c.md")],
  };

  test("no browser call, no dialog, nothing opened", () => {
    const h = harness();
    for (const id of ["delete", "archive", "copy", "open", "moveTo"] as MenuActionId[]) {
      h.run(id, selection);
    }
    expect(h.calls).toEqual([]);
    expect(h.dialogs).toEqual([]);
    expect(h.opened).toEqual([]);
  });

  test("and it is the target resolver that says so, once", () => {
    expect(actionTargetOf(selection)).toBeNull();
  });
});

describe("reveal puts the tree on a folder rather than opening it again", () => {
  /**
   * The breadcrumb's own verb. You are already *in* the folder — that is why
   * you are standing on its crumb — so this is not an alias for `open`: it
   * expands the ancestors and selects the row, which is where the folder's full
   * set of verbs lives.
   */
  test("it reveals and does not open", () => {
    const h = harness();
    h.run("revealInTree", { kind: "crumb", folder: "2-areas/health" });
    expect(h.revealed).toEqual(["2-areas/health"]);
    expect(h.opened).toEqual([]);
  });

  test("and open still opens", () => {
    const h = harness();
    h.run("open", { kind: "crumb", folder: "2-areas/health" });
    expect(h.opened).toEqual(["2-areas/health"]);
    expect(h.revealed).toEqual([]);
  });
});

describe("a surface without a capability degrades rather than throwing", () => {
  test("no tabs: open in new tab falls back to a plain open", () => {
    const h = harness({ openPinned: undefined });
    h.run("openInNewTab", onRow(note("1-projects/plan.md")));
    expect(h.opened).toEqual(["1-projects/plan.md"]);
  });

  test("no tree: reveal does nothing, quietly", () => {
    const h = harness({ reveal: undefined });
    expect(() => h.run("revealInTree", onRow(note("a.md")))).not.toThrow();
  });

});

describe("addresses", () => {
  test("copy path is the bucket-relative one, never namespaced", () => {
    const h = harness();
    h.run("copyPath", onRow(note("1-projects/plan.md")));
    expect(h.copied).toEqual(["1-projects/plan.md"]);
  });

  test("copy @path carries the context so it addresses from outside", () => {
    const h = harness();
    h.run("copyAtPath", onRow(note("1-projects/plan.md")));
    expect(h.copied).toEqual(["@seyi/1-projects/plan.md"]);
  });
});

describe("visibility", () => {
  test("the two tiers are written straight through, with the row's kind", () => {
    const h = harness();
    h.run("visibilityPrivate", onRow(note("1-projects/plan.md")));
    h.run("visibilityTeam", onRow(dir("1-projects")));
    expect(h.calls).toEqual([
      { name: "setVisibility", args: ["1-projects/plan.md", "file", "private"] },
      { name: "setVisibility", args: ["1-projects", "folder", "team"] },
    ]);
  });

  test("following the folder writes the folder's own value back", () => {
    const h = harness({ inheritedOf: () => "private" });
    h.run("visibilityFollow", onRow(note("1-projects/plan.md")));
    expect(h.calls).toEqual([
      { name: "setVisibility", args: ["1-projects/plan.md", "file", "private"] },
    ]);
  });

  /**
   * A group rule is not one of the two tiers `setVisibility` takes, so writing
   * either would change what the note reaches rather than make it follow.
   * Doing nothing is the honest answer until the group controls land.
   */
  test("a group rule has no follow this control can express, so nothing happens", () => {
    const h = harness({ inheritedOf: () => "@design" as Visibility });
    h.run("visibilityFollow", onRow(note("1-projects/plan.md")));
    expect(h.calls).toEqual([]);
  });

  /**
   * The parent row. A dispatcher that forgot to check `items` and ran this id
   * would set a visibility nobody asked for — which is why `menu.ts` gives the
   * parent an id of its own, and why this arm has to stay empty.
   */
  test("the submenu's own id changes nothing", () => {
    const h = harness();
    h.run("visibility", onRow(note("1-projects/plan.md")));
    expect(h.calls).toEqual([]);
    expect(h.dialogs).toEqual([]);
  });
});

describe("restore reads the original path back out of the archive", () => {
  test("an archived note goes back where it came from", () => {
    const h = harness();
    h.run("restore", onRow(note("4-archive/2026-09-16T00-00-00/1-projects/plan.md")));
    expect(h.calls).toEqual([{ name: "move", args: [
      "4-archive/2026-09-16T00-00-00/1-projects/plan.md",
      "1-projects",
    ] }]);
  });

  test("a note that is not archived has nowhere to go back to, so nothing moves", () => {
    const h = harness();
    h.run("restore", onRow(note("1-projects/plan.md")));
    expect(h.calls).toEqual([]);
  });
});

describe("trash is immediate and recoverable, so it raises no dialog", () => {
  test("delete destroys, archive asks", () => {
    const h = harness();
    h.run("delete", onRow(note("1-projects/plan.md")));
    h.run("archive", onRow(note("1-projects/plan.md")));
    expect(h.calls).toEqual([{ name: "destroy", args: ["1-projects/plan.md"] }]);
    expect(h.dialogs).toEqual([{ kind: "archive", path: "1-projects/plan.md" }]);
  });
});
