/**
 * @jest-environment jsdom
 */

import { describe, expect, test } from "@jest/globals";
import { dataWith, ENTRY, mountConsole } from "./fixtures";

/**
 * **THE FILE TREE'S FOOT, AND WHERE THE THREE THINGS IN IT WENT.**
 *
 * This block was `the file tree ends in a vault switcher`, and it asserted
 * Obsidian's block: the context's name with a chevron and a gear, a row of five
 * icon verbs, and one muted line reading `R2 · notes-bucket · 1 note, 0 folders`. Its
 * three tests opened `frame-drawer-toggle` first, because all of it lived
 * inside the file tree, and the file tree was a drawer.
 *
 * **A phone has no file tree.** Not a hidden one, not one behind a toggle —
 * none (`features/app/frame.ts`). So the block is not merely unreachable, it is
 * not rendered at any density: `Explorer` is a pointer-layout column and its
 * `vault` and `vaultDetail` slots have no supplier left and are deleted.
 *
 * Deleting the assertions with the design would have dropped a feature
 * silently, which is why each of the four things that block carried is followed
 * to where it went instead:
 *
 *  - **the context's name and the chevron** — the contexts are the strip along
 *    the top, and choosing one is a press rather than a panel
 *    (`consoleChrome.test.ts`, `contextStrip.test.ts`);
 *  - **the gear** — a context's settings are the strip's long-press menu
 *    (`contextMenu.ts`'s `settings` row, held by `contextStrip.test.ts`);
 *  - **the five verbs** — new note, search and the tab count are keys on the
 *    bottom row, which is where a thumb already is;
 *  - **the muted line** — `storage · index · counts`, which had **no other
 *    route on a phone to any of the three**, is the foot of the context root
 *    page. That is the one this block is the proof for, because it is the one
 *    that would have been lost without anybody noticing: nothing else on a
 *    phone says which bucket this context is bound to.
 *
 * `indexProgressSurfaces.test.ts` owns the index figure's own rules — the
 * owner-only gate, the stalled and finished and failed wordings. What is here
 * is that the *line* exists, in the right place, with all three facts on it.
 *
 * ## Sabotage record
 *
 * Against a green baseline of **172 suites / 3,285 tests**
 * (`npx jest --watchman=false`), one at a time:
 *
 * | broken guard | result |
 * | --- | --- |
 * | `atContextRoot` drops its `compact &&` | 1 failure, `a pointer layout draws no context foot`, and only it |
 * | a phone with nothing open falls back to `Empty` | 4 failures / 2 files, led here by `a phone that has opened nothing lands on that page rather than on a dead end` |
 * | `contextFootLine` drops the binding | 5 failures / 3 files, one of them `the binding and the counts are one line under the context's own page` |
 */
describe("the tree's foot became the context root page's foot", () => {
  /** The root's listing, for a console that has landed on the context itself. */
  const AT_ROOT = {
    selectedPath: "",
    listings: {
      "": {
        path: "",
        folderDefault: "private" as const,
        truncated: false,
        manifestUsable: true,
        entries: [{ ...ENTRY, path: "1-projects/plan.md" }],
      },
    },
  };

  test("the binding and the counts are one line under the context's own page", () => {
    const app = mountConsole(dataWith(AT_ROOT as never, { kind: "folder", path: "", name: "" }));

    // The page is really the context's — the heading is the context's name,
    // which is what `FolderView` takes a `contextLabel` for.
    expect(app.container.textContent).toContain("@seyi");
    // One muted line: the binding, then what has been read of the tree. No
    // index figure, because this fixture's `fastSearch.status` is `null` —
    // "not answered yet" — and an absence is never drawn as a zero.
    expect(app.find("context-foot")!.textContent).toBe("R2 · notes-bucket · 1 note, 0 folders");
  });

  test("a pointer layout draws no context foot", () => {
    // It says all three of these already — the bucket and the tier are the top
    // bar's chips, the index figure is the status strip's segment, and the
    // counts are the tree's own foot. A second copy under the listing would be
    // the same facts twice on the one density that never lost them.
    const app = mountConsole(
      dataWith(AT_ROOT as never, { kind: "folder", path: "", name: "" }),
      1440,
    );
    expect(app.find("context-foot")).toBeNull();
    // The positive control: the tree is there and still counts what it has read.
    expect(app.find("explorer-counts")!.textContent).toBe("1 note, 0 folders");
  });

  test("a phone that has opened nothing lands on that page rather than on a dead end", () => {
    /*
      `Empty` says "choose a note … right-click any row — or press and hold on a
      phone", which was true while the tree was one press away. There are no
      rows on a phone until you are standing in a folder, so on
      `/console/@seyi` with no `?note=` that sentence named a gesture with
      nothing to perform it on — and the context's own page, with the line
      above on it, was unreachable.
    */
    const app = mountConsole(
      dataWith({ ...AT_ROOT, selectedPath: null, opening: null } as never),
    );

    expect(app.container.textContent).not.toContain("Choose a note");
    expect(app.find("folder-row")).not.toBeNull();
    expect(app.find("context-foot")).not.toBeNull();
  });

  test("and a pointer layout keeps its empty state", () => {
    // The other density has a tree beside the pane, so "choose a note" names
    // something on the screen. Replacing it there would be answering a
    // question nobody asked.
    const app = mountConsole(
      dataWith({ ...AT_ROOT, selectedPath: null, opening: null } as never),
      1440,
    );
    expect(app.container.textContent).toContain("Choose a note");
  });
});
