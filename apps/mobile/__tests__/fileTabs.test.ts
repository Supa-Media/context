/**
 * Open tabs, driven one action at a time.
 *
 * The whole reason `features/console/files/tabs.ts` is a pure module is that
 * these are sequences, not snapshots: close the active tab and land on the
 * right neighbour, rename the note somebody is typing into and keep the draft,
 * close four tabs and get them back in the order they were in. None of that is
 * reachable from a screenshot, and this suite runs in plain node with no
 * renderer.
 *
 * Fake paths throughout — this repository is public.
 */

import { describe, expect, test } from "@jest/globals";
import {
  MAX_REOPENABLE,
  dirtyCount,
  emptyTabs,
  tabAt,
  tabLabel,
  tabsReducer,
  type TabsAction,
  type TabsState,
} from "../features/console/files/tabs";

/** Apply a sequence, so a test reads as the story it is describing. */
function run(state: TabsState, ...actions: TabsAction[]): TabsState {
  return actions.reduce(tabsReducer, state);
}

function pinned(...paths: string[]): TabsState {
  return run(
    emptyTabs,
    ...paths.map((path): TabsAction => ({ type: "opened", path, mode: "pinned" })),
  );
}

const paths = (state: TabsState) => state.tabs.map((tab) => tab.path);

/* -------------------------------------------------------------------------- */
/*                             opening and previewing                         */
/* -------------------------------------------------------------------------- */

describe("there is only ever one preview tab", () => {
  test("a second single click replaces the first preview rather than adding to it", () => {
    const state = run(
      emptyTabs,
      { type: "opened", path: "1-projects/a.md", mode: "preview" },
      { type: "opened", path: "1-projects/b.md", mode: "preview" },
    );
    expect(paths(state)).toEqual(["1-projects/b.md"]);
    expect(state.tabs[0].preview).toBe(true);
    expect(state.activePath).toBe("1-projects/b.md");
  });

  test("the replacement takes the preview's slot, not the end of the strip", () => {
    const state = run(
      pinned("1-projects/a.md"),
      { type: "opened", path: "1-projects/b.md", mode: "preview" },
      { type: "opened", path: "1-projects/c.md", mode: "pinned" },
      { type: "opened", path: "1-projects/d.md", mode: "preview" },
    );
    expect(paths(state)).toEqual(["1-projects/a.md", "1-projects/d.md", "1-projects/c.md"]);
  });

  test("a double click adds a tab and leaves the preview alone", () => {
    const state = run(
      emptyTabs,
      { type: "opened", path: "1-projects/a.md", mode: "preview" },
      { type: "opened", path: "1-projects/b.md", mode: "pinned" },
    );
    expect(paths(state)).toEqual(["1-projects/a.md", "1-projects/b.md"]);
    expect(state.tabs.map((tab) => tab.preview)).toEqual([true, false]);
  });

  test("a replaced preview is not remembered as closed — nobody closed it", () => {
    const state = run(
      emptyTabs,
      { type: "opened", path: "1-projects/a.md", mode: "preview" },
      { type: "opened", path: "1-projects/b.md", mode: "preview" },
    );
    expect(state.closed).toEqual([]);
  });
});

describe("opening something already open", () => {
  test("activates it instead of duplicating it", () => {
    const state = run(
      pinned("1-projects/a.md", "1-projects/b.md"),
      { type: "activated", path: "1-projects/a.md" },
      { type: "opened", path: "1-projects/b.md", mode: "preview" },
    );
    expect(paths(state)).toEqual(["1-projects/a.md", "1-projects/b.md"]);
    expect(state.activePath).toBe("1-projects/b.md");
  });

  test("never demotes a pinned tab back to preview", () => {
    const state = run(pinned("1-projects/a.md"), {
      type: "opened",
      path: "1-projects/a.md",
      mode: "preview",
    });
    expect(state.tabs[0].preview).toBe(false);
  });

  test("but a second click in pinned mode does pin a preview", () => {
    const state = run(
      emptyTabs,
      { type: "opened", path: "1-projects/a.md", mode: "preview" },
      { type: "opened", path: "1-projects/a.md", mode: "pinned" },
    );
    expect(state.tabs).toHaveLength(1);
    expect(state.tabs[0].preview).toBe(false);
  });

  test("pinning explicitly does the same thing", () => {
    const state = run(
      emptyTabs,
      { type: "opened", path: "1-projects/a.md", mode: "preview" },
      { type: "pinned", path: "1-projects/a.md" },
    );
    expect(state.tabs[0].preview).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/*                              dirty and saved                               */
/* -------------------------------------------------------------------------- */

describe("editing", () => {
  /** A tab the next single click would replace is no place for a draft. */
  test("typing into a preview tab pins it as well as marking it dirty", () => {
    const state = run(
      emptyTabs,
      { type: "opened", path: "1-projects/a.md", mode: "preview" },
      { type: "edited", path: "1-projects/a.md" },
    );
    expect(state.tabs[0]).toEqual({ path: "1-projects/a.md", preview: false, dirty: true });
    expect(dirtyCount(state)).toBe(1);
  });

  test("a pinned preview is no longer replaced by the next single click", () => {
    const state = run(
      emptyTabs,
      { type: "opened", path: "1-projects/a.md", mode: "preview" },
      { type: "edited", path: "1-projects/a.md" },
      { type: "opened", path: "1-projects/b.md", mode: "preview" },
    );
    expect(paths(state)).toEqual(["1-projects/a.md", "1-projects/b.md"]);
  });

  test("saving clears dirty, and the count is what the strip and the mobile button show", () => {
    let state = run(
      pinned("1-projects/a.md", "1-projects/b.md"),
      { type: "edited", path: "1-projects/a.md" },
      { type: "edited", path: "1-projects/b.md" },
    );
    expect(dirtyCount(state)).toBe(2);
    state = tabsReducer(state, { type: "saved", path: "1-projects/a.md" });
    expect(dirtyCount(state)).toBe(1);
    expect(state.tabs[0].dirty).toBe(false);
  });

  test("editing or saving a note that is not open is a no-op, not a crash", () => {
    const before = pinned("1-projects/a.md");
    expect(tabsReducer(before, { type: "saved", path: "1-projects/ghost.md" })).toBe(before);
    expect(tabsReducer(before, { type: "edited", path: "1-projects/ghost.md" })).toBe(before);
    expect(tabsReducer(before, { type: "activated", path: "1-projects/ghost.md" })).toBe(before);
  });
});

/* -------------------------------------------------------------------------- */
/*                                  closing                                   */
/* -------------------------------------------------------------------------- */

describe("closing the active tab lands on its neighbour", () => {
  test("the tab to the right", () => {
    const state = run(
      pinned("1-projects/a.md", "1-projects/b.md", "1-projects/c.md"),
      { type: "activated", path: "1-projects/b.md" },
      { type: "closed", path: "1-projects/b.md" },
    );
    expect(paths(state)).toEqual(["1-projects/a.md", "1-projects/c.md"]);
    expect(state.activePath).toBe("1-projects/c.md");
  });

  test("the tab to the left, when it was the last one", () => {
    const state = run(pinned("1-projects/a.md", "1-projects/b.md", "1-projects/c.md"), {
      type: "closed",
      path: "1-projects/c.md",
    });
    expect(state.activePath).toBe("1-projects/b.md");
  });

  test("closing the only tab leaves nothing active", () => {
    const state = run(pinned("1-projects/a.md"), { type: "closed", path: "1-projects/a.md" });
    expect(state.tabs).toEqual([]);
    expect(state.activePath).toBeNull();
  });

  test("closing an inactive tab does not move the person", () => {
    const state = run(
      pinned("1-projects/a.md", "1-projects/b.md", "1-projects/c.md"),
      { type: "activated", path: "1-projects/a.md" },
      { type: "closed", path: "1-projects/c.md" },
    );
    expect(state.activePath).toBe("1-projects/a.md");
  });

  test("closing something that is not open changes nothing", () => {
    const before = pinned("1-projects/a.md");
    expect(tabsReducer(before, { type: "closed", path: "1-projects/ghost.md" })).toBe(before);
  });

  /**
   * The reducer does not own the confirm dialog. It closes, and publishes the
   * `dirty` flag the UI is expected to have asked about first — a data
   * structure that refused would be a modal decision in the wrong place.
   */
  test("a dirty tab still closes; warning is the UI's job", () => {
    const state = run(
      pinned("1-projects/a.md", "1-projects/b.md"),
      { type: "edited", path: "1-projects/a.md" },
      { type: "closed", path: "1-projects/a.md" },
    );
    expect(paths(state)).toEqual(["1-projects/b.md"]);
    expect(dirtyCount(state)).toBe(0);
    expect(state.closed).toEqual(["1-projects/a.md"]);
  });
});

/* -------------------------------------------------------------------------- */
/*                                  reopening                                 */
/* -------------------------------------------------------------------------- */

describe("reopening", () => {
  test("brings back the most recently closed tab, pinned", () => {
    const state = run(
      pinned("1-projects/a.md", "1-projects/b.md"),
      { type: "closed", path: "1-projects/a.md" },
      { type: "closed", path: "1-projects/b.md" },
      { type: "reopened" },
    );
    expect(paths(state)).toEqual(["1-projects/b.md"]);
    expect(state.tabs[0].preview).toBe(false);
    expect(state.activePath).toBe("1-projects/b.md");
    expect(state.closed).toEqual(["1-projects/a.md"]);
  });

  test("a reopened tab is not replaced by the next single click", () => {
    const state = run(
      pinned("1-projects/a.md"),
      { type: "closed", path: "1-projects/a.md" },
      { type: "reopened" },
      { type: "opened", path: "1-projects/b.md", mode: "preview" },
    );
    expect(paths(state)).toEqual(["1-projects/a.md", "1-projects/b.md"]);
  });

  test("reopening with nothing closed is a no-op", () => {
    const before = pinned("1-projects/a.md");
    expect(tabsReducer(before, { type: "reopened" })).toBe(before);
    expect(tabsReducer(emptyTabs, { type: "reopened" })).toBe(emptyTabs);
  });

  test("the list is capped, oldest dropped first", () => {
    const many = Array.from({ length: MAX_REOPENABLE + 3 }, (_, index) => `1-projects/n${index}.md`);
    const state = run(
      pinned(...many),
      ...many.map((path): TabsAction => ({ type: "closed", path })),
    );
    expect(state.closed).toHaveLength(MAX_REOPENABLE);
    expect(state.closed[0]).toBe(many[many.length - 1]);
    expect(state.closed).not.toContain(many[0]);
  });
});

describe("close others", () => {
  test("keeps exactly one tab, pins it, and reopens the rest left to right", () => {
    let state = run(
      emptyTabs,
      { type: "opened", path: "1-projects/a.md", mode: "pinned" },
      { type: "opened", path: "1-projects/b.md", mode: "pinned" },
      { type: "opened", path: "1-projects/c.md", mode: "preview" },
      { type: "closedOthers", path: "1-projects/b.md" },
    );
    expect(paths(state)).toEqual(["1-projects/b.md"]);
    expect(state.tabs[0].preview).toBe(false);
    expect(state.activePath).toBe("1-projects/b.md");
    expect(state.closed).toEqual(["1-projects/a.md", "1-projects/c.md"]);

    state = run(state, { type: "reopened" }, { type: "reopened" });
    expect(paths(state)).toEqual(["1-projects/b.md", "1-projects/a.md", "1-projects/c.md"]);
  });

  test("on a path that is not open, nothing happens", () => {
    const before = pinned("1-projects/a.md", "1-projects/b.md");
    expect(tabsReducer(before, { type: "closedOthers", path: "1-projects/ghost.md" })).toBe(before);
  });
});

/* -------------------------------------------------------------------------- */
/*                            renames and removals                            */
/* -------------------------------------------------------------------------- */

describe("a rename follows the tab", () => {
  test("the draft, the pin and the active tab all survive it", () => {
    const state = run(
      pinned("1-projects/a.md", "1-projects/b.md"),
      { type: "activated", path: "1-projects/b.md" },
      { type: "edited", path: "1-projects/b.md" },
      { type: "renamed", from: "1-projects/b.md", to: "1-projects/renamed.md" },
    );
    expect(paths(state)).toEqual(["1-projects/a.md", "1-projects/renamed.md"]);
    expect(state.activePath).toBe("1-projects/renamed.md");
    expect(state.tabs[1].dirty).toBe(true);
    expect(dirtyCount(state)).toBe(1);
  });

  test("a preview tab stays a preview tab", () => {
    const state = run(
      emptyTabs,
      { type: "opened", path: "1-projects/a.md", mode: "preview" },
      { type: "renamed", from: "1-projects/a.md", to: "2-areas/a.md" },
    );
    expect(state.tabs[0]).toEqual({ path: "2-areas/a.md", preview: true, dirty: false });
  });

  /** A stale path in the reopen list would come back as a 404. */
  test("a closed tab's remembered path is renamed too", () => {
    const state = run(
      pinned("1-projects/a.md"),
      { type: "closed", path: "1-projects/a.md" },
      { type: "renamed", from: "1-projects/a.md", to: "2-areas/a.md" },
      { type: "reopened" },
    );
    expect(paths(state)).toEqual(["2-areas/a.md"]);
  });

  test("renaming something neither open nor closed changes nothing", () => {
    const before = pinned("1-projects/a.md");
    expect(tabsReducer(before, { type: "renamed", from: "x.md", to: "y.md" })).toBe(before);
  });
});

describe("a removed note cannot stay open", () => {
  test("its tab closes and the neighbour takes over", () => {
    const state = run(
      pinned("1-projects/a.md", "1-projects/b.md", "1-projects/c.md"),
      { type: "activated", path: "1-projects/b.md" },
      { type: "removed", path: "1-projects/b.md" },
    );
    expect(paths(state)).toEqual(["1-projects/a.md", "1-projects/c.md"]);
    expect(state.activePath).toBe("1-projects/c.md");
  });

  /** ⌘⇧T handing somebody a 404 is worse than ⌘⇧T doing nothing. */
  test("it never goes onto the reopen list", () => {
    const state = run(pinned("1-projects/a.md"), { type: "removed", path: "1-projects/a.md" });
    expect(state.closed).toEqual([]);
    expect(tabsReducer(state, { type: "reopened" })).toBe(state);
  });

  test("and it is scrubbed from the list if it was already there", () => {
    const state = run(
      pinned("1-projects/a.md", "1-projects/b.md"),
      { type: "closed", path: "1-projects/a.md" },
      { type: "removed", path: "1-projects/a.md" },
    );
    expect(state.closed).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/*                          keyboard, labels, immutability                    */
/* -------------------------------------------------------------------------- */

describe("⌘1–⌘9", () => {
  test("index 8 is the ninth tab, and out of range is a no-op", () => {
    const state = pinned(...Array.from({ length: 9 }, (_, index) => `1-projects/n${index}.md`));
    expect(tabAt(state, 0)).toBe("1-projects/n0.md");
    expect(tabAt(state, 8)).toBe("1-projects/n8.md");
    expect(tabAt(state, 9)).toBeNull();
    expect(tabAt(state, -1)).toBeNull();
    expect(tabAt(emptyTabs, 0)).toBeNull();
  });
});

describe("tab labels", () => {
  test("the base name without its extension", () => {
    const state = pinned("1-projects/quarterly plan.md");
    expect(tabLabel(state, "1-projects/quarterly plan.md")).toBe("quarterly plan");
  });

  test("two open notes with the same name each get their folder", () => {
    const state = pinned("1-projects/notes.md", "2-areas/notes.md");
    expect(tabLabel(state, "1-projects/notes.md")).toBe("1-projects/notes");
    expect(tabLabel(state, "2-areas/notes.md")).toBe("2-areas/notes");
  });
});

describe("nothing is mutated in place", () => {
  test("the previous state survives every action unchanged", () => {
    const before = run(
      pinned("1-projects/a.md", "1-projects/b.md"),
      { type: "edited", path: "1-projects/a.md" },
    );
    const snapshot = JSON.stringify(before);
    const firstTab = before.tabs[0];

    const actions: TabsAction[] = [
      { type: "opened", path: "1-projects/c.md", mode: "preview" },
      { type: "pinned", path: "1-projects/b.md" },
      { type: "edited", path: "1-projects/b.md" },
      { type: "saved", path: "1-projects/a.md" },
      { type: "closed", path: "1-projects/a.md" },
      { type: "closedOthers", path: "1-projects/a.md" },
      { type: "activated", path: "1-projects/b.md" },
      { type: "renamed", from: "1-projects/a.md", to: "1-projects/z.md" },
      { type: "removed", path: "1-projects/a.md" },
      { type: "reopened" },
    ];
    for (const action of actions) {
      tabsReducer(before, action);
      expect(JSON.stringify(before)).toBe(snapshot);
      expect(before.tabs[0]).toBe(firstTab);
    }
  });

  test("the empty state is never written through", () => {
    const state = run(emptyTabs, { type: "opened", path: "1-projects/a.md", mode: "preview" });
    expect(emptyTabs.tabs).toEqual([]);
    expect(emptyTabs.activePath).toBeNull();
    expect(state).not.toBe(emptyTabs);
  });
});
