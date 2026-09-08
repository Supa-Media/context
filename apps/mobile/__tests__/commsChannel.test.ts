import { describe, expect, test } from "@jest/globals";
import { channelDayNotePath } from "@context/communications";
import {
  channelDayPageCount,
  collateChannelDays,
  pageChannelDays,
} from "../features/console/communications/channel";
import type { FileEntry } from "../features/console/files/types";

function file(path: string): FileEntry {
  return {
    kind: "file",
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
  };
}

describe("collateChannelDays", () => {
  test("one row per day, newest first", () => {
    const entries = [
      file(channelDayNotePath({ channel: "email", account: "name-at-example-com", date: "2026-09-05" })),
      file(channelDayNotePath({ channel: "email", account: "name-at-example-com", date: "2026-09-07" })),
    ];
    const rows = collateChannelDays("email", "name-at-example-com", entries);
    expect(rows.map((row) => row.date)).toEqual(["2026-09-07", "2026-09-05"]);
    expect(rows.every((row) => row.parts === 1)).toBe(true);
  });

  test("split parts collapse onto one row, pointing at part 1", () => {
    const entries = [
      file(channelDayNotePath({ channel: "imessage", date: "2026-09-07", part: 1 })),
      file(channelDayNotePath({ channel: "imessage", date: "2026-09-07", part: 2 })),
      file(channelDayNotePath({ channel: "imessage", date: "2026-09-07", part: 3 })),
    ];
    const rows = collateChannelDays("imessage", "", entries);
    expect(rows).toHaveLength(1);
    expect(rows[0].parts).toBe(3);
    expect(rows[0].path).toBe(channelDayNotePath({ channel: "imessage", date: "2026-09-07", part: 1 }));
  });

  test("a listing that has not reached part 1 yet still points at a real part", () => {
    const entries = [
      file(channelDayNotePath({ channel: "imessage", date: "2026-09-07", part: 2 })),
      file(channelDayNotePath({ channel: "imessage", date: "2026-09-07", part: 3 })),
    ];
    const [row] = collateChannelDays("imessage", "", entries);
    expect(row.parts).toBe(2);
    expect(row.path).toBe(channelDayNotePath({ channel: "imessage", date: "2026-09-07", part: 2 }));
  });

  test("a different mailbox's day is never counted against this one", () => {
    const entries = [
      file(channelDayNotePath({ channel: "email", account: "name-at-example-com", date: "2026-09-07" })),
      file(channelDayNotePath({ channel: "email", account: "another-at-example-com", date: "2026-09-07" })),
    ];
    expect(collateChannelDays("email", "name-at-example-com", entries)).toHaveLength(1);
  });

  test("a forwarded capture beside a mailbox is not one of its days", () => {
    const entries = [
      file("0-inbox/email/9f2c1d7a4b6e8035ac91d2f4.md"),
      file(channelDayNotePath({ channel: "email", account: "name-at-example-com", date: "2026-09-07" })),
    ];
    expect(collateChannelDays("email", "name-at-example-com", entries)).toHaveLength(1);
  });

  test("a folder in the listing is never a day", () => {
    const entries: FileEntry[] = [
      { kind: "folder", path: "0-inbox/email/name-at-example-com/attachments", name: "attachments", visibility: "private", inherited: "private", exception: false, readOnly: false },
    ];
    expect(collateChannelDays("email", "name-at-example-com", entries)).toEqual([]);
  });
});

describe("paging", () => {
  const rows = Array.from({ length: 25 }, (_, i) => ({
    channel: "google-chat" as const,
    account: "",
    date: `2026-01-${String(i + 1).padStart(2, "0")}`,
    path: "x",
    parts: 1,
    messages: null,
    threads: null,
  }));

  test("a page is bounded by pageSize", () => {
    expect(pageChannelDays(rows, 0, 10)).toHaveLength(10);
    expect(pageChannelDays(rows, 2, 10)).toHaveLength(5);
    expect(pageChannelDays(rows, 3, 10)).toHaveLength(0);
  });

  test("page count matches", () => {
    expect(channelDayPageCount(rows, 10)).toBe(3);
    expect(channelDayPageCount([], 10)).toBe(0);
  });
});
