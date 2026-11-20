import assert from "node:assert/strict";
import test from "node:test";

import { mapEvent } from "../container/map.mjs";

const LINE = "+15550100123";
const DM = "any;-;+15550100999";
const GROUP = "any;+;chat-fixture-1";
const WHEN = new Date("2026-11-14T12:00:00.000Z");

function message(overrides = {}) {
  return {
    guid: "msg-fixture-1",
    chatGuids: [DM],
    isFromMe: false,
    dateCreated: WHEN,
    sender: { address: "+15550100999", country: "US", service: "iMessage" },
    content: {
      text: "hello there",
      attachments: [],
      formatting: [],
      mentions: [],
    },
    appliedReactions: [],
    placedStickers: [],
    replyTargetGuid: undefined,
    threadOriginatorGuid: undefined,
    ...overrides,
  };
}

function received(overrides = {}, messageOverrides = {}) {
  return {
    type: "message.received",
    sequence: 101,
    chatGuid: DM,
    isFromMe: false,
    occurredAt: WHEN,
    message: message(messageOverrides),
    ...overrides,
  };
}

test("a received message maps to the contract with a stable eventId", () => {
  const event = received();
  const first = mapEvent(event, LINE);
  const replay = mapEvent(event, LINE);
  assert.equal(first.type, "message.received");
  assert.equal(first.seq, 101);
  assert.equal(first.eventId, "photon:message.received:msg-fixture-1");
  assert.equal(first.line, LINE);
  assert.deepEqual(first.chat, { guid: DM, kind: "dm" });
  assert.equal(first.from, "+15550100999");
  assert.equal(first.fromMe, false);
  assert.equal(first.at, "2026-11-14T12:00:00.000Z");
  assert.deepEqual(first.message, { guid: "msg-fixture-1", text: "hello there", service: "iMessage", attachments: [] });
  assert.deepEqual(replay, first);
});

test("a message I sent has no from address and is marked fromMe", () => {
  const mapped = mapEvent(received({ isFromMe: true }, { isFromMe: true, sender: undefined }), LINE);
  assert.equal(mapped.fromMe, true);
  assert.equal(mapped.from, undefined);
  assert.equal(mapped.message.service, "unknown");
});

test("a group chat is recognised from its guid and carries the group title", () => {
  const mapped = mapEvent(received({ chatGuid: GROUP }, { chatGuids: [GROUP], groupTitle: "Weekend" }), LINE);
  assert.deepEqual(mapped.chat, { guid: GROUP, kind: "group", name: "Weekend" });
});

test("a received message keeps its reply target and the words the bridge looked up", () => {
  const mapped = mapEvent(
    received({}, { replyTargetGuid: "msg-fixture-0", threadOriginatorGuid: "msg-fixture-0" }),
    LINE,
    { replyToText: "the earlier words", replyToFromMe: true },
  );
  assert.equal(mapped.message.replyTo, "msg-fixture-0");
  assert.equal(mapped.message.threadRoot, "msg-fixture-0");
  assert.equal(mapped.message.replyToText, "the earlier words");
  assert.equal(mapped.message.replyToFromMe, true);
});

test("attachments keep name, mime type and size", () => {
  const mapped = mapEvent(
    received({}, {
      content: {
        text: "",
        attachments: [{ guid: "at-fixture-1", fileName: "photo.jpg", mimeType: "image/jpeg", totalBytes: 2048 }],
        formatting: [],
        mentions: [],
      },
    }),
    LINE,
  );
  assert.deepEqual(mapped.message.attachments, [
    { guid: "at-fixture-1", name: "photo.jpg", mimeType: "image/jpeg", size: 2048 },
  ]);
});

test("an edit carries the new words and the previous ones when the bridge had them", () => {
  const event = {
    type: "message.edited",
    sequence: 110,
    messageGuid: "msg-fixture-1",
    chatGuid: DM,
    isFromMe: false,
    occurredAt: WHEN,
    actor: { address: "+15550100999", service: "iMessage" },
    content: { text: "edited words", attachments: [], formatting: [], mentions: [] },
    editedAt: new Date("2026-11-14T12:05:00.000Z"),
  };
  const withPrevious = mapEvent(event, LINE, { previousText: "hello there" });
  assert.equal(withPrevious.type, "message.edited");
  assert.equal(withPrevious.at, "2026-11-14T12:05:00.000Z");
  assert.equal(withPrevious.eventId, "photon:message.edited:msg-fixture-1:110");
  assert.deepEqual(withPrevious.edited, { targetGuid: "msg-fixture-1", previousText: "hello there" });
  assert.equal(withPrevious.message.text, "edited words");

  const without = mapEvent(event, LINE);
  assert.equal(without.edited.previousText, undefined);
});

test("an unsend maps to the target guid", () => {
  const mapped = mapEvent({
    type: "message.unsent",
    sequence: 111,
    messageGuid: "msg-fixture-1",
    chatGuid: DM,
    isFromMe: true,
    occurredAt: WHEN,
    retractedAt: new Date("2026-11-14T12:06:00.000Z"),
  }, LINE);
  assert.equal(mapped.type, "message.unsent");
  assert.equal(mapped.fromMe, true);
  assert.deepEqual(mapped.unsent, { targetGuid: "msg-fixture-1" });
  assert.equal(mapped.at, "2026-11-14T12:06:00.000Z");
});

test("a read receipt names the message it covers", () => {
  const mapped = mapEvent({
    type: "message.read",
    sequence: 112,
    messageGuid: "msg-fixture-1",
    chatGuid: DM,
    isFromMe: false,
    occurredAt: WHEN,
    readAt: WHEN,
  }, LINE);
  assert.deepEqual(mapped.read, { targetGuid: "msg-fixture-1" });
});

test("a reaction carries kind, target part and the target's words", () => {
  const event = {
    type: "message.reactionAdded",
    sequence: 113,
    messageGuid: "msg-fixture-1",
    chatGuid: DM,
    isFromMe: false,
    occurredAt: WHEN,
    actor: { address: "+15550100999", service: "iMessage" },
    reaction: { kind: "emoji", emoji: "🎉" },
    targetPartIndex: 1,
  };
  const mapped = mapEvent(event, LINE, { targetText: "hello there", targetFromMe: true });
  assert.equal(mapped.type, "message.reactionAdded");
  assert.deepEqual(mapped.reaction, {
    kind: "emoji",
    emoji: "🎉",
    targetGuid: "msg-fixture-1",
    targetPart: 1,
    targetText: "hello there",
    targetFromMe: true,
  });
});

test("a reaction kind outside the contract is reported as unknown", () => {
  const mapped = mapEvent({
    type: "message.reactionRemoved",
    sequence: 114,
    messageGuid: "msg-fixture-1",
    chatGuid: DM,
    isFromMe: false,
    occurredAt: WHEN,
    reaction: { kind: "mystery" },
  }, LINE);
  assert.equal(mapped.reaction.kind, "unknown");
});

test("a group change maps with its change and the address it concerns", () => {
  const mapped = mapEvent({
    type: "group.changed",
    sequence: 120,
    chatGuid: GROUP,
    isFromMe: false,
    occurredAt: WHEN,
    actor: { address: "+15550100999", service: "iMessage" },
    change: { type: "participantAdded", participant: { address: "+15550100777", service: "iMessage" } },
  }, LINE);
  assert.equal(mapped.type, "group.changed");
  assert.deepEqual(mapped.group, { change: "participantAdded", address: "+15550100777" });
  assert.equal(mapped.chat.kind, "group");
});

test("chat events map to chat.other and name the event", () => {
  const mapped = mapEvent({
    type: "chat.markedRead",
    sequence: 121,
    chatGuid: DM,
    isFromMe: false,
    occurredAt: WHEN,
  }, LINE);
  assert.equal(mapped.type, "chat.other");
  assert.equal(mapped.chatEvent, "chat.markedRead");
  assert.equal(mapped.eventId, `photon:chat.markedRead:${DM}:121`);
});

test("events outside the contract, catchup.complete and malformed input map to nothing", () => {
  assert.equal(mapEvent({ type: "catchup.complete", headSequence: 500 }, LINE), null);
  assert.equal(mapEvent({ type: "poll.changed", sequence: 130, chatGuid: DM }, LINE), null);
  assert.equal(mapEvent({ type: "message.stickerPlaced", sequence: 131, chatGuid: DM }, LINE), null);
  assert.equal(mapEvent(null, LINE), null);
  assert.equal(mapEvent({ type: "message.received", sequence: "1" }, LINE), null);
});

test("an event with no chat cannot be routed and is not mapped", () => {
  assert.equal(mapEvent({ type: "message.unsent", sequence: 140, messageGuid: "m", isFromMe: false }, LINE), null);
});

test("an invalid date falls back to the observation time, not a crash", () => {
  const mapped = mapEvent(received({}, { dateCreated: new Date("nope") }), LINE);
  assert.match(mapped.at, /^\d{4}-\d{2}-\d{2}T/);
});

test("the mapped event is JSON-safe and carries no undefined members", () => {
  const mapped = mapEvent(received(), LINE);
  const text = JSON.stringify(mapped);
  assert.equal(text, JSON.stringify(JSON.parse(text)));
  assert.equal("replyToText" in mapped.message, false);
});

test("a sticker stuck on a message is a sticker reaction on that message", () => {
  const mapped = mapEvent(
    { type: "message.stickerPlaced", sequence: 140, chatGuid: DM, isFromMe: false, occurredAt: WHEN, actor: { address: "+15550100999", service: "iMessage" }, messageGuid: "target-1", sticker: { guid: "att" } },
    LINE,
    { targetText: "Tex's words", targetFromMe: true },
  );
  assert.equal(mapped.type, "message.reactionAdded");
  assert.equal(mapped.eventId, "photon:message.stickerPlaced:target-1:140");
  assert.deepEqual(mapped.reaction, { kind: "sticker", targetGuid: "target-1", targetText: "Tex's words", targetFromMe: true });
  assert.equal(mapped.from, "+15550100999");
});

test("a poll started, an option added and a vote are messages in words", () => {
  const base = { type: "poll.changed", chatGuid: GROUP, isFromMe: false, occurredAt: WHEN, actor: { address: "+15550100999", service: "iMessage" }, pollMessageGuid: "poll-1" };
  const created = mapEvent({ ...base, sequence: 150, delta: { type: "created", title: "Dinner", options: [{ optionIdentifier: "a", text: "Pizza" }, { optionIdentifier: "b", text: "Tacos" }] } }, LINE);
  assert.equal(created.type, "message.received");
  assert.equal(created.chat.kind, "group");
  assert.equal(created.message.text, "Started a poll “Dinner”: “Pizza”, “Tacos”");
  assert.equal(created.message.guid, "poll-1:poll:150");
  assert.equal(created.message.poll, true);
  assert.equal(created.message.service, "iMessage");
  const voted = mapEvent({ ...base, sequence: 151, delta: { type: "voted", optionIdentifier: "b" } }, LINE, { poll: { title: "Dinner", options: [{ id: "a", text: "Pizza" }, { id: "b", text: "Tacos" }] } });
  assert.equal(voted.message.text, "Voted “Tacos” in the poll “Dinner”");
  const blind = mapEvent({ ...base, sequence: 152, delta: { type: "voted", optionIdentifier: "b" } }, LINE);
  assert.equal(blind.message.text, "Voted in the poll");
  const unvoted = mapEvent({ ...base, sequence: 153, delta: { type: "unvoted", optionIdentifier: "b" } }, LINE, { poll: { title: "Dinner", options: [] } });
  assert.equal(unvoted.message.text, "Took back a vote in the poll “Dinner”");
  assert.equal(mapEvent({ ...base, sequence: 154, delta: { type: "mystery" } }, LINE), null);
});

test("an event Apple gave no time is stamped with the observation time and marked atGuessed; a dated one is not", () => {
  const base = { type: "message.received", sequence: 77, chatGuid: DM, isFromMe: false };
  const undated = mapEvent({ ...base, message: { guid: "msg-undated", chatGuids: [DM], isFromMe: false, sender: { address: "+15550100999" }, content: { text: "hi", attachments: [] } } }, LINE, {});
  assert.equal(undated.atGuessed, true);
  assert.equal(Number.isNaN(Date.parse(undated.at)), false);
  assert.equal("replay" in undated, false, "mapping alone does not mark a replay");

  const dated = mapEvent({ ...base, message: { guid: "msg-dated", chatGuids: [DM], isFromMe: false, dateCreated: WHEN, sender: { address: "+15550100999" }, content: { text: "hi", attachments: [] } } }, LINE, {});
  assert.equal(dated.at, WHEN.toISOString());
  assert.equal("atGuessed" in dated, false);
});
