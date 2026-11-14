import { describe, expect, it } from "vitest";
import { parsePhotonEvent, photonAttachmentGuids } from "./photonInbound";
import { photonChatId, photonGroupId } from "./photon";

const LINE = "+15555550199";
const PHONE = "+15555550100";
const OTHER = "+15555550101";
const GUID = "any;+;ABCDEF0123456789";
const GROUP_ID = photonGroupId(GUID);
const GENERIC_ADDRESS = (guid: string) => `https://agent.example/photon/attachment/${guid}?s=sig`;

/** A `PhotonEvent` as the bridge sends it (plan.md, Contract A); the overrides change one field each. */
function event(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    seq: 1,
    eventId: "photon:message.received:msg-1",
    type: "message.received",
    line: LINE,
    chat: { guid: `any;-;${PHONE}`, kind: "dm" },
    from: PHONE,
    fromMe: false,
    at: "2026-11-14T10:00:00.000Z",
    message: { guid: "msg-1", text: "hello", service: "iMessage" },
    ...over,
  };
}

function groupEvent(over: Record<string, unknown> = {}): Record<string, unknown> {
  return event({ chat: { guid: GUID, kind: "group", participants: [PHONE, OTHER] }, ...over });
}

function reactionEvent(kind: string, extra: Record<string, unknown> = {}, type = "message.reactionAdded"): Record<string, unknown> {
  return event({
    eventId: "photon:message.reactionAdded:msg-1",
    type,
    message: undefined,
    reaction: { kind, targetGuid: "msg-tex-1", ...extra },
  });
}

describe("parsePhotonEvent: messages in a 1:1 chat", () => {
  it("reads a text as a message, keyed by the line and the person, with the bridge's guid", () => {
    expect(parsePhotonEvent(event())).toEqual({
      kind: "message",
      eventId: "photon:msg-1",
      chatId: photonChatId(LINE, PHONE),
      from: PHONE,
      messageId: "msg-1",
      text: "hello",
    });
  });

  it("trims the words and cuts a text past the limit, as the other providers do", () => {
    const long = `  ${"a".repeat(20_500)}  `;
    const parsed = parsePhotonEvent(event({ message: { guid: "msg-long", text: long, service: "iMessage" } }));
    expect(parsed).toMatchObject({ kind: "message", left: expect.any(Number) });
    expect((parsed as { text: string }).text.length).toBeLessThanOrEqual(20_000);
  });

  it("gives a picture its address from the route, and leaves off one with none", () => {
    const body = event({
      message: {
        guid: "msg-pic",
        text: "",
        service: "iMessage",
        attachments: [
          { guid: "att-1", name: "IMG_1.HEIC", mimeType: "image/HEIC", size: 1234 },
          { guid: "att-unsigned", name: "x.png", mimeType: "image/png", size: null },
        ],
      },
    });
    const parsed = parsePhotonEvent(body, { attachmentUrl: (guid) => (guid === "att-1" ? GENERIC_ADDRESS(guid) : undefined) });
    expect(parsed).toMatchObject({
      kind: "message",
      text: "",
      attachments: [{ url: GENERIC_ADDRESS("att-1"), mimeType: "image/heic", filename: "IMG_1.HEIC", size: 1234 }],
    });
    // Without any address, a picture alone is nothing to answer.
    expect(parsePhotonEvent(body)).toEqual({ kind: "ignored", reason: "empty" });
  });

  it("marks a reply as threaded, without its words or the Sendblue handle", () => {
    const parsed = parsePhotonEvent(event({ message: { guid: "msg-r", text: "yes", service: "iMessage", replyTo: "msg-tex-1" } }));
    expect(parsed).toMatchObject({ kind: "message", threaded: true });
    expect(parsed).not.toHaveProperty("replyTo");
    expect(parsed).not.toHaveProperty("quoted");
  });

  it("keeps an SMS, flagged, and reads none of its files", () => {
    const sms = parsePhotonEvent(
      event({
        message: { guid: "msg-sms", text: "hi", service: "SMS", attachments: [{ guid: "a", name: "p.png", mimeType: "image/png", size: 1 }] },
      }),
      { attachmentUrl: () => GENERIC_ADDRESS("a") },
    );
    expect(sms).toEqual({ kind: "message", eventId: "photon:msg-sms", chatId: photonChatId(LINE, PHONE), from: PHONE, messageId: "msg-sms", text: "hi", sms: true });
  });

  it("ignores a service that is neither iMessage nor SMS, and a sender that is not a phone", () => {
    expect(parsePhotonEvent(event({ message: { guid: "m", text: "hi", service: "RCS" } }))).toEqual({ kind: "ignored", reason: "service" });
    expect(parsePhotonEvent(event({ from: "person@example.com" }))).toEqual({ kind: "ignored", reason: "sender" });
  });

  it("reads one of our iMessage app cards as the words it stands for, and another app's card as nothing", () => {
    const ours = "lc.context.texts.messages";
    const card = parsePhotonEvent(
      event({ message: { guid: "m-card", text: "Pick", service: "iMessage", balloonBundleId: ours, appUrl: "https://context.lc/tex/ask?k=abc123&c=1" } }),
    );
    expect(card).toMatchObject({ kind: "message", text: "yes", viaCard: { ask: "abc123" } });
    const other = parsePhotonEvent(event({ message: { guid: "m-other", text: "Poll", service: "iMessage", balloonBundleId: "com.apple.Polls", appUrl: "https://x.example" } }));
    expect(other).toEqual({ kind: "ignored", reason: "app_card" });
  });

  it("ignores a message with no words and no file", () => {
    expect(parsePhotonEvent(event({ message: { guid: "m-empty", text: "   ", service: "iMessage" } }))).toEqual({ kind: "ignored", reason: "empty" });
  });
});

describe("parsePhotonEvent: groups", () => {
  it("reads a group message into the group's own queue, with its participants and the sender among them", () => {
    expect(parsePhotonEvent(groupEvent())).toEqual({
      kind: "group-message",
      eventId: "photon:msg-1",
      groupId: GROUP_ID,
      line: LINE,
      from: PHONE,
      participants: [PHONE, OTHER],
      messageId: "msg-1",
      text: "hello",
    });
  });

  it("adds a sender the list leaves out, and counts an entry that is not a string as somebody unknown", () => {
    const parsed = parsePhotonEvent(groupEvent({ from: OTHER, chat: { guid: GUID, kind: "group", participants: [PHONE, 7] } }));
    expect(parsed).toMatchObject({ kind: "group-message", participants: [PHONE, "?", OTHER] });
  });

  it("keeps a group SMS flagged, with no files read", () => {
    const parsed = parsePhotonEvent(
      groupEvent({ message: { guid: "g-sms", text: "hey", service: "SMS", attachments: [{ guid: "a", name: "p.png", mimeType: "image/png", size: 1 }] } }),
      { attachmentUrl: () => GENERIC_ADDRESS("a") },
    );
    expect(parsed).toMatchObject({ kind: "group-message", text: "hey", sms: true });
    expect(parsed).not.toHaveProperty("attachments");
  });

  it("reads a group's reaction on Tex's text, and a group's removal, as a reaction in the group", () => {
    const added = parsePhotonEvent(groupEvent({ type: "message.reactionAdded", message: undefined, reaction: { kind: "like", targetGuid: "t" }, eventId: "photon:message.reactionAdded:r1" }));
    expect(added).toMatchObject({ kind: "group-message", groupId: GROUP_ID, reaction: { how: "Liked", words: "" }, eventId: "photon:message.reactionAdded:r1" });
    const removed = parsePhotonEvent(groupEvent({ type: "message.reactionRemoved", message: undefined, reaction: { kind: "like", targetGuid: "t" } }));
    expect(removed).toMatchObject({ kind: "group-message", reaction: { how: "Liked", removed: true } });
  });
});

describe("parsePhotonEvent: tapbacks", () => {
  it.each([
    ["love", "Loved"],
    ["like", "Liked"],
    ["dislike", "Disliked"],
    ["laugh", "Laughed at"],
    ["emphasize", "Emphasized"],
    ["question", "Questioned"],
  ] as const)("reads %s on a text of Tex's as %s, naming the message it was on", (kind, how) => {
    expect(parsePhotonEvent(reactionEvent(kind))).toEqual({
      kind: "reaction",
      eventId: "photon:message.reactionAdded:msg-1",
      chatId: photonChatId(LINE, PHONE),
      from: PHONE,
      messageId: "photon:message.reactionAdded:msg-1",
      reaction: { how, words: "" },
      on: "msg-tex-1",
    });
  });

  it("reads a removal as removed", () => {
    expect(parsePhotonEvent(reactionEvent("love", {}, "message.reactionRemoved"))).toMatchObject({ kind: "reaction", reaction: { how: "Loved", words: "", removed: true } });
  });

  it("reads any other emoji as Reacted with that emoji, and a sticker as nothing", () => {
    expect(parsePhotonEvent(reactionEvent("emoji", { emoji: "🎉" }))).toMatchObject({ kind: "reaction", reaction: { how: "Reacted", emoji: "🎉" } });
    expect(parsePhotonEvent(reactionEvent("sticker"))).toEqual({ kind: "ignored", reason: "reaction" });
    expect(parsePhotonEvent(reactionEvent("wave"))).toEqual({ kind: "ignored", reason: "reaction" });
  });
});

describe("parsePhotonEvent: edits and unsends", () => {
  it("reads an edit as a side event on the message, with its new words, in a 1:1 chat", () => {
    expect(
      parsePhotonEvent(
        event({ type: "message.edited", eventId: "photon:message.edited:msg-2", message: { guid: "msg-2", text: "new words", service: "iMessage" }, edited: { targetGuid: "msg-2", previousText: "old" } }),
      ),
    ).toEqual({
      kind: "edited",
      eventId: "photon:message.edited:msg-2",
      chatId: photonChatId(LINE, PHONE),
      from: PHONE,
      messageId: "msg-2",
      text: "new words",
      at: "2026-11-14T10:00:00.000Z",
    });
  });

  it("reads an unsend as a side event with no words, in a group", () => {
    expect(parsePhotonEvent(groupEvent({ type: "message.unsent", eventId: "photon:message.unsent:msg-3", unsent: { targetGuid: "msg-3" } }))).toEqual({
      kind: "unsent",
      eventId: "photon:message.unsent:msg-3",
      groupId: GROUP_ID,
      from: PHONE,
      messageId: "msg-3",
      at: "2026-11-14T10:00:00.000Z",
    });
  });

  it("drops an edit or an unsend from a sender that is not a phone", () => {
    expect(parsePhotonEvent(event({ type: "message.unsent", from: "x@example.com", unsent: { targetGuid: "m" } }))).toEqual({ kind: "ignored", reason: "sender" });
  });
});

describe("parsePhotonEvent: what is not a message", () => {
  it("ignores Tex's own side of every event (fromMe), whatever kind it is", () => {
    expect(parsePhotonEvent(event({ fromMe: true }))).toEqual({ kind: "ignored", reason: "event_type" });
    expect(parsePhotonEvent({ ...reactionEvent("love"), fromMe: true })).toEqual({ kind: "ignored", reason: "event_type" });
    expect(parsePhotonEvent(groupEvent({ fromMe: true }))).toEqual({ kind: "ignored", reason: "event_type" });
    expect(parsePhotonEvent(event({ type: "message.unsent", fromMe: true, unsent: { targetGuid: "m" } }))).toEqual({ kind: "ignored", reason: "event_type" });
    expect(parsePhotonEvent(event({ type: "message.edited", fromMe: true, edited: { targetGuid: "m" } }))).toEqual({ kind: "ignored", reason: "event_type" });
  });

  it("ignores a read receipt, a group change and a chat change as an event type", () => {
    expect(parsePhotonEvent(event({ type: "message.read", message: undefined, read: { targetGuid: "m" } }))).toEqual({ kind: "ignored", reason: "event_type" });
    expect(parsePhotonEvent(event({ type: "group.changed", message: undefined }))).toEqual({ kind: "ignored", reason: "event_type" });
    expect(parsePhotonEvent(event({ type: "chat.other", message: undefined }))).toEqual({ kind: "ignored", reason: "event_type" });
  });
});

describe("parsePhotonEvent: malformed", () => {
  it.each([
    ["not an object", null],
    ["an array", []],
    ["an unknown type", event({ type: "message.teleported" })],
    ["a line that is not E.164", event({ line: "5555550199" })],
    ["no event id", event({ eventId: "" })],
    ["no time", event({ at: undefined })],
    ["a chat of no kind", event({ chat: { guid: "x", kind: "channel" } })],
    ["fromMe that is not a boolean", event({ fromMe: "no" })],
    ["a message with no guid", event({ message: { text: "hi", service: "iMessage" } })],
    ["a group guid that is not Photon's", groupEvent({ chat: { guid: "not-a-group", kind: "group" } })],
    ["a reaction with no target", event({ type: "message.reactionAdded", message: undefined, reaction: { kind: "love" } })],
    ["an edit with no target", event({ type: "message.edited", edited: {} })],
  ])("refuses %s as invalid", (_name, body) => {
    expect(parsePhotonEvent(body)).toEqual({ kind: "invalid" });
  });
});

describe("photonAttachmentGuids", () => {
  it("lists the guids a message names, and nothing for a message with none", () => {
    expect(photonAttachmentGuids(event({ message: { guid: "m", text: "", attachments: [{ guid: "a" }, { name: "no guid" }, { guid: "b" }] } }))).toEqual(["a", "b"]);
    expect(photonAttachmentGuids(event())).toEqual([]);
    expect(photonAttachmentGuids(null)).toEqual([]);
  });
});
