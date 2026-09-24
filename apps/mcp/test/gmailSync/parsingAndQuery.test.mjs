// Gmail sync: pure parsing (base64url, header lookup, address lists, body
// extraction, the message-to-event shape) and the search query gmailSync
// builds for a day.
//
// Split out of gmailSync.test.mjs; see fixtures.mjs for the shared message
// builder. Returns `{ event }`, the parsed event later sections (rendering,
// quota) build on.

import { buildDayQuery, dateKeyOf, decodeBase64UrlToUtf8, extractBody, gmailMessageToEvent, headerValue, parseAddressList } from "../../src/communications/gmailSync.js";
import { base64Url, fixtureMessage } from "./fixtures.mjs";

export async function runGmailParsingAndQueryChecks(check) {
  // -- pure parsing -----------------------------------------------------------

  check("base64url round-trips a UTF-8 body, including non-ASCII", decodeBase64UrlToUtf8(base64Url("héllo — wörld")) === "héllo — wörld");
  check("an empty/absent body decodes to an empty string, not a throw", decodeBase64UrlToUtf8(undefined) === "" && decodeBase64UrlToUtf8("") === "");

  check(
    "header lookup is case-insensitive, per RFC 5322",
    headerValue([{ name: "sUbJeCt", value: "Hello" }], "Subject") === "Hello",
  );
  check("a missing header is an empty string, never undefined", headerValue([], "Subject") === "");

  check(
    "a display name and address parse apart",
    JSON.stringify(parseAddressList('"Ada Lovelace" <ada@example.invalid>')) ===
      JSON.stringify([{ name: "Ada Lovelace", address: "ada@example.invalid" }]),
  );
  check(
    "a bare address with no display name parses too",
    JSON.stringify(parseAddressList("bob@example.invalid")) === JSON.stringify([{ address: "bob@example.invalid" }]),
  );
  check(
    "a list of two addresses is two entries",
    parseAddressList("a@example.invalid, b@example.invalid").length === 2,
  );
  check("an empty value parses to no addresses at all", parseAddressList("").length === 0);

  const plainMessage = fixtureMessage({
    id: "m1",
    threadId: "t1",
    date: "2026-09-07T09:14:00.000Z",
    from: "Adam Okonkwo <adam@example.invalid>",
    to: "person@example.invalid",
    subject: "Quarterly numbers",
    text: "Here they are.",
  });
  check("a plain-text body decodes and is used as-is", extractBody(plainMessage.payload).text === "Here they are.");

  const htmlOnlyMessage = fixtureMessage({
    id: "m2",
    threadId: "t2",
    date: "2026-09-07T10:00:00.000Z",
    from: "a@example.invalid",
    to: "person@example.invalid",
    subject: "HTML only",
    html: "<p>Hello <b>world</b></p><br>Line two",
  });
  const htmlBody = extractBody(htmlOnlyMessage.payload).text;
  check("an HTML-only message falls back to stripped text", htmlBody.includes("Hello") && htmlBody.includes("world") && !htmlBody.includes("<b>"));

  const withAttachment = fixtureMessage({
    id: "m3",
    threadId: "t3",
    date: "2026-09-07T11:00:00.000Z",
    from: "a@example.invalid",
    to: "person@example.invalid",
    subject: "Has a file",
    text: "See attached.",
    attachments: [{ filename: "report.pdf", contentType: "application/pdf", size: 12345 }],
  });
  const extracted = extractBody(withAttachment.payload);
  check(
    "an attachment is described by filename, type and size — metadata only",
    extracted.attachments.length === 1 &&
      extracted.attachments[0].filename === "report.pdf" &&
      extracted.attachments[0].contentType === "application/pdf" &&
      extracted.attachments[0].size === 12345,
  );
  check(
    "the attachment part never contributes an attachmentId to anything this module produces",
    JSON.stringify(extracted) !== JSON.stringify(withAttachment.payload) && !JSON.stringify(extracted).includes("attachmentId"),
  );

  const event = gmailMessageToEvent(plainMessage, { mailboxSlug: "person-at-example-invalid" });
  check("account carries the mailbox SLUG, not the address", event.account === "person-at-example-invalid");
  check("messageId and threadId are the provider's raw ids — hashed later, not here", event.messageId === "m1" && event.threadId === "t1");
  check("sentAt is derived from internalDate", event.sentAt === new Date(Number(plainMessage.internalDate)).toISOString());
  check("the sender is parsed from the From header", event.from.address === "adam@example.invalid" && event.from.name === "Adam Okonkwo");
  check("dateKeyOf reads the calendar date off sentAt", dateKeyOf(event) === "2026-09-07");

  // -- query building -----------------------------------------------------------

  const query = buildDayQuery({ folders: ["inbox", "sent"], date: "2026-09-07" });
  check("both configured folders appear in the query", query.includes("in:inbox") && query.includes("in:sent"));
  check(
    "spam and trash are excluded UNCONDITIONALLY, not merely un-included",
    query.includes("-in:spam") && query.includes("-in:trash"),
  );
  check(
    "the date bound is exactly one UTC calendar day, back to back with no gap or overlap",
    (() => {
      const q1 = buildDayQuery({ folders: ["inbox"], date: "2026-09-07" });
      const q2 = buildDayQuery({ folders: ["inbox"], date: "2026-09-08" });
      const after1 = Number(/after:(\d+)/.exec(q1)[1]);
      const before1 = Number(/before:(\d+)/.exec(q1)[1]);
      const after2 = Number(/after:(\d+)/.exec(q2)[1]);
      return before1 - after1 === 24 * 60 * 60 && before1 === after2;
    })(),
  );
  check("a query with no date has no after/before bound at all — 'all mail'", !buildDayQuery({ folders: ["inbox"] }).includes("after:"));
  let threwOnBadDate = false;
  try {
    buildDayQuery({ folders: ["inbox"], date: "2026-02-30" });
  } catch {
    threwOnBadDate = true;
  }
  check("a date that does not exist is refused rather than silently mis-queried", threwOnBadDate);

  return { event };
}
