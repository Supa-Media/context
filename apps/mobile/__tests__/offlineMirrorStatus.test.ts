import { describe, expect, test } from "@jest/globals";
import { emptyIndex, type MirrorIndex } from "../features/offline/mirror";
import { mirrorLine } from "../features/offline/mirrorCopy";
import { statusFromIndex, type MirrorStatus } from "../features/offline/mirrorStatus";

/**
 * Whether it is clear when notes are not synced — the owner's words — and
 * whether saying so stays quiet when nothing needs anybody.
 *
 * Two rules, each a test that fails when it is broken:
 *
 *  - **A whole mirror never asks for attention.** "All 1,204 notes on this
 *    device" is a fact, never a warning, online or off — so it can never be
 *    the thing that puts the phone's pill in its header. Toning it `warn`
 *    fails "a complete mirror is quiet even offline".
 *  - **An incomplete one does, exactly when it matters** — offline, when a
 *    note somebody reaches for may not be there — and quietly otherwise, so a
 *    context too large to list in full is not a permanent alarm.
 */

const NOW = Date.parse("2026-09-18T12:00:00Z");

function indexWith(notes: number, extra: Partial<MirrorIndex> = {}): MirrorIndex {
  const index = emptyIndex();
  for (let n = 0; n < notes; n += 1) {
    index.entries.set(`n${n}.md`, {
      path: `n${n}.md`,
      etag: `e${n}`,
      size: 1_000,
      visibility: "private",
      inherited: "private",
      exception: false,
      readOnly: false,
      body: true,
      syncedAt: NOW,
    });
  }
  index.entries.set("photo.png", {
    path: "photo.png",
    etag: "i",
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
    body: false,
    syncedAt: NOW,
  });
  return Object.assign(index, extra);
}

describe("what an index says about itself", () => {
  test("nothing on the device is never", () => {
    expect(statusFromIndex(null).state).toBe("never");
  });

  test("notes opened before any sync are still never, with a count", () => {
    const status = statusFromIndex(indexWith(3));
    expect(status).toMatchObject({ state: "never", notes: 3 });
  });

  test("a complete sync is synced, counting notes and not attachments", () => {
    const status = statusFromIndex(
      indexWith(1_204, { lastSyncedAt: NOW - 120_000, complete: true, remaining: 0 }),
    );
    expect(status).toMatchObject({
      state: "synced",
      notes: 1_204,
      bytes: 1_204_000,
      lastSyncedAt: NOW - 120_000,
    });
  });

  test("an incomplete one is partial, with what is missing and why", () => {
    const status = statusFromIndex(
      indexWith(40, { lastSyncedAt: NOW, complete: false, remaining: 12, incomplete: "interrupted" }),
    );
    expect(status).toMatchObject({ state: "partial", remaining: 12, truncatedReason: "interrupted" });
  });
});

describe("the sentence", () => {
  const synced: MirrorStatus = {
    state: "synced",
    notes: 1_204,
    bytes: 3_500_000,
    lastSyncedAt: NOW - 120_000,
  };

  test("a whole mirror says so, with its age", () => {
    expect(mirrorLine(synced, { now: NOW, offline: false }).text).toBe(
      "All 1,204 notes on this device · synced 2 minutes ago",
    );
  });

  test("a complete mirror is quiet even offline", () => {
    expect(mirrorLine(synced, { now: NOW, offline: true }).tone).toBe("quiet");
  });

  test("a download in progress counts up", () => {
    const line = mirrorLine(
      { state: "syncing", notes: 340, bytes: 0, lastSyncedAt: null, remaining: 864, total: 1_204 },
      { now: NOW, offline: false },
    );
    expect(line.text).toBe("Downloading 340 of 1,204 notes…");
    expect(line.tone).toBe("quiet");
  });

  test("an incomplete mirror names what is missing, and warns only offline", () => {
    const partial: MirrorStatus = {
      state: "partial",
      notes: 1_100,
      bytes: 0,
      lastSyncedAt: NOW,
      remaining: 104,
      truncatedReason: "read-failed",
    };
    expect(mirrorLine(partial, { now: NOW, offline: false }).text).toBe(
      "Only part of this context is on this device — 104 notes not downloaded",
    );
    expect(mirrorLine(partial, { now: NOW, offline: false }).tone).toBe("quiet");
    expect(mirrorLine(partial, { now: NOW, offline: true }).tone).toBe("warn");
  });

  test("a context too large to list says it fits only in part", () => {
    const line = mirrorLine(
      {
        state: "partial",
        notes: 9_000,
        bytes: 0,
        lastSyncedAt: NOW,
        truncatedReason: "manifest-truncated",
      },
      { now: NOW, offline: false },
    );
    expect(line.text).toContain("Only part of this context fits offline");
  });

  test("never synced asks for one connection, and keeps the old promise's words", () => {
    const line = mirrorLine(
      { state: "never", notes: 0, bytes: 0, lastSyncedAt: null },
      { now: NOW, offline: true },
    );
    expect(line.text).toBe("Not yet downloaded — connect once to put this context on this device");
    expect(line.short).toBe("Not available offline");
    expect(line.tone).toBe("warn");
  });

  test("never synced with opened notes says some notes are offline", () => {
    const line = mirrorLine(
      { state: "never", notes: 3, bytes: 0, lastSyncedAt: null },
      { now: NOW, offline: true },
    );
    expect(line.short).toBe("Some notes offline");
  });

  test("no mirror on this device is said, not hidden", () => {
    const line = mirrorLine(
      { state: "unavailable", notes: 0, bytes: 0, lastSyncedAt: null },
      { now: NOW, offline: false },
    );
    expect(line.text).toContain("not keeping an offline copy");
  });

  test("no sentence carries a path", () => {
    for (const state of ["syncing", "synced", "partial", "never", "unavailable"] as const) {
      const line = mirrorLine(
        { state, notes: 2, bytes: 10, lastSyncedAt: NOW, remaining: 1, total: 3 },
        { now: NOW, offline: true },
      );
      expect(`${line.text} ${line.short} ${line.detail}`).not.toMatch(/\.md\b|\//);
    }
  });
});

describe("where it is drawn", () => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { withMirrorSegment, mirrorSheetSection } =
    require("../features/offline/mirrorCopy") as typeof import("../features/offline/mirrorCopy");
  const { compactSync, statusSegments } =
    require("../features/console/files/status") as typeof import("../features/console/files/status");
  const { connectionLine } =
    require("../features/offline/copy") as typeof import("../features/offline/copy");
  const { emptyEditor } =
    require("../features/console/files/editor") as typeof import("../features/console/files/editor");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const zero = { pending: 0, conflicted: 0, rejected: 0 };
  const synced: MirrorStatus = { state: "synced", notes: 12, bytes: 1, lastSyncedAt: NOW };
  const partial: MirrorStatus = {
    state: "partial",
    notes: 10,
    bytes: 1,
    lastSyncedAt: NOW,
    remaining: 2,
    truncatedReason: "interrupted",
  };

  test("a synced phone grows no pill", () => {
    const sync = { reachability: "online" as const, counts: zero, durable: true, mirror: synced };
    expect(compactSync(sync, null)).toBeNull();
  });

  test("the strip carries it quietly at the end, or beside Offline when it matters", () => {
    const quiet = withMirrorSegment(
      statusSegments({
        editor: emptyEditor,
        storageLabel: null,
        now: NOW,
        sync: { reachability: "online", counts: zero, durable: true, mirror: synced },
      }),
      { reachability: "online", counts: zero, durable: true, mirror: synced },
      NOW,
    );
    expect(quiet.at(-1)).toMatchObject({ id: "mirror", tone: "quiet", text: "12 notes offline" });

    const offlineSync = { reachability: "offline" as const, counts: zero, durable: true, mirror: partial };
    const loud = withMirrorSegment(
      statusSegments({ editor: emptyEditor, storageLabel: null, now: NOW, sync: offlineSync }),
      offlineSync,
      NOW,
    );
    expect(loud.map((segment) => segment.id).slice(0, 2)).toEqual(["connection", "mirror"]);
    expect(loud[1]!.tone).toBe("warn");
  });

  test("the phone's sheet has the line, and nothing without a status", () => {
    expect(
      mirrorSheetSection({ reachability: "offline", counts: zero, durable: true, mirror: partial }, NOW),
    ).toEqual([expect.objectContaining({ id: "mirror", tone: "warn", paths: [] })]);
    expect(mirrorSheetSection({ reachability: "offline", counts: zero, durable: true }, NOW)).toEqual(
      [],
    );
  });

  test("offline says every note is here only when every note is", () => {
    const whole = connectionLine({ reachability: "offline", counts: zero, durable: true, mirror: synced });
    expect(whole?.detail).toContain("Every note in this context is on this device");
    const part = connectionLine({ reachability: "offline", counts: zero, durable: true, mirror: partial });
    expect(part?.detail).toContain("notes you have opened before");
  });
});
