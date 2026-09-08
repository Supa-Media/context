import { describe, expect, test } from "@jest/globals";
import { channelDayNotePath, contactNotePath, contactSlug } from "@context/communications";
import { MEETINGS_FOLDER } from "@context/meetings/paths";
import {
  CONTACTS_FOLDER,
  INBOX_FOLDER,
  classifyCommsPath,
  mailboxFolder,
} from "../features/console/communications/paths";

describe("classifyCommsPath", () => {
  test("the inbox root", () => {
    expect(classifyCommsPath(INBOX_FOLDER)).toEqual({ kind: "inbox" });
  });

  test("the contacts folder", () => {
    expect(classifyCommsPath(CONTACTS_FOLDER)).toEqual({ kind: "contacts" });
  });

  test("meetings is never a comms route — it stays the generic folder view", () => {
    expect(classifyCommsPath(MEETINGS_FOLDER)).toBeNull();
  });

  test("google-chat and imessage are flat channels", () => {
    expect(classifyCommsPath("0-inbox/google-chat")).toEqual({
      kind: "channel",
      channel: "google-chat",
      account: "",
    });
    expect(classifyCommsPath("0-inbox/imessage")).toEqual({
      kind: "channel",
      channel: "imessage",
      account: "",
    });
  });

  test("a mailbox folder is a channel with an account", () => {
    expect(classifyCommsPath(mailboxFolder("name-at-example-com"))).toEqual({
      kind: "channel",
      channel: "email",
      account: "name-at-example-com",
    });
  });

  test("a folder somebody made by hand inside 0-inbox/email is not a mailbox", () => {
    expect(classifyCommsPath("0-inbox/email/Work_Box")).toBeNull();
  });

  test("a forwarded capture is not a mailbox folder", () => {
    expect(classifyCommsPath("0-inbox/email/9f2c1d7a4b6e8035ac91d2f4.md")).toBeNull();
  });

  test("a subfolder of a mailbox — attachments, or one somebody made — is not the mailbox itself", () => {
    expect(classifyCommsPath("0-inbox/email/name-at-example-com/attachments")).toBeNull();
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

  test("a dated-tree channel path is not a channel-day note", () => {
    expect(classifyCommsPath("0-inbox/email/name-at-example-com/2026/09/2026-09-07.md")).toBeNull();
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
