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
    expect(parsePhotonEvent(body)).toMatchObject({ kind: "ignored", reason: "empty" });
  });

  it("marks a reply as threaded, and carries the words it answers as quoted", () => {
    const parsed = parsePhotonEvent(event({ message: { guid: "msg-r", text: "yes", service: "iMessage", replyTo: "msg-tex-1", replyToText: "Book it?", replyToFromMe: true } }));
    expect(parsed).toMatchObject({ kind: "message", threaded: true, quoted: "Book it?" });
    expect(parsed).not.toHaveProperty("replyTo");
  });

  it("marks a reply threaded with no quoted words when the bridge sent none", () => {
    const parsed = parsePhotonEvent(event({ message: { guid: "msg-r2", text: "yes", service: "iMessage", replyTo: "msg-tex-1" } }));
    expect(parsed).toMatchObject({ kind: "message", threaded: true });
    expect(parsed).not.toHaveProperty("quoted");
  });

  it("does not drop a file that is not a preview, and drops a link's preview file and any file sent with an address", () => {
    const withFile = (name: string, text: string) =>
      parsePhotonEvent(event({ message: { guid: "m-f", text, service: "iMessage", attachments: [{ guid: "a", name, mimeType: "image/png", size: 1 }] } }), {
        attachmentUrl: () => "https://agent.example/photon/attachment/a?s=x",
      });
    expect(withFile("photo.png", "look")).toMatchObject({ kind: "message", attachments: [{ filename: "photo.png" }] });
    // A rich link's card is a plugin payload, never something the person sent.
    expect(withFile("Preview.pluginPayloadAttachment", "")).toMatchObject({ kind: "ignored", reason: "empty" });
    // A file sent with an address in its words is that address's preview (`isPreviewFile`).
    expect(withFile("photo.png", "https://example.com/page")).toMatchObject({ kind: "message", text: "https://example.com/page" });
    expect(withFile("photo.png", "https://example.com/page")).not.toHaveProperty("attachments");
  });

  it("refuses a group whose guid is too long for the gateway's id limit, as invalid", () => {
    expect(parsePhotonEvent(groupEvent({ chat: { guid: `any;+;${"A".repeat(73)}`, kind: "group" } }))).toEqual({ kind: "invalid" });
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
    expect(parsePhotonEvent(event({ from: "person@example.com" }))).toEqual({ kind: "ignored", reason: "sender" });
  });

  it("reads one of our iMessage app cards as the words it stands for, and another app's card as nothing", () => {
    const ours = "lc.context.texts.messages";
    const card = parsePhotonEvent(
      event({ message: { guid: "m-card", text: "Pick", service: "iMessage", balloonBundleId: ours, appUrl: "https://context.lc/tex/ask?k=abc123&c=1" } }),
    );
    expect(card).toMatchObject({ kind: "message", text: "yes", viaCard: { ask: "abc123" } });
    const other = parsePhotonEvent(event({ message: { guid: "m-other", text: "Poll", service: "iMessage", balloonBundleId: "com.apple.Polls", appUrl: "https://x.example" } }));
    expect(other).toEqual({ kind: "ignored", reason: "app_card", chatId: photonChatId(LINE, PHONE), from: PHONE });
  });

  // Dev, 2026-11-23: other apps' cards (Apple Cash, Check In, Find My) are read as the words on them.
  it("reads another app's card by the words on it, in a 1:1 and a group, and never by its address", () => {
    const cash = {
      guid: "m-cash",
      text: "",
      service: "iMessage",
      balloonBundleId: "com.apple.messages.MSMessageExtensionBalloonPlugin:T:com.apple.PassbookUIService.PeerPaymentMessagesExtension",
      appUrl: "https://pay.example/secret-token",
      app: { name: "Apple Pay", bundle: "com.apple.PassbookUIService.PeerPaymentMessagesExtension", caption: "$40", subcaption: "Sent" },
    };
    const dm = parsePhotonEvent(event({ message: cash }));
    expect(dm).toMatchObject({ kind: "message", text: "(Apple Cash card: $40 · Sent)" });
    expect(JSON.stringify(dm)).not.toContain("secret-token");
    expect(parsePhotonEvent(groupEvent({ message: cash }))).toMatchObject({ kind: "group-message", text: "(Apple Cash card: $40 · Sent)" });
    const checkIn = { guid: "m-ci", text: "", service: "iMessage", balloonBundleId: "x:T:com.apple.SafetyMonitorApp.SafetyMonitorMessages", appUrl: "https://x.example", app: { bundle: "com.apple.SafetyMonitorApp.SafetyMonitorMessages", summary: "Sam arrived home" } };
    expect(parsePhotonEvent(groupEvent({ message: checkIn }))).toMatchObject({ text: "(Check In card: Sam arrived home)" });
  });

  it("reads a native tag as a tag and an effect by its name, and leaves a plain text as it was", () => {
    const tagged = { guid: "m-tag", text: "Tex can you ask Sam", service: "iMessage", mentions: [{ address: LINE, start: 0, length: 3 }, { address: OTHER, start: 16, length: 3 }] };
    expect(parsePhotonEvent(groupEvent({ message: tagged }))).toMatchObject({ kind: "group-message", text: "@Tex can you ask @Sam" });
    expect(parsePhotonEvent(event({ message: tagged }))).toMatchObject({ kind: "message", text: "@Tex can you ask @Sam" });
    const slam = { guid: "m-slam", text: "WE WON", service: "iMessage", effect: "com.apple.MobileSMS.expressivesend.impact" };
    expect(parsePhotonEvent(groupEvent({ message: slam }))).toMatchObject({ text: "(sent with Slam) WE WON" });
    expect(parsePhotonEvent(groupEvent({ message: { guid: "m-p", text: "Tex hi", service: "iMessage" } }))).toMatchObject({ text: "Tex hi" });
  });

  it("keeps a tag in an edit's new words", () => {
    const edit = event({ type: "message.edited", eventId: "photon:message.edited:m-1:3", message: { guid: "m-1", text: "Sam, call Tex", mentions: [{ address: OTHER, start: 0, length: 3 }] }, edited: { targetGuid: "m-1" } });
    expect(parsePhotonEvent(edit)).toMatchObject({ kind: "edited", text: "@Sam, call Tex" });
  });

  // 2026-11-17: a link sent with its preview reached Tex in a group but was dropped in a 1:1 as another app's card.
  it("reads a link sent with Apple's preview as its words, in a 1:1 as in a group", () => {
    const link = "https://shop.example/products/hoodie";
    const preview = { guid: "m-link", text: link, service: "iMessage", balloonBundleId: "com.apple.messages.URLBalloonProvider" };
    expect(parsePhotonEvent(event({ message: preview }))).toEqual({ kind: "message", eventId: "photon:m-link", chatId: photonChatId(LINE, PHONE), from: PHONE, messageId: "m-link", text: link });
    expect(parsePhotonEvent(groupEvent({ message: preview }))).toMatchObject({ kind: "group-message", groupId: GROUP_ID, text: link });
    // A card with no app address whose words are one link is a preview too, whatever id the bridge names it by.
    const unnamed = parsePhotonEvent(event({ message: { guid: "m-link2", text: link, service: "iMessage", balloonBundleId: "com.apple.messages.SomethingNew" } }));
    expect(unnamed).toMatchObject({ kind: "message", text: link });
    // Another app's card whose words happen to be a link, with its own address, is still that app's card.
    const app = parsePhotonEvent(event({ message: { guid: "m-app", text: link, service: "iMessage", balloonBundleId: "com.example.app", appUrl: "https://x.example" } }));
    expect(app).toMatchObject({ kind: "ignored", reason: "app_card" });
  });

  it("answers an RCS text (an Android phone) as an SMS: kept for its fixed answer, its files not read", () => {
    expect(parsePhotonEvent(event({ message: { guid: "m", text: "hi", service: "RCS" } }))).toMatchObject({ kind: "message", text: "hi", sms: true });
    expect(parsePhotonEvent(groupEvent({ message: { guid: "m", text: "hi", service: "RCS" } }))).toMatchObject({ kind: "group-message", sms: true });
  });

  it("reads a poll's change, which the bridge tells in words, as the person's message", () => {
    expect(parsePhotonEvent(groupEvent({ message: { guid: "poll-1:poll:150", text: "Started a poll “Dinner”: “Pizza”, “Tacos”", service: "iMessage", attachments: [], poll: true } }))).toMatchObject({
      kind: "group-message", text: "Started a poll “Dinner”: “Pizza”, “Tacos”", messageId: "poll-1:poll:150",
    });
  });

  it("names the chat a dropped message was sent in, so its history can show the drop", () => {
    expect(parsePhotonEvent(event({ message: { guid: "m", text: "hi", service: "unknown" } }))).toEqual({ kind: "ignored", reason: "service", chatId: photonChatId(LINE, PHONE), from: PHONE });
    expect(parsePhotonEvent(groupEvent({ message: { guid: "m", text: " ", service: "iMessage" } }))).toEqual({
      kind: "ignored", reason: "empty", groupId: GROUP_ID, line: LINE, from: PHONE, participants: [PHONE, OTHER],
    });
  });

  it("ignores a message with no words and no file", () => {
    expect(parsePhotonEvent(event({ message: { guid: "m-empty", text: "   ", service: "iMessage" } }))).toEqual({ kind: "ignored", reason: "empty", chatId: photonChatId(LINE, PHONE), from: PHONE });
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

  it("a group reply to Tex's own text carries those words as quoted; a reply to somebody else's does not", () => {
    const toTex = parsePhotonEvent(groupEvent({ message: { guid: "g-r", text: "yes", service: "iMessage", replyTo: "tex-1", replyToText: " Book it? ", replyToFromMe: true } }));
    expect(toTex).toMatchObject({ kind: "group-message", replyTo: "tex-1", quoted: "Book it?" });
    const toOther = parsePhotonEvent(groupEvent({ message: { guid: "g-r2", text: "same", service: "iMessage", replyTo: "p-1", replyToText: "lunch?", replyToFromMe: false } }));
    expect(toOther).toMatchObject({ kind: "group-message", replyTo: "p-1" });
    expect(toOther).not.toHaveProperty("quoted");
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
    });
  });

  it("carries Tex's own text a tapback was on, as its words, flagged onTex", () => {
    const parsed = parsePhotonEvent(reactionEvent("like", { targetText: "  Want me to book it?  ", targetFromMe: true }));
    expect(parsed).toMatchObject({ kind: "reaction", reaction: { how: "Liked", words: "Want me to book it?", onTex: true } });
  });

  it("flags a tapback on somebody else's message as onOther, its words apart from Tex's (a vote names what it voted on)", () => {
    const parsed = parsePhotonEvent(reactionEvent("like", { targetText: "  Thumbs up here if lunch at noon  ", targetFromMe: false }));
    expect(parsed).toMatchObject({ kind: "reaction", reaction: { how: "Liked", words: "", onOther: true, otherWords: "Thumbs up here if lunch at noon" } });
    expect(parsed).toMatchObject({ reaction: expect.not.objectContaining({ onTex: true }) });
  });

  it("a tapback on somebody else's message the bridge could not read carries no words of it", () => {
    const parsed = parsePhotonEvent(reactionEvent("dislike", { targetFromMe: false }));
    expect(parsed).toMatchObject({ kind: "reaction", reaction: { how: "Disliked", words: "", onOther: true } });
    expect(parsed).toMatchObject({ reaction: expect.not.objectContaining({ otherWords: expect.anything() }) });
  });

  it("a group tapback on somebody else's message keeps its words for the line", () => {
    const parsed = parsePhotonEvent(groupEvent({ type: "message.reactionAdded", message: undefined, reaction: { kind: "dislike", targetGuid: "t", targetText: "thumbs down if friday", targetFromMe: false } }));
    expect(parsed).toMatchObject({ kind: "group-message", reaction: { how: "Disliked", words: "", onOther: true, otherWords: "thumbs down if friday" } });
  });

  it("says nothing about a target it could not read: no words and no flag", () => {
    const parsed = parsePhotonEvent(reactionEvent("love", { targetFromMe: true }));
    expect(parsed).toMatchObject({ kind: "reaction", reaction: { how: "Loved", words: "" } });
    expect(parsed).toMatchObject({ reaction: expect.not.objectContaining({ onTex: true }) });
    expect(parsed).toMatchObject({ reaction: expect.not.objectContaining({ onOther: true }) });
  });

  it("carries a group tapback on Tex's text the same way", () => {
    const parsed = parsePhotonEvent(groupEvent({ type: "message.reactionAdded", message: undefined, reaction: { kind: "question", targetGuid: "t", targetText: "Pick one", targetFromMe: true } }));
    expect(parsed).toMatchObject({ kind: "group-message", reaction: { how: "Questioned", words: "Pick one", onTex: true } });
  });

  it("reads a removal as removed", () => {
    expect(parsePhotonEvent(reactionEvent("love", {}, "message.reactionRemoved"))).toMatchObject({ kind: "reaction", reaction: { how: "Loved", words: "", removed: true } });
  });

  it("reads any other emoji as Reacted with that emoji, and a sticker as Reacted with a sticker", () => {
    expect(parsePhotonEvent(reactionEvent("emoji", { emoji: "🎉" }))).toMatchObject({ kind: "reaction", reaction: { how: "Reacted", emoji: "🎉" } });
    expect(parsePhotonEvent(reactionEvent("sticker"))).toMatchObject({ kind: "reaction", reaction: { how: "Reacted", emoji: "with a sticker" } });
    expect(parsePhotonEvent(reactionEvent("wave"))).toEqual({ kind: "ignored", reason: "reaction" });
  });

  it("a placed sticker carries its own attachment on the line, for Tex to stick again (stickers.ts)", () => {
    expect(parsePhotonEvent(reactionEvent("sticker", { sticker: "at_0_ABC" }))).toMatchObject({ kind: "reaction", reaction: { how: "Reacted", emoji: "with a sticker", sticker: "at_0_ABC" } });
    const unnamed = parsePhotonEvent(reactionEvent("sticker", { sticker: "" }));
    expect(unnamed).toMatchObject({ kind: "reaction" });
    expect((unnamed as { reaction: object }).reaction).not.toHaveProperty("sticker");
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
      line: LINE,
      from: PHONE,
      messageId: "msg-2",
      text: "new words",
      previous: "old",
      at: "2026-11-14T10:00:00.000Z",
    });
  });

  it("reads a group's edit with its line and people, so it can be queued as the group's message", () => {
    const parsed = parsePhotonEvent(groupEvent({ type: "message.edited", eventId: "photon:message.edited:msg-4", message: { guid: "msg-4", text: "  7pm, not 6  ", service: "iMessage" }, edited: { targetGuid: "msg-4" } }));
    expect(parsed).toMatchObject({ kind: "edited", groupId: GROUP_ID, line: LINE, from: PHONE, messageId: "msg-4", text: "7pm, not 6" });
    expect((parsed as { participants?: string[] }).participants).toContain(PHONE);
    expect(parsed).not.toHaveProperty("previous");
  });

  it("drops an edit that leaves no words", () => {
    expect(parsePhotonEvent(event({ type: "message.edited", message: { guid: "m", text: "   ", service: "iMessage" }, edited: { targetGuid: "m" } }))).toEqual({ kind: "ignored", reason: "empty" });
  });

  it("reads an unsend as a side event with no words, in a group", () => {
    expect(parsePhotonEvent(groupEvent({ type: "message.unsent", eventId: "photon:message.unsent:msg-3", unsent: { targetGuid: "msg-3" } }))).toEqual({
      kind: "unsent",
      eventId: "photon:message.unsent:msg-3",
      groupId: GROUP_ID,
      line: LINE,
      from: PHONE,
      participants: expect.arrayContaining([PHONE]),
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
    expect(parsePhotonEvent(event({ fromMe: true }))).toEqual({ kind: "ignored", reason: "from_me" });
    expect(parsePhotonEvent({ ...reactionEvent("love"), fromMe: true })).toEqual({ kind: "ignored", reason: "from_me" });
    expect(parsePhotonEvent(groupEvent({ fromMe: true }))).toEqual({ kind: "ignored", reason: "from_me" });
    expect(parsePhotonEvent(event({ type: "message.unsent", fromMe: true, unsent: { targetGuid: "m" } }))).toEqual({ kind: "ignored", reason: "from_me" });
    expect(parsePhotonEvent(event({ type: "message.edited", fromMe: true, edited: { targetGuid: "m" } }))).toEqual({ kind: "ignored", reason: "from_me" });
  });

  it("ignores a read receipt, a group change and a chat change as an event type", () => {
    expect(parsePhotonEvent(event({ type: "message.read", message: undefined, read: { targetGuid: "m" } }))).toEqual({ kind: "ignored", reason: "read" });
    expect(parsePhotonEvent(event({ type: "group.changed", message: undefined }))).toEqual({ kind: "ignored", reason: "group_change" });
    expect(parsePhotonEvent(event({ type: "chat.other", message: undefined }))).toEqual({ kind: "ignored", reason: "chat_event" });
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
