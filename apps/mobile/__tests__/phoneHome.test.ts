import { describe, expect, test } from "@jest/globals";
import { buildHome, countLabel, openedLabel, whenLabel, type HomeInput } from "../features/console/home/homeModel";

/**
 * The phone's Home (the Apple Notes style board approved 2026-09-30): what
 * each section holds, built from the device's copy of the workspace and the
 * person's own pins and opens.
 *
 * ## Sabotage record
 *
 * Applied, suite run, named test observed failing, reverted.
 *
 *  1. Pins not intersected with the tree.          → "a pin whose place is gone is not drawn"
 *  2. Counts direct children only.                 → "counts include everything inside"
 *  3. Dot folders counted.                         → "plumbing is never a folder or a note"
 *  4. Pinned folders left in You open most.        → "a pinned folder is not repeated"
 *  5. Tag filter ignored for folders.              → "a tag narrows every section"
 *  6. Recent sorted oldest first.                  → "recent is newest first, three of them"
 *  7. Top notes taken from every folder.           → "every note outside a folder is listed…"
 *  8. Tagged notes left to the root rule.         → "a tagged Home lists every note carrying the tag…"
 *  9. Archived notes counted under a tag.         → "a tagged Home lists every note carrying the tag…"
 * 10. Recent from updatedAt when the person has rows. → "with an account, recent is the notes this person was in…"
 * 11. Recent rows not intersected with the tree.   → "a recent note that is gone, archived or hidden is not drawn"
 */

const HOUR = 60 * 60 * 1000;
const NOW = Date.UTC(2026, 8, 30, 12);

function input(overrides: Partial<HomeInput> = {}): HomeInput {
  return {
    notes: [
      { path: "0-inbox/hiring.md", updatedAt: NOW - 3 * HOUR, title: "Hiring notes", lede: "Two designers", tags: [] },
      { path: "1-projects/launch.md", updatedAt: NOW - 2 * HOUR, title: "Launch plan", lede: "Press list", tags: ["launch"] },
      { path: "1-projects/site/copy.md", updatedAt: NOW - 30 * HOUR, title: "Site copy", lede: null, tags: ["launch"] },
      { path: "clients/acme/brief.md", updatedAt: NOW - HOUR, title: "Acme brief", lede: "They want the pilot", tags: ["client"] },
      { path: "clients/bloom.md", updatedAt: NOW - 50 * HOUR, title: "Bloom", lede: null, tags: ["client"] },
      { path: "index.md", updatedAt: NOW - 90 * HOUR, title: "Northwind", lede: null, tags: [] },
      { path: "privacy.md", updatedAt: NOW, title: "privacy", lede: null, tags: [] },
      { path: ".context/collaboration/x.md", updatedAt: NOW, title: "x", lede: null, tags: [] },
    ],
    folders: ["0-inbox", "1-projects", "1-projects/site", "clients", "clients/acme", "brand", ".context"],
    shared: new Set(["clients"]),
    pins: [],
    opened: [],
    recents: null,
    tag: null,
    now: NOW,
    ...overrides,
  };
}

describe("folders and counts", () => {
  test("every top-level folder, with counts that include everything inside", () => {
    const home = buildHome(input());
    expect(home.folders.map((f) => [f.path, f.notes, f.folders])).toEqual([
      ["0-inbox", 1, 0],
      ["1-projects", 2, 1],
      ["brand", 0, 0],
      ["clients", 2, 1],
    ]);
    expect(home.totals).toEqual({ folders: 4, notes: 6 });
  });

  test("plumbing is never a folder or a note", () => {
    const home = buildHome(input());
    expect(home.folders.map((f) => f.path)).not.toContain(".context");
    expect(home.recent.map((n) => n.path)).not.toContain("privacy.md");
    expect(home.recent.map((n) => n.path)).not.toContain(".context/collaboration/x.md");
  });

  test("a shared folder says so", () => {
    expect(buildHome(input()).folders.find((f) => f.path === "clients")?.shared).toBe(true);
  });
});

describe("notes at the top", () => {
  test("every note outside a folder is listed, by title, so none is out of reach", () => {
    const home = buildHome(
      input({
        notes: [
          ...input().notes,
          { path: "todo.md", updatedAt: NOW - 200 * HOUR, title: "Todo", lede: null, tags: ["launch"] },
          { path: "about.md", updatedAt: NOW - 300 * HOUR, title: "About us", lede: null, tags: [] },
        ],
      }),
    );
    expect(home.notes.map((n) => n.path)).toEqual(["about.md", "index.md", "todo.md"]);
  });

  test("a tag narrows them too", () => {
    const home = buildHome(
      input({
        tag: "launch",
        notes: [...input().notes, { path: "todo.md", updatedAt: NOW, title: "Todo", lede: null, tags: ["launch"] }],
      }),
    );
    expect(home.notes.map((n) => n.path)).toContain("todo.md");
    expect(home.notes.map((n) => n.path)).not.toContain("index.md");
  });
});

describe("recent", () => {
  test("with an account, recent is the notes this person was in, not the ones changed last", () => {
    const home = buildHome(
      input({
        recents: [
          { path: "index.md", at: NOW - 5 * HOUR },
          { path: "clients/bloom.md", at: NOW - 10 * 60 * 1000 },
          { path: "1-projects/site/copy.md", at: NOW - HOUR },
          { path: "0-inbox/hiring.md", at: NOW - 9 * HOUR },
        ],
      }),
    );
    // Acme brief changed last, by somebody else, and is not in this person's Recent.
    expect(home.recent.map((n) => [n.path, n.seenAt])).toEqual([
      ["clients/bloom.md", NOW - 10 * 60 * 1000],
      ["1-projects/site/copy.md", NOW - HOUR],
      ["index.md", NOW - 5 * HOUR],
    ]);
  });

  test("a recent note that is gone, archived or hidden is not drawn", () => {
    const home = buildHome(
      input({
        notes: [
          ...input().notes,
          { path: "4-archive/1-projects/old.md", updatedAt: NOW, title: "Old", lede: null, tags: [] },
        ],
        recents: [
          { path: "1-projects/moved-away.md", at: NOW },
          { path: "4-archive/1-projects/old.md", at: NOW - 1 },
          { path: "privacy.md", at: NOW - 2 },
          { path: "1-projects/launch.md", at: NOW - 3 },
        ],
      }),
    );
    expect(home.recent.map((n) => n.path)).toEqual(["1-projects/launch.md"]);
  });

  test("an account with no rows yet has an empty Recent, never somebody else's edits", () => {
    expect(buildHome(input({ recents: [] })).recent).toEqual([]);
  });

  test("recent is newest first, three of them", () => {
    expect(buildHome(input()).recent.map((n) => n.path)).toEqual([
      "clients/acme/brief.md",
      "1-projects/launch.md",
      "0-inbox/hiring.md",
    ]);
  });
});

describe("pins", () => {
  test("in the order given, as notes or folders with what they hold", () => {
    const home = buildHome(
      input({
        pins: [
          { path: "1-projects/launch.md", kind: "note" },
          { path: "clients", kind: "folder" },
        ],
      }),
    );
    expect(home.pinned.map((p) => [p.kind, p.path, p.title])).toEqual([
      ["note", "1-projects/launch.md", "Launch plan"],
      ["folder", "clients", "clients"],
    ]);
    const clients = home.pinned[1];
    expect(clients.kind === "folder" && [clients.notes, clients.folders]).toEqual([2, 1]);
  });

  test("a pin whose place is gone is not drawn", () => {
    const home = buildHome(
      input({
        pins: [
          { path: "gone.md", kind: "note" },
          { path: "old-folder", kind: "folder" },
          { path: "brand", kind: "folder" },
        ],
      }),
    );
    expect(home.pinned.map((p) => p.path)).toEqual(["brand"]);
  });

  test("a pin in the archive is not drawn", () => {
    const home = buildHome(
      input({
        notes: [
          ...input().notes,
          { path: "4-archive/2026-09-30/launch.md", updatedAt: NOW, title: "Launch plan", lede: null, tags: [] },
        ],
        pins: [{ path: "4-archive/2026-09-30/launch.md", kind: "note" }],
      }),
    );
    expect(home.pinned).toEqual([]);
  });
});

describe("you open most", () => {
  test("busiest first, only folders that exist, and a pinned folder is not repeated", () => {
    const home = buildHome(
      input({
        pins: [{ path: "clients", kind: "folder" }],
        opened: [
          { path: "clients", opens: 9, daysOpened: 5, lastAt: NOW },
          { path: "1-projects", opens: 6, daysOpened: 6, lastAt: NOW },
          { path: "nowhere", opens: 5, daysOpened: 2, lastAt: NOW },
          { path: "0-inbox", opens: 2, daysOpened: 2, lastAt: NOW },
        ],
      }),
    );
    expect(home.openMost.map((f) => f.path)).toEqual(["1-projects", "0-inbox"]);
  });

  test("says how often in plain words", () => {
    expect(openedLabel({ opens: 1, daysOpened: 1 })).toBe("Once lately");
    expect(openedLabel({ opens: 5, daysOpened: 3 })).toBe("5 times in 2 weeks");
    expect(openedLabel({ opens: 30, daysOpened: 12 })).toBe("Almost every day");
  });
});

describe("tags", () => {
  test("no tag, nothing tagged", () => {
    expect(buildHome(input()).tagged).toBeNull();
  });

  /*
    The bug behind removing the chips (2026-10-05): "Galatians 7", and the
    seven were nowhere — the count took every note, archived ones too, and the
    narrowed page listed three recent notes and some folders. A tag's count and
    its list are now the same notes.
  */
  test("a tagged Home lists every note carrying the tag, and counts exactly those", () => {
    const home = buildHome(
      input({
        tag: "launch",
        notes: [
          ...input().notes,
          { path: "4-archive/2026-09-30/old-launch.md", updatedAt: NOW, title: "Old launch", lede: null, tags: ["launch"] },
        ],
      }),
    );
    expect(home.notes.map((n) => [n.path, n.place])).toEqual([
      ["1-projects/launch.md", "projects"],
      ["1-projects/site/copy.md", "site"],
    ]);
    expect(home.tagged).toEqual({ tag: "launch", count: home.notes.length });
  });

  test("a tag narrows every section", () => {
    const home = buildHome(
      input({
        tag: "client",
        pins: [
          { path: "1-projects/launch.md", kind: "note" },
          { path: "clients", kind: "folder" },
        ],
        opened: [
          { path: "1-projects", opens: 6, daysOpened: 6, lastAt: NOW },
          { path: "clients/acme", opens: 2, daysOpened: 2, lastAt: NOW },
        ],
      }),
    );
    expect(home.pinned.map((p) => p.path)).toEqual(["clients"]);
    expect(home.openMost.map((f) => f.path)).toEqual(["clients/acme"]);
    expect(home.recent.map((n) => n.path)).toEqual(["clients/acme/brief.md", "clients/bloom.md"]);
    expect(home.folders.map((f) => [f.path, f.notes])).toEqual([["clients", 2]]);
  });
});

describe("labels", () => {
  test("a recent note's time: clock today, weekday this week, date before that", () => {
    const now = new Date(2026, 8, 30, 15, 0).getTime();
    expect(whenLabel(new Date(2026, 8, 30, 9, 5).getTime(), now)).toBe("9:05");
    expect(whenLabel(new Date(2026, 8, 28, 9, 5).getTime(), now)).toBe("Mon");
    expect(whenLabel(new Date(2026, 8, 12, 9, 5).getTime(), now)).toBe("Sep 12");
    expect(whenLabel(new Date(2025, 11, 2, 9, 5).getTime(), now)).toBe("Dec 2, 2025");
  });

  test("what a folder holds, in words", () => {
    expect(countLabel(14, 3)).toBe("14 notes · 3 folders");
    expect(countLabel(1, 0)).toBe("1 note");
    expect(countLabel(0, 1)).toBe("1 folder");
    expect(countLabel(0, 0)).toBe("Empty");
  });
});
