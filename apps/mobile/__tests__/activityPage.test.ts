/**
 * @jest-environment jsdom
 */

/**
 * `activity.md`, OPENED — THE PAGE, NOT THE RULES.
 *
 * `activity.test.ts` holds the rules and `activityRender.test.ts` holds the
 * indicator's wiring. This holds the three claims the page itself makes, all
 * three of which came out of looking at it on a screen rather than out of a
 * failing test:
 *
 *  1. **The column is the note's column.** A hard 760 pinned to the left edge
 *     is what shipped; the measure is shared with the editor now, because
 *     pressing the pencil swaps this list for that editor over the same file
 *     and a page with a column of its own jumps sideways at the press.
 *  2. **A hand-edited row is named rather than swallowed.** Deleting a row's
 *     `<!--ctx …-->` is allowed — the file is the owner's — and the row then
 *     stops existing for every reader and goes on the next change. Saying
 *     nothing is how a person edits a file, watches rows vanish, and concludes
 *     the product ate them.
 *  3. **The repair is a prompt, never a button.** A one-press sweep that
 *     deletes what somebody typed is the product taking the file back the
 *     moment it looks untidy, in the one feature whose whole subject is that
 *     the file is theirs.
 *
 * ## Sabotage record
 *
 * Applied, this suite run, named test observed failing, reverted.
 *
 *  1. `strayRows` dropped from the page, so the notice never draws.
 *     → **2 fail**: `names a row whose comment was deleted` and `and says how
 *       many when there are several`.
 *  2. The notice drawn whenever `source` is present rather than only when
 *     something is stray.
 *     → **1 fails**: `a file nobody has touched says nothing about repairs`.
 *  3. The foot's pencil sentence drawn for everybody, not just the owner.
 *     → **1 fails**: `a member is not told to press a pencil they have not
 *       got`.
 */

import { afterEach, describe, expect, test } from "@jest/globals";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { parseFile, renderFile } from "@context/shared/src/activity.cjs";
import { DEMO_ACTIVITY, DEMO_CONTEXT_TREES } from "../features/console/placeholderData";
import { ActivityPage } from "../features/console/activity/ActivityPage";
import type { ActivityEntry, ActivityView } from "../features/console/activity/activity";

const NOW = Date.parse("2026-09-19T17:00:00.000Z");

function entry(over: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    at: new Date(NOW - 4 * 60_000).toISOString(),
    kind: "added",
    paths: ["1-projects/alpha.md"],
    n: 1,
    vis: "team",
    by: "@sayo",
    via: "Claude",
    note: null,
    ...over,
  };
}

function view(entries: ActivityEntry[]): ActivityView {
  return {
    entries,
    seenAt: NOW,
    unseen: 0,
    unseenPaths: new Set<string>(),
    loaded: true,
    refresh: () => {},
    markSeen: () => {},
  };
}

const roots: (() => void)[] = [];
afterEach(() => {
  while (roots.length > 0) roots.pop()!();
  document.body.innerHTML = "";
});

function mount(props: { source?: string; editable?: boolean; entries?: ActivityEntry[] } = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container, { onUncaughtError: () => {}, onCaughtError: () => {} });
  roots.push(() => {
    act(() => root.unmount());
    container.remove();
  });
  act(() => {
    root.render(
      createElement(ActivityPage, {
        activity: view(props.entries ?? [entry()]),
        shared: false,
        now: NOW,
        source: props.source,
        editable: props.editable,
        onOpen: () => {},
      }),
    );
  });
  return container;
}

const text = (container: HTMLElement) => container.textContent ?? "";

/** The file as Context writes it, with one real row in it. */
const CLEAN: string = renderFile([entry()]);

/*
  THE COLUMN IS NOT ASSERTED HERE, AND THAT IS THE POINT.

  react-native-web compiles a `StyleSheet` to CSS classes, so `style.maxWidth`
  on a rendered node is the empty string and any assertion made here would be
  about the stylesheet's own bookkeeping rather than about where the text
  lands. The first draft of this file asserted it anyway and had to be deleted,
  which is the same lesson `docs/decisions/app-and-console.md` already draws
  twice about this feature: the defect that shipped was a layout one, and only
  a browser has an opinion about layout.

  `e2e/webkit/activityPage.spec.ts` measures it, against the built export, in
  the engine — the column's box against the note editor's, at a width where
  the measure binds.
*/

describe("a row somebody edited by hand", () => {
  test("a file nobody has touched says nothing about repairs", () => {
    const container = mount({ source: CLEAN });
    expect(container.querySelector('[data-testid="activity-stray"]')).toBeNull();
  });

  test("and neither does a page with no file in hand at all", () => {
    // The demo console and the fixtures pass no source. Absent is not broken.
    const container = mount();
    expect(container.querySelector('[data-testid="activity-stray"]')).toBeNull();
  });

  test("editing a row's words is not a repair — the comment is what is read", () => {
    const container = mount({ source: CLEAN.replace("added", "ADDED, by my own hand") });
    expect(container.querySelector('[data-testid="activity-stray"]')).toBeNull();
  });

  test("names a row whose comment was deleted", () => {
    const container = mount({ source: CLEAN.replace(/ <!--ctx[\s\S]*?-->/, "") });
    expect(container.querySelector('[data-testid="activity-stray"]')).not.toBeNull();
    expect(text(container)).toContain("One line between the markers");
    // The half that stops it reading as a threat: their own prose is safe.
    expect(text(container)).toContain("outside the markers is kept");
  });

  test("and says how many when there are several", () => {
    const two = renderFile([entry(), entry({ paths: ["1-projects/beta.md"] })]);
    const container = mount({ source: two.replace(/ <!--ctx[\s\S]*?-->/g, "") });
    expect(text(container)).toContain("2 lines between the markers");
  });

  test("offers a prompt to copy, and never a button that deletes them", () => {
    const container = mount({ source: CLEAN.replace(/ <!--ctx[\s\S]*?-->/, "") });
    const copy = container.querySelector('[data-testid="activity-stray-copy"]');
    expect(copy).not.toBeNull();
    expect(copy!.textContent).toContain("Copy a prompt");
    // No control on this page removes anything. If one is ever added, this is
    // the test that should stop it — the reasoning is in the file header.
    expect(text(container)).not.toMatch(/\b(Delete|Remove|Clean up|Tidy)\b/);
  });
});

describe("the foot", () => {
  test("says what the page is, to everybody", () => {
    expect(text(mount())).toContain("a note in your own storage");
  });

  test("tells an owner the pencil reaches the Markdown", () => {
    expect(text(mount({ editable: true }))).toContain("pencil");
  });

  test("a member is not told to press a pencil they have not got", () => {
    expect(text(mount({ editable: false }))).not.toContain("pencil");
  });
});

/*
  THE DEMO'S OWN FILE, WHICH IS WHERE A VISITOR MEETS THIS FEATURE.

  Adding `activity.md` to the demo tree so a browser could open the page put a
  file full of `<!--ctx {…}-->` one click from the landing page — `NoteEditor`
  draws the list only where the console has the list, and the read-only demo
  had none. Caught by reading the diff rather than by a test, which is what
  these two are for.
*/
describe("the demo context", () => {
  test("lists activity.md at the root, beside index and privacy", () => {
    const root = DEMO_CONTEXT_TREES.seyi?.listings[""];
    expect(root?.entries.some((e) => e.path === "activity.md")).toBe(true);
  });

  test("has an activity file, and it is the real format", () => {
    const body = DEMO_CONTEXT_TREES.seyi?.notes["activity.md"];
    expect(typeof body).toBe("string");
    // Parsed by the same reader the console uses: a demo file that does not
    // parse is a demo of an empty page.
    expect(parseFile(body as string)).toHaveLength(DEMO_ACTIVITY.length);
  });

  test("and the file and the view come from one list, so they cannot disagree", () => {
    const body = DEMO_CONTEXT_TREES.seyi?.notes["activity.md"] as string;
    expect(body).toBe(renderFile(DEMO_ACTIVITY));
  });
});
