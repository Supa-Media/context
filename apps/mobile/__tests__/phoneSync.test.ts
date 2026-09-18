/**
 * What a phone is told about sync, without a renderer.
 *
 * A phone has no status strip (`frame.ts` answers `statusBar: false` at
 * compact), so until the header pill existed the three states `copy.ts` words
 * — Offline, "N notes waiting to sync", "N notes need you" — reached no surface
 * a phone could see. These are the rules for the pill, the sheet behind it and
 * the per-row marks, as pure functions; `phoneSyncRender.test.ts` mounts them.
 *
 * The negative case is the one worth the most: the pill is **absent** while
 * online with nothing waiting, and absent while the platform has not said. A
 * pill that is always there is a pill nobody reads.
 */

import { describe, expect, test } from "@jest/globals";
import {
  compactSync,
  loudSave,
  saveChip,
  statusSegments,
  syncSegments,
  syncSheetSections,
  type StatusSegment,
} from "../features/console/files/status";
import { emptyEditor, type EditorState } from "../features/console/files/editor";
import {
  describeSyncMark,
  NO_PENDING,
  pendingMarks,
} from "../features/console/files/pendingMarks";
import type { SyncFacts } from "../features/offline/copy";
import type { PendingWrite } from "../features/offline/outbox";

const NOW = new Date(2026, 2, 12, 12, 0, 0).getTime();

function sync(overrides: Partial<SyncFacts> = {}): SyncFacts {
  return {
    reachability: "online",
    counts: { pending: 0, conflicted: 0, rejected: 0 },
    durable: true,
    ready: true,
    ...overrides,
  };
}

function editor(extra: Partial<EditorState>): EditorState {
  return {
    ...emptyEditor,
    status: "clean",
    path: "1-projects/plan.md",
    baseline: "x",
    draft: "x",
    etag: "e1",
    ...extra,
  };
}

function chip(extra: Partial<EditorState>): StatusSegment | null {
  return saveChip({ editor: editor(extra), now: NOW });
}

function write(path: string, state: PendingWrite["state"], queuedAt: number) {
  return { path, state, queuedAt };
}

describe("the phone's header pill", () => {
  test("is absent online with nothing waiting and nothing loud about the note", () => {
    expect(compactSync(sync(), chip({}))).toBeNull();
    expect(compactSync(sync(), null)).toBeNull();
    // A console with no offline layer under it — the landing page's picture.
    expect(compactSync(undefined, null)).toBeNull();
  });

  test("is absent while the platform has not said whether it is online", () => {
    /*
      SABOTAGE: made `connectionLine` answer for `unknown`. Fails here — and in
      the strip's own test, because both read the same function.
    */
    expect(compactSync(sync({ reachability: "unknown" }), null)).toBeNull();
  });

  test("says Offline, warn, when the connection goes and nothing is waiting", () => {
    const pill = compactSync(sync({ reachability: "offline" }), null)!;
    expect(pill).toEqual({ tone: "warn", text: "Offline", label: "Offline" });
  });

  test("offline with writes waiting, it counts every note not yet in the bucket", () => {
    const pill = compactSync(
      sync({ reachability: "offline", counts: { pending: 3, conflicted: 0, rejected: 0 } }),
      null,
    )!;
    expect(pill.text).toBe("Offline · 3");
    expect(pill.tone).toBe("warn");
    // The label is the strip's own words, in full.
    expect(pill.label).toBe("Offline. 3 notes waiting to sync");
  });

  test("online, the queue's own sentence is short enough to print as it is", () => {
    const pill = compactSync(sync({ counts: { pending: 2, conflicted: 0, rejected: 0 } }), null)!;
    expect(pill.text).toBe("2 notes waiting to sync");
    expect(pill.tone).toBe("warn");
  });

  test("a note that needs somebody outranks everything, in tone", () => {
    const counts = { pending: 3, conflicted: 1, rejected: 0 };
    const online = compactSync(sync({ counts }), null)!;
    expect(online.tone).toBe("crit");
    expect(online.text).toBe("1 note needs you");

    const offline = compactSync(sync({ reachability: "offline", counts }), null)!;
    expect(offline.tone).toBe("crit");
    expect(offline.text).toBe("Offline · 4");
    expect(offline.label).toBe("Offline. 1 note needs you");
  });

  test("a refused write counts as needing somebody, as the strip counts it", () => {
    const pill = compactSync(sync({ counts: { pending: 0, conflicted: 0, rejected: 2 } }), null)!;
    expect(pill.tone).toBe("crit");
    expect(pill.text).toBe("2 notes need you");
  });

  test("the pill's facts are exactly the strip's facts", () => {
    /*
      The phone must not have an opinion of its own about when to speak. Every
      state the strip is silent in, the pill is silent in, and vice versa.
    */
    const cases: SyncFacts[] = [
      sync(),
      sync({ reachability: "unknown" }),
      sync({ reachability: "offline" }),
      sync({ counts: { pending: 1, conflicted: 0, rejected: 0 } }),
      sync({ counts: { pending: 0, conflicted: 1, rejected: 0 } }),
    ];
    for (const facts of cases) {
      const strip = statusSegments({
        editor: emptyEditor,
        storageLabel: null,
        now: NOW,
        sync: facts,
      });
      expect(compactSync(facts, null) === null).toBe(strip.length === 0);
      expect(syncSegments(facts)).toEqual(strip);
    }
  });

  test("carries the open note's own state when it is one to notice", () => {
    const cached = chip({
      fromCache: true,
      message: "Showing the copy on this device, read 3 hours ago.",
    });
    const pill = compactSync(sync(), cached)!;
    expect(pill).toEqual({
      tone: "warn",
      text: "Cached copy",
      label: "This note: Cached copy",
    });

    const queued = chip({ status: "queued" });
    const both = compactSync(
      sync({ reachability: "offline", counts: { pending: 1, conflicted: 0, rejected: 0 } }),
      queued,
    )!;
    expect(both.text).toBe("Offline · 1 · Queued");
    expect(both.label).toBe("Offline. 1 note waiting to sync. This note: Queued");
  });

  test("does not carry the note's quiet states, which the note's own foot says", () => {
    for (const status of ["dirty", "saving", "saved"] as const) {
      expect(loudSave(chip({ status }))).toBeNull();
      expect(compactSync(sync(), chip({ status }))).toBeNull();
    }
    expect(loudSave(chip({}))).toBeNull();
    expect(loudSave(chip({ status: "conflict" }))?.tone).toBe("crit");
    expect(loudSave(chip({ status: "error" }))?.tone).toBe("crit");
  });
});

describe("the sheet behind the pill", () => {
  test("names every stuck note and every waiting one, each as its own block", () => {
    const marks = pendingMarks([
      write("1-projects/b.md", "pending", 2),
      write("1-projects/a.md", "conflicted", 1),
      write("2-areas/c.md", "pending", 3),
    ]);
    const sections = syncSheetSections(
      sync({
        reachability: "offline",
        counts: { pending: 2, conflicted: 1, rejected: 0 },
        stuckPaths: ["1-projects/a.md"],
      }),
      marks,
      null,
    );
    expect(sections.map((s) => s.id)).toEqual(["connection", "stuck", "waiting"]);

    const stuck = sections.find((s) => s.id === "stuck")!;
    expect(stuck.tone).toBe("crit");
    expect(stuck.text).toBe("1 note needs you");
    expect(stuck.paths).toEqual(["1-projects/a.md"]);
    // The rows are the names: the sentence does not list them a second time.
    expect(stuck.detail).not.toContain("a.md");

    const waiting = sections.find((s) => s.id === "waiting")!;
    expect(waiting.tone).toBe("warn");
    expect(waiting.text).toBe("2 notes waiting to sync");
    expect(waiting.paths).toEqual(["1-projects/b.md", "2-areas/c.md"]);
  });

  test("says nothing online with an empty queue", () => {
    expect(syncSheetSections(sync(), NO_PENDING, null)).toEqual([]);
  });

  test("gives the open note's cached copy its age, which a phone has no tooltip for", () => {
    const sections = syncSheetSections(
      sync(),
      NO_PENDING,
      chip({ fromCache: true, message: "Showing the copy on this device, read 3 hours ago." }),
    );
    expect(sections).toEqual([
      {
        id: "note",
        tone: "warn",
        text: "This note: Cached copy",
        detail: "Showing the copy on this device, read 3 hours ago.",
        paths: [],
      },
    ]);
  });
});

describe("marking a row", () => {
  test("a queued write is waiting, a parked or refused one needs you, anything else is nothing", () => {
    const marks = pendingMarks([
      write("a.md", "pending", 1),
      write("b.md", "conflicted", 2),
      write("c.md", "rejected", 3),
    ]);
    expect(marks.stateFor("a.md")).toBe("queued");
    expect(marks.stateFor("b.md")).toBe("conflict");
    expect(marks.stateFor("c.md")).toBe("conflict");
    expect(marks.stateFor("d.md")).toBeNull();
    // A folder is not a note, and a prefix is not a match.
    expect(marks.stateFor("a")).toBeNull();
  });

  test("the lists are in the order the drain sends them, oldest first", () => {
    const marks = pendingMarks([write("late.md", "pending", 9), write("early.md", "pending", 1)]);
    expect(marks.queued).toEqual(["early.md", "late.md"]);
  });

  test("an empty queue marks nothing", () => {
    expect(pendingMarks([])).toBe(NO_PENDING);
    expect(NO_PENDING.stateFor("a.md")).toBeNull();
  });

  test("says what it means in words", () => {
    expect(describeSyncMark("queued")).toBe("waiting to sync");
    expect(describeSyncMark("conflict")).toBe("needs you");
  });
});
