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
    expect(line.tone).toBe("warn");
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
