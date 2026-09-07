/**
 * Rows out, `CommunicationEvent`s in — the pure heart of iMessage import.
 *
 * Every row here is hand-built, never read off a real `chat.db`; that half is
 * `imessageSqlite.test.mjs`, which runs the real query strings against a real
 * fixture database and feeds the result through the exact same
 * `readChatDbWindow` this file drives directly.
 *
 * ## Sabotage record
 *
 * Measured by actually editing `src/core/imessage/reader.ts` and reverting:
 *
 *   `isReactionRow` made to always return `false`                       6 FAIL
 */

import { IMESSAGE_ACCOUNT, isReactionRow, readChatDbWindow, targetMessageGuid } from "../src/core/imessage/reader.ts";

const NS = "810432840000000000"; // 2026-09-07T00:14:00.000Z

function row(overrides = {}) {
  return {
    rowid: "1",
    guid: "guid-1",
    date_ns: NS,
    text: "hello",
    attributed_body_hex: null,
    is_from_me: 0,
    associated_message_type: 0,
    associated_message_guid: null,
    chat_guid: "chat-1",
    chat_display_name: null,
    chat_identifier: "+15551234567",
    sender_address: "+15551234567",
    ...overrides,
  };
}

export function runImessageReaderChecks(check) {
  // -- isReactionRow / targetMessageGuid -------------------------------------
  check("type 0 is an ordinary message", !isReactionRow({ associated_message_type: 0 }));
  check("type 2000 (loved) is a reaction", isReactionRow({ associated_message_type: 2000 }));
  check("type 2005 (questioned) is a reaction", isReactionRow({ associated_message_type: 2005 }));
  check("type 3000 (a removed tapback) is still classified as a reaction row", isReactionRow({ associated_message_type: 3000 }));
  check("type 1 (not a documented tapback code) is an ordinary message", !isReactionRow({ associated_message_type: 1 }));

  check("a bare guid with no scheme is returned as-is", targetMessageGuid("plain-guid") === "plain-guid");
  check("the bp: scheme is stripped", targetMessageGuid("bp:the-real-guid") === "the-real-guid");
  check("the p:0/ scheme is stripped", targetMessageGuid("p:0/the-real-guid") === "the-real-guid");
  check("null is refused", targetMessageGuid(null) === null);
  check("empty string is refused", targetMessageGuid("") === null);

  // -- ordinary messages ------------------------------------------------------
  const [event] = readChatDbWindow([row()], [], []);
  check("an ordinary message becomes one event", event !== undefined);
  check("the channel is imessage", event.channel === "imessage");
  check("the account is the fixed iMessage constant, never a folder-shaped value", event.account === IMESSAGE_ACCOUNT);
  check("the message id is the row's own guid", event.messageId === "guid-1");
  check("the thread id is the chat's guid", event.threadId === "chat-1");
  check("the timestamp is decoded from Apple epoch nanoseconds", event.sentAt === "2026-09-07T00:14:00.000Z");
  check("the sender's address is carried through", event.from.address === "+15551234567");
  check("the body is the row's text", event.body === "hello");

  // -- a message from me --------------------------------------------------
  const [fromMe] = readChatDbWindow([row({ guid: "guid-2", is_from_me: 1, sender_address: null, text: "sent by me" })], [], []);
  check("a message from this device is labelled You", fromMe.from.name === "You");

  // -- dropped rows -----------------------------------------------------------
  const dropped = readChatDbWindow(
    [row({ guid: "guid-3", text: null, attributed_body_hex: null })],
    [],
    [],
  );
  check("a row with no text, no attributed body, and no attachment is dropped", dropped.length === 0);

  const attachmentOnly = readChatDbWindow(
    [row({ guid: "guid-4", text: null })],
    [{ message_guid: "guid-4", filename: "photo.heic", mime_type: "image/heic", total_bytes: "1024" }],
    [],
  );
  check("an attachment with no text is still kept, for the attachment alone", attachmentOnly.length === 1);
  check("the attachment is described, not fetched — filename, type, size only", attachmentOnly[0].attachments[0].filename === "photo.heic");
  check("the attachment size is a number", attachmentOnly[0].attachments[0].size === 1024);

  // -- reactions folded as annotations, never as messages of their own --------
  const target = row({ guid: "target-1", text: "look at this" });
  const reaction = row({
    guid: "reaction-1",
    text: null,
    associated_message_type: 2000, // loved
    associated_message_guid: "bp:target-1",
    is_from_me: 1,
    sender_address: null,
  });
  const withReaction = readChatDbWindow([target, reaction], [], []);
  check("a tapback never becomes an event of its own — one event in, one event out", withReaction.length === 1);
  check("the tapback is appended to the target message's own body", withReaction[0].body.includes("look at this"));
  check("the appended annotation says who reacted and how", withReaction[0].body.includes("You loved this message."));

  const reactionFirst = readChatDbWindow(
    [
      row({ guid: "reaction-2", text: null, associated_message_type: 2001, associated_message_guid: "bp:target-2", sender_address: "+15550000000" }),
      row({ guid: "target-2", text: "reordered", rowid: "2" }),
    ],
    [],
    [],
  );
  check(
    "a tapback that precedes its target in the row order (ROWID) is still folded correctly",
    reactionFirst.length === 1 && reactionFirst[0].body.includes("liked this message"),
  );

  const removedTapback = readChatDbWindow(
    [row({ guid: "target-3", text: "still here" }), row({ guid: "undo-1", text: null, associated_message_type: 3000, associated_message_guid: "bp:target-3" })],
    [],
    [],
  );
  check("a removed tapback (3000-3005) is dropped outright, not folded", removedTapback.length === 1 && removedTapback[0].body === "still here");

  const orphanTapback = readChatDbWindow(
    [row({ guid: "reaction-3", text: null, associated_message_type: 2000, associated_message_guid: "bp:not-in-this-window" })],
    [],
    [],
  );
  check("a tapback whose target is outside this window is silently dropped, not left dangling", orphanTapback.length === 0);

  // -- group chats: subject and participant list -------------------------------
  const groupParticipants = [
    { chat_guid: "group-1", address: "+15550000001" },
    { chat_guid: "group-1", address: "+15550000002" },
    { chat_guid: "group-1", address: "+15559999999" }, // this device's own address
  ];
  const [namedGroup] = readChatDbWindow(
    [row({ guid: "g1", chat_guid: "group-1", chat_display_name: "Family Trip", chat_identifier: "chat123456" })],
    [],
    groupParticipants,
    { selfAddresses: ["+15559999999"] },
  );
  check("a named group chat's display name is the thread subject", namedGroup.subject === "Family Trip");

  const [unnamedGroup] = readChatDbWindow(
    [row({ guid: "g2", chat_guid: "group-1", chat_display_name: null, chat_identifier: "chat123456", is_from_me: 1, sender_address: null })],
    [],
    groupParticipants,
    { selfAddresses: ["+15559999999"] },
  );
  check(
    "an unnamed group's subject falls back to its other participants, excluding this device's own address",
    unnamedGroup.subject === "+15550000001, +15550000002" && !unnamedGroup.subject.includes("+15559999999"),
  );
  check(
    "a message sent from this device lists the other participants as recipients",
    unnamedGroup.to.map((entry) => entry.address).sort().join(",") === "+15550000001,+15550000002",
  );

  const [oneOnOne] = readChatDbWindow(
    [row({ guid: "g3", chat_guid: "solo-chat", chat_display_name: null, chat_identifier: "+15551234567" })],
    [],
    [],
  );
  check("a one-on-one chat with no display name and no participant rows falls back to the chat identifier", oneOnOne.subject === "+15551234567");
}
