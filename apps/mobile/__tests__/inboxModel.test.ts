import { describe, expect, test } from "@jest/globals";
import { CONSOLE_CLIENT_NAME } from "@context/shared/src/activityActors.cjs";
import type { HomeFolder, HomeNote } from "../features/console/home/homeModel";
import {
  buildInbox,
  inboxCount,
  inboxWhen,
  placeOf,
  type InboxActivity,
} from "../features/console/home/inboxModel";

/**
 * The phone's first page, Inbox (leadership weekly, 2026-10-17; boards 1 and 2
 * of `meeting-2026-10-17/phone-inbox/`): what is loose, what was filed today
 * and where, and which folders get a dot.
 *
 * SABOTAGE: dropping the `parentPath(from) === INBOX_FOLDER` check lets a move
 * between two folders into Filed today; dropping the `at >= today` check lets
 * yesterday's; dropping the archive filter puts Archive in the dots.
 */

const NOW = new Date(2026, 9, 17, 15, 0).getTime();
const at = (hours: number, minutes = 0, day = 17) => new Date(2026, 9, day, hours, minutes).toISOString();

const note = (path: string, title: string, updatedAt?: number): HomeNote => ({
  path,
  title,
  lede: `${title} lede`,
  tags: [],
  ...(updatedAt === undefined ? {} : { updatedAt }),
});
const folder = (path: string): HomeFolder => ({ kind: "folder", path, title: path, notes: 1, folders: 0, shared: false });

const NOTES = [
  note("0-inbox/old-idea.md", "Old idea", new Date(2026, 9, 12).getTime()),
  note("0-inbox/sermon.md", "Sermon thoughts", new Date(2026, 9, 17, 11, 42).getTime()),
  note("0-inbox/inner/deeper.md", "Deeper"),
  note("2-areas/preaching/advent.md", "Advent series"),
  note("1-projects/dc-chapter.md", "DC chapter"),
  note("1-projects/moved-twice.md", "Moved twice"),
];

const moved = (when: string, moves: [string, string][], who: Partial<InboxActivity> = {}): InboxActivity => ({
  at: when,
  kind: "moved",
  by: "@seyi",
  via: null,
  moves,
  ...who,
});

function inbox(entries: InboxActivity[], folders: HomeFolder[] = [], openMost: HomeFolder[] = []) {
  return buildInbox({
    notes: NOTES,
    home: { folders, openMost: openMost as never },
    entries,
    isMe: (by) => by === "@seyi",
    now: NOW,
  });
}

describe("loose notes", () => {
  test("are the notes lying in the Inbox itself, newest first", () => {
    expect(inbox([]).loose.map((row) => row.title)).toEqual(["Sermon thoughts", "Old idea"]);
  });
});

describe("filed today", () => {
  test("lists a note moved out of the Inbox today, where it went and who moved it", () => {
    const filed = inbox([
      moved(at(9), [["0-inbox/advent.md", "2-areas/preaching/advent.md"]], { via: "Tex" }),
      moved(at(10), [["0-inbox/dc.md", "1-projects/dc-chapter.md"]]),
    ]).filed;
    expect(filed.map((row) => [row.title, row.place, row.who])).toEqual([
      ["DC chapter", "projects", "you"],
      ["Advent series", "areas › preaching", "Tex"],
    ]);
  });

  test("leaves out yesterday, moves between other folders, and moves within the Inbox", () => {
    const filed = inbox([
      moved(at(9, 0, 16), [["0-inbox/advent.md", "2-areas/preaching/advent.md"]]),
      moved(at(9), [["2-areas/dc.md", "1-projects/dc-chapter.md"]]),
      moved(at(9), [["0-inbox/x.md", "0-inbox/old-idea.md"]]),
      { at: at(9), kind: "edited", by: "@seyi", via: null },
    ]).filed;
    expect(filed).toEqual([]);
  });

  test("draws a note where it is now, once, and not at all once it is gone", () => {
    const filed = inbox([
      moved(at(12), [["0-inbox/twice.md", "1-projects/moved-twice.md"]]),
      moved(at(11), [["0-inbox/twice.md", "1-projects/moved-twice.md"]]),
      moved(at(10), [["0-inbox/gone.md", "1-projects/deleted-since.md"]]),
    ]).filed;
    expect(filed.map((row) => row.path)).toEqual(["1-projects/moved-twice.md"]);
  });

  test("a move made in the app itself is yours, not the app's", () => {
    const filed = inbox([moved(at(9), [["0-inbox/dc.md", "1-projects/dc-chapter.md"]], { via: CONSOLE_CLIENT_NAME })]).filed;
    expect(filed[0]?.who).toBe("you");
  });

  test("names someone else by handle", () => {
    const filed = inbox([moved(at(9), [["0-inbox/dc.md", "1-projects/dc-chapter.md"]], { by: "@sayo" })]).filed;
    expect(filed[0]?.who).toBe("@sayo");
  });
});

describe("folder dots", () => {
  test("open-most first, then the rest, never the Inbox or Archive, at most five", () => {
    const folders = ["0-inbox", "1-projects", "2-areas", "3-resources", "4-archive", "5-a", "6-b", "7-c"].map(folder);
    const dots = inbox([], folders, [folder("3-resources"), folder("2-areas/preaching")]).dots;
    expect(dots.map((dot) => dot.path)).toEqual(["3-resources", "1-projects", "2-areas", "5-a", "6-b"]);
  });
});

describe("the words", () => {
  test("place is every folder above the note, by its own name", () => {
    expect(placeOf("2-areas/people/ana/notes.md")).toBe("areas › people › ana");
  });

  test("when reads as board 1 does", () => {
    expect(inboxWhen(new Date(2026, 9, 17, 9, 5).getTime(), NOW)).toBe("9:05");
    expect(inboxWhen(new Date(2026, 9, 16, 9).getTime(), NOW)).toBe("Yesterday");
    expect(inboxWhen(new Date(2026, 9, 13, 9).getTime(), NOW)).toBe("Tuesday");
    expect(inboxWhen(new Date(2026, 8, 12, 9).getTime(), NOW)).toBe("Sep 12");
    expect(inboxWhen(new Date(2025, 8, 12, 9).getTime(), NOW)).toBe("Sep 12, 2025");
  });

  test("the count under the title", () => {
    expect(inboxCount(0, 3)).toBe("Nothing loose");
    expect(inboxCount(1, 0)).toBe("1 loose note");
    expect(inboxCount(5, 2)).toBe("5 loose notes · 2 filed today");
  });
});
