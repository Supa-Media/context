import { describe, expect, it } from "vitest";
import { parseSendblueInbound } from "./sendblue";
import { answers } from "./reactions";
import { holdsAsYes, onTheAsk, rememberAskReply } from "./thumbs";
import { MemoryStorage } from "./memoryStorage.testing";

const LINE = "+15555550199";
const PHONE = "+15555550100";
const ASK =
  "Before I do that, I need your OK: send a Slack message to Jo Park (ACME NYC): \"Hey Jo, I'm testing if my assistant can connect to Slack: https://example.com\". Give it a 👍 and I'll go ahead.";

const received = (over: Record<string, unknown> = {}) => ({
  content: "hello",
  is_outbound: false,
  message_handle: "mh_9",
  from_number: PHONE,
  number: PHONE,
  to_number: LINE,
  sendblue_number: LINE,
  media_url: "",
  message_type: "message",
  group_id: "",
  service: "iMessage",
  ...over,
});

// Dev2, 2026-10-22: three Apple 👍 tapbacks on asks reached nothing, and a typed "yes" sent at once.
describe("the Apple 👍 tapback, in every shape Sendblue may send it", () => {
  it("reads it as words whatever message_type or service say, the nested quotes of a Slack ask included", () => {
    for (const over of [{}, { message_type: "reaction" }, { message_type: "tapback" }, { service: undefined }]) {
      expect(parseSendblueInbound(received({ content: `Liked “${ASK}”`, ...over }))).toMatchObject({
        kind: "reaction",
        reaction: { how: "Liked", words: ASK },
      });
    }
  });

  it("reads a reaction Sendblue reports on its own, naming the message it was on", () => {
    expect(parseSendblueInbound(received({ content: "", message_type: "reaction", reaction: "like", reply_to: { message_handle: "mh_ask" } }))).toMatchObject({
      kind: "reaction",
      reaction: { how: "Liked", words: "" },
      on: "mh_ask",
    });
    expect(parseSendblueInbound(received({ content: "love", message_type: "reaction", associated_message_handle: "mh_ask" }))).toMatchObject({
      kind: "reaction",
      reaction: { how: "Loved" },
      on: "mh_ask",
    });
    expect(parseSendblueInbound(received({ content: "", message_type: "reaction", reaction: "-like", reply_to: { message_handle: "mh_ask" } }))).toMatchObject({
      kind: "reaction",
      reaction: { how: "Liked", removed: true },
    });
  });

  it("never takes one over SMS, where anyone could type it from the number, or one of our own", () => {
    expect(parseSendblueInbound(received({ service: "SMS", content: `Liked “${ASK}”` }))).toMatchObject({ kind: "ignored" });
    expect(parseSendblueInbound(received({ is_outbound: true, content: `Liked “${ASK}”` }))).toMatchObject({ kind: "ignored" });
    expect(parseSendblueInbound(received({ content: "", message_type: "reaction", reaction: "like" }))).not.toMatchObject({ kind: "reaction" });
  });

  it("a like on a message whose words Sendblue could not give is a like on the ask still waiting", async () => {
    const storage = new MemoryStorage();
    await rememberAskReply(storage, ["Here it is.", ASK], 1_000);
    const got = await onTheAsk(storage, { how: "Liked", words: "" }, 2_000);
    expect(got.words).toBe(ASK);
    expect(holdsAsYes(got)).toBe(true);
  });
});

describe("a 👍 on a text that asks in words is answered, never only noted", () => {
  it("takes Tex's own 'say yes' and 'say the word' asks", () => {
    for (const words of [
      "“Hey Jo, testing.”\n\nSay yes and I'll try sending it again.",
      "Not yet. Say the word and I’ll send it to Jo Park on Acme Slack.",
      "Give it a 👍 and I'll send it.",
      "Let me know and I'll post it.",
    ]) {
      expect(answers({ how: "Liked", words })).toBe(true);
    }
    expect(answers({ how: "Liked", words: "Done, I sent it." })).toBe(false);
    expect(answers({ how: "Loved", words: "Have a good night." })).toBe(false);
  });
});
