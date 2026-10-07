import { describe, expect, it } from "vitest";
import { parseInbound, MAX_INBOUND_TEXT } from "./inbound";

// Redacted shape of a live message.received delivery from Linq's shared line.
function event(overrides: Record<string, unknown> = {}, data: Record<string, unknown> = {}) {
  return {
    api_version: "v3",
    event_type: "message.received",
    event_id: "evt_1",
    data: {
      chat: { id: "chat_1", is_group: false },
      id: "msg_1",
      sender_handle: { handle: "+15555550100", service: "iMessage" },
      service: "iMessage",
      parts: [{ type: "text", value: "hello" }],
      ...data,
    },
    ...overrides,
  };
}

describe("parseInbound", () => {
  it("reads the live direct iMessage shape", () => {
    expect(parseInbound(event())).toEqual({
      kind: "message",
      eventId: "evt_1",
      chatId: "chat_1",
      from: "+15555550100",
      messageId: "msg_1",
      text: "hello",
    });
  });

  it("joins several text parts and ignores media and links", () => {
    const parsed = parseInbound(event({}, {
      parts: [
        { type: "text", value: "one" },
        { type: "media", value: "https://cdn.example/x.png" },
        { type: "text", value: "two" },
      ],
    }));
    expect(parsed).toMatchObject({ kind: "message", text: "one\ntwo" });
  });

  it("ignores every event that is not an inbound message", () => {
    for (const type of ["message.sent", "message.delivered", "message.read", "message.failed"]) {
      expect(parseInbound(event({ event_type: type }))).toEqual({ kind: "ignored", reason: "event_type" });
    }
  });

  it("ignores group chats and requires an explicit false on data.chat", () => {
    for (const is_group of [true, "true", "false", "", 1, 0, null, undefined, {}, []]) {
      expect(parseInbound(event({}, { chat: { id: "chat_1", is_group } }))).toEqual({
        kind: "ignored", reason: "group",
      });
    }
    expect(parseInbound(event({}, { chat: { id: "chat_1" }, is_group: false }))).toEqual({
      kind: "ignored", reason: "group",
    });
  });

  it("ignores a sender that is not an E.164 phone number", () => {
    for (const handle of ["someone@example.com", "5555550100", "+1 555 555 0100", "", 42]) {
      expect(parseInbound(event({}, { sender_handle: { handle, service: "iMessage" } }))).toEqual({
        kind: "ignored", reason: "sender",
      });
    }
  });

  it("refuses SMS, RCS, missing service, or conflicting handle transport", () => {
    for (const service of ["SMS", "RCS", "imessage", undefined]) {
      expect(parseInbound(event({}, { service }))).toEqual({ kind: "ignored", reason: "service" });
    }
    expect(parseInbound(event({}, {
      sender_handle: { handle: "+15555550100", service: "SMS" },
    }))).toEqual({ kind: "ignored", reason: "service" });
    expect(parseInbound(event({}, {
      sender_handle: { handle: "+15555550100" },
    }))).toEqual({ kind: "ignored", reason: "service" });
  });

  it("ignores a message with no text", () => {
    expect(parseInbound(event({}, { parts: [{ type: "media", value: "x" }] }))).toEqual({
      kind: "ignored", reason: "empty",
    });
  });

  it("truncates very long text rather than forwarding it whole", () => {
    const long = "a".repeat(MAX_INBOUND_TEXT + 50);
    const parsed = parseInbound(event({}, { parts: [{ type: "text", value: long }] }));
    expect(parsed.kind === "message" && parsed.text.length).toBe(MAX_INBOUND_TEXT);
  });

  it("refuses malformed payloads without throwing", () => {
    for (const bad of [
      null, [], "x", {}, event({ event_id: "" }), event({}, { chat: null }),
      event({}, { chat: { id: 7, is_group: false } }), event({}, { id: null }),
      event({}, { sender_handle: null }), event({}, { parts: null }),
      event({}, { chat: null, chat_id: "chat_1", from: "+15555550100", is_group: false }),
    ]) {
      expect(parseInbound(bad)).toEqual({ kind: "invalid" });
    }
  });
});
