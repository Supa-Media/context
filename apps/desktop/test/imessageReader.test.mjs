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
 *   `isReactionRow` made to always return `false`                       7 FAIL
 *   the fold's `target.threadId !== row.chat_guid` check removed          2 FAIL
 *
 * The second row is the one this file was extended for. Folding on the target
 * GUID alone let a reaction row filed under one chat append a line to a
 * message in another — see `docs/decisions/communications.md`, *And a tapback
 * may only annotate a message in its own conversation*.
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

  // -- a tapback may never reach out of its own conversation -----------------
  //
  // `associated_message_guid` is bytes the *reacting* device chose, and a
  // message GUID is unique across the whole database rather than per chat. So
  // a row filed under one chat naming a GUID that belongs to another must be
  // dropped, not folded: somebody who has ever messaged this Mac knows the
  // GUIDs of the messages they sent, and folding on GUID alone lets them write
  // a line naming themselves into a conversation they were never in.
  const crossConversation = readChatDbWindow(
    [
      row({ guid: "private-msg", chat_guid: "chat-private", text: "the private one" }),
      row({
        rowid: "2",
        guid: "outsider-reaction",
        chat_guid: "chat-somewhere-else",
        text: null,
        associated_message_type: 2000,
        associated_message_guid: "bp:private-msg",
        sender_address: "+15550001111",
      }),
    ],
    [],
    [],
  );
  check(
    "A TAPBACK FROM ANOTHER CONVERSATION IS NOT FOLDED onto a message it names by guid",
    crossConversation.length === 1 && crossConversation[0].body === "the private one",
  );
  check(
    "...so the outsider's handle never appears anywhere in the conversation they were not in",
    !JSON.stringify(crossConversation).includes("+15550001111"),
  );

  const sameConversation = readChatDbWindow(
    [
      row({ guid: "kept-msg", chat_guid: "chat-private", text: "the private one" }),
      row({
        rowid: "2",
        guid: "insider-reaction",
        chat_guid: "chat-private",
        text: null,
        associated_message_type: 2000,
        associated_message_guid: "bp:kept-msg",
        sender_address: "+15550001111",
      }),
    ],
    [],
    [],
  );
  check(
    "...while a tapback in the SAME conversation still folds, so the check is not simply refusing everything",
    sameConversation.length === 1 && sameConversation[0].body.includes("+15550001111 loved this message."),
  );

  // -- a renamed group, and a participant who left ---------------------------
  //
  // `chat.display_name` is whatever the group was last renamed to, and
  // `chat_handle_join` is who is in it *now* — a member who left is simply
  // absent from the join. Neither is history: a message that person sent
  // before leaving still carries their handle as its sender, and the day it
  // landed on still renders it. What must not happen is the subject silently
  // becoming a different group's, or a departed member's messages losing their
  // sender.
  const renamedGroupParticipants = [
    { chat_guid: "group-2", address: "+15550000001" },
    { chat_guid: "group-2", address: "+15550000002" },
    // +15550000003 left the group: no row here at all any more.
  ];
  const renamed = readChatDbWindow(
    [
      row({ guid: "r1", chat_guid: "group-2", chat_display_name: "Trip 2027", chat_identifier: "chat987654", sender_address: "+15550000003" }),
      row({ rowid: "2", guid: "r2", chat_guid: "group-2", chat_display_name: "Trip 2027", chat_identifier: "chat987654", sender_address: "+15550000001", text: "still here" }),
    ],
    [],
    renamedGroupParticipants,
  );
  check(
    "a renamed group uses the name it carries NOW, for every message of the day alike",
    renamed.length === 2 && renamed.every((event) => event.subject === "Trip 2027"),
  );
  check(
    "a message from a participant who has since left still carries that sender's own address",
    renamed[0].from.address === "+15550000003",
  );
  const departedUnnamed = readChatDbWindow(
    [row({ guid: "r3", chat_guid: "group-2", chat_display_name: null, chat_identifier: "chat987654", is_from_me: 1, sender_address: null })],
    [],
    renamedGroupParticipants,
  );
  check(
    "an unnamed group's synthesized subject lists who is in it now, and never invents a departed member back into it",
    departedUnnamed[0].subject === "+15550000001, +15550000002",
  );
  check(
    "...and a message sent from this device is addressed to the current members only",
    departedUnnamed[0].to.map((entry) => entry.address).join(",") === "+15550000001,+15550000002",
  );

  const [oneOnOne] = readChatDbWindow(
    [row({ guid: "g3", chat_guid: "solo-chat", chat_display_name: null, chat_identifier: "+15551234567" })],
    [],
    [],
  );
  check("a one-on-one chat with no display name and no participant rows falls back to the chat identifier", oneOnOne.subject === "+15551234567");
}
