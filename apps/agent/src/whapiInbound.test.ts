import { afterEach, describe, expect, it, vi } from "vitest";
import { parseWhapiWebhook } from "./whapiInbound";

const LINE = "+15550001111";
const PHONE = "15551234567";
const PERSON = "+15551234567";
const GROUP = "120363012345678901@g.us";

const message = (over: Record<string, unknown> = {}) => ({
  id: "3EB0ABCD-EF121234",
  type: "text",
  chat_id: `${PHONE}@s.whatsapp.net`,
  from: PHONE,
  from_me: false,
  from_name: "Sam",
  timestamp: 1_700_000_000,
  text: { body: "hello" },
  ...over,
});

const delivery = (...messages: unknown[]) => ({ messages, channel_id: "chan_1" });

afterEach(() => {
  vi.restoreAllMocks();
});

describe("whapi webhook: deliveries", () => {
  it("reads nothing from a payload that is not a record or has no messages", () => {
    expect(parseWhapiWebhook(null, LINE)).toEqual([]);
    expect(parseWhapiWebhook("messages", LINE)).toEqual([]);
    expect(parseWhapiWebhook([message()], LINE)).toEqual([]);
    expect(parseWhapiWebhook({ event: { type: "statuses", event: "post" } }, LINE)).toEqual([]);
    expect(parseWhapiWebhook({ messages: "nope" }, LINE)).toEqual([]);
  });

  it("yields one event per message in a delivery, in order", () => {
    const events = parseWhapiWebhook(
      delivery(
        message({ id: "AAAA1111-BBBB2222", text: { body: "one" } }),
        message({ id: "BBBB2222-CCCC3333", from_me: true }),
        message({ id: "CCCC3333-DDDD4444", text: { body: "three" } }),
      ),
      LINE,
    );
    expect(events.map((event) => event.kind)).toEqual(["message", "ignored", "message"]);
    expect(events[0]).toMatchObject({ kind: "message", messageId: "AAAA1111-BBBB2222", text: "one" });
    expect(events[2]).toMatchObject({ kind: "message", messageId: "CCCC3333-DDDD4444", text: "three" });
  });

  it("reads at most twenty messages from one delivery", () => {
    const many = Array.from({ length: 25 }, (_, index) => message({ id: `MSG${index}ABCD-WXYZ${index}` }));
    expect(parseWhapiWebhook(delivery(...many), LINE)).toHaveLength(20);
  });

  it("marks every message invalid when the line is not a phone number", () => {
    expect(parseWhapiWebhook(delivery(message()), "15550001111")).toEqual([{ kind: "invalid" }]);
  });
});

describe("whapi webhook: 1:1 chats", () => {
  it("takes an inbound text from the phone WhatsApp registered", () => {
    expect(parseWhapiWebhook(delivery(message()), LINE)).toEqual([
      {
        kind: "message",
        eventId: "whapi:3EB0ABCD-EF121234",
        chatId: `whapi:${LINE}:${PERSON}`,
        from: PERSON,
        messageId: "3EB0ABCD-EF121234",
        text: "hello",
      },
    ]);
  });

  it("trims the words and keeps them within the inbound limit", () => {
    const [event] = parseWhapiWebhook(delivery(message({ text: { body: `  ${"a".repeat(5000)}  ` } })), LINE);
    expect(event).toMatchObject({ kind: "message" });
    expect(event.kind === "message" && event.text.length).toBe(4000);
  });

  it("takes a picture with a caption and an https link as its words and one attachment", () => {
    const [event] = parseWhapiWebhook(
      delivery(
        message({
          type: "image",
          text: undefined,
          image: {
            id: "img_1",
            link: "https://cdn.whapi.example/media/IMG_1.jpg",
            mime_type: "image/jpeg",
            file_size: 2048,
            caption: " look at this ",
          },
        }),
      ),
      LINE,
    );
    expect(event).toEqual({
      kind: "message",
      eventId: "whapi:3EB0ABCD-EF121234",
      chatId: `whapi:${LINE}:${PERSON}`,
      from: PERSON,
      messageId: "3EB0ABCD-EF121234",
      text: "look at this",
      attachments: [
        { url: "https://cdn.whapi.example/media/IMG_1.jpg", mimeType: "image/jpeg", filename: "IMG_1.jpg", size: 2048 },
      ],
    });
  });

  it("takes a picture without a link as no attachment, and with no words it is empty", () => {
    expect(
      parseWhapiWebhook(delivery(message({ type: "image", text: undefined, image: { id: "img_2", mime_type: "image/png" } })), LINE),
    ).toEqual([{ kind: "ignored", reason: "empty" }]);
  });

  it("takes a picture without a link as its caption only, never as a file", () => {
    const [event] = parseWhapiWebhook(
      delivery(message({ type: "image", text: undefined, image: { id: "img_3", caption: "a note" } })),
      LINE,
    );
    expect(event).toMatchObject({ kind: "message", text: "a note" });
    expect(event).not.toHaveProperty("attachments");
  });

  it("refuses a link that is not https", () => {
    const [event] = parseWhapiWebhook(
      delivery(message({ type: "document", text: undefined, document: { id: "d", link: "http://cdn.example/a.pdf", file_name: "a.pdf" } })),
      LINE,
    );
    expect(event).toEqual({ kind: "ignored", reason: "empty" });
  });

  it("names a document after its file name, and reads a voice note's size", () => {
    const [event] = parseWhapiWebhook(
      delivery(
        message({
          type: "document",
          text: undefined,
          document: { id: "d", link: "https://cdn.example/x/1", filename: "Plan final.pdf", mime_type: "application/PDF", file_size: 9 },
        }),
      ),
      LINE,
    );
    expect(event).toMatchObject({ attachments: [{ filename: "Plan final.pdf", mimeType: "application/pdf", size: 9 }] });
  });

  it("reads the quoted words of a reply as quoted, and marks it threaded", () => {
    const [event] = parseWhapiWebhook(
      delivery(
        message({
          text: { body: "yes, do it" },
          context: { quoted_id: "3EB0QUOTED-ABCD9999", quoted_content: { body: "Want me to book it?" } },
        }),
      ),
      LINE,
    );
    expect(event).toEqual({
      kind: "message",
      eventId: "whapi:3EB0ABCD-EF121234",
      chatId: `whapi:${LINE}:${PERSON}`,
      from: PERSON,
      messageId: "3EB0ABCD-EF121234",
      text: "yes, do it",
      threaded: true,
      quoted: "Want me to book it?",
    });
    expect(event).not.toHaveProperty("replyTo");
  });

  it("marks a reply threaded without quoted when the replied-to words are absent", () => {
    const [event] = parseWhapiWebhook(delivery(message({ context: { quoted_id: "3EB0QUOTED-ABCD9999" } })), LINE);
    expect(event).toMatchObject({ kind: "message", threaded: true });
    expect(event).not.toHaveProperty("quoted");
  });

  it("ignores a message Tex sent, including one typed on the phone", () => {
    expect(parseWhapiWebhook(delivery(message({ from_me: true })), LINE)).toEqual([{ kind: "ignored", reason: "event_type" }]);
  });

  it("ignores a chat whose sender is a @lid, never reading its digits as a phone", () => {
    expect(parseWhapiWebhook(delivery(message({ chat_id: "98765432100123@lid", from: "98765432100123@lid" })), LINE)).toEqual([
      { kind: "ignored", reason: "sender" },
    ]);
  });

  it("ignores a broadcast or status chat as no sender", () => {
    expect(parseWhapiWebhook(delivery(message({ chat_id: "status@broadcast" })), LINE)).toEqual([
      { kind: "ignored", reason: "sender" },
    ]);
  });

  it("ignores a link preview with no words as empty, and reads a link preview's body", () => {
    expect(parseWhapiWebhook(delivery(message({ type: "link_preview", text: undefined, link_preview: { body: "" } })), LINE)).toEqual([
      { kind: "ignored", reason: "empty" },
    ]);
    expect(
      parseWhapiWebhook(delivery(message({ type: "link_preview", text: undefined, link_preview: { body: "see https://context.lc" } })), LINE),
    ).toEqual([
      expect.objectContaining({ kind: "message", text: "see https://context.lc" }),
    ]);
  });

  it("ignores empty text as empty", () => {
    expect(parseWhapiWebhook(delivery(message({ text: { body: "   " } })), LINE)).toEqual([{ kind: "ignored", reason: "empty" }]);
  });

  it("ignores types it does not act on, and edits and deletes", () => {
    expect(parseWhapiWebhook(delivery(message({ type: "system", text: undefined })), LINE)).toEqual([
      { kind: "ignored", reason: "event_type" },
    ]);
    expect(parseWhapiWebhook(delivery(message({ type: "poll", text: undefined })), LINE)).toEqual([
      { kind: "ignored", reason: "event_type" },
    ]);
    expect(
      parseWhapiWebhook(delivery(message({ type: "action", text: undefined, action: { type: "edited", target: "3EB0ABCD-EF120000" } })), LINE),
    ).toEqual([{ kind: "ignored", reason: "event_type" }]);
    expect(
      parseWhapiWebhook(delivery(message({ type: "action", text: undefined, action: { type: "delete", target: "3EB0ABCD-EF120000" } })), LINE),
    ).toEqual([{ kind: "ignored", reason: "event_type" }]);
  });

  it("names a 1:1 reaction by its emoji, on the message it is on", () => {
    const reaction = (emoji: string) =>
      parseWhapiWebhook(
        delivery(message({ type: "action", text: undefined, action: { type: "reaction", target: "3EB0TARGET-ABCD7777", emoji } })),
        LINE,
      )[0];
    const on = (how: string) => ({
      kind: "reaction",
      eventId: "whapi:3EB0ABCD-EF121234",
      chatId: `whapi:${LINE}:${PERSON}`,
      from: PERSON,
      messageId: "3EB0ABCD-EF121234",
      reaction: { how, words: "" },
      on: "3EB0TARGET-ABCD7777",
    });
    expect(reaction("\u{1F44D}")).toEqual(on("Liked"));
    expect(reaction("\u{1F44D}\u{1F3FD}")).toEqual(on("Liked"));
    expect(reaction("❤️")).toEqual(on("Loved"));
    expect(reaction("❤")).toEqual(on("Loved"));
    expect(reaction("\u{1F44E}")).toEqual(on("Disliked"));
    expect(reaction("\u{1F602}")).toEqual(on("Laughed at"));
    expect(reaction("‼️")).toEqual(on("Emphasized"));
    expect(reaction("❓")).toEqual(on("Questioned"));
    expect(reaction("❔")).toEqual(on("Questioned"));
    expect(reaction("\u{1F525}")).toEqual(on("Reacted"));
    expect(reaction("constructor")).toEqual(on("Reacted"));
  });

  it("takes an empty emoji as a tapback taken back", () => {
    const [event] = parseWhapiWebhook(
      delivery(message({ type: "action", text: undefined, action: { type: "reaction", target: "3EB0TARGET-ABCD7777", emoji: "" } })),
      LINE,
    );
    expect(event).toMatchObject({ kind: "reaction", reaction: { how: "Liked", words: "", removed: true }, on: "3EB0TARGET-ABCD7777" });
  });

  it("refuses a reaction whose target is not a message id", () => {
    expect(
      parseWhapiWebhook(delivery(message({ type: "action", text: undefined, action: { type: "reaction", target: "not an id", emoji: "\u{1F44D}" } })), LINE),
    ).toEqual([{ kind: "invalid" }]);
  });
});

describe("whapi webhook: groups", () => {
  const group = (over: Record<string, unknown> = {}) => message({ chat_id: GROUP, from: PHONE, ...over });

  it("takes a group text with its sender and a group id", () => {
    expect(parseWhapiWebhook(delivery(group({ text: { body: "lunch?" } })), LINE)).toEqual([
      {
        kind: "group-message",
        eventId: "whapi:3EB0ABCD-EF121234",
        groupId: `whapi:${GROUP}`,
        line: LINE,
        from: PERSON,
        participants: [PERSON],
        messageId: "3EB0ABCD-EF121234",
        text: "lunch?",
      },
    ]);
  });

  it("rewrites an @mention of Tex's own number to Tex, and no other number", () => {
    const [event] = parseWhapiWebhook(delivery(group({ text: { body: "@15550001111 what's up @15550001112" } })), LINE);
    expect(event).toMatchObject({ kind: "group-message", text: "Tex what's up @15550001112" });
    const [again] = parseWhapiWebhook(delivery(group({ text: { body: "@15550001111 and @15550001111" } })), LINE);
    expect(again).toMatchObject({ text: "Tex and Tex" });
  });

  it("names a sender with only a @lid id as lid:<digits>, never as a phone", () => {
    const [event] = parseWhapiWebhook(
      delivery(group({ from: "98765432100123@lid", text: { body: "hi all" } })),
      LINE,
    );
    expect(event).toMatchObject({ kind: "group-message", from: "lid:98765432100123", participants: ["lid:98765432100123"] });
  });

  it("names a group member's jid as the phone it is", () => {
    const [event] = parseWhapiWebhook(delivery(group({ from: `${PHONE}@s.whatsapp.net`, text: { body: "hi" } })), LINE);
    expect(event).toMatchObject({ from: PERSON });
  });

  it("refuses a group message with no sender", () => {
    expect(parseWhapiWebhook(delivery(group({ from: undefined, text: { body: "hi" } })), LINE)).toEqual([{ kind: "invalid" }]);
  });

  it("keeps a quoted id as replyTo in a group, and drops one that is not a message id", () => {
    const [event] = parseWhapiWebhook(delivery(group({ text: { body: "agreed" }, context: { quoted_id: "3EB0QUOTED-ABCD9999" } })), LINE);
    expect(event).toMatchObject({ kind: "group-message", replyTo: "3EB0QUOTED-ABCD9999" });
    expect(event).not.toHaveProperty("quoted");
    const [other] = parseWhapiWebhook(delivery(group({ text: { body: "agreed" }, context: { quoted_id: "bad id!" } })), LINE);
    expect(other).not.toHaveProperty("replyTo");
  });

  it("takes a group picture with a link as an attachment", () => {
    const [event] = parseWhapiWebhook(
      delivery(group({ type: "image", text: undefined, image: { link: "https://cdn.example/p/pic.png", mime_type: "image/png" } })),
      LINE,
    );
    expect(event).toMatchObject({ kind: "group-message", attachments: [{ url: "https://cdn.example/p/pic.png", filename: "pic.png" }] });
  });

  it("reads a group's 👍 as Liked, with the message it is on", () => {
    const [event] = parseWhapiWebhook(
      delivery(group({ type: "action", text: undefined, action: { type: "reaction", target: "3EB0TARGET-ABCD7777", emoji: "\u{1F44D}\u{1F3FB}" } })),
      LINE,
    );
    expect(event).toEqual({
      kind: "group-message",
      eventId: "whapi:3EB0ABCD-EF121234",
      groupId: `whapi:${GROUP}`,
      line: LINE,
      from: PERSON,
      participants: [PERSON],
      messageId: "3EB0ABCD-EF121234",
      text: "\u{1F44D}\u{1F3FB}",
      reaction: { how: "Liked", words: "" },
      reactionOn: "3EB0TARGET-ABCD7777",
    });
  });

  it("reads a group's ❤️ as Loved, and an empty emoji as a like taken back", () => {
    const [loved] = parseWhapiWebhook(
      delivery(group({ type: "action", text: undefined, action: { type: "reaction", target: "3EB0TARGET-ABCD7777", emoji: "❤️" } })),
      LINE,
    );
    expect(loved).toMatchObject({ reaction: { how: "Loved", words: "" }, reactionOn: "3EB0TARGET-ABCD7777" });
    const [removed] = parseWhapiWebhook(
      delivery(group({ type: "action", text: undefined, action: { type: "reaction", target: "3EB0TARGET-ABCD7777", emoji: "" } })),
      LINE,
    );
    expect(removed).toMatchObject({ reaction: { how: "Liked", words: "", removed: true }, reactionOn: "3EB0TARGET-ABCD7777" });
  });

  it("ignores any other group reaction", () => {
    expect(
      parseWhapiWebhook(delivery(group({ type: "action", text: undefined, action: { type: "reaction", target: "3EB0TARGET-ABCD7777", emoji: "\u{1F602}" } })), LINE),
    ).toEqual([{ kind: "ignored", reason: "reaction" }]);
  });

  it("ignores a group's own messages and its edits", () => {
    expect(parseWhapiWebhook(delivery(group({ from_me: true })), LINE)).toEqual([{ kind: "ignored", reason: "event_type" }]);
    expect(
      parseWhapiWebhook(delivery(group({ type: "action", text: undefined, action: { type: "edited", target: "3EB0TARGET-ABCD7777" } })), LINE),
    ).toEqual([{ kind: "ignored", reason: "event_type" }]);
  });
});

describe("whapi webhook: shapes it does not read", () => {
  it("refuses a message id that is not a Whapi id", () => {
    expect(parseWhapiWebhook(delivery(message({ id: "no spaces allowed!" })), LINE)).toEqual([{ kind: "invalid" }]);
    expect(parseWhapiWebhook(delivery(message({ id: 42 })), LINE)).toEqual([{ kind: "invalid" }]);
    expect(parseWhapiWebhook(delivery(message({ id: undefined })), LINE)).toEqual([{ kind: "invalid" }]);
  });

  it("refuses a message that is not an object", () => {
    expect(parseWhapiWebhook(delivery("hello", null, 3), LINE)).toEqual([{ kind: "invalid" }, { kind: "invalid" }, { kind: "invalid" }]);
  });

  it("logs the keys of a skipped shape, never its values", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    parseWhapiWebhook(delivery(message({ type: "poll", text: undefined, secret_words: "my words 15551234567" })), LINE);
    const logged = log.mock.calls.map((call) => String(call[0])).join("\n");
    expect(logged).toContain("whapi_shape");
    expect(logged).toContain("secret_words");
    expect(logged).not.toContain("my words");
    expect(logged).not.toContain("15551234567");
  });
});
