import { describe, expect, test } from "@jest/globals";
import {
  MAX_RECENT,
  appPlace,
  canGoBack,
  canGoForward,
  currentPath,
  currentPlace,
  emptyHistory,
  hasSomewhereToGo,
  notePlace,
  placeOf,
  recentPaths,
  settingsPlace,
  stepped,
  visited,
  type HistoryState,
  type Place,
} from "../features/console/files/history";

/**
 * The two controls Obsidian's toolbar leads with, and which ours did not have.
 *
 * A phone shows one note at a time, so "the one I was just looking at" is a
 * destination you reach constantly and cannot see. Without this the only route
 * back was to open the drawer and find it in the tree.
 */

function walk(...paths: string[]): HistoryState {
  return walkPlaces(...paths.map(notePlace));
}

function walkPlaces(...places: Place[]): HistoryState {
  return places.reduce(visited, emptyHistory);
}

describe("where you have been", () => {
  test("nothing visited is nowhere to go", () => {
    expect(currentPath(emptyHistory)).toBeNull();
    expect(canGoBack(emptyHistory)).toBe(false);
    expect(canGoForward(emptyHistory)).toBe(false);
  });

  test("one visit is still nowhere to go back to", () => {
    // The first note is not somewhere you arrived *from*.
    const one = walk("a.md");
    expect(canGoBack(one)).toBe(false);
    expect(canGoForward(one)).toBe(false);
  });

  test("back and forward walk the list", () => {
    const three = walk("a.md", "b.md", "c.md");
    expect(currentPath(three)).toBe("c.md");

    const back = stepped(three, -1);
    expect(currentPath(back)).toBe("b.md");
    expect(canGoForward(back)).toBe(true);

    expect(currentPath(stepped(back, 1))).toBe("c.md");
  });

  test("re-opening the note you are on records nothing", () => {
    /*
      The bug that makes a back button untrustworthy. The console re-selects
      the open note on plenty of ordinary events — a listing refresh, a rename
      that lands on the same path — and if each one were an entry, back would
      need two presses to go anywhere, then three.
    */
    const twice = visited(
      visited(walk("a.md", "b.md"), notePlace("b.md")),
      notePlace("b.md"),
    );
    expect(twice.entries).toEqual(["a.md", "b.md"].map(notePlace));
    expect(currentPath(stepped(twice, -1))).toBe("a.md");
  });

  test("a revisit further back is a new entry, not a jump", () => {
    // Distinct from the case above: you *went somewhere else* and came back,
    // which is a visit. Collapsing it would make back skip the return trip.
    const state = walk("a.md", "b.md", "a.md");
    expect(state.entries).toEqual(["a.md", "b.md", "a.md"].map(notePlace));
    expect(currentPath(stepped(state, -1))).toBe("b.md");
  });

  test("visiting after stepping back drops the forward tail", () => {
    /*
      A browser's rule, and the reason it is a browser's rule: a forward entry
      is a prediction about a branch you have just left. Keeping it would offer
      to take somebody forward to somewhere they never chose from here.
    */
    const branched = visited(
      stepped(walk("a.md", "b.md", "c.md"), -1),
      notePlace("d.md"),
    );
    expect(branched.entries).toEqual(["a.md", "b.md", "d.md"].map(notePlace));
    expect(canGoForward(branched)).toBe(false);
  });

  test("neither end runs off", () => {
    const one = walk("a.md");
    expect(stepped(one, -1)).toBe(one);
    expect(stepped(one, 1)).toBe(one);
    expect(stepped(emptyHistory, -1)).toBe(emptyHistory);
  });

  test("nothing is mutated", () => {
    // The reducer is handed to React state; a returned object that shares an
    // array with its input is a render that does not happen.
    const before = walk("a.md", "b.md");
    const snapshot = [...before.entries];
    visited(before, notePlace("c.md"));
    stepped(before, -1);
    expect(before.entries).toEqual(snapshot);
  });
});

/**
 * The list behind the phone's Recent sheet.
 *
 * `‹` reaches the previous note; this reaches the previous fifteen, which is
 * the whole reason the sheet replaced the tab switcher that used to sit in that
 * toolbar slot. It is **derived from the same array `‹` and `›` walk** rather
 * than kept beside it: a second log would be a second model of "which notes am
 * I working with" on a 390pt screen, which is exactly the thing being removed.
 */
describe("recent, for the sheet", () => {
  test("most recent first, which is the reverse of the walk", () => {
    expect(recentPaths(walk("a.md", "b.md", "c.md"))).toEqual(["c.md", "b.md", "a.md"]);
  });

  test("nowhere visited is an empty list rather than a null", () => {
    expect(recentPaths(emptyHistory)).toEqual([]);
  });

  test("a note visited twice appears once, at its most recent position", () => {
    /*
      `entries` keeps both visits on purpose — collapsing them would make `‹`
      skip the return trip (see "a revisit further back is a new entry"). A
      *list* has no such need: two rows with the same name, one of which is
      dead, is the sheet reading as broken.
    */
    expect(recentPaths(walk("a.md", "b.md", "a.md"))).toEqual(["a.md", "b.md"]);
  });

  test("the note you are on is in the list, because the sheet marks it", () => {
    // Dropping it here would leave the sheet unable to say where you already
    // are, and `RecentSheet` marks that row rather than hiding it.
    const state = walk("a.md", "b.md");
    expect(recentPaths(state)[0]).toBe(currentPath(state));
  });

  test("stepping back does not reorder the list under the thumb", () => {
    /*
      Back and forward are movement *within* this list, not new visits. If a
      press reordered it, walking back through the sheet would shuffle the rows
      you were reading — and no browser's history list does that either.
    */
    const three = walk("a.md", "b.md", "c.md");
    expect(recentPaths(stepped(three, -1))).toEqual(recentPaths(three));
  });

  test("a branch drops the forward tail here too, because it is one array", () => {
    // The cost of deriving rather than keeping a parallel log, stated: `c.md`
    // is genuinely gone. It is the browser rule `entries` already lives by, and
    // one model that forgets is better than two that disagree.
    const branched = visited(
      stepped(walk("a.md", "b.md", "c.md"), -1),
      notePlace("d.md"),
    );
    expect(recentPaths(branched)).toEqual(["d.md", "b.md", "a.md"]);
  });

  test("capped, keeping the newest", () => {
    // An unbounded list is a sheet nobody scrolls to the bottom of, and the
    // rows past the first dozen are somewhere you went this morning.
    const many = walk(...Array.from({ length: MAX_RECENT + 8 }, (_, i) => `n${i}.md`));
    const recent = recentPaths(many);
    expect(recent).toHaveLength(MAX_RECENT);
    expect(recent[0]).toBe(`n${MAX_RECENT + 7}.md`);
  });

  test("folders are in it, because a folder is somewhere you were", () => {
    // History records the *selection*, which is a folder as often as a note —
    // and "back to the folder I was in" is a real destination on a phone. The
    // sheet draws those rows with a folder icon rather than filtering them.
    expect(recentPaths(walk("1-projects", "1-projects/plan.md"))).toEqual([
      "1-projects/plan.md",
      "1-projects",
    ]);
  });

  test("one entry, and it is where you already are, is nowhere to go", () => {
    /*
      The state the toolbar's Recent key is dimmed in, and the ordinary one on
      the first note of a session. `length > 0` is the wrong question: the list
      always holds the note on screen, so it is never empty once anything is
      open, and a control offering to take somebody where they already stand is
      one they learn to stop pressing.
    */
    const one = walk("a.md");
    expect(recentPaths(one)).toEqual(["a.md"]);
    expect(hasSomewhereToGo(one, "a.md")).toBe(false);
  });

  test("a second place lights it, and so does stepping off the only one", () => {
    expect(hasSomewhereToGo(walk("a.md", "b.md"), "b.md")).toBe(true);
    // Closing the note leaves the folder view with nothing selected, and the
    // one entry becomes a destination again rather than a mirror.
    expect(hasSomewhereToGo(walk("a.md"), null)).toBe(true);
    expect(hasSomewhereToGo(emptyHistory, null)).toBe(false);
  });

  test("it asks about the selection, because a folder is a place too", () => {
    // Standing *in* `1-projects` with `1-projects` the only entry is the same
    // dead end as standing in the only note.
    expect(hasSomewhereToGo(walk("1-projects"), "1-projects")).toBe(false);
    expect(hasSomewhereToGo(walk("1-projects"), "1-projects/plan.md")).toBe(true);
  });

  test("a context switch empties it with everything else", () => {
    // Paths are relative to a bucket; `clearedHistory` is the guard, and this
    // is the assertion that the new list is behind it rather than beside it.
    expect(recentPaths(emptyHistory)).toEqual([]);
  });
});

/**
 * EVERY PLACE THE CONSOLE CAN REACH, NOT JUST THE NOTES.
 *
 * Reported from a phone: open Settings, open a note from it, press `‹` — and
 * you land on the note you were reading *before*, never back in Settings. The
 * key is not broken, it is walking the wrong list: `entries` held paths, so a
 * settings section, an app pane and a context's own root were not somewhere
 * you had been, they were nothing at all.
 *
 * A back key that skips a page is the same defect as one that does nothing, so
 * these walk **sequences across kinds** rather than one hop each.
 */
describe("history covers every kind of destination", () => {
  test("settings is a place, and back returns to it", () => {
    const state = walkPlaces(
      settingsPlace("storage"),
      notePlace("1-projects/plan.md"),
    );
    expect(currentPlace(state)).toEqual(notePlace("1-projects/plan.md"));

    const back = stepped(state, -1);
    // The reported case, exactly: Settings, then a note, then `‹`.
    expect(currentPlace(back)).toEqual(settingsPlace("storage"));
  });

  test("two settings sections are two places", () => {
    // Sections are addressable — `?settings=storage` and `?settings=integrations`
    // are different URLs — so stepping between them is a step.
    const state = walkPlaces(settingsPlace("storage"), settingsPlace("integrations"));
    expect(canGoBack(state)).toBe(true);
    expect(currentPlace(stepped(state, -1))).toEqual(settingsPlace("storage"));
  });

  test("an app pane is a place", () => {
    const state = walkPlaces(notePlace("a.md"), appPlace("map"));
    expect(currentPlace(stepped(state, -1))).toEqual(notePlace("a.md"));
  });

  test("a walk across four kinds steps back through all four", () => {
    /*
      The sequence a person actually makes: read a note, look something up in
      Search, change a setting, open the inbox. Every one of those four is a
      page, and `‹` owes them all — pressing it four times has to retrace the
      route rather than falling through to whichever notes happen to be in a
      path stack.
    */
    const route = [
      notePlace("2-areas/spirit/kings.md"),
      appPlace("search"),
      settingsPlace("storage"),
      notePlace("0-inbox/sayo-seyi.md"),
    ];
    let state = walkPlaces(...route);
    for (let index = route.length - 1; index > 0; index -= 1) {
      expect(currentPlace(state)).toEqual(route[index]);
      state = stepped(state, -1);
    }
    expect(currentPlace(state)).toEqual(route[0]);
    expect(canGoBack(state)).toBe(false);
  });

  test("arriving where you already are is still not a step", () => {
    // `visited`'s rule, which has to hold per PLACE now rather than per path —
    // otherwise a re-render that re-derives the open settings section grows
    // the list and `‹` needs two presses.
    const once = walkPlaces(settingsPlace("storage"));
    expect(visited(once, settingsPlace("storage"))).toBe(once);
  });

  test("a note and a settings section are never the same place", () => {
    const state = walkPlaces(notePlace("storage"), settingsPlace("storage"));
    // The naive comparison — compare the payload strings — would call these
    // one place and swallow the step between them.
    expect(canGoBack(state)).toBe(true);
  });

  test("Recent still lists notes and folders, and only those", () => {
    /*
      The sheet draws file names and sends `select(path)`, so a settings
      section in it would be a row that either reads as a note or navigates
      nowhere. History is wider than Recent on purpose.
    */
    const state = walkPlaces(
      notePlace("a.md"),
      settingsPlace("storage"),
      appPlace("map"),
      notePlace("b.md"),
    );
    expect(recentPaths(state)).toEqual(["b.md", "a.md"]);
  });

  test("`currentPath` answers null where the place is not a path", () => {
    /*
      Its callers select a file with it, so "the last path you were on" would
      move the selection out from under somebody who pressed back to reach a
      setting — they would land on the settings section with a *different* note
      swapped in behind it.

      The settings place is put AFTER a note deliberately: with nothing behind
      it, a buggy implementation that walked back to the nearest path would
      return null too and this would pass while the defect shipped. Confirmed
      by sabotage — the walk-backwards version survives the empty case.
    */
    const afterANote = walkPlaces(notePlace("a.md"), settingsPlace("storage"));
    expect(currentPath(afterANote)).toBeNull();
    expect(currentPath(walkPlaces(settingsPlace("storage")))).toBeNull();
    expect(currentPath(walkPlaces(notePlace("a.md")))).toBe("a.md");
  });
});

/**
 * WHICH PAGE THE CONSOLE IS SHOWING.
 *
 * The half the model could not prove on its own. `HistoryState` was already
 * wide enough to hold a settings section long before anything recorded one, so
 * every test above could pass while `‹` still walked past Settings — the
 * derivation lived in a `useMemo` in the layout, where no test could reach it.
 */
describe("reading the place off the screen", () => {
  const BROWSE = {
    settingsSection: null,
    routeKind: "context",
    appSection: null,
    selectedPath: "1-projects/plan.md",
  } as const;

  test("the settings overlay wins over the note behind it", () => {
    // It is drawn OVER Browse with the note still mounted, so asking which
    // path is selected answers about the page underneath — which is exactly
    // how Settings failed to be a place at all.
    expect(placeOf({ ...BROWSE, settingsSection: "storage" })).toEqual(
      settingsPlace("storage"),
    );
  });

  test("an app pane wins over a selection that survived into it", () => {
    // Walking to Map does not clear the context's selection, so the stale path
    // is still there to be mistaken for where you are.
    expect(
      placeOf({ ...BROWSE, routeKind: "app", appSection: "map" }),
    ).toEqual(appPlace("map"));
  });

  test("settings wins over an app pane too", () => {
    expect(
      placeOf({
        ...BROWSE,
        routeKind: "app",
        appSection: "map",
        settingsSection: "storage",
      }),
    ).toEqual(settingsPlace("storage"));
  });

  test("otherwise it is the selection", () => {
    expect(placeOf(BROWSE)).toEqual(notePlace("1-projects/plan.md"));
  });

  test("nowhere yet records nothing rather than a guess", () => {
    // The frame before the first selection lands.
    expect(placeOf({ ...BROWSE, selectedPath: null })).toBeNull();
  });

  test("the reported sequence, end to end through the derivation", () => {
    /*
      Seyi's report, replayed as the screen states that produce it rather than
      as places handed straight to `visited`: in Settings, open a note, press
      back. The assertion is that the first step lands in Settings — which is
      what it did not do.
    */
    const screens = [
      { ...BROWSE, settingsSection: "storage" as const },
      { ...BROWSE, selectedPath: "2-areas/spirit/kings.md" },
    ];
    const state = screens
      .map((screen) => placeOf(screen))
      .reduce<HistoryState>(
        (acc, place) => (place === null ? acc : visited(acc, place)),
        emptyHistory,
      );
    expect(currentPlace(stepped(state, -1))).toEqual(settingsPlace("storage"));
  });
});
