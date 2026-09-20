/**
 * The console lists one folder at a time, and a day is now two folders down.
 *
 * `ensureListing` fetches a folder's own children and nothing below them, so
 * the Inbox and the Channel view see a day written after 2026-09-18 only if
 * something walks `YYYY/MM` for them. The failure this guards is not a blank
 * screen — somebody would report that — it is a list that silently stops at
 * the last flat day and goes on looking correct.
 */

import { describe, expect, test } from "@jest/globals";
import {
  dayEntriesUnder,
  dayFolderPaths,
} from "../features/console/communications/dayFolders";
import type { FileEntry } from "../features/console/files/types";

const folder = (path: string): FileEntry =>
  ({ path, name: path.slice(path.lastIndexOf("/") + 1), kind: "folder" }) as FileEntry;
const file = (path: string): FileEntry =>
  ({ path, name: path.slice(path.lastIndexOf("/") + 1), kind: "file" }) as FileEntry;

const MAILBOX = "0-inbox/email/name-at-example-com";

/** A bucket synced before the change and again after it. */
const listings = {
  [MAILBOX]: { entries: [file(`${MAILBOX}/2026-08-30.md`), folder(`${MAILBOX}/2026`)] },
  [`${MAILBOX}/2026`]: { entries: [folder(`${MAILBOX}/2026/09`), folder(`${MAILBOX}/2026/08`)] },
  [`${MAILBOX}/2026/09`]: {
    entries: [file(`${MAILBOX}/2026/09/2026-09-07.md`), file(`${MAILBOX}/2026/09/2026-09-08.md`)],
  },
  [`${MAILBOX}/2026/08`]: { entries: [file(`${MAILBOX}/2026/08/2026-08-31.md`)] },
};

describe("walking a channel folder", () => {
  test("the folder itself is always first, so a bucket with only flat days needs no walk", () => {
    expect(dayFolderPaths(MAILBOX, {})).toEqual([MAILBOX]);
  });

  test("the years and months that have been listed are included", () => {
    expect(dayFolderPaths(MAILBOX, listings)).toEqual([
      MAILBOX,
      `${MAILBOX}/2026`,
      `${MAILBOX}/2026/09`,
      `${MAILBOX}/2026/08`,
    ]);
  });

  test("the walk grows one level per render rather than guessing at folders it has not seen", () => {
    const firstRound = dayFolderPaths(MAILBOX, { [MAILBOX]: listings[MAILBOX] });
    expect(firstRound).toEqual([MAILBOX, `${MAILBOX}/2026`]);
  });

  test("a folder somebody made is not a year, and is never listed", () => {
    expect(
      dayFolderPaths(MAILBOX, {
        [MAILBOX]: { entries: [folder(`${MAILBOX}/drafts`), folder(`${MAILBOX}/2026`)] },
      }),
    ).toEqual([MAILBOX, `${MAILBOX}/2026`]);
  });

  test("and the walk stops at the month — a folder under it is somebody's filing", () => {
    expect(
      dayFolderPaths(MAILBOX, {
        ...listings,
        [`${MAILBOX}/2026/09`]: { entries: [folder(`${MAILBOX}/2026/09/drafts`)] },
      }),
    ).not.toContain(`${MAILBOX}/2026/09/drafts`);
  });
});

describe("collecting the days", () => {
  test("every day under the folder comes back, flat and dated together", () => {
    expect(dayEntriesUnder(MAILBOX, listings).map((entry) => entry.path)).toEqual([
      `${MAILBOX}/2026-08-30.md`,
      `${MAILBOX}/2026/09/2026-09-07.md`,
      `${MAILBOX}/2026/09/2026-09-08.md`,
      `${MAILBOX}/2026/08/2026-08-31.md`,
    ]);
  });

  test("a year folder is never handed back as if it were a day", () => {
    expect(dayEntriesUnder(MAILBOX, listings).every((entry) => entry.kind === "file")).toBe(true);
  });

  test("nothing listed yet is no days rather than a crash", () => {
    expect(dayEntriesUnder(MAILBOX, {})).toEqual([]);
  });
});
