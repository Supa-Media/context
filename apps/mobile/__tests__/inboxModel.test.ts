import { describe, expect, test } from "@jest/globals";
import { CONSOLE_CLIENT_NAME } from "@context/shared/src/activityActors.cjs";
import type { HomeFolder, HomeNote } from "../features/console/home/homeModel";
import {
  buildInbox,
  humanEdits,
  inboxCount,
  inboxGroupOf,
  inboxWhen,
  placeOf,
  type InboxActivity,
} from "../features/console/home/inboxModel";

/**
 * The phone's first page, Inbox (leadership weekly, 2026-10-17; boards 1 and 2
 * of `meeting-2026-10-17/phone-inbox/`): Pinned, the notes people wrote by
 * hand under Apple Notes' date headings (Dev2, 2026-10-18), what was filed
 * today and where, and which folders get a dot.
 *
 * SABOTAGE: dropping the `clientOf(entry.via) !== null` check in `humanEdits`
 * lists a note only an AI wrote; dropping the move carry-over loses a note a
 * person wrote and an agent then filed.
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

function inbox(
  entries: InboxActivity[],
  folders: HomeFolder[] = [],
  openMost: HomeFolder[] = [],
  extra: Partial<Parameters<typeof buildInbox>[0]> = {},
) {
  return buildInbox({
    notes: NOTES,
    ...extra,
    home: { folders, openMost: openMost as never },
    entries,
    isMe: (by) => by === "@seyi",
    now: NOW,
  });
}

const wrote = (when: string, paths: string[], who: Partial<InboxActivity> = {}): InboxActivity => ({
  at: when,
  kind: "revised",
  by: "@seyi",
  via: null,
  paths,
  ...who,
});

describe("the notes people wrote by hand", () => {
  test("are only the notes a person's own hand changed, newest first, from any folder", () => {
    const { groups } = inbox([
      wrote(at(9), ["0-inbox/sermon.md"]),
      wrote(at(10), ["1-projects/dc-chapter.md"], { via: "Context (this app)", by: "@sayo" }),
      wrote(at(11), ["2-areas/preaching/advent.md"], { via: "Claude" }),
      wrote(at(12), ["0-inbox/old-idea.md"], { via: "Tex", kind: "added" }),
    ]);
    expect(groups.map((group) => [group.label, group.notes.map((row) => [row.title, row.folder])])).toEqual([
      ["Today", [["DC chapter", "projects"], ["Sermon thoughts", "inbox"]]],
    ]);
  });

  test("are dated by the hand's last edit, not by an AI's later write", () => {
    const edits = humanEdits(
      [wrote(at(9, 0, 1), ["1-projects/dc-chapter.md"]), wrote(at(12), ["1-projects/dc-chapter.md"], { via: "Claude" })],
      [],
    );
    expect(edits.get("1-projects/dc-chapter.md")).toBe(Date.parse(at(9, 0, 1)));
  });

  test("keep a note a person wrote after an agent filed it", () => {
    const { groups } = inbox([
      wrote(at(9), ["0-inbox/advent.md"]),
      moved(at(10), [["0-inbox/advent.md", "2-areas/preaching/advent.md"]], { via: "Tex" }),
    ]);
    expect(groups[0]?.notes.map((row) => [row.path, row.folder])).toEqual([["2-areas/preaching/advent.md", "preaching"]]);
  });

  test("include what this person's app marked edited, and not what they only opened", () => {
    const { groups } = inbox([], [], [], {
      recents: [
        { path: "1-projects/moved-twice.md", at: new Date(2026, 9, 2).getTime(), kind: "edited" },
        { path: "1-projects/dc-chapter.md", at: NOW, kind: "opened" },
      ],
    });
    expect(groups.map((group) => [group.label, group.notes.map((row) => row.title)])).toEqual([
      ["Previous 30 Days", ["Moved twice"]],
    ]);
  });

  test("leave pinned notes to Pinned, which says where each is", () => {
    const result = inbox([wrote(at(9), ["0-inbox/sermon.md"])], [], [], {
      pins: [
        { path: "0-inbox/sermon.md", kind: "note" },
        { path: "2-areas/preaching/advent.md", kind: "note" },
        { path: "2-areas", kind: "folder" },
      ],
    });
    expect(result.pinned.map((row) => [row.title, row.folder])).toEqual([
      ["Sermon thoughts", "inbox"],
      ["Advent series", "preaching"],
    ]);
    expect(result.groups).toEqual([]);
  });

  test("the headings are Apple Notes' own", () => {
    expect(inboxGroupOf(new Date(2026, 9, 17, 1).getTime(), NOW)).toBe("Today");
    expect(inboxGroupOf(new Date(2026, 9, 16).getTime(), NOW)).toBe("Yesterday");
    expect(inboxGroupOf(new Date(2026, 9, 12).getTime(), NOW)).toBe("Previous 7 Days");
    expect(inboxGroupOf(new Date(2026, 8, 20).getTime(), NOW)).toBe("Previous 30 Days");
    expect(inboxGroupOf(new Date(2026, 7, 3).getTime(), NOW)).toBe("August");
    expect(inboxGroupOf(new Date(2025, 11, 3).getTime(), NOW)).toBe("2025");
  });

  test("the count still counts every note in the Inbox, whoever wrote it", () => {
    expect(inbox([]).count).toBe(2);
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
    expect(inboxCount(0, 3)).toBe("Inbox empty · 3 filed today");
    expect(inboxCount(1, 0)).toBe("1 in the Inbox");
    expect(inboxCount(5, 2)).toBe("5 in the Inbox · 2 filed today");
  });
});
