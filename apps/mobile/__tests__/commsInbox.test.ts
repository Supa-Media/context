import { describe, expect, test } from "@jest/globals";
import { isMailboxSlug } from "@context/communications";
import { MEETINGS_FOLDER } from "@context/meetings/paths";
import {
  activeDatesFor,
  channelLabel,
  discoverInboxChannels,
  shapeInboxRows,
  type InboxChannelSource,
} from "../features/console/communications/inbox";
import type { FileEntry } from "../features/console/files/types";

function file(path: string, over: Partial<FileEntry> = {}): FileEntry {
  return {
    kind: "file",
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
    ...over,
  };
}

function folder(path: string): FileEntry {
  return {
    kind: "folder",
    path,
    name: path.slice(path.lastIndexOf("/") + 1),
    visibility: "private",
    inherited: "private",
    exception: false,
    readOnly: false,
  };
}

describe("activeDatesFor", () => {
  test("a mailbox's channel-day notes, newest first, parts collapsed", () => {
    const entries = [
      file("0-inbox/email/name-at-example-com/2026-09-07.md"),
      file("0-inbox/email/name-at-example-com/2026-09-07-part-2.md"),
      file("0-inbox/email/name-at-example-com/2026-09-05.md"),
    ];
    expect(activeDatesFor("email", entries)).toEqual(["2026-09-07", "2026-09-05"]);
  });

  test("a mailbox folder's forwarded captures are not channel-days and are not counted", () => {
    const entries = [file("0-inbox/email/name-at-example-com/2026-09-07.md")];
    expect(activeDatesFor("email", entries)).toEqual(["2026-09-07"]);
  });

  test("meetings read their date off the filename, not off any content", () => {
    const entries = [
      file("0-inbox/meetings/2026-09-07-standup-8h9jkmnp.md"),
      file("0-inbox/meetings/2026-09-07-retro-a1b2c3d4.md"),
      file("0-inbox/meetings/2026-09-01-kickoff-zz998877.md"),
    ];
    expect(activeDatesFor("meetings", entries)).toEqual(["2026-09-07", "2026-09-01"]);
  });

  test("a session note or another folder's file is never counted as a meeting", () => {
    const entries = [file("0-inbox/meetings/notes.md"), folder("0-inbox/meetings/2026")];
    expect(activeDatesFor("meetings", entries)).toEqual([]);
  });

  test("contacts read their date off updatedAt, never off content", () => {
    const entries = [
      file("0-inbox/contacts/adam-okonkwo.md", { updatedAt: Date.parse("2026-09-07T18:00:00.000Z") }),
      file("0-inbox/contacts/bea-lindqvist.md", { updatedAt: Date.parse("2026-08-01T09:00:00.000Z") }),
    ];
    expect(activeDatesFor("contacts", entries)).toEqual(["2026-09-07", "2026-08-01"]);
  });

  test("a contact with no updatedAt contributes no date, never a wrong one", () => {
    expect(activeDatesFor("contacts", [file("0-inbox/contacts/adam-okonkwo.md")])).toEqual([]);
  });
});

describe("channelLabel", () => {
  test("fixed names for the flat channels", () => {
    expect(channelLabel("meetings", "")).toBe("Meetings");
    expect(channelLabel("contacts", "")).toBe("Contacts");
    expect(channelLabel("google-chat", "")).toBe("Google Chat");
    expect(channelLabel("imessage", "")).toBe("iMessage");
  });

  test("a mailbox's address, once one is known", () => {
    expect(channelLabel("email", "name-at-example-com", { address: "name@example.com" })).toBe(
      "name@example.com",
    );
  });

  test("the slug, honestly, before an address is known", () => {
    expect(channelLabel("email", "name-at-example-com")).toBe("name-at-example-com");
  });

  test("a rename wins over everything, once that storage exists", () => {
    expect(
      channelLabel("email", "name-at-example-com", { address: "name@example.com", rename: "Work mail" }),
    ).toBe("Work mail");
  });
});

describe("discoverInboxChannels", () => {
  test("nothing while the root listing has not arrived", () => {
    expect(discoverInboxChannels(undefined, undefined)).toEqual([]);
  });

  test("a folder that is not there is not a candidate", () => {
    expect(discoverInboxChannels([], undefined)).toEqual([]);
  });

  test("every connected flat channel", () => {
    const root = [folder(MEETINGS_FOLDER), folder("0-inbox/google-chat"), folder("0-inbox/imessage"), folder("0-inbox/contacts")];
    const found = discoverInboxChannels(root, undefined);
    expect(found.map((c) => c.kind).sort()).toEqual(["contacts", "google-chat", "imessage", "meetings"]);
  });

  test("email needs its own subfolder listing to find mailboxes", () => {
    const root = [folder("0-inbox/email")];
    // The email folder exists, but its own listing has not arrived yet.
    expect(discoverInboxChannels(root, undefined)).toEqual([]);
  });

  test("every mailbox under 0-inbox/email is its own candidate", () => {
    const root = [folder("0-inbox/email")];
    const emailEntries = [
      folder("0-inbox/email/name-at-example-com"),
      folder("0-inbox/email/another-at-example-com"),
      // A forwarded capture living beside the mailboxes: a file, not a folder.
      file("0-inbox/email/9f2c1d7a4b6e8035ac91d2f4.md"),
      // Somebody made a folder by hand — not a slug this product would produce.
      folder("0-inbox/email/Work_Box"),
    ];
    const found = discoverInboxChannels(root, emailEntries);
    expect(found).toEqual([
      { kind: "email", account: "name-at-example-com", path: "0-inbox/email/name-at-example-com" },
      { kind: "email", account: "another-at-example-com", path: "0-inbox/email/another-at-example-com" },
    ]);
    expect(found.every((candidate) => isMailboxSlug(candidate.account))).toBe(true);
  });

  test("a folder nobody has connected does not appear", () => {
    expect(discoverInboxChannels([], [])).toEqual([]);
  });
});

describe("shapeInboxRows", () => {
  function source(over: Partial<InboxChannelSource>): InboxChannelSource {
    return { kind: "google-chat", account: "", path: "0-inbox/google-chat", label: "Google Chat", entries: undefined, ...over };
  }

  test("most recently active first", () => {
    const rows = shapeInboxRows([
      source({ kind: "imessage", path: "0-inbox/imessage", label: "iMessage", entries: [file("0-inbox/imessage/2026-08-01.md")] }),
      source({ entries: [file("0-inbox/google-chat/2026-09-07.md")] }),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["google-chat", "imessage"]);
    expect(rows[0].lastActive).toBe("2026-09-07");
  });

  test("a channel with no activity yet sorts last, not dropped", () => {
    const rows = shapeInboxRows([
      source({ entries: [] }),
      source({ kind: "imessage", path: "0-inbox/imessage", label: "iMessage", entries: [file("0-inbox/imessage/2026-08-01.md")] }),
    ]);
    expect(rows.map((row) => row.kind)).toEqual(["imessage", "google-chat"]);
    expect(rows[1].lastActive).toBeNull();
    expect(rows[1].activeDays).toBe(0);
  });

  test("a listing that has not loaded reads as not-yet-active, never as empty", () => {
    const [row] = shapeInboxRows([source({ entries: undefined })]);
    expect(row.lastActive).toBeNull();
    expect(row.activeDays).toBe(0);
  });

  test("active days are capped at the recency window", () => {
    const entries = Array.from({ length: 40 }, (_, i) =>
      file(`0-inbox/google-chat/2026-01-${String((i % 28) + 1).padStart(2, "0")}.md`),
    );
    const [row] = shapeInboxRows([source({ entries })], 10);
    expect(row.activeDays).toBeLessThanOrEqual(10);
  });
});
