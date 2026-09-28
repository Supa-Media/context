import { describe, expect, test } from "@jest/globals";
import {
  CHANNEL_FOLDERS,
  CONTACTS_FOLDER,
  INBOX_FOLDER,
  channelDayNotePath,
  contactNotePath,
  contactSlug,
} from "@context/communications";
import { MEETINGS_FOLDER } from "@context/meetings/paths";
import { classifyCommsPath } from "../features/console/communications/paths";

describe("classifyCommsPath", () => {
  // Every folder under the inbox is an ordinary folder, drawn by the same
  // `FolderView` as any other — Dev2 (2026-09-28): a custom Inbox list
  // "looks broken" beside every other folder in the app.
  test.each([
    ["the inbox root", INBOX_FOLDER],
    ["the contacts folder", CONTACTS_FOLDER],
    ["meetings", MEETINGS_FOLDER],
    ["google chat", CHANNEL_FOLDERS["google-chat"]],
    ["imessage", CHANNEL_FOLDERS.imessage],
    ["the email folder", CHANNEL_FOLDERS.email],
    ["a mailbox", `${CHANNEL_FOLDERS.email}/name-at-example-com`],
    ["a year folder in a mailbox", `${CHANNEL_FOLDERS.email}/name-at-example-com/2026`],
  ])("%s is a regular folder, never a comms route", (_label, path) => {
    expect(classifyCommsPath(path)).toBeNull();
  });

  test("a forwarded capture is not a comms route", () => {
    expect(classifyCommsPath("0-inbox/email/9f2c1d7a4b6e8035ac91d2f4.md")).toBeNull();
  });

  test("a channel-day note, part 1", () => {
    const path = channelDayNotePath({ channel: "email", account: "name-at-example-com", date: "2026-09-07" });
    expect(classifyCommsPath(path)).toEqual({
      kind: "channel-day",
      channel: "email",
      account: "name-at-example-com",
      date: "2026-09-07",
      part: 1,
    });
  });

  test("a split part", () => {
    const path = channelDayNotePath({ channel: "imessage", date: "2026-09-07", part: 3 });
    expect(classifyCommsPath(path)).toEqual({
      kind: "channel-day",
      channel: "imessage",
      account: "",
      date: "2026-09-07",
      part: 3,
    });
  });

  test("a dated-tree channel path IS a channel-day note, since that is where days are written", () => {
    expect(classifyCommsPath("0-inbox/email/name-at-example-com/2026/09/2026-09-07.md")).toEqual({
      kind: "channel-day",
      channel: "email",
      account: "name-at-example-com",
      date: "2026-09-07",
      part: 1,
    });
  });

  test("...and so is the flat path every day written before it still lives at", () => {
    expect(classifyCommsPath("0-inbox/email/name-at-example-com/2026-09-07.md")).toEqual({
      kind: "channel-day",
      channel: "email",
      account: "name-at-example-com",
      date: "2026-09-07",
      part: 1,
    });
  });

  test("a year folder that disagrees with the filename is nobody's day", () => {
    expect(classifyCommsPath("0-inbox/email/name-at-example-com/2025/01/2026-09-07.md")).toBeNull();
  });

  test("a contact page", () => {
    const slug = contactSlug("Adam Okonkwo");
    expect(classifyCommsPath(contactNotePath(slug))).toEqual({ kind: "contact", slug });
  });

  test("an ordinary note is not a comms route", () => {
    expect(classifyCommsPath("1-projects/plan.md")).toBeNull();
  });

  test("an ordinary folder is not a comms route", () => {
    expect(classifyCommsPath("1-projects")).toBeNull();
  });

  test("the root is not a comms route", () => {
    expect(classifyCommsPath("")).toBeNull();
  });
});
