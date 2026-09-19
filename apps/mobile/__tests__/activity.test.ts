/**
 * THE VIEWING LAYER'S ARITHMETIC — `features/console/activity/activity.ts`.
 *
 * The file's format is proven in the gateway and the control plane. What is
 * proven here is the half a person actually looks at: which row carries a dot,
 * what the foot line says, where the unread marker sits, and what a row reads
 * as.
 *
 * The rules that carry weight are the two that are easy to get subtly wrong and
 * impossible to notice afterwards:
 *
 *  1. **A dot moves inward when a folder is opened.** The obvious
 *     implementation marks every ancestor, which lights the path to the root
 *     permanently and makes the mark mean "this context has notes".
 *  2. **The unread line is a position, not a filter.** Catching up must leave
 *     every row where it was.
 *
 * ## Sabotage record
 *
 * Applied, both activity suites run, reverted. Counts are failing tests across
 * `activity.test.ts` and `activityRender.test.ts` together, 36 in total.
 *
 *   `markedRows` marking every ancestor                   4 failed
 *   `markedRows` marking only the note                    4 failed
 *   `footLabel` ignoring the `counts` fallback            1 failed
 *   `rows` dropping the unread marker                     1 failed
 *   `unseenCount` treating `null` as zero                 1 failed
 *   `targetOf` taking the source of a move                1 failed
 *
 * The two `markedRows` rows are the pair worth reading: the rule has two ways
 * to be wrong and each fails a different four, which is what says the tests
 * describe the rule rather than one side of it.
 */

import { describe, expect, test } from "@jest/globals";
import {
  footLabel,
  markFor,
  markedRows,
  relativeWhen,
  rowText,
  rows,
  targetOf,
  unseenCount,
  unseenNotePaths,
  type ActivityEntry,
} from "../features/console/activity/activity";

const NOW = Date.parse("2026-09-19T17:00:00.000Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function entry(overrides: Partial<ActivityEntry> = {}): ActivityEntry {
  return {
    at: at(-60_000),
    kind: "added",
    paths: ["1-projects/alpha/notes.md"],
    n: 1,
    vis: "team",
    by: "@sayo",
    via: "Claude",
    note: null,
    ...overrides,
  };
}

describe("the dot in the tree", () => {
  const unseen = new Set(["1-projects/alpha/notes.md"]);

  test("marks the nearest collapsed folder", () => {
    expect([...markedRows(unseen, new Set())]).toEqual(["1-projects"]);
  });

  test("moves inward as the tree is opened", () => {
    expect([...markedRows(unseen, new Set(["1-projects"]))]).toEqual([
      "1-projects/alpha",
    ]);
    expect([
      ...markedRows(unseen, new Set(["1-projects", "1-projects/alpha"])),
    ]).toEqual(["1-projects/alpha/notes.md"]);
  });

  test("never lights the whole path at once", () => {
    const marked = markedRows(unseen, new Set(["1-projects"]));
    expect(marked.has("1-projects")).toBe(false);
    expect(marked.size).toBe(1);
  });

  test("a note at the root is marked as itself", () => {
    expect([...markedRows(new Set(["index.md"]), new Set())]).toEqual(["index.md"]);
  });

  test("two notes under one collapsed folder are one dot", () => {
    const marked = markedRows(
      new Set(["1-projects/a.md", "1-projects/b.md"]),
      new Set(),
    );
    expect([...marked]).toEqual(["1-projects"]);
  });
});

describe("what is new to this reader", () => {
  const entries = [entry({ at: at(-60_000) }), entry({ at: at(-7_200_000) })];

  test("everything, for somebody who has never looked", () => {
    expect(unseenCount(entries, null)).toBe(2);
  });

  test("and only what came after, for somebody returning", () => {
    expect(unseenCount(entries, NOW - 600_000)).toBe(1);
  });

  test("nothing, once they have caught up", () => {
    expect(unseenCount(entries, NOW)).toBe(0);
  });

  test("only note paths are offered to the tree", () => {
    const paths = unseenNotePaths(
      [entry({ paths: ["1-projects/triage", "1-projects/backlog/triage"] }), entry()],
      null,
    );
    expect([...paths]).toEqual(["1-projects/alpha/notes.md"]);
  });
});

describe("your own hand", () => {
  const mine = entry({ by: "@me", via: null });
  const myClient = entry({ by: "@me", via: "ChatGPT" });
  const theirs = entry({ by: "@sayo", via: null });

  test("is not news to you, however long ago you last looked", () => {
    expect(unseenCount([mine, theirs], null, "@me")).toBe(1);
  });

  test("but your own client is, because you were not watching it", () => {
    expect(unseenCount([myClient], null, "@me")).toBe(1);
  });

  test("and a console with no name for you counts everything, which is the safe way to be wrong", () => {
    expect(unseenCount([mine, theirs], null, null)).toBe(2);
  });

  test("your own note carries no dot in the tree", () => {
    expect(
      unseenNotePaths([mine], null, "@me").has("1-projects/alpha/notes.md"),
    ).toBe(false);
  });
});

describe("the line at the foot of the tree", () => {
  const counts = "12 notes, 8 folders";

  test("is the note count when there is nothing new", () => {
    expect(footLabel({ unseen: 0, since: NOW, counts, now: NOW })).toBe(counts);
  });

  test("counts one update without pluralising it", () => {
    expect(footLabel({ unseen: 1, since: NOW - 600_000, counts, now: NOW })).toBe(
      "1 update since you looked",
    );
  });

  test("stops counting past fifty", () => {
    expect(footLabel({ unseen: 51, since: NOW - 600_000, counts, now: NOW })).toContain(
      "50+ updates",
    );
  });

  test("names the day for somebody who has been away", () => {
    const since = NOW - 3 * 24 * 60 * 60 * 1000;
    expect(footLabel({ unseen: 4, since, counts, now: NOW })).toBe(
      "4 updates since Wednesday",
    );
  });

  test("says nothing about when, for somebody who has never looked", () => {
    expect(footLabel({ unseen: 4, since: null, counts, now: NOW })).toBe("4 updates");
  });
});

describe("the list", () => {
  const entries = [
    entry({ at: at(-60_000), paths: ["1-projects/new.md"] }),
    entry({ at: at(-26 * 60 * 60 * 1000), paths: ["1-projects/old.md"] }),
  ];

  test("carries a day heading before each day", () => {
    const drawn = rows(entries, null, NOW);
    expect(drawn.filter((row) => row.kind === "day").map((row) => (row as { label: string }).label)).toEqual([
      "Today",
      "Yesterday",
    ]);
  });

  test("labels the marker as a place in the list, not as a time", () => {
    const drawn = rows(entries, NOW - 600_000, NOW);
    const marker = drawn.find((row) => row.kind === "unread");
    expect(marker).toBeDefined();
    expect((marker as { label: string }).label).toBe("Earlier");
  });

  test("puts the unread marker between what is new and what is not", () => {
    const drawn = rows(entries, NOW - 600_000, NOW);
    const kinds = drawn.map((row) => row.kind);
    expect(kinds).toContain("unread");
    // The marker sits after the first entry and before the second — and both
    // entries are still in the list, because catching up is not a filter.
    expect(kinds.indexOf("unread")).toBeGreaterThan(kinds.indexOf("entry"));
    expect(drawn.filter((row) => row.kind === "entry")).toHaveLength(2);
  });

  test("draws no marker when everything is already read", () => {
    expect(rows(entries, NOW, NOW).some((row) => row.kind === "unread")).toBe(false);
  });

  test("draws no marker when everything is new, because it would mark nothing", () => {
    expect(rows(entries, null, NOW).some((row) => row.kind === "unread")).toBe(false);
  });
});

describe("a row", () => {
  test("names the note rather than spending the column on its path", () => {
    const { title, meta } = rowText(entry());
    expect(title).toBe("@sayo's Claude added notes");
    // The path is not lost, it is demoted: the line above says what, the line
    // below says where, which is the order the tree beside it already uses.
    // And named the way the tree names it: no sort number, no `.md`.
    expect(meta).toBe("projects/alpha");
    expect(title).not.toContain("`");
  });

  test("a meeting names the meeting, not the folder it landed in", () => {
    const { title } = rowText(
      entry({ kind: "meeting", paths: ["0-inbox/meetings/2026-09-19-steering.md"], by: null, via: null }),
    );
    expect(title).toBe("A meeting landed: 2026-09-19-steering");
  });

  test("a group of notes names the folder it landed in", () => {
    const { title } = rowText(entry({ n: 3, paths: ["1-projects/fixes/a.md"] }));
    expect(title).toBe("@sayo's Claude added 3 notes to fixes");
  });

  test("prefers the agent's own sentence to a folder path", () => {
    expect(rowText(entry({ note: "recorded the rename" })).meta).toBe(
      "recorded the rename",
    );
  });

  test("opens the destination of a move, not the source", () => {
    expect(
      targetOf(entry({ kind: "moved", paths: ["1-projects/a.md", "5-archive/a.md"] })),
    ).toBe("5-archive/a.md");
  });

  test("opens nothing when the thing that changed was a folder", () => {
    expect(targetOf(entry({ kind: "moved", paths: ["1-projects", "5-archive"] }))).toBeNull();
  });

  test("falls back to a mark it can draw rather than drawing nothing", () => {
    expect(markFor(entry({ kind: "something-a-later-build-invented" }))).toBe("revised");
  });
});

describe("how long ago", () => {
  test("is minutes, then hours, then the weekday, then the date", () => {
    expect(relativeWhen(at(-30_000), NOW)).toBe("just now");
    expect(relativeWhen(at(-4 * 60_000), NOW)).toBe("4 min");
    expect(relativeWhen(at(-5 * 60 * 60_000), NOW)).toBe("5h");
    expect(relativeWhen(at(-3 * 24 * 60 * 60_000), NOW)).toBe("Wed");
    expect(relativeWhen(at(-30 * 24 * 60 * 60_000), NOW)).toBe("20 Aug");
  });
});
