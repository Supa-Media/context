import { describe, expect, test } from "@jest/globals";
import type { ImessageStatus, MessagesBackupView } from "@context/desktop-bridge";
import {
  ago,
  backupOnThisMac,
  progressLines,
  spaceLabel,
  waitingForFullDiskAccess,
  whatsCopiedLines,
  downloadLine,
  whoseTexts,
} from "../features/messagesBackup/view";

/**
 * What the console says about the Messages backup (boards approved by the
 * owner, 2026-10-26). Sabotage record, as temporary edits to `view.ts`;
 * counts are failures across this file and `messagesBackupSettings.test.ts`:
 *
 *   waitingForFullDiskAccess reading only the switch, not the phase         3
 *   backupOnThisMac reading a missing view as off rather than outdated      2
 *   the copying line counting past the total                                1
 */

const VIEW: MessagesBackupView = {
  phase: "copying",
  copiedRows: 48_210,
  totalRows: 212_408,
  reachedBack: Date.parse("2024-03-14T10:00:00Z"),
  problem: null,
  account: "+1 ••• 4410",
  machine: "MacBook Pro",
};

function status(backup: MessagesBackupView | undefined, enabled = true): ImessageStatus {
  return { enabled, permission: "granted", lastSyncedAt: null, lastError: null, ...(backup ? { backup } : {}) };
}

const NOW = Date.parse("2026-10-26T12:00:00Z");

describe("the Messages backup in words", () => {
  test("a Mac app from before the backup is told apart from a backup that is off", () => {
    expect(backupOnThisMac(status(undefined)).kind).toBe("outdated");
    expect(backupOnThisMac(status({ ...VIEW, phase: "off" }, false))).toEqual({
      kind: "here",
      enabled: false,
      view: { ...VIEW, phase: "off" },
    });
  });

  test("the first-run card waits only while the backup is on and the permission is missing", () => {
    const waiting = { ...VIEW, phase: "needs_permission" as const };
    expect(waitingForFullDiskAccess(status(waiting))).toBe(true);
    expect(waitingForFullDiskAccess(status(waiting, false))).toBe(false);
    expect(waitingForFullDiskAccess(status(VIEW))).toBe(false);
    expect(waitingForFullDiskAccess(status(undefined))).toBe(false);
    expect(waitingForFullDiskAccess(null)).toBe(false);
  });

  test("whose texts, and which Mac, so a shared Mac is caught", () => {
    expect(whoseTexts(VIEW)).toBe("Texts for +1 ••• 4410 · MacBook Pro");
    expect(whoseTexts({ ...VIEW, account: null })).toBe("Texts for MacBook Pro");
    expect(whoseTexts({ ...VIEW, account: null, machine: null })).toBe("Texts on this Mac");
  });

  test("copying says how many and how far back, newest first", () => {
    expect(progressLines(true, VIEW, { now: NOW, lastCopiedAt: null })).toEqual({
      title: "Copying, newest first",
      detail: "48,210 of 212,408 messages · back to March 2024 so far",
    });
    expect(progressLines(true, { ...VIEW, copiedRows: 300, totalRows: 200 }, { now: NOW, lastCopiedAt: null }).detail).toBe(
      "200 of 200 messages · back to March 2024 so far",
    );
  });

  test("done says when it last copied", () => {
    const done = { ...VIEW, phase: "up_to_date" as const };
    expect(progressLines(true, done, { now: NOW, lastCopiedAt: NOW - 2 * 60_000 }).title).toBe("Up to date · copied 2 min ago");
    expect(progressLines(true, done, { now: NOW, lastCopiedAt: null }).title).toBe("Up to date");
  });

  test("off keeps what is copied, and says so", () => {
    expect(progressLines(false, VIEW, { now: NOW, lastCopiedAt: null }).detail).toContain("What's already copied stays");
  });

  test("a stop is said in our words from a closed set, never the server's", () => {
    const stopped = { ...VIEW, phase: "stopped" as const };
    expect(progressLines(true, { ...stopped, problem: "offline" }, { now: NOW, lastCopiedAt: null }).detail).toContain("offline");
    expect(progressLines(true, { ...stopped, problem: "<script>" }, { now: NOW, lastCopiedAt: null }).detail).toContain(
      "couldn't be reached",
    );
  });

  test("times read as people say them", () => {
    expect(ago(NOW, NOW)).toBe("just now");
    expect(ago(NOW - 60 * 60_000, NOW)).toBe("1 hour ago");
    expect(ago(NOW - 3 * 24 * 60 * 60_000, NOW)).toBe("3 days ago");
  });
});

describe("what's copied", () => {
  test("space reads as a person would say it", () => {
    expect(spaceLabel(0)).toBe("0 bytes");
    expect(spaceLabel(830_000)).toBe("830 KB");
    expect(spaceLabel(1_400_000_000)).toBe("1.4 GB");
    expect(spaceLabel(12_345_678)).toBe("12 MB");
  });

  test("pictures say their limit and the space so far; videos say why they are off", () => {
    expect(whatsCopiedLines({ pictures: true, videos: false, bytes: 0 })).toEqual({ pictures: "Up to 25 MB each", videos: "Off. Videos take most of the space." });
    expect(whatsCopiedLines({ pictures: true, videos: true, bytes: 2_000_000 }).pictures).toBe("Up to 25 MB each · 2 MB so far");
    expect(whatsCopiedLines({ pictures: false, videos: true, bytes: 2_000_000 })).toEqual({ pictures: "Off. The 2 MB already copied stays.", videos: "Up to 25 MB each" });
  });

  test("a download says what it saved, what it could not, and never the shell's own words", () => {
    expect(downloadLine({ ok: true, conversations: 12, transcripts: 40, pictures: 1340, notCopied: 0 })).toBe("Saved 12 conversations and 1,340 pictures to Downloads.");
    expect(downloadLine({ ok: true, conversations: 1, transcripts: 1, pictures: 0, notCopied: 1 })).toBe("Saved 1 conversation to Downloads. 1 file was never copied, so it is named instead.");
    expect(downloadLine({ ok: true, conversations: 0, transcripts: 0, pictures: 0, notCopied: 0 })).toBe("Nothing is backed up yet.");
    expect(downloadLine({ ok: false, problem: "write_failed" })).toBe("Couldn't save to Downloads. Check there's room on this Mac, then try again.");
    expect(downloadLine({ ok: false, problem: "something new" })).toBe("Something went wrong. Try again.");
  });
});
