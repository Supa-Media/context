/**
 * THE CARD A TAPPED DOT OPENS.
 *
 * Tapping a note on the map no longer leaves the map: a card opens beside the
 * dot with the note's words, who is writing it and who is reading it, and
 * what is being typed shows up as it is typed. These are the pure parts: the
 * note cut into blocks, which blocks changed since the last read, who is on
 * the note, where the card sits, and what the map remembers for Back.
 * Fake names only.
 */
import { describe, expect, test } from "@jest/globals";
import {
  PEEK_READ_MS,
  PEEK_WRITING_READ_MS,
  changedBlocks,
  lastWritten,
  peekBlocks,
  peekCrumbs,
  peekPlacement,
  peekPresence,
  presenceChips,
} from "../features/console/map/live/peek/peekModel";
import { forgetMapMemory, mapMemoryKey, recallMap, rememberCamera, rememberPeek } from "../features/console/map/live/peek/mapMemory";
import type { MapActor } from "../features/console/map/live/engine/timeline";

const NOTE = { workspaceId: "ws-p", path: "1-projects/launch.md" };

describe("the note, as blocks a small card can draw", () => {
  test("front matter is dropped and headings, paragraphs, list items and code are kept apart", () => {
    const text = [
      "---",
      "status: In progress",
      "---",
      "# Q4 launch plan",
      "",
      "Ship the iOS app to the waitlist.",
      "Open sign-ups for teams.",
      "",
      "## Pricing",
      "- One plan at $5",
      "- Own bucket stays free",
      "",
      "```",
      "not a heading",
      "# still code",
      "```",
    ].join("\n");
    expect(peekBlocks(text)).toEqual([
      { kind: "heading", level: 1, text: "Q4 launch plan" },
      { kind: "paragraph", text: "Ship the iOS app to the waitlist. Open sign-ups for teams." },
      { kind: "heading", level: 2, text: "Pricing" },
      { kind: "item", text: "One plan at $5" },
      { kind: "item", text: "Own bucket stays free" },
      { kind: "code", text: "not a heading\n# still code" },
    ]);
  });

  test("an empty note, or one that is only front matter, has no blocks", () => {
    expect(peekBlocks("")).toEqual([]);
    expect(peekBlocks("---\ntags: [a]\n---\n")).toEqual([]);
  });

  test("an unclosed code fence still shows what was typed", () => {
    expect(peekBlocks("```\nhalf typed")).toEqual([{ kind: "code", text: "half typed" }]);
  });

  test("a numbered list and a checklist are items too", () => {
    expect(peekBlocks("1. First\n- [x] Done\n* Star")).toEqual([
      { kind: "item", text: "First" },
      { kind: "item", text: "Done" },
      { kind: "item", text: "Star" },
    ]);
  });
});

describe("what changed since the last read, for the live view", () => {
  const before = peekBlocks("# Plan\n\nWeek 1: TestFlight.\n\n## Pricing\n\nOne plan.");

  test("a block typed into is marked, and the rest are not", () => {
    const after = peekBlocks("# Plan\n\nWeek 1: TestFlight. Week 2: fixes.\n\n## Pricing\n\nOne plan.");
    expect(changedBlocks(before, after)).toEqual([1]);
  });

  test("a new block at the end is marked", () => {
    const after = peekBlocks("# Plan\n\nWeek 1: TestFlight.\n\n## Pricing\n\nOne plan.\n\nAnnual waits.");
    expect(changedBlocks(before, after)).toEqual([4]);
  });

  test("a block inserted in the middle marks only itself, not everything after it", () => {
    const after = peekBlocks("# Plan\n\nGoals first.\n\nWeek 1: TestFlight.\n\n## Pricing\n\nOne plan.");
    expect(changedBlocks(before, after)).toEqual([1]);
  });

  test("the first read marks nothing: nothing has been typed while you watched", () => {
    expect(changedBlocks(null, before)).toEqual([]);
  });

  test("an unchanged note marks nothing", () => {
    expect(changedBlocks(before, peekBlocks("# Plan\n\nWeek 1: TestFlight.\n\n## Pricing\n\nOne plan."))).toEqual([]);
  });
});

describe("who is on the note", () => {
  const actor = (over: Partial<MapActor>): MapActor => ({
    id: "a",
    kind: "agent",
    name: "@maya's Claude",
    path: NOTE.path,
    doing: "edit",
    at: 1,
    workspaceId: NOTE.workspaceId,
    ...over,
  });

  test("writers and readers of this note, and nobody elsewhere", () => {
    const actors = [
      actor({ id: "w", name: "@maya's Claude", doing: "edit" }),
      actor({ id: "c", name: "ChatGPT", doing: "create" }),
      actor({ id: "r", name: "Jon", kind: "person", doing: "read" }),
      actor({ id: "x", name: "Elsewhere", doing: "edit", path: "2-areas/other.md" }),
      actor({ id: "y", name: "Other workspace", doing: "edit", workspaceId: "ws-s" }),
      actor({ id: "i", name: "Idle", doing: "idle" }),
    ];
    expect(peekPresence(actors, NOTE)).toEqual({ writers: ["@maya's Claude", "ChatGPT"], readers: ["Jon"] });
  });

  test("a tool that read the note as part of a search is reading it", () => {
    const actors = [actor({ id: "s", name: "Claude", doing: "read", path: "2-areas/other.md", reads: ["2-areas/other.md", NOTE.path] })];
    expect(peekPresence(actors, NOTE)).toEqual({ writers: [], readers: ["Claude"] });
  });

  test("you are not listed on your own card", () => {
    expect(peekPresence([actor({ self: true, kind: "person", name: "Seyi" })], NOTE)).toEqual({ writers: [], readers: [] });
  });

  test("somebody both writing and reading is only writing", () => {
    expect(peekPresence([actor({ doing: "edit", reads: [NOTE.path] })], NOTE)).toEqual({ writers: ["@maya's Claude"], readers: [] });
  });

  test("the chips say it in words", () => {
    expect(presenceChips({ writers: ["@maya's Claude"], readers: ["ChatGPT", "Jon"] })).toEqual([
      { kind: "writing", text: "@maya's Claude is writing" },
      { kind: "reading", text: "ChatGPT is reading" },
      { kind: "reading", text: "Jon is reading" },
    ]);
    expect(presenceChips({ writers: ["A", "B", "C", "D"], readers: [] })).toEqual([
      { kind: "writing", text: "A is writing" },
      { kind: "writing", text: "B is writing" },
      { kind: "writing", text: "2 more are writing" },
    ]);
  });

  test("the note is read again often while somebody writes it, and seldom otherwise", () => {
    expect(PEEK_WRITING_READ_MS).toBeLessThan(PEEK_READ_MS);
    expect(PEEK_WRITING_READ_MS).toBeLessThanOrEqual(3_000);
  });
});

describe("when it was last written", () => {
  test("the latest edit or creation of this note, not a read and not another note", () => {
    const actor = { id: "a", kind: "agent" as const, name: "Claude" };
    const events = [
      { kind: "create" as const, at: 10, workspaceId: NOTE.workspaceId, path: NOTE.path, actor },
      { kind: "edit" as const, at: 30, workspaceId: NOTE.workspaceId, path: NOTE.path, actor },
      { kind: "read" as const, at: 50, workspaceId: NOTE.workspaceId, path: NOTE.path, actor },
      { kind: "edit" as const, at: 60, workspaceId: "ws-s", path: NOTE.path, actor },
      { kind: "edit" as const, at: 70, workspaceId: NOTE.workspaceId, path: "other.md", actor },
    ];
    expect(lastWritten(events, NOTE)).toBe(30);
    expect(lastWritten([], NOTE)).toBeNull();
  });
});

describe("the card's header", () => {
  test("the folders the note is in, in words", () => {
    expect(peekCrumbs("1-projects/launch-plan/q4.md")).toEqual("Projects › Launch plan");
    expect(peekCrumbs("index.md")).toEqual("");
  });
});

describe("where the card sits", () => {
  const box = { width: 1200, height: 700 };
  const card = { width: 380, height: 460 };

  test("to the right of the dot, with room between them", () => {
    const at = peekPlacement({ x: 400, y: 300 }, box, card);
    expect(at.left).toBeGreaterThan(400);
    expect(at.top).toBeLessThanOrEqual(300);
  });

  test("to the left when the right edge has no room", () => {
    const at = peekPlacement({ x: 1100, y: 300 }, box, card);
    expect(at.left + card.width).toBeLessThan(1100);
  });

  test("always inside the canvas, whatever the tap", () => {
    for (const p of [{ x: 0, y: 0 }, { x: 1200, y: 700 }, { x: 600, y: 690 }, { x: 5, y: 650 }]) {
      const at = peekPlacement(p, box, card);
      expect(at.left).toBeGreaterThanOrEqual(12);
      expect(at.top).toBeGreaterThanOrEqual(12);
      expect(at.left + card.width).toBeLessThanOrEqual(box.width - 12);
      expect(at.top + card.height).toBeLessThanOrEqual(box.height - 12);
    }
  });

  test("a canvas smaller than the card pins it to the corner rather than off screen", () => {
    expect(peekPlacement({ x: 100, y: 100 }, { width: 300, height: 300 }, card)).toEqual({ left: 12, top: 12 });
  });

  test("with no tap point (coming back to the map) it sits at the top right", () => {
    const at = peekPlacement(null, box, card);
    expect(at.left + card.width).toBe(box.width - 12);
    expect(at.top).toBe(12);
  });
});

describe("what the map remembers for Back", () => {
  test("the camera and the open card come back for the same workspace and scope", () => {
    const key = mapMemoryKey("ws-p", "one");
    forgetMapMemory();
    rememberCamera(key, { x: 10, y: 20, s: 3 });
    rememberPeek(key, NOTE);
    expect(recallMap(key)).toEqual({ cam: { x: 10, y: 20, s: 3 }, peek: NOTE });
  });

  test("another workspace or scope remembers its own", () => {
    forgetMapMemory();
    rememberCamera(mapMemoryKey("ws-p", "one"), { x: 1, y: 1, s: 1 });
    expect(recallMap(mapMemoryKey("ws-s", "one"))).toEqual({ cam: null, peek: null });
    expect(recallMap(mapMemoryKey("ws-p", "all"))).toEqual({ cam: null, peek: null });
  });

  test("closing the card forgets it, and keeps the camera", () => {
    const key = mapMemoryKey("ws-p", "one");
    forgetMapMemory();
    rememberCamera(key, { x: 1, y: 2, s: 3 });
    rememberPeek(key, NOTE);
    rememberPeek(key, null);
    expect(recallMap(key)).toEqual({ cam: { x: 1, y: 2, s: 3 }, peek: null });
  });
});
