import { describe, expect, test } from "@jest/globals";
import { lastChangeOf } from "../features/console/activity/lastChange";
import type { ActivityEntry } from "../features/console/activity/activity";
import { buildHome, recentLabel, type HomeInput } from "../features/console/home/homeModel";
import { accountRecentItems } from "../features/console/files/palette";

/**
 * Recent shows only what you did (owner, 2026-10-17; boards 1 to 4, option A):
 *
 *  - Each Recent row says what the person did: "You edited 9:12", "You opened Mon".
 *  - ⌘K's untyped search lists the same Recent, saying the same.
 *  - Their agents' work is said on the note instead: "Claude changed this at
 *    9:31", only when it was not their own hand.
 *
 * ## Sabotage record
 *
 *  1. `recentLabel` ignores the kind.                → "a row says what they did"
 *  2. `seenKind` dropped in buildHome.               → "Home's recent tiles carry what they did"
 *  3. lastChange speaks for the reader's own edit.   → "their own hand says nothing"
 *  4. lastChange counts a move.                      → "a move is not a change of what it says"
 *  5. lastChange takes the first line, not the newest. → "the newest change speaks"
 */

const at = (h: number, m = 0) => new Date(2026, 9, 17, h, m).getTime();
const NOW = at(12);

function entry(over: Partial<ActivityEntry>): ActivityEntry {
  return { at: new Date(at(9, 31)).toISOString(), kind: "revised", paths: ["a.md"], n: 1, vis: "team", by: "@seyi", via: null, note: null, ...over };
}

describe("Recent rows say what you did", () => {
  test("a row says what they did", () => {
    expect(recentLabel("edited", at(9, 12), NOW)).toBe("You edited 9:12");
    expect(recentLabel("opened", at(8, 40), NOW)).toBe("You opened 8:40");
    expect(recentLabel(undefined, at(8, 40), NOW)).toBe("8:40");
  });

  test("Home's recent tiles carry what they did", () => {
    const input: HomeInput = {
      notes: [
        { path: "a.md", updatedAt: NOW, title: "A", lede: null, tags: [] },
        { path: "b.md", updatedAt: NOW, title: "B", lede: null, tags: [] },
      ],
      folders: [],
      shared: new Set(),
      pins: [],
      opened: [],
      recents: [
        { path: "a.md", at: at(9), kind: "edited" },
        { path: "b.md", at: at(8) },
      ],
      tag: null,
      now: NOW,
    } as HomeInput;
    const home = buildHome(input);
    expect(home.recent.map((tile) => [tile.path, tile.seenKind])).toEqual([
      ["a.md", "edited"],
      ["b.md", undefined],
    ]);
  });

  test("⌘K lists the person's own Recent, saying what they did", () => {
    const items = accountRecentItems(
      [
        { path: "notes/plan.md", at: at(9, 12), kind: "edited" },
        { path: "folder", at: at(9) },
        { path: "todo.md", at: at(8, 40), kind: "opened" },
      ],
      [],
      (row) => recentLabel(row.kind, row.at, NOW),
    );
    expect(items.map((item) => [item.id, item.snippet])).toEqual([
      ["notes/plan.md", "You edited 9:12"],
      ["todo.md", "You opened 8:40"],
    ]);
  });
});

describe("the note says who changed it last, when it was not you", () => {
  test("their own AI is named", () => {
    expect(lastChangeOf([entry({ via: "Claude" })], "a.md", "@seyi", NOW)?.text).toBe("Claude changed this at 9:31");
  });

  test("a teammate, or a teammate's AI, is named as theirs", () => {
    expect(lastChangeOf([entry({ by: "@sayo" })], "a.md", "@seyi", NOW)?.text).toBe("@sayo changed this at 9:31");
    expect(lastChangeOf([entry({ by: "@sayo", via: "ChatGPT" })], "a.md", "@seyi", NOW)?.text).toBe(
      "@sayo's ChatGPT changed this at 9:31",
    );
  });

  test("their own hand says nothing, the app included", () => {
    expect(lastChangeOf([entry({})], "a.md", "@seyi", NOW)).toBeNull();
    expect(lastChangeOf([entry({ via: "Context (this app)" })], "a.md", "@seyi", NOW)).toBeNull();
  });

  test("the newest change speaks", () => {
    const older = entry({ via: "Claude", at: new Date(at(8)).toISOString() });
    const mine = entry({ at: new Date(at(10)).toISOString() });
    expect(lastChangeOf([older, mine], "a.md", "@seyi", NOW)).toBeNull();
    expect(lastChangeOf([mine, entry({ via: "Tex", at: new Date(at(11)).toISOString() })], "a.md", "@seyi", NOW)?.text).toBe(
      "Tex changed this at 11:00",
    );
  });

  test("a move is not a change of what it says, and other notes are not this one", () => {
    expect(lastChangeOf([entry({ via: "Claude", kind: "moved" })], "a.md", "@seyi", NOW)).toBeNull();
    expect(lastChangeOf([entry({ via: "Claude", paths: ["b.md"] })], "a.md", "@seyi", NOW)).toBeNull();
  });

  test("an earlier day says the day", () => {
    const monday = new Date(2026, 9, 12, 15).toISOString();
    expect(lastChangeOf([entry({ via: "Claude", at: monday })], "a.md", "@seyi", NOW)?.text).toBe("Claude changed this on Monday");
  });
});
