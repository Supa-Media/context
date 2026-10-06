import { describe, expect, it } from "vitest";
import { parseInbound, MAX_INBOUND_TEXT } from "./inbound";

function event(overrides: Record<string, unknown> = {}, data: Record<string, unknown> = {}) {
  return {
    api_version: "v3",
    event_type: "message.received",
    event_id: "evt_1",
    data: {
      chat_id: "chat_1",
      from: "+15555550100",
      to: ["+15555550199"],
      is_group: false,
      service: "iMessage",
      message: { id: "msg_1", parts: [{ type: "text", value: "hello" }] },
      ...data,
    },
    ...overrides,
  };
}

describe("parseInbound", () => {
  it("reads a direct text message", () => {
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
    const parsed = parseInbound(
      event({}, {
        message: {
          id: "msg_1",
          parts: [
            { type: "text", value: "one" },
            { type: "media", value: "https://cdn.example/x.png" },
            { type: "text", value: "two" },
          ],
        },
      }),
    );
    expect(parsed).toMatchObject({ kind: "message", text: "one\ntwo" });
  });

  it("ignores every event that is not an inbound message", () => {
    for (const type of ["message.sent", "message.delivered", "message.read", "message.failed"]) {
      expect(parseInbound(event({ event_type: type }))).toEqual({ kind: "ignored", reason: "event_type" });
    }
  });

  it("ignores group chats in this phase, so a group never reaches anyone's personal context", () => {
    expect(parseInbound(event({}, { is_group: true }))).toEqual({ kind: "ignored", reason: "group" });
  });

  it("ignores a sender that is not an E.164 phone number (an email handle, a malformed value)", () => {
    for (const from of ["someone@example.com", "5555550100", "+1 555 555 0100", "", 42]) {
      expect(parseInbound(event({}, { from }))).toEqual({ kind: "ignored", reason: "sender" });
    }
  });

  it("refuses SMS and RCS, whose sender numbers can be spoofed, and a message naming no service", () => {
    for (const service of ["SMS", "RCS", "imessage", undefined]) {
      expect(parseInbound(event({}, { service }))).toEqual({ kind: "ignored", reason: "service" });
    }
  });

  it("finds the service on the message or the sender handle too", () => {
    const onMessage = event({}, {
      service: undefined,
      message: { id: "m", service: "iMessage", parts: [{ type: "text", value: "hi" }] },
    });
    expect(parseInbound(onMessage).kind).toBe("message");
    const onHandle = event({}, { service: undefined, sender_handle: { handle: "+15555550100", service: "iMessage" } });
    expect(parseInbound(onHandle).kind).toBe("message");
    const smsHandle = event({}, { service: undefined, sender_handle: { service: "SMS" } });
    expect(parseInbound(smsHandle)).toEqual({ kind: "ignored", reason: "service" });
  });

  it("ignores a message with no text", () => {
    const parsed = parseInbound(
      event({}, { message: { id: "msg_1", parts: [{ type: "media", value: "x" }] } }),
    );
    expect(parsed).toEqual({ kind: "ignored", reason: "empty" });
  });

  it("truncates very long text rather than forwarding it whole", () => {
    const long = "a".repeat(MAX_INBOUND_TEXT + 50);
    const parsed = parseInbound(
      event({}, { message: { id: "msg_1", parts: [{ type: "text", value: long }] } }),
    );
    expect(parsed.kind === "message" && parsed.text.length).toBe(MAX_INBOUND_TEXT);
  });

  it("refuses malformed payloads without throwing", () => {
    for (const bad of [null, [], "x", {}, event({ event_id: "" }), event({}, { chat_id: 7 }), event({}, { message: null })]) {
      expect(parseInbound(bad)).toEqual({ kind: "invalid" });
    }
  });
});
